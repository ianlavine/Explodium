// Flip Triples: swap-and-flip triple-making game on a 5x5, 4x6 or 6x6 board,
// with an optional AI opponent backed by the solver in ./solver.js (via the
// engine facade and a worker thread, see bot-worker.js).
import { Worker } from "worker_threads";
import { shuffle, clampInt } from "../../lib/util.js";
// The difficulty ladder is shared with the browser so the picker cannot drift
// from the budgets the search is actually handed.
import {
  FLIP_BOT_LEVELS as SHARED_BOT_LEVELS,
  FLIP_BOT_DEFAULT_LEVEL
} from "../../../public/games/flip-triples/bot-levels.js";

// `defaultPieces` is the per-player scoring-piece count for a fresh deal; the
// rest of the cells become neutrals (6x6: 14 + 14 + 8 neutral = 36).
const FLIP_BOARD_5X5 = { boardSize: "5x5", cols: 5, rows: 5, cells: 25, centerRow: 2, centerCol: 2, defaultPieces: 9 };
const FLIP_BOARD_4X6 = { boardSize: "4x6", cols: 4, rows: 6, cells: 24, centerRow: null, centerCol: null, defaultPieces: 9 };
const FLIP_BOARD_6X6 = { boardSize: "6x6", cols: 6, rows: 6, cells: 36, centerRow: null, centerCol: null, defaultPieces: 14 };
const FLIP_SCORING_SHAPES = ["red-x", "blue-o", "purple"];
// Group variants: the play is unchanged, but the win condition stops counting
// triples and looks at each color's orthogonally-connected groups instead.
//   most     - number of separate groups
//   biggest  - size of the largest group
//   second   - size of the second largest group (a lone group scores 0)
//   smallest - size of the smallest group (bigger still wins)
//   product  - the two largest groups multiplied (a lone group scores 0)
// All of them tie-break on remaining white pieces, whatever the board.
const FLIP_GROUP_RULES = ["most", "biggest", "second", "smallest", "product"];
// Ring pieces count with neutrals toward a triple for their color's player.
const FLIP_RING_FOR_SHAPE = { "red-x": "red-ring", "blue-o": "blue-ring" };

// The Flip Triples bot always occupies seat index 1; its color (red or blue)
// is decided by the color pick at the start of each game.
const FLIP_BOT_ID = "__flip_bot__";
const FLIP_BOT_INDEX = 1;
const FLIP_BOT_DELAY_MS = 300;
// Difficulty ladder. Every level plays the best move it can find; levels differ
// in how far ahead they are allowed to look. The table lives in
// public/games/flip-triples/bot-levels.js so the picker shows the same numbers
// the search actually gets; see there for why depth beats a clock, and for the
// measurements behind the spacing.
//
// The search runs in a worker thread (bot-worker.js), so a long think does not
// block the event loop. It is one worker handling requests SERIALLY, though, so
// concurrent games queue behind each other — which is why the deepest level
// carries a 10s cap rather than being left to run.
//
// FLIP_BOT_MS overrides the top rung's CAP only (for a slower host, or tests).
const FLIP_BOT_LEVELS = SHARED_BOT_LEVELS.map((level, i) => ({
  maxDepth: level.depth,
  timeMs:
    i === SHARED_BOT_LEVELS.length - 1 && process.env.FLIP_BOT_MS
      ? Number(process.env.FLIP_BOT_MS)
      : level.capMs
}));

function flipBoardPreset(boardSize) {
  if (boardSize === "6x6") return FLIP_BOARD_6X6;
  if (boardSize === "5x5") return FLIP_BOARD_5X5;
  return FLIP_BOARD_4X6;
}

function flipBoardDimsFromBoard(board) {
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  return { rows, cols, cells: rows * cols };
}

function normalizeFlipSettings(options = {}) {
  const boardSize =
    options.boardSize === "5x5" ? "5x5" : options.boardSize === "6x6" ? "6x6" : "4x6";
  const preset = flipBoardPreset(boardSize);
  const maxPlayerPieces = Math.floor(preset.cells / 2);
  let playerPieces = clampInt(
    options.playerPieces,
    0,
    maxPlayerPieces,
    preset.defaultPieces
  );
  let purple = clampInt(options.purple, 0, preset.cells, 0);
  let yellow = clampInt(options.yellow, 0, preset.cells, 0);
  let hopper = clampInt(options.hopper, 0, preset.cells, 0);
  // Ring pieces come as one red + one blue pair; `rings` counts the pairs.
  let rings = clampInt(options.rings, 0, Math.floor(preset.cells / 2), 0);

  // Trim until everything fits on the board, leaving room for at least 0 neutrals.
  const total = () => playerPieces * 2 + purple + yellow + hopper + rings * 2;
  while (total() > preset.cells) {
    if (playerPieces > 0) playerPieces -= 1;
    else if (purple > 0) purple -= 1;
    else if (yellow > 0) yellow -= 1;
    else if (hopper > 0) hopper -= 1;
    else if (rings > 0) rings -= 1;
    else break;
  }

  const neutralPieces = preset.cells - total();
  // Group variants are single-phase: a two-phase score would add each phase's
  // group count on top of the other, which means nothing.
  const groupRule = FLIP_GROUP_RULES.includes(options.groupRule) ? options.groupRule : "none";
  const mode = options.mode === "extended" && groupRule === "none" ? "extended" : "basic";
  const extendedRule = ["none", "ring", "swap"].includes(options.extendedRule)
    ? options.extendedRule
    : "none";
  const uniqueSwap = options.uniqueSwap !== false;
  const staticNeutrals = options.staticNeutrals === true;
  // Only odd boards have a single center cell to protect.
  const protectedMiddle = preset.centerRow == null ? false : options.protectedMiddle === true;
  const doubleMove = options.doubleMove === true;
  // Exact Mode is the default rule set; pass exactMode: false for classic scoring.
  const exactMode = options.exactMode !== false;

  return {
    boardSize,
    boardCols: preset.cols,
    boardRows: preset.rows,
    playerPieces,
    purple,
    yellow,
    hopper,
    rings,
    neutralPieces,
    mode,
    extendedRule: mode === "extended" ? extendedRule : "none",
    uniqueSwap,
    staticNeutrals,
    protectedMiddle,
    doubleMove,
    exactMode,
    groupRule
  };
}

