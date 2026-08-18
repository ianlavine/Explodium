// Downstream client. A big 10x10 grid on the left; your tiles, the scores and
// the rule dials on the right. Pick a tile, drop it on any empty square; the
// highest tile beside a dry token starts it running, and after that it steps
// onto any neighbouring tile showing its own number or one below — never twice
// onto the same square in one run.
//
// Everything in the options menu is drawn from the `settingSpecs` the server
// ships, so a new dial there needs no work here.
//
// The server resolves a whole turn at once and ships the path each token took
// in `anim`, so incoming states are queued and replayed a square at a time —
// that way a five-square run reads as a run, not a teleport.
import { socket, els, app } from "../../shared/context.js";
import { metrics, positionOf, fitWidth, tokenSize, SIZE } from "./geometry.js";

// Pacing knobs: one square of travel, and the beat a token holds once it has
// come to rest before the next turn is drawn.
const HOP_MS = 400;
const SETTLE_MS = 650;
const PANEL_PX = 330; // the fixed right column, reserved out of the board's box
const MIN_CELL = 30;
const MAX_CELL = 92;

const SEAT_CLASSES = ["ds-p0", "ds-p1", "ds-p2", "ds-p3"];

let state = null;
let board = null; // { root, grid, tokenLayer, cells: [], tokens: Map }
let panel = null; // { scores, hint, stop, tiles, footer, log, rules }
let cellPx = 46; // recomputed from the viewport on build and on resize
let selectedTile = null; // index into our hand
let displayCells = new Map(); // tokenId -> cell currently drawn (mid-animation)
let queue = [];
let animating = false;
let animTimer = null;
let showRules = false;
let showSettings = false;
let resizeHandler = null;
let resizeObserver = null;

const myTurn = () => !!state && !state.gameOver && state.turn === 0 && !animating;
const seatName = (seat) => state?.players?.[seat]?.name ?? `P${seat + 1}`;
// A fork the player has to answer, and whether it is a choice of which token
// takes the new tile rather than where the running one goes next.
const fork = () => (!animating && state?.pending ? state.pending : null);
// The highest tile in play; a dry token is waiting for one of those.
const topValue = () => state?.settings?.maxValue ?? 6;
const shape = () => state?.settings?.shape ?? "square";
const isHex = () => shape() === "hex";
const forkIsTokenPick = () => {
  const pending = fork();
  return !!pending && new Set(pending.options.map((option) => option.tokenId)).size > 1;
};

// --- geometry ---------------------------------------------------------------

// The board takes whatever the viewport leaves beside the right-hand column.
function measureCell() {
  const host = els.gameBoard.parentElement ?? els.gameBoard;
  // The game screen is still hidden when the first state lands; keep the
  // current size until there is a real box to measure against.
  if (host.getBoundingClientRect().width < 50) return cellPx;
  const box = els.gameBoard.getBoundingClientRect();
  const padding = 20; // the board's own padding, inside which the cells sit
  const availableWidth = window.innerWidth - PANEL_PX - box.left - 28 - padding;
  const availableHeight = window.innerHeight - box.top - 34 - padding;
  return Math.max(
    MIN_CELL,
    Math.min(MAX_CELL, Math.floor(fitWidth(shape(), availableWidth, availableHeight)))
  );
}

