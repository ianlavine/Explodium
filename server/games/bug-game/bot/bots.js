// Bug Game bots. Each one plays a whole turn through the real engine: lay the
// soil card, put tokens down, complete and choose dances. The runner ends the
// turn. Two-player for now: "opp" is the one other seat, and everything is
// scored as MY score minus THEIRS (taking a point = gaining one).
//
// The live game uses BOTS.breeder5 (see ../game.js). The rest are the ladder
// it was found on; the lab that plays them off lives in tools/bug-game.
import * as E from "../engine.js";
import { Board, BUG_INDEX, DANCE_SHAPES, N, NOW, idx, xOf, yOf, T_POOP, T_ROCK, T_BABY, SPROUT } from "./fast.js";

const B = new Board();

// Every real move goes through act(). recordTurn() collects the moves made on
// one state (and not the ones tried on lookahead copies), so a live game can
// replay them a beat apart.
let recording = null;

export function act(name, state, ...args) {
  const ok = E[name](state, ...args);
  if (ok && recording && recording.state === state) recording.moves.push([name, args]);
  return ok;
}

// Plays bot's turn on `state` (a copy the caller can throw away) and returns
// its moves as [engineFunctionName, argsAfterState] — ending the turn excluded.
export function recordTurn(bot, state, seat) {
  recording = { state, moves: [] };
  try {
    bot.turn(state, seat);
    return recording.moves;
  } finally {
    recording = null;
  }
}
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// --- shared pieces --------------------------------------------------------------

export function sides(state, seat) {
  const me = BUG_INDEX[state.seats[seat].bug];
  const opp = BUG_INDEX[state.seats[1 - seat].bug];
  return { me, opp };
}

// Is this the last turn I get? (Nothing left to draw at the end of it.)
export const lastTurn = (state) => state.pile.length === 0;

function layMove(state, seat, m) {
  if (!act("layCard", state, seat, { x: m.x, y: m.y, rot: m.v.rot, mirror: m.v.mirror })) throw new Error("engine refused card");
}

function layTok(state, seat, i, type) {
  if (!act("layToken", state, seat, { x: xOf(i), y: yOf(i), type })) throw new Error(`engine refused ${type}`);
}

// Complete every dance that's made, choosing each replacement with `choose`.
export function danceLoop(state, seat, choose) {
  let guard = 0;
  while (act("completeDance", state, seat)) {
    if (state.choosing && !act("chooseDance", state, seat, choose(state, seat))) throw new Error("bad dance choice");
    if (++guard > 30) break;
  }
}

// Market slot whose dance is closest to done for me (5s over 3s on a tie).
export function chooseByProgress(state, seat) {
  B.load(state);
  const { me } = sides(state, seat);
  let best = 0;
  let bestKey = -Infinity;
  state.market.forEach((d, slot) => {
    const need = E.DANCES[d].cells.length;
    // Taken now, so nothing already on the table counts as new for it.
    const left = need - B.danceProgress(me, d, B.cells[me], NOW);
    const key = -left * 10 + E.DANCES[d].pts + Math.random() * 0.1;
    if (key > bestKey) {
      bestKey = key;
      best = slot;
    }
  });
  return best;
}

// Score change of a card placement for (me - opp), from the board as loaded.
// Returns { gain, ate, bred } — the tokens it would earn, not yet valued.
function cardDelta(m, me, opp, base, Bd = B) {
  const { undo, touched, ate, bred } = Bd.applyCard(m.v, m.x, m.y, me);
  let d = 0;
  if (touched & (1 << me)) d += Bd.scoreList(me, Bd.listAfterCard(me, m.v, m.x, m.y)) - base.me;
  if (touched & (1 << opp)) d -= Bd.scoreList(opp, Bd.listAfterCard(opp, m.v, m.x, m.y)) - base.opp;
  Bd.revert(undo);
  return { d, ate, bred };
}