function defaultFlipSettings() {
  return normalizeFlipSettings({});
}

function makeFlipPiece(index, shape) {
  return {
    id: `flip-${index}`,
    shape,
    flipped: false,
    opportunity: false,
    swapped: false,
    // Rings are not protected: they can lead a swap (flip), but only for their
    // own color — that ownership is enforced in flipMoveActors, not here.
    protected: shape === "purple" || shape === "yellow" || shape === "hopper"
  };
}

function createFlipTriplesBoard(settings) {
  const pieces = [];
  let index = 0;
  for (let i = 0; i < settings.playerPieces; i += 1) {
    pieces.push(makeFlipPiece(index++, "red-x"));
    pieces.push(makeFlipPiece(index++, "blue-o"));
  }
  for (let i = 0; i < settings.purple; i += 1) {
    pieces.push(makeFlipPiece(index++, "purple"));
  }
  for (let i = 0; i < settings.yellow; i += 1) {
    pieces.push(makeFlipPiece(index++, "yellow"));
  }
  for (let i = 0; i < settings.hopper; i += 1) {
    pieces.push(makeFlipPiece(index++, "hopper"));
  }
  for (let i = 0; i < settings.rings; i += 1) {
    pieces.push(makeFlipPiece(index++, "red-ring"));
    pieces.push(makeFlipPiece(index++, "blue-ring"));
  }
  for (let i = 0; i < settings.neutralPieces; i += 1) {
    pieces.push(makeFlipPiece(index++, "neutral"));
  }
  const shuffled = shuffle(pieces);
  const { cols, rows } = flipBoardPreset(settings.boardSize);
  const board = [];
  for (let row = 0; row < rows; row += 1) {
    board.push(shuffled.slice(row * cols, (row + 1) * cols));
  }
  return board;
}

const FLIP_SHAPE_NAMES = new Set([
  "red-x",
  "blue-o",
  "neutral",
  "purple",
  "yellow",
  "hopper",
  "red-ring",
  "blue-ring"
]);

// A starting deal supplied by the client (from a saved game file) instead of a
// fresh shuffle. Returns rows of shape names when the payload fits the board
// preset, or null — a null falls back to a random deal.
function normalizeFlipStartShapes(startShapes, boardSize) {
  if (!Array.isArray(startShapes)) return null;
  const preset = flipBoardPreset(boardSize);
  if (startShapes.length !== preset.rows) return null;
  const rows = [];
  for (const row of startShapes) {
    if (!Array.isArray(row) || row.length !== preset.cols) return null;
    for (const shape of row) {
      if (!FLIP_SHAPE_NAMES.has(shape)) return null;
    }
    rows.push(row.slice());
  }
  return rows;
}

function flipBoardFromShapes(shapes) {
  let index = 0;
  return shapes.map((row) => row.map((shape) => makeFlipPiece(index++, shape)));
}

// Piece counts implied by a loaded deal, so state.settings keeps describing the
// board that is actually in play (a rematch re-shuffles from these counts).
function flipSettingsForShapes(shapes, options) {
  const counts = {};
  shapes.forEach((row) => row.forEach((shape) => {
    counts[shape] = (counts[shape] ?? 0) + 1;
  }));
  return normalizeFlipSettings({
    ...options,
    playerPieces: Math.min(counts["red-x"] ?? 0, counts["blue-o"] ?? 0),
    purple: counts.purple ?? 0,
    yellow: counts.yellow ?? 0,
    hopper: counts.hopper ?? 0,
    rings: Math.min(counts["red-ring"] ?? 0, counts["blue-ring"] ?? 0)
  });
}

// A seat->color map replayed from a saved game; null unless it is a real
// red/blue pair.
function normalizeFlipSeatColors(seatColors) {
  if (!Array.isArray(seatColors) || seatColors.length !== 2) return null;
  const [a, b] = seatColors;
  const valid = (c) => c === "red" || c === "blue";
  if (!valid(a) || !valid(b) || a === b) return null;
  return [a, b];
}

function flipSeatIndex(value, fallback) {
  return value === 0 || value === 1 ? value : fallback;
}

function createFlipTriplesState() {
  return {
    setup: true,
    settings: defaultFlipSettings(),
    board: [],
    // Shapes of the deal as it was dealt (rows of shape names), kept so a
    // finished game can be exported and re-analyzed from its starting position.
    startShapes: null,
    phase: 1,
    // Color-pick pre-game: player one (colorPicker seat) chooses a color, then
    // player two (firstMover seat) makes the opening move. seatColors maps seat
    // index -> "red"/"blue".
    pickingColor: false,
    colorPicker: null,
    firstMover: null,
    seatColors: null,
    // Double move: each seat may spend one "double" to take two moves in a row.
    doubleUsed: [false, false],
    doublePending: null,
    pendingPhase2: false,
    phaseScores: {
      phase1: { red: 0, blue: 0 },
      phase2: { red: 0, blue: 0 },
      bonus: { red: 0, blue: 0 }
    },
    scores: { red: 0, blue: 0 },
    gameOver: false,
    lastMove: null,
    moveId: 0,
    transitionId: 0
  };
}

