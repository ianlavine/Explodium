import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

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
const FLIP_TRIPLES_SIZE = 5;
const FLIP_TRIPLES_DEFAULT_PLAYER_PIECES = 8;
const FLIP_TRIPLES_MAX_PLAYER_PIECES = Math.floor((FLIP_TRIPLES_SIZE * FLIP_TRIPLES_SIZE) / 2);

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

function normalizeFlipTriplesOptions(options = {}) {
  const rawCount = Number(options.playerPieces);
  const playerPieces = Number.isInteger(rawCount) ? rawCount : FLIP_TRIPLES_DEFAULT_PLAYER_PIECES;
  return {
    playerPieces: Math.min(Math.max(playerPieces, 0), FLIP_TRIPLES_MAX_PLAYER_PIECES)
  };
}

function normalizeGameOptions(gameId, options = {}) {
  if (gameId === "flip-triples") return normalizeFlipTriplesOptions(options);
  return {};
}

function getQueueKey(gameId, options = {}) {
  if (gameId === "flip-triples") {
    return `${gameId}:${normalizeFlipTriplesOptions(options).playerPieces}`;
  }
  return gameId;
}

function getQueue(gameId, options = {}) {
  const queueKey = getQueueKey(gameId, options);
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

function createFlipTriplesShapes(playerPieces) {
  const neutralPieces = FLIP_TRIPLES_SIZE * FLIP_TRIPLES_SIZE - playerPieces * 2;
  return [
    ...Array.from({ length: playerPieces }, () => "red-x"),
    ...Array.from({ length: playerPieces }, () => "blue-o"),
    ...Array.from({ length: neutralPieces }, () => "neutral")
  ];
}

function createFlipTriplesState(options = {}) {
  const settings = normalizeFlipTriplesOptions(options);
  const pieces = shuffle(createFlipTriplesShapes(settings.playerPieces)).map((shape, index) => ({
    id: `flip-${index}`,
    shape,
    flipped: false,
    opportunity: false
  }));
  const board = [];
  for (let row = 0; row < FLIP_TRIPLES_SIZE; row += 1) {
    board.push(pieces.slice(row * FLIP_TRIPLES_SIZE, (row + 1) * FLIP_TRIPLES_SIZE));
  }
  return {
    settings: {
      playerPieces: settings.playerPieces,
      neutralPieces: FLIP_TRIPLES_SIZE * FLIP_TRIPLES_SIZE - settings.playerPieces * 2
    },
    board,
    phase: 1,
    phaseScores: {
      phase1: { red: 0, blue: 0 },
      phase2: { red: 0, blue: 0 },
      bonus: { red: 0, blue: 0 }
    },
    scores: { red: 0, blue: 0 },
    gameOver: false
  };
}

function hasFlipTriplesMove(board, phase) {
  for (let row = 0; row < FLIP_TRIPLES_SIZE; row += 1) {
    for (let col = 0; col < FLIP_TRIPLES_SIZE; col += 1) {
      if (!isSelectableFlipPiece(board[row][col], phase)) continue;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (nextRow < 0 || nextRow >= FLIP_TRIPLES_SIZE) continue;
          if (nextCol < 0 || nextCol >= FLIP_TRIPLES_SIZE) continue;
          if (isSelectableFlipPiece(board[nextRow][nextCol], phase)) return true;
        }
      }
    }
  }
  return false;
}

function isSelectableFlipPiece(piece, phase) {
  return phase === 1 ? !piece.flipped : piece.flipped;
}

function getFlipTriples(board, shape) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];
  const triples = [];
  for (let row = 0; row < FLIP_TRIPLES_SIZE; row += 1) {
    for (let col = 0; col < FLIP_TRIPLES_SIZE; col += 1) {
      directions.forEach(([dr, dc]) => {
        const cells = [0, 1, 2].map((offset) => [row + dr * offset, col + dc * offset]);
        const inBounds = cells.every(
          ([r, c]) => r >= 0 && r < FLIP_TRIPLES_SIZE && c >= 0 && c < FLIP_TRIPLES_SIZE
        );
        if (!inBounds) return;
        if (cells.every(([r, c]) => board[r][c].shape === shape)) triples.push(cells);
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
      piece.opportunity = !piece.flipped && piece.shape !== "neutral";
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

function advanceFlipTriplesIfNeeded(room) {
  const state = room.flipTriples;
  if (hasFlipTriplesMove(state.board, state.phase)) return;

  if (state.phase === 1) {
    state.phaseScores.phase1 = getFlipTriplesScores(state.board);
    markFlipTriplesOpportunities(state.board);
    refreshFlipTriplesTotals(state);
    state.phase = 2;
    if (hasFlipTriplesMove(state.board, state.phase)) return;
  }

  state.phaseScores.phase2 = getFlipTriplesScores(state.board);
  state.phaseScores.bonus = {
    red: countFlipTriplesOpportunityBonus(state.board, "red-x"),
    blue: countFlipTriplesOpportunityBonus(state.board, "blue-o")
  };
  refreshFlipTriplesTotals(state);
  state.gameOver = true;
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
  io.to(roomId).emit("state_update", {
    flipTriples: room.flipTriples,
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
      flipTriples: createFlipTriplesState(gameOptions)
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

  socket.on("flip_triples_swap", ({ roomId, from, to } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "flip-triples") return;
    if (room.turn !== socket.id || room.flipTriples.gameOver) return;
    const isCoordinate = (point) =>
      point &&
      Number.isInteger(point.row) &&
      Number.isInteger(point.col) &&
      point.row >= 0 &&
      point.row < FLIP_TRIPLES_SIZE &&
      point.col >= 0 &&
      point.col < FLIP_TRIPLES_SIZE;
    if (!isCoordinate(from) || !isCoordinate(to)) return;
    const rowGap = Math.abs(from.row - to.row);
    const colGap = Math.abs(from.col - to.col);
    if (rowGap === 0 && colGap === 0) return;
    if (Math.max(rowGap, colGap) !== 1) return;

    const board = room.flipTriples.board;
    const first = board[from.row][from.col];
    const second = board[to.row][to.col];
    if (
      !first ||
      !second ||
      !isSelectableFlipPiece(first, room.flipTriples.phase) ||
      !isSelectableFlipPiece(second, room.flipTriples.phase)
    ) {
      return;
    }

    board[to.row][to.col] = { ...first, flipped: room.flipTriples.phase === 1 };
    board[from.row][from.col] = second;
    advanceFlipTriplesIfNeeded(room);

    if (!room.flipTriples.gameOver) {
      const [a, b] = room.players;
      room.turn = socket.id === a ? b : a;
    }
    emitFlipTriplesState(roomId, room);
    if (!room.flipTriples.gameOver) {
      io.to(roomId).emit("turn_update", { turn: room.turn });
    }
  });

  socket.on("disconnect", () => {
    cleanupSocket(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
