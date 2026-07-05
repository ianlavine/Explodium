// Flip Triples search core — AssemblyScript port of the flip-solver.js
// "simple path" (red/blue/neutral pieces on bitboard-capable boards).
// Direct translation of the JS engine: bitboard movegen, negamax + PVS,
// staged TT move, killers/history ordering, persistent generation-aged TT,
// incremental evaluation counters. Exotic pieces and rootMoves-restricted
// searches stay on the JS engine (the wrapper falls back).
//
// The JS engine remains the reference implementation; equivalence is
// enforced by the test harness (exact-solve values must match).

// Host-provided clock (Date.now).
@external("env", "now")
declare function now(): f64;

const RED: i32 = 0;
const BLUE: i32 = 1;
const NEUTRAL: i32 = 2;

const INF: i32 = 1000000000;
const TERMINAL_SCALE: i32 = 100000;
const TIE_SCALE: i32 = 10;

const MAX_PLY: i32 = 64;
const MAX_MOVES: i32 = 640;
const MAX_CELLS: i32 = 32;
const MAX_LINES: i32 = 128;

const TT_BITS: i32 = 21;
const TT_SIZE: i32 = 1 << TT_BITS;
const TT_MASK: i32 = TT_SIZE - 1;
const TT_EXACT: i32 = 0;
const TT_LOWER: i32 = 1;
const TT_UPPER: i32 = 2;

// ---------------------------------------------------------------------------
// Config + geometry (rebuilt by init)
// ---------------------------------------------------------------------------

let rows: i32 = 0;
let cols: i32 = 0;
let cells: i32 = 0;
let uniqueSwap: bool = true;
let staticNeutrals: bool = false;
let blockedCenter: i32 = -1; // cell index or -1
let phase: i32 = 1;
let noTiebreak: bool = false;
let carryDiff: i32 = 0;
let centerIdx: i32 = -1;

let boardMaskP: i32 = 0;
const rowOf = new StaticArray<i32>(MAX_CELLS);
const colOf = new StaticArray<i32>(MAX_CELLS);
const padBit = new StaticArray<i32>(MAX_CELLS);
const cellOfBit = new StaticArray<i32>(MAX_CELLS);
const dirsP = new StaticArray<i32>(8);
let lineCount: i32 = 0;
const lineMasksP = new StaticArray<i32>(MAX_LINES);
// lines through each cell: offsets into a flat id list
const ltOff = new StaticArray<i32>(MAX_CELLS + 1);
const ltIds = new StaticArray<i32>(MAX_LINES * 3);
// "other two cells" masks per (cell, line-through) entry, aligned with ltIds
const ltOthers = new StaticArray<i32>(MAX_LINES * 3);

// Zobrist
const zob1 = new StaticArray<u32>(MAX_CELLS * 14);
const zob2 = new StaticArray<u32>(MAX_CELLS * 14);
const sideKey1 = new StaticArray<u32>(2);
const sideKey2 = new StaticArray<u32>(2);

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

const shapes = new StaticArray<i32>(MAX_CELLS);
const flippedA = new StaticArray<i32>(MAX_CELLS);
let mRed: i32 = 0;
let mBlue: i32 = 0;
let mFlip: i32 = 0;
let h1: u32 = 0;
let h2: u32 = 0;
let cntAllRed: i32 = 0;
let cntAllBlue: i32 = 0;
let cntLockedRed: i32 = 0;
let cntLockedBlue: i32 = 0;
let whiteRed: i32 = 0;
let whiteBlue: i32 = 0;

// ---------------------------------------------------------------------------
// Search tables
// ---------------------------------------------------------------------------

const ttKey = new StaticArray<u32>(TT_SIZE);
const ttVal = new StaticArray<i32>(TT_SIZE);
const ttMeta = new StaticArray<i32>(TT_SIZE);
let ttGen: i32 = 0;

const moveBuf = new StaticArray<i32>(MAX_PLY * MAX_MOVES);
const scoreBuf = new StaticArray<i32>(MAX_PLY * MAX_MOVES);
const killer1 = new StaticArray<i32>(MAX_PLY);
const killer2 = new StaticArray<i32>(MAX_PLY);
const cntSave = new StaticArray<i32>(MAX_PLY * 8);
const history = new StaticArray<i32>(MAX_CELLS * MAX_CELLS);