// Score change of a token on cell i, plus what a baby would earn.
function tokenDelta(i, t, me, opp, base) {
  const t0 = B.tok[i];
  const s0 = B.sym[i];
  const touched = B.placeToken(i, t);
  let d = 0;
  if (touched & (1 << me)) d += B.scoreList(me, B.listAfterToken(me, i)) - base.me;
  if (touched & (1 << opp)) d -= B.scoreList(opp, B.listAfterToken(opp, i)) - base.opp;
  B.removeToken(i);
  const isBaby = t >= T_BABY;
  return {
    d,
    ate: isBaby && t0 === 0 && s0 === SPROUT ? 1 : 0,
    bred: isBaby && ((t0 === 0 && s0 === me + 1) || t0 === T_BABY + me) ? 1 : 0
  };
}

// Tokens earned, valued — capped by what's left in the pools.
const earned = (state, seat, ate, bred, w) =>
  Math.min(ate, state.poopLeft) * (w.livePoop ?? w.poopTok) +
  Math.min(bred * breedMul(state, seat), state.babiesLeft[state.seats[seat].bug]) * (w.liveBaby ?? w.babyTok);

// Babies per breed: two for a Cockroach with its power.
const breedMul = (state, seat) => (E.hasPower(state, state.seats[seat].bug, "R") ? 2 : 1);

// What one more baby / poop token in hand is worth right now: the best spot
// for it on the board as it stands (never less than the fixed values).
function liveTokenValues(state, seat, w) {
  const { me, opp } = sides(state, seat);
  B.load(state);
  const base = { me: B.score(me), opp: B.score(opp) };
  let baby = w.babyTok;
  let poop = w.poopTok;
  for (const i of B.tokenCells(seat)) {
    const b = tokenDelta(i, T_BABY + me, me, opp, base).d;
    if (b > baby) baby = b;
    const p = tokenDelta(i, T_POOP, me, opp, base).d;
    if (p > poop) poop = p;
  }
  return { baby: Math.min(baby, w.liveCap), poop: Math.min(poop, w.liveCap) };
}

// --- B0: random -------------------------------------------------------------------

// Any legal card placement; each token in hand goes down at a random legal
// cell half the time (poop either side up); any dance made is completed and a
// random one taken.
export const random = {
  name: "random",
  turn(state, seat) {
    B.load(state);
    layMove(state, seat, pick(B.cardMoves(state.seats[seat].hand, BUG_INDEX[state.seats[seat].bug])));
    const s = state.seats[seat];
    const bug = BUG_INDEX[s.bug];
    for (let n = s.babies; n > 0; n -= 1) {
      if (Math.random() < 0.5) continue;
      B.load(state);
      layTok(state, seat, pick(B.tokenCells(seat)), "baby");
    }
    for (let n = s.poop; n > 0; n -= 1) {
      if (Math.random() < 0.5) continue;
      B.load(state);
      layTok(state, seat, pick(B.tokenCells(seat)), Math.random() < 0.5 ? "poop" : "rock");
    }
    void bug;
    danceLoop(state, seat, () => Math.floor(Math.random() * state.market.length));
  }
};

// --- B1: greedy on the score right now ------------------------------------------

// The card goes wherever it raises (my score - theirs) the most right now,
// counting a poop token earned as 1.5 and a baby as 2. Then babies go down at
// their best cell straight away, and a poop token goes down if it's worth 2+
// (on my last turn, anything worth more than nothing). Dances: complete when
// made, take the one closest to done.
export function makeGreedy(name, w) {
  return {
    name,
    w,
    turn(state, seat) {
      const { me, opp } = sides(state, seat);
      B.load(state);
      const base = { me: B.score(me), opp: B.score(opp) };
      let best = null;
      let bestV = -Infinity;
      for (const m of B.cardMoves(state.seats[seat].hand, BUG_INDEX[state.seats[seat].bug])) {
        const { d, ate, bred } = cardDelta(m, me, opp, base);
        const v = d + earned(state, seat, ate, bred, w) + Math.random() * 1e-3;
        if (v > bestV) {
          bestV = v;
          best = m;
        }
      }
      layMove(state, seat, best);
      placeTokensGreedy(state, seat, w);
      danceLoop(state, seat, chooseByProgress);
    }
  };
}