function isSelectableFlipPiece(piece, phase) {
  if (!piece) return false;
  return phase === 1 ? !piece.flipped : piece.flipped;
}

function flipRingForShape(shape) {
  return shape === "red-x" ? "red-ring" : shape === "blue-o" ? "blue-ring" : null;
}

function flipRingColor(shape) {
  return shape === "red-ring" ? "red" : shape === "blue-ring" ? "blue" : null;
}

// Whether a whole 3-cell line scores a triple for `shape` (a real color). A line
// scores in one of two disjoint ways:
//   - Standard: every cell is that color or a purple/yellow wildcard.
//   - Ring: every cell is a plain neutral or that color's ring, and the line
//     contains at least one such ring. Rings only bind neutrals to neutrals —
//     they never connect a shaped/wildcard piece to neutrals.
function flipLineMatchesShape(cells, board, shape) {
  const ring = flipRingForShape(shape);
  const pieces = cells.map(([row, col]) => board[row][col]);
  if (pieces.some((p) => !p)) return false;
  const standard = pieces.every(
    (p) => p.shape === shape || p.shape === "purple" || p.shape === "yellow"
  );
  if (standard) return true;
  const ringOnly = pieces.every((p) => p.shape === "neutral" || p.shape === ring);
  const hasRing = pieces.some((p) => p.shape === ring);
  return ringOnly && hasRing;
}

// Exact Mode: a triple only scores when the run is exactly three long. A 3-cell
// line whose run continues into a 4th matching cell on either side is part of a
// longer run and scores nothing at all — so four/five/six in a row are worth 0
// instead of 2/3/4. Rings and wildcards extend a run the same way they form one.
function flipLineIsExactRun(cells, board, shape) {
  const [r0, c0] = cells[0];
  const dr = cells[1][0] - r0;
  const dc = cells[1][1] - c0;
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  const inBounds = ([r, c]) => r >= 0 && r < rows && c >= 0 && c < cols;
  const before = [r0 - dr, c0 - dc];
  const after = [r0 + dr * 3, c0 + dc * 3];
  if (inBounds(before) && flipLineMatchesShape([before, ...cells], board, shape)) return false;
  if (inBounds(after) && flipLineMatchesShape([...cells, after], board, shape)) return false;
  return true;
}

// Seats able to perform a swap of (first -> flips, second -> slides). A ring can
// only be flipped (led first) by the seat holding its color; it can be the
// sliding (second) piece for either seat.
function flipMoveActors(first, second, seatColors) {
  let actors = [0, 1];
  const firstRing = flipRingColor(first.shape);
  if (firstRing) {
    actors = actors.filter((seat) => seatColors && seatColors[seat] === firstRing);
  }
  return actors;
}

// Distance rule: a swap is allowed if the two pieces are adjacent, or if the
// second (slider) piece is a hopper, which can swap with any swappable piece.
function flipSwapReachable(first, second, fromRow, fromCol, toRow, toCol) {
  if (second.shape === "hopper") return true;
  const dist = Math.max(Math.abs(fromRow - toRow), Math.abs(fromCol - toCol));
  return dist === 1;
}

// Unique Swap: the two pieces must have different shapes. Static Neutrals: a
// neutral must flip (first), never slide (second) — so two neutrals can't swap.
// Protected Middle: the flipping piece can't land on the center cell.
function flipSwapPairAllowed(first, second, settings = {}, toRow = null, toCol = null) {
  if (settings.uniqueSwap === true && first.shape === second.shape) return false;
  if (settings.staticNeutrals === true && second.shape === "neutral") return false;
  const preset = flipBoardPreset(settings.boardSize);
  if (
    settings.protectedMiddle === true &&
    preset.centerRow != null &&
    toRow === preset.centerRow &&
    toCol === preset.centerCol
  ) {
    return false;
  }
  return true;
}

function flipMoveExists(board, phase, allowedPlayers, settings = {}, seatColors = null) {
  const { rows, cols } = flipBoardDimsFromBoard(board);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const first = board[row][col];
      if (!isSelectableFlipPiece(first, phase)) continue;
      if (first.protected) continue; // protected pieces can never be the first (flipping) piece
      for (let r2 = 0; r2 < rows; r2 += 1) {
        for (let c2 = 0; c2 < cols; c2 += 1) {
          if (r2 === row && c2 === col) continue;
          const second = board[r2][c2];
          if (!isSelectableFlipPiece(second, phase)) continue;
          if (!flipSwapPairAllowed(first, second, settings, r2, c2)) continue;
          if (!flipSwapReachable(first, second, row, col, r2, c2)) continue;
          const actors = flipMoveActors(first, second, seatColors);
          if (actors.some((p) => allowedPlayers.includes(p))) return true;
        }
      }
    }
  }
  return false;
}

function anyFlipMove(state) {
  return flipMoveExists(state.board, state.phase, [0, 1], state.settings ?? {}, state.seatColors);
}

function playerHasFlipMove(state, playerIndex) {
  return flipMoveExists(state.board, state.phase, [playerIndex], state.settings ?? {}, state.seatColors);
}

function getFlipTriples(board, shape, exactMode = false) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];
  const { rows, cols } = flipBoardDimsFromBoard(board);
  const triples = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      directions.forEach(([dr, dc]) => {
        const cells = [0, 1, 2].map((offset) => [row + dr * offset, col + dc * offset]);
        const inBounds = cells.every(
          ([r, c]) => r >= 0 && r < rows && c >= 0 && c < cols
        );
        if (!inBounds) return;
        if (!flipLineMatchesShape(cells, board, shape)) return;
        if (exactMode && !flipLineIsExactRun(cells, board, shape)) return;
        triples.push(cells);
      });
    }
  }
  return triples;
}

