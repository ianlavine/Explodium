import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { chooseSolverMove } from "./flip-solver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/lobby", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/game", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const queueByGame = new Map(); // queueKey -> [socketId]
const rooms = new Map(); // roomId -> { gameId, players, turn, board, hands }
const BOARD_SIZE = 14;
const TILE_TYPES = 5;
const TILES_PER_TYPE = 4;
const squareType = 1;
const diamondType = 0;
const circleType = 2;
const extensionType = 3;
const destroyType = 4;
const maxRangeSquare = 3;
const maxRangeDiamond = 3;
const maxRangeCircle = 2;
const TOY_BATTLE_TYPES = ["Kwak", "Skully", "Cap'n", "Jumbo", "Hook", "XB-42", "Star", "Roxy"];
const FLIP_TRIPLES_DEFAULT_PLAYER_PIECES = 9;
const FLIP_BOARD_5X5 = { boardSize: "5x5", cols: 5, rows: 5, cells: 25, centerRow: 2, centerCol: 2 };
const FLIP_BOARD_4X6 = { boardSize: "4x6", cols: 4, rows: 6, cells: 24, centerRow: null, centerCol: null };
const FLIP_SCORING_SHAPES = ["red-x", "blue-o", "purple"];

// The Flip Triples bot always plays as X (red) and always goes second, so it
// occupies player index 1 while the human opponent (O / blue) takes index 0.
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

function getTile(cell) {
  if (!cell || typeof cell !== "object") return null;
  if ("player" in cell && "type" in cell) return cell;
  return cell.tile ?? null;
}

function getMarkers(cell) {
  if (!cell || typeof cell !== "object") return [];
  if ("markers" in cell && Array.isArray(cell.markers)) return cell.markers;
  return [];
}

function normalizeCell(board, r, c) {
  const cell = board[r][c];
  const existingTile = getTile(cell);
  if (!cell || typeof cell !== "object" || !("markers" in cell)) {
    board[r][c] = { tile: existingTile ?? null, markers: [] };
  } else if (!("tile" in cell)) {
    cell.tile = existingTile ?? null;
  }
  return board[r][c];
}

