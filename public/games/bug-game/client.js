// Bug Game client: a setup screen (your table, the bug you'll play, other
// tables you could join), then the game — the table of overlapping soil cards
// on the right, everything you hold on the left.
//
// Anything you can put down is picked up the same way: drag it, or click it
// and it sticks to the pointer until the next click. The soil card is shown
// both ways round, so you pick up the side you want; while holding it,
// right-click (or R) turns it and F mirrors it. F flips a poop token to its
// rock side too. While held, a piece snaps to the table's grid and goes red
// where it can't go, with the reason under your hand. The server has the last
// word, but runs the same checks, so the red is never a surprise.
//
// The table zooms itself to fit the cards plus a margin to play into, and
// holds still while something is held so the snap doesn't shift.
import { socket, els, app, setBotThinking } from "../../shared/context.js";

const W = 3; // a soil card's cells, unturned
const H = 4;
const MARGIN = 4; // empty cells shown around the cards
const MAX_CELL = 84;
const SIDE_CELL = 70; // the soil card in the side panel: 4 cells = the panel's width
const PEEK_CELL = 14; // the other held cards and the pile's top, small
const DRAG_PX = 6; // movement that turns a press into a drag

// Where each symbol sits on card 1, for cutting icons out of its picture.
const ICON_AT = { S: [2, 0], R: [2, 1], P: [0, 2], G: [1, 2], L: [1, 1], X: [1, 3] };
const BUG_NAME = { S: "Scorpion", R: "Cockroach", P: "Rolly Polly", G: "Spider" };
const BUG_COLOR = { S: "#e8c547", R: "#e8643c", P: "#4f6ae0", G: "#78b04a" };

const PROBLEM = {
  rock: "Rocks can't be covered",
  token: "Tokens can't be covered",
  apart: "It has to overlap a card or share a side with the board",
  far: "Tokens go on the board or right beside it",
  taken: "There's a token there already",
  opponent: "Another player's bug can't be covered"
};

let state = null;
let handRot = 0;
let handMirror = false; // the soil card is shown, and held, mirrored
let held = null; // { kind: "card", mirror } | { kind: "token", type }, plus pointer bookkeeping
let frame = null; // { cell, ox, oy } — the table's zoom, frozen while held
let ghost = null;
let note = ""; // a one-off message under the hand (a dance that isn't there yet)
let inbound = { poop: 0, baby: 0 }; // earned tokens still flying to your stacks
let seenGain = null; // the last batch of earned tokens already shown

const isActive = () => app.currentGame?.id === "bug-game";
const emit = (event, payload = {}, ack) => {
  if (app.roomId) socket.emit(event, { roomId: app.roomId, ...payload }, ack);
};
const img = (card) => `/games/bug-game/cards/card-${String(card + 1).padStart(2, "0")}.jpg`;
const size = (rot) => (rot % 2 ? [H, W] : [W, H]);
const key = (x, y) => `${x},${y}`;
const me = () => state.seats[state.mySeat];
const canAct = () => state.phase === "play" && state.turn === state.mySeat && !state.choosing;
const canLay = () => canAct() && !state.laid && me().hand !== null;
const seatName = (i) => (i === state.mySeat ? "You" : state.seats[i].isBot ? "Bot" : `Player ${i + 1}`);

// --- rules (the same as server/games/bug-game/engine.js) --------------------

function oriented(card, rot, mirror) {
  let g = state.cards[card].map((row) => row.split(""));
  if (mirror) g = g.map((row) => [...row].reverse());
  for (let k = 0; k < rot; k += 1) {
    const h = g.length;
    const w = g[0].length;
    g = Array.from({ length: w }, (_, y) => Array.from({ length: h }, (_, x) => g[h - 1 - x][y]));
  }
  return g;
}

