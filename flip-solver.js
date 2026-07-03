// Flip Triples solver / semi-solver.
//
// A fast search engine for the swap-and-lock game: iterative-deepening
// alpha-beta with a Zobrist transposition table over a compact integer board.
// When the remaining game tree fits inside the time budget the result is an
// exact solve (game-theoretically optimal for the rest of the game); otherwise
// it returns the best move found at the deepest completed depth.
//
// Rules modeled (matching server.js):
//   - A move picks a "first" piece (which locks/flips and slides) and an
//     adjacent "second" piece (Chebyshev distance 1) that takes its old cell.
//   - Unique Swap: the two pieces must have different shapes.
//   - Static Neutrals: a neutral can never be the second (sliding) piece.
//   - Hoppers may be the second piece at any distance; hoppers and purples are
//     protected (never the first piece). Blocker swaps are owner-restricted.
//   - Turn passes to the opponent if they have a move, else back to the mover;
//     the phase ends when neither player can move.
//   - Scoring: 3-in-a-row (4 orientations) counted over ALL pieces at the end.
//     Purple matches both shapes. Tie-breaker on center-less boards (4x6):
//     more of your own unflipped ("white") pieces wins. On odd boards (5x5)
//     the center-cell occupant loses the tie.
//
// Player index convention (matches server.js): index 0 = blue-o, index 1 = red-x.
// All search values are from RED's perspective; red maximizes.

export const RED = 0;
export const BLUE = 1;
export const NEUTRAL = 2;
export const PURPLE = 3;
export const HOPPER = 4;
export const BLOCKER0 = 5; // blocker owned by player index 0 (blue)
export const BLOCKER1 = 6; // blocker owned by player index 1 (red)

const SHAPE_CODES = {
  "red-x": RED,
  "blue-o": BLUE,
  neutral: NEUTRAL,
  purple: PURPLE,
  hopper: HOPPER
};

const INF = 1e9;
const TERMINAL_SCALE = 100000; // one triple of margin
const TIE_SCALE = 10; // white-piece / center tie-breaker unit
const TT_MAX = 2_000_000;
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const ABORT = Symbol("search-timeout");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Geometry + Zobrist tables, cached per board dimension.
// ---------------------------------------------------------------------------

const geomCache = new Map();

function getGeom(rows, cols) {
  const key = `${rows}x${cols}`;
  const cached = geomCache.get(key);
  if (cached) return cached;

  const cells = rows * cols;
  const rowOf = new Int8Array(cells);
  const colOf = new Int8Array(cells);
  for (let i = 0; i < cells; i += 1) {
    rowOf[i] = Math.floor(i / cols);
    colOf[i] = i % cols;
  }

  // All 3-in-a-row lines in the four scoring orientations.
  const lineDirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];
  const lines = [];
  const linesThrough = Array.from({ length: cells }, () => []);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      for (const [dr, dc] of lineDirs) {
        const r2 = r + 2 * dr;
        const c2 = c + 2 * dc;
        if (r2 < 0 || r2 >= rows || c2 < 0 || c2 >= cols) continue;
        const line = [r * cols + c, (r + dr) * cols + (c + dc), r2 * cols + c2];
        const id = lines.length;
        lines.push(line);
        line.forEach((cell) => linesThrough[cell].push(id));
      }
    }
  }

  // Ordered adjacent (first, second) pairs, Chebyshev distance 1.
  const adjPairs = [];
  for (let a = 0; a < cells; a += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const r = rowOf[a] + dr;
        const c = colOf[a] + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        adjPairs.push(a, r * cols + c);
      }
    }
  }

  // Zobrist keys: per cell x (7 shapes x 2 flipped states), split in two
  // 32-bit halves, plus side-to-move keys.
  const rand = mulberry32(0x9e3779b9);
  const r32 = () => Math.floor(rand() * 4294967296) >>> 0;
  const zob1 = new Uint32Array(cells * 14);
  const zob2 = new Uint32Array(cells * 14);
  for (let i = 0; i < zob1.length; i += 1) {
    zob1[i] = r32();
    zob2[i] = r32();
  }
  const sideKey1 = [r32(), r32()];
  const sideKey2 = [r32(), r32()];

  const centerIdx =
    rows % 2 === 1 && cols % 2 === 1
      ? Math.floor(rows / 2) * cols + Math.floor(cols / 2)
      : -1;

  const geom = {
    rows,
    cols,
    cells,
    rowOf,
    colOf,
    lines,
    linesThrough,
    adjPairs,
    zob1,
    zob2,
    sideKey1,
    sideKey2,
    centerIdx
  };
  geomCache.set(key, geom);
  return geom;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function cellCode(shape, flipped) {
  return shape * 2 + (flipped ? 1 : 0);
}

