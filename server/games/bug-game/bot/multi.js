// Bug Game bots for any number of players (2-4): breeder5's machinery from
// ./bots.js, generalised. Where a two-player bot scores a move as (my points -
// my opponent's), these score it against a WEIGHTED view of the table:
//
//   value = my change - sum over opponents of weight(opponent) x their change
//
// and the objective (`w.goal`) sets the weights: "mean" (each opponent 1/(n-1)
// — in two players this is exactly breeder5), "sum" (each 1), "self" (0: just
// build), or "lead" (shared by how far each opponent is ahead).
//
// Lookahead reads every opponent's face-up card: for each (or only the next
// to play, `w.scope`), their best greedy move against the board my move leaves,
// and what it costs me. Opponents are assumed to play for themselves ("mean").
//
// `w.taste` ({ p, g }) re-weights MY OWN poop and group points — a bot that
// cares about groups more than the score does (see the colony bots).
import * as E from "../engine.js";
import { act } from "./bots.js";
import { Board, BUG_INDEX, DANCE_SHAPES, N, NOW, idx, xOf, yOf, T_POOP, T_ROCK, T_BABY, SPROUT } from "./fast.js";

const B = new Board(); // the table as it stands
const BR = new Board(); // a table after one of my candidate moves

const bugOf = (state, seat) => BUG_INDEX[state.seats[seat].bug];
const lastTurn = (state) => state.pile.length === 0;
const cloneState = (state) => JSON.parse(JSON.stringify(state));

function layMove(state, seat, m) {
  if (!act("layCard", state, seat, { x: m.x, y: m.y, rot: m.v.rot, mirror: m.v.mirror })) throw new Error("engine refused card");
}
function layTok(state, seat, i, type) {
  if (!act("layToken", state, seat, { x: xOf(i), y: yOf(i), type })) throw new Error(`engine refused ${type}`);
}

// --- whose points count, and how much -----------------------------------------------

// ctx: me (bug), seat, wts[bug] (+1 me, -x opponents, 0 nobody), taste.
function makeCtx(state, seat, goal, taste, Bd) {
  const n = state.seats.length;
  const me = bugOf(state, seat);
  const wts = new Float64Array(4);
  wts[me] = 1;
  const others = state.seats.map((_, i) => i).filter((i) => i !== seat);
  if (goal === "lead") {
    // Opponents weighted by standing: the leader most. Totals include dances.
    const total = (s) => Bd.score(bugOf(state, s)) + state.seats[s].done.reduce((a, d) => a + E.DANCES[d].pts, 0);
    const mine = total(seat);
    const ex = others.map((j) => Math.exp((total(j) - mine) / 6));
    const z = ex.reduce((a, b) => a + b, 0);
    others.forEach((j, k) => (wts[bugOf(state, j)] = -ex[k] / z));
  } else {
    const k = goal === "sum" ? 1 : goal === "self" ? 0 : 1 / (n - 1);
    for (const j of others) wts[bugOf(state, j)] = -k;
  }
  return { me, seat, wts, taste };
}

// An opponent's own view, for guessing their reply: they play for themselves.
const oppCtx = (state, j) => {
  const n = state.seats.length;
  const wts = new Float64Array(4);
  state.seats.forEach((s, i) => (wts[BUG_INDEX[s.bug]] = i === j ? 1 : -1 / (n - 1)));
  return { me: bugOf(state, j), seat: j, wts, taste: null };
};

const scoreOf = (Bd, ctx, b, list) =>
  ctx.taste && b === ctx.me ? Bd.scoreListW(b, list, ctx.taste.p, ctx.taste.g) : Bd.scoreList(b, list);

function baseOf(Bd, ctx) {
  const base = new Float64Array(4);
  for (let b = 0; b < 4; b++) if (ctx.wts[b] !== 0) base[b] = scoreOf(Bd, ctx, b, Bd.cells[b]);
  return base;
}

// Weighted score change of a card (laid by bug `layer`), plus what it earns
// that bug: { d, ate, bred }.
function cardDelta(Bd, ctx, m, base, layer) {
  const { undo, touched, ate, bred } = Bd.applyCard(m.v, m.x, m.y, layer);
  let d = 0;
  for (let b = 0; b < 4; b++) {
    if (ctx.wts[b] !== 0 && touched & (1 << b)) d += ctx.wts[b] * (scoreOf(Bd, ctx, b, Bd.listAfterCard(b, m.v, m.x, m.y)) - base[b]);
  }
  Bd.revert(undo);
  return { d, ate, bred };
}