// Root bookkeeping
const moveA = new StaticArray<i32>(MAX_CELLS * MAX_CELLS);
const moveB = new StaticArray<i32>(MAX_CELLS * MAX_CELLS);

const rootMovesA = new StaticArray<i32>(MAX_MOVES);
const rootValuesA = new StaticArray<i32>(MAX_MOVES);
let rootCount: i32 = 0;

let nodes: i32 = 0;
let cutoffCount: i32 = 0;
let deadline: f64 = 0;
let aborted: bool = false;

// Results
let resMove: i32 = -1;
let resValue: i32 = 0; // mover's perspective
let resDepth: i32 = 0;
let resSolved: i32 = 0;

// ---------------------------------------------------------------------------
// RNG for zobrist
// ---------------------------------------------------------------------------

let rngState: u32 = 0;
function rngNext(): u32 {
  rngState += 0x6d2b79f5;
  let t: u32 = rngState;
  t = (t ^ (t >> 15)) * (1 | t);
  t = (t + ((t ^ (t >> 7)) * (61 | t))) ^ t;
  return t ^ (t >> 14);
}

// ---------------------------------------------------------------------------
// init: configure rules + rebuild geometry + clear TT
// ---------------------------------------------------------------------------

export function init(
  r: i32,
  c: i32,
  unique: i32,
  statNeu: i32,
  blocked: i32,
  ph: i32,
  noTb: i32,
  carry: i32
): i32 {
  rows = r;
  cols = c;
  cells = r * c;
  uniqueSwap = unique != 0;
  staticNeutrals = statNeu != 0;
  blockedCenter = blocked;
  phase = ph;
  noTiebreak = noTb != 0;
  carryDiff = carry;
  const padCols = c + 1;
  if (rows * padCols > 31 || cells > MAX_CELLS) return 0; // not bitboard-capable

  centerIdx = (r % 2 == 1 && c % 2 == 1) ? (r / 2) * c + c / 2 : -1;

  boardMaskP = 0;
  for (let i = 0; i < MAX_CELLS; i++) unchecked(cellOfBit[i] = -1);
  for (let i = 0; i < cells; i++) {
    const rr = i / c;
    const cc = i % c;
    unchecked(rowOf[i] = rr);
    unchecked(colOf[i] = cc);
    const bit = rr * padCols + cc;
    unchecked(padBit[i] = bit);
    unchecked(cellOfBit[bit] = i);
    boardMaskP |= 1 << bit;
  }
  unchecked(dirsP[0] = 1);
  unchecked(dirsP[1] = -1);
  unchecked(dirsP[2] = padCols);
  unchecked(dirsP[3] = -padCols);
  unchecked(dirsP[4] = padCols + 1);
  unchecked(dirsP[5] = -(padCols + 1));
  unchecked(dirsP[6] = padCols - 1);
  unchecked(dirsP[7] = -(padCols - 1));
  for (let m = 0; m < cells * cells; m++) {
    unchecked(moveA[m] = m / cells);
    unchecked(moveB[m] = m % cells);
  }

  // Lines (4 orientations), padded masks, per-cell through-lists.
  lineCount = 0;
  // temporary per-cell counts
  const tmpCount = new StaticArray<i32>(MAX_CELLS);
  for (let i = 0; i < cells; i++) unchecked(tmpCount[i] = 0);
  const lineCellsFlat = new StaticArray<i32>(MAX_LINES * 3);
  for (let rr = 0; rr < rows; rr++) {
    for (let cc = 0; cc < cols; cc++) {
      for (let d = 0; d < 4; d++) {
        let dr = 0;
        let dc = 0;
        if (d == 0) { dr = 0; dc = 1; }
        else if (d == 1) { dr = 1; dc = 0; }
        else if (d == 2) { dr = 1; dc = 1; }
        else { dr = 1; dc = -1; }
        const r2 = rr + 2 * dr;
        const c2 = cc + 2 * dc;
        if (r2 < 0 || r2 >= rows || c2 < 0 || c2 >= cols) continue;
        const x = rr * cols + cc;
        const y = (rr + dr) * cols + (cc + dc);
        const z = r2 * cols + c2;
        unchecked(lineMasksP[lineCount] =
          (1 << unchecked(padBit[x])) | (1 << unchecked(padBit[y])) | (1 << unchecked(padBit[z])));
        unchecked(lineCellsFlat[lineCount * 3] = x);
        unchecked(lineCellsFlat[lineCount * 3 + 1] = y);
        unchecked(lineCellsFlat[lineCount * 3 + 2] = z);
        unchecked(tmpCount[x] += 1);
        unchecked(tmpCount[y] += 1);
        unchecked(tmpCount[z] += 1);
        lineCount++;
      }
    }
  }
  // prefix offsets
  let acc = 0;
  for (let i = 0; i < cells; i++) {
    unchecked(ltOff[i] = acc);
    acc += unchecked(tmpCount[i]);
    unchecked(tmpCount[i] = 0);
  }
  unchecked(ltOff[cells] = acc);
  for (let l = 0; l < lineCount; l++) {
    for (let k = 0; k < 3; k++) {
      const cell = unchecked(lineCellsFlat[l * 3 + k]);
      const pos = unchecked(ltOff[cell]) + unchecked(tmpCount[cell]);
      unchecked(ltIds[pos] = l);
      unchecked(ltOthers[pos] = unchecked(lineMasksP[l]) & ~(1 << unchecked(padBit[cell])));
      unchecked(tmpCount[cell] += 1);
    }
  }

  // Zobrist
  rngState = 0x9e3779b9;
  for (let i = 0; i < cells * 14; i++) {
    unchecked(zob1[i] = rngNext());
    unchecked(zob2[i] = rngNext());
  }
  unchecked(sideKey1[0] = rngNext());
  unchecked(sideKey2[0] = rngNext());
  unchecked(sideKey1[1] = rngNext());
  unchecked(sideKey2[1] = rngNext());

  // Clear TT + history
  for (let i = 0; i < TT_SIZE; i++) unchecked(ttMeta[i] = 0);
  ttGen = 0;
  return 1;
}