function topCells() {
  const top = new Map();
  for (const p of state.placed) {
    oriented(p.card, p.rot, p.mirror).forEach((row, dy) =>
      row.forEach((sym, dx) => top.set(key(p.x + dx, p.y + dy), sym))
    );
  }
  return top;
}

const tokenKeys = () => new Set(state.tokens.map((t) => key(t.x, t.y)));

// The board is every card cell plus every token; a token off the cards
// extends it. Corners never count as touching.
const besideBoard = (top, tokens, x, y) =>
  [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([sx, sy]) => top.has(key(x + sx, y + sy)) || tokens.has(key(x + sx, y + sy)));

function cardProblem(x, y, rot, mirror) {
  const top = topCells();
  const tokens = tokenKeys();
  const grid = oriented(me().hand, rot, mirror);
  let ok = false;
  for (let dy = 0; dy < grid.length; dy += 1) {
    for (let dx = 0; dx < grid[0].length; dx += 1) {
      const k = key(x + dx, y + dy);
      if (tokens.has(k)) return "token";
      const below = top.get(k);
      if (below === "X") return "rock";
      if (below !== undefined || besideBoard(top, tokens, x + dx, y + dy)) ok = true;
    }
  }
  return ok ? null : "apart";
}

function tokenProblem(x, y) {
  const top = topCells();
  const tokens = tokenKeys();
  if (tokens.has(key(x, y))) return "taken";
  const sym = top.get(key(x, y));
  if (sym === undefined) return besideBoard(top, tokens, x, y) ? null : "far";
  const owner = state.seats.findIndex((s) => s.bug === sym);
  return owner !== -1 && owner !== state.mySeat ? "opponent" : null;
}

// --- pieces -------------------------------------------------------------------

const icon = (sym, px, cls = "") => {
  const [col, row] = ICON_AT[sym];
  return `<span class="bg-icon ${cls}" style="width:${px}px;height:${px}px;background-image:url(${img(0)});background-position:${col * 50}% ${(row * 100) / 3}%"></span>`;
};

const POOP_SVG = `<svg viewBox="0 0 40 40" class="bg-poop" aria-hidden="true">
    <ellipse cx="20" cy="31" rx="15" ry="6" /><ellipse cx="20" cy="23.5" rx="11" ry="5.5" />
    <ellipse cx="20" cy="16" rx="7" ry="4.8" /><path d="M20 6 q5 4 1 8 h-3 q3 -3 2 -8z" />
  </svg>`;

function tokenFace(type, bug, px) {
  if (type === "poop") return `<span class="bg-tok poop" style="width:${px}px;height:${px}px">${POOP_SVG}</span>`;
  if (type === "rock") return `<span class="bg-tok rock" style="width:${px}px;height:${px}px">${icon("X", px)}</span>`;
  return `<span class="bg-tok baby" style="width:${px}px;height:${px}px;--ring:${BUG_COLOR[bug]}">${icon(bug, px * 0.8)}</span>`;
}

// A soil card as a box the size of its turned footprint, with the picture
// mirrored and turned inside it about the centre.
function cardHtml(card, rot, mirror, cell, cls = "", style = "") {
  const [w, h] = size(rot);
  return `<div class="bg-card ${cls}" style="width:${w * cell}px;height:${h * cell}px;${style}">
      <img src="${img(card)}" alt="" draggable="false"
        style="width:${W * cell}px;height:${H * cell}px;transform:translate(-50%,-50%) rotate(${rot * 90}deg) scaleX(${mirror ? -1 : 1})" />
    </div>`;
}

// A colony dance: the gridded dirt cut from the card's own art, with its
// points in the corner.
function danceHtml(index, cls = "", attrs = "") {
  const art = `/games/bug-game/cards/dance-${String(index + 1).padStart(2, "0")}.jpg`;
  return `<div class="bg-dance ${cls}" ${attrs}><img src="${art}" alt="" draggable="false" /><b>+${state.dances[index].pts}</b></div>`;
}

// --- setup --------------------------------------------------------------------

