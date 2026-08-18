// Only 3: 6x6 placement game. Seat 0 is red and moves first, seat 1 is blue;
// either seat may place red, blue or purple on any empty cell. Rules live in
// ./engine.js, the AI opponent in ./bot.js (run in a worker thread).
import { Worker } from "worker_threads";
import {
  CELLS,
  EMPTY,
  RED,
  BLUE,
  PURPLE,
  SEAT_COLORS,
  createBoard,
  countColor,
  listTriples,
  decideWinner,
  isFull
} from "./engine.js";
import { ONLY3_BOT_ID } from "./bot.js";

const ONLY3_BOT_SEAT = 1;
const ONLY3_BOT_DELAY_MS = 320;

// Search budget per move plus deliberate blunders: pickWeights are the
// probabilities of playing the 1st/2nd/3rd/... ranked move. Baby bot only ever
// looks one ply ahead and picks its best move a fifth of the time; God bot
// always plays its best after a long think.
const ONLY3_BOT_LEVELS = {
  0: { timeMs: 20, maxDepth: 1, pickWeights: [0.2, 0.25, 0.25, 0.2, 0.1] },
  1: { timeMs: 70, maxDepth: 3, pickWeights: [0.55, 0.25, 0.12, 0.08] },
  2: { timeMs: 250, maxDepth: 6, pickWeights: [0.78, 0.15, 0.07] },
  3: { timeMs: 900, maxDepth: 64, pickWeights: null },
  4: { timeMs: Number(process.env.ONLY3_BOT_MS || 4500), maxDepth: 64, pickWeights: null }
};
const ONLY3_BOT_DEFAULT_LEVEL = 3;

function createOnly3State() {
  return {
    board: createBoard(),
    toMove: 0,
    moveCount: 0,
    lastMove: null,
    gameOver: false,
    winner: null
  };
}

// Everything the client renders, derived fresh so the two never drift.
function only3View(state) {
  const result = decideWinner(state.board);
  return {
    board: state.board,
    toMove: state.toMove,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
    gameOver: state.gameOver,
    winner: state.gameOver ? result.winner : null,
    scores: { red: result.red, blue: result.blue },
    stones: {
      red: result.redStones,
      blue: result.blueStones,
      purple: countColor(state.board, PURPLE)
    },
    triples: listTriples(state.board)
  };
}

export function createOnly3Game({ io, rooms }) {
  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      only3: only3View(room.only3),
      turn: room.turn
    });
  }

  function place(room, cell, color) {
    const state = room.only3;
    state.board[cell] = color;
    state.lastMove = { cell, color, seat: state.toMove };
    state.moveCount += 1;
    if (isFull(state.board)) {
      state.gameOver = true;
      state.winner = decideWinner(state.board).winner;
      room.turn = null;
    } else {
      state.toMove = 1 - state.toMove;
      room.turn = room.players[state.toMove];
    }
  }

  // Any in-flight bot search no longer matches the room's position.
  function invalidateBotSearch(room) {
    room.only3Seq = (room.only3Seq || 0) + 1;
  }

  const botWorker = new Worker(new URL("./bot-worker.js", import.meta.url));
  botWorker.on("error", (err) => console.error("only-3 bot worker crashed:", err));
  botWorker.on("message", ({ seq, roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "only-3" || !room.isBot) return;
    if (room.only3Seq !== seq) return; // stale: the position changed since we asked
    const state = room.only3;
    if (!state || state.gameOver) return;
    if (room.turn !== ONLY3_BOT_ID) return;
    // A crashed or empty search must not stall the game: fall back to the first
    // empty cell with the bot's own color.
    const fallbackCell = state.board.findIndex((value) => value === EMPTY);
    const cell = move ? move.cell : fallbackCell;
    const color = move ? move.color : SEAT_COLORS[ONLY3_BOT_SEAT];
    if (cell < 0 || state.board[cell] !== EMPTY) return;
    place(room, cell, color);
    emitState(roomId, room);
    if (!state.gameOver) io.to(roomId).emit("turn_update", { turn: room.turn });
    if (room.turn === ONLY3_BOT_ID) scheduleBot(roomId);
  });

  function runBot(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "only-3" || !room.isBot) return;
    const state = room.only3;
    if (!state || state.gameOver || room.turn !== ONLY3_BOT_ID) return;

    const level = ONLY3_BOT_LEVELS[room.botLevel] ?? ONLY3_BOT_LEVELS[ONLY3_BOT_DEFAULT_LEVEL];
    invalidateBotSearch(room);
    botWorker.postMessage({
      seq: room.only3Seq,
      roomId,
      board: state.board,
      meColor: SEAT_COLORS[ONLY3_BOT_SEAT],
      timeMs: level.timeMs,
      maxDepth: level.maxDepth,
      pickWeights: level.pickWeights
    });
  }

  function scheduleBot(roomId) {
    setTimeout(() => runBot(roomId), ONLY3_BOT_DELAY_MS);
  }

  return {
    id: "only-3",

    createRoomState() {
      return { only3: createOnly3State(), only3Seq: 0 };
    },

    emitState,

    bot: {
      id: ONLY3_BOT_ID,
      normalizeLevel(level) {
        return ONLY3_BOT_LEVELS[level] ? level : ONLY3_BOT_DEFAULT_LEVEL;
      },
      onRoomCreated(roomId) {
        scheduleBot(roomId);
      }
    },

    registerHandlers(socket) {
      socket.on("only_3_place", ({ roomId, cell, color } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "only-3") return;
        const state = room.only3;
        if (!state || state.gameOver) return;
        // In solo play the one human drives both seats, so socket-owns-the-turn
        // is the only check needed.
        if (room.turn !== socket.id) return;
        if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return;
        if (state.board[cell] !== EMPTY) return;
        if (color !== RED && color !== BLUE && color !== PURPLE) return;

        invalidateBotSearch(room);
        place(room, cell, color);
        emitState(roomId, room);
        if (!state.gameOver) io.to(roomId).emit("turn_update", { turn: room.turn });
        if (room.isBot && room.turn === ONLY3_BOT_ID) scheduleBot(roomId);
      });

      socket.on("only_3_restart", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "only-3") return;
        if (!room.players.includes(socket.id)) return;
        invalidateBotSearch(room);
        room.only3 = createOnly3State();
        room.turn = room.players[0];
        emitState(roomId, room);
        io.to(roomId).emit("turn_update", { turn: room.turn });
        if (room.isBot && room.turn === ONLY3_BOT_ID) scheduleBot(roomId);
      });
    }
  };
}
