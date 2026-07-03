// Flip Triples solver / semi-solver.
//
// A fast search engine for the swap-and-lock game: iterative-deepening
// negamax with alpha-beta + principal-variation search, a fixed-size
// transposition table, killer/history move ordering, and a bitboard fast path
// for the standard piece set. When the remaining game tree fits inside the
// time budget the result is an exact solve (game-theoretically optimal for
// the rest of the game); otherwise it returns the best move found at the
// deepest completed depth.
//
// SOUNDNESS: nothing here forward-prunes. Alpha-beta/PVS only skip work that
// is *proven* irrelevant to the final value (a refutation has already been
// found); PVS probes later moves with a null window and fully re-searches any
// move whose probe suggests it could beat the current best. Move ordering
// (TT move, triple-completions, killers, history) changes only the order
// moves are tried, never whether they are tried. Search results are therefore
// identical in value to plain minimax at the same depth.
//
// Bitboards: boards up to 4x6/5x5 fit in 32-bit masks using a padded layout
// (one ghost column prevents shift wraparound). A cell's 6 states
// (red/blue/neutral x white/flipped) live across three parallel masks:
// mRed, mBlue (neutral = neither), and mFlip. Move generation and triple
// counting become a handful of shifts/ANDs over all cells at once. Exotic
// pieces (purple/hopper/blocker) fall back to the generic scan path.
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

function popcnt(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
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

  // Ordered adjacent (first, second) pairs, Chebyshev distance 1 (generic path).
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

  // Padded bitboard layout: bit = row * (cols + 1) + col. The ghost column at
  // col == cols is never set in any mask, so horizontal shifts cannot wrap
  // onto the next row. Fits in 31 bits for boards up to 4x6 / 5x5.
  const padCols = cols + 1;
  const fitsBitboard = rows * padCols <= 31;
  const padBit = new Int8Array(cells);
  const cellOfBit = new Int8Array(32).fill(-1);
  let boardMaskP = 0;
  if (fitsBitboard) {
    for (let i = 0; i < cells; i += 1) {
      const bit = rowOf[i] * padCols + colOf[i];
      padBit[i] = bit;
      cellOfBit[bit] = i;
      boardMaskP |= 1 << bit;
    }
  }
  // Padded deltas for the 8 swap directions.
  const dirsP = [1, -1, padCols, -padCols, padCols + 1, -(padCols + 1), padCols - 1, -(padCols - 1)];
  // Padded line masks, and per-cell "other two cells of each line through me".
  const lineMasksP = fitsBitboard
    ? lines.map(([x, y, z]) => (1 << padBit[x]) | (1 << padBit[y]) | (1 << padBit[z]))
    : [];
  const linesThroughOthersP = fitsBitboard
    ? Array.from({ length: cells }, (_, cell) =>
        linesThrough[cell].map((id) => lineMasksP[id] & ~(1 << padBit[cell]))
      )
    : [];

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
    fitsBitboard,
    padBit,
    cellOfBit,
    boardMaskP,
    dirsP,
    lineMasksP,
    linesThroughOthersP,
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

function computeMasks(state) {
  const { geom, shapes, flipped } = state;
  let mRed = 0;
  let mBlue = 0;
  let mFlip = 0;
  let exotic = false;
  for (let i = 0; i < geom.cells; i += 1) {
    const s = shapes[i];
    if (s >= PURPLE) exotic = true;
    if (!geom.fitsBitboard) continue;
    const bit = 1 << geom.padBit[i];
    if (s === RED) mRed |= bit;
    else if (s === BLUE) mBlue |= bit;
    if (flipped[i]) mFlip |= bit;
  }
  state.mRed = mRed;
  state.mBlue = mBlue;
  state.mFlip = mFlip;
  // The bitboard fast path covers red/blue/neutral pieces only; blockers,
  // hoppers and purples take the generic scan path.
  state.simple = geom.fitsBitboard && !exotic;
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
    simple: false,
    mRed: 0,
    mBlue: 0,
    mFlip: 0,
    h1: 0,
    h2: 0
  };
  for (let i = 0; i < geom.cells; i += 1) {
    if (state.shapes[i] === HOPPER) state.hasHopper = true;
  }
  computeMasks(state);
  computeHash(state);
  return state;
}

