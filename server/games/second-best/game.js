// Second Best: 5x5 or 6x6 placement game. Seat 0 is blue and moves first, seat
// 1 is red; either seat may place either color, or spend from the shared
// neutral stock, on any empty cell. Rules live in ./engine.js, the AI opponent
// in ./bot.js (run in a worker thread).
import { Worker } from "worker_threads";
import {
  EMPTY,
  BLUE,
  RED,
  NEUTRAL,
  SEAT_COLORS,
  geometry,
  createBoard,
  seedNeutrals,
  normalizeSettings,
  decideWinner,
  isFull
} from "./engine.js";
import { SECOND_BEST_BOT_ID } from "./bot.js";

const SECOND_BEST_BOT_SEAT = 1;
const SECOND_BEST_BOT_DELAY_MS = 320;

// Search budget per move plus deliberate blunders: pickWeights are the
// probabilities of playing the 1st/2nd/3rd/... ranked move. Baby bot only looks
// one ply ahead and plays its best move a fifth of the time; God bot always
// plays its best after a long think. Every level solves the last several cells
// exactly, so the endgame is sharp even at the bottom.
const SECOND_BEST_BOT_LEVELS = {
  0: { timeMs: 20, maxDepth: 1, pickWeights: [0.2, 0.25, 0.25, 0.2, 0.1] },
  1: { timeMs: 80, maxDepth: 3, pickWeights: [0.55, 0.25, 0.12, 0.08] },
  2: { timeMs: 260, maxDepth: 6, pickWeights: [0.78, 0.15, 0.07] },
  3: { timeMs: 900, maxDepth: 64, pickWeights: null },
  4: { timeMs: Number(process.env.SECOND_BEST_BOT_MS || 4000), maxDepth: 64, pickWeights: null }
};
const SECOND_BEST_BOT_DEFAULT_LEVEL = 3;

function createSecondBestState(options) {
  const settings = normalizeSettings(options?.settings);
  const board = seedNeutrals(createBoard(settings.size), settings.seededNeutrals);
  return {
    settings,
    board,
    toMove: 0,
    moveCount: 0,
    neutralsUsed: 0,
    lastMove: null,
    gameOver: false,
    winner: null
  };
}

const neutralsLeft = (state) => state.settings.playableNeutrals - state.neutralsUsed;

// Enough of the state to put the board back exactly as it was before a move.
// `settings` is never mutated, so it rides along by reference.
function snapshotState(state) {
  return {
    ...state,
    board: [...state.board],
    lastMove: state.lastMove ? { ...state.lastMove } : null
  };
}

// Everything the client renders, derived fresh so the two never drift. The
// ranked group lists are what the board highlights: rank 1 is the group that
// actually scores.
function secondBestView(state, undo) {
  const result = decideWinner(state.board);
  return {
    settings: state.settings,
    board: state.board,
    toMove: state.toMove,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
    gameOver: state.gameOver,
    winner: state.gameOver ? result.winner : null,
    scores: { blue: result.blue, red: result.red },
    pieces: { blue: result.bluePieces, red: result.redPieces, neutral: result.neutralPieces },
    neutralsLeft: neutralsLeft(state),
    groups: {
      blue: result.blueGroups.map((group) => ({ size: group.size, cells: group.cells })),
      red: result.redGroups.map((group) => ({ size: group.size, cells: group.cells }))
    },
    undoBy: undo ? undo.by : null
  };
}