// Babies and poop at their best cells while that beats keeping them.
export function placeTokensGreedy(state, seat, w) {
  const { me, opp } = sides(state, seat);
  const s = state.seats[seat];
  const final = lastTurn(state);
  for (let guard = 0; guard < 40; guard += 1) {
    let best = null;
    let bestV = -Infinity;
    B.load(state);
    const base = { me: B.score(me), opp: B.score(opp) };
    const cells = B.tokenCells(seat);
    const consider = (type, t, hold) => {
      for (const i of cells) {
        const { d, ate, bred } = tokenDelta(i, t, me, opp, base);
        const v = d + earned(state, seat, ate, bred, w) - hold + Math.random() * 1e-3;
        if (v > bestV) {
          bestV = v;
          best = { i, type };
        }
      }
    };
    if (s.babies > 0) consider("baby", T_BABY + me, final ? 0 : w.babyHold);
    if (s.poop > 0) consider("poop", T_POOP, final ? 0 : w.poopHold);
    if (!best || bestV <= 0) return;
    layTok(state, seat, best.i, best.type);
  }
}

export const greedy = makeGreedy("greedy", { poopTok: 1.5, babyTok: 2, babyHold: 0, poopHold: 2 });

// --- B2: dances count ---------------------------------------------------------------

// What a dance in hand is worth as it stands: a share of its points by how
// close the best placement of it is (the table is indexed by cells missing).
// A finished one is worth its points plus a little for the pick that follows.
function danceTerm(state, seat, b, list, w) {
  const d = state.seats[seat].dance;
  if (d === null) return 0;
  return danceValue(state, d, b, list, w, 0, [d], state.seats[seat].danceAt ?? -1);
}

// With w.chainDepth, a finished dance is also worth the best market dance it
// lets you take next (bugs can be reused, so that one may be finished too),
// up to chainDepth deep. Without it, a flat w.chain.
function danceValue(state, d, b, list, w, depth, used, since) {
  const need = E.DANCES[d].cells.length;
  const missing = need - B.danceProgress(b, d, list, since);
  const v = E.DANCES[d].pts * (w.danceShare[missing] ?? 0);
  if (missing !== 0) return v;
  if (!w.chainDepth) return v + w.chain;
  if (depth >= w.chainDepth) return v;
  let next = 0;
  for (const m of state.market) {
    if (used.includes(m)) continue;
    const mv = danceValue(state, m, b, list, w, depth + 1, [...used, m], NOW);
    if (mv > next) next = mv;
  }
  return v + next;
}

// Cells where a change could move either dance: every cell of each placement
// that is within two of done.
function hotCells(state, seat, opp, oppSeat, me) {
  const hot = new Set();
  for (const [b, s] of [[me, seat], [opp, oppSeat]]) {
    const d = state.seats[s].dance;
    if (d === null) continue;
    const need = E.DANCES[d].cells.length;
    for (const shape of DANCE_SHAPES[d]) {
      for (const c of B.cells[b]) {
        for (const o of shape.offs) {
          const anchor = c - o;
          let hit = 0;
          for (const q of shape.offs) if (B.vis(anchor + q) === b) hit += 1;
          if (hit >= need - 2) for (const q of shape.offs) hot.add(anchor + q);
        }
      }
    }
  }
  return hot;
}

