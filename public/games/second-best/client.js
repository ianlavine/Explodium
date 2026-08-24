// Second Best client: the setup modal, the board, the palette and the score
// panel. The board rings each side's SECOND-largest group — the one that
// actually scores — with a bright outline, and its largest group with a faint
// one, so the shape you are being paid for is always visible.
import { socket, els, app, setBotThinking } from "../../shared/context.js";

const BLUE = 1;
const RED = 2;
const NEUTRAL = 3;
const COLOR_NAME = { [BLUE]: "blue", [RED]: "red", [NEUTRAL]: "neutral" };
const SEAT_COLORS = [BLUE, RED];

// Mirrors engine.js: neutrals are capped at a third of the board. The server
// clamps anyway, this just keeps the steppers from offering silly numbers.
const maxNeutrals = (size) => Math.floor((size * size) / 3);

const DEFAULT_SETTINGS = { size: 6, seededNeutrals: 0, playableNeutrals: 0 };

let secondBestState = null;
let selectedColor = BLUE;
let pickedThisMatch = false;
let lastSeatSeen = null;

// Setup choices persist between matches so a table can be replayed without
// re-dialling every number.
let chosenSettings = { ...DEFAULT_SETTINGS };
let pendingSetup = null;
let setupEl = null;

function isActive() {
  return app.currentGame?.id === "second-best";
}

const settings = () => secondBestState?.settings ?? DEFAULT_SETTINGS;
const boardSize = () => settings().size;

// In solo play the single human drives both seats, so the seat that matters is
// whichever one is to move.
function mySeat() {
  if (!secondBestState) return 0;
  return app.isSoloGame ? secondBestState.toMove : app.myPlayerIndex ?? 0;
}

function myColor() {
  return SEAT_COLORS[mySeat()];
}

function canPlay() {
  if (!secondBestState || secondBestState.gameOver) return false;
  if (app.isSoloGame) return true;
  return secondBestState.toMove === (app.myPlayerIndex ?? 0);
}

const neutralsLeft = () => secondBestState?.neutralsLeft ?? 0;

/* --- Setup modal --------------------------------------------------------- */

// Built here rather than in index.html: the shell only ships the markup for
// games it always has on screen, and this one is loaded on demand.
function buildSetup() {
  if (setupEl) return setupEl;
  setupEl = document.createElement("div");
  setupEl.className = "modal-overlay hidden sb-setup";
  setupEl.setAttribute("role", "dialog");
  setupEl.setAttribute("aria-modal", "true");
  setupEl.setAttribute("aria-label", "Second Best setup");
  setupEl.innerHTML = `
    <div class="modal-card sb-setup-card">
      <h3>Second Best — Setup</h3>
      <p class="modal-sub">Table rules for this match</p>
      <div class="sb-setup-rows"></div>
      <div class="sb-setup-play"></div>
      <button type="button" class="ghost-btn sb-setup-cancel">Cancel</button>
    </div>
  `;
  setupEl.addEventListener("click", onSetupClick);
  document.body.appendChild(setupEl);
  return setupEl;
}

function clampSettings() {
  const cap = maxNeutrals(chosenSettings.size);
  chosenSettings.seededNeutrals = Math.max(0, Math.min(cap, chosenSettings.seededNeutrals));
  chosenSettings.playableNeutrals = Math.max(0, Math.min(cap, chosenSettings.playableNeutrals));
}

function stepperRow(key, label, caption) {
  const cap = maxNeutrals(chosenSettings.size);
  const value = chosenSettings[key];
  return `
    <div class="sb-setup-row">
      <div class="sb-setup-label">
        <strong>${label}</strong>
        <small>${caption}</small>
      </div>
      <div class="sb-stepper">
        <button type="button" class="sb-step" data-key="${key}" data-delta="-1" ${value <= 0 ? "disabled" : ""}>−</button>
        <span class="sb-step-value">${value}</span>
        <button type="button" class="sb-step" data-key="${key}" data-delta="1" ${value >= cap ? "disabled" : ""}>+</button>
      </div>
    </div>
  `;
}

const BOT_OPTIONS = [
  { bot: "none", title: "None", sub: "Play against yourself" },
  { bot: "0", title: "Baby bot", sub: "Mostly wings it — great for learning" },
  { bot: "1", title: "Bot — Level 1", sub: "Decent moves, frequent slips" },
  { bot: "2", title: "Bot — Level 2", sub: "Sharp, with the occasional blunder" },
  { bot: "3", title: "Bot — Level 3", sub: "Always its best move; perfect endgame" },
  { bot: "4", title: "God bot", sub: "Thinks 4s a move — bring a plan" }
];

