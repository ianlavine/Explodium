// Jabble lobby module, made once per game (Jabble and Jabble Ice share it —
// the engine's VARIANTS say what differs). One fixed-rate simulation loop per
// room: the engine steps at TICK_HZ; positions go out as small volatile
// "jabble_tick" snapshots every SEND_EVERY ticks, and the rest (arena, score,
// phase) as a normal state_update only when it changes. Clients send held
// movement keys and jab presses; nothing they send is trusted beyond that.
//
// Both instances listen for the same socket events, so every handler first
// checks the room belongs to its own game.
import {
  TICK_MS,
  createMatch,
  resetMatch,
  step,
  setKeys,
  requestJab,
  snapshot,
  publicState
} from "./engine.js";
import { JABBLE_BOT_ID, createBotBrain, botThink } from "./bot.js";

const SEND_EVERY = 2; // 30 snapshots a second
const LOOP_MS = 8; // timer resolution; the accumulator keeps the sim at TICK_HZ
const MAX_CATCHUP = 5; // after a stall, drop time rather than fast-forward

// `id` is the lobby's game id (and the engine variant); `stateKey` is the key
// its state_update payload travels under, which is how the client shell knows
// whose it is.
export function createJabbleGame({ io, rooms }, { id, stateKey }) {
  const loops = new Map(); // roomId -> interval handle

  function stopLoop(roomId) {
    const handle = loops.get(roomId);
    if (handle) clearInterval(handle);
    loops.delete(roomId);
  }

  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", { [stateKey]: publicState(room.jabble) });
  }

  // Seats a real person sits in (a solo room lists the same socket twice).
  function humanSeats(room) {
    return room.players
      .map((playerId, seat) => ({ playerId, seat }))
      .filter(({ playerId, seat }) => playerId !== JABBLE_BOT_ID && room.players.indexOf(playerId) === seat)
      .map(({ seat }) => seat);
  }

  function roomFor(roomId) {
    const room = rooms.get(roomId);
    return room && room.gameId === id ? room : null;
  }

  function startLoop(roomId) {
    stopLoop(roomId);
    let last = performance.now();
    let pending = 0;
    let lastSent = -Infinity;
    loops.set(
      roomId,
      setInterval(() => {
        // The lobby deletes rooms outright on leave/disconnect, so the loop
        // checks every time and shuts itself down once its room is gone.
        const room = roomFor(roomId);
        if (!room) {
          stopLoop(roomId);
          return;
        }
        const now = performance.now();
        pending += now - last;
        last = now;
        const state = room.jabble;
        let steps = 0;
        let changed = false;
        while (pending >= TICK_MS && steps < MAX_CATCHUP) {
          pending -= TICK_MS;
          steps += 1;
          room.jabbleBots?.forEach(({ seat, brain }) => botThink(state, seat, brain));
          if (step(state)) changed = true;
        }
        if (steps === MAX_CATCHUP) pending = 0;
        if (changed) emitState(roomId, room);
        if (steps && state.tick - lastSent >= SEND_EVERY) {
          lastSent = state.tick;
          io.to(roomId).volatile.emit("jabble_tick", snapshot(state));
        }
      }, LOOP_MS)
    );
  }

  // The room and seat a socket's message is about, or null if it isn't ours.
  function seated(socket, roomId) {
    const room = roomFor(roomId);
    const seat = room ? room.players.indexOf(socket.id) : -1;
    return seat === -1 ? null : { room, seat };
  }

  return {
    id,

    createRoomState() {
      return { jabble: createMatch(2, id) };
    },

    emitState,

    onRoomCreated(roomId) {
      startLoop(roomId);
    },

    registerHandlers(socket) {
      socket.on("jabble_input", ({ roomId, keys } = {}) => {
        const at = seated(socket, roomId);
        if (at) setKeys(at.room.jabble, at.seat, Number(keys) || 0);
      });

      socket.on("jabble_jab", ({ roomId, dir } = {}) => {
        const at = seated(socket, roomId);
        if (at) requestJab(at.room.jabble, at.seat, Number(dir) || 0);
      });

      socket.on("jabble_rematch", ({ roomId } = {}) => {
        const at = seated(socket, roomId);
        if (!at || at.room.jabble.phase !== "matchover") return;
        const { room, seat } = at;
        room.jabble.rematch.add(seat);
        if (humanSeats(room).every((s) => room.jabble.rematch.has(s))) resetMatch(room.jabble);
        emitState(roomId, room);
      });
    },

    bot: {
      id: JABBLE_BOT_ID,
      normalizeLevel() {
        return 0;
      },
      onRoomCreated(roomId, room) {
        room.jabbleBots = room.players
          .map((playerId, seat) => ({ playerId, seat }))
          .filter(({ playerId }) => playerId === JABBLE_BOT_ID)
          .map(({ seat }) => ({ seat, brain: createBotBrain() }));
      }
    }
  };
}