export function makeDancer(name, w) {
  return {
    name,
    w,
    turn(state, seat) {
      const { me, opp } = sides(state, seat);
      const oppSeat = 1 - seat;
      B.load(state);
      const base = { me: B.score(me), opp: B.score(opp) };
      const danceBase = danceTerm(state, seat, me, B.cells[me], w) - danceTerm(state, oppSeat, opp, B.cells[opp], w);
      const hot = hotCells(state, seat, opp, oppSeat, me);

      // Stage 1: the cheap score change for every placement.
      const moves = B.cardMoves(state.seats[seat].hand, BUG_INDEX[state.seats[seat].bug]).map((m) => {
        const { d, ate, bred } = cardDelta(m, me, opp, base);
        m.v0 = d + earned(state, seat, ate, bred, w) + Math.random() * 1e-3;
        return m;
      });
      moves.sort((a, b) => b.v0 - a.v0);
      // Stage 2: dances, for the best few and anything touching a hot cell.
      let best = moves[0];
      let bestV = -Infinity;
      moves.forEach((m, k) => {
        if (k >= w.topK && !touchesHot(m, hot)) return;
        const { undo } = B.applyCard(m.v, m.x, m.y, me);
        const dt =
          danceTerm(state, seat, me, B.listAfterCard(me, m.v, m.x, m.y), w) -
          danceTerm(state, oppSeat, opp, B.listAfterCard(opp, m.v, m.x, m.y), w);
        B.revert(undo);
        const v = m.v0 + dt - danceBase;
        if (v > bestV) {
          bestV = v;
          best = m;
        }
      });
      layMove(state, seat, best);
      danceLoop(state, seat, chooseByProgress);
      placeTokensDancing(state, seat, w);
      danceLoop(state, seat, chooseByProgress);
    }
  };
}

function touchesHot(m, hot) {
  if (!hot.size) return false;
  for (let dy = 0; dy < m.v.h; dy += 1) {
    for (let dx = 0; dx < m.v.w; dx += 1) if (hot.has(idx(m.x + dx, m.y + dy))) return true;
  }
  return false;
}

// placeTokensGreedy, with dances in the value — so a baby that finishes a
// dance goes there, and a token can spoil the opponent's.
export function placeTokensDancing(state, seat, w) {
  const { me, opp } = sides(state, seat);
  const oppSeat = 1 - seat;
  const s = state.seats[seat];
  const final = lastTurn(state);
  for (let guard = 0; guard < 40; guard += 1) {
    let best = null;
    let bestV = -Infinity;
    B.load(state);
    const base = { me: B.score(me), opp: B.score(opp) };
    const danceBase = danceTerm(state, seat, me, B.cells[me], w) - danceTerm(state, oppSeat, opp, B.cells[opp], w);
    const cells = B.tokenCells(seat);
    const consider = (type, t, hold) => {
      for (const i of cells) {
        const { d, ate, bred } = tokenDelta(i, t, me, opp, base);
        B.placeToken(i, t);
        const dt =
          danceTerm(state, seat, me, B.listAfterToken(me, i), w) - danceTerm(state, oppSeat, opp, B.listAfterToken(opp, i), w);
        B.removeToken(i);
        const v = d + dt - danceBase + earned(state, seat, ate, bred, w) - hold + Math.random() * 1e-3;
        if (v > bestV) {
          bestV = v;
          best = { i, type };
        }
      }
    };
    if (s.babies > 0) consider("baby", T_BABY + me, final ? 0 : w.babyHold);
    if (s.poop > 0) consider("poop", T_POOP, final ? 0 : w.poopHold);
    if (!best || bestV <= 0) return;
    layTok(state, seat, best.i, best.type);
    danceLoop(state, seat, chooseByProgress);
  }
}

export const dancer = makeDancer("dancer", {
  poopTok: 1.5,
  babyTok: 2,
  babyHold: 0,
  poopHold: 2,
  danceShare: [1, 0.45, 0.15],
  chain: 1.5,
  topK: 40
});

// --- B3: one move of lookahead --------------------------------------------------

const B2 = new Board();

// The opponent's best greedy reply (their gain in their-score-minus-mine)
// with the card they hold (averaged, if ever given several). `after` is the state with my
// card laid.
function replyCost(after, mySeat, cards, w) {
  const oppSeat = 1 - mySeat;
  const { me, opp } = sides(after, mySeat);
  B2.load(after);
  const base = { me: B2.score(opp), opp: B2.score(me) }; // from their side
  const poopLeft = after.poopLeft;
  const babiesLeft = after.babiesLeft[after.seats[oppSeat].bug];
  const m = { v: null, x: 0, y: 0 };
  let sum = 0;
  for (const card of cards) {
    let best = -Infinity;
    B2.eachCardMove(card, (v, x, y) => {
      m.v = v;
      m.x = x;
      m.y = y;
      const r = cardDelta(m, opp, me, base, B2);
      const val = r.d + Math.min(r.ate, poopLeft) * w.poopTok + Math.min(r.bred * breedMul(after, oppSeat), babiesLeft) * w.babyTok;
      if (val > best) best = val;
    }, opp);
    sum += best;
  }
  return sum / cards.length;
}

