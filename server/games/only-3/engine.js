// Only 3 — pure rules. A 6x6 grid; each turn a player drops a red, blue or
// purple stone on any empty cell. Purple is neutral and counts for BOTH sides.
//
// Scoring is the whole game: a "triple" is a maximal run of EXACTLY three
// cells that are all your color or purple. Four or more in a row is worth
// nothing, so a run can be killed by extending it — including by the player
// who owns it capping their own line with the opponent's color.
//
// The run/guard formulation used everywhere below: a 3-cell window scores for
// `player` when every window cell is player-or-purple and neither guard (the
// cell just before and just after the window on the same line) is
// player-or-purple. Off-board guards are free. That is exactly "maximal run of
// length 3".

export const SIZE = 6;
export const CELLS = SIZE * SIZE;

export const EMPTY = 0;
export const RED = 1;
export const BLUE = 2;
export const PURPLE = 3;

export const COLOR_NAME = { [RED]: "red", [BLUE]: "blue", [PURPLE]: "purple" };
export const COLOR_ID = { red: RED, blue: BLUE, purple: PURPLE };

// Seat 0 plays red and moves first; seat 1 plays blue.
export const SEAT_COLORS = [RED, BLUE];

const DIRS = [
  [0, 1], // →
  [1, 0], // ↓
  [1, 1], // ↘
  [1, -1] // ↙
];

const index = (row, col) => row * SIZE + col;
const inBounds = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;

// Every 3-cell window on the board, with its (0-2) on-board guard cells.
export const WINDOWS = (() => {
  const windows = [];
  for (const [dr, dc] of DIRS) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        if (!inBounds(row + 2 * dr, col + 2 * dc)) continue;
        const guards = [];
        if (inBounds(row - dr, col - dc)) guards.push(index(row - dr, col - dc));
        if (inBounds(row + 3 * dr, col + 3 * dc)) guards.push(index(row + 3 * dr, col + 3 * dc));
        windows.push({
          cells: [index(row, col), index(row + dr, col + dc), index(row + 2 * dr, col + 2 * dc)],
          guards
        });
      }
    }
  }
  return windows;
})();

// windowsByCell[cell] = every window the cell touches, as a member or a guard.
// Placing a stone can only change those windows' status, which is what makes
// the bot's incremental evaluation cheap.
export const WINDOWS_BY_CELL = (() => {
  const byCell = Array.from({ length: CELLS }, () => []);
  WINDOWS.forEach((window, windowIndex) => {
    window.cells.forEach((cell) => byCell[cell].push(windowIndex));
    window.guards.forEach((cell) => byCell[cell].push(windowIndex));
  });
  return byCell.map((list) => Int32Array.from(list));
})();

export function createBoard() {
  return new Array(CELLS).fill(EMPTY);
}

// How many placements `player` still needs for this window to score, or -1 if
// the window can never score for them again. Empty window cells must become
// player-or-purple; empty guards must become the opponent's color (which the
// player is allowed to place themselves).
export function windowCost(board, window, player) {
  let cost = 0;
  const { cells, guards } = window;
  for (let i = 0; i < 3; i += 1) {
    const value = board[cells[i]];
    if (value === EMPTY) cost += 1;
    else if (value !== player && value !== PURPLE) return -1;
  }
  for (let i = 0; i < guards.length; i += 1) {
    const value = board[guards[i]];
    if (value === player || value === PURPLE) return -1;
    if (value === EMPTY) cost += 1;
  }
  return cost;
}

export function countTriples(board, player) {
  let total = 0;
  for (let i = 0; i < WINDOWS.length; i += 1) {
    if (windowCost(board, WINDOWS[i], player) === 0) total += 1;
  }
  return total;
}

// Scoring windows on the current board, for the client's highlighting. A window
// of three purples scores for both sides, so a cell can appear in two entries.
export function listTriples(board) {
  const triples = [];
  for (let i = 0; i < WINDOWS.length; i += 1) {
    const window = WINDOWS[i];
    for (const player of [RED, BLUE]) {
      if (windowCost(board, window, player) === 0) {
        triples.push({ color: COLOR_NAME[player], cells: [...window.cells] });
      }
    }
  }
  return triples;
}

export function countColor(board, color) {
  let total = 0;
  for (let i = 0; i < CELLS; i += 1) {
    if (board[i] === color) total += 1;
  }
  return total;
}

export function isFull(board) {
  for (let i = 0; i < CELLS; i += 1) {
    if (board[i] === EMPTY) return false;
  }
  return true;
}

// Most triples wins. On a tie the player with FEWER stones of their own color
// on the board wins — so spending your turns on purple and on the opponent's
// color is a live tiebreak strategy. Equal on both counts is a draw.
export function decideWinner(board) {
  const red = countTriples(board, RED);
  const blue = countTriples(board, BLUE);
  const redStones = countColor(board, RED);
  const blueStones = countColor(board, BLUE);
  let winner;
  if (red !== blue) winner = red > blue ? "red" : "blue";
  else if (redStones !== blueStones) winner = redStones < blueStones ? "red" : "blue";
  else winner = "draw";
  return { red, blue, redStones, blueStones, winner };
}