function renderSetup() {
  const el = buildSetup();
  clampSettings();
  const cap = maxNeutrals(chosenSettings.size);

  el.querySelector(".sb-setup-rows").innerHTML = `
    <div class="sb-setup-row">
      <div class="sb-setup-label">
        <strong>Board</strong>
        <small>25 or 36 squares to divide up</small>
      </div>
      <div class="sb-segmented">
        <button type="button" class="sb-seg${chosenSettings.size === 5 ? " selected" : ""}" data-size="5">5 × 5</button>
        <button type="button" class="sb-seg${chosenSettings.size === 6 ? " selected" : ""}" data-size="6">6 × 6</button>
      </div>
    </div>
    ${stepperRow("seededNeutrals", "Seeded neutrals", `Black pieces dropped at random before move one (max ${cap})`)}
    ${stepperRow("playableNeutrals", "Playable neutrals", `A shared stock either player can spend a turn from (max ${cap})`)}
  `;

  const playBox = el.querySelector(".sb-setup-play");
  playBox.innerHTML = "";
  if (pendingSetup?.mode === "solo") {
    const caption = document.createElement("p");
    caption.className = "modal-sub";
    caption.textContent = "Pick an opponent to start";
    playBox.appendChild(caption);
    const grid = document.createElement("div");
    grid.className = "sb-opponents";
    BOT_OPTIONS.forEach((opponent) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sb-play-btn";
      button.dataset.bot = opponent.bot;
      button.innerHTML = `<strong>${opponent.title}</strong><small>${opponent.sub}</small>`;
      grid.appendChild(button);
    });
    playBox.appendChild(grid);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sb-play-btn primary";
    button.dataset.bot = "queue";
    button.innerHTML = "<strong>Play — find a match</strong>";
    playBox.appendChild(button);
  }
}

function closeSetup() {
  pendingSetup = null;
  setupEl?.classList.add("hidden");
}

function onSetupClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target === setupEl || target.closest(".sb-setup-cancel")) {
    closeSetup();
    return;
  }

  const seg = target.closest(".sb-seg");
  if (seg) {
    chosenSettings.size = Number(seg.dataset.size);
    renderSetup();
    return;
  }

  const step = target.closest(".sb-step");
  if (step) {
    chosenSettings[step.dataset.key] += Number(step.dataset.delta);
    renderSetup();
    return;
  }

  const play = target.closest(".sb-play-btn");
  if (!play || !pendingSetup) return;
  const { onReady } = pendingSetup;
  const choice = play.dataset.bot;
  clampSettings();
  const options = { settings: { ...chosenSettings } };
  closeSetup();
  onReady(options, choice === "queue" || choice === "none" ? null : Number(choice));
}

/* --- Board --------------------------------------------------------------- */

// cell -> "scoring" (the second-largest group) or "top" (the largest), per
// color. A cell only ever belongs to one group of one color, so one map does.
function groupRoles() {
  const roles = new Map();
  if (!secondBestState) return roles;
  ["blue", "red"].forEach((side) => {
    const groups = secondBestState.groups?.[side] ?? [];
    groups[0]?.cells.forEach((cell) => roles.set(cell, "top"));
    groups[1]?.cells.forEach((cell) => roles.set(cell, "scoring"));
  });
  return roles;
}

function renderBoard() {
  if (!secondBestState) return;
  const size = boardSize();
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("toy-battle-board", "flip-triples-board", "only-3-board", "player-0", "player-1");
  els.gameBoard.classList.add("second-best-board");
  els.gameBoard.style.setProperty("--sb-cols", String(size));
  els.gameBoard.style.setProperty("--sb-pick", `var(--sb-${COLOR_NAME[selectedColor]})`);
  els.gameBoard.classList.toggle("locked", !canPlay());

  const playable = canPlay();
  const roles = groupRoles();
  for (let cell = 0; cell < size * size; cell += 1) {
    const value = secondBestState.board[cell];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sb-cell";
    button.dataset.cell = String(cell);
    button.disabled = value !== 0 || !playable;
    if (secondBestState.lastMove?.cell === cell) button.classList.add("last-move");

    const piece = document.createElement("span");
    piece.className = "sb-piece";
    if (value !== 0) {
      piece.classList.add(COLOR_NAME[value]);
      const role = roles.get(cell);
      if (role) piece.classList.add(role);
    }
    button.appendChild(piece);
    els.gameBoard.appendChild(button);
  }
}