export function createSecondBestGame({ io, rooms }) {
  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      secondBest: secondBestView(room.secondBest, room.secondBestUndo),
      turn: room.turn
    });
  }

  // `recordUndo` is true for human moves so the move can be rewound; the bot
  // passes false, which leaves the human's own snapshot standing and so lets
  // one undo take back their move together with the bot's reply.
  function place(room, cell, color, recordUndo, actorId) {
    const state = room.secondBest;
    if (recordUndo) {
      room.secondBestUndo = { by: actorId, turn: room.turn, snapshot: snapshotState(state) };
    }
    state.board[cell] = color;
    if (color === NEUTRAL) state.neutralsUsed += 1;
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
    room.secondBestSeq = (room.secondBestSeq || 0) + 1;
  }

  const botWorker = new Worker(new URL("./bot-worker.js", import.meta.url));
  botWorker.on("error", (err) => console.error("second-best bot worker crashed:", err));
  botWorker.on("message", ({ seq, roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "second-best" || !room.isBot) return;
    if (room.secondBestSeq !== seq) return; // stale: the position changed since we asked
    const state = room.secondBest;
    if (!state || state.gameOver) return;
    if (room.turn !== SECOND_BEST_BOT_ID) return;
    // A crashed or empty search must not stall the game: fall back to the first
    // empty cell with the bot's own color.
    const fallbackCell = state.board.findIndex((value) => value === EMPTY);
    const cell = move ? move.cell : fallbackCell;
    const color = move ? move.color : SEAT_COLORS[SECOND_BEST_BOT_SEAT];
    if (cell < 0 || state.board[cell] !== EMPTY) return;
    if (color === NEUTRAL && neutralsLeft(state) <= 0) return;
    place(room, cell, color, false, SECOND_BEST_BOT_ID);
    emitState(roomId, room);
    if (!state.gameOver) io.to(roomId).emit("turn_update", { turn: room.turn });
    if (room.turn === SECOND_BEST_BOT_ID) scheduleBot(roomId);
  });

  function runBot(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "second-best" || !room.isBot) return;
    const state = room.secondBest;
    if (!state || state.gameOver || room.turn !== SECOND_BEST_BOT_ID) return;

    const level =
      SECOND_BEST_BOT_LEVELS[room.botLevel] ?? SECOND_BEST_BOT_LEVELS[SECOND_BEST_BOT_DEFAULT_LEVEL];
    invalidateBotSearch(room);
    botWorker.postMessage({
      seq: room.secondBestSeq,
      roomId,
      board: state.board,
      meColor: SEAT_COLORS[SECOND_BEST_BOT_SEAT],
      neutralsLeft: neutralsLeft(state),
      timeMs: level.timeMs,
      maxDepth: level.maxDepth,
      pickWeights: level.pickWeights
    });
  }

  function scheduleBot(roomId) {
    setTimeout(() => runBot(roomId), SECOND_BEST_BOT_DELAY_MS);
  }

  return {
    id: "second-best",

    createRoomState(options) {
      return { secondBest: createSecondBestState(options), secondBestSeq: 0, secondBestUndo: null };
    },

    emitState,

    bot: {
      id: SECOND_BEST_BOT_ID,
      normalizeLevel(level) {
        return SECOND_BEST_BOT_LEVELS[level] ? level : SECOND_BEST_BOT_DEFAULT_LEVEL;
      },
      onRoomCreated(roomId) {
        scheduleBot(roomId);
      }
    },

    registerHandlers(socket) {
      socket.on("second_best_place", ({ roomId, cell, color } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "second-best") return;
        const state = room.secondBest;
        if (!state || state.gameOver) return;
        // In solo play the one human drives both seats, so socket-owns-the-turn
        // is the only check needed.
        if (room.turn !== socket.id) return;
        const { cells } = geometry(state.settings.size);
        if (!Number.isInteger(cell) || cell < 0 || cell >= cells) return;
        if (state.board[cell] !== EMPTY) return;
        if (color !== BLUE && color !== RED && color !== NEUTRAL) return;
        if (color === NEUTRAL && neutralsLeft(state) <= 0) return;

        invalidateBotSearch(room);
        place(room, cell, color, true, socket.id);
        emitState(roomId, room);
        if (!state.gameOver) io.to(roomId).emit("turn_update", { turn: room.turn });
        if (room.isBot && room.turn === SECOND_BEST_BOT_ID) scheduleBot(roomId);
      });

      // One level of take-back, owned by whoever made the move. Against the bot
      // it rewinds the reply as well, because the bot never records a snapshot.
      socket.on("second_best_undo", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "second-best") return;
        const undo = room.secondBestUndo;
        if (!undo || undo.by !== socket.id) return;
        room.secondBest = undo.snapshot;
        room.turn = undo.turn;
        room.secondBestUndo = null;
        invalidateBotSearch(room);
        emitState(roomId, room);
        io.to(roomId).emit("turn_update", { turn: room.turn });
        if (room.isBot && room.turn === SECOND_BEST_BOT_ID) scheduleBot(roomId);
      });

      // A restart re-rolls the seeded neutrals, so the same table plays a fresh
      // board rather than the same obstacles every time.
      socket.on("second_best_restart", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "second-best") return;
        if (!room.players.includes(socket.id)) return;
        invalidateBotSearch(room);
        room.secondBest = createSecondBestState({ settings: room.secondBest.settings });
        room.secondBestUndo = null;
        room.turn = room.players[0];
        emitState(roomId, room);
        io.to(roomId).emit("turn_update", { turn: room.turn });
        if (room.isBot && room.turn === SECOND_BEST_BOT_ID) scheduleBot(roomId);
      });
    }
  };
}