function recomputeMarkers(room) {
  const tiles = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const cell = normalizeCell(room.board, r, c);
      const tile = getTile(cell);
      if (tile) {
        if (typeof tile.placedAt !== "number") {
          room.moveIndex += 1;
          tile.placedAt = room.moveIndex;
        }
        tile.rangeBoost = 1;
        tiles.push({ r, c, tile });
      }
      cell.markers = [];
    }
  }

  tiles.sort((a, b) => a.tile.placedAt - b.tile.placedAt);

  const normalizeMarkers = (markers) =>
    markers.map((marker) => (typeof marker === "number" ? { player: marker, filled: false } : marker));
  const hasBlockingNormal = (pathCells) =>
    pathCells.some(([r, c]) => {
      const cell = room.board[r][c];
      const tile = getTile(cell);
      if (tile) return true;
      const markers = normalizeMarkers(getMarkers(cell));
      return markers.length > 0;
    });
  const hasBlockingFilled = (pathCells) =>
    pathCells.some(([r, c]) => {
      const tile = getTile(room.board[r][c]);
      if (tile) return true;
      const markers = normalizeMarkers(getMarkers(room.board[r][c]));
      return markers.length > 0;
    });
  const markCell = (r, c, player, filled = false) => {
    const cell = normalizeCell(room.board, r, c);
    const markers = normalizeMarkers(getMarkers(cell));
    const existing = markers.find((marker) => marker.player === player);
    if (existing) {
      if (filled) existing.filled = true;
    } else {
      markers.push({ player, filled });
    }
    cell.markers = markers;
  };

  for (let i = 0; i < tiles.length; i += 1) {
    const newEntry = tiles[i];
    const newTile = newEntry.tile;
    const currentNew = getTile(room.board[newEntry.r][newEntry.c]);
    if (!currentNew || currentNew.placedAt !== newTile.placedAt) continue;
    for (let j = 0; j < i; j += 1) {
      const travelerEntry = tiles[j];
      const traveler = travelerEntry.tile;
      const currentTraveler = getTile(room.board[travelerEntry.r][travelerEntry.c]);
      if (!currentTraveler || currentTraveler.placedAt !== traveler.placedAt) continue;
      if (traveler.player !== newTile.player) continue;
      if (traveler.type === destroyType || traveler.type === extensionType) continue;

      const dr = newEntry.r - travelerEntry.r;
      const dc = newEntry.c - travelerEntry.c;
      if (dr === 0 && dc === 0) continue;

      const rangeBoost = traveler.rangeBoost ?? 1;
      if (traveler.type === squareType) {
        const sameRow = dr === 0;
        const sameCol = dc === 0;
        const distance = sameRow ? Math.abs(dc) : sameCol ? Math.abs(dr) : null;
        if (distance === null || distance > maxRangeSquare * rangeBoost) continue;
        const stepR = sameRow ? 0 : dr > 0 ? 1 : -1;
        const stepC = sameCol ? 0 : dc > 0 ? 1 : -1;
        const path = [];
        let rr = travelerEntry.r + stepR;
        let cc = travelerEntry.c + stepC;
        while (rr !== newEntry.r || cc !== newEntry.c) {
          path.push([rr, cc]);
          rr += stepR;
          cc += stepC;
        }
        if (!path.length) {
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
          continue;
        }
        if (newTile.type === destroyType) {
          path.forEach(([r, c]) => {
            const cell = normalizeCell(room.board, r, c);
            const tile = getTile(cell);
            if (tile && tile.player !== newTile.player) {
              cell.tile = null;
            } else if (tile) {
              return;
            }
            const markers = normalizeMarkers(getMarkers(cell)).filter(
              (marker) => marker.player === newTile.player
            );
            cell.markers = markers;
            markCell(r, c, newTile.player, true);
          });
        } else {
          if (hasBlockingNormal(path)) continue;
          path.forEach(([r, c]) => {
            if (!getTile(room.board[r][c])) markCell(r, c, newTile.player);
          });
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
        }
      } else if (traveler.type === diamondType) {
        if (Math.abs(dr) !== Math.abs(dc)) continue;
        if (Math.abs(dr) > maxRangeDiamond * rangeBoost) continue;
        const stepR = dr > 0 ? 1 : -1;
        const stepC = dc > 0 ? 1 : -1;
        const path = [];
        let rr = travelerEntry.r + stepR;
        let cc = travelerEntry.c + stepC;
        while (rr !== newEntry.r || cc !== newEntry.c) {
          path.push([rr, cc]);
          rr += stepR;
          cc += stepC;
        }
        if (!path.length) {
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
          continue;
        }
        if (newTile.type === destroyType) {
          path.forEach(([r, c]) => {
            const cell = normalizeCell(room.board, r, c);
            const tile = getTile(cell);
            if (tile && tile.player !== newTile.player) {
              cell.tile = null;
            } else if (tile) {
              return;
            }
            const markers = normalizeMarkers(getMarkers(cell)).filter(
              (marker) => marker.player === newTile.player
            );
            cell.markers = markers;
            markCell(r, c, newTile.player, true);
          });
        } else {
          if (hasBlockingNormal(path)) continue;
          path.forEach(([r, c]) => {
            if (!getTile(room.board[r][c])) markCell(r, c, newTile.player);
          });
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
        }
      } else if (traveler.type === circleType) {
        const isOrth = dr === 0 || dc === 0;
        const isDiag = Math.abs(dr) === Math.abs(dc);
        if (!isOrth && !isDiag) continue;
        const distance = Math.max(Math.abs(dr), Math.abs(dc));
        if (distance > maxRangeCircle * rangeBoost) continue;
        const stepR = dr === 0 ? 0 : dr > 0 ? 1 : -1;
        const stepC = dc === 0 ? 0 : dc > 0 ? 1 : -1;
        const path = [];
        let rr = travelerEntry.r + stepR;
        let cc = travelerEntry.c + stepC;
        while (rr !== newEntry.r || cc !== newEntry.c) {
          path.push([rr, cc]);
          rr += stepR;
          cc += stepC;
        }
        if (!path.length) {
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
          continue;
        }
        if (newTile.type === destroyType) {
          path.forEach(([r, c]) => {
            const cell = normalizeCell(room.board, r, c);
            const tile = getTile(cell);
            if (tile && tile.player !== newTile.player) {
              cell.tile = null;
            } else if (tile) {
              return;
            }
            const markers = normalizeMarkers(getMarkers(cell)).filter(
              (marker) => marker.player === newTile.player
            );
            cell.markers = markers;
            markCell(r, c, newTile.player, true);
          });
        } else {
          if (hasBlockingNormal(path)) continue;
          path.forEach(([r, c]) => {
            if (!getTile(room.board[r][c])) markCell(r, c, newTile.player);
          });
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
        }
      }
    }
  }
}

