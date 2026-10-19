// Lost Cities client: the table as it sits between two explorers.
//
// The opponent's expeditions climb up from the middle, yours climb down, and
// the discard piles sit between them, one per colour, lined up under the
// columns they belong to, with the deck at the end of that row. A column is
// fanned so every card's number still shows: yours hang downward from the
// first card, theirs stack upward, which is why each card prints its number in
// both corners.
//
// Nothing is totalled while a round is on -- the arithmetic is part of the
// game, as it is at a real table. Scores appear when the round ends.
import { socket, els, app, setBotThinking } from "../../shared/context.js";

const SLOTS = 12;
const WAGERS = 3;
const WAGER_GLYPH = "\u{1F91D}";

const COLORS = [
  { key: "yellow", name: "Yellow" },
  { key: "blue", name: "Blue" },
  { key: "white", name: "White" },
  { key: "green", name: "Green" },
  { key: "red", name: "Red" },
  { key: "purple", name: "Purple" }
];

// One small mark per expedition -- sun, wave, peaks, leaf, volcano, crystal --
// so a colour can be told apart without its colour.
const ICONS = [
  `<circle cx="12" cy="12" r="4.6" fill="currentColor"/><g stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></g>`,
  `<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2.5 9c2.4-2.6 4.7-2.6 7 0s4.7 2.6 7 0 4.6-2.6 5 0"/><path d="M2.5 16c2.4-2.6 4.7-2.6 7 0s4.7 2.6 7 0 4.6-2.6 5 0"/></g>`,
  `<path d="M1.5 20.5 8.5 6.5l4.2 7.6 3-4.6 6.8 11z" fill="currentColor"/>`,
  `<path d="M12 2C5.2 7 4.8 15.6 12 22c7.2-6.4 6.8-15-0-20z" fill="currentColor"/><path d="M12 6v14" stroke="rgba(0,0,0,0.35)" stroke-width="1.6"/>`,
  `<path d="M2.5 21.5 9 11h6l6.5 10.5z" fill="currentColor"/><path d="M11 8.5c-1-2.6 2.6-2.8 1.6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  `<path d="M12 2 19.5 9 12 22 4.5 9z" fill="currentColor"/><path d="M4.5 9h15M12 2 9 9l3 13 3-13z" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="1.2"/>`
];

const BOT_OPTIONS = [
  { bot: 0, title: "Tourist", sub: "Wanders a lot — good for learning the game" },
  { bot: 1, title: "Explorer", sub: "Sound plans, the odd wrong turn" },
  { bot: 2, title: "Archaeologist", sub: "Its best move every turn" }
];

const cardColor = (id) => Math.floor(id / SLOTS);
const cardValue = (id) => {
  const slot = id % SLOTS;
  return slot < WAGERS ? 0 : slot - 1;
};
const topValue = (col) => (col.length ? cardValue(col[col.length - 1]) : -1);
const canExtend = (col, id) => {
  const top = topValue(col);
  const value = cardValue(id);
  if (top < 0) return true;
  return value === 0 ? top === 0 : value > top;
};
const cardName = (id) => {
  const value = cardValue(id);
  return `${COLORS[cardColor(id)].name} ${value === 0 ? "wager" : value}`;
};
const byColorThenValue = (a, b) => cardColor(a) - cardColor(b) || cardValue(a) - cardValue(b) || a - b;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

let state = null;
let selected = null;
// The card you drew last, tagged in your hand until your next play.
let freshCard = null;
let rulesOpen = false;
let setupEl = null;
let pendingSetup = null;
const chosen = loadChoices();

const isActive = () => app.currentGame?.id === "lost-cities";
const opp = () => 1 - state.you;
const playing = () => state && (state.phase === "play" || state.phase === "draw");
const myTurn = () => playing() && state.toMove === state.you;
const myPlay = () => myTurn() && state.phase === "play";
const myDraw = () => myTurn() && state.phase === "draw";
const emit = (event, payload = {}) => {
  if (app.roomId) socket.emit(event, { roomId: app.roomId, ...payload });
};

function loadChoices() {
  try {
    return {
      rounds: localStorage.getItem("lc-rounds") === "1" ? 1 : 3,
      colors: localStorage.getItem("lc-colors") === "6" ? 6 : 5
    };
  } catch {
    return { rounds: 3, colors: 5 };
  }
}

function saveChoices() {
  try {
    localStorage.setItem("lc-rounds", String(chosen.rounds));
    localStorage.setItem("lc-colors", String(chosen.colors));
  } catch {
    /* private window: the choice just won't stick */
  }
}

// --- cards ------------------------------------------------------------------

const icon = (color) => `<svg class="lc-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[color]}</svg>`;

function cardHtml(id, extra = "") {
  const color = cardColor(id);
  const value = cardValue(id);
  const mark = value === 0 ? `<span class="lc-shake">${WAGER_GLYPH}</span>` : value;
  return `<span class="lc-card lc-${COLORS[color].key}${value === 0 ? " lc-wager" : ""}${extra}" title="${cardName(id)}">
      <span class="lc-end lc-head"><span class="lc-num">${mark}</span>${icon(color)}</span>
      <span class="lc-face">${mark}</span>
      <span class="lc-end lc-foot"><span class="lc-num">${mark}</span>${icon(color)}</span>
    </span>`;
}

const slotHtml = (color, extra = "") =>
  `<span class="lc-slot lc-${COLORS[color].key}${extra}">${icon(color)}</span>`;

const backHtml = (extra = "") => `<span class="lc-card lc-back${extra}"></span>`;

// The last card the other side put out is ringed, so their turn can be read
// after it has happened.
function lastMark(id) {
  const last = state.lastPlay;
  return last && last.card === id && last.seat !== state.you ? " lc-last" : "";
}

// --- table ------------------------------------------------------------------

function columnHtml(seat, color) {
  const col = state.expeditions[seat][color];
  const mine = seat === state.you;
  const cards = col.map((id) => cardHtml(id, lastMark(id))).join("");
  const target = mine && myPlay() && selected !== null && cardColor(selected) === color && canExtend(col, selected);
  const attrs = mine ? ` data-act="col" data-color="${color}"` : "";
  return `<div class="lc-col${target ? " lc-open" : ""}"${attrs}>${cards || slotHtml(color, " lc-empty")}</div>`;
}

function scoreRowHtml(seat) {
  if (!state.result) return "";
  const rows = state.result[seat].rows;
  const chips = rows
    .map((row) => {
      if (!row.count) return `<span class="lc-chip lc-none">—</span>`;
      const formula = `(${row.sum} − 20) × ${1 + row.wagers}${row.count >= 8 ? " + 20" : ""}`;
      const tone = row.score > 0 ? " lc-up" : row.score < 0 ? " lc-down" : "";
      return `<span class="lc-chip${tone}" title="${formula}">${signed(row.score)}</span>`;
    })
    .join("");
  return `<div class="lc-row lc-scores">${chips}<span class="lc-chip lc-total">${signed(state.result[seat].total)}</span></div>`;
}

function pileHtml(color) {
  const pile = state.discards[color];
  const locked = myDraw() && color === state.justDiscarded;
  const drawable = myDraw() && pile.count > 0 && !locked;
  const discardable = myPlay() && selected !== null && cardColor(selected) === color;
  const fresh = state.lastPlay && state.lastPlay.to === "discard" && state.lastPlay.card === pile.top ? lastMark(pile.top) : "";
  const inner = pile.top === null ? slotHtml(color, " lc-board-spot") : cardHtml(pile.top, fresh);
  const count = pile.count > 1 ? `<span class="lc-count">${pile.count}</span>` : "";
  const lock = locked && pile.count ? `<span class="lc-lock">just discarded</span>` : "";
  const cls = `lc-pile${drawable ? " lc-drawable" : ""}${discardable ? " lc-open" : ""}`;
  return `<button type="button" class="${cls}" data-act="pile" data-color="${color}"${drawable || discardable ? "" : " disabled"} aria-label="${COLORS[color].name} discard pile">${inner}${count}${lock}</button>`;
}

function deckHtml() {
  const drawable = myDraw();
  return `<button type="button" class="lc-deck${drawable ? " lc-drawable" : ""}" data-act="deck"${drawable ? "" : " disabled"} aria-label="Draw pile">
      ${state.deck ? backHtml() : `<span class="lc-slot lc-deck-empty"></span>`}
      <span class="lc-deck-count">${state.deck}</span>
    </button>`;
}

function oppHandHtml() {
  const name = esc(state.names[opp()]);
  const cards = state.oppHand
    ? [...state.oppHand].sort(byColorThenValue).map((id) => cardHtml(id, " lc-mini")).join("")
    : Array.from({ length: state.oppHandCount }, () => backHtml(" lc-mini")).join("");
  const label = state.oppHand ? "left in hand" : `${state.oppHandCount} cards`;
  return `<div class="lc-opp-hand"><span class="lc-who">${name} <small>${label}</small></span><span class="lc-minis">${cards}</span></div>`;
}

function handHtml() {
  const hand = [...state.hand].sort(byColorThenValue);
  const canPick = myPlay();
  const cards = hand
    .map((id) => {
      const lifted = id === selected ? " lc-selected" : "";
      const fresh = id === freshCard ? " lc-fresh" : "";
      return `<button type="button" class="lc-hand-card${lifted}${fresh}" data-act="select" data-card="${id}"${canPick ? "" : " disabled"}>${cardHtml(id)}</button>`;
    })
    .join("");
  return `<div class="lc-hand">${cards}</div>`;
}

function actionsHtml() {
  const them = esc(state.names[opp()]);
  if (state.phase === "roundOver" || state.phase === "matchOver") {
    const last = state.phase === "matchOver";
    const mineReady = state.ready[state.you];
    const button = mineReady
      ? `<span class="lc-hint">Waiting for ${them}…</span>`
      : `<button type="button" class="lc-btn lc-primary" data-act="ready">${last ? "Play again" : "Next round"}</button>`;
    return `<span class="lc-hint lc-strong">${esc(resultLine())}</span>${button}`;
  }
  if (!myTurn()) {
    return `<span class="lc-hint">${them} is ${state.phase === "play" ? "choosing a card" : "drawing"}…</span>`;
  }
  if (state.phase === "draw") {
    const shut = state.justDiscarded !== null ? ` Not the ${COLORS[state.justDiscarded].name} pile — you just discarded there.` : "";
    return `<span class="lc-hint">Now draw one: the deck, or the top card of a discard pile.${shut}</span>`;
  }
  if (selected === null) return `<span class="lc-hint">Choose a card from your hand to play or discard.</span>`;
  const color = cardColor(selected);
  const col = state.expeditions[state.you][color];
  const ok = canExtend(col, selected);
  let why = "";
  if (!ok) {
    why =
      cardValue(selected) === 0
        ? `Wagers go down before any number, and your ${COLORS[color].name} expedition has started.`
        : `Your ${COLORS[color].name} expedition is already at ${topValue(col)}.`;
  }
  const startLabel = col.length ? `Play on ${COLORS[color].name}` : `Start ${COLORS[color].name}`;
  return `<button type="button" class="lc-btn lc-primary" data-act="expedition"${ok ? "" : " disabled"}>${startLabel}</button>
    <button type="button" class="lc-btn" data-act="discard">Discard</button>
    ${why ? `<span class="lc-hint">${why}</span>` : ""}`;
}

function resultLine() {
  const [me, them] = [state.you, opp()];
  if (state.phase === "matchOver") {
    const a = state.totals[me];
    const b = state.totals[them];
    if (state.winner === -1) return `A tie, ${a} each.`;
    return state.winner === me ? `You win, ${a} to ${b}.` : `${state.names[them]} wins, ${b} to ${a}.`;
  }
  const a = state.result[me].total;
  const b = state.result[them].total;
  return `Round ${state.round}: you ${signed(a)}, ${state.names[them]} ${signed(b)}.`;
}

// --- side panel -------------------------------------------------------------

function standingsHtml() {
  const me = state.you;
  const them = opp();
  const rows = state.history
    .map((pair, i) => `<tr><td>Round ${i + 1}</td><td>${signed(pair[me])}</td><td>${signed(pair[them])}</td></tr>`)
    .join("");
  const totals =
    state.settings.rounds > 1 && state.history.length
      ? `<tr class="lc-total-row"><td>Total</td><td>${signed(state.totals[me])}</td><td>${signed(state.totals[them])}</td></tr>`
      : "";
  const head = state.settings.rounds > 1 ? `Round ${state.round} of ${state.settings.rounds}` : "One round";
  const body = rows || totals ? `<tbody>${rows}${totals}</tbody>` : "";
  return `<section class="lc-panel">
      <div class="lc-panel-head"><strong>${head}</strong><span>${esc(state.names[state.starter])} opened</span></div>
      <table class="lc-standings"><thead><tr><th></th><th>You</th><th>${esc(state.names[them])}</th></tr></thead>${body}</table>
    </section>`;
}

function logLine(entry) {
  const who = entry.seat === state.you ? "You" : state.names[entry.seat];
  if (entry.kind === "play") return `${who} played ${cardName(entry.card)}`;
  if (entry.kind === "discard") return `${who} discarded ${cardName(entry.card)}`;
  if (entry.from === "deck") return entry.card === null ? `${who} drew from the deck` : `${who} drew ${cardName(entry.card)} from the deck`;
  return `${who} took ${cardName(entry.card)} off the discards`;
}

function logHtml() {
  if (!state.log.length) return "";
  const items = [...state.log]
    .reverse()
    .slice(0, 8)
    .map((entry) => `<li class="${entry.seat === state.you ? "lc-me" : ""}">${esc(logLine(entry))}</li>`)
    .join("");
  return `<section class="lc-panel"><div class="lc-panel-head"><strong>This round</strong></div><ul class="lc-log">${items}</ul></section>`;
}

function rulesHtml() {
  return `<details class="lc-panel lc-rules"${rulesOpen ? " open" : ""}>
      <summary>Rules</summary>
      <p>Every turn, <b>play one card</b> then <b>draw one card</b>.</p>
      <p><b>Play</b> it onto your expedition of its colour, or face up onto that colour's discard pile.</p>
      <p><b>Draw</b> from the deck, or take the top card of any discard pile — but not the one you just discarded.</p>
      <p>An expedition only climbs: each card must be higher than the one before. Wagers (${WAGER_GLYPH}) go down first, before any number.</p>
      <p>Each expedition scores its numbers <b>minus 20</b>, times <b>1 + its wagers</b>. Eight or more cards earn <b>+20</b> more. An expedition you never start scores nothing.</p>
      <p>The round ends the moment the deck's last card is drawn. Over three rounds the higher total wins; whoever leads opens the next round.</p>
    </details>`;
}

// --- render -----------------------------------------------------------------

function render() {
  els.hand.innerHTML = "";
  els.gameBoard.classList.add("lc-board");
  els.gameBoard.style.setProperty("--lc-cols", String(state.settings.colors + 1)); // + the deck
  const colors = Array.from({ length: state.settings.colors }, (_, c) => c);
  const done = state.phase === "roundOver" || state.phase === "matchOver";
  els.gameBoard.innerHTML = `
    <div class="lc-table${done ? " lc-done" : ""}">
      ${oppHandHtml()}
      ${scoreRowHtml(opp())}
      <div class="lc-row lc-theirs">${colors.map((c) => columnHtml(opp(), c)).join("")}<span></span></div>
      <div class="lc-row lc-middle">${colors.map(pileHtml).join("")}${deckHtml()}</div>
      <div class="lc-row lc-mine">${colors.map((c) => columnHtml(state.you, c)).join("")}<span></span></div>
      ${scoreRowHtml(state.you)}
      ${handHtml()}
      <div class="lc-actions">${actionsHtml()}</div>
    </div>
    <aside class="lc-side">${standingsHtml()}${logHtml()}${rulesHtml()}</aside>`;
  updateTurnText();
  setBotThinking(state.vsBot && playing() && state.toMove !== state.you);
}

function updateTurnText() {
  if (!state) return;
  let text;
  if (state.phase === "matchOver") text = "Match over";
  else if (state.phase === "roundOver") text = `Round ${state.round} over`;
  else if (myTurn()) text = state.phase === "play" ? "Your turn — play a card" : "Your turn — draw a card";
  else text = `${state.names[opp()]}'s turn`;
  els.turnStatus.textContent = text;
}

function play(to) {
  if (!myPlay() || selected === null) return;
  emit("lc_play", { card: selected, to });
  selected = null;
  freshCard = null;
}

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive() || !state) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".lc-rules summary")) {
    rulesOpen = !rulesOpen;
    return;
  }
  const el = target.closest("[data-act]");
  if (!el || el.disabled) return;
  const color = Number(el.dataset.color);
  switch (el.dataset.act) {
    case "select": {
      if (!myPlay()) return;
      const id = Number(el.dataset.card);
      selected = selected === id ? null : id;
      render();
      return;
    }
    case "expedition":
      play("expedition");
      return;
    case "discard":
      play("discard");
      return;
    case "col":
      if (myPlay() && selected !== null && cardColor(selected) === color) {
        if (canExtend(state.expeditions[state.you][color], selected)) play("expedition");
      }
      return;
    case "pile":
      if (myPlay()) {
        if (selected !== null && cardColor(selected) === color) play("discard");
      } else if (myDraw()) {
        emit("lc_draw", { from: color });
      }
      return;
    case "deck":
      if (myDraw()) emit("lc_draw", { from: "deck" });
      return;
    case "ready":
      emit("lc_ready");
      return;
    default:
  }
});