function tokenDelta(Bd, ctx, i, t, base) {
  // What shows there before: a sprout feeds a baby, my own bug (a card bug,
  // or a baby a stacking Scorpion lays on) breeds one.
  const t0 = Bd.tok[i];
  const s0 = Bd.sym[i];
  const touched = Bd.placeToken(i, t);
  let d = 0;
  for (let b = 0; b < 4; b++) {
    if (ctx.wts[b] !== 0 && touched & (1 << b)) d += ctx.wts[b] * (scoreOf(Bd, ctx, b, Bd.listAfterToken(b, i)) - base[b]);
  }
  Bd.removeToken(i);
  const isBaby = t >= T_BABY;
  return {
    d,
    ate: isBaby && t0 === 0 && s0 === SPROUT ? 1 : 0,
    bred: isBaby && ((t0 === 0 && s0 === ctx.me + 1) || t0 === T_BABY + ctx.me) ? 1 : 0
  };
}

// Tokens earned, capped by what's left (a Cockroach with its power earns two
// babies a breed).
const earned = (state, seat, ate, bred, poopV, babyV) => {
  const bug = state.seats[seat].bug;
  const per = E.hasPower(state, bug, "R") ? 2 : 1;
  return Math.min(ate, state.poopLeft) * poopV + Math.min(bred * per, state.babiesLeft[bug]) * babyV;
};

// A token in hand is worth its best spot right now (breeder's idea), capped.
function liveTokenValues(state, ctx, w) {
  B.load(state);
  const base = baseOf(B, ctx);
  let baby = w.babyTok;
  let poop = w.poopTok;
  for (const i of B.tokenCells(ctx.seat)) {
    const b = tokenDelta(B, ctx, i, T_BABY + ctx.me, base).d;
    if (b > baby) baby = b;
    const p = tokenDelta(B, ctx, i, T_POOP, base).d;
    if (p > poop) poop = p;
  }
  return { baby: Math.min(baby, w.liveCap), poop: Math.min(poop, w.liveCap) };
}

// --- dances ---------------------------------------------------------------------------

function danceValue(Bd, state, d, b, list, w, depth, used, since) {
  const need = E.DANCES[d].cells.length;
  const missing = need - Bd.danceProgress(b, d, list, since);
  const v = E.DANCES[d].pts * (w.danceShare[missing] ?? 0);
  if (missing !== 0) return v;
  return v + w.chain;
}

// Sum over seats of weight x (what that seat's dance in hand is worth), with
// `listOf(bug)` giving each bug's cells.
function danceTerms(Bd, state, ctx, w, listOf) {
  let t = 0;
  state.seats.forEach((s, i) => {
    if (s.dance === null) return;
    const b = BUG_INDEX[s.bug];
    if (ctx.wts[b] === 0) return;
    const share = i === ctx.seat ? w.danceShare : w.oppDanceShare ?? w.danceShare;
    t += ctx.wts[b] * danceValue(Bd, state, s.dance, b, listOf(b), { ...w, danceShare: share }, 0, [s.dance], s.danceAt ?? -1);
  });
  return t;
}

function hotCells(Bd, state, ctx) {
  const hot = new Set();
  state.seats.forEach((s) => {
    const b = BUG_INDEX[s.bug];
    if (s.dance === null || ctx.wts[b] === 0) return;
    const need = E.DANCES[s.dance].cells.length;
    for (const shape of DANCE_SHAPES[s.dance]) {
      for (const c of Bd.cells[b]) {
        for (const o of shape.offs) {
          const anchor = c - o;
          let hit = 0;
          for (const q of shape.offs) if (Bd.vis(anchor + q) === b) hit += 1;
          if (hit >= need - 2) for (const q of shape.offs) hot.add(anchor + q);
        }
      }
    }
  });
  return hot;
}

function touchesHot(m, hot) {
  if (!hot.size) return false;
  for (let dy = 0; dy < m.v.h; dy += 1) for (let dx = 0; dx < m.v.w; dx += 1) if (hot.has(idx(m.x + dx, m.y + dy))) return true;
  return false;
}

function chooseDance(state, seat) {
  B.load(state);
  const me = bugOf(state, seat);
  let best = 0;
  let bestKey = -Infinity;
  state.market.forEach((d, slot) => {
    const left = E.DANCES[d].cells.length - B.danceProgress(me, d, B.cells[me], NOW);
    const key = -left * 10 + E.DANCES[d].pts + Math.random() * 0.1;
    if (key > bestKey) [bestKey, best] = [key, slot];
  });
  return best;
}

function danceLoop(state, seat) {
  for (let guard = 0; guard < 30 && act("completeDance", state, seat); guard += 1) {
    if (state.choosing && !act("chooseDance", state, seat, chooseDance(state, seat))) throw new Error("bad dance choice");
  }
}

// --- what the others can do to me -----------------------------------------------------

