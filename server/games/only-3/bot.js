// Only 3 bot: iterative-deepening negamax with alpha-beta, a transposition
// table and an incrementally maintained positional score.
//
// Two properties of the game shape the search:
//  * The branching factor is huge (3 colors x up to 36 empty cells), so nodes
//    are limited to the best few candidates by a static score, and that static
//    score is EXACTLY the evaluation after the move — which means a node with
//    one ply left needs no recursion at all, just the best static move.
//  * Move order never matters, only the final set of stones, so transpositions
//    are everywhere. The TT earns its keep several times over.
//
// The evaluation is a sum over the board's 80 three-cell windows: each window
// alive for a player is worth a decaying amount based on how many placements
// they still need to close it (see engine.js `windowCost`). A closed window is
// a real triple, so once the board fills the evaluation IS the exact result —
// no special-cased terminal scoring.
import {
  CELLS,
  EMPTY,
  RED,
  BLUE,
  PURPLE,
  WINDOWS,
  WINDOWS_BY_CELL
} from "./engine.js";

export const ONLY3_BOT_ID = "__only3_bot__";

// Value of a window by remaining cost. Index 0 is a scored triple; a window
// needs at most 5 more placements (3 cells + 2 guards).
const COST_VALUE = [10000, 4200, 1600, 550, 180, 60];
// The "fewer of your own color wins ties" rule, as a nudge small enough that it
// can only ever break ties between otherwise equal lines.
const TIE_WEIGHT = 1;
const INFINITY = 1 << 30;

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_ENTRIES = 500000;

const MAX_MOVES = CELLS * 3;
const MAX_PLY = CELLS + 2;

// Deterministic 26-bit Zobrist keys. Two independent halves are packed into one
// double (26 + 26 = 52 bits) so the table can key on a plain number.
const ZOBRIST_A = new Int32Array(CELLS * 3);
const ZOBRIST_B = new Int32Array(CELLS * 3);
(() => {
  let seed = 0x9e3779b9;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 6; // 26 bits
  };
  for (let i = 0; i < CELLS * 3; i += 1) {
    ZOBRIST_A[i] = next();
    ZOBRIST_B[i] = next();
  }
})();

const WINDOW_CELLS = new Int32Array(WINDOWS.length * 3);
const WINDOW_GUARDS = new Int32Array(WINDOWS.length * 2);
const WINDOW_GUARD_COUNT = new Int32Array(WINDOWS.length);
WINDOWS.forEach((window, i) => {
  WINDOW_CELLS[i * 3] = window.cells[0];
  WINDOW_CELLS[i * 3 + 1] = window.cells[1];
  WINDOW_CELLS[i * 3 + 2] = window.cells[2];
  WINDOW_GUARD_COUNT[i] = window.guards.length;
  for (let g = 0; g < window.guards.length; g += 1) {
    WINDOW_GUARDS[i * 2 + g] = window.guards[g];
  }
});

// How many candidate moves a node considers, by plies left to search. Wide at
// the top of the tree where mistakes are expensive, narrow deep down. Endgames
// small enough to solve outright ignore this entirely.
function candidateWidth(remainingDepth) {
  if (remainingDepth >= 6) return 10;
  if (remainingDepth === 5) return 12;
  if (remainingDepth === 4) return 14;
  if (remainingDepth === 3) return 18;
  return 24;
}

// Below this many empty cells the search runs full-width to the end of the
// game, so its answer is exact rather than heuristic.
const EXACT_ENDGAME_EMPTIES = 8;