// The card the opponent plays next: they hold it face up. (None once they're
// out of cards.)
const oppCards = (state, seat) => {
  const h = state.seats[1 - seat].hand;
  return h === null ? [] : [h];
};

const cloneState = (state) => JSON.parse(JSON.stringify(state));

// --- B6: three moves deep, all on known cards --------------------------------------

const B3 = new Board();

// `who`'s best greedy card with `card` on board `Bd` loaded from `st`, judged
// as (who's score - the other's) plus tokens earned: { val, move }.
function bestCard(Bd, st, who, card, w) {
  const whoSeat = st.seats.findIndex((x) => BUG_INDEX[x.bug] === who);
  const other = BUG_INDEX[st.seats[1 - whoSeat].bug];
  const base = { me: Bd.score(who), opp: Bd.score(other) };
  const poopLeft = st.poopLeft;
  const babiesLeft = st.babiesLeft[st.seats[whoSeat].bug];
  const m = { v: null, x: 0, y: 0 };
  let best = { val: -Infinity, move: null };
  Bd.eachCardMove(card, (v, x, y) => {
    m.v = v;
    m.x = x;
    m.y = y;
    const r = cardDelta(m, who, other, base, Bd);
    const val = r.d + Math.min(r.ate, poopLeft) * w.poopTok + Math.min(r.bred * breedMul(st, whoSeat), babiesLeft) * w.babyTok;
    if (val > best.val) best = { val, move: { v, x, y } };
  }, who);
  return best;
}

// After my card: the opponent's best reply with the card they hold, then my
// best follow-up with the card I'll draw (the pile's top). Returns
// (my follow-up - their reply), from my side.
function deepLine(after, mySeat, next, w) {
  const oppSeat = 1 - mySeat;
  const { me, opp } = sides(after, mySeat);
  const theirs = after.seats[oppSeat].hand;
  let line = 0;
  let st = after;
  if (theirs !== null) {
    B2.load(st);
    const r = bestCard(B2, st, opp, theirs, w);
    line -= r.val;
    if (next !== null && r.move) {
      st = cloneState(st);
      st.noUndo = true;
      st.turn = oppSeat;
      st.laid = false;
      st.choosing = false;
      layMove(st, oppSeat, r.move);
    }
  }
  if (next !== null) {
    B3.load(st);
    line += w.follow * bestCard(B3, st, me, next, w).val;
  }
  return line;
}

export function makeDeep(name, w0) {
  return {
    name,
    w: w0,
    turn(state, seat) {
      let w = w0;
      if (w0.live) {
        const live = liveTokenValues(state, seat, w0);
        w = { ...w0, liveBaby: live.baby, livePoop: live.poop };
      }
      const { me, opp } = sides(state, seat);
      const oppSeat = 1 - seat;
      B.load(state);
      const base = { me: B.score(me), opp: B.score(opp) };
      const danceBase = danceTerm(state, seat, me, B.cells[me], w) - danceTerm(state, oppSeat, opp, B.cells[opp], w);
      const hot = hotCells(state, seat, opp, oppSeat, me);
      const moves = B.cardMoves(state.seats[seat].hand, BUG_INDEX[state.seats[seat].bug]).map((m) => {
        const { d, ate, bred } = cardDelta(m, me, opp, base);
        m.v0 = d + earned(state, seat, ate, bred, w) + Math.random() * 1e-3;
        return m;
      });
      moves.sort((a, b) => b.v0 - a.v0);
      const scored = [];
      moves.forEach((m, k) => {
        if (k >= w.topK && !touchesHot(m, hot)) return;
        const { undo } = B.applyCard(m.v, m.x, m.y, me);
        const dt =
          danceTerm(state, seat, me, B.listAfterCard(me, m.v, m.x, m.y), w) -
          danceTerm(state, oppSeat, opp, B.listAfterCard(opp, m.v, m.x, m.y), w);
        B.revert(undo);
        m.v1 = m.v0 + dt - danceBase;
        scored.push(m);
      });
      scored.sort((a, b) => b.v1 - a.v1);
      // The card I draw at the end of this turn: the pile's top, face up.
      const next = state.pile.length ? state.pile[0] : null;
      let best = scored[0];
      let bestV = -Infinity;
      for (const m of scored.slice(0, w.lookK)) {
        const after = cloneState(state);
        after.noUndo = true;
        layMove(after, seat, m);
        const v = m.v1 + deepLine(after, seat, next, w);
        if (v > bestV) {
          bestV = v;
          best = m;
        }
      }
      layMove(state, seat, best);
      danceLoop(state, seat, chooseByProgress);
      (w.tokens ?? placeTokensDancing)(state, seat, w);
      danceLoop(state, seat, chooseByProgress);
    }
  };
}