/* --- Panel --------------------------------------------------------------- */

// "8 · 3 · 2 · 1" with the scoring entry called out.
function groupLadder(groups) {
  if (!groups || groups.length === 0) return "<em>no groups yet</em>";
  return groups
    .map((group, rank) => (rank === 1 ? `<b>${group.size}</b>` : `<span>${group.size}</span>`))
    .join(" · ");
}

function renderPanel() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("toy-rack", "flip-score", "only-3-panel", "player-0", "player-1");
  els.hand.classList.add("second-best-panel");
  if (!secondBestState) return;

  const scores = secondBestState.scores ?? { blue: 0, red: 0 };
  const pieces = secondBestState.pieces ?? { blue: 0, red: 0, neutral: 0 };
  const groups = secondBestState.groups ?? { blue: [], red: [] };
  // Who is ahead right now, tiebreak included — the same test the server ends
  // the game with.
  const leader =
    scores.blue !== scores.red
      ? scores.blue > scores.red
        ? "blue"
        : "red"
      : pieces.blue !== pieces.red
      ? pieces.blue < pieces.red
        ? "blue"
        : "red"
      : null;

  const scoreRow = document.createElement("div");
  scoreRow.className = "sb-scores";
  ["blue", "red"].forEach((side) => {
    const box = document.createElement("div");
    box.className = `sb-score ${side}${leader === side ? " leading" : ""}`;
    box.innerHTML = `
      <span class="sb-score-dot"></span>
      <strong>${scores[side]}</strong>
      <span class="sb-ladder">${groupLadder(groups[side])}</span>
      <small>${pieces[side]} pieces</small>
    `;
    scoreRow.appendChild(box);
  });
  els.hand.appendChild(scoreRow);

  const palette = document.createElement("div");
  palette.className = "sb-palette";
  const own = myColor();
  const usesNeutrals = settings().playableNeutrals > 0;
  const colors = usesNeutrals ? [BLUE, RED, NEUTRAL] : [BLUE, RED];
  palette.classList.toggle("three", usesNeutrals);
  colors.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sb-swatch ${COLOR_NAME[color]}${color === selectedColor ? " selected" : ""}`;
    button.dataset.color = String(color);
    button.disabled = !canPlay() || (color === NEUTRAL && neutralsLeft() <= 0);
    const tag = color === NEUTRAL ? `${neutralsLeft()} left` : color === own ? "yours" : "theirs";
    button.innerHTML = `
      <span class="sb-swatch-dot"></span>
      <span class="sb-swatch-name">${COLOR_NAME[color]}</span>
      <small>${tag}</small>
    `;
    palette.appendChild(button);
  });
  els.hand.appendChild(palette);

  if (secondBestState.undoBy && secondBestState.undoBy === app.myId) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "ghost-btn sb-undo";
    undo.textContent = "Undo move";
    els.hand.appendChild(undo);
  }

  if (!secondBestState.gameOver) {
    const left = secondBestState.board.filter((value) => value === 0).length;
    const hint = document.createElement("p");
    hint.className = "sb-hint";
    const neutralNote =
      pieces.neutral > 0 || settings().playableNeutrals > 0
        ? ` · ${pieces.neutral} black on the board, blocking for nobody`
        : "";
    hint.textContent =
      `${left} squares left · you score your SECOND-biggest connected group, so one blob is worth nothing · ` +
      `ties go to whoever has fewer pieces${neutralNote}`;
    els.hand.appendChild(hint);
  }

  if (secondBestState.gameOver) {
    const banner = document.createElement("div");
    banner.className = `sb-winner ${secondBestState.winner}`;
    banner.textContent = winnerText();
    els.hand.appendChild(banner);

    const again = document.createElement("button");
    again.type = "button";
    again.className = "primary-btn sb-again";
    again.textContent = "Play again";
    els.hand.appendChild(again);
  }
}

// Always reads winner-first, so "Blue wins 5-4" can never look like a loss.
function winnerText() {
  if (!secondBestState) return "";
  const { winner, scores, pieces } = secondBestState;
  if (winner === "draw") {
    return `Draw — ${scores.blue}-${scores.red}, and ${pieces.blue} pieces each with nothing left to separate them`;
  }
  const side = winner === "blue" ? "Blue" : "Red";
  const won = winner === "blue" ? scores.blue : scores.red;
  const lost = winner === "blue" ? scores.red : scores.blue;
  if (won === lost) {
    const own = winner === "blue" ? pieces.blue : pieces.red;
    const other = winner === "blue" ? pieces.red : pieces.blue;
    return `${side} takes the tiebreak at ${won}-${lost} — fewer pieces on the board (${own} vs ${other})`;
  }
  return `${side} wins ${won}-${lost} on second-biggest group`;
}

function updateSecondBestTurn() {
  if (!secondBestState) return;
  if (secondBestState.gameOver) {
    els.turnStatus.textContent = `Game over — ${winnerText()}`;
    setBotThinking(false);
    return;
  }
  const side = secondBestState.toMove === 0 ? "Blue" : "Red";
  const mine = canPlay();
  els.turnStatus.textContent = app.isSoloGame
    ? `${side} to move`
    : mine
    ? `Your turn — ${side}`
    : `Opponent's turn — ${side}`;
  setBotThinking(app.isBotGame && !mine);
}