function normalizeGameOptions(gameId, options = {}) {
  return {};
}

function getQueueKey(gameId) {
  return gameId;
}

function getQueue(gameId) {
  const queueKey = getQueueKey(gameId);
  if (!queueByGame.has(queueKey)) {
    queueByGame.set(queueKey, []);
  }
  return queueByGame.get(queueKey);
}

function shuffle(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function createToyBattleDeck() {
  return shuffle(
    TOY_BATTLE_TYPES.flatMap((name) =>
      Array.from({ length: 3 }, (_, copy) => ({
        id: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${copy}`,
        name
      }))
    )
  );
}

function createToyBattleBoard() {
  const nodes = [];
  const nodeByPosition = new Map();
  const addNode = (row, col, base = null) => {
    const key = `${row}-${col}`;
    if (nodeByPosition.has(key)) return nodeByPosition.get(key);
    const node = {
      id: `n-${row}-${col}`,
      row,
      col,
      base,
      piece: null
    };
    nodes.push(node);
    nodeByPosition.set(key, node);
    return node;
  };

  addNode(0, 4, "blue");
  addNode(6, 4, "red");
  for (let row = 1; row <= 5; row += 1) {
    addNode(row, 4);
    for (let col = 0; col <= 8; col += 1) {
      if (col === 4) continue;
      if (Math.random() < 0.42) addNode(row, col);
    }
  }

  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (a, b) => {
    if (!a || !b || a.id === b.id) return;
    const key = [a.id, b.id].sort().join(":");
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from: a.id, to: b.id });
  };

  for (let row = 0; row < 6; row += 1) {
    addEdge(nodeByPosition.get(`${row}-4`), nodeByPosition.get(`${row + 1}-4`));
  }

  nodes.forEach((node) => {
    nodes.forEach((other) => {
      const rowGap = Math.abs(node.row - other.row);
      const colGap = Math.abs(node.col - other.col);
      if (rowGap + colGap === 0) return;
      if (rowGap <= 1 && colGap <= 2 && rowGap + colGap <= 2 && Math.random() < 0.5) {
        addEdge(node, other);
      }
    });
  });

  return { nodes, edges };
}

function createToyBattleState() {
  const deck = createToyBattleDeck();
  return {
    ...createToyBattleBoard(),
    deck,
    rack: deck.splice(0, 3)
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
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
  let hopper = clampInt(options.hopper, 0, preset.cells, 0);
  let blocker = clampInt(options.blocker, 0, preset.cells, 0);
  blocker -= blocker % 2; // blockers come in equal pairs per player

  // Trim until everything fits on the board, leaving room for at least 0 neutrals.
  const total = () => playerPieces * 2 + purple + hopper + blocker;
  while (total() > preset.cells) {
    if (playerPieces > 0) playerPieces -= 1;
    else if (purple > 0) purple -= 1;
    else if (hopper > 0) hopper -= 1;
    else if (blocker >= 2) blocker -= 2;
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

  return {
    boardSize,
    boardCols: preset.cols,
    boardRows: preset.rows,
    playerPieces,
    purple,
    hopper,
    blocker,
    neutralPieces,
    mode,
    extendedRule: mode === "extended" ? extendedRule : "none",
    uniqueSwap,
    staticNeutrals,
    protectedMiddle
  };
}

function defaultFlipSettings() {
  return normalizeFlipSettings({});
}

function makeFlipPiece(index, shape, owner = null) {
  return {
    id: `flip-${index}`,
    shape,
    flipped: false,
    opportunity: false,
    swapped: false,
    protected: shape === "purple" || shape === "hopper",
    owner: shape === "blocker" ? owner : null
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
  for (let i = 0; i < settings.hopper; i += 1) {
    pieces.push(makeFlipPiece(index++, "hopper"));
  }
  for (let i = 0; i < settings.blocker; i += 1) {
    pieces.push(makeFlipPiece(index++, "blocker", i < settings.blocker / 2 ? 0 : 1));
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

function flipPieceMatchesShape(piece, shape) {
  if (!piece) return false;
  if (piece.shape === "purple") return shape === "red-x" || shape === "blue-o";
  return piece.shape === shape;
}

// Players able to perform a swap of (first -> flips, second -> slides), before geometry.
function flipMoveActors(first, second) {
  let actors = [0, 1];
  if (first.shape === "blocker") actors = actors.filter((p) => p === first.owner);
  if (second.shape === "blocker") actors = actors.filter((p) => p === second.owner);
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

function flipMoveExists(board, phase, allowedPlayers, settings = {}) {
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
          const actors = flipMoveActors(first, second);
          if (actors.some((p) => allowedPlayers.includes(p))) return true;
        }
      }
    }
  }
  return false;
}

function anyFlipMove(state) {
  return flipMoveExists(state.board, state.phase, [0, 1], state.settings ?? {});
}

function playerHasFlipMove(state, playerIndex) {
  return flipMoveExists(state.board, state.phase, [playerIndex], state.settings ?? {});
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
        if (cells.every(([r, c]) => flipPieceMatchesShape(board[r][c], shape))) triples.push(cells);
      });
    }
  }
  return triples;
}

function countFlipTriples(board, shape) {
  return getFlipTriples(board, shape).length;
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
    else if (center.shape === "blocker") controller = center.owner === 0 ? "red" : "blue";
  }
  if (controller === "red") return "blue";
  if (controller === "blue") return "red";
  return "tie";
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
  if (players[0] === players[1]) {
    room.turn = players[0];
    return;
  }
  const actorIndex = players.indexOf(actingSocketId);
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
  room.phase2Ready = new Set();
  room.flipUndo = null;
  setInitialFlipTurn(room);
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

// The bot's move choice lives in flip-solver.js: an iterative-deepening
// alpha-beta search that solves the game exactly once the remaining tree fits
// in its time budget, and plays the deepest completed search before that.

// Drives the bot: readies it for phase 2 automatically and plays its move(s)
// whenever it is the bot's turn. Re-schedules itself for back-to-back bot turns.
function runFlipBot(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.gameId !== "flip-triples" || !room.isBot) return;
  const state = room.flipTriples;
  if (!state || state.setup || state.gameOver) return;

  if (state.pendingPhase2) {
    if (!room.phase2Ready) room.phase2Ready = new Set();
    if (!room.phase2Ready.has(FLIP_BOT_ID)) {
      room.phase2Ready.add(FLIP_BOT_ID);
      const uniquePlayers = new Set(room.players).size;
      if (room.phase2Ready.size >= uniquePlayers) {
        startFlipPhase2(room);
        emitFlipTriplesState(roomId, room);
        if (!state.pendingPhase2 && !state.gameOver) {
          io.to(roomId).emit("turn_update", { turn: room.turn });
        }
        scheduleFlipBot(roomId);
      } else {
        emitFlipTriplesState(roomId, room);
      }
    }
    return;
  }

  if (room.turn !== FLIP_BOT_ID) return;
  const level = FLIP_BOT_LEVELS[room.botLevel] ?? FLIP_BOT_LEVELS[FLIP_BOT_DEFAULT_LEVEL];
  const move = chooseSolverMove(state, FLIP_BOT_INDEX, {
    timeMs: level.timeMs,
    pickWeights: level.pickWeights
  });
  if (!move) return;
  performFlipSwap(room, FLIP_BOT_ID, move.from, move.to, false);
  emitFlipTriplesState(roomId, room);
  if (!state.gameOver && !state.pendingPhase2) {
    io.to(roomId).emit("turn_update", { turn: room.turn });
  }
  if (state.pendingPhase2 || room.turn === FLIP_BOT_ID) scheduleFlipBot(roomId);
}

function scheduleFlipBot(roomId) {
  setTimeout(() => runFlipBot(roomId), FLIP_BOT_DELAY_MS);
}

function emitToyBattleState(roomId, room) {
  io.to(roomId).emit("state_update", {
    toyBattle: {
      nodes: room.toyBattle.nodes,
      edges: room.toyBattle.edges,
      rack: room.toyBattle.rack,
      deckCount: room.toyBattle.deck.length
    },
    turn: room.turn
  });
}

function emitFlipTriplesState(roomId, room) {
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

function createRoom(gameId, playerA, playerB, options = {}) {
  const roomId = `room-${gameId}-${playerA}-${playerB}`;
  const gameOptions = normalizeGameOptions(gameId, options);
  if (gameId === "toy-battle") {
    rooms.set(roomId, {
      gameId,
      players: [playerA, playerB],
      turn: playerA,
      toyBattle: createToyBattleState()
    });
    return roomId;
  }
  if (gameId === "flip-triples") {
    rooms.set(roomId, {
      gameId,
      players: [playerA, playerB],
      turn: playerA,
      flipTriples: createFlipTriplesState(),
      phase2Ready: new Set(),
      flipUndo: null
    });
    return roomId;
  }

  const board = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => ({ tile: null, markers: [] }))
  );
  const hands = Array.from({ length: 2 }, () =>
    Array.from({ length: TILE_TYPES }, () => TILES_PER_TYPE)
  );
  rooms.set(roomId, {
    gameId,
    players: [playerA, playerB],
    turn: playerA,
    board,
    hands,
    moveIndex: 0
  });
  return roomId;
}

function cleanupSocket(socketId) {
  for (const queue of queueByGame.values()) {
    const queueIndex = queue.indexOf(socketId);
    if (queueIndex !== -1) {
      queue.splice(queueIndex, 1);
    }
  }

  for (const [roomId, room] of rooms.entries()) {
    if (room.players.includes(socketId)) {
      room.players.forEach((id) => {
        if (id !== socketId) {
          io.to(id).emit("opponent_left");
        }
      });
      rooms.delete(roomId);
      break;
    }
  }
}

io.on("connection", (socket) => {
  socket.on("start_solo", ({ gameId = "default", options = {} } = {}) => {
    const roomId = createRoom(gameId, socket.id, socket.id, options);
    io.sockets.sockets.get(socket.id)?.join(roomId);
    const room = rooms.get(roomId);
    io.to(socket.id).emit("match_found", {
      roomId,
      gameId,
      players: [socket.id, socket.id],
      turn: room.turn,
      playerIndex: 0
    });
    if (room.gameId === "toy-battle") {
      emitToyBattleState(roomId, room);
    } else if (room.gameId === "flip-triples") {
      emitFlipTriplesState(roomId, room);
    } else {
      io.to(roomId).emit("state_update", {
        board: room.board,
        hands: room.hands,
        turn: room.turn
      });
    }
  });

  // Single-player vs. the AI. Only Flip Triples ships a bot, so other games fall
  // back to a normal solo (the human controls both sides).
  socket.on("start_bot", ({ gameId = "default", options = {}, botLevel } = {}) => {
    const botSupported = gameId === "flip-triples";
    const opponentId = botSupported ? FLIP_BOT_ID : socket.id;
    const roomId = createRoom(gameId, socket.id, opponentId, options);
    io.sockets.sockets.get(socket.id)?.join(roomId);
    const room = rooms.get(roomId);
    room.isBot = botSupported;
    room.botLevel = FLIP_BOT_LEVELS[botLevel] ? botLevel : FLIP_BOT_DEFAULT_LEVEL;
    io.to(socket.id).emit("match_found", {
      roomId,
      gameId,
      players: [socket.id, opponentId],
      turn: room.turn,
      playerIndex: 0
    });
    if (room.gameId === "toy-battle") {
      emitToyBattleState(roomId, room);
    } else if (room.gameId === "flip-triples") {
      emitFlipTriplesState(roomId, room);
      if (room.isBot) scheduleFlipBot(roomId);
    } else {
      io.to(roomId).emit("state_update", {
        board: room.board,
        hands: room.hands,
        turn: room.turn
      });
    }
  });

  socket.on("join_queue", ({ gameId = "default", options = {} } = {}) => {
    const gameOptions = normalizeGameOptions(gameId, options);
    const queue = getQueue(gameId, gameOptions);
    if (queue.includes(socket.id)) return;
    queue.push(socket.id);

    if (queue.length >= 2) {
      const playerA = queue.shift();
      const playerB = queue.shift();
      const roomId = createRoom(gameId, playerA, playerB, gameOptions);

      io.sockets.sockets.get(playerA)?.join(roomId);
      io.sockets.sockets.get(playerB)?.join(roomId);

      const room = rooms.get(roomId);
      io.to(playerA).emit("match_found", {
        roomId,
        gameId,
        players: [playerA, playerB],
        turn: room.turn,
        playerIndex: 0
      });
      io.to(playerB).emit("match_found", {
        roomId,
        gameId,
        players: [playerA, playerB],
        turn: room.turn,
        playerIndex: 1
      });
      if (room.gameId === "toy-battle") {
        emitToyBattleState(roomId, room);
      } else if (room.gameId === "flip-triples") {
        emitFlipTriplesState(roomId, room);
      } else {
        io.to(roomId).emit("state_update", {
          board: room.board,
          hands: room.hands,
          turn: room.turn
        });
      }
    }
  });

  socket.on("leave_queue", ({ gameId = "default", options = {} } = {}) => {
    const queue = getQueue(gameId, options);
    const index = queue.indexOf(socket.id);
    if (index !== -1) queue.splice(index, 1);
  });

  socket.on("leave_room", ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (!room.players.includes(socket.id)) return;
    room.players.forEach((id) => {
      if (id !== socket.id) {
        io.to(id).emit("opponent_left");
      }
    });
    rooms.delete(roomId);
  });

  socket.on("place_tile", ({ roomId, row, col, type }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.gameId === "toy-battle" || room.gameId === "flip-triples") return;
    if (room.turn !== socket.id) return;
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
    if (type < 0 || type >= TILE_TYPES) return;

    const playerIndex = room.players.indexOf(socket.id);
    if (playerIndex === -1) return;
    if (room.hands[playerIndex][type] <= 0) return;
    const existingCell = room.board[row][col];
    const existingTile =
      existingCell && typeof existingCell === "object" && "player" in existingCell && "type" in existingCell
        ? existingCell
        : existingCell?.tile ?? null;
    if (existingTile) return;
    if (existingCell && Array.isArray(existingCell.markers) && existingCell.markers.length > 0) return;
    if (!existingCell || typeof existingCell !== "object" || !("markers" in existingCell)) {
      room.board[row][col] = { tile: null, markers: [] };
    }

    room.moveIndex += 1;
    room.board[row][col].tile = { player: playerIndex, type, placedAt: room.moveIndex };
    room.hands[playerIndex][type] -= 1;
    recomputeMarkers(room);

    const [a, b] = room.players;
    room.turn = socket.id === a ? b : a;
    io.to(roomId).emit("state_update", {
      board: room.board,
      hands: room.hands,
      turn: room.turn
    });
    io.to(roomId).emit("turn_update", { turn: room.turn });
  });

  socket.on("toy_battle_place", ({ roomId, nodeId, pieceId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "toy-battle") return;
    if (room.turn !== socket.id) return;
    const node = room.toyBattle.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.base || node.piece) return;
    const pieceIndex = room.toyBattle.rack.findIndex((piece) => piece.id === pieceId);
    if (pieceIndex === -1) return;
    const [piece] = room.toyBattle.rack.splice(pieceIndex, 1);
    node.piece = { ...piece, player: 0 };
    emitToyBattleState(roomId, room);
  });

  socket.on("toy_battle_draw", ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "toy-battle") return;
    if (room.turn !== socket.id) return;
    const drawn = room.toyBattle.deck.splice(0, 2);
    room.toyBattle.rack.push(...drawn);
    emitToyBattleState(roomId, room);
  });

  socket.on("flip_triples_start", ({ roomId, options } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples") return;
    if (!room.flipTriples.setup) return;
    if (!room.players.includes(socket.id)) return;
    // Either player may start; whoever presses first locks in their chosen settings.
    startFlipTriplesGame(room, options || {});
    emitFlipTriplesState(roomId, room);
    if (!room.flipTriples.gameOver && !room.flipTriples.pendingPhase2) {
      io.to(roomId).emit("turn_update", { turn: room.turn });
    }
    if (room.isBot) scheduleFlipBot(roomId);
  });

  socket.on("flip_triples_undo", ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples") return;
    if (!room.flipUndo || room.flipUndo.by !== socket.id) return;
    room.flipTriples = room.flipUndo.snapshot;
    room.turn = room.flipUndo.turn;
    room.flipUndo = null;
    room.phase2Ready = new Set();
    emitFlipTriplesState(roomId, room);
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
    emitFlipTriplesState(roomId, room);
    if (!state.pendingPhase2 && !state.gameOver) {
      io.to(roomId).emit("turn_update", { turn: room.turn });
    }
    if (room.isBot) scheduleFlipBot(roomId);
  });

  socket.on("flip_triples_swap", ({ roomId, from, to } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples") return;
    const state = room.flipTriples;
    if (state.setup || state.pendingPhase2 || state.gameOver) return;
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

    // Blocker ownership: a swap touching a blocker is only available to its owner.
    const isSolo = room.players[0] === room.players[1];
    const allowed = isSolo ? [0, 1] : [room.players.indexOf(socket.id)];
    const actors = flipMoveActors(first, second);
    if (!actors.some((p) => allowed.includes(p))) return;

    // Snapshot the pre-move state so this move can be undone until the other
    // player moves (which replaces the snapshot with their own). Against the bot
    // the reply does not record its own snapshot, so this lets the human undo
    // their move together with the bot's automatic response.
    performFlipSwap(room, socket.id, from, to, true);

    emitFlipTriplesState(roomId, room);
    if (!state.gameOver && !state.pendingPhase2) {
      io.to(roomId).emit("turn_update", { turn: room.turn });
    }
    if (room.isBot) scheduleFlipBot(roomId);
  });

  socket.on("disconnect", () => {
    cleanupSocket(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