// Seats whose card I look at: all the others who still hold one, or just the
// next to play.
function threatSeats(state, seat, scope) {
  const n = state.seats.length;
  const order = Array.from({ length: n - 1 }, (_, k) => (seat + 1 + k) % n);
  const live = order.filter((j) => state.seats[j].hand !== null);
  return scope === "next" ? live.slice(0, 1) : live;
}

// For each threat seat, on the table `after` leaves: their best greedy card
// (judged their way), and what it does to MY value. Each is judged on the same
// table, independently. Returns my total loss.
function replyLoss(after, ctx, w, seats) {
  if (!seats.length) return 0;
  BR.load(after);
  const myBase = baseOf(BR, ctx);
  const m = { v: null, x: 0, y: 0 };
  let loss = 0;
  for (const j of seats) {
    const jc = oppCtx(after, j);
    const jBase = baseOf(BR, jc);
    let best = -Infinity;
    let bestMove = null;
    let bestEarn = 0;
    BR.eachCardMove(after.seats[j].hand, (v, x, y) => {
      m.v = v;
      m.x = x;
      m.y = y;
      const r = cardDelta(BR, jc, m, jBase, jc.me);
      const earn = earned(after, j, r.ate, r.bred, w.poopTok, w.babyTok);
      const val = r.d + earn;
      if (val > best) {
        best = val;
        bestMove = { v, x, y };
        bestEarn = earn;
      }
    }, jc.me);
    if (!bestMove) continue;
    const mine = cardDelta(BR, ctx, bestMove, myBase, jc.me).d + ctx.wts[jc.me] * bestEarn;
    loss -= mine;
  }
  return loss;
}

// --- tokens (breeder's guarded placement, for n players) --------------------------------

function placeTokens(state, ctx, w) {
  const seat = ctx.seat;
  const s = state.seats[seat];
  const final = lastTurn(state);
  const seats = threatSeats(state, seat, w.scope);
  for (let guard = 0; guard < 40; guard += 1) {
    if (!s.babies && !s.poop) return;
    B.load(state);
    const base = baseOf(B, ctx);
    const danceBase = danceTerms(B, state, ctx, w, (b) => B.cells[b]);
    const cells = B.tokenCells(seat);
    const options = [];
    const consider = (type, t, hold) => {
      const list = [];
      for (const i of cells) {
        const { d, ate, bred } = tokenDelta(B, ctx, i, t, base);
        B.placeToken(i, t);
        const dt = danceTerms(B, state, ctx, w, (b) => B.listAfterToken(b, i)) - danceBase;
        B.removeToken(i);
        list.push({ i, type, v: d + dt + earned(state, seat, ate, bred, w.livePoop ?? w.poopTok, w.liveBaby ?? w.babyTok) - hold + Math.random() * 1e-3 });
      }
      list.sort((a, b) => b.v - a.v);
      options.push(...list.slice(0, w.tokK));
    };
    if (s.babies > 0) consider("baby", T_BABY + ctx.me, final ? 0 : w.babyHold);
    if (s.poop > 0) {
      consider("poop", T_POOP, final ? 0 : w.poopHold);
      if (seats.length && !final) {
        const mine = new Set(B.cells[ctx.me]);
        const near = cells.filter((i) => [1, -1, N, -N].some((o) => mine.has(i + o)) && B.vis(i) !== ctx.me);
        for (const i of near.sort(() => Math.random() - 0.5).slice(0, w.tokK)) {
          options.push({ i, type: "rock", v: tokenDelta(B, ctx, i, T_ROCK, base).d - w.poopHold });
        }
      }
    }
    if (!options.length) return;
    let best = null;
    let bestV = 0; // keeping the token
    if (seats.length && w.fear) {
      const keep = replyLoss(state, ctx, w, seats);
      for (const o of options) {
        if (o.v + w.tokSlack < 0) continue;
        const after = cloneState(state);
        after.noUndo = true;
        layTok(after, seat, o.i, o.type);
        const v = o.v + w.fear * (keep - replyLoss(after, ctx, w, seats));
        if (v > bestV) [bestV, best] = [v, o];
      }
    } else {
      for (const o of options) if (o.v > bestV) [bestV, best] = [o.v, o];
    }
    if (!best) return;
    layTok(state, seat, best.i, best.type);
    danceLoop(state, seat);
  }
}

// --- the bot ---------------------------------------------------------------------------

