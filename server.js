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

const queueByGame = new Map(); // gameId -> [socketId]
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

function getQueue(gameId) {
  if (!queueByGame.has(gameId)) {
    queueByGame.set(gameId, []);
  }
  return queueByGame.get(gameId);
}

function createRoom(gameId, playerA, playerB) {
  const roomId = `room-${gameId}-${playerA}-${playerB}`;
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
  socket.on("start_solo", ({ gameId = "default" } = {}) => {
    const roomId = createRoom(gameId, socket.id, socket.id);
    io.sockets.sockets.get(socket.id)?.join(roomId);
    const room = rooms.get(roomId);
    io.to(socket.id).emit("match_found", {
      roomId,
      gameId,
      players: [socket.id, socket.id],
      turn: room.turn,
      playerIndex: 0
    });
    io.to(roomId).emit("state_update", {
      board: room.board,
      hands: room.hands,
      turn: room.turn
    });
  });

  socket.on("join_queue", ({ gameId = "default" } = {}) => {
    const queue = getQueue(gameId);
    if (queue.includes(socket.id)) return;
    queue.push(socket.id);

    if (queue.length >= 2) {
      const playerA = queue.shift();
      const playerB = queue.shift();
      const roomId = createRoom(gameId, playerA, playerB);

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
      io.to(roomId).emit("state_update", {
        board: room.board,
        hands: room.hands,
        turn: room.turn
      });
    }
  });

  socket.on("leave_queue", ({ gameId = "default" } = {}) => {
    const queue = getQueue(gameId);
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

  socket.on("disconnect", () => {
    cleanupSocket(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
