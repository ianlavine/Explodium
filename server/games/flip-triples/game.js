// Flip Triples: swap-and-flip triple-making game on a 5x5 or 4x6 board,
// with an optional AI opponent backed by the solver in ./solver.js (via the
// engine facade and a worker thread, see bot-worker.js).
import { Worker } from "worker_threads";
import { shuffle, clampInt } from "../../lib/util.js";

const FLIP_TRIPLES_DEFAULT_PLAYER_PIECES = 9;
const FLIP_BOARD_5X5 = { boardSize: "5x5", cols: 5, rows: 5, cells: 25, centerRow: 2, centerCol: 2 };
const FLIP_BOARD_4X6 = { boardSize: "4x6", cols: 4, rows: 6, cells: 24, centerRow: null, centerCol: null };
const FLIP_SCORING_SHAPES = ["red-x", "blue-o", "purple"];
// Ring pieces count with neutrals toward a triple for their color's player.
const FLIP_RING_FOR_SHAPE = { "red-x": "red-ring", "blue-o": "blue-ring" };

// The Flip Triples bot always occupies seat index 1; its color (red or blue)
// is decided by the color pick at the start of each game.
const FLIP_BOT_ID = "__flip_bot__";
const FLIP_BOT_INDEX = 1;
const FLIP_BOT_DELAY_MS = 300;
// Difficulty levels: search budget per move (runs synchronously, so keep it
// short enough not to stall the event loop) plus deliberate blunders —
// pickWeights are the probabilities of playing the 1st/2nd/3rd/... ranked
// move. The engine is strong even at tiny budgets, so the lower levels lean
// on blunders to stay beatable: Baby bot (0) plays its best move only 15% of
// the time; God bot (4) always plays its best move on a long think.
const FLIP_BOT_LEVELS = {
  0: { timeMs: 15, pickWeights: [0.15, 0.25, 0.25, 0.2, 0.15] },
  1: { timeMs: 60, pickWeights: [0.5, 0.25, 0.15, 0.1] },
  2: { timeMs: 200, pickWeights: [0.75, 0.17, 0.08] },
  3: { timeMs: 800, pickWeights: null },
  4: { timeMs: Number(process.env.FLIP_BOT_MS || 4500), pickWeights: null }
};
const FLIP_BOT_DEFAULT_LEVEL = 3;

function flipBoardPreset(boardSize) {
  return boardSize === "4x6" ? FLIP_BOARD_4X6 : FLIP_BOARD_5X5;
}

function flipBoardDimsFromBoard(board) {
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  return { rows, cols, cells: rows * cols };
}

function normalizeFlipSettings(options = {}) {
  const boardSize = options.boardSize === "5x5" ? "5x5" : "4x6";
  const preset = flipBoardPreset(boardSize);
  const maxPlayerPieces = Math.floor(preset.cells / 2);
  let playerPieces = clampInt(
    options.playerPieces,
    0,
    maxPlayerPieces,
    FLIP_TRIPLES_DEFAULT_PLAYER_PIECES
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
  const mode = options.mode === "extended" ? "extended" : "basic";
  const extendedRule = ["none", "ring", "swap"].includes(options.extendedRule)
    ? options.extendedRule
    : "none";
  const uniqueSwap = options.uniqueSwap !== false;
  const staticNeutrals = options.staticNeutrals === true;
  const protectedMiddle = boardSize === "4x6" ? false : options.protectedMiddle === true;
  const doubleMove = options.doubleMove === true;

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
    doubleMove
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

function createFlipTriplesState() {
  return {
    setup: true,
    settings: defaultFlipSettings(),
    board: [],
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

function getFlipTriples(board, shape) {
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
        if (flipLineMatchesShape(cells, board, shape)) triples.push(cells);
      });
    }
  }
  return triples;
}

// Net triple score: a triple through a yellow piece counts -1 instead of +1.
function countFlipTriples(board, shape) {
  let score = 0;
  getFlipTriples(board, shape).forEach((triple) => {
    const hasYellow = triple.some(([row, col]) => board[row][col].shape === "yellow");
    score += hasYellow ? -1 : 1;
  });
  return score;
}

function getFlipTriplesScores(board) {
  return {
    red: countFlipTriples(board, "red-x"),
    blue: countFlipTriples(board, "blue-o")
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

function countFlipTriplesOpportunityBonus(board, shape) {
  const usedOpportunityIds = new Set();
  getFlipTriples(board, shape).forEach((triple) => {
    triple.forEach(([row, col]) => {
      const piece = board[row][col];
      if (piece.opportunity) usedOpportunityIds.add(piece.id);
    });
  });
  return usedOpportunityIds.size;
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

// Tie-breaker: 5×5 uses the center cell (occupant loses). 4×6 uses remaining
// unflipped player pieces — more white X's or O's wins; equal counts stay tied.
function computeFlipWinner(state) {
  const { red, blue } = state.scores;
  if (red > blue) return "red";
  if (blue > red) return "blue";
  const preset = flipBoardPreset(state.settings?.boardSize);
  if (preset.centerRow == null) {
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
  const before = countFlipTriples(board, shape);
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
          const after = countFlipTriples(board, shape);
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
      state.phaseScores.phase2 = getFlipTriplesScores(state.board);
      if (state.settings.extendedRule === "ring") {
        state.phaseScores.bonus = {
          red: countFlipTriplesOpportunityBonus(state.board, "red-x"),
          blue: countFlipTriplesOpportunityBonus(state.board, "blue-o")
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
      state.phaseScores.phase1 = getFlipTriplesScores(state.board);
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
    const settings = normalizeFlipSettings(options);
    const state = room.flipTriples;
    state.setup = false;
    state.settings = settings;
    state.board = createFlipTriplesBoard(settings);
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

    // Online / vs AI: randomly choose which seat picks the color (player one)
    // and which seat makes the opening move (player two). Play is gated until a
    // color is chosen.
    state.pickingColor = true;
    state.colorPicker = Math.random() < 0.5 ? 0 : 1;
    state.firstMover = 1 - state.colorPicker;
    state.seatColors = null;
    room.turn = null;
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

    const fm = state.firstMover;
    if (playerHasFlipMove(state, fm)) room.turn = room.players[fm];
    else if (playerHasFlipMove(state, 1 - fm)) room.turn = room.players[1 - fm];
    else room.turn = room.players[fm];
    if (!anyFlipMove(state)) advanceFlipPhaseOrEnd(room);
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
    settleFlipTurn(room, actorId);
  }

  // The bot's move choice lives in solver.js, and runs inside a worker
  // thread so a long think (God bot: 4.5s) never blocks the event loop. Replies
  // carry a per-room sequence number; a restart or undo bumps it so any
  // in-flight result for the old position is dropped on arrival.
  const botWorker = new Worker(new URL("./bot-worker.js", import.meta.url));
  botWorker.on("error", (err) => console.error("bot worker crashed:", err));
  botWorker.on("message", ({ seq, roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples" || !room.isBot) return;
    if (room.botSeq !== seq) return; // stale: position changed since requested
    const state = room.flipTriples;
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

    const level = FLIP_BOT_LEVELS[room.botLevel] ?? FLIP_BOT_LEVELS[FLIP_BOT_DEFAULT_LEVEL];
    invalidateBotSearch(room);
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
      pickWeights: level.pickWeights
    });
  }

  function scheduleFlipBot(roomId) {
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
      normalizeLevel(level) {
        return FLIP_BOT_LEVELS[level] ? level : FLIP_BOT_DEFAULT_LEVEL;
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