function applyGeometry() {
  cellPx = measureCell();
  const m = metrics(shape(), cellPx);
  board.metrics = m;
  board.shape = m.shape;
  board.root.style.setProperty("--ds-cell", `${cellPx}px`);
  board.grid.style.width = `${m.boardWidth}px`;
  board.grid.style.height = `${m.boardHeight}px`;
  board.cells.forEach((el, cell) => {
    const { x, y } = positionOf(cell, m);
    el.style.width = `${m.width}px`;
    el.style.height = `${m.height}px`;
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
  const size = tokenSize(m);
  board.tokens.forEach((el) => {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
  });
  if (state) renderTokens();
}

// --- construction -----------------------------------------------------------

function buildBoard() {
  document.body.classList.add("ds-mode");
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.add("ds-host");

  const root = document.createElement("div");
  root.className = "ds-board";

  const grid = document.createElement("div");
  grid.className = "ds-grid";

  const cells = [];
  for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ds-cell";
    el.dataset.cell = String(cell);
    el.innerHTML = '<span class="ds-num"></span>';
    grid.appendChild(el);
    cells.push(el);
  }

  const tokenLayer = document.createElement("div");
  tokenLayer.className = "ds-tokens";

  root.appendChild(grid);
  root.appendChild(tokenLayer);
  els.gameBoard.appendChild(root);

  grid.addEventListener("click", onCellClick);
  grid.addEventListener("mouseover", onCellHover);
  grid.addEventListener("mouseleave", clearPreview);
  tokenLayer.addEventListener("click", onTokenClick);

  board = { root, grid, tokenLayer, cells, tokens: new Map() };
  applyGeometry();

  resizeHandler = () => {
    if (board) applyGeometry();
  };
  window.addEventListener("resize", resizeHandler);
  // The board is built while the game screen is still hidden, so the first
  // real measurement comes from the play area getting its size.
  resizeObserver = new ResizeObserver(resizeHandler);
  resizeObserver.observe(els.gameBoard.parentElement ?? els.gameBoard);
}

function buildPanel() {
  els.hand.innerHTML = "";
  els.hand.classList.add("ds-panel-host");

  const scores = document.createElement("div");
  scores.className = "ds-scores";

  const hint = document.createElement("div");
  hint.className = "ds-hint";

  const rack = document.createElement("div");
  rack.className = "ds-rack";
  const rackLabel = document.createElement("div");
  rackLabel.className = "ds-rack-label";
  rackLabel.textContent = "Your tiles";
  const tiles = document.createElement("div");
  tiles.className = "ds-rack-tiles";
  const footer = document.createElement("div");
  footer.className = "ds-rack-footer";
  rack.appendChild(rackLabel);
  rack.appendChild(tiles);
  rack.appendChild(footer);

  // Rule dials, driven entirely by the specs the server ships in
  // `settingSpecs` — adding a knob server-side puts a slider here for free.
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "ds-rules-btn";
  settingsBtn.textContent = "Options";
  settingsBtn.addEventListener("click", () => {
    showSettings = !showSettings;
    renderPanel();
  });

  const settings = document.createElement("div");
  settings.className = "ds-settings hidden";
  settings.addEventListener("input", (event) => {
    const slider = event.target.closest(".ds-setting-input");
    if (!slider) return;
    // Draw the new number straight away; the server confirms a moment later.
    slider.closest(".ds-setting").querySelector(".ds-setting-value").textContent = slider.value;
    socket.emit("downstream_setting", {
      roomId: app.roomId,
      key: slider.dataset.key,
      value: Number(slider.value)
    });
  });
  settings.addEventListener("click", (event) => {
    const option = event.target.closest(".ds-setting-opt");
    if (!option) return;
    socket.emit("downstream_setting", {
      roomId: app.roomId,
      key: option.dataset.key,
      value: option.dataset.value
    });
  });

  const rulesBtn = document.createElement("button");
  rulesBtn.type = "button";
  rulesBtn.className = "ds-rules-btn";
  rulesBtn.textContent = "How to play";
  rulesBtn.addEventListener("click", () => {
    showRules = !showRules;
    renderPanel();
  });

  const rules = document.createElement("div");
  rules.className = "ds-rules hidden";

  // Only offered when the token has nothing but sideways moves left: water
  // keeps falling while a step down is available.
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "ghost-btn ds-stop hidden";
  stop.textContent = "Let it rest here";
  stop.addEventListener("click", () => {
    if (fork()?.canStop) socket.emit("downstream_choose", { roomId: app.roomId, stop: true });
  });

  const log = document.createElement("div");
  log.className = "ds-log";

  tiles.addEventListener("click", (event) => {
    const tile = event.target.closest(".ds-tile");
    if (!tile || !myTurn() || fork()) return;
    selectedTile = Number(tile.dataset.index);
    renderPanel();
  });

  [scores, hint, stop, rack, settingsBtn, settings, rulesBtn, rules, log].forEach((node) =>
    els.hand.appendChild(node)
  );
  panel = { scores, hint, stop, tiles, footer, log, rules, settings };
}

// --- rendering --------------------------------------------------------------

function renderBoard() {
  const pending = fork();
  const forkCells = new Set(pending && !forkIsTokenPick() ? pending.options.map((o) => o.cell) : []);
  const occupied = new Set(state.tokens.filter((t) => t.status !== "done").map((t) => t.cell));
  const shapeClass = isHex() ? "ds-cell ds-cell-hex" : "ds-cell";
  board.cells.forEach((el, cell) => {
    const tile = state.board[cell];
    el.className = shapeClass;
    const num = el.firstChild;
    if (tile) {
      el.classList.add("ds-filled", SEAT_CLASSES[tile.owner]);
      num.textContent = String(tile.value);
      if (tile.value === 0) el.classList.add("ds-zero");
    } else {
      num.textContent = "";
      if (occupied.has(cell)) el.classList.add("ds-blocked");
      else if (myTurn() && !pending) el.classList.add("ds-open");
    }
    if (forkCells.has(cell)) el.classList.add("ds-choice");
  });
}

function renderTokens() {
  const tokenPick = forkIsTokenPick();
  const pickable = new Set(tokenPick ? fork().options.map((o) => o.tokenId) : []);
  board.tokenLayer.classList.toggle("ds-tokens-live", tokenPick);
  const seen = new Set();
  state.tokens.forEach((token) => {
    seen.add(token.id);
    let el = board.tokens.get(token.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "ds-token";
      el.dataset.tokenId = token.id;
      const size = tokenSize(board.metrics);
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.innerHTML = '<span class="ds-token-value"></span><span class="ds-token-id"></span>';
      board.tokenLayer.appendChild(el);
      board.tokens.set(token.id, el);
    }
    const cell = displayCells.get(token.id) ?? token.cell;
    const m = board.metrics;
    const spot = positionOf(cell, m);
    const size = tokenSize(m);
    const x = spot.x + (m.width - size) / 2;
    const y = spot.y + (m.height - size) / 2;
    // Mid-run the token wears the number of the square it is passing over, not
    // the one it will end on; its fate only shows once it gets there.
    const arrived = cell === token.cell;
    const value = arrived ? token.value : state.board[cell]?.value ?? null;
    // A finished token shrinks to a marker so its 0 stays legible.
    const scale = arrived && token.status === "done" ? " scale(0.55)" : "";
    el.style.transform = `translate(${x}px, ${y}px)${scale}`;
    el.classList.toggle("ds-token-dead", arrived && token.status === "dead");
    el.classList.toggle("ds-token-done", arrived && token.status === "done");
    el.classList.toggle("ds-token-dry", value === null && token.status !== "dead");
    el.classList.toggle("ds-token-pick", pickable.has(token.id));
    // The token covers the tile it stands on, so it wears that number itself.
    el.querySelector(".ds-token-value").textContent =
      arrived && token.status === "dead" ? "✕" : arrived && token.status === "done" ? "★" : value === null ? "–" : String(value);
    el.querySelector(".ds-token-id").textContent = token.id;
    el.title = describeToken(token);
  });
  board.tokens.forEach((el, id) => {
    if (!seen.has(id)) {
      el.remove();
      board.tokens.delete(id);
    }
  });
}

function describeToken(token) {
  if (token.status === "dead") return `Token ${token.id} drowned here`;
  if (token.status === "done") return `Token ${token.id} finished here`;
  if (token.value === null)
    return `Token ${token.id} is dry — a ${topValue()} beside it starts it moving`;
  if (token.value === 0) return `Token ${token.id} is home on a 0`;
  return `Token ${token.id} is on a ${token.value} — a ${token.value} or a ${token.value - 1} beside it moves it on`;
}

function renderSettings() {
  panel.settings.classList.toggle("hidden", !showSettings);
  const specs = state.settingSpecs ?? {};
  const keys = Object.keys(specs);
  // Built once and then only kept in sync: rebuilding would tear the slider
  // out from under the cursor every time a bot takes its turn.
  if (panel.settings.childElementCount !== keys.length + 1) {
    panel.settings.innerHTML = "";
    keys.forEach((key) => {
      const spec = specs[key];
      const row = document.createElement(spec.type === "choice" ? "div" : "label");
      row.className = "ds-setting";
      const control =
        spec.type === "choice"
          ? `<span class="ds-setting-choice">${spec.options
              .map(
                (option) =>
                  `<button type="button" class="ds-setting-opt" data-key="${key}" data-value="${option.value}">${option.label}</button>`
              )
              .join("")}</span>`
          : `<input class="ds-setting-input" type="range" data-key="${key}"
                    min="${spec.min}" max="${spec.max}" step="${spec.step}" />
             <span class="ds-setting-scale"><span>${spec.min}</span><span>${spec.max}</span></span>`;
      row.innerHTML = `
        <span class="ds-setting-head">
          <span>${spec.label}</span>
          ${spec.type === "choice" ? "" : '<b class="ds-setting-value"></b>'}
        </span>
        ${control}
        <span class="ds-setting-hint">${spec.hint ?? ""}${
          spec.applies === "next" ? ' <em>Takes effect in the next game.</em>' : ""
        }</span>`;
      panel.settings.appendChild(row);
    });
    // The pile-shaping dials need a fresh deal to mean anything.
    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "ghost-btn ds-restart";
    restart.textContent = "Deal a new game with these";
    restart.addEventListener("click", () => socket.emit("downstream_restart", { roomId: app.roomId }));
    panel.settings.appendChild(restart);
  }
  keys.forEach((key) => {
    const value = state.settings?.[key] ?? specs[key].value;
    if (specs[key].type === "choice") {
      panel.settings
        .querySelectorAll(`.ds-setting-opt[data-key="${key}"]`)
        .forEach((button) => button.classList.toggle("ds-opt-on", button.dataset.value === value));
      return;
    }
    const input = panel.settings.querySelector(`.ds-setting-input[data-key="${key}"]`);
    if (!input) return;
    if (input !== document.activeElement) input.value = String(value);
    input.closest(".ds-setting").querySelector(".ds-setting-value").textContent = String(value);
  });
}

// The blurb quotes the dials, so it is written out rather than baked in.
function renderRules() {
  panel.rules.classList.toggle("hidden", !showRules);
  if (!showRules) return;
  const top = topValue();
  panel.rules.innerHTML = `
    <p><b>Place</b> one tile per turn on any empty square. Tiles run <b>0 to ${top}</b>.</p>
    <p>A <b>${top}</b> next to a dry token starts it moving. After that it steps onto any neighbouring tile showing <b>its own number or one below</b>, never twice onto the same square in one run.</p>
    <p>Water keeps falling: while a step <b>down</b> is available the token must move. Once only <b>sideways</b> moves are left, you may take one or let it rest.</p>
    <p>${
      state.settings?.scoring === "movement"
        ? "You score <b>1 point per square</b> a token travels on your turn — sideways steps included."
        : "You score <b>how far the token's number falls</b> over the run. Sideways steps move it along but pay nothing."
    } Whoever owns the tile it <b>stops on</b> scores the same again.</p>
    <p>Reaching a <b>0</b> ends that token's journey and pays the tile's owner <b>+${state.settings?.completionBonus ?? 7}</b>.</p>
    <p>A token with a tile on every side can never be moved again — it <b>drowns</b>, and each tile touching it costs its owner its face value.</p>
    <p>The game ends when all five tokens are finished or drowned.</p>`;
}

function renderPanel() {
  renderSettings();
  renderRules();
  const leader = Math.max(...state.scores);
  panel.scores.innerHTML = "";
  state.players.forEach((player, seat) => {
    const row = document.createElement("div");
    row.className = `ds-score ${SEAT_CLASSES[seat]}`;
    if (state.turn === seat && !state.gameOver) row.classList.add("ds-score-turn");
    if (state.scores[seat] === leader) row.classList.add("ds-score-lead");
    const gain = state.lastTurn?.gains?.[seat] ?? 0;
    row.innerHTML = `
      <span class="ds-chip"></span>
      <span class="ds-score-name">${player.name}</span>
      ${gain ? `<span class="ds-delta ${gain > 0 ? "up" : "down"}">${gain > 0 ? "+" : "−"}${Math.abs(gain)}</span>` : ""}
      <span class="ds-score-tiles">${state.handCounts[seat] + state.deckCounts[seat]}</span>
      <span class="ds-score-pts">${state.scores[seat]}</span>`;
    panel.scores.appendChild(row);
  });

  const pending = fork();
  panel.hint.className = "ds-hint";
  if (state.gameOver) {
    const names = state.winners.map(seatName).join(" & ");
    panel.hint.classList.add("ds-hint-big");
    panel.hint.textContent =
      state.winners.length === 1 && state.winners[0] === 0
        ? `You win with ${state.scores[0]}!`
        : `${names} ${state.winners.length > 1 ? "tie" : "wins"} — ${Math.max(...state.scores)} points`;
  } else if (animating) {
    panel.hint.textContent = "Water is moving…";
  } else if (pending && forkIsTokenPick()) {
    panel.hint.classList.add("ds-hint-act");
    panel.hint.textContent = pending.canStop
      ? `${pending.options.length} tokens could take that tile sideways — click one, or leave them.`
      : `${pending.options.length} tokens can take that tile — click the one that moves.`;
  } else if (pending) {
    panel.hint.classList.add("ds-hint-act");
    panel.hint.textContent = pending.canStop
      ? `Token ${pending.tokenId} can only go sideways now — click a glowing square, or let it rest.`
      : `Token ${pending.tokenId} has ${pending.options.length} ways to go — click a glowing square.`;
  } else if (state.turn === 0) {
    panel.hint.classList.add("ds-hint-act");
    panel.hint.textContent = selectedTile === null ? "Your turn — pick a tile." : "Now click an empty square.";
  } else {
    panel.hint.textContent = `${seatName(state.turn)} is thinking…`;
  }

  panel.stop.classList.toggle("hidden", !pending?.canStop);

  panel.tiles.innerHTML = "";
  state.hand.forEach((value, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "ds-tile ds-p0";
    tile.dataset.index = String(index);
    tile.textContent = String(value);
    if (index === selectedTile) tile.classList.add("ds-tile-sel");
    if (!myTurn() || pending) tile.classList.add("ds-tile-off");
    panel.tiles.appendChild(tile);
  });

  panel.footer.innerHTML = "";
  const left = document.createElement("span");
  left.textContent = `${state.deckCounts[0]} left in your pile`;
  panel.footer.appendChild(left);
  if (state.gameOver) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "ghost-btn ds-again";
    again.textContent = "Play again";
    again.addEventListener("click", () => socket.emit("downstream_restart", { roomId: app.roomId }));
    panel.footer.appendChild(again);
  }

  panel.log.innerHTML = "";
  [...state.log].reverse().forEach((line) => {
    const entry = document.createElement("div");
    entry.className = "ds-log-line";
    entry.textContent = line;
    panel.log.appendChild(entry);
  });
}