// --- setup ------------------------------------------------------------------

const segmented = (key, options, current) =>
  `<div class="lc-segmented">${options
    .map(
      ({ value, label }) =>
        `<button type="button" class="lc-seg${value === current ? " selected" : ""}" data-key="${key}" data-value="${value}">${label}</button>`
    )
    .join("")}</div>`;

function buildSetup() {
  if (setupEl) return setupEl;
  setupEl = document.createElement("div");
  setupEl.className = "modal-overlay hidden lc-setup";
  setupEl.setAttribute("role", "dialog");
  setupEl.setAttribute("aria-modal", "true");
  setupEl.setAttribute("aria-label", "Lost Cities setup");
  setupEl.innerHTML = `
    <div class="modal-card lc-setup-card">
      <h3>Lost Cities — Setup</h3>
      <p class="modal-sub">Reiner Knizia's two-player expedition game</p>
      <div class="lc-setup-rows"></div>
      <div class="lc-setup-play"></div>
      <button type="button" class="ghost-btn lc-setup-cancel">Cancel</button>
    </div>`;
  setupEl.addEventListener("click", onSetupClick);
  document.body.appendChild(setupEl);
  return setupEl;
}

function renderSetup() {
  const el = buildSetup();
  el.querySelector(".lc-setup-rows").innerHTML = `
    <div class="lc-setup-row">
      <div class="lc-setup-label"><strong>Rounds</strong><small>Totals carry over; the leader opens</small></div>
      ${segmented("rounds", [{ value: 1, label: "1" }, { value: 3, label: "3" }], chosen.rounds)}
    </div>
    <div class="lc-setup-row">
      <div class="lc-setup-label"><strong>Expeditions</strong><small>Six adds purple: 72 cards, a longer round</small></div>
      ${segmented("colors", [{ value: 5, label: "5" }, { value: 6, label: "6" }], chosen.colors)}
    </div>`;
  const box = el.querySelector(".lc-setup-play");
  if (pendingSetup?.mode === "solo") {
    box.innerHTML = `<p class="modal-sub">Pick an opponent to start</p>
      <div class="lc-opponents">${BOT_OPTIONS.map(
        (o) => `<button type="button" class="lc-play-btn" data-bot="${o.bot}"><strong>${o.title}</strong><small>${o.sub}</small></button>`
      ).join("")}</div>`;
  } else {
    box.innerHTML = `<button type="button" class="lc-play-btn lc-primary" data-bot="queue"><strong>Play — find a match</strong></button>`;
  }
}

