// Downstream: socket wiring. One human (seat 0) against three AI at the same
// table; the rules live in ./engine.js and the AI in ./bot.js.
import {
  createState,
  place,
  chooseMove as applyChoice,
  setSetting,
  reconcileHands,
  SETTINGS,
  defaultSettings,
  SEATS
} from "./engine.js";
import { chooseMove as botMove, greedyChoice } from "./bot.js";

const PLAYER_NAMES = ["You", "Robin", "Marlow", "Pike"];
// Pacing knob: how long an AI sits on its hands before playing. Slow enough
// to follow what it did, since its move often sets water running.
const BOT_DELAY_MS = 1700;

function createDownstreamState(settings = defaultSettings()) {
  const state = createState(SEATS, settings);
  state.players = PLAYER_NAMES.map((name, seat) => ({ name, seat, isBot: seat > 0 }));
  return state;
}

export function createDownstreamGame({ io, rooms }) {
  const botTimers = new Map(); // roomId -> timeout handle

  function stopBots(roomId) {
    const timer = botTimers.get(roomId);
    if (timer) clearTimeout(timer);
    botTimers.delete(roomId);
  }

  function emitState(roomId, room) {
    const state = room.downstream;
    io.to(roomId).emit("state_update", {
      downstream: {
        board: state.board,
        tokens: state.tokens.map(({ id, cell, value, status }) => ({ id, cell, value, status })),
        scores: state.scores,
        players: state.players,
        // Only the seated human's tiles are ever sent.
        hand: state.hands[0],
        handCounts: state.hands.map((hand) => hand.length),
        deckCounts: state.decks.map((deck) => deck.length),
        turn: state.turn,
        pending: state.pending,
        anim: state.anim,
        lastTurn: state.lastTurn,
        log: state.log.slice(-8),
        gameOver: state.gameOver,
        winners: state.winners,
        settings: state.settings,
        settingSpecs: SETTINGS
      },
      turn: room.turn
    });
    state.anim = [];
  }

  // Bots play one after another until the turn comes back around to the human.
  function scheduleBots(roomId) {
    stopBots(roomId);
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "downstream") return;
    const state = room.downstream;
    if (state.gameOver || state.turn === 0) return;
    botTimers.set(
      roomId,
      setTimeout(() => {
        botTimers.delete(roomId);
        const current = rooms.get(roomId);
        if (!current || current.gameId !== "downstream") return;
        const live = current.downstream;
        if (live.gameOver || live.turn === 0) return;
        const seat = live.turn;
        const move = botMove(live, seat);
        if (move) {
          place(live, seat, move.tileIndex, move.cell, greedyChoice);
        } else {
          // Nothing legal to play (shouldn't happen while squares remain) —
          // pass the seat on rather than stalling the table.
          live.turn = (seat + 1) % live.scores.length;
        }
        emitState(roomId, current);
        scheduleBots(roomId);
      }, BOT_DELAY_MS)
    );
  }

  return {
    id: "downstream",

    createRoomState() {
      return { downstream: createDownstreamState() };
    },

    emitState,

    onRoomCreated(roomId) {
      stopBots(roomId);
    },

    registerHandlers(socket) {
      const roomFor = (roomId) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "downstream") return null;
        if (!room.players.includes(socket.id)) return null;
        return room;
      };

      socket.on("downstream_place", ({ roomId, tileIndex, cell } = {}) => {
        const room = roomFor(roomId);
        if (!room) return;
        if (!place(room.downstream, 0, tileIndex, cell)) return;
        emitState(roomId, room);
        scheduleBots(roomId);
      });

      socket.on("downstream_choose", ({ roomId, tokenId, cell, stop } = {}) => {
        const room = roomFor(roomId);
        if (!room) return;
        if (!applyChoice(room.downstream, 0, tokenId ?? null, cell, !!stop)) return;
        emitState(roomId, room);
        scheduleBots(roomId);
      });

      // Scoring dials take effect immediately, mid-game included, and carry
      // over into the next one.
      socket.on("downstream_setting", ({ roomId, key, value } = {}) => {
        const room = roomFor(roomId);
        if (!room) return;
        if (!setSetting(room.downstream, key, value)) return;
        // A wider or narrower hand takes hold right away; the dials that
        // reshape the pile only matter when the next game is dealt.
        if (key === "handSize") reconcileHands(room.downstream);
        emitState(roomId, room);
      });

      socket.on("downstream_restart", ({ roomId } = {}) => {
        const room = roomFor(roomId);
        if (!room) return;
        stopBots(roomId);
        room.downstream = createDownstreamState({ ...room.downstream.settings });
        emitState(roomId, room);
      });
    }
  };
}