function renderSetup() {
  const mine = me();
  const seats = state.seats
    .map(
      (s, i) => `<li${i === state.mySeat ? ' class="mine"' : ""}>
        ${s.bug ? icon(s.bug, 32) : '<span class="bg-icon blank"></span>'}
        <span>${seatName(i)}${i === 0 ? " · host" : ""}</span>
        <em>${s.bug ? BUG_NAME[s.bug] : "choosing…"}</em>
      </li>`
    )
    .join("");
  const picks = state.bugs
    .map((b) => {
      const taken = state.seats.some((s, i) => i !== state.mySeat && s.bug === b);
      return `<button type="button" class="bg-bugpick${mine.bug === b ? " on" : ""}" data-bug="${b}" ${taken ? "disabled" : ""}
          style="--ring:${BUG_COLOR[b]}">${icon(b, 56)}<span>${BUG_NAME[b]}</span></button>`;
    })
    .join("");
  const startRow =
    state.mySeat === 0
      ? `<button type="button" class="primary-btn bg-start" ${state.canStart ? "" : "disabled"}>
          Start with ${state.seats.length} player${state.seats.length > 1 ? "s" : ""}</button>
         <p class="bg-muted">${state.canStart ? "" : "Everyone needs a bug first."}</p>`
      : `<p class="bg-muted">Waiting for the host to start.</p>`;
  // Alone at the table: play the bot instead, 1v1.
  const botRow =
    state.mySeat === 0 && state.seats.length === 1
      ? `<button type="button" class="ghost-btn bg-vsbot" ${mine.bug ? "" : "disabled"}>Play the bot (1v1)</button>
         <p class="bg-muted">${mine.bug ? "Who goes first is random." : "Pick your bug first."}</p>`
      : "";
  const tables = state.tables.length
    ? `<h3>Or join a table</h3><ul class="bg-tables">${state.tables
        .map(
          (t) => `<li><span>Table ${t.table} · ${t.seated} seated</span>
            <button type="button" class="ghost-btn" data-join="${t.roomId}">Join</button></li>`
        )
        .join("")}</ul>`
    : "";
  els.gameBoard.innerHTML = `<div class="bg-setup">
      <h2>Table ${state.table}</h2>
      <ol class="bg-seatlist">${seats}</ol>
      <h3>Your bug</h3>
      <div class="bg-bugpicks">${picks}</div>
      ${startRow}
      ${botRow}
      ${tables}
    </div>`;
  els.turnStatus.textContent = "Setting up";
}

// --- the table ------------------------------------------------------------------

function computeFrame() {
  const field = els.gameBoard.querySelector(".bg-field");
  if (!field) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of state.placed) {
    const [w, h] = size(p.rot);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w);
    maxY = Math.max(maxY, p.y + h);
  }
  for (const t of state.tokens) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + 1);
    maxY = Math.max(maxY, t.y + 1);
  }
  minX -= MARGIN;
  minY -= MARGIN;
  maxX += MARGIN;
  maxY += MARGIN;
  const { width, height } = field.getBoundingClientRect();
  const cell = Math.max(12, Math.min(MAX_CELL, width / (maxX - minX), height / (maxY - minY)));
  return {
    cell,
    ox: (width - (maxX - minX) * cell) / 2 - minX * cell,
    oy: (height - (maxY - minY) * cell) / 2 - minY * cell
  };
}