function computeHash(state) {
  const { geom, shapes, flipped } = state;
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < geom.cells; i += 1) {
    const idx = i * 14 + cellCode(shapes[i], flipped[i]);
    h1 ^= geom.zob1[idx];
    h2 ^= geom.zob2[idx];
  }
  state.h1 = h1 >>> 0;
  state.h2 = h2 >>> 0;
}

export function createState({
  shapes,
  flipped = null,
  rows,
  cols,
  phase = 1,
  uniqueSwap = true,
  staticNeutrals = false,
  protectedMiddle = false,
  carryDiff = 0
}) {
  const geom = getGeom(rows, cols);
  const state = {
    geom,
    shapes: Uint8Array.from(shapes),
    flipped: flipped ? Uint8Array.from(flipped) : new Uint8Array(geom.cells),
    phase,
    uniqueSwap: !!uniqueSwap,
    staticNeutrals: !!staticNeutrals,
    blockedCenter: protectedMiddle && geom.centerIdx >= 0 ? geom.centerIdx : -1,
    carryDiff,
    hasHopper: false,
    h1: 0,
    h2: 0
  };
  for (let i = 0; i < geom.cells; i += 1) {
    if (state.shapes[i] === HOPPER) state.hasHopper = true;
  }
  computeHash(state);
  return state;
}

// Build a solver state from the live game state (room.flipTriples).
export function stateFromGame(gameState) {
  const board = gameState.board;
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  const cells = rows * cols;
  const shapes = new Uint8Array(cells);
  const flipped = new Uint8Array(cells);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const piece = board[r][c];
      const i = r * cols + c;
      if (!piece) {
        shapes[i] = NEUTRAL;
        continue;
      }
      if (piece.shape === "blocker") {
        shapes[i] = piece.owner === 0 ? BLOCKER0 : BLOCKER1;
      } else {
        shapes[i] = SHAPE_CODES[piece.shape] ?? NEUTRAL;
      }
      flipped[i] = piece.flipped ? 1 : 0;
    }
  }
  const settings = gameState.settings ?? {};
  const phase = gameState.phase ?? 1;
  // Points already banked in phase 1 shift the target in phase 2. (The ring
  // bonus is not modeled.)
  const carryDiff =
    phase === 2
      ? (gameState.phaseScores?.phase1?.red ?? 0) - (gameState.phaseScores?.phase1?.blue ?? 0)
      : 0;
  return createState({
    shapes,
    flipped,
    rows,
    cols,
    phase,
    uniqueSwap: settings.uniqueSwap !== false,
    staticNeutrals: settings.staticNeutrals === true,
    protectedMiddle: settings.protectedMiddle === true,
    carryDiff
  });
}

function isActive(state, i) {
  return state.phase === 1 ? state.flipped[i] === 0 : state.flipped[i] === 1;
}

function sameShapeFamily(a, b) {
  return a === b || (a >= BLOCKER0 && b >= BLOCKER0);
}

function isProtectedShape(shape) {
  return shape === PURPLE || shape === HOPPER;
}

// True when `player` may act on a pair involving these shapes (blockers are
// owner-restricted; everything else is shared).
function actorAllowed(shape, player) {
  if (shape === BLOCKER0) return player === 0;
  if (shape === BLOCKER1) return player === 1;
  return true;
}

