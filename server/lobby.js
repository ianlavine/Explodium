// Shared matchmaking/room infrastructure. Game-specific logic lives in
// ./games/<game-id>/game.js; each game module exposes:
//   id               - the gameId used by the client
//   createRoomState  - per-room game state merged into the room object
//   emitState        - pushes the current room state to the room's sockets
//   registerHandlers - installs the game's socket event handlers
//   onRoomCreated    - (optional) called once the room exists with its final
//                      player list, for state that depends on who's seated
//   bot (optional)   - { id, normalizeLevel, onRoomCreated } for AI opponents
import { createExplodiumGame } from "./games/explodium/game.js";
import { createToyBattleGame } from "./games/toy-battle/game.js";
import { createFlipTriplesGame } from "./games/flip-triples/game.js";
import { createTruckManiaGame } from "./games/truck-mania/game.js";
import { createUberManiaGame } from "./games/uber-mania/game.js";
import { createLinoGame } from "./games/lino/game.js";

export function createLobby(io) {
  const queueByGame = new Map(); // queueKey -> [socketId]
  const rooms = new Map(); // roomId -> { gameId, players, turn, ...gameState }

  const ctx = { io, rooms };
  const games = [
    createExplodiumGame(ctx),
    createToyBattleGame(ctx),
    createFlipTriplesGame(ctx),
    createTruckManiaGame(ctx),
    createUberManiaGame(ctx),
    createLinoGame(ctx)
  ];
  const gamesById = new Map(games.map((game) => [game.id, game]));

  function getGame(gameId) {
    return gamesById.get(gameId) ?? gamesById.get("explodium");
  }

  function getQueue(gameId) {
    if (!queueByGame.has(gameId)) {
      queueByGame.set(gameId, []);
    }
    return queueByGame.get(gameId);
  }

  function createRoom(gameId, playerA, playerB) {
    const game = getGame(gameId);
    const roomId = `room-${game.id}-${playerA}-${playerB}`;
    rooms.set(roomId, {
      gameId: game.id,
      players: [playerA, playerB],
      turn: playerA,
      ...game.createRoomState()
    });
    game.onRoomCreated?.(roomId, rooms.get(roomId));
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
    games.forEach((game) => game.registerHandlers(socket));

    socket.on("start_solo", ({ gameId = "default" } = {}) => {
      const roomId = createRoom(gameId, socket.id, socket.id);
      io.sockets.sockets.get(socket.id)?.join(roomId);
      const room = rooms.get(roomId);
      io.to(socket.id).emit("match_found", {
        roomId,
        gameId: room.gameId,
        players: [socket.id, socket.id],
        turn: room.turn,
        playerIndex: 0
      });
      getGame(room.gameId).emitState(roomId, room);
    });

    // Single-player vs. the AI. Games without a bot fall back to a normal solo
    // (the human controls both sides).
    socket.on("start_bot", ({ gameId = "default", botLevel } = {}) => {
      const game = getGame(gameId);
      const botSupported = !!game.bot;
      const opponentId = botSupported ? game.bot.id : socket.id;
      const roomId = createRoom(gameId, socket.id, opponentId);
      io.sockets.sockets.get(socket.id)?.join(roomId);
      const room = rooms.get(roomId);
      room.isBot = botSupported;
      if (botSupported) room.botLevel = game.bot.normalizeLevel(botLevel);
      io.to(socket.id).emit("match_found", {
        roomId,
        gameId: room.gameId,
        players: [socket.id, opponentId],
        turn: room.turn,
        playerIndex: 0
      });
      game.emitState(roomId, room);
      if (room.isBot) game.bot.onRoomCreated(roomId, room);
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
          gameId: room.gameId,
          players: [playerA, playerB],
          turn: room.turn,
          playerIndex: 0
        });
        io.to(playerB).emit("match_found", {
          roomId,
          gameId: room.gameId,
          players: [playerA, playerB],
          turn: room.turn,
          playerIndex: 1
        });
        getGame(room.gameId).emitState(roomId, room);
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

    socket.on("disconnect", () => {
      cleanupSocket(socket.id);
    });
  });
}
