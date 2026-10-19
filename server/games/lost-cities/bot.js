// Lost Cities bot: one turn of lookahead over every (card out, card in) pair,
// scored by what the round is projected to be worth once the deck runs dry.
//
// The bot sees only what a careful player at the table would: its own hand,
// both rows of expeditions, every card ever discarded, the deck's size, and the
// cards the other side took off a discard pile. Everything else is "unknown",
// and each unknown card is in the deck or in the other hand with the odds
// those two sizes give.
//
// A position is worth (my projected round score) - (theirs) - (what the discard
// tops I leave would hand them next turn). A projection credits an expedition
// with the cards already down, the cards in hand that can still go on it --
// thinned when there are more of them than turns left -- and a slice of every
// unknown card above its top. Wagers are charged for the spread of that slice,
// so a wager waits for cards in hand rather than hopes. An expedition nobody
// has started is worth at least nothing, because nobody has to start it.
import { SLOTS, COST, BONUS, BONUS_CARDS, cardColor, cardValue, topValue, canExtend } from "./engine.js";

export const LOST_CITIES_BOT_ID = "lost-cities-bot";

// 0 = argmax; otherwise a softmax over the options' scores at this temperature.
export const BOT_LEVELS = [
  { name: "Tourist", temperature: 9 },
  { name: "Explorer", temperature: 2.5 },
  { name: "Archaeologist", temperature: 0 }
];

const HAND_CERTAINTY = 0.97; // a card in hand is a promise, a card down is a fact
const WAGER_RISK = 0.5;

const bonusOf = (count) => BONUS * Math.min(1, Math.max(0, count - (BONUS_CARDS - 1)));

// Everything the bot is allowed to know, copied so it can be played with.
function viewFor(match, me) {
  const opp = 1 - me;
  const seen = new Set(match.hands[me]);
  match.expeditions.forEach((cols) => cols.forEach((col) => col.forEach((id) => seen.add(id))));
  match.discards.forEach((pile) => pile.forEach((id) => seen.add(id)));
  match.taken[opp].forEach((id) => seen.add(id));
  const unknown = [];
  for (let id = 0; id < match.settings.colors * SLOTS; id += 1) if (!seen.has(id)) unknown.push(id);
  return {
    hand: [...match.hands[me]],
    mine: match.expeditions[me],
    theirs: match.expeditions[opp],
    theirKnown: [...match.taken[opp]],
    discards: match.discards,
    deck: match.deck.length,
    unknown,
    oppHidden: match.hands[opp].length - match.taken[opp].length
  };
}

// One side's projected round score. `share` is the slice of each unknown card
// above a column's top that this side is expected to land in time; `turns` is
// how many more cards it will get to put down.
function projected(columns, hand, unknown, share, turns) {
  const per = columns.map((col) => {
    const top = topValue(col);
    let playedSum = 0;
    let playedW = 0;
    col.forEach((id) => {
      const v = cardValue(id);
      if (v === 0) playedW += 1;
      else playedSum += v;
    });
    return { col, top, playedSum, playedW, handSum: 0, handCnt: 0, handW: 0, futSum: 0, futCnt: 0, futSq: 0 };
  });
  hand.forEach((id) => {
    const row = per[cardColor(id)];
    const v = cardValue(id);
    if (v === 0) {
      if (row.top <= 0) row.handW += 1;
    } else if (v > row.top) {
      row.handSum += v;
      row.handCnt += 1;
    }
  });
  if (share > 0) {
    unknown.forEach((id) => {
      const row = per[cardColor(id)];
      const v = cardValue(id);
      if (v > 0 && v > row.top) {
        row.futSum += v;
        row.futCnt += 1;
        row.futSq += v * v;
      }
    });
  }

  const sigmaOf = (row) => Math.sqrt(share * (1 - share) * row.futSq);
  const valueOf = (row, h) => {
    const sum = row.playedSum + h * row.handSum + share * row.futSum;
    const useW = sum - COST > 0;
    const wagers = row.playedW + (useW ? h * row.handW : 0);
    const count = row.col.length + h * (row.handCnt + (useW ? row.handW : 0)) + share * row.futCnt;
    const value = (sum - COST) * (1 + wagers) - WAGER_RISK * wagers * sigmaOf(row) + bonusOf(count);
    return row.col.length ? value : Math.max(0, value);
  };

  // Which columns are worth feeding at all decides how thinly the turns left
  // are spread over the cards waiting to go down.
  let planned = 0;
  per.forEach((row) => {
    if (row.col.length || valueOf(row, 1) > 0) {
      const sum = row.playedSum + row.handSum + share * row.futSum;
      planned += row.handCnt + (sum - COST > 0 ? row.handW : 0);
    }
  });
  const h = (planned ? Math.min(1, turns / planned) : 1) * HAND_CERTAINTY;
  return per.reduce((acc, row) => acc + valueOf(row, h), 0);
}