// ---------------------------------------------------------------------------
// Move generation. Moves are encoded as first * cells + second.
// ---------------------------------------------------------------------------

export function genMoves(state, player) {
  const { geom, shapes } = state;
  const cells = geom.cells;
  const moves = [];
  const pairs = geom.adjPairs;
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k];
    const b = pairs[k + 1];
    if (!isActive(state, a) || !isActive(state, b)) continue;
    const sa = shapes[a];
    if (isProtectedShape(sa)) continue;
    const sb = shapes[b];
    if (state.uniqueSwap && sameShapeFamily(sa, sb)) continue;
    if (state.staticNeutrals && sb === NEUTRAL) continue;
    if (state.blockedCenter === b) continue;
    if (!actorAllowed(sa, player) || !actorAllowed(sb, player)) continue;
    moves.push(a * cells + b);
  }
  if (state.hasHopper) {
    const { rowOf, colOf } = geom;
    for (let b = 0; b < cells; b += 1) {
      if (shapes[b] !== HOPPER || !isActive(state, b)) continue;
      if (state.blockedCenter === b) continue;
      for (let a = 0; a < cells; a += 1) {
        if (a === b || !isActive(state, a)) continue;
        const sa = shapes[a];
        if (isProtectedShape(sa)) continue;
        if (!actorAllowed(sa, player)) continue;
        const dist = Math.max(Math.abs(rowOf[a] - rowOf[b]), Math.abs(colOf[a] - colOf[b]));
        if (dist === 1) continue; // already covered by the adjacent pairs
        moves.push(a * cells + b);
      }
    }
  }
  return moves;
}

export function decodeMove(state, m) {
  const cells = state.geom.cells;
  const a = Math.floor(m / cells);
  const b = m % cells;
  return {
    from: { row: state.geom.rowOf[a], col: state.geom.colOf[a] },
    to: { row: state.geom.rowOf[b], col: state.geom.colOf[b] }
  };
}

// First piece (at a) locks and slides to b; second piece slides from b to a
// keeping its flipped state. In phase 1 locking means flipped=1, in phase 2
// flipped=0 (mirroring performFlipSwap in server.js).
export function applyMove(state, m) {
  const { geom, shapes, flipped } = state;
  const cells = geom.cells;
  const a = Math.floor(m / cells);
  const b = m % cells;
  const lockFlip = state.phase === 1 ? 1 : 0;
  let h1 = state.h1;
  let h2 = state.h2;
  let idx = a * 14 + cellCode(shapes[a], flipped[a]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];
  idx = b * 14 + cellCode(shapes[b], flipped[b]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];

  const sb = shapes[b];
  const fb = flipped[b];
  shapes[b] = shapes[a];
  flipped[b] = lockFlip;
  shapes[a] = sb;
  flipped[a] = fb;

  idx = a * 14 + cellCode(shapes[a], flipped[a]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];
  idx = b * 14 + cellCode(shapes[b], flipped[b]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];
  state.h1 = h1 >>> 0;
  state.h2 = h2 >>> 0;
}

export function undoMove(state, m) {
  const { geom, shapes, flipped } = state;
  const cells = geom.cells;
  const a = Math.floor(m / cells);
  const b = m % cells;
  // The first piece was active before the move, so its original flipped state
  // is implied by the phase.
  const activeFlip = state.phase === 1 ? 0 : 1;
  let h1 = state.h1;
  let h2 = state.h2;
  let idx = a * 14 + cellCode(shapes[a], flipped[a]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];
  idx = b * 14 + cellCode(shapes[b], flipped[b]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];

  const firstShape = shapes[b];
  const secondShape = shapes[a];
  const secondFlip = flipped[a];
  shapes[a] = firstShape;
  flipped[a] = activeFlip;
  shapes[b] = secondShape;
  flipped[b] = secondFlip;

  idx = a * 14 + cellCode(shapes[a], flipped[a]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];
  idx = b * 14 + cellCode(shapes[b], flipped[b]);
  h1 ^= geom.zob1[idx];
  h2 ^= geom.zob2[idx];
  state.h1 = h1 >>> 0;
  state.h2 = h2 >>> 0;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function shapeMatches(shape, target) {
  return shape === target || shape === PURPLE;
}

function countTriples(state, target) {
  const { lines } = state.geom;
  const shapes = state.shapes;
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const [x, y, z] = lines[i];
    if (shapeMatches(shapes[x], target) && shapeMatches(shapes[y], target) && shapeMatches(shapes[z], target)) {
      count += 1;
    }
  }
  return count;
}