export function makeLooker(name, w0) {
  return {
    name,
    w: w0,
    turn(state, seat) {
      let w = w0;
      if (w0.live) {
        const live = liveTokenValues(state, seat, w0);
        w = { ...w0, liveBaby: live.baby, livePoop: live.poop };
      }
      const { me, opp } = sides(state, seat);
      const oppSeat = 1 - seat;
      B.load(state);
      const base = { me: B.score(me), opp: B.score(opp) };
      const danceBase = danceTerm(state, seat, me, B.cells[me], w) - danceTerm(state, oppSeat, opp, B.cells[opp], w);
      const hot = hotCells(state, seat, opp, oppSeat, me);
      const moves = B.cardMoves(state.seats[seat].hand, BUG_INDEX[state.seats[seat].bug]).map((m) => {
        const { d, ate, bred } = cardDelta(m, me, opp, base);
        m.v0 = d + earned(state, seat, ate, bred, w) + Math.random() * 1e-3;
        return m;
      });
      moves.sort((a, b) => b.v0 - a.v0);
      const scored = [];
      moves.forEach((m, k) => {
        if (k >= w.topK && !touchesHot(m, hot)) return;
        const { undo } = B.applyCard(m.v, m.x, m.y, me);
        const dt =
          danceTerm(state, seat, me, B.listAfterCard(me, m.v, m.x, m.y), w) -
          danceTerm(state, oppSeat, opp, B.listAfterCard(opp, m.v, m.x, m.y), w);
        B.revert(undo);
        m.v1 = m.v0 + dt - danceBase;
        scored.push(m);
      });
      scored.sort((a, b) => b.v1 - a.v1);
      // The last card of the game has no reply to fear.
      let best = scored[0];
      const cards = oppCards(state, seat);
      if (cards.length) {
        let bestV = -Infinity;
        for (const m of scored.slice(0, w.lookK)) {
          const after = cloneState(state);
          after.noUndo = true;
          layMove(after, seat, m);
          const v = m.v1 - w.fear * replyCost(after, seat, cards, w);
          if (v > bestV) {
            bestV = v;
            best = m;
          }
        }
      }
      layMove(state, seat, best);
      danceLoop(state, seat, chooseByProgress);
      (w.tokens ?? placeTokensDancing)(state, seat, w);
      danceLoop(state, seat, chooseByProgress);
    }
  };
}

// --- B4: tokens with lookahead too ------------------------------------------------

