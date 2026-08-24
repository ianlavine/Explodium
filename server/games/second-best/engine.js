// Second Best — pure rules. A 5x5 or 6x6 grid; each turn a player drops a blue
// or a red piece on any empty cell, and either player may place either color.
// The board fills up and that ends the game.
//
// Your score is the size of your SECOND-largest orthogonally connected group
// of your own color. One giant blob is worth nothing, so the game is about
// keeping two substantial groups apart — and about welding the opponent's two
// groups together by placing THEIR color in the cell that joins them.
//
// NEUTRALS (black) belong to nobody. They score for neither side and they cut
// connectivity, so they exist purely to block. Two table settings govern them:
//   seededNeutrals   - dropped on random cells before the first move
//   playableNeutrals - a SHARED stock either player may spend a turn from,
//                      first come first served, until it runs out
// The two are independent: seeded neutrals do not come out of the playable
// stock, so the most black a board can ever hold is the sum of both.
//
// Two readings the rules don't spell out, fixed here:
//  * Fewer than two groups scores 0 (a single blob has no second group).
//  * Ties for largest count normally: groups of 5, 5 and 2 score 5.
//
// The tiebreak is "fewer of your own pieces on the board wins". On a 5x5 with
// no neutrals the two counts sum to 25 and so can never be equal — that board
// has no draws. Any even number of colored placements (a 6x6, or a 5x5 whose
// neutrals flip the parity) puts draws back on the table, and the rules give
// nothing to break them with, so `decideWinner` can return "draw".

export const MIN_SIZE = 5;
export const MAX_SIZE = 6;
export const DEFAULT_SIZE = 6;

export const EMPTY = 0;
export const BLUE = 1;
export const RED = 2;
export const NEUTRAL = 3;

export const COLOR_NAME = { [BLUE]: "blue", [RED]: "red", [NEUTRAL]: "neutral" };
export const COLOR_ID = { blue: BLUE, red: RED, neutral: NEUTRAL };

// Seat 0 plays blue and moves first; seat 1 plays red. The color a seat "is"
// only decides whose groups score for them — both seats may place either color,
// and either may spend from the neutral stock.
export const SEAT_COLORS = [BLUE, RED];

// Board geometry, built once per size. Everything downstream reads the
// neighbour table from here rather than recomputing row/col arithmetic.
const geometries = new Map();

export function geometry(size) {
  const clamped = size === MAX_SIZE ? MAX_SIZE : MIN_SIZE;
  let geo = geometries.get(clamped);
  if (geo) return geo;
  const cells = clamped * clamped;
  const neighbors = [];
  for (let row = 0; row < clamped; row += 1) {
    for (let col = 0; col < clamped; col += 1) {
      const list = [];
      if (row > 0) list.push((row - 1) * clamped + col);
      if (row < clamped - 1) list.push((row + 1) * clamped + col);
      if (col > 0) list.push(row * clamped + col - 1);
      if (col < clamped - 1) list.push(row * clamped + col + 1);
      neighbors.push(Int32Array.from(list));
    }
  }
  geo = { size: clamped, cells, neighbors };
  geometries.set(clamped, geo);
  return geo;
}

// A board carries its own size in its length, so nothing has to thread the
// setting through every call.
export const geometryFor = (board) => geometry(Math.round(Math.sqrt(board.length)));

// Neutrals are capped at a third of the board each; past that there is barely a
// game left to play.
export const maxNeutrals = (size) => Math.floor(geometry(size).cells / 3);

export function normalizeSettings(raw) {
  const size = Number(raw?.size) === MAX_SIZE ? MAX_SIZE : Number(raw?.size) === MIN_SIZE ? MIN_SIZE : DEFAULT_SIZE;
  const cap = maxNeutrals(size);
  const clamp = (value) => {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 0) return 0;
    return number > cap ? cap : number;
  };
  return {
    size,
    seededNeutrals: clamp(raw?.seededNeutrals),
    playableNeutrals: clamp(raw?.playableNeutrals)
  };
}

export function createBoard(size = DEFAULT_SIZE) {
  return new Array(geometry(size).cells).fill(EMPTY);
}

// Drops `count` neutrals on random empty cells. Called once, before the first
// move, so both seats face the same obstacles.
export function seedNeutrals(board, count) {
  const empties = [];
  for (let cell = 0; cell < board.length; cell += 1) {
    if (board[cell] === EMPTY) empties.push(cell);
  }
  const wanted = Math.min(count, empties.length);
  for (let i = 0; i < wanted; i += 1) {
    const pick = i + Math.floor(Math.random() * (empties.length - i));
    const cell = empties[pick];
    empties[pick] = empties[i];
    board[cell] = NEUTRAL;
  }
  return board;
}

// Every group of `color`, ranked largest first. Same-size groups are ordered by
// their lowest cell so the ranking (and therefore which group the client draws
// as "the scoring one") is stable between renders.
export function findGroups(board, color) {
  const { cells, neighbors } = geometryFor(board);
  const seen = new Uint8Array(cells);
  const groups = [];
  const stack = [];
  for (let start = 0; start < cells; start += 1) {
    if (seen[start] || board[start] !== color) continue;
    const group = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop();
      group.push(cell);
      const around = neighbors[cell];
      for (let i = 0; i < around.length; i += 1) {
        const next = around[i];
        if (!seen[next] && board[next] === color) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    group.sort((a, b) => a - b);
    groups.push({ size: group.length, cells: group });
  }
  groups.sort((a, b) => b.size - a.size || a.cells[0] - b.cells[0]);
  return groups;
}

export const secondLargest = (groups) => (groups.length >= 2 ? groups[1].size : 0);

export function scoreFor(board, color) {
  return secondLargest(findGroups(board, color));
}

export function countColor(board, color) {
  let total = 0;
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === color) total += 1;
  }
  return total;
}

export function isFull(board) {
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === EMPTY) return false;
  }
  return true;
}

// Bigger second-largest group wins; on a tie, fewer own pieces wins. Neutrals
// count for neither, so on a board where the colored placements come out even
// both tests can tie and the game is drawn.
export function decideWinner(board) {
  const blueGroups = findGroups(board, BLUE);
  const redGroups = findGroups(board, RED);
  const blue = secondLargest(blueGroups);
  const red = secondLargest(redGroups);
  const bluePieces = countColor(board, BLUE);
  const redPieces = countColor(board, RED);
  let winner;
  if (blue !== red) winner = blue > red ? "blue" : "red";
  else if (bluePieces !== redPieces) winner = bluePieces < redPieces ? "blue" : "red";
  else winner = "draw";
  return {
    blue,
    red,
    bluePieces,
    redPieces,
    neutralPieces: countColor(board, NEUTRAL),
    blueGroups,
    redGroups,
    winner
  };
}