// What a discard top hands the other side if they take it next turn.
function giftOf(col, id, deck) {
  const v = cardValue(id);
  if (!col.length) {
    // Only a seed for an expedition they haven't started, and less of one the
    // nearer the end.
    const late = Math.min(1, deck / 30);
    return (v === 0 ? 1.5 : v * 0.25) * late;
  }
  if (!canExtend(col, id)) return 0;
  let wagers = 0;
  col.forEach((c) => {
    if (cardValue(c) === 0) wagers += 1;
  });
  if (v === 0) return 4;
  const skipped = Math.max(0, v - Math.max(topValue(col), 1) - 1);
  return Math.max(0, (v * 0.9 - skipped * 0.6) * (1 + wagers));
}

function threatOf(pos) {
  let best = 0;
  let rest = 0;
  pos.discards.forEach((pile, color) => {
    if (!pile.length) return;
    const gift = giftOf(pos.theirs[color], pile[pile.length - 1], pos.deck);
    if (gift > best) {
      rest += best;
      best = gift;
    } else {
      rest += gift;
    }
  });
  return best + 0.15 * rest;
}

// The position after this side's draw, with the other side to move.
function evaluate(pos) {
  const { deck, oppHidden } = pos;
  const pool = deck + oppHidden || 1;
  const late = deck / (deck + 6);
  const myShare = 0.5 * (deck / pool) * late;
  const theirTurns = Math.ceil(deck / 2);
  const theirShare = (oppHidden / pool) * Math.min(1, theirTurns / 4) + 0.5 * (deck / pool) * late;
  const mine = projected(pos.mine, pos.hand, pos.unknown, myShare, Math.floor(deck / 2));
  const theirs = projected(pos.theirs, pos.theirKnown, pos.unknown, deck ? theirShare : 0, theirTurns);
  return mine - theirs - (deck ? threatOf(pos) : 0);
}

const withCard = (list, id) => [...list, id];
const without = (list, id) => list.filter((x) => x !== id);
const replaceAt = (list, at, value) => list.map((x, i) => (i === at ? value : x));

// Every draw open after a play, each with its expected score. A deck draw is
// the average over the unknown cards, any of which could be on top.
function drawOptions(pos, justDiscarded) {
  const options = [];
  if (pos.deck > 0) {
    let total = 0;
    pos.unknown.forEach((id) => {
      total += evaluate({ ...pos, hand: withCard(pos.hand, id), unknown: without(pos.unknown, id), deck: pos.deck - 1 });
    });
    options.push({ from: "deck", score: pos.unknown.length ? total / pos.unknown.length : evaluate({ ...pos, deck: pos.deck - 1 }) });
  }
  pos.discards.forEach((pile, color) => {
    if (!pile.length || color === justDiscarded) return;
    const id = pile[pile.length - 1];
    const discards = replaceAt(pos.discards, color, pile.slice(0, -1));
    options.push({ from: color, score: evaluate({ ...pos, hand: withCard(pos.hand, id), discards }) });
  });
  return options;
}

function playOptions(pos) {
  const options = [];
  pos.hand.forEach((id) => {
    const color = cardColor(id);
    const hand = without(pos.hand, id);
    if (canExtend(pos.mine[color], id)) {
      const mine = replaceAt(pos.mine, color, withCard(pos.mine[color], id));
      options.push({ card: id, to: "expedition", after: { ...pos, hand, mine }, justDiscarded: null });
    }
    const discards = replaceAt(pos.discards, color, withCard(pos.discards[color], id));
    options.push({ card: id, to: "discard", after: { ...pos, hand, discards }, justDiscarded: color });
  });
  return options;
}

function pick(options, temperature) {
  if (!temperature) return options.reduce((a, b) => (b.score > a.score ? b : a));
  const top = Math.max(...options.map((o) => o.score));
  const weights = options.map((o) => Math.exp((o.score - top) / temperature));
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < options.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return options[i];
  }
  return options[options.length - 1];
}

const levelOf = (level) => BOT_LEVELS[level] ?? BOT_LEVELS[BOT_LEVELS.length - 1];

// The card to put out: judged with the best draw that would follow it.
export function choosePlay(match, seat, level) {
  const pos = viewFor(match, seat);
  const options = playOptions(pos).map((option) => {
    const draws = drawOptions(option.after, option.justDiscarded);
    return { card: option.card, to: option.to, score: Math.max(...draws.map((d) => d.score)) };
  });
  return pick(options, levelOf(level).temperature);
}

export function chooseDraw(match, seat, level) {
  const pos = viewFor(match, seat);
  return pick(drawOptions(pos, match.justDiscarded), levelOf(level).temperature);
}