function renderTable() {
  const world = els.gameBoard.querySelector(".bg-world");
  if (!world) return;
  if (!held) frame = computeFrame();
  if (!frame) return;
  const { cell, ox, oy } = frame;
  world.style.setProperty("--cell", `${cell}px`);
  world.style.backgroundPosition = `${ox}px ${oy}px`;
  const last = state.placed.length - 1;
  const cards = state.placed
    .map((p, i) =>
      cardHtml(p.card, p.rot, p.mirror, cell, i === last && last > 0 ? "bg-last" : "", `left:${ox + p.x * cell}px;top:${oy + p.y * cell}px`)
    )
    .join("");
  // A token off the cards sits on a patch of its own: it is board now.
  const top = topCells();
  const tokens = state.tokens
    .map(
      (t) => `<div class="bg-placed-tok${top.has(key(t.x, t.y)) ? "" : " off"}" style="left:${ox + t.x * cell}px;top:${oy + t.y * cell}px;width:${cell}px;height:${cell}px">
        ${tokenFace(t.type, t.bug, cell * 0.78)}</div>`
    )
    .join("");
  world.innerHTML = cards + tokens;
}

// --- the side panel -------------------------------------------------------------

// Centred in the header, over the space it already has: your bug, then every
// bug at the table in turn order with the one playing ringed.
function renderOrder() {
  const header = els.gameTitle.parentElement;
  let strip = header.querySelector(".bg-order");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "bg-order";
    header.appendChild(strip);
  }
  strip.hidden = false;
  const order = state.seats
    .map((s, i) => {
      const turn = state.phase === "play" && state.turn === i;
      return `<span class="bg-seat${turn ? " turn" : ""}" style="--ring:${BUG_COLOR[s.bug]}" title="${seatName(i)} · ${BUG_NAME[s.bug]}">
          ${icon(s.bug, 30)}<b>${s.score.total}</b></span>`;
    })
    .join("");
  strip.innerHTML = `<span class="bg-me">${icon(me().bug, 34)}<small>You</small></span><span class="bg-sep"></span>${order}`;
}

// Your card, big. Then, small, every other card in sight: what each other
// player holds (they play it next) and the top of the pile (whoever ends the
// turn draws it) — the cards are printed both sides, so all of it is open.
function soilHtml() {
  const mine = me().hand;
  const myTurn = state.turn === state.mySeat;
  const live = canLay();
  const title = mine === null ? (myTurn ? "Laid · you draw at End turn" : "No card left") : myTurn ? "Your soil card" : "Your next card";
  const big =
    mine === null
      ? `<div class="bg-soil empty">${myTurn && state.pileTop !== null ? "The pile's top card is yours at End turn" : ""}</div>`
      : `<div class="bg-soil${live ? " bg-pick" : ""}${held?.kind === "card" ? " lifted" : ""}" data-kind="card">
          ${cardHtml(mine, handRot, handMirror, SIDE_CELL)}</div>`;
  const peek = (label, card) =>
    `<div class="bg-peek">${label}${card !== null ? cardHtml(card, 0, false, PEEK_CELL) : `<span class="bg-peek-none">—</span>`}</div>`;
  const others = state.seats.map((o, i) => (i === state.mySeat ? "" : peek(icon(o.bug, 18), o.hand))).join("");
  return `<section>
      <h4>${title}</h4>
      <div class="bg-soils">${big}</div>
      ${mine !== null ? `<p class="bg-keys"><kbd>Right-click</kbd> or <kbd>R</kbd> rotate · <kbd>F</kbd> flip</p>` : ""}
      <div class="bg-peeks">${others}${peek(`<small>Pile ${state.pileLeft}</small>`, state.pileTop)}</div>
    </section>`;
}

// Your two stacks. A token still flying in isn't counted until it lands.
function tokensHtml() {
  const s = me();
  const live = canAct();
  const tok = (type, count) =>
    `<div class="bg-tokslot${live && count ? " bg-pick" : ""}${count ? "" : " none"}" data-kind="token" data-type="${type}">
      ${tokenFace(type, s.bug, 38)}<span>×${count}</span></div>`;
  return `<section class="bg-lower"><h4>Your tokens</h4><div class="bg-toks">
      ${tok("poop", s.poop - inbound.poop)}${tok("baby", s.babies - inbound.baby)}</div></section>`;
}