// Fresh copy of a state (e.g. to replay the same deal with colors swapped).
export function cloneState(state) {
  return createState({
    shapes: state.shapes,
    flipped: state.flipped,
    rows: state.geom.rows,
    cols: state.geom.cols,
    phase: state.phase,
    uniqueSwap: state.uniqueSwap,
    staticNeutrals: state.staticNeutrals,
    protectedMiddle: state.blockedCenter >= 0,
    carryDiff: state.carryDiff
  });
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
//
// Fast path: for each of the 8 directions d, a single mask expression yields
// every legal "first" cell at once (active here AND active at +d AND not the
// same shape at +d ...), then set bits are decoded into the move buffer.
// `dsh(m, d)` maps information at cell x+d onto cell x.
// ---------------------------------------------------------------------------

function dsh(m, d) {
  return d > 0 ? m >>> d : m << -d;
}

// Mask of active (this-phase movable) cells, padded layout.
function activeMaskP(state) {
  return (state.phase === 1 ? ~state.mFlip : state.mFlip) & state.geom.boardMaskP;
}

function genSimpleInto(state, buf, off) {
  const g = state.geom;
  const active = activeMaskP(state);
  const red = state.mRed;
  const blue = state.mBlue;
  const neu = g.boardMaskP & ~(red | blue);
  const centerBit = state.blockedCenter >= 0 ? 1 << g.padBit[state.blockedCenter] : 0;
  const cells = g.cells;
  const cellOfBit = g.cellOfBit;
  let n = 0;
  for (let k = 0; k < 8; k += 1) {
    const d = g.dirsP[k];
    let firsts = active & dsh(active, d);
    if (state.uniqueSwap) {
      firsts &= ~(red & dsh(red, d));
      firsts &= ~(blue & dsh(blue, d));
      firsts &= ~(neu & dsh(neu, d));
    }
    if (state.staticNeutrals) firsts &= ~dsh(neu, d);
    if (centerBit) firsts &= ~dsh(centerBit, d);
    while (firsts) {
      const lsb = firsts & -firsts;
      firsts ^= lsb;
      const bitA = 31 - Math.clz32(lsb);
      buf[off + n] = cellOfBit[bitA] * cells + cellOfBit[bitA + d];
      n += 1;
    }
  }
  return n;
}

function hasSimpleMove(state) {
  const g = state.geom;
  const active = activeMaskP(state);
  const red = state.mRed;
  const blue = state.mBlue;
  const neu = g.boardMaskP & ~(red | blue);
  const centerBit = state.blockedCenter >= 0 ? 1 << g.padBit[state.blockedCenter] : 0;
  for (let k = 0; k < 8; k += 1) {
    const d = g.dirsP[k];
    let firsts = active & dsh(active, d);
    if (state.uniqueSwap) {
      firsts &= ~(red & dsh(red, d));
      firsts &= ~(blue & dsh(blue, d));
      firsts &= ~(neu & dsh(neu, d));
    }
    if (state.staticNeutrals) firsts &= ~dsh(neu, d);
    if (centerBit) firsts &= ~dsh(centerBit, d);
    if (firsts) return true;
  }
  return false;
}

// Generic scan path (any piece set, hoppers included).
function genGenericInto(state, player, buf, off) {
  const { geom, shapes } = state;
  const cells = geom.cells;
  const pairs = geom.adjPairs;
  let n = 0;
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
    buf[off + n] = a * cells + b;
    n += 1;
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
        buf[off + n] = a * cells + b;
        n += 1;
      }
    }
  }
  return n;
}

function genMovesInto(state, player, buf, off) {
  // Without blockers both players share the same move set, so the simple path
  // ignores `player`.
  if (state.simple) return genSimpleInto(state, buf, off);
  return genGenericInto(state, player, buf, off);
}

function hasAnyMove(state, player) {
  if (state.simple) return hasSimpleMove(state);
  return genGenericInto(state, player, scratchBuf, 0) > 0;
}

const scratchBuf = new Int16Array(640);

// Public wrapper (allocates a plain array; the search uses the buffers).
export function genMoves(state, player) {
  const n = genMovesInto(state, player, scratchBuf, 0);
  return Array.from(scratchBuf.subarray(0, n));
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
  updateMasksAt(state, a, b);
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
  updateMasksAt(state, a, b);
}