function renderAll() {
  renderBoard();
  renderTokens();
  renderPanel();
  els.turnStatus.textContent = state.gameOver
    ? "Game over"
    : state.turn === 0
    ? "Your turn"
    : `${seatName(state.turn)}'s turn`;
}

// --- input ------------------------------------------------------------------

function clearPreview() {
  board?.cells.forEach((el) => {
    el.classList.remove("ds-preview");
    el.removeAttribute("data-preview");
  });
}

function onCellHover(event) {
  const el = event.target.closest(".ds-cell");
  clearPreview();
  if (!el || selectedTile === null || !myTurn() || fork()) return;
  const cell = Number(el.dataset.cell);
  if (state.board[cell] || state.tokens.some((t) => t.status !== "done" && t.cell === cell)) return;
  el.classList.add("ds-preview");
  el.dataset.preview = String(state.hand[selectedTile]);
}

function onCellClick(event) {
  const el = event.target.closest(".ds-cell");
  if (!el || !state || animating) return;
  const cell = Number(el.dataset.cell);
  const pending = fork();
  if (pending) {
    if (forkIsTokenPick()) return; // that fork is answered by clicking a token
    const option = pending.options.find((candidate) => candidate.cell === cell);
    if (option) socket.emit("downstream_choose", { roomId: app.roomId, ...option });
    return;
  }
  if (!myTurn() || selectedTile === null) return;
  socket.emit("downstream_place", { roomId: app.roomId, tileIndex: selectedTile, cell });
  selectedTile = null;
  clearPreview();
}

