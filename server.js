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
const rooms = new Map(); // roomId -> { gameId, players: [socketId], turn: socketId }

function getQueue(gameId) {
  if (!queueByGame.has(gameId)) {
    queueByGame.set(gameId, []);
  }
  return queueByGame.get(gameId);
}

function createRoom(gameId, playerA, playerB) {
  const roomId = `room-${gameId}-${playerA}-${playerB}`;
  rooms.set(roomId, { gameId, players: [playerA, playerB], turn: playerA });
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

      io.to(roomId).emit("match_found", {
        roomId,
        gameId,
        players: [playerA, playerB],
        turn: rooms.get(roomId).turn
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

  socket.on("take_turn", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.turn !== socket.id) return;

    const [a, b] = room.players;
    room.turn = socket.id === a ? b : a;
    io.to(roomId).emit("turn_update", { turn: room.turn });
  });

  socket.on("disconnect", () => {
    cleanupSocket(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