// Triples made entirely of pieces that can no longer move this phase.
function countLockedTriples(state, target) {
  const { lines } = state.geom;
  const shapes = state.shapes;
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const [x, y, z] = lines[i];
    if (isActive(state, x) || isActive(state, y) || isActive(state, z)) continue;
    if (shapeMatches(shapes[x], target) && shapeMatches(shapes[y], target) && shapeMatches(shapes[z], target)) {
      count += 1;
    }
  }
  return count;
}

// Locked triples running through one cell (used for cheap move ordering).
function lockedTriplesThrough(state, cell, target) {
  const lineIds = state.geom.linesThrough[cell];
  const { lines } = state.geom;
  const shapes = state.shapes;
  let count = 0;
  for (let i = 0; i < lineIds.length; i += 1) {
    const [x, y, z] = lines[lineIds[i]];
    if (isActive(state, x) || isActive(state, y) || isActive(state, z)) continue;
    if (shapeMatches(shapes[x], target) && shapeMatches(shapes[y], target) && shapeMatches(shapes[z], target)) {
      count += 1;
    }
  }
  return count;
}

// Unflipped ("white") own-shape pieces; the 4x6 tie-breaker. Purple excluded,
// matching countFlipRemainingWhitePieces.
function whiteDiff(state) {
  const shapes = state.shapes;
  const flipped = state.flipped;
  let diff = 0;
  for (let i = 0; i < shapes.length; i += 1) {
    if (flipped[i]) continue;
    if (shapes[i] === RED) diff += 1;
    else if (shapes[i] === BLUE) diff -= 1;
  }
  return diff;
}

// Exact value of a finished phase, from red's perspective. The triple margin
// dominates; the tie-breaker only matters at equal triples (its magnitude is
// far below TERMINAL_SCALE so ordering stays lexicographic).
function terminalEval(state) {
  const diff = countTriples(state, RED) - countTriples(state, BLUE) + state.carryDiff;
  let tb;
  if (state.geom.centerIdx >= 0) {
    // 5x5 rule: whoever holds the center loses the tie. Blocker ownership
    // mirrors computeFlipWinner in server.js: owner 0 counts as red control.
    const s = state.shapes[state.geom.centerIdx];
    if (s === RED || s === BLOCKER0) tb = -1;
    else if (s === BLUE || s === BLOCKER1) tb = 1;
    else tb = 0;
  } else {
    tb = whiteDiff(state);
  }
  return diff * TERMINAL_SCALE + tb * TIE_SCALE;
}

// Heuristic for depth-cutoff leaves: locked triples are permanent this phase,
// soft triples and white pieces are potential.
function staticEval(state) {
  const lockedDiffV = countLockedTriples(state, RED) - countLockedTriples(state, BLUE) + state.carryDiff;
  const softDiff = countTriples(state, RED) - countTriples(state, BLUE);
  return lockedDiffV * 2000 + softDiff * 250 + whiteDiff(state) * TIE_SCALE;
}

export function isPhaseOver(state) {
  return genMoves(state, 0).length === 0 && genMoves(state, 1).length === 0;
}

// Final result of a finished basic game (or finished phase), matching
// computeFlipWinner.
export function computeWinner(state) {
  const red = countTriples(state, RED) + (state.carryDiff > 0 ? state.carryDiff : 0);
  const blue = countTriples(state, BLUE) + (state.carryDiff < 0 ? -state.carryDiff : 0);
  const value = terminalEval(state);
  return {
    red,
    blue,
    winner: value > 0 ? "red" : value < 0 ? "blue" : "tie"
  };
}