// Net triple score: a triple through a yellow piece counts -1 instead of +1.
function countFlipTriples(board, shape, exactMode = false) {
  let score = 0;
  getFlipTriples(board, shape, exactMode).forEach((triple) => {
    const hasYellow = triple.some(([row, col]) => board[row][col].shape === "yellow");
    score += hasYellow ? -1 : 1;
  });
  return score;
}

// Sizes of a color's orthogonally-connected groups, largest first. Purple is a
// wildcard here exactly as it is in a triple: it belongs to both colors, so it
// can join up red groups and blue groups at the same time. Every other shape
// (neutral, yellow, rings, hoppers) is inert and blocks connection.
function flipGroupSizes(board, shape) {
  const { rows, cols } = flipBoardDimsFromBoard(board);
  const mine = (r, c) => {
    const s = board[r]?.[c]?.shape;
    return s === shape || s === "purple";
  };
  const seen = new Set();
  const sizes = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const key = row * cols + col;
      if (seen.has(key) || !mine(row, col)) continue;
      let size = 0;
      const stack = [key];
      seen.add(key);
      while (stack.length) {
        const cur = stack.pop();
        const r = Math.floor(cur / cols);
        const c = cur % cols;
        size += 1;
        [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].forEach(([nr, nc]) => {
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return;
          const nk = nr * cols + nc;
          if (seen.has(nk) || !mine(nr, nc)) return;
          seen.add(nk);
          stack.push(nk);
        });
      }
      sizes.push(size);
    }
  }
  sizes.sort((a, b) => b - a);
  return sizes;
}

function flipGroupScore(sizes, rule) {
  switch (rule) {
    case "most":
      return sizes.length;
    case "biggest":
      return sizes.length ? sizes[0] : 0;
    case "second":
      return sizes[1] ?? 0;
    case "smallest":
      return sizes.length ? sizes[sizes.length - 1] : 0;
    case "product":
      return (sizes[0] ?? 0) * (sizes[1] ?? 0);
    default:
      return 0;
  }
}

function getFlipGroupScores(board, rule) {
  return {
    red: flipGroupScore(flipGroupSizes(board, "red-x"), rule),
    blue: flipGroupScore(flipGroupSizes(board, "blue-o"), rule)
  };
}

function getFlipTriplesScores(board, settings = {}) {
  const rule = settings.groupRule ?? "none";
  if (FLIP_GROUP_RULES.includes(rule)) return getFlipGroupScores(board, rule);
  const exactMode = settings.exactMode === true;
  return {
    red: countFlipTriples(board, "red-x", exactMode),
    blue: countFlipTriples(board, "blue-o", exactMode)
  };
}

function markFlipTriplesOpportunities(board) {
  board.forEach((row) => {
    row.forEach((piece) => {
      piece.opportunity = !piece.flipped && FLIP_SCORING_SHAPES.includes(piece.shape);
    });
  });
}

function applyFlipSwapTransition(board) {
  board.forEach((row) => {
    row.forEach((piece) => {
      if (piece.flipped) return;
      if (piece.shape === "red-x" || piece.shape === "blue-o") {
        piece.shape = piece.shape === "red-x" ? "blue-o" : "red-x";
        piece.swapped = true;
      }
    });
  });
}

function countFlipTriplesOpportunityBonus(board, shape, exactMode = false) {
  const usedOpportunityIds = new Set();
  getFlipTriples(board, shape, exactMode).forEach((triple) => {
    triple.forEach(([row, col]) => {
      const piece = board[row][col];
      if (piece.opportunity) usedOpportunityIds.add(piece.id);
    });
  });
  return usedOpportunityIds.size;
}

// Group scores describe the board as it stands, so they are live: every move
// refreshes the running total. (Triple scores stay hidden until a phase ends.)
function refreshFlipLiveScores(state) {
  const rule = state.settings?.groupRule ?? "none";
  if (!FLIP_GROUP_RULES.includes(rule)) return;
  state.phaseScores.phase1 = getFlipGroupScores(state.board, rule);
  refreshFlipTriplesTotals(state);
}

function refreshFlipTriplesTotals(state) {
  state.scores = {
    red: state.phaseScores.phase1.red + state.phaseScores.phase2.red + state.phaseScores.bonus.red,
    blue: state.phaseScores.phase1.blue + state.phaseScores.phase2.blue + state.phaseScores.bonus.blue
  };
}

function countFlipRemainingWhitePieces(board, shape) {
  let count = 0;
  board.forEach((row) => {
    row.forEach((piece) => {
      if (piece && piece.shape === shape && !piece.flipped) count += 1;
    });
  });
  return count;
}

// Tie-breaker: the triple game on 5×5 uses the center cell (occupant loses).
// Everything else — the center-less boards (4×6, 6×6), and every group variant
// on any board — uses remaining unflipped player pieces: more white X's or O's
// wins; equal counts stay tied.
function computeFlipWinner(state) {
  const { red, blue } = state.scores;
  if (red > blue) return "red";
  if (blue > red) return "blue";
  const preset = flipBoardPreset(state.settings?.boardSize);
  // Every group variant tie-breaks on white pieces, including on the boards
  // that have a center cell for the triple game to use.
  const groupGame = FLIP_GROUP_RULES.includes(state.settings?.groupRule ?? "none");
  if (groupGame || preset.centerRow == null) {
    const redWhite = countFlipRemainingWhitePieces(state.board, "red-x");
    const blueWhite = countFlipRemainingWhitePieces(state.board, "blue-o");
    if (redWhite > blueWhite) return "red";
    if (blueWhite > redWhite) return "blue";
    return "tie";
  }
  const center = state.board?.[preset.centerRow]?.[preset.centerCol];
  let controller = null;
  if (center) {
    if (center.shape === "red-x") controller = "red";
    else if (center.shape === "blue-o") controller = "blue";
  }
  if (controller === "red") return "blue";
  if (controller === "blue") return "red";
  return "tie";
}