// Refresh the bitboard masks for the two cells a move touches.
function updateMasksAt(state, a, b) {
  const g = state.geom;
  if (!g.fitsBitboard) return;
  const bitA = 1 << g.padBit[a];
  const bitB = 1 << g.padBit[b];
  const both = bitA | bitB;
  let mRed = state.mRed & ~both;
  let mBlue = state.mBlue & ~both;
  let mFlip = state.mFlip & ~both;
  const sa = state.shapes[a];
  const sb = state.shapes[b];
  if (sa === RED) mRed |= bitA;
  else if (sa === BLUE) mBlue |= bitA;
  if (sb === RED) mRed |= bitB;
  else if (sb === BLUE) mBlue |= bitB;
  if (state.flipped[a]) mFlip |= bitA;
  if (state.flipped[b]) mFlip |= bitB;
  state.mRed = mRed;
  state.mBlue = mBlue;
  state.mFlip = mFlip;
}

// ---------------------------------------------------------------------------
// Evaluation (values are always from RED's perspective; the search negates
// per side). Fast path counts triples via the 44 padded line masks.
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

// Unflipped ("white") own-shape pieces; the 4x6 tie-breaker. Purple excluded,
// matching countFlipRemainingWhitePieces.
function whiteDiffGeneric(state) {
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

function whiteDiffFast(state) {
  return popcnt(state.mRed & ~state.mFlip) - popcnt(state.mBlue & ~state.mFlip);
}

// One pass over the line masks: all-piece and locked triple counts for both
// shapes. Locked = cannot move again this phase.
function tripleCountsFast(state) {
  const g = state.geom;
  const lockedM = (state.phase === 1 ? state.mFlip : ~state.mFlip) & g.boardMaskP;
  const mRed = state.mRed;
  const mBlue = state.mBlue;
  const masks = g.lineMasksP;
  let allRed = 0;
  let allBlue = 0;
  let lockedRed = 0;
  let lockedBlue = 0;
  for (let i = 0; i < masks.length; i += 1) {
    const L = masks[i];
    if ((L & mRed) === L) {
      allRed += 1;
      if ((L & lockedM) === L) lockedRed += 1;
    } else if ((L & mBlue) === L) {
      allBlue += 1;
      if ((L & lockedM) === L) lockedBlue += 1;
    }
  }
  return { allRed, allBlue, lockedRed, lockedBlue };
}

function centerTiebreak(state) {
  // 5x5 rule: whoever holds the center loses the tie. Blocker ownership
  // mirrors computeFlipWinner in server.js: owner 0 counts as red control.
  const s = state.shapes[state.geom.centerIdx];
  if (s === RED || s === BLOCKER0) return -1;
  if (s === BLUE || s === BLOCKER1) return 1;
  return 0;
}

// Exact value of a finished phase. The triple margin dominates; the
// tie-breaker only matters at equal triples (its magnitude is far below
// TERMINAL_SCALE so ordering stays lexicographic).
function terminalEval(state) {
  let diff;
  let tb;
  if (state.simple) {
    const t = tripleCountsFast(state);
    diff = t.allRed - t.allBlue + state.carryDiff;
    tb = state.geom.centerIdx >= 0 ? centerTiebreak(state) : whiteDiffFast(state);
  } else {
    diff = countTriples(state, RED) - countTriples(state, BLUE) + state.carryDiff;
    tb = state.geom.centerIdx >= 0 ? centerTiebreak(state) : whiteDiffGeneric(state);
  }
  return diff * TERMINAL_SCALE + tb * TIE_SCALE;
}

// Heuristic for depth-cutoff leaves: locked triples are permanent this phase,
// soft triples and white pieces are potential.
function staticEval(state) {
  if (state.simple) {
    const t = tripleCountsFast(state);
    return (
      (t.lockedRed - t.lockedBlue + state.carryDiff) * 2000 +
      (t.allRed - t.allBlue) * 250 +
      whiteDiffFast(state) * TIE_SCALE
    );
  }
  const lockedDiffV = countLockedTriples(state, RED) - countLockedTriples(state, BLUE) + state.carryDiff;
  const softDiff = countTriples(state, RED) - countTriples(state, BLUE);
  return lockedDiffV * 2000 + softDiff * 250 + whiteDiffGeneric(state) * TIE_SCALE;
}

export function isPhaseOver(state) {
  return !hasAnyMove(state, 0) && !hasAnyMove(state, 1);
}

// Final result of a finished basic game (or finished phase), matching
// computeFlipWinner. `redPoints`/`bluePoints` fold the white tie-breaker into
// a single margin-friendly number: each triple = 1, each remaining white
// piece = 0.1 (whites max out at 0.9, so they can never outweigh a triple —
// the same lexicographic order the real rules use).
export function computeWinner(state) {
  const red = countTriples(state, RED) + (state.carryDiff > 0 ? state.carryDiff : 0);
  const blue = countTriples(state, BLUE) + (state.carryDiff < 0 ? -state.carryDiff : 0);
  let redWhite = 0;
  let blueWhite = 0;
  for (let i = 0; i < state.shapes.length; i += 1) {
    if (state.flipped[i]) continue;
    if (state.shapes[i] === RED) redWhite += 1;
    else if (state.shapes[i] === BLUE) blueWhite += 1;
  }
  const value = terminalEval(state);
  return {
    red,
    blue,
    redWhite,
    blueWhite,
    redPoints: red + 0.1 * redWhite,
    bluePoints: blue + 0.1 * blueWhite,
    winner: value > 0 ? "red" : value < 0 ? "blue" : "tie"
  };
}

// ---------------------------------------------------------------------------
// Transposition table: fixed-size typed arrays (no per-entry heap objects).
// meta packs: (move+1) in bits 0..11, depth in 12..17, flag+1 in 18..19,
// solved in 20. meta === 0 means empty.
// ---------------------------------------------------------------------------

const TT_BITS = 21;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttKey = new Uint32Array(TT_SIZE);
const ttVal = new Int32Array(TT_SIZE);
const ttMeta = new Int32Array(TT_SIZE);
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

// ---------------------------------------------------------------------------
// Search: iterative-deepening negamax with alpha-beta + PVS.
// Values inside the search are from the side-to-move's perspective.
// ---------------------------------------------------------------------------

const MAX_PLY = 64;
const MAX_MOVES = 640;
const moveBuf = new Int16Array(MAX_PLY * MAX_MOVES);
const scoreBuf = new Float64Array(MAX_PLY * MAX_MOVES);
const killer1 = new Int32Array(MAX_PLY);
const killer2 = new Int32Array(MAX_PLY);

let nodes = 0;
let cutoffCount = 0;
let deadline = Infinity;
let history = null;

function redSign(side) {
  return side === 1 ? 1 : -1;
}

// Cheap move-ordering score (no board mutation): does locking shapes[a] at b
// complete a permanent triple for the mover (great) or the opponent (bad)?
// Uses the precomputed "other two cells" masks of every line through b.
function scoreMovesSimple(state, side, buf, scores, off, count, ttMove, ply) {
  const g = state.geom;
  const cells = g.cells;
  const lockedM = (state.phase === 1 ? state.mFlip : ~state.mFlip) & g.boardMaskP;
  const ownShape = side === 1 ? RED : BLUE;
  const k1 = killer1[ply];
  const k2 = killer2[ply];
  for (let i = 0; i < count; i += 1) {
    const m = buf[off + i];
    if (m === ttMove) {
      scores[off + i] = 1 << 24;
      continue;
    }
    const a = (m / cells) | 0;
    const b = m % cells;
    const s = state.shapes[a];
    let sc = history[m];
    if (s === RED || s === BLUE) {
      const lockedS = (s === RED ? state.mRed : state.mBlue) & lockedM;
      const others = g.linesThroughOthersP[b];
      let completes = 0;
      for (let j = 0; j < others.length; j += 1) {
        if ((others[j] & lockedS) === others[j]) completes += 1;
      }
      sc += s === ownShape ? 4096 * completes : -3072 * completes;
    }
    if (m === k1) sc += 2400;
    else if (m === k2) sc += 1800;
    scores[off + i] = sc;
  }
}

function scoreMovesGeneric(buf, scores, off, count, ttMove, ply) {
  const k1 = killer1[ply];
  const k2 = killer2[ply];
  for (let i = 0; i < count; i += 1) {
    const m = buf[off + i];
    let sc = history[m];
    if (m === ttMove) sc = 1 << 24;
    else if (m === k1) sc += 2400;
    else if (m === k2) sc += 1800;
    scores[off + i] = sc;
  }
}

// Lazy selection: pull the best remaining move to slot i (cutoffs usually
// happen within the first few moves, so full sorting is wasted work).
function pickNext(buf, scores, off, i, count) {
  let bestIdx = i;
  let bestScore = scores[off + i];
  for (let j = i + 1; j < count; j += 1) {
    if (scores[off + j] > bestScore) {
      bestScore = scores[off + j];
      bestIdx = j;
    }
  }
  if (bestIdx !== i) {
    const tm = buf[off + i];
    buf[off + i] = buf[off + bestIdx];
    buf[off + bestIdx] = tm;
    const ts = scores[off + i];
    scores[off + i] = scores[off + bestIdx];
    scores[off + bestIdx] = ts;
  }
  return buf[off + i];
}

function negamax(state, side, depth, alpha, beta, ply) {
  nodes += 1;
  if ((nodes & 2047) === 0 && Date.now() > deadline) throw ABORT;

  const off = ply * MAX_MOVES;
  const count = genMovesInto(state, side, moveBuf, off);
  if (count === 0) {
    // In the simple game both players share the move set, so no moves for one
    // means no moves for either. With blockers the other side may still move
    // (the stuck player passes; no depth is consumed).
    if (state.simple || !hasAnyMove(state, 1 - side)) {
      return redSign(side) * terminalEval(state);
    }
    return -negamax(state, 1 - side, depth, -beta, -alpha, ply);
  }
  if (depth <= 0) {
    cutoffCount += 1;
    return redSign(side) * staticEval(state);
  }

  const key1 = (state.h1 ^ state.geom.sideKey1[side]) >>> 0;
  const key2 = (state.h2 ^ state.geom.sideKey2[side]) >>> 0;
  const slot = key1 & TT_MASK;
  let ttMove = -1;
  const meta = ttMeta[slot];
  if (meta !== 0 && ttKey[slot] === key2) {
    ttMove = (meta & 0xfff) - 1;
    const eDepth = (meta >> 12) & 0x3f;
    const eFlag = ((meta >> 18) & 0x3) - 1;
    const eSolved = (meta >>> 20) & 1;
    // Solved entries hold exact game values: usable at any depth. Unsolved
    // entries carry heuristic leaves, so relying on one taints a solve proof.
    if (eSolved || eDepth >= depth) {
      const v = ttVal[slot];
      const usable =
        eFlag === TT_EXACT ||
        (eFlag === TT_LOWER && v >= beta) ||
        (eFlag === TT_UPPER && v <= alpha);
      if (usable) {
        if (!eSolved) cutoffCount += 1;
        return v;
      }
      if (eSolved) {
        if (eFlag === TT_LOWER && v > alpha) alpha = v;
        else if (eFlag === TT_UPPER && v < beta) beta = v;
        if (alpha >= beta) return v;
      }
    }
  }

  const cutoffsAtEntry = cutoffCount;
  if (state.simple) scoreMovesSimple(state, side, moveBuf, scoreBuf, off, count, ttMove, ply);
  else scoreMovesGeneric(moveBuf, scoreBuf, off, count, ttMove, ply);

  const origAlpha = alpha;
  let best = -INF;
  let bestMove = -1;
  for (let i = 0; i < count; i += 1) {
    const m = pickNext(moveBuf, scoreBuf, off, i, count);
    applyMove(state, m);
    let v;
    try {
      if (i === 0) {
        v = -negamax(state, 1 - side, depth - 1, -beta, -alpha, ply + 1);
      } else {
        // PVS: null-window probe proves "not better than alpha" cheaply; any
        // move whose probe escapes the window is re-searched at full width,
        // so no move is ever dismissed on the probe alone.
        v = -negamax(state, 1 - side, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (v > alpha && v < beta) {
          v = -negamax(state, 1 - side, depth - 1, -beta, -v, ply + 1);
        }
      }
    } finally {
      undoMove(state, m);
    }
    if (v > best) {
      best = v;
      bestMove = m;
    }
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      history[m] += depth * depth;
      if (killer1[ply] !== m) {
        killer2[ply] = killer1[ply];
        killer1[ply] = m;
      }
      break;
    }
  }

  const solved = cutoffCount === cutoffsAtEntry ? 1 : 0;
  let flag = TT_EXACT;
  if (best <= origAlpha) flag = TT_UPPER;
  else if (best >= beta) flag = TT_LOWER;
  ttKey[slot] = key2;
  ttVal[slot] = best;
  ttMeta[slot] = (bestMove + 1) | (depth << 12) | ((flag + 1) << 18) | (solved << 20);
  return best;
}

// Search the best move for `player` (0 = blue, 1 = red). Returns null when the
// player has no legal move. `solved` is true when the returned value is the
// exact game-theoretic value of the position (the search reached every leaf).
// `value` is reported from RED's perspective (API compatibility).
export function search(state, player, { timeMs = 1000, maxDepth = 60 } = {}) {
  const rootCount = genMovesInto(state, player, moveBuf, 0);
  if (rootCount === 0) return null;
  const rootMoves = Array.from(moveBuf.subarray(0, rootCount));

  nodes = 0;
  deadline = Date.now() + timeMs;
  ttMeta.fill(0);
  history = new Int32Array(state.geom.cells * state.geom.cells);
  killer1.fill(-1);
  killer2.fill(-1);

  let order = rootMoves.slice();
  let bestMove = rootMoves[0];
  let bestValue = -INF; // mover's perspective
  let completedDepth = 0;
  let solved = false;
  let lastValues = null;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    cutoffCount = 0;
    let iterBest = -INF;
    let iterMove = -1;
    let alpha = -INF;
    const beta = INF;
    let aborted = false;
    const values = new Map();
    for (let i = 0; i < order.length; i += 1) {
      const m = order[i];
      applyMove(state, m);
      let v;
      try {
        if (i === 0) {
          v = -negamax(state, 1 - player, depth - 1, -beta, -alpha, 1);
        } else {
          v = -negamax(state, 1 - player, depth - 1, -alpha - 1, -alpha, 1);
          if (v > alpha && v < beta) {
            v = -negamax(state, 1 - player, depth - 1, -beta, -v, 1);
          }
        }
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
      if (v > iterBest) {
        iterBest = v;
        iterMove = m;
      }
      if (iterBest > alpha) alpha = iterBest;
    }
    if (aborted) break;

    bestMove = iterMove;
    bestValue = iterBest;
    completedDepth = depth;
    lastValues = values;
    // Re-order root moves by this iteration's results (best first for the mover).
    order.sort((x, y) => (values.get(y) ?? -INF) - (values.get(x) ?? -INF));
    if (cutoffCount === 0) {
      solved = true;
      break;
    }
    if (Date.now() > deadline) break;
  }

  // Root moves ranked best-first for the mover. Non-best values may be
  // alpha-beta bounds rather than exact, but the ranking is what matters
  // (it drives the blunder-injection difficulty levels).
  const sign = redSign(player);
  const ranked = order.map((m) => ({
    move: m,
    ...decodeMove(state, m),
    value: lastValues?.has(m) ? sign * lastValues.get(m) : null
  }));
  const result = {
    move: bestMove,
    ...decodeMove(state, bestMove),
    value: sign * bestValue,
    depth: completedDepth,
    solved,
    nodes,
    ranked
  };
  history = null;
  return result;
}

// Convenience wrapper for server.js: pick a move for the live game state.
// `pickWeights` (optional) turns the solver into a weaker bot: it is a list of
// probabilities over the ranked moves — e.g. [0.6, 0.25, 0.15] plays the best
// move 60% of the time, the 2nd best 25%, the 3rd 15%. Omitted or [1] means
// always play the best move.
export function chooseSolverMove(gameState, playerIndex, opts = {}) {
  const { pickWeights = null, rand = Math.random, ...searchOpts } = opts;
  const state = stateFromGame(gameState);
  const result = search(state, playerIndex, searchOpts);
  if (!result) return null;
  let choice = result;
  if (pickWeights && result.ranked.length > 1) {
    const n = Math.min(pickWeights.length, result.ranked.length);
    let total = 0;
    for (let i = 0; i < n; i += 1) total += pickWeights[i];
    let roll = rand() * total;
    let idx = 0;
    for (let i = 0; i < n; i += 1) {
      roll -= pickWeights[i];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    choice = result.ranked[idx];
  }
  return { from: choice.from, to: choice.to, info: result };
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
