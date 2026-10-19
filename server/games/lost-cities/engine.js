// Lost Cities (Reiner Knizia, 1999): the rules, with no sockets in sight.
//
// Two explorers share five expeditions (six with the purple one). Every colour
// has twelve cards: three wagers and the numbers 2 to 10. A turn is always
// one card OUT of your hand -- onto your own expedition of its colour, or face
// up onto that colour's discard pile -- and then one card IN, from the deck or
// from the top of any discard pile except the one you just fed.
//
// An expedition only climbs: each card must beat the one before it, and the
// wagers go down first, before any number. It is worth the sum of its numbers
// minus 20, times one more than its wagers, plus 20 if it reached eight cards.
// An expedition you never start costs nothing. The round ends the moment the
// deck's last card is drawn, and a match is one or three rounds.
//
// A card is just an integer: colour * 12 + slot, where slots 0-2 are the
// wagers and slot s >= 3 is the number s - 1.
import { shuffle } from "../../lib/util.js";

export const SLOTS = 12;
export const WAGERS = 3;
export const HAND_SIZE = 8;
export const COST = 20;
export const BONUS_CARDS = 8;
export const BONUS = 20;
export const COLOR_NAMES = ["Yellow", "Blue", "White", "Green", "Red", "Purple"];

export const cardColor = (id) => Math.floor(id / SLOTS);
export const cardValue = (id) => {
  const slot = id % SLOTS;
  return slot < WAGERS ? 0 : slot - 1;
};
export const cardName = (id) => {
  const value = cardValue(id);
  return `${COLOR_NAMES[cardColor(id)]} ${value === 0 ? "wager" : value}`;
};

export function normalizeSettings(raw) {
  return {
    rounds: Number(raw?.rounds) === 1 ? 1 : 3,
    colors: Number(raw?.colors) === 6 ? 6 : 5
  };
}

// -1 for an empty column, 0 while it holds only wagers.
export const topValue = (column) => (column.length ? cardValue(column[column.length - 1]) : -1);

export function canExtend(column, id) {
  const top = topValue(column);
  const value = cardValue(id);
  if (top < 0) return true;
  return value === 0 ? top === 0 : value > top;
}

export function expeditionScore(column) {
  if (!column.length) return { sum: 0, wagers: 0, count: 0, score: 0 };
  let sum = 0;
  let wagers = 0;
  column.forEach((id) => {
    const value = cardValue(id);
    if (value === 0) wagers += 1;
    else sum += value;
  });
  const count = column.length;
  const score = (sum - COST) * (1 + wagers) + (count >= BONUS_CARDS ? BONUS : 0);
  return { sum, wagers, count, score };
}

export function seatScore(columns) {
  const rows = columns.map(expeditionScore);
  return { rows, total: rows.reduce((acc, row) => acc + row.score, 0) };
}

export function createMatch(settings, rng = Math.random) {
  const match = {
    settings,
    round: 0,
    totals: [0, 0],
    history: [],
    ready: [false, false]
  };
  dealRound(match, rng() < 0.5 ? 0 : 1);
  return match;
}

export function dealRound(match, starter) {
  const { colors } = match.settings;
  const deck = shuffle(Array.from({ length: colors * SLOTS }, (_, id) => id));
  match.round += 1;
  match.hands = [deck.splice(0, HAND_SIZE), deck.splice(0, HAND_SIZE)];
  match.deck = deck;
  match.expeditions = [0, 1].map(() => Array.from({ length: colors }, () => []));
  match.discards = Array.from({ length: colors }, () => []);
  // Cards each seat took off a discard pile and still holds: the one part of a
  // hand the other explorer has actually seen.
  match.taken = [[], []];
  match.starter = starter;
  match.toMove = starter;
  match.phase = "play";
  match.justDiscarded = null;
  match.lastPlay = null;
  match.lastDraw = null;
  match.roundResult = null;
  match.ready = [false, false];
  match.log = [];
}

// The higher running total opens the next round; a tie hands it to whoever
// didn't open this one.
export function nextStarter(match) {
  const [a, b] = match.totals;
  if (a === b) return 1 - match.starter;
  return a > b ? 0 : 1;
}

export function nextRound(match) {
  dealRound(match, nextStarter(match));
}

const drop = (list, id) => {
  const at = list.indexOf(id);
  if (at !== -1) list.splice(at, 1);
};

// `to` is "expedition" or "discard". Returns an error string, or null.
export function playCard(match, seat, id, to) {
  if (match.phase !== "play" || match.toMove !== seat) return "not your play";
  const hand = match.hands[seat];
  if (!hand.includes(id)) return "not in hand";
  const color = cardColor(id);
  if (to === "expedition") {
    const column = match.expeditions[seat][color];
    if (!canExtend(column, id)) return "too low";
    column.push(id);
    match.justDiscarded = null;
  } else if (to === "discard") {
    match.discards[color].push(id);
    match.justDiscarded = color;
  } else {
    return "bad target";
  }
  drop(hand, id);
  drop(match.taken[seat], id);
  match.lastPlay = { seat, card: id, to };
  match.lastDraw = null;
  match.log.push({ seat, kind: to === "expedition" ? "play" : "discard", card: id });
  match.phase = "draw";
  return null;
}

// `from` is "deck" or a colour index. Returns an error string, or null.
export function drawCard(match, seat, from) {
  if (match.phase !== "draw" || match.toMove !== seat) return "not your draw";
  let id;
  if (from === "deck") {
    if (!match.deck.length) return "deck empty";
    id = match.deck.shift();
  } else {
    const color = Number(from);
    if (!Number.isInteger(color) || color < 0 || color >= match.settings.colors) return "bad pile";
    if (color === match.justDiscarded) return "just discarded";
    const pile = match.discards[color];
    if (!pile.length) return "empty pile";
    id = pile.pop();
    match.taken[seat].push(id);
  }
  match.hands[seat].push(id);
  match.lastDraw = { seat, from: from === "deck" ? "deck" : Number(from), card: id };
  match.log.push({ seat, kind: "draw", from: from === "deck" ? "deck" : Number(from), card: id });
  match.justDiscarded = null;
  if (!match.deck.length) {
    endRound(match);
  } else {
    match.toMove = 1 - seat;
    match.phase = "play";
  }
  return null;
}

function endRound(match) {
  const scores = match.expeditions.map(seatScore);
  match.roundResult = scores;
  match.history.push(scores.map((s) => s.total));
  match.totals = match.totals.map((total, seat) => total + scores[seat].total);
  match.phase = match.round < match.settings.rounds ? "roundOver" : "matchOver";
  match.toMove = null;
  match.ready = [false, false];
}

export function matchWinner(match) {
  if (match.phase !== "matchOver") return null;
  const [a, b] = match.totals;
  if (a === b) return -1;
  return a > b ? 0 : 1;
}