function danceSectionHtml() {
  const s = me();
  const live = canAct();
  const mine = s.dance !== null ? danceHtml(s.dance, "mine") : `<div class="bg-dance empty">—</div>`;
  const market = state.market.map((d, slot) => danceHtml(d, "", `data-slot="${slot}"`)).join("");
  const pick = state.choosing && state.turn === state.mySeat;
  // Everyone's dance is open information.
  const theirs = state.seats
    .map((o, i) =>
      i === state.mySeat
        ? ""
        : `<div class="bg-theirs">${icon(o.bug, 22)}${o.dance !== null ? danceHtml(o.dance) : `<div class="bg-dance empty">—</div>`}</div>`
    )
    .join("");
  return `<section>
      <h4>Your colony dance <small>${s.done.length ? `${s.done.length} done` : ""}</small></h4>
      <div class="bg-mydance">${mine}
        <div class="bg-dance-btns">
          <button type="button" class="primary-btn bg-complete" ${live && s.dance !== null ? "" : "disabled"}>Complete</button>
        </div>
      </div>
      <h4>${pick ? "Choose your new dance" : "Market"}</h4>
      <div class="bg-market${pick ? " picking" : ""}">${market}</div>
      ${theirs ? `<h4>Their dances</h4><div class="bg-market bg-others">${theirs}</div>` : ""}
    </section>`;
}

function resultHtml() {
  const r = state.result;
  const rows = state.seats
    .map((s, i) => {
      const sc = r.scores[i];
      return `<tr class="${r.winners.includes(i) ? "won" : ""}"><td>${icon(s.bug, 22)} ${seatName(i)}</td>
        <td>${sc.bugs}</td><td>${sc.poop}</td><td>${sc.group}</td><td>${sc.dance}</td><td><b>${sc.total}</b></td></tr>`;
    })
    .join("");
  const names = r.winners.map(seatName);
  const headline = names.length > 1 ? `${names.join(" & ")} rule the garden together` : `${names[0]} ${names[0] === "You" ? "win" : "wins"}`;
  return `<section class="bg-result"><h4>${headline}</h4>
      <table><thead><tr><th></th><th>Bugs</th><th>Poop</th><th>Groups</th><th>Dance</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${state.mySeat === 0 ? `<button type="button" class="primary-btn bg-again">Play again</button>` : ""}</section>`;
}

function renderSide() {
  const side = els.gameBoard.querySelector(".bg-side");
  if (!side) return;
  const over = state.phase === "over";
  const myTurn = state.turn === state.mySeat && !over;
  side.innerHTML = `
    ${over ? resultHtml() : soilHtml() + tokensHtml() + danceSectionHtml()}
    <p class="bg-hint">${note}</p>
    ${
      myTurn
        ? `<div class="bg-turnbtns">
            <button type="button" class="ghost-btn bg-undo" ${state.canUndo ? "" : "disabled"}>Undo</button>
            <button type="button" class="primary-btn bg-end" ${state.laid && !state.choosing ? "" : "disabled"}>End turn</button>
          </div>`
        : ""
    }`;
}

function renderTurn() {
  if (state.phase === "setup") return;
  let text;
  if (state.phase === "over") text = "Game over";
  else if (state.turn !== state.mySeat) text = `${BUG_NAME[state.seats[state.turn].bug]}'s turn`;
  else if (state.choosing) text = "Pick a new dance";
  else if (!state.laid) text = "Lay the soil card";
  else text = "Tokens and dances, then End turn";
  els.turnStatus.textContent = `${text} · card ${state.placed.length}/${state.total}`;
}

function render() {
  if (state.phase === "setup") {
    els.gameBoard.classList.remove("bg-board");
    els.gameBoard.classList.add("bg-board-setup");
    renderSetup();
    return;
  }
  renderOrder();
  els.gameBoard.classList.remove("bg-board-setup");
  els.gameBoard.classList.add("bg-board");
  if (!els.gameBoard.querySelector(".bg-field")) {
    els.gameBoard.innerHTML = `<div class="bg-side"></div><div class="bg-field"><div class="bg-world"></div></div>`;
  }
  renderSide();
  renderTable();
  renderTurn();
}