// Does the given color have a legal move that increases its own triple count?
// Used to decide whether the bot should spend its double move this turn. Scans
// the same move space as flipMoveExists, temporarily applying each candidate.
function flipColorHasScoringMove(state, color) {
  const board = state.board;
  const { rows, cols } = flipBoardDimsFromBoard(board);
  const phase = state.phase;
  const settings = state.settings ?? {};
  const seatColors = state.seatColors;
  const seat = seatColors ? seatColors.indexOf(color) : -1;
  if (seat < 0) return false;
  const shape = color === "red" ? "red-x" : "blue-o";
  const exactMode = settings.exactMode === true;
  const groupRule = settings.groupRule ?? "none";
  const useGroups = FLIP_GROUP_RULES.includes(groupRule);
  const scoreNow = () =>
    useGroups
      ? flipGroupScore(flipGroupSizes(board, shape), groupRule)
      : countFlipTriples(board, shape, exactMode);
  const before = scoreNow();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const first = board[row][col];
      if (!isSelectableFlipPiece(first, phase) || first.protected) continue;
      for (let r2 = 0; r2 < rows; r2 += 1) {
        for (let c2 = 0; c2 < cols; c2 += 1) {
          if (r2 === row && c2 === col) continue;
          const second = board[r2][c2];
          if (!isSelectableFlipPiece(second, phase)) continue;
          if (!flipSwapPairAllowed(first, second, settings, r2, c2)) continue;
          if (!flipSwapReachable(first, second, row, col, r2, c2)) continue;
          const actors = flipMoveActors(first, second, seatColors);
          if (!actors.includes(seat)) continue;
          const savedTo = board[r2][c2];
          const savedFrom = board[row][col];
          board[r2][c2] = { ...first, flipped: phase === 1 };
          board[row][col] = second;
          const after = scoreNow();
          board[r2][c2] = savedTo;
          board[row][col] = savedFrom;
          if (after > before) return true;
        }
      }
    }
  }
  return false;
}

