// Flip Triples — metric algorithms, browser-safe and framework-free.
//
// This is a faithful port of the metric functions in
// server/games/flip-triples/solver.js (computePermanentMask,
// countLockedTriples, countTriples, countPermanentTriples,
// countCompletionSpaces) plus "locate" variants that also return WHICH cells
// and lines to highlight. tools/flip-triples/metrics-check.mjs asserts this
// module and the engine agree on random positions, so the playground shows
// exactly what the bot scores.
//
// State shape (plain object): { shapes: Uint8Array, flipped: Uint8Array,
//   phase: 1, carryDiff: 0, geom }. geom comes from buildGeom(rows, cols).

export const RED = 0; // "X"
export const BLUE = 1; // "O"
export const NEUTRAL = 2;
export const PURPLE = 3;
export const HOPPER = 4;
export const YELLOW = 5;
export const RED_RING = 6;
export const BLUE_RING = 7;

// All 3-in-a-row lines (4 orientations) + a per-cell index of lines through it.
export function buildGeom(rows, cols) {
  const cells = rows * cols;
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
  const centerIdx =
    rows % 2 === 1 && cols % 2 === 1 ? Math.floor(rows / 2) * cols + Math.floor(cols / 2) : -1;
  return { rows, cols, cells, lines, linesThrough, centerIdx };
}

export function makeState(shapes, flipped, geom, { phase = 1, carryDiff = 0 } = {}) {
  return { shapes, flipped, geom, phase, carryDiff };
}

// ---- predicates (mirror solver.js) ----------------------------------------
function isActive(state, i) {
  return state.phase === 1 ? state.flipped[i] === 0 : state.flipped[i] === 1;
}
function isColorOrWild(shape, target) {
  return shape === target || shape === PURPLE || shape === YELLOW;
}
function ringCodeFor(target) {
  return target === RED ? RED_RING : BLUE_RING;
}
function lineMatchesTarget(shapes, x, y, z, target) {
  const ring = ringCodeFor(target);
  const sx = shapes[x];
  const sy = shapes[y];
  const sz = shapes[z];
  if (isColorOrWild(sx, target) && isColorOrWild(sy, target) && isColorOrWild(sz, target)) return true;
  const ringOnly =
    (sx === NEUTRAL || sx === ring) && (sy === NEUTRAL || sy === ring) && (sz === NEUTRAL || sz === ring);
  const hasRing = sx === ring || sy === ring || sz === ring;
  return ringOnly && hasRing;
}
function tripleValue(sx, sy, sz) {
  return sx === YELLOW || sy === YELLOW || sz === YELLOW ? -1 : 1;
}

const NEIGHBORS_8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
function neighbors8(geom, i) {
  const { rows, cols } = geom;
  const r = (i / cols) | 0;
  const c = i % cols;
  const out = [];
  for (let k = 0; k < 8; k += 1) {
    const nr = r + NEIGHBORS_8[k][0];
    const nc = c + NEIGHBORS_8[k][1];
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
  }
  return out;
}

// ---- permanence -----------------------------------------------------------
export function computePermanentMask(state) {
  const { cells } = state.geom;
  const shapes = state.shapes;
  const movable = (i) => isActive(state, i);
  const perm = new Uint8Array(cells);
  for (let i = 0; i < cells; i += 1) if (!movable(i)) perm[i] = 1;

  const seen = new Uint8Array(cells);
  for (let start = 0; start < cells; start += 1) {
    if (seen[start] || !movable(start)) continue;
    const myShape = shapes[start];
    const blob = [];
    const stack = [start];
    seen[start] = 1;
    let sealed = true;
    while (stack.length) {
      const c = stack.pop();
      blob.push(c);
      for (const nb of neighbors8(state.geom, c)) {
        if (!movable(nb)) continue;
        if (shapes[nb] === myShape) {
          if (!seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        } else {
          sealed = false;
        }
      }
    }
    if (sealed) for (const c of blob) perm[c] = 1;
  }
  return perm;
}

// ---- triples ("locate" returns { count, lines:[lineId...] }) ---------------
// gate(x,y,z) -> boolean decides which triples qualify (all / locked / permanent).
function locateTriples(state, target, gate) {
  const { lines } = state.geom;
  const shapes = state.shapes;
  const hit = [];
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const [x, y, z] = lines[i];
    if (!gate(x, y, z)) continue;
    if (lineMatchesTarget(shapes, x, y, z, target)) {
      count += tripleValue(shapes[x], shapes[y], shapes[z]);
      hit.push(i);
    }
  }
  return { count, lines: hit };
}

export function locateAllTriples(state, target) {
  return locateTriples(state, target, () => true); // "soft"
}
export function locateLockedTriples(state, target) {
  return locateTriples(state, target, (x, y, z) => !isActive(state, x) && !isActive(state, y) && !isActive(state, z));
}
export function locatePermanentTriples(state, target, perm = computePermanentMask(state)) {
  return locateTriples(state, target, (x, y, z) => perm[x] && perm[y] && perm[z]);
}

// ---- completion spaces ----------------------------------------------------
// A one-move threat to lock a PERMANENT triple: a movable non-target cell C
// whose line's other two cells are BOTH permanent and already count as target,
// with an adjacent movable target piece to slide in and lock. (The two permanent
// cells are either adjacent with C at the end, or straddle C.)
// Returns { count, spaces:[{ cell, lines:[lineId...], supports:[cell...] }] }.
export function locateCompletionSpaces(state, target, perm = computePermanentMask(state)) {
  const { cells, lines, linesThrough } = state.geom;
  const shapes = state.shapes;
  const countsAsX = (i) => isColorOrWild(shapes[i], target);
  const whiteX = (i) => isActive(state, i) && shapes[i] === target;

  const spaces = [];
  let count = 0;
  for (let c = 0; c < cells; c += 1) {
    if (!isActive(state, c)) continue;
    if (countsAsX(c)) continue;
    const fillers = neighbors8(state.geom, c).filter(whiteX);
    if (fillers.length === 0) continue;
    const hitLines = [];
    const supports = [];
    for (const lineId of linesThrough[c]) {
      const [x, y, z] = lines[lineId];
      const a = x === c ? y : x;
      const b = z === c ? y : z;
      if (!(countsAsX(a) && countsAsX(b))) continue;
      if (!(perm[a] && perm[b])) continue; // both supporting cells must be permanent
      if (fillers.some((f) => f !== a && f !== b)) {
        count += 1;
        hitLines.push(lineId);
        supports.push(a, b);
      }
    }
    if (hitLines.length) spaces.push({ cell: c, lines: hitLines, supports });
  }
  return { count, spaces };
}