// --- holding things -------------------------------------------------------------

// Where the held piece would land, or null when the pointer is off the table.
// A card is centred on the pointer; a token takes the cell under it.
function target() {
  const field = els.gameBoard.querySelector(".bg-field");
  if (!field || !frame) return null;
  const r = field.getBoundingClientRect();
  if (held.px < r.left || held.px > r.right || held.py < r.top || held.py > r.bottom) return null;
  const fx = (held.px - r.left - frame.ox) / frame.cell;
  const fy = (held.py - r.top - frame.oy) / frame.cell;
  let x;
  let y;
  let why;
  if (held.kind === "card") {
    const [w, h] = size(handRot);
    x = Math.round(fx - w / 2);
    y = Math.round(fy - h / 2);
    why = cardProblem(x, y, handRot, handMirror);
  } else {
    x = Math.floor(fx);
    y = Math.floor(fy);
    why = tokenProblem(x, y);
  }
  return { x, y, left: r.left + frame.ox + x * frame.cell, top: r.top + frame.oy + y * frame.cell, why };
}

function drawGhost() {
  if (!held) return;
  const cell = frame?.cell ?? 40;
  const spot = target();
  const tone = spot ? (spot.why ? " bad" : " good") : "";
  if (!ghost) {
    ghost = document.createElement("div");
    document.body.appendChild(ghost);
  }
  if (held.kind === "card") {
    const [w, h] = size(handRot);
    const left = spot ? spot.left : held.px - (w * cell) / 2;
    const top = spot ? spot.top : held.py - (h * cell) / 2;
    ghost.innerHTML = cardHtml(me().hand, handRot, handMirror, cell, `bg-ghost${tone}`, `left:${left}px;top:${top}px`);
  } else {
    const left = spot ? spot.left : held.px - cell / 2;
    const top = spot ? spot.top : held.py - cell / 2;
    ghost.innerHTML = `<div class="bg-ghost bg-ghost-tok${tone}" style="left:${left}px;top:${top}px;width:${cell}px;height:${cell}px">
        ${tokenFace(held.type, me().bug, cell * 0.78)}</div>`;
  }
  const hint = els.gameBoard.querySelector(".bg-hint");
  if (hint) hint.textContent = spot?.why ? PROBLEM[spot.why] : held.kind === "card" ? "" : held.type === "baby" ? "" : "Right-click flips it poop ↔ rock";
}

function pickUp(event, el) {
  const base = { startX: event.clientX, startY: event.clientY, px: event.clientX, py: event.clientY, dragged: false };
  held = el.dataset.kind === "card" ? { ...base, kind: "card" } : { ...base, kind: "token", type: el.dataset.type };
  note = "";
  frame = computeFrame();
  renderSide();
  drawGhost();
}

function letGo() {
  held = null;
  ghost?.remove();
  ghost = null;
  if (state && isActive() && state.phase !== "setup") render();
}

// Put the held piece down where the pointer is, if it may go there.
function drop() {
  const spot = target();
  if (!spot || spot.why) return false;
  const { x, y } = spot;
  // Shown at once; the server's state replaces it a moment later.
  if (held.kind === "card") {
    const move = { x, y, rot: handRot, mirror: handMirror };
    state.placed = [...state.placed, { card: me().hand, ...move }];
    me().hand = null;
    state.laid = true;
    handRot = 0;
    handMirror = false;
    emit("bug_game_card", move);
  } else {
    const s = me();
    state.tokens = [...state.tokens, { x, y, type: held.type, seat: state.mySeat, bug: held.type === "baby" ? s.bug : null }];
    if (held.type === "baby") s.babies -= 1;
    else s.poop -= 1;
    emit("bug_game_token", { x, y, type: held.type });
  }
  letGo();
  return true;
}