// ---------------------------------------------------------------------------
// Search: iterative-deepening alpha-beta with a transposition table.
// ---------------------------------------------------------------------------

let nodes = 0;
let cutoffCount = 0;
let deadline = Infinity;
let tt = null;
let history = null;

function orderedMoves(state, moves, side, depth, ttMove) {
  const cells = state.geom.cells;
  const ownShape = side === 1 ? RED : BLUE;
  const oppShape = side === 1 ? BLUE : RED;
  const scored = new Array(moves.length);
  for (let i = 0; i < moves.length; i += 1) {
    const m = moves[i];
    let score = history[m];
    if (m === ttMove) {
      score += 1 << 24;
    } else if (depth >= 2) {
      // Locking a piece at `to`: does it complete a permanent triple for me
      // (great) or for the opponent (terrible)?
      applyMove(state, m);
      const b = m % cells;
      score += 4096 * lockedTriplesThrough(state, b, ownShape);
      score -= 3072 * lockedTriplesThrough(state, b, oppShape);
      undoMove(state, m);
    }
    scored[i] = { m, score };
  }
  scored.sort((x, y) => y.score - x.score);
  return scored;
}

function alphabeta(state, side, depth, alpha, beta) {
  nodes += 1;
  if ((nodes & 2047) === 0 && Date.now() > deadline) throw ABORT;

  const myMoves = genMoves(state, side);
  if (myMoves.length === 0) {
    if (genMoves(state, 1 - side).length === 0) return terminalEval(state);
    // Stuck player passes; no depth is consumed.
    return alphabeta(state, 1 - side, depth, alpha, beta);
  }
  if (depth <= 0) {
    cutoffCount += 1;
    return staticEval(state);
  }

  const key1 = (state.h1 ^ state.geom.sideKey1[side]) >>> 0;
  const key2 = (state.h2 ^ state.geom.sideKey2[side]) >>> 0;
  const entry = tt.get(key1);
  let ttMove = -1;
  if (entry && entry.h2 === key2) {
    ttMove = entry.move;
    // Solved entries are exact game values: usable at any depth. Unsolved
    // entries carry heuristic leaves, so using one taints the solve proof.
    if (entry.solved || entry.depth >= depth) {
      const usable =
        entry.flag === TT_EXACT ||
        (entry.flag === TT_LOWER && entry.value >= beta) ||
        (entry.flag === TT_UPPER && entry.value <= alpha);
      if (usable) {
        if (!entry.solved) cutoffCount += 1;
        return entry.value;
      }
      if (entry.solved) {
        if (entry.flag === TT_LOWER && entry.value > alpha) alpha = entry.value;
        else if (entry.flag === TT_UPPER && entry.value < beta) beta = entry.value;
        if (alpha >= beta) return entry.value;
      }
    }
  }

  const cutoffsAtEntry = cutoffCount;
  const scored = orderedMoves(state, myMoves, side, depth, ttMove);
  const isMax = side === 1;
  let best = isMax ? -INF : INF;
  let bestMove = -1;
  let a = alpha;
  let b = beta;
  for (let i = 0; i < scored.length; i += 1) {
    const m = scored[i].m;
    applyMove(state, m);
    let v;
    try {
      v = alphabeta(state, 1 - side, depth - 1, a, b);
    } finally {
      undoMove(state, m);
    }
    if (isMax) {
      if (v > best) {
        best = v;
        bestMove = m;
      }
      if (best > a) a = best;
    } else {
      if (v < best) {
        best = v;
        bestMove = m;
      }
      if (best < b) b = best;
    }
    if (a >= b) {
      history[m] += depth * depth;
      break;
    }
  }

  const solved = cutoffCount === cutoffsAtEntry;
  let flag = TT_EXACT;
  if (best <= alpha) flag = TT_UPPER;
  else if (best >= beta) flag = TT_LOWER;
  if (tt.size < TT_MAX || tt.has(key1)) {
    tt.set(key1, { h2: key2, depth, value: best, flag, move: bestMove, solved });
  }
  return best;
}