/* --- Input --------------------------------------------------------------- */

els.hand.addEventListener("click", (event) => {
  if (!isActive() || !secondBestState) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.closest(".sb-again")) {
    if (app.roomId) socket.emit("second_best_restart", { roomId: app.roomId });
    return;
  }

  if (target.closest(".sb-undo")) {
    if (app.roomId) socket.emit("second_best_undo", { roomId: app.roomId });
    return;
  }

  const swatch = target.closest(".sb-swatch");
  if (!swatch || swatch.disabled) return;
  selectedColor = Number(swatch.dataset.color);
  pickedThisMatch = true;
  renderBoard();
  renderPanel();
});

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive() || !secondBestState || secondBestState.gameOver) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const cellButton = target.closest(".sb-cell");
  if (!cellButton || !app.roomId) return;
  const cell = Number(cellButton.dataset.cell);
  if (secondBestState.board[cell] !== 0 || !canPlay()) return;
  if (selectedColor === NEUTRAL && neutralsLeft() <= 0) return;
  socket.emit("second_best_place", { roomId: app.roomId, cell, color: selectedColor });
});

// 1/2/3 pick blue/red/neutral without leaving the board.
window.addEventListener("keydown", (event) => {
  if (!isActive() || !secondBestState || secondBestState.gameOver) return;
  const color = { 1: BLUE, 2: RED, 3: NEUTRAL }[event.key];
  if (!color) return;
  if (color === NEUTRAL && (settings().playableNeutrals <= 0 || neutralsLeft() <= 0)) return;
  selectedColor = color;
  pickedThisMatch = true;
  renderBoard();
  renderPanel();
});

function resetUi() {
  els.gameBoard.classList.remove("second-best-board", "locked");
  els.gameBoard.style.removeProperty("--sb-pick");
  els.gameBoard.style.removeProperty("--sb-cols");
  els.hand.classList.remove("second-best-panel");
}

export const secondBest = {
  id: "second-best",
  name: "Second Best",
  hasBots: true,

  // The shell hands the whole pre-game flow over to us: table rules plus
  // opponent choice, then we call back to start the match.
  openSetup({ mode, onReady }) {
    pendingSetup = { mode, onReady };
    renderSetup();
    buildSetup().classList.remove("hidden");
  },

  handleState(payload, resetGameUi) {
    if (!payload.secondBest) return false;
    const fresh = !secondBestState || payload.secondBest.moveCount < secondBestState.moveCount;
    secondBestState = payload.secondBest;
    // Solo play alternates sides on one screen, so a hand-picked color applies
    // to that turn only and the default returns to the new seat's own color.
    if (fresh || (app.isSoloGame && secondBestState.toMove !== lastSeatSeen)) pickedThisMatch = false;
    lastSeatSeen = secondBestState.toMove;
    if (!pickedThisMatch) selectedColor = myColor();
    // The stock can run dry while black is still the held color.
    if (selectedColor === NEUTRAL && neutralsLeft() <= 0) selectedColor = myColor();
    resetGameUi();
    renderBoard();
    renderPanel();
    updateSecondBestTurn();
    return true;
  },

  handleTurn() {
    if (!isActive() || !secondBestState) return false;
    updateSecondBestTurn();
    return true;
  },

  clearState() {
    secondBestState = null;
  },

  resetUi,

  onMatchFound() {
    pickedThisMatch = false;
  },

  onOpponentLeft() {
    secondBestState = null;
  },

  onExit() {
    secondBestState = null;
    pickedThisMatch = false;
    lastSeatSeen = null;
    selectedColor = BLUE;
  }
};