function turnCard() {
  handRot = (handRot + 1) % 4;
  if (held) drawGhost();
  else renderSide();
}

function mirrorCard() {
  if (held?.kind === "token") return;
  handMirror = !handMirror;
  if (held) drawGhost();
  else renderSide();
}

// Right-click / R: turns the soil card, or flips a held poop token over.
function twist() {
  if (held?.kind === "token") {
    if (held.type === "baby") return;
    held.type = held.type === "poop" ? "rock" : "poop";
    drawGhost();
  } else turnCard();
}

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive() || !state || !(event.target instanceof Element)) return;
  const t = event.target;
  const bug = t.closest("[data-bug]");
  if (bug && !bug.disabled) return emit("bug_game_pick", { bug: bug.dataset.bug });
  const join = t.closest("[data-join]");
  if (join) return emit("bug_game_join", { target: join.dataset.join });
  if (t.closest(".bg-start")) return emit("bug_game_start");
  if (t.closest(".bg-vsbot")) return emit("bug_game_bot");
  if (t.closest(".bg-again")) {
    handRot = 0;
    handMirror = false;
    return emit("bug_game_again");
  }
  if (t.closest(".bg-end")) return emit("bug_game_end");
  if (t.closest(".bg-undo")) {
    letGo();
    return emit("bug_game_undo");
  }
  if (t.closest(".bg-complete")) {
    emit("bug_game_complete", {}, (res) => {
      if (res?.ok || !state) return;
      note = "That pattern isn't on the table yet";
      const hint = els.gameBoard.querySelector(".bg-hint");
      if (hint) hint.textContent = note;
    });
    return;
  }
  const slot = t.closest(".bg-market.picking [data-slot]");
  if (slot) emit("bug_game_choose", { slot: Number(slot.dataset.slot) });
});

window.addEventListener("pointerdown", (event) => {
  if (!isActive() || !state || state.phase !== "play" || event.button !== 0) return;
  if (held) {
    // A stuck-on piece: a click on the table puts it down, a click off it lets go.
    held.px = event.clientX;
    held.py = event.clientY;
    if (!drop() && !target()) letGo();
    event.preventDefault();
    return;
  }
  const el = event.target instanceof Element && event.target.closest(".bg-pick");
  if (!el || !canAct()) return;
  if (el.dataset.kind === "card" && !canLay()) return;
  event.preventDefault();
  pickUp(event, el);
});

window.addEventListener("pointermove", (event) => {
  if (!held || !isActive()) return;
  held.px = event.clientX;
  held.py = event.clientY;
  if (Math.hypot(held.px - held.startX, held.py - held.startY) > DRAG_PX) held.dragged = true;
  drawGhost();
});

window.addEventListener("pointerup", (event) => {
  if (!held || !isActive() || event.button !== 0) return;
  // A click (no drag) leaves the piece stuck to the pointer until the next one.
  if (!held.dragged) return;
  held.px = event.clientX;
  held.py = event.clientY;
  if (!drop()) letGo();
});

window.addEventListener("contextmenu", (event) => {
  if (!isActive() || !state || state.phase !== "play") return;
  const inGame = event.target instanceof Element && event.target.closest("#game-board");
  if (!held && !inGame) return;
  event.preventDefault();
  twist();
});

window.addEventListener("keydown", (event) => {
  if (!isActive() || !state || state.phase !== "play") return;
  if (event.key === "r" || event.key === "R") twist();
  else if (event.key === "f" || event.key === "F") mirrorCard();
  else if (event.key === "Escape" && held) letGo();
});

window.addEventListener("resize", () => {
  if (isActive() && state && state.phase !== "setup" && !held) renderTable();
});

// --- earned tokens ----------------------------------------------------------------

const FLY_MS = 800;

