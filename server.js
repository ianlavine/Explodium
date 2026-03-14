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
    hands
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
    if (!existingCell || typeof existingCell !== "object" || !("markers" in existingCell)) {
      room.board[row][col] = { tile: null, markers: [] };
    }

    room.board[row][col].tile = { player: playerIndex, type };
    room.hands[playerIndex][type] -= 1;

    const squareType = 1;
    const diamondType = 0;
    const circleType = 2;
    const maxRangeSquare = 3;
    const maxRangeDiamond = 3;
    const maxRangeCircle = 2;
    const getTile = (cell) => {
      if (!cell || typeof cell !== "object") return null;
      if ("player" in cell && "type" in cell) return cell;
      return cell.tile ?? null;
    };
    const normalizeCell = (r, c) => {
      const cell = room.board[r][c];
      if (!cell || typeof cell !== "object" || !("markers" in cell)) {
        const existingTile = getTile(cell);
        room.board[r][c] = { tile: existingTile, markers: [] };
      }
      return room.board[r][c];
    };
    const markCell = (r, c) => {
      const cell = normalizeCell(r, c);
      const markers = room.board[r][c].markers;
      if (!markers.includes(playerIndex)) markers.push(playerIndex);
    };
    const isEmptyCell = (r, c) => !getTile(room.board[r][c]);
    const hasBlockingTile = (pathCells) =>
      pathCells.some(([r, c]) => {
        const tile = getTile(room.board[r][c]);
        return Boolean(tile);
      });
    const applyPathMarkers = (pathCells) => {
      if (pathCells.length === 0) return;
      if (hasBlockingTile(pathCells)) return;
      pathCells.forEach(([r, c]) => {
        if (isEmptyCell(r, c)) markCell(r, c);
      });
    };
    for (let r = 0; r < BOARD_SIZE; r += 1) {
      for (let c = 0; c < BOARD_SIZE; c += 1) {
        const cellTile = getTile(room.board[r][c]);
        if (!cellTile) continue;
        if (cellTile.player !== playerIndex) continue;
        const dr = row - r;
        const dc = col - c;
        if (dr === 0 && dc === 0) continue;

        if (cellTile.type === squareType) {
          const sameRow = dr === 0;
          const sameCol = dc === 0;
          const distance = sameRow ? Math.abs(dc) : sameCol ? Math.abs(dr) : null;
          if (distance === null || distance > maxRangeSquare) continue;
          const stepR = sameRow ? 0 : dr > 0 ? 1 : -1;
          const stepC = sameCol ? 0 : dc > 0 ? 1 : -1;
          const path = [];
          let rr = r + stepR;
          let cc = c + stepC;
          while (rr !== row || cc !== col) {
            path.push([rr, cc]);
            rr += stepR;
            cc += stepC;
          }
          applyPathMarkers(path);
        } else if (cellTile.type === diamondType) {
          if (Math.abs(dr) !== Math.abs(dc)) continue;
          if (Math.abs(dr) > maxRangeDiamond) continue;
          const stepR = dr > 0 ? 1 : -1;
          const stepC = dc > 0 ? 1 : -1;
          const path = [];
          let rr = r + stepR;
          let cc = c + stepC;
          while (rr !== row || cc !== col) {
            path.push([rr, cc]);
            rr += stepR;
            cc += stepC;
          }
          applyPathMarkers(path);
        } else if (cellTile.type === circleType) {
          const isOrth = dr === 0 || dc === 0;
          const isDiag = Math.abs(dr) === Math.abs(dc);
          if (!isOrth && !isDiag) continue;
          const distance = Math.max(Math.abs(dr), Math.abs(dc));
          if (distance > maxRangeCircle) continue;
          const stepR = dr === 0 ? 0 : dr > 0 ? 1 : -1;
          const stepC = dc === 0 ? 0 : dc > 0 ? 1 : -1;
          const path = [];
          let rr = r + stepR;
          let cc = c + stepC;
          while (rr !== row || cc !== col) {
            path.push([rr, cc]);
            rr += stepR;
            cc += stepC;
          }
          applyPathMarkers(path);
        }
      }
    }

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