// Two tokens can be beside the same new tile; then the fork is which one takes
// it, and the answer is a click on the token itself.
function onTokenClick(event) {
  if (!forkIsTokenPick()) return;
  const el = event.target.closest(".ds-token");
  if (!el) return;
  const option = fork().options.find((candidate) => candidate.tokenId === el.dataset.tokenId);
  if (option) socket.emit("downstream_choose", { roomId: app.roomId, ...option });
}

// --- the animation queue ----------------------------------------------------

function pump() {
  if (animating || queue.length === 0) return;
  apply(queue.shift());
}

function apply(payload) {
  const first = !board || !els.gameBoard.querySelector(".ds-board");
  state = payload;
  if (first) {
    buildBoard();
    buildPanel();
  }
  if (selectedTile !== null && selectedTile >= state.hand.length) selectedTile = null;
  // A new board shape changes every cell's size and place, not just its
  // outline — without this the hexes would sit on the old square lattice.
  if (!first && board.shape !== shape()) applyGeometry();

  // Rewind the moving tokens to where their run began, then walk them forward.
  displayCells = new Map(state.tokens.map((token) => [token.id, token.cell]));
  const hops = [];
  (state.anim ?? []).forEach(({ tokenId, path }) => {
    displayCells.set(tokenId, path[0]);
    path.slice(1).forEach((cell) => hops.push({ tokenId, cell }));
  });

  animating = hops.length > 0;
  renderAll();
  if (!animating) {
    pump();
    return;
  }
  let index = 0;
  const walk = () => {
    if (index >= hops.length) {
      animTimer = setTimeout(() => {
        animating = false;
        renderAll();
        pump();
      }, SETTLE_MS);
      return;
    }
    const hop = hops[index];
    index += 1;
    displayCells.set(hop.tokenId, hop.cell);
    renderTokens();
    animTimer = setTimeout(walk, HOP_MS);
  };
  animTimer = setTimeout(walk, 180);
}

function reset() {
  clearTimeout(animTimer);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  resizeObserver?.disconnect();
  resizeObserver = null;
  resizeHandler = null;
  animTimer = null;
  animating = false;
  queue = [];
  state = null;
  board = null;
  panel = null;
  selectedTile = null;
  displayCells = new Map();
}

export const downstream = {
  id: "downstream",
  name: "Downstream",
  soloOnly: true, // one human, three AI — there is no two-player queue

  handleState(payload, resetGameUi) {
    if (!payload.downstream) return false;
    if (!board) resetGameUi();
    queue.push(payload.downstream);
    pump();
    return true;
  },

  resetUi() {
    document.body.classList.remove("ds-mode");
    els.gameBoard.classList.remove("ds-host");
    els.hand.classList.remove("ds-panel-host");
  },

  clearState() {
    reset();
  },

  onMatchFound() {
    reset();
  },

  onOpponentLeft() {
    reset();
  },

  onExit() {
    reset();
  }
};