// Search the best move for `player` (0 = blue, 1 = red). Returns null when the
// player has no legal move. `solved` is true when the returned value is the
// exact game-theoretic value of the position (the search reached every leaf).
export function search(state, player, { timeMs = 1000, maxDepth = 64 } = {}) {
  const rootMoves = genMoves(state, player);
  if (rootMoves.length === 0) return null;

  nodes = 0;
  deadline = Date.now() + timeMs;
  tt = new Map();
  history = new Int32Array(state.geom.cells * state.geom.cells);

  const isMax = player === 1;
  const sign = isMax ? 1 : -1;
  let order = rootMoves.map((m) => ({ m, score: 0 }));
  let bestMove = rootMoves[0];
  let bestValue = sign * -INF;
  let completedDepth = 0;
  let solved = false;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    cutoffCount = 0;
    let iterBest = isMax ? -INF : INF;
    let iterMove = -1;
    let a = -INF;
    let b = INF;
    let aborted = false;
    const values = new Map();
    for (let i = 0; i < order.length; i += 1) {
      const m = order[i].m;
      applyMove(state, m);
      let v;
      try {
        v = alphabeta(state, 1 - player, depth - 1, a, b);
      } catch (err) {
        undoMove(state, m);
        if (err === ABORT) {
          aborted = true;
          break;
        }
        throw err;
      }
      undoMove(state, m);
      values.set(m, v);
      if (isMax) {
        if (v > iterBest) {
          iterBest = v;
          iterMove = m;
        }
        if (iterBest > a) a = iterBest;
      } else {
        if (v < iterBest) {
          iterBest = v;
          iterMove = m;
        }
        if (iterBest < b) b = iterBest;
      }
    }
    if (aborted) break;

    bestMove = iterMove;
    bestValue = iterBest;
    completedDepth = depth;
    // Re-order root moves by this iteration's results (best first for the mover).
    order.sort((x, y) => {
      const vx = values.has(x.m) ? sign * values.get(x.m) : -INF;
      const vy = values.has(y.m) ? sign * values.get(y.m) : -INF;
      return vy - vx;
    });
    if (cutoffCount === 0) {
      solved = true;
      break;
    }
    if (Date.now() > deadline) break;
  }

  const result = {
    move: bestMove,
    ...decodeMove(state, bestMove),
    value: bestValue,
    depth: completedDepth,
    solved,
    nodes
  };
  tt = null;
  history = null;
  return result;
}

// Convenience wrapper for server.js: pick a move for the live game state.
export function chooseSolverMove(gameState, playerIndex, opts = {}) {
  const state = stateFromGame(gameState);
  const result = search(state, playerIndex, opts);
  if (!result) return null;
  return { from: result.from, to: result.to, info: result };
}

// ---------------------------------------------------------------------------
// Deal generation (for analysis tools)
// ---------------------------------------------------------------------------

export function makeRandomDeal(
  { rows = 6, cols = 4, playerPieces = 9, purple = 0, hopper = 0, blocker = 0, uniqueSwap = true, staticNeutrals = false, protectedMiddle = false } = {},
  rand = Math.random
) {
  const cells = rows * cols;
  const bag = [];
  for (let i = 0; i < playerPieces; i += 1) bag.push(RED, BLUE);
  for (let i = 0; i < purple; i += 1) bag.push(PURPLE);
  for (let i = 0; i < hopper; i += 1) bag.push(HOPPER);
  for (let i = 0; i < blocker; i += 1) bag.push(i < blocker / 2 ? BLOCKER0 : BLOCKER1);
  while (bag.length < cells) bag.push(NEUTRAL);
  if (bag.length > cells) throw new Error("deal does not fit on the board");
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return createState({ shapes: bag, rows, cols, uniqueSwap, staticNeutrals, protectedMiddle });
}

export { mulberry32 };
