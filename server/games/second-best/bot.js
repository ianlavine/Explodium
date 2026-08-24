// Second Best bot: iterative-deepening negamax with alpha-beta and a
// transposition table.
//
// Three things about the game shape the search:
//  * Branching is every empty cell times two colors (three while the neutral
//    stock holds out), so nodes only recurse into the best few candidates by a
//    static score — and that static score is EXACTLY the evaluation after the
//    move, so a node with one ply left needs no recursion.
//  * Move ORDER never matters, only the final arrangement of pieces, so
//    transpositions are everywhere and the TT pays for itself many times over.
//  * The board is 25 or 36 cells, so once it is nearly full the search runs
//    full-width to the end and its answer is exact, not heuristic.
//
// The evaluation is the hard part, because "second-largest group" is worth
// nothing until late: two groups of 1 score 1 whether or not they have room to
// grow. So a group is valued at its size PLUS its room to breathe, a color with
// fewer than two groups gets a nascent second group valued from the largest
// open region, and a pair of top groups that a single placement would weld
// together is discounted toward the third group's value — because the opponent
// can, and will, place your color in that cell.
//
// Neutrals need no special handling anywhere below: they are simply not empty
// and not either color, so they shrink liberties and cut regions on their own.
// The remaining stock never needs hashing either — with the seeded neutrals
// fixed for the whole search, the count of black on the board determines it.
import { EMPTY, BLUE, RED, NEUTRAL, MAX_SIZE, geometry, geometryFor, findGroups, secondLargest } from "./engine.js";

export const SECOND_BEST_BOT_ID = "__second_best_bot__";

// One piece of group size is worth 100, so every other term reads as a
// fraction of a piece.
const SIZE_UNIT = 100;
// Each empty cell touching a group, up to LIB_CAP of them. Room to grow is
// worth a lot early and nothing once the board is closed.
const LIB_WEIGHT = 42;
const LIB_CAP = 4;
// A color with fewer than two groups still has the open board to start one in.
const SEED_WEIGHT = 34;
const SEED_CAP = 5;
// When ONE placement would merge the top two groups, the second-largest is
// living on borrowed time — blend it toward the third group's value.
const MERGE_KEEP = 0.6;
// "Fewer of your own pieces wins ties", small enough to only break ties.
const TIE_WEIGHT = 3;

const TERMINAL_WIN = 900000;
const INFINITY = 1 << 30;

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_ENTRIES = 400000;

const MAX_CELLS = geometry(MAX_SIZE).cells;
const MAX_MOVES = MAX_CELLS * 3;
const MAX_PLY = MAX_CELLS + 2;

// Below this many empty cells the search ignores its candidate width and
// solves the rest of the game outright. A live neutral stock adds a third
// color to every node, so the exhaustive window has to start later.
const EXACT_ENDGAME_EMPTIES = 9;
const EXACT_ENDGAME_EMPTIES_WITH_NEUTRALS = 7;

// How many candidates a node considers, by plies left. Wide at the top where
// mistakes are expensive, narrow deep down.
function candidateWidth(remainingDepth) {
  if (remainingDepth >= 6) return 8;
  if (remainingDepth === 5) return 10;
  if (remainingDepth === 4) return 12;
  if (remainingDepth === 3) return 16;
  return 22;
}

// Deterministic 26-bit Zobrist keys, two halves packed into one double so the
// table can key on a plain number.
const ZOBRIST_A = new Int32Array(MAX_CELLS * 3);
const ZOBRIST_B = new Int32Array(MAX_CELLS * 3);
(() => {
  let seed = 0x9e3779b9;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 6; // 26 bits
  };
  for (let i = 0; i < MAX_CELLS * 3; i += 1) {
    ZOBRIST_A[i] = next();
    ZOBRIST_B[i] = next();
  }
})();

// Search-wide scratch, sized for the biggest board. Only one search runs at a
// time (the bot lives in its own worker thread), so these are reused rather
// than reallocated per evaluation.
const cellGroup = new Int32Array(MAX_CELLS);
const groupSizes = new Int32Array(MAX_CELLS);
const groupLibs = new Int32Array(MAX_CELLS);
const libStamp = new Int32Array(MAX_CELLS);
const seen = new Uint8Array(MAX_CELLS);
const stack = new Int32Array(MAX_CELLS);
const pots = new Int32Array(MAX_CELLS + 1);
let stampCounter = 0;