function closeSetup() {
  pendingSetup = null;
  setupEl?.classList.add("hidden");
}

function onSetupClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target === setupEl || target.closest(".lc-setup-cancel")) {
    closeSetup();
    return;
  }
  const seg = target.closest(".lc-seg");
  if (seg) {
    chosen[seg.dataset.key] = Number(seg.dataset.value);
    saveChoices();
    renderSetup();
    return;
  }
  const playBtn = target.closest(".lc-play-btn");
  if (!playBtn || !pendingSetup) return;
  const { onReady } = pendingSetup;
  const choice = playBtn.dataset.bot;
  closeSetup();
  onReady({ settings: { ...chosen } }, choice === "queue" ? null : Number(choice));
}

// --- module -----------------------------------------------------------------

function resetUi() {
  els.gameBoard.classList.remove("lc-board");
  els.gameBoard.style.removeProperty("--lc-cols");
}

function newMatch() {
  state = null;
  selected = null;
  freshCard = null;
}

export const lostCities = {
  id: "lost-cities",
  name: "Lost Cities",
  hasBots: true,

  openSetup({ mode, onReady }) {
    pendingSetup = { mode, onReady };
    renderSetup();
    buildSetup().classList.remove("hidden");
  },

  handleState(payload, resetGameUi) {
    if (!payload.lostCities) return false;
    state = payload.lostCities;
    if (selected !== null && (!myPlay() || !state.hand.includes(selected))) selected = null;
    const drew = state.lastDraw;
    if (drew && drew.seat === state.you && drew.card !== null) freshCard = drew.card;
    if (!state.hand.includes(freshCard)) freshCard = null;
    resetGameUi();
    render();
    return true;
  },

  handleTurn() {
    if (!isActive() || !state) return false;
    updateTurnText();
    return true;
  },

  clearState: newMatch,
  resetUi,
  onMatchFound: newMatch,
  onOpponentLeft: newMatch,
  onExit: newMatch
};