export function setCell(i: i32, shape: i32, flip: i32): void {
  unchecked(shapes[i] = shape);
  unchecked(flippedA[i] = flip);
}

// Recompute masks, counters and hash from the board arrays.
export function beginPosition(): void {
  mRed = 0;
  mBlue = 0;
  mFlip = 0;
  h1 = 0;
  h2 = 0;
  for (let i = 0; i < cells; i++) {
    const s = unchecked(shapes[i]);
    const f = unchecked(flippedA[i]);
    const bit = 1 << unchecked(padBit[i]);
    if (s == RED) mRed |= bit;
    else if (s == BLUE) mBlue |= bit;
    if (f != 0) mFlip |= bit;
    const idx = i * 14 + s * 2 + f;
    h1 ^= unchecked(zob1[idx]);
    h2 ^= unchecked(zob2[idx]);
  }
  cntAllRed = 0;
  cntAllBlue = 0;
  cntLockedRed = 0;
  cntLockedBlue = 0;
  const lockedM = (phase == 1 ? mFlip : ~mFlip) & boardMaskP;
  for (let l = 0; l < lineCount; l++) {
    const L = unchecked(lineMasksP[l]);
    if ((L & mRed) == L) {
      cntAllRed++;
      if ((L & lockedM) == L) cntLockedRed++;
    } else if ((L & mBlue) == L) {
      cntAllBlue++;
      if ((L & lockedM) == L) cntLockedBlue++;
    }
  }
  whiteRed = popcnt<i32>(mRed & ~mFlip);
  whiteBlue = popcnt<i32>(mBlue & ~mFlip);
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

@inline
function dsh(m: i32, d: i32): i32 {
  return d > 0 ? (m >>> d) : (m << -d);
}

@inline
function activeMaskP(): i32 {
  return (phase == 1 ? ~mFlip : mFlip) & boardMaskP;
}

function genMovesAt(off: i32): i32 {
  const active = activeMaskP();
  const red = mRed;
  const blue = mBlue;
  const neu = boardMaskP & ~(red | blue);
  const centerBit = blockedCenter >= 0 ? 1 << unchecked(padBit[blockedCenter]) : 0;
  let n = 0;
  for (let k = 0; k < 8; k++) {
    const d = unchecked(dirsP[k]);
    let firsts = active & dsh(active, d);
    if (uniqueSwap) {
      firsts &= ~(red & dsh(red, d));
      firsts &= ~(blue & dsh(blue, d));
      firsts &= ~(neu & dsh(neu, d));
    }
    if (staticNeutrals) firsts &= ~dsh(neu, d);
    if (centerBit != 0) firsts &= ~dsh(centerBit, d);
    while (firsts != 0) {
      const lsb = firsts & -firsts;
      firsts ^= lsb;
      const bitA = 31 - clz<i32>(lsb);
      unchecked(moveBuf[off + n] =
        unchecked(cellOfBit[bitA]) * cells + unchecked(cellOfBit[bitA + d]));
      n++;
    }
  }
  return n;
}

function hasMove(): bool {
  const active = activeMaskP();
  const red = mRed;
  const blue = mBlue;
  const neu = boardMaskP & ~(red | blue);
  const centerBit = blockedCenter >= 0 ? 1 << unchecked(padBit[blockedCenter]) : 0;
  for (let k = 0; k < 8; k++) {
    const d = unchecked(dirsP[k]);
    let firsts = active & dsh(active, d);
    if (uniqueSwap) {
      firsts &= ~(red & dsh(red, d));
      firsts &= ~(blue & dsh(blue, d));
      firsts &= ~(neu & dsh(neu, d));
    }
    if (staticNeutrals) firsts &= ~dsh(neu, d);
    if (centerBit != 0) firsts &= ~dsh(centerBit, d);
    if (firsts != 0) return true;
  }
  return false;
}

@inline
function isActiveCell(i: i32): bool {
  return phase == 1 ? unchecked(flippedA[i]) == 0 : unchecked(flippedA[i]) != 0;
}

function isLegalMove(m: i32): bool {
  if (m < 0 || m >= cells * cells) return false;
  const a = unchecked(moveA[m]);
  const b = unchecked(moveB[m]);
  if (a == b) return false;
  let dr = unchecked(rowOf[a]) - unchecked(rowOf[b]);
  if (dr < 0) dr = -dr;
  let dc = unchecked(colOf[a]) - unchecked(colOf[b]);
  if (dc < 0) dc = -dc;
  if (dr > 1 || dc > 1) return false;
  if (!isActiveCell(a) || !isActiveCell(b)) return false;
  const sa = unchecked(shapes[a]);
  const sb = unchecked(shapes[b]);
  if (uniqueSwap && sa == sb) return false;
  if (staticNeutrals && sb == NEUTRAL) return false;
  if (blockedCenter == b) return false;
  return true;
}

// Contribution add/remove for lines through a and b (dedup via stamp).
const lineSeen = new StaticArray<i32>(MAX_LINES);
let lineSeenGen: i32 = 0;
const affected = new StaticArray<i32>(64);
let affectedN: i32 = 0;

function adjustContrib(a: i32, b: i32, sign: i32): void {
  if (sign < 0) {
    lineSeenGen++;
    affectedN = 0;
    for (let p = unchecked(ltOff[a]); p < unchecked(ltOff[a + 1]); p++) {
      const id = unchecked(ltIds[p]);
      unchecked(lineSeen[id] = lineSeenGen);
      unchecked(affected[affectedN++] = id);
    }
    for (let p = unchecked(ltOff[b]); p < unchecked(ltOff[b + 1]); p++) {
      const id = unchecked(ltIds[p]);
      if (unchecked(lineSeen[id]) != lineSeenGen) {
        unchecked(lineSeen[id] = lineSeenGen);
        unchecked(affected[affectedN++] = id);
      }
    }
  }
  const lockedM = (phase == 1 ? mFlip : ~mFlip) & boardMaskP;
  for (let i = 0; i < affectedN; i++) {
    const L = unchecked(lineMasksP[unchecked(affected[i])]);
    if ((L & mRed) == L) {
      cntAllRed += sign;
      if ((L & lockedM) == L) cntLockedRed += sign;
    } else if ((L & mBlue) == L) {
      cntAllBlue += sign;
      if ((L & lockedM) == L) cntLockedBlue += sign;
    }
  }
  if (unchecked(flippedA[a]) == 0) {
    if (unchecked(shapes[a]) == RED) whiteRed += sign;
    else if (unchecked(shapes[a]) == BLUE) whiteBlue += sign;
  }
  if (unchecked(flippedA[b]) == 0) {
    if (unchecked(shapes[b]) == RED) whiteRed += sign;
    else if (unchecked(shapes[b]) == BLUE) whiteBlue += sign;
  }
}

function moveCore(a: i32, b: i32, undoing: bool): void {
  let idx = a * 14 + unchecked(shapes[a]) * 2 + unchecked(flippedA[a]);
  h1 ^= unchecked(zob1[idx]);
  h2 ^= unchecked(zob2[idx]);
  idx = b * 14 + unchecked(shapes[b]) * 2 + unchecked(flippedA[b]);
  h1 ^= unchecked(zob1[idx]);
  h2 ^= unchecked(zob2[idx]);

  if (!undoing) {
    const lockFlip = phase == 1 ? 1 : 0;
    const sb = unchecked(shapes[b]);
    const fb = unchecked(flippedA[b]);
    unchecked(shapes[b] = unchecked(shapes[a]));
    unchecked(flippedA[b] = lockFlip);
    unchecked(shapes[a] = sb);
    unchecked(flippedA[a] = fb);
  } else {
    const activeFlip = phase == 1 ? 0 : 1;
    const firstShape = unchecked(shapes[b]);
    const secondShape = unchecked(shapes[a]);
    const secondFlip = unchecked(flippedA[a]);
    unchecked(shapes[a] = firstShape);
    unchecked(flippedA[a] = activeFlip);
    unchecked(shapes[b] = secondShape);
    unchecked(flippedA[b] = secondFlip);
  }

  idx = a * 14 + unchecked(shapes[a]) * 2 + unchecked(flippedA[a]);
  h1 ^= unchecked(zob1[idx]);
  h2 ^= unchecked(zob2[idx]);
  idx = b * 14 + unchecked(shapes[b]) * 2 + unchecked(flippedA[b]);
  h1 ^= unchecked(zob1[idx]);
  h2 ^= unchecked(zob2[idx]);

  // masks
  const bitA = 1 << unchecked(padBit[a]);
  const bitB = 1 << unchecked(padBit[b]);
  const both = bitA | bitB;
  mRed &= ~both;
  mBlue &= ~both;
  mFlip &= ~both;
  const sa2 = unchecked(shapes[a]);
  const sb2 = unchecked(shapes[b]);
  if (sa2 == RED) mRed |= bitA;
  else if (sa2 == BLUE) mBlue |= bitA;
  if (sb2 == RED) mRed |= bitB;
  else if (sb2 == BLUE) mBlue |= bitB;
  if (unchecked(flippedA[a]) != 0) mFlip |= bitA;
  if (unchecked(flippedA[b]) != 0) mFlip |= bitB;
}

function applySearch(m: i32, ply: i32): void {
  const o = ply * 8;
  unchecked(cntSave[o] = cntAllRed);
  unchecked(cntSave[o + 1] = cntAllBlue);
  unchecked(cntSave[o + 2] = cntLockedRed);
  unchecked(cntSave[o + 3] = cntLockedBlue);
  unchecked(cntSave[o + 4] = whiteRed);
  unchecked(cntSave[o + 5] = whiteBlue);
  const a = unchecked(moveA[m]);
  const b = unchecked(moveB[m]);
  adjustContrib(a, b, -1);
  moveCore(a, b, false);
  adjustContrib(a, b, 1);
}

function undoSearch(m: i32, ply: i32): void {
  const a = unchecked(moveA[m]);
  const b = unchecked(moveB[m]);
  moveCore(a, b, true);
  const o = ply * 8;
  cntAllRed = unchecked(cntSave[o]);
  cntAllBlue = unchecked(cntSave[o + 1]);
  cntLockedRed = unchecked(cntSave[o + 2]);
  cntLockedBlue = unchecked(cntSave[o + 3]);
  whiteRed = unchecked(cntSave[o + 4]);
  whiteBlue = unchecked(cntSave[o + 5]);
}

// ---------------------------------------------------------------------------
// Evaluation (red perspective)
// ---------------------------------------------------------------------------

function centerTb(): i32 {
  const s = unchecked(shapes[centerIdx]);
  if (s == RED) return -1;
  if (s == BLUE) return 1;
  return 0;
}

function terminalEval(): i32 {
  const diff = cntAllRed - cntAllBlue + carryDiff;
  let tb = centerIdx >= 0 ? centerTb() : whiteRed - whiteBlue;
  if (noTiebreak) tb = 0;
  return diff * TERMINAL_SCALE + tb * TIE_SCALE;
}

function staticEval(): i32 {
  return (
    (cntLockedRed - cntLockedBlue + carryDiff) * 2000 +
    (cntAllRed - cntAllBlue) * 250 +
    (whiteRed - whiteBlue) * TIE_SCALE
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function scoreMoves(side: i32, off: i32, count: i32, ttMove: i32, ply: i32): void {
  const lockedM = (phase == 1 ? mFlip : ~mFlip) & boardMaskP;
  const ownShape = side == 1 ? RED : BLUE;
  const k1 = unchecked(killer1[ply]);
  const k2 = unchecked(killer2[ply]);
  for (let i = 0; i < count; i++) {
    const m = unchecked(moveBuf[off + i]);
    if (m == ttMove) {
      unchecked(scoreBuf[off + i] = 1 << 24);
      continue;
    }
    const a = unchecked(moveA[m]);
    const b = unchecked(moveB[m]);
    const s = unchecked(shapes[a]);
    let sc = unchecked(history[m]);
    if (s == RED || s == BLUE) {
      const lockedS = (s == RED ? mRed : mBlue) & lockedM;
      let completes = 0;
      for (let p = unchecked(ltOff[b]); p < unchecked(ltOff[b + 1]); p++) {
        const others = unchecked(ltOthers[p]);
        if ((others & lockedS) == others) completes++;
      }
      sc += s == ownShape ? 4096 * completes : -3072 * completes;
    }
    if (m == k1) sc += 2400;
    else if (m == k2) sc += 1800;
    unchecked(scoreBuf[off + i] = sc);
  }
}

function pickNext(off: i32, i: i32, count: i32): i32 {
  let bestIdx = i;
  let bestScore = unchecked(scoreBuf[off + i]);
  for (let j = i + 1; j < count; j++) {
    if (unchecked(scoreBuf[off + j]) > bestScore) {
      bestScore = unchecked(scoreBuf[off + j]);
      bestIdx = j;
    }
  }
  if (bestIdx != i) {
    const tm = unchecked(moveBuf[off + i]);
    unchecked(moveBuf[off + i] = unchecked(moveBuf[off + bestIdx]));
    unchecked(moveBuf[off + bestIdx] = tm);
    const ts = unchecked(scoreBuf[off + i]);
    unchecked(scoreBuf[off + i] = unchecked(scoreBuf[off + bestIdx]));
    unchecked(scoreBuf[off + bestIdx] = ts);
  }
  return unchecked(moveBuf[off + i]);
}

// ---------------------------------------------------------------------------
// TT
// ---------------------------------------------------------------------------

function ttStore(slot: i32, key2v: u32, value: i32, depth: i32, flag: i32, solved: i32, bestMove: i32): void {
  const cur = unchecked(ttMeta[slot]);
  if (cur != 0 && unchecked(ttKey[slot]) != key2v) {
    const eGen = (cur >>> 21) & 63;
    if (eGen == ttGen) {
      const eDepth = (cur >> 12) & 0x3f;
      const eSolved = (cur >>> 20) & 1;
      if (eDepth > depth && !(solved != 0 && eSolved == 0)) return;
      if (eSolved != 0 && solved == 0) return;
    }
  }
  unchecked(ttKey[slot] = key2v);
  unchecked(ttVal[slot] = value);
  unchecked(ttMeta[slot] = (bestMove + 1) | (depth << 12) | ((flag + 1) << 18) | (solved << 20) | (ttGen << 21));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

@inline
function redSign(side: i32): i32 {
  return side == 1 ? 1 : -1;
}

function negamax(side: i32, depth: i32, alphaIn: i32, betaIn: i32, ply: i32): i32 {
  let alpha = alphaIn;
  let beta = betaIn;
  nodes++;
  if ((nodes & 2047) == 0 && now() > deadline) {
    aborted = true;
    return 0;
  }

  if (!hasMove()) return redSign(side) * terminalEval();
  if (depth <= 0) {
    cutoffCount++;
    return redSign(side) * staticEval();
  }

  const key1 = h1 ^ unchecked(sideKey1[side]);
  const key2v = h2 ^ unchecked(sideKey2[side]);
  const slot = <i32>(key1 & <u32>TT_MASK);
  let ttMove = -1;
  const meta = unchecked(ttMeta[slot]);
  if (meta != 0 && unchecked(ttKey[slot]) == key2v) {
    ttMove = (meta & 0xfff) - 1;
    const eDepth = (meta >> 12) & 0x3f;
    const eFlag = ((meta >> 18) & 0x3) - 1;
    const eSolved = (meta >>> 20) & 1;
    const eGen = (meta >>> 21) & 63;
    if (eSolved != 0 || (eGen == ttGen && eDepth >= depth)) {
      const v = unchecked(ttVal[slot]);
      const usable =
        eFlag == TT_EXACT ||
        (eFlag == TT_LOWER && v >= beta) ||
        (eFlag == TT_UPPER && v <= alpha);
      if (usable) {
        if (eSolved == 0) cutoffCount++;
        return v;
      }
      if (eSolved != 0) {
        if (eFlag == TT_LOWER && v > alpha) alpha = v;
        else if (eFlag == TT_UPPER && v < beta) beta = v;
        if (alpha >= beta) return v;
      }
    }
  }

  const cutoffsAtEntry = cutoffCount;
  const origAlpha = alpha;
  let best = -INF;
  let bestMove = -1;
  let searchedFirst = false;

  // Staged TT move: try before generating.
  let stagedMove = -1;
  if (ttMove >= 0 && isLegalMove(ttMove)) {
    stagedMove = ttMove;
    applySearch(stagedMove, ply);
    const v = -negamax(1 - side, depth - 1, -beta, -alpha, ply + 1);
    undoSearch(stagedMove, ply);
    if (aborted) return 0;
    best = v;
    bestMove = stagedMove;
    if (best > alpha) alpha = best;
    searchedFirst = true;
    if (alpha >= beta) {
      unchecked(history[stagedMove] += depth * depth);
      if (unchecked(killer1[ply]) != stagedMove) {
        unchecked(killer2[ply] = unchecked(killer1[ply]));
        unchecked(killer1[ply] = stagedMove);
      }
      const solvedF = cutoffCount == cutoffsAtEntry ? 1 : 0;
      ttStore(slot, key2v, best, depth, TT_LOWER, solvedF, bestMove);
      return best;
    }
  }

  const off = ply * MAX_MOVES;
  const count = genMovesAt(off);
  scoreMoves(side, off, count, stagedMove >= 0 ? -1 : ttMove, ply);

  for (let i = 0; i < count; i++) {
    const m = pickNext(off, i, count);
    if (m == stagedMove) continue;
    applySearch(m, ply);
    let v: i32;
    if (!searchedFirst) {
      v = -negamax(1 - side, depth - 1, -beta, -alpha, ply + 1);
    } else {
      v = -negamax(1 - side, depth - 1, -alpha - 1, -alpha, ply + 1);
      if (!aborted && v > alpha && v < beta) {
        v = -negamax(1 - side, depth - 1, -beta, -v, ply + 1);
      }
    }
    undoSearch(m, ply);
    if (aborted) return 0;
    searchedFirst = true;
    if (v > best) {
      best = v;
      bestMove = m;
    }
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      unchecked(history[m] += depth * depth);
      if (unchecked(killer1[ply]) != m) {
        unchecked(killer2[ply] = unchecked(killer1[ply]));
        unchecked(killer1[ply] = m);
      }
      break;
    }
  }

  const solvedF = cutoffCount == cutoffsAtEntry ? 1 : 0;
  let flag = TT_EXACT;
  if (best <= origAlpha) flag = TT_UPPER;
  else if (best >= beta) flag = TT_LOWER;
  ttStore(slot, key2v, best, depth, flag, solvedF, bestMove);
  return best;
}

// Root search. Returns best move (or -1 when the side has no legal move).
// Values reported from the MOVER's perspective (the JS wrapper converts).
export function searchRoot(player: i32, maxDepth: i32, timeMs: f64): i32 {
  rootCount = genMovesAt(0);
  if (rootCount == 0) return -1;
  for (let i = 0; i < rootCount; i++) {
    unchecked(rootMovesA[i] = unchecked(moveBuf[i]));
    unchecked(rootValuesA[i] = -INF);
  }

  nodes = 0;
  aborted = false;
  deadline = now() + timeMs;
  ttGen = (ttGen + 1) & 63;
  for (let i = 0; i < cells * cells; i++) unchecked(history[i] = 0);
  for (let i = 0; i < MAX_PLY; i++) {
    unchecked(killer1[i] = -1);
    unchecked(killer2[i] = -1);
  }

  resMove = unchecked(rootMovesA[0]);
  resValue = -INF;
  resDepth = 0;
  resSolved = 0;

  const iterValues = new StaticArray<i32>(MAX_MOVES);

  for (let depth = 1; depth <= maxDepth; depth++) {
    cutoffCount = 0;
    let iterBest = -INF;
    let iterMove = -1;
    let alpha = -INF;
    for (let i = 0; i < rootCount; i++) {
      const m = unchecked(rootMovesA[i]);
      applySearch(m, 0);
      let v: i32;
      if (i == 0) {
        v = -negamax(1 - player, depth - 1, -INF, -alpha, 1);
      } else {
        v = -negamax(1 - player, depth - 1, -alpha - 1, -alpha, 1);
        if (!aborted && v > alpha && v < INF) {
          v = -negamax(1 - player, depth - 1, -INF, -v, 1);
        }
      }
      undoSearch(m, 0);
      if (aborted) break;
      unchecked(iterValues[i] = v);
      if (v > iterBest) {
        iterBest = v;
        iterMove = m;
      }
      if (iterBest > alpha) alpha = iterBest;
    }
    if (aborted) break;

    resMove = iterMove;
    resValue = iterBest;
    resDepth = depth;
    for (let i = 0; i < rootCount; i++) unchecked(rootValuesA[i] = unchecked(iterValues[i]));
    // insertion sort root moves by value desc (parallel arrays)
    for (let i = 1; i < rootCount; i++) {
      const mv = unchecked(rootMovesA[i]);
      const vv = unchecked(rootValuesA[i]);
      let j = i - 1;
      while (j >= 0 && unchecked(rootValuesA[j]) < vv) {
        unchecked(rootMovesA[j + 1] = unchecked(rootMovesA[j]));
        unchecked(rootValuesA[j + 1] = unchecked(rootValuesA[j]));
        j--;
      }
      unchecked(rootMovesA[j + 1] = mv);
      unchecked(rootValuesA[j + 1] = vv);
    }
    if (cutoffCount == 0) {
      resSolved = 1;
      break;
    }
    if (now() > deadline) break;
  }
  return resMove;
}

export function getValue(): i32 {
  return resValue;
}
export function getDepth(): i32 {
  return resDepth;
}
export function getSolved(): i32 {
  return resSolved;
}
export function getNodes(): i32 {
  return nodes;
}
export function getRankedCount(): i32 {
  return rootCount;
}
export function getRankedMove(i: i32): i32 {
  return unchecked(rootMovesA[i]);
}
export function getRankedValue(i: i32): i32 {
  return unchecked(rootValuesA[i]);
}