export function chooseSecondBestMove(boardInput, meColor, options = {}) {
  const { timeMs = 500, maxDepth = MAX_PLY, pickWeights = null, neutralsLeft = 0 } = options;
  const board = Int8Array.from(boardInput);
  const { cells, neighbors } = geometryFor(boardInput);
  const oppColor = meColor === BLUE ? RED : BLUE;

  let emptyCount = 0;
  let piecesBlue = 0;
  let piecesRed = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    if (board[cell] === EMPTY) emptyCount += 1;
    else if (board[cell] === BLUE) piecesBlue += 1;
    else if (board[cell] === RED) piecesRed += 1;
  }
  if (emptyCount === 0) return null;
  let neutralStock = Math.max(0, Math.min(neutralsLeft, emptyCount));

  let hashA = 0;
  let hashB = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    if (board[cell] === EMPTY) continue;
    const z = cell * 3 + board[cell] - 1;
    hashA ^= ZOBRIST_A[z];
    hashB ^= ZOBRIST_B[z];
  }

  const exactWindow = neutralStock > 0 ? EXACT_ENDGAME_EMPTIES_WITH_NEUTRALS : EXACT_ENDGAME_EMPTIES;

  const moveBuffers = [];
  const scoreBuffers = [];
  for (let ply = 0; ply < MAX_PLY; ply += 1) {
    moveBuffers.push(new Int32Array(MAX_MOVES));
    scoreBuffers.push(new Int32Array(MAX_MOVES));
  }

  // Labels every group of `color`, filling groupSizes/groupLibs/cellGroup, and
  // returns the group count.
  function labelGroups(color) {
    seen.fill(0, 0, cells);
    let count = 0;
    for (let start = 0; start < cells; start += 1) {
      if (seen[start] || board[start] !== color) continue;
      const id = count;
      count += 1;
      stampCounter += 1;
      let size = 0;
      let libs = 0;
      let top = 0;
      seen[start] = 1;
      stack[top] = start;
      top += 1;
      while (top > 0) {
        top -= 1;
        const cell = stack[top];
        size += 1;
        cellGroup[cell] = id;
        const around = neighbors[cell];
        for (let i = 0; i < around.length; i += 1) {
          const next = around[i];
          const value = board[next];
          if (value === EMPTY) {
            // Stamp so a cell touching the group twice only counts once.
            if (libStamp[next] !== stampCounter) {
              libStamp[next] = stampCounter;
              libs += 1;
            }
          } else if (value === color && !seen[next]) {
            seen[next] = 1;
            stack[top] = next;
            top += 1;
          }
        }
      }
      groupSizes[id] = size;
      groupLibs[id] = libs;
    }
    return count;
  }

  // True when a single placement of `color` would join the two named groups.
  function mergeableInOne(color, groupA, groupB) {
    for (let cell = 0; cell < cells; cell += 1) {
      if (board[cell] !== EMPTY) continue;
      let touchesA = false;
      let touchesB = false;
      const around = neighbors[cell];
      for (let i = 0; i < around.length; i += 1) {
        const next = around[i];
        if (board[next] !== color) continue;
        const id = cellGroup[next];
        if (id === groupA) touchesA = true;
        else if (id === groupB) touchesB = true;
      }
      if (touchesA && touchesB) return true;
    }
    return false;
  }

  // Size of the largest connected region of empty cells — the room a color
  // with fewer than two groups has to start its second one in.
  function largestEmptyRegion() {
    seen.fill(0, 0, cells);
    let best = 0;
    for (let start = 0; start < cells; start += 1) {
      if (seen[start] || board[start] !== EMPTY) continue;
      let size = 0;
      let top = 0;
      seen[start] = 1;
      stack[top] = start;
      top += 1;
      while (top > 0) {
        top -= 1;
        const cell = stack[top];
        size += 1;
        const around = neighbors[cell];
        for (let i = 0; i < around.length; i += 1) {
          const next = around[i];
          if (!seen[next] && board[next] === EMPTY) {
            seen[next] = 1;
            stack[top] = next;
            top += 1;
          }
        }
      }
      if (size > best) best = size;
    }
    return best;
  }

  // What `color`'s second-largest group is worth, in hundredths of a piece.
  function colorValue(color, openRoom) {
    const count = labelGroups(color);
    for (let id = 0; id < count; id += 1) {
      const libs = groupLibs[id] > LIB_CAP ? LIB_CAP : groupLibs[id];
      pots[id] = groupSizes[id] * SIZE_UNIT + libs * LIB_WEIGHT;
    }
    let potCount = count;
    if (count < 2) {
      // The second group hasn't been started yet; value the space to start it.
      const room = openRoom > SEED_CAP ? SEED_CAP : openRoom;
      pots[potCount] = room * SEED_WEIGHT;
      potCount += 1;
    }
    if (potCount < 2) return 0;

    // Only the top three matter, so a partial selection sort beats a full one.
    for (let i = 0; i < 3 && i < potCount; i += 1) {
      let best = i;
      for (let j = i + 1; j < potCount; j += 1) {
        if (pots[j] > pots[best]) best = j;
      }
      if (best !== i) {
        const swap = pots[i];
        pots[i] = pots[best];
        pots[best] = swap;
      }
    }
    let second = pots[1];
    const third = potCount > 2 ? pots[2] : 0;

    // A top pair one placement away from merging is fragile: the opponent can
    // play your color into the joining cell and drop you to the third group.
    if (count >= 2) {
      let biggest = 0;
      let runnerUp = 1;
      for (let id = 1; id < count; id += 1) {
        if (groupSizes[id] > groupSizes[biggest]) {
          runnerUp = biggest;
          biggest = id;
        } else if (groupSizes[id] > groupSizes[runnerUp]) {
          runnerUp = id;
        }
      }
      if (biggest !== runnerUp && mergeableInOne(color, biggest, runnerUp)) {
        second = Math.round(MERGE_KEEP * second + (1 - MERGE_KEEP) * third);
      }
    }
    return second;
  }

  function evaluate(player) {
    const myPieces = player === BLUE ? piecesBlue : piecesRed;
    const theirPieces = player === BLUE ? piecesRed : piecesBlue;

    if (emptyCount === 0) {
      // Full board: the real result, no heuristic involved.
      const mine = secondLargest(findGroups(board, player));
      const theirs = secondLargest(findGroups(board, player === BLUE ? RED : BLUE));
      if (mine !== theirs) {
        const margin = Math.abs(mine - theirs) * 1000;
        return mine > theirs ? TERMINAL_WIN + margin : -TERMINAL_WIN - margin;
      }
      if (myPieces === theirPieces) return 0; // a real draw, on an even board
      return myPieces < theirPieces ? TERMINAL_WIN : -TERMINAL_WIN;
    }

    const openRoom = largestEmptyRegion();
    const mine = colorValue(player, openRoom);
    const theirs = colorValue(player === BLUE ? RED : BLUE, openRoom);
    return mine - theirs + TIE_WEIGHT * (theirPieces - myPieces);
  }

  function make(cell, color) {
    board[cell] = color;
    if (color === BLUE) piecesBlue += 1;
    else if (color === RED) piecesRed += 1;
    else neutralStock -= 1;
    emptyCount -= 1;
    const z = cell * 3 + color - 1;
    hashA ^= ZOBRIST_A[z];
    hashB ^= ZOBRIST_B[z];
  }

  function unmake(cell, color) {
    const z = cell * 3 + color - 1;
    hashA ^= ZOBRIST_A[z];
    hashB ^= ZOBRIST_B[z];
    board[cell] = EMPTY;
    if (color === BLUE) piecesBlue -= 1;
    else if (color === RED) piecesRed -= 1;
    else neutralStock += 1;
    emptyCount += 1;
  }

  const table = new Map();
  const key = () => hashA * 67108864 + hashB;

  const deadline = Date.now() + timeMs;
  let nodes = 0;
  let aborted = false;
  function outOfTime() {
    if (aborted) return true;
    nodes += 1;
    if ((nodes & 255) === 0 && Date.now() >= deadline) aborted = true;
    return aborted;
  }

  // Fills the ply's buffers with every legal move, scored by the evaluation of
  // the position it leads to, and returns the move count.
  function generate(player, ply) {
    const moves = moveBuffers[ply];
    const scores = scoreBuffers[ply];
    const topColor = neutralStock > 0 ? NEUTRAL : RED;
    let count = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      if (board[cell] !== EMPTY) continue;
      for (let color = BLUE; color <= topColor; color += 1) {
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
      const score = scores[i];
      for (let j = i; j > 0; j -= 1) {
        moves[j] = moves[j - 1];
        scores[j] = scores[j - 1];
      }
      moves[0] = wanted;
      scores[0] = score + INFINITY / 2;
      return;
    }
  }

  function negamax(player, remainingDepth, alphaIn, betaIn, ply) {
    if (emptyCount === 0) return evaluate(player);
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

    const width =
      emptyCount <= exactWindow ? count : Math.min(count, candidateWidth(remainingDepth));
    const opponent = player === BLUE ? RED : BLUE;
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
  // worse move. When the ranking matters every root move gets a full window —
  // an alpha-beta bound is enough to find the best move, but not to order the
  // rest.
  const rankAll = Array.isArray(pickWeights) && pickWeights.length > 0;
  const rootCount = generate(meColor, 0);
  const rootMoves = [];
  for (let i = 0; i < rootCount; i += 1) {
    selectNext(0, i, rootCount);
    rootMoves.push({ move: moveBuffers[0][i], score: scoreBuffers[0][i] });
  }

  const rootWidth = emptyCount <= exactWindow ? rootMoves.length : Math.min(rootMoves.length, 20);
  const rootPool = rootMoves.slice(0, rootWidth);
  let ranked = rootPool.map((entry) => ({ ...entry }));

  const depthCap = Math.min(maxDepth, emptyCount);
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
    const byMove = new Map(results.map((r) => [r.move, r.score]));
    rootPool.sort((a, b) => (byMove.get(b.move) ?? -INFINITY) - (byMove.get(a.move) ?? -INFINITY));
    if (depth >= emptyCount) break; // solved to the end of the game
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