export function createFlipTriplesGame({ io, rooms }) {
  function emitState(roomId, room) {
    const playerCount = new Set(room.players).size;
    const readyCount = room.phase2Ready ? room.phase2Ready.size : 0;
    io.to(roomId).emit("state_update", {
      flipTriples: {
        ...room.flipTriples,
        phase2ReadyCount: readyCount,
        playerCount,
        undoBy: room.flipUndo ? room.flipUndo.by : null
      },
      turn: room.turn
    });
  }

  function finalizeFlipTriples(room) {
    const state = room.flipTriples;
    if (state.phase === 2) {
      state.phaseScores.phase2 = getFlipTriplesScores(state.board, state.settings);
      if (state.settings.extendedRule === "ring") {
        const exactMode = state.settings.exactMode === true;
        state.phaseScores.bonus = {
          red: countFlipTriplesOpportunityBonus(state.board, "red-x", exactMode),
          blue: countFlipTriplesOpportunityBonus(state.board, "blue-o", exactMode)
        };
      }
    }
    refreshFlipTriplesTotals(state);
    state.winner = computeFlipWinner(state);
    state.gameOver = true;
  }

  // Called when the active phase has no remaining moves for either player.
  function advanceFlipPhaseOrEnd(room) {
    const state = room.flipTriples;
    if (state.phase === 1) {
      state.phaseScores.phase1 = getFlipTriplesScores(state.board, state.settings);
      refreshFlipTriplesTotals(state);
      if (state.settings.mode === "basic") {
        finalizeFlipTriples(room);
        return;
      }
      state.pendingPhase2 = true;
      room.phase2Ready = new Set();
      return;
    }
    finalizeFlipTriples(room);
  }

  function setInitialFlipTurn(room) {
    const state = room.flipTriples;
    const players = room.players;
    if (players[0] === players[1]) {
      room.turn = players[0];
      return;
    }
    if (playerHasFlipMove(state, 0)) room.turn = players[0];
    else if (playerHasFlipMove(state, 1)) room.turn = players[1];
    else room.turn = players[0];
  }

  // After a move, advance phase if stuck, otherwise pick the next mover (skipping a
  // player who has no available move so the other can keep going).
  function settleFlipTurn(room, actingSocketId) {
    const state = room.flipTriples;
    if (!anyFlipMove(state)) {
      advanceFlipPhaseOrEnd(room);
      return;
    }
    const players = room.players;
    const actorIndex = players.indexOf(actingSocketId);
    // Double move: the actor gets a second consecutive move. Consume the pending
    // double and keep the turn if the actor can still move.
    if (state.doublePending === actorIndex && actorIndex >= 0) {
      state.doublePending = null;
      if (playerHasFlipMove(state, actorIndex)) {
        room.turn = players[actorIndex];
        return;
      }
    }
    if (players[0] === players[1]) {
      room.turn = players[0];
      return;
    }
    const otherIndex = 1 - actorIndex;
    room.turn = playerHasFlipMove(state, otherIndex) ? players[otherIndex] : players[actorIndex];
  }

  function startFlipPhase2(room) {
    const state = room.flipTriples;
    if (state.settings.extendedRule === "ring") {
      markFlipTriplesOpportunities(state.board);
    } else if (state.settings.extendedRule === "swap") {
      applyFlipSwapTransition(state.board);
    }
    state.pendingPhase2 = false;
    room.phase2Ready = new Set();
    room.flipUndo = null;
    state.phase = 2;
    state.lastMove = null;
    state.transitionId += 1;
    if (!anyFlipMove(state)) {
      finalizeFlipTriples(room);
      return;
    }
    setInitialFlipTurn(room);
  }

  function startFlipTriplesGame(room, options) {
    // A saved game can supply its exact opening deal (and the color assignment
    // it was played with); anything else falls back to a fresh shuffle.
    const loadedShapes = normalizeFlipStartShapes(options.startShapes, options.boardSize);
    const settings = loadedShapes
      ? flipSettingsForShapes(loadedShapes, options)
      : normalizeFlipSettings(options);
    const state = room.flipTriples;
    state.setup = false;
    state.settings = settings;
    state.board = loadedShapes ? flipBoardFromShapes(loadedShapes) : createFlipTriplesBoard(settings);
    state.startShapes = state.board.map((row) => row.map((piece) => piece.shape));
    state.phase = 1;
    state.pendingPhase2 = false;
    state.phaseScores = {
      phase1: { red: 0, blue: 0 },
      phase2: { red: 0, blue: 0 },
      bonus: { red: 0, blue: 0 }
    };
    state.scores = { red: 0, blue: 0 };
    state.gameOver = false;
    state.lastMove = null;
    state.moveId = 0;
    state.transitionId = 0;
    state.winner = null;
    state.doubleUsed = [false, false];
    state.doublePending = null;
    room.phase2Ready = new Set();
    room.flipUndo = null;
    refreshFlipLiveScores(state);

    const solo = room.players[0] === room.players[1];
    if (solo) {
      // Solo play has no separate color pick: seat 0 is blue, seat 1 is red, and
      // the single human drives both sides.
      state.pickingColor = false;
      state.colorPicker = null;
      state.firstMover = null;
      state.seatColors = ["blue", "red"];
      setInitialFlipTurn(room);
      if (!anyFlipMove(state)) advanceFlipPhaseOrEnd(room);
      return;
    }

    // A loaded game replays its recorded color assignment, so there is no pick.
    const loadedColors = normalizeFlipSeatColors(options.seatColors);
    if (loadedColors) {
      state.pickingColor = false;
      state.colorPicker = flipSeatIndex(options.colorPicker, 0);
      state.firstMover = flipSeatIndex(options.firstMover, 1 - state.colorPicker);
      state.seatColors = loadedColors;
      beginFlipPlay(room);
      return;
    }

    // Online / vs AI: randomly choose which seat picks the color (player one)
    // and which seat makes the opening move (player two). Play is gated until a
    // color is chosen.
    state.pickingColor = true;
    state.colorPicker = Math.random() < 0.5 ? 0 : 1;
    state.firstMover = 1 - state.colorPicker;
    state.seatColors = null;
    room.turn = null;
  }

  // Colors are settled: hand the opening move to the first mover (skipping a
  // seat with no legal move) and start the game.
  function beginFlipPlay(room) {
    const state = room.flipTriples;
    const fm = state.firstMover;
    if (playerHasFlipMove(state, fm)) room.turn = room.players[fm];
    else if (playerHasFlipMove(state, 1 - fm)) room.turn = room.players[1 - fm];
    else room.turn = room.players[fm];
    if (!anyFlipMove(state)) advanceFlipPhaseOrEnd(room);
  }

  // Player one has chosen a color; assign colors, hand the opening move to
  // player two, and begin play.
  function finalizeColorPick(room, pickerColor) {
    const state = room.flipTriples;
    const color = pickerColor === "red" ? "red" : "blue";
    const other = color === "red" ? "blue" : "red";
    const seatColors = [null, null];
    seatColors[state.colorPicker] = color;
    seatColors[state.firstMover] = other;
    state.seatColors = seatColors;
    state.pickingColor = false;
    beginFlipPlay(room);
  }

  // Applies a validated swap to the live state. The first piece flips (locks) and
  // slides into the second piece's cell; the second piece takes the first's old
  // cell. `recordUndo` is true for human moves so the move can be rewound; the bot
  // passes false so the human keeps the ability to undo their own move (and the
  // bot's automatic reply).
  function performFlipSwap(room, actorId, from, to, recordUndo) {
    const state = room.flipTriples;
    const board = state.board;
    const first = board[from.row][from.col];
    const second = board[to.row][to.col];
    if (!first || !second) return;

    if (recordUndo) {
      room.flipUndo = {
        by: actorId,
        turn: room.turn,
        snapshot: JSON.parse(JSON.stringify(state))
      };
    }

    const prevFlipped = first.flipped;
    board[to.row][to.col] = { ...first, flipped: state.phase === 1 };
    board[from.row][from.col] = second;
    state.lastMove = {
      from: { row: from.row, col: from.col },
      to: { row: to.row, col: to.col },
      prevFlipped
    };
    state.moveId += 1;
    refreshFlipLiveScores(state);
    settleFlipTurn(room, actorId);
  }

  // The bot's move choice lives in solver.js, and runs inside a worker thread
  // so a long think (top level: 10s) never blocks the event loop. Replies carry
  // a per-room sequence number; a restart or undo bumps it so any in-flight
  // result for the old position is dropped on arrival.
  //
  // The worker handles requests SERIALLY, so a redundant request is not free —
  // it costs a full think before the real one is even read. Several paths can
  // legitimately want the bot to move at nearly the same moment (room created,
  // game started, colour picked), and they used to queue three searches for one
  // move: 30s of thinking to make a 10s move. `botPending` collapses that to a
  // single in-flight search per room, and `botRerun` remembers that the
  // position moved on underneath it so the answer is recomputed once, rather
  // than N times up front.
  const botWorker = new Worker(new URL("./bot-worker.js", import.meta.url));
  botWorker.on("error", (err) => console.error("bot worker crashed:", err));
  botWorker.on("message", ({ seq, roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples" || !room.isBot) return;
    room.botPending = false;
    const stale = room.botSeq !== seq;
    const rerun = room.botRerun;
    room.botRerun = false;
    const state = room.flipTriples;
    // A search whose position changed under it tells us nothing — but the bot
    // may still owe a move, so ask again rather than stalling the game.
    if (stale || rerun) {
      if (state && !state.setup && !state.gameOver && room.turn === FLIP_BOT_ID) {
        scheduleFlipBot(roomId);
      }
      return;
    }
    if (!state || state.setup || state.gameOver || state.pendingPhase2) return;
    if (room.turn !== FLIP_BOT_ID || !move) return;
    performFlipSwap(room, FLIP_BOT_ID, move.from, move.to, false);
    emitState(roomId, room);
    if (!state.gameOver && !state.pendingPhase2) {
      io.to(roomId).emit("turn_update", { turn: room.turn });
    }
    if (state.pendingPhase2 || room.turn === FLIP_BOT_ID) scheduleFlipBot(roomId);
  });

  // Any in-flight bot search no longer matches the room's position.
  function invalidateBotSearch(room) {
    room.botSeq = (room.botSeq || 0) + 1;
    if (room.botPending) room.botRerun = true;
  }

  // Drives the bot: readies it for phase 2 automatically and requests a move
  // from the worker whenever it is the bot's turn.
  function runFlipBot(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples" || !room.isBot) return;
    const state = room.flipTriples;
    if (!state || state.setup || state.gameOver) return;

    // Color pick: if the bot is player one, it chooses a color at random and
    // hands the opening move to player two.
    if (state.pickingColor) {
      if (state.colorPicker === FLIP_BOT_INDEX) {
        finalizeColorPick(room, Math.random() < 0.5 ? "red" : "blue");
        emitState(roomId, room);
        if (!state.gameOver && !state.pendingPhase2) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        if (room.turn === FLIP_BOT_ID) scheduleFlipBot(roomId);
      }
      return;
    }

    if (state.pendingPhase2) {
      if (!room.phase2Ready) room.phase2Ready = new Set();
      if (!room.phase2Ready.has(FLIP_BOT_ID)) {
        room.phase2Ready.add(FLIP_BOT_ID);
        const uniquePlayers = new Set(room.players).size;
        if (room.phase2Ready.size >= uniquePlayers) {
          startFlipPhase2(room);
          emitState(roomId, room);
          if (!state.pendingPhase2 && !state.gameOver) {
            io.to(roomId).emit("turn_update", { turn: room.turn });
          }
          scheduleFlipBot(roomId);
        } else {
          emitState(roomId, room);
        }
      }
      return;
    }

    if (room.turn !== FLIP_BOT_ID) return;
    // The bot's color is decided by the color pick; the solver's player index is
    // in color space (1 = red, 0 = blue), which also fixes ring ownership.
    const botColor = state.seatColors?.[FLIP_BOT_INDEX] === "red" ? "red" : "blue";
    const botColorIndex = botColor === "red" ? 1 : 0;

    // Spend the bot's double move when it currently has a scoring move.
    if (
      state.settings.doubleMove &&
      !state.doubleUsed[FLIP_BOT_INDEX] &&
      state.doublePending == null &&
      flipColorHasScoringMove(state, botColor)
    ) {
      state.doubleUsed[FLIP_BOT_INDEX] = true;
      state.doublePending = FLIP_BOT_INDEX;
      emitState(roomId, room);
    }

    // One search in flight per room. A second request would sit behind the
    // first in the worker's serial queue and cost a whole extra think.
    if (room.botPending) return;

    const level = FLIP_BOT_LEVELS[room.botLevel] ?? FLIP_BOT_LEVELS[FLIP_BOT_DEFAULT_LEVEL];
    invalidateBotSearch(room);
    room.botPending = true;
    room.botRerun = false;
    botWorker.postMessage({
      seq: room.botSeq,
      roomId,
      gameState: {
        board: state.board,
        phase: state.phase,
        settings: state.settings,
        phaseScores: state.phaseScores
      },
      playerIndex: botColorIndex,
      timeMs: level.timeMs,
      maxDepth: level.maxDepth
    });
  }

  // Coalesce timers too: several handlers can each decide the bot should move
  // now, and without this they each get their own timer and their own search.
  function scheduleFlipBot(roomId) {
    const room = rooms.get(roomId);
    if (room) {
      if (room.botTimer) return;
      room.botTimer = setTimeout(() => {
        room.botTimer = null;
        runFlipBot(roomId);
      }, FLIP_BOT_DELAY_MS);
      return;
    }
    setTimeout(() => runFlipBot(roomId), FLIP_BOT_DELAY_MS);
  }

  return {
    id: "flip-triples",

    createRoomState() {
      return {
        flipTriples: createFlipTriplesState(),
        phase2Ready: new Set(),
        flipUndo: null
      };
    },

    emitState,

    bot: {
      id: FLIP_BOT_ID,
      // Comes straight off a socket, so coerce and range-check rather than
      // indexing the array with it — "length" would otherwise pass as a level.
      normalizeLevel(level) {
        const i = Number(level);
        return Number.isInteger(i) && i >= 0 && i < FLIP_BOT_LEVELS.length
          ? i
          : FLIP_BOT_DEFAULT_LEVEL;
      },
      onRoomCreated(roomId) {
        scheduleFlipBot(roomId);
      }
    },

    registerHandlers(socket) {
      socket.on("flip_triples_start", ({ roomId, options } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "flip-triples") return;
        // Allowed from setup, or as a rematch once the game is over.
        if (!room.flipTriples.setup && !room.flipTriples.gameOver) return;
        if (!room.players.includes(socket.id)) return;
        // Either player may start; whoever presses first locks in their chosen settings.
        invalidateBotSearch(room);
        startFlipTriplesGame(room, options || {});
        emitState(roomId, room);
        if (
          !room.flipTriples.gameOver &&
          !room.flipTriples.pendingPhase2 &&
          !room.flipTriples.pickingColor
        ) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        if (room.isBot) scheduleFlipBot(roomId);
      });

      socket.on("flip_triples_pick_color", ({ roomId, color } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "flip-triples") return;
        const state = room.flipTriples;
        if (!state.pickingColor) return;
        if (!room.players.includes(socket.id)) return;
        // Only player one (the color picker seat) may choose.
        if (room.players.indexOf(socket.id) !== state.colorPicker) return;
        if (color !== "red" && color !== "blue") return;
        invalidateBotSearch(room);
        finalizeColorPick(room, color);
        emitState(roomId, room);
        if (!state.gameOver && !state.pendingPhase2) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        if (room.isBot && room.turn === FLIP_BOT_ID) scheduleFlipBot(roomId);
      });

      socket.on("flip_triples_double", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "flip-triples") return;
        const state = room.flipTriples;
        if (state.setup || state.pickingColor || state.pendingPhase2 || state.gameOver) return;
        if (!state.settings.doubleMove) return;
        if (room.players[0] === room.players[1]) return; // no double in solo play
        if (room.turn !== socket.id) return;
        const seat = room.players.indexOf(socket.id);
        if (seat < 0 || state.doubleUsed[seat] || state.doublePending != null) return;
        state.doubleUsed[seat] = true;
        state.doublePending = seat;
        // Activating a double is a commitment: drop any pending undo.
        room.flipUndo = null;
        invalidateBotSearch(room);
        emitState(roomId, room);
      });

      socket.on("flip_triples_undo", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "flip-triples") return;
        if (!room.flipUndo || room.flipUndo.by !== socket.id) return;
        room.flipTriples = room.flipUndo.snapshot;
        room.turn = room.flipUndo.turn;
        room.flipUndo = null;
        invalidateBotSearch(room);
        room.phase2Ready = new Set();
        emitState(roomId, room);
        if (!room.flipTriples.gameOver && !room.flipTriples.pendingPhase2) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        if (room.isBot && room.turn === FLIP_BOT_ID) scheduleFlipBot(roomId);
      });

      socket.on("flip_triples_ready", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "flip-triples") return;
        const state = room.flipTriples;
        if (!state.pendingPhase2) return;
        if (!room.players.includes(socket.id)) return;
        if (!room.phase2Ready) room.phase2Ready = new Set();
        room.phase2Ready.add(socket.id);
        const uniquePlayers = new Set(room.players).size;
        if (room.phase2Ready.size >= uniquePlayers) {
          startFlipPhase2(room);
        }
        emitState(roomId, room);
        if (!state.pendingPhase2 && !state.gameOver) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        if (room.isBot) scheduleFlipBot(roomId);
      });

      socket.on("flip_triples_swap", ({ roomId, from, to } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "flip-triples") return;
        const state = room.flipTriples;
        if (state.setup || state.pickingColor || state.pendingPhase2 || state.gameOver) return;
        if (room.turn !== socket.id) return;
        const { rows, cols } = flipBoardDimsFromBoard(state.board);
        const isCoordinate = (point) =>
          point &&
          Number.isInteger(point.row) &&
          Number.isInteger(point.col) &&
          point.row >= 0 &&
          point.row < rows &&
          point.col >= 0 &&
          point.col < cols;
        if (!isCoordinate(from) || !isCoordinate(to)) return;

        const board = state.board;
        const first = board[from.row][from.col]; // the piece that flips
        const second = board[to.row][to.col]; // the slider
        if (!first || !second) return;
        if (!isSelectableFlipPiece(first, state.phase)) return;
        if (!isSelectableFlipPiece(second, state.phase)) return;
        if (first.protected) return; // protected pieces must be selected second
        if (!flipSwapPairAllowed(first, second, state.settings ?? {}, to.row, to.col)) return;

        const dist = Math.max(Math.abs(from.row - to.row), Math.abs(from.col - to.col));
        if (dist === 0) return;
        // Adjacent swaps are always allowed; a hopper (second) can swap with any piece.
        if (dist !== 1 && second.shape !== "hopper") return;

        // Ring ownership: a ring can only be flipped (led first) by the seat that
        // holds its color. In solo play the one human drives both seats.
        const isSolo = room.players[0] === room.players[1];
        const allowed = isSolo ? [0, 1] : [room.players.indexOf(socket.id)];
        const actors = flipMoveActors(first, second, state.seatColors);
        if (!actors.some((p) => allowed.includes(p))) return;

        // Snapshot the pre-move state so this move can be undone until the other
        // player moves (which replaces the snapshot with their own). Against the bot
        // the reply does not record its own snapshot, so this lets the human undo
        // their move together with the bot's automatic response.
        performFlipSwap(room, socket.id, from, to, true);

        emitState(roomId, room);
        if (!state.gameOver && !state.pendingPhase2) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        if (room.isBot) scheduleFlipBot(roomId);
      });
    }
  };
}