export function makeMulti(name, w0) {
  return {
    name,
    w: w0,
    turn(state, seat) {
      B.load(state);
      const ctx = makeCtx(state, seat, w0.goal, w0.taste ?? null, B);
      const live = liveTokenValues(state, ctx, w0);
      const w = { ...w0, liveBaby: live.baby, livePoop: live.poop };
      B.load(state);
      const base = baseOf(B, ctx);
      const danceBase = danceTerms(B, state, ctx, w, (b) => B.cells[b]);
      const hot = hotCells(B, state, ctx);
      const moves = B.cardMoves(state.seats[seat].hand, ctx.me).map((m) => {
        const { d, ate, bred } = cardDelta(B, ctx, m, base, ctx.me);
        m.v0 = d + earned(state, seat, ate, bred, w.livePoop ?? w.poopTok, w.liveBaby ?? w.babyTok) + Math.random() * 1e-3;
        return m;
      });
      moves.sort((a, b) => b.v0 - a.v0);
      const scored = [];
      moves.forEach((m, k) => {
        if (k >= w.topK && !touchesHot(m, hot)) return;
        const { undo } = B.applyCard(m.v, m.x, m.y, ctx.me);
        m.v1 = m.v0 + danceTerms(B, state, ctx, w, (b) => B.listAfterCard(b, m.v, m.x, m.y)) - danceBase;
        B.revert(undo);
        scored.push(m);
      });
      scored.sort((a, b) => b.v1 - a.v1);
      let best = scored[0];
      const seats = threatSeats(state, seat, w.scope);
      if (seats.length && w.fear) {
        let bestV = -Infinity;
        for (const m of scored.slice(0, w.lookK)) {
          const after = cloneState(state);
          after.noUndo = true;
          layMove(after, seat, m);
          const v = m.v1 - w.fear * replyLoss(after, ctx, w, seats);
          if (v > bestV) [bestV, best] = [v, m];
        }
      }
      layMove(state, seat, best);
      danceLoop(state, seat);
      placeTokens(state, ctx, w);
      danceLoop(state, seat);
    }
  };
}

// breeder5's settings.
export const BASE = {
  goal: "mean",
  scope: "all",
  poopTok: 1.5,
  babyTok: 2,
  babyHold: 0,
  poopHold: 2,
  danceShare: [1, 0.45, 0.15],
  chain: 1.5,
  topK: 40,
  lookK: 8,
  fear: 1,
  tokK: 6,
  tokSlack: 4,
  liveCap: 5
};

export const MULTI = {};
export const add = (name, change = {}) => (MULTI[name] = makeMulti(name, { ...BASE, ...change }));

// In two players, "mean" is breeder5 exactly.
add("m_mean");

// --- 4-player experiments ---------------------------------------------------------
// What to optimise against: every opponent at full weight, nobody, or the
// leader.
add("m_sum", { goal: "sum" });
add("m_self", { goal: "self" });
add("m_lead", { goal: "lead" });
// How much to fear the others' replies: only the next player's, or none.
add("m_next", { scope: "next" });
add("m_nofear", { fear: 0 });
// Hungrier for babies / for dances.
add("m_cap8", { liveCap: 8 });
add("m_dance", { danceShare: [1, 0.6, 0.25], chain: 3 });
// With three others the replies are summed, each judged on its own: that may
// count the same threat three times. Fear each reply less.
add("m_fear05", { fear: 0.5 });
add("m_fear033", { fear: 1 / 3 });
// Six turns each instead of twelve: tokens may be worth putting down sooner,
// and lookahead may be worth more breadth.
add("m_poopFree", { poopHold: 0 });
add("m_cap3", { liveCap: 3 });
add("m_wide", { lookK: 16, topK: 60 });
// The dance market is shared by four: a dance a cell or two from done is
// more likely to be taken from under you.
add("m_danceNow", { danceShare: [1, 0.3, 0.05] });
add("m_f05c8", { fear: 0.5, liveCap: 8 });

// --- colony: all-in on groups --------------------------------------------------------
// Plays for (number of groups) x (biggest group) above all: its own group
// points count double, its own poop a quarter, and a dance only counts once
// it's finished (it never steers towards one). Babies — the one thing nothing
// can cover — are valued by what they add to groups, uncapped. Opponents are
// still scored straight.
const COLONY = { taste: { p: 0.25, g: 2 }, danceShare: [1, 0, 0], chain: 0, oppDanceShare: [1, 0.45, 0.15], poopTok: 0.5, liveCap: 12 };
add("colony", COLONY);
add("colony15", { ...COLONY, taste: { p: 0.25, g: 1.5 } });
add("colony3", { ...COLONY, taste: { p: 0, g: 3 } });

// --- the 4-player champion -------------------------------------------------------------
// breeder5 generalised, fearing each opponent's reply half as much (with three
// opponents the replies are summed, each judged alone, which overcounts).
// 1v3 against three m_mean: 27.0% on 600 games, 27.2% (±1.8) on 1,600 fresh
// games, where 25% is a fair share. The 2-player bot stays breeder5 (bots.js).
export const FOUR = add("four", { fear: 0.5 });