export function chooseOnly3Move(boardInput, meColor, options = {}) {
  const { timeMs = 500, maxDepth = MAX_PLY, pickWeights = null } = options;
  const board = Int8Array.from(boardInput);
  const oppColor = meColor === RED ? BLUE : RED;

  const empties = [];
  for (let cell = 0; cell < CELLS; cell += 1) {
    if (board[cell] === EMPTY) empties.push(cell);
  }
  if (empties.length === 0) return null;

  const windowCount = WINDOWS.length;
  const valueRed = new Int32Array(windowCount);
  const valueBlue = new Int32Array(windowCount);
  let potentialRed = 0;
  let potentialBlue = 0;
  let stonesRed = 0;
  let stonesBlue = 0;
  let filled = 0;
  let hashA = 0;
  let hashB = 0;

  const moveBuffers = [];
  const scoreBuffers = [];
  for (let ply = 0; ply < MAX_PLY; ply += 1) {
    moveBuffers.push(new Int32Array(MAX_MOVES));
    scoreBuffers.push(new Int32Array(MAX_MOVES));
  }

  function windowValue(windowIndex, player) {
    const base = windowIndex * 3;
    let cost = 0;
    for (let k = 0; k < 3; k += 1) {
      const value = board[WINDOW_CELLS[base + k]];
      if (value === EMPTY) cost += 1;
      else if (value !== player && value !== PURPLE) return 0;
    }
    const guardBase = windowIndex * 2;
    const guardCount = WINDOW_GUARD_COUNT[windowIndex];
    for (let k = 0; k < guardCount; k += 1) {
      const value = board[WINDOW_GUARDS[guardBase + k]];
      if (value === player || value === PURPLE) return 0;
      if (value === EMPTY) cost += 1;
    }
    return COST_VALUE[cost];
  }

  function refreshCell(cell) {
    const windows = WINDOWS_BY_CELL[cell];
    for (let i = 0; i < windows.length; i += 1) {
      const windowIndex = windows[i];
      potentialRed -= valueRed[windowIndex];
      potentialBlue -= valueBlue[windowIndex];
      const red = windowValue(windowIndex, RED);
      const blue = windowValue(windowIndex, BLUE);
      valueRed[windowIndex] = red;
      valueBlue[windowIndex] = blue;
      potentialRed += red;
      potentialBlue += blue;
    }
  }

  function make(cell, color) {
    board[cell] = color;
    if (color === RED) stonesRed += 1;
    else if (color === BLUE) stonesBlue += 1;
    refreshCell(cell);
    const z = cell * 3 + color - 1;
    hashA ^= ZOBRIST_A[z];
    hashB ^= ZOBRIST_B[z];
    filled += 1;
  }

  function unmake(cell, color) {
    const z = cell * 3 + color - 1;
    hashA ^= ZOBRIST_A[z];
    hashB ^= ZOBRIST_B[z];
    board[cell] = EMPTY;
    if (color === RED) stonesRed -= 1;
    else if (color === BLUE) stonesBlue -= 1;
    refreshCell(cell);
    filled -= 1;
  }

  function evaluate(player) {
    if (player === RED) {
      return potentialRed - potentialBlue + TIE_WEIGHT * (stonesBlue - stonesRed);
    }
    return potentialBlue - potentialRed + TIE_WEIGHT * (stonesRed - stonesBlue);
  }

  // Seed the incremental state from the position we were handed.
  for (let cell = 0; cell < CELLS; cell += 1) {
    const color = board[cell];
    if (color === EMPTY) continue;
    if (color === RED) stonesRed += 1;
    else if (color === BLUE) stonesBlue += 1;
    filled += 1;
    const z = cell * 3 + color - 1;
    hashA ^= ZOBRIST_A[z];
    hashB ^= ZOBRIST_B[z];
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const red = windowValue(windowIndex, RED);
    const blue = windowValue(windowIndex, BLUE);
    valueRed[windowIndex] = red;
    valueBlue[windowIndex] = blue;
    potentialRed += red;
    potentialBlue += blue;
  }

  const table = new Map();
  const key = () => hashA * 67108864 + hashB;

  const deadline = Date.now() + timeMs;
  let nodes = 0;
  let aborted = false;
  function outOfTime() {
    if (aborted) return true;
    nodes += 1;
    if ((nodes & 1023) === 0 && Date.now() >= deadline) aborted = true;
    return aborted;
  }

  // Fills the ply's buffers with every legal move scored by the evaluation of
  // the resulting position, and returns the move count.
  function generate(player, ply) {
    const moves = moveBuffers[ply];
    const scores = scoreBuffers[ply];
    let count = 0;
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (board[cell] !== EMPTY) continue;
      for (let color = RED; color <= PURPLE; color += 1) {
        make(cell, color);
        scores[count] = evaluate(player);
        unmake(cell, color);
        moves[count] = cell * 4 + color;
        count += 1;
      }
    }
    return count;
  }

  // Selection sort one slot at a time: alpha-beta usually cuts long before the
  // whole list is needed, so ordering the tail would be wasted work.
  function selectNext(ply, from, count) {
    const moves = moveBuffers[ply];
    const scores = scoreBuffers[ply];
    let best = from;
    for (let i = from + 1; i < count; i += 1) {
      if (scores[i] > scores[best]) best = i;
    }
    if (best !== from) {
      const move = moves[best];
      const score = scores[best];
      moves[best] = moves[from];
      scores[best] = scores[from];
      moves[from] = move;
      scores[from] = score;
    }
  }

  function promote(ply, count, wanted) {
    const moves = moveBuffers[ply];
    const scores = scoreBuffers[ply];
    for (let i = 0; i < count; i += 1) {
      if (moves[i] !== wanted) continue;
      const move = moves[i];
      const score = scores[i];
      for (let j = i; j > 0; j -= 1) {
        moves[j] = moves[j - 1];
        scores[j] = scores[j - 1];
      }
      moves[0] = move;
      scores[0] = score + INFINITY / 2;
      return;
    }
  }

  function negamax(player, remainingDepth, alphaIn, betaIn, ply) {
    if (filled === CELLS) return evaluate(player);
    if (outOfTime()) return evaluate(player);

    let alpha = alphaIn;
    let beta = betaIn;
    const ttKey = key();
    const entry = table.get(ttKey);
    if (entry && entry.depth >= remainingDepth) {
      if (entry.flag === TT_EXACT) return entry.value;
      if (entry.flag === TT_LOWER && entry.value > alpha) alpha = entry.value;
      else if (entry.flag === TT_UPPER && entry.value < beta) beta = entry.value;
      if (alpha >= beta) return entry.value;
    }

    const alphaOrigin = alpha;
    const count = generate(player, ply);

    // One ply left: the static score already IS the value of the position after
    // the move, so the best static move is the exact depth-1 answer.
    if (remainingDepth <= 1) {
      const scores = scoreBuffers[ply];
      let best = -INFINITY;
      for (let i = 0; i < count; i += 1) {
        if (scores[i] > best) best = scores[i];
      }
      return best;
    }

    if (entry && entry.move >= 0) promote(ply, count, entry.move);

    const empty = CELLS - filled;
    const width =
      empty <= EXACT_ENDGAME_EMPTIES ? count : Math.min(count, candidateWidth(remainingDepth));
    const opponent = player === RED ? BLUE : RED;
    const moves = moveBuffers[ply];

    let best = -INFINITY;
    let bestMove = -1;
    for (let i = 0; i < width; i += 1) {
      selectNext(ply, i, count);
      const move = moves[i];
      const cell = move >> 2;
      const color = move & 3;
      make(cell, color);
      const value = -negamax(opponent, remainingDepth - 1, -beta, -alpha, ply + 1);
      unmake(cell, color);
      if (aborted) return best > -INFINITY ? best : evaluate(player);
      if (value > best) {
        best = value;
        bestMove = move;
        if (value > alpha) alpha = value;
        if (alpha >= beta) break;
      }
    }

    if (table.size < TT_MAX_ENTRIES) {
      const flag = best <= alphaOrigin ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      table.set(ttKey, { depth: remainingDepth, value: best, flag, move: bestMove });
    }
    return best;
  }

  // Root: keeps a full ranking so the weaker levels can deliberately pick a
  // worse move. When ranking matters every root move gets a full window (an
  // alpha-beta bound is enough to find the best move, but not to order the
  // rest).
  const rankAll = Array.isArray(pickWeights) && pickWeights.length > 0;
  const rootCount = generate(meColor, 0);
  const rootMoves = [];
  for (let i = 0; i < rootCount; i += 1) {
    selectNext(0, i, rootCount);
    rootMoves.push({ move: moveBuffers[0][i], score: scoreBuffers[0][i] });
  }

  const rootWidth =
    empties.length <= EXACT_ENDGAME_EMPTIES ? rootMoves.length : Math.min(rootMoves.length, 26);
  const rootPool = rootMoves.slice(0, rootWidth);
  let ranked = rootPool.map((entry) => ({ ...entry }));

  const depthCap = Math.min(maxDepth, empties.length);
  for (let depth = 1; depth <= depthCap; depth += 1) {
    const results = [];
    let alpha = -INFINITY;
    let completed = true;
    for (const candidate of rootPool) {
      const cell = candidate.move >> 2;
      const color = candidate.move & 3;
      make(cell, color);
      const value =
        depth === 1
          ? evaluate(meColor)
          : -negamax(oppColor, depth - 1, -INFINITY, rankAll ? INFINITY : -alpha, 1);
      unmake(cell, color);
      if (aborted) {
        completed = false;
        break;
      }
      results.push({ move: candidate.move, score: value });
      if (!rankAll && value > alpha) alpha = value;
    }
    if (!completed) break;
    results.sort((a, b) => b.score - a.score);
    ranked = results;
    // Re-order the next iteration by what we just learned.
    rootPool.sort(
      (a, b) =>
        (results.find((r) => r.move === b.move)?.score ?? -INFINITY) -
        (results.find((r) => r.move === a.move)?.score ?? -INFINITY)
    );
    if (depth >= empties.length) break; // solved to the end of the game
    if (Date.now() >= deadline) break;
  }

  const chosen = pickRanked(ranked, pickWeights);
  if (!chosen) return null;
  return { cell: chosen.move >> 2, color: chosen.move & 3, score: chosen.score };
}

// Weaker levels blunder on purpose: pickWeights are the probabilities of taking
// the 1st, 2nd, 3rd... ranked move.
function pickRanked(ranked, pickWeights) {
  if (ranked.length === 0) return null;
  if (!Array.isArray(pickWeights) || pickWeights.length === 0) return ranked[0];
  const usable = pickWeights.slice(0, ranked.length);
  const total = usable.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return ranked[0];
  let roll = Math.random() * total;
  for (let i = 0; i < usable.length; i += 1) {
    roll -= usable[i];
    if (roll <= 0) return ranked[i];
  }
  return ranked[usable.length - 1];
}