// Each token decision: score every cell for every token as dancer does, keep
// the best few (and the best few rock-side spots, which only ever pay by
// blocking), then put each through the opponent's reply — against keeping
// the token. Rock side is judged ONLY by what it saves.
export function placeTokensGuarded(state, seat, w) {
  const { me, opp } = sides(state, seat);
  const oppSeat = 1 - seat;
  const s = state.seats[seat];
  const final = lastTurn(state);
  const cards = oppCards(state, seat);
  const replies = cards.length > 0;
  for (let guard = 0; guard < 40; guard += 1) {
    if (!s.babies && !s.poop) return;
    B.load(state);
    const base = { me: B.score(me), opp: B.score(opp) };
    const danceBase = danceTerm(state, seat, me, B.cells[me], w) - danceTerm(state, oppSeat, opp, B.cells[opp], w);
    const cells = B.tokenCells(seat);
    const options = [];
    const consider = (type, t, hold) => {
      const list = [];
      for (const i of cells) {
        const { d, ate, bred } = tokenDelta(i, t, me, opp, base);
        B.placeToken(i, t);
        const dt =
          danceTerm(state, seat, me, B.listAfterToken(me, i), w) - danceTerm(state, oppSeat, opp, B.listAfterToken(opp, i), w);
        B.removeToken(i);
        list.push({ i, type, v: d + dt - danceBase + earned(state, seat, ate, bred, w) - hold + Math.random() * 1e-3 });
      }
      list.sort((a, b) => b.v - a.v);
      options.push(...list.slice(0, w.tokK));
    };
    if (s.babies > 0) consider("baby", T_BABY + me, final ? 0 : w.babyHold);
    if (s.poop > 0) {
      consider("poop", T_POOP, final ? 0 : w.poopHold);
      // Rock side: no score of its own, so the candidates are the cells that
      // touch my bugs (it can only help by standing in a card's way).
      if (replies && !final) {
        const mine = new Set(B.cells[me]);
        const near = cells.filter((i) => [1, -1, N, -N].some((o) => mine.has(i + o)) && B.vis(i) !== me);
        for (const i of near.sort(() => Math.random() - 0.5).slice(0, w.tokK)) {
          const { d } = tokenDelta(i, T_ROCK, me, opp, base);
          options.push({ i, type: "rock", v: d - w.poopHold });
        }
      }
    }
    if (!options.length) return;
    let best = null;
    let bestV = 0; // keeping the token
    if (replies) {
      const keep = replyCost(cloneState(state), seat, cards, w);
      for (const o of options) {
        if (o.v + w.tokSlack < 0) continue; // hopeless even with a big save
        const after = cloneState(state);
        after.noUndo = true;
        layTok(after, seat, o.i, o.type);
        const v = o.v + w.fear * (keep - replyCost(after, seat, cards, w));
        if (v > bestV) {
          bestV = v;
          best = o;
        }
      }
    } else {
      for (const o of options) if (o.v > bestV) [bestV, best] = [o.v, o];
    }
    if (!best) return;
    layTok(state, seat, best.i, best.type);
    danceLoop(state, seat, chooseByProgress);
  }
}

export const looker = makeLooker("looker", { ...dancer.w, lookK: 8, samples: 3, fear: 1 });

export const lookerWide = makeLooker("lookerWide", { ...dancer.w, lookK: 16, samples: 6, fear: 1 });

export const guard = makeLooker("guard", { ...looker.w, tokens: placeTokensGuarded, tokK: 6, tokSlack: 4 });

export const breeder = makeLooker("breeder", { ...guard.w, live: true, liveCap: 8 });

export const deep = makeDeep("deep", { ...breeder.w, lookK: 12, follow: 1 });

export const chainer = makeLooker("chainer", { ...breeder.w, chainDepth: 3 });

// The champion: breeder with a token in hand capped at 5 (53.9% over breeder
// on 2,000 fresh games).
export const breeder5 = makeLooker("breeder5", { ...breeder.w, liveCap: 5 });

export const BOTS = { random, greedy, dancer, looker, lookerWide, guard, breeder, deep, chainer, breeder5 };

// One-change variants of breeder, for tuning.
const tune = (name, change) => (BOTS[name] = makeLooker(name, { ...breeder.w, ...change }));
tune("br_fear07", { fear: 0.7 });
tune("br_fear14", { fear: 1.4 });
tune("br_danceHungry", { danceShare: [1, 0.6, 0.25], chain: 3 });
tune("br_poopFree", { poopHold: 0 });
tune("br_poopHold4", { poopHold: 4 });
tune("br_cap5", { liveCap: 5 });
tune("br_cap4", { liveCap: 4 });
tune("br_cap3", { liveCap: 3 });
void T_ROCK;