// Sends each token you just earned from the cell that made it to its stack,
// one after another. The stack's count goes up as each one lands.
function flyGains(items) {
  items.forEach((it) => {
    inbound[it.type] += 1;
  });
  items.forEach((it, i) => setTimeout(() => fly(it), 250 + i * 260));
}

function landed(type) {
  inbound[type] = Math.max(0, inbound[type] - 1);
  if (state && isActive() && state.phase === "play") renderSide();
}

function fly(it) {
  const field = els.gameBoard.querySelector(".bg-field");
  const slot = els.gameBoard.querySelector(`.bg-tokslot[data-type="${it.type}"] .bg-tok`);
  if (!field || !slot || !frame || !state) return landed(it.type);
  const r = field.getBoundingClientRect();
  const sx = r.left + frame.ox + (it.x + 0.5) * frame.cell;
  const sy = r.top + frame.oy + (it.y + 0.5) * frame.cell;
  const t = slot.getBoundingClientRect();
  const ex = t.left + t.width / 2;
  const ey = t.top + t.height / 2;
  const start = (frame.cell * 0.78) / t.width;
  const el = document.createElement("div");
  el.className = "bg-flyer";
  el.innerHTML = tokenFace(it.type, me().bug, t.width);
  document.body.appendChild(el);
  const at = (x, y, scale) => `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
  const anim = el.animate(
    [
      { transform: at(sx, sy, start * 0.3), opacity: 0 },
      { transform: at(sx, sy - frame.cell * 0.4, start * 1.25), opacity: 1, offset: 0.25 },
      { transform: at(ex, ey, 1), opacity: 1 }
    ],
    { duration: FLY_MS, easing: "cubic-bezier(.45,0,.25,1)", fill: "forwards" }
  );
  anim.onfinish = () => {
    el.remove();
    landed(it.type);
  };
}

// --- module -------------------------------------------------------------------

function resetUi() {
  els.gameBoard.classList.remove("bg-board", "bg-board-setup");
  const strip = els.gameTitle.parentElement.querySelector(".bg-order");
  if (strip) strip.hidden = true;
}

function newMatch() {
  state = null;
  handRot = 0;
  handMirror = false;
  held = null;
  note = "";
  inbound = { poop: 0, baby: 0 };
  seenGain = null;
  ghost?.remove();
  ghost = null;
}

export const bugGame = {
  id: "bug-game",
  name: "Bug Game",
  // Opening it makes you a table; others join from their own setup screen.
  soloOnly: true,

  handleState(payload, resetGameUi) {
    if (!payload.bugGame) return false;
    const prev = state;
    state = payload.bugGame;
    // Joining another table moves you to its room.
    app.roomId = state.roomId;
    if (prev && (prev.phase !== state.phase || prev.turn !== state.turn)) note = "";
    if (state.phase !== "play" && held) {
      held = null;
      ghost?.remove();
      ghost = null;
    }
    if (prev?.phase === "setup" && state.phase !== "setup") els.gameBoard.innerHTML = "";
    // Tokens you just earned: held back from your stacks until they fly in.
    const gains = state.gains;
    const fresh = prev && gains && gains.n !== seenGain && gains.seat === state.mySeat && gains.items.length;
    seenGain = gains?.n ?? 0;
    if (state.phase !== "play") inbound = { poop: 0, baby: 0 };
    resetGameUi();
    els.hand.innerHTML = "";
    if (fresh) flyGains(gains.items);
    render();
    if (held) drawGhost();
    // The shared bouncing dots while the bot works out its turn.
    setBotThinking(state.phase === "play" && !!state.seats[state.turn]?.isBot);
    return true;
  },

  handleTurn() {
    if (!isActive() || !state) return false;
    renderTurn();
    return true;
  },

  clearState() {
    state = null;
  },

  resetUi,
  onMatchFound: newMatch,
  onOpponentLeft: newMatch,
  onExit: newMatch
};
