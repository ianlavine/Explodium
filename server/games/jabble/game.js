// Jabble lobby module, made once per game (Jabble and Jabble Ice share it —
// the engine's VARIANTS say what differs). One fixed-rate simulation loop per
// room: the engine steps at TICK_HZ; positions go out as small volatile
// "jabble_tick" snapshots every SEND_EVERY ticks, and the rest (arena, score,
// phase) as a normal state_update only when it changes.
//
// Each browser predicts its own square (public/games/jabble/predict.js), so
// it sends one numbered input per tick — [seq, keys, jab] — in small batches.
// They queue here and the loop spends exactly one per player per tick, the
// same way the browser did, and every snapshot carries each seat's `ack`:
// the last input it has spent. A queue that runs dry (a late packet) just
// repeats the last keys. Nothing a client sends is trusted beyond its keys.
//
// Anyone at the table can move the sliders (engine SETTINGS); a change goes
// out to everyone as a state_update, so in an online match both players are
// always playing — and predicting — the same numbers.
//
// Both instances listen for the same socket events, so every handler first
// checks the room belongs to its own game.
import {
  TICK_MS,
  createMatch,
  resetMatch,
  applySettings,
  resetSettings,
  step,
  setKeys,
  requestJab,
  snapshot,
  publicState
} from "../../../public/games/jabble/engine.js";
import { JABBLE_BOT_ID, createBotBrain, botThink } from "./bot.js";

const SEND_EVERY = 2; // 30 snapshots a second
const LOOP_MS = 8; // timer resolution; the accumulator keeps the sim at TICK_HZ
const MAX_CATCHUP = 5; // after a stall, drop time rather than fast-forward
const MAX_QUEUE = 12; // inputs a seat may have waiting (0.2 s); older ones are dropped
const MAX_BATCH = 30; // inputs one message may carry

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
          room.jabbleInputs.forEach((inputs, seat) => {
            const next = inputs.queue.shift();
            if (!next) return;
            setKeys(state, seat, next.keys);
            if (next.jab) requestJab(state, seat, next.jab);
            inputs.ack = next.seq;
          });
          if (step(state)) changed = true;
        }
        if (steps === MAX_CATCHUP) pending = 0;
        if (changed) emitState(roomId, room);
        if (steps && state.tick - lastSent >= SEND_EVERY) {
          lastSent = state.tick;
          io.to(roomId).volatile.emit("jabble_tick", {
            ...snapshot(state),
            ack: room.jabbleInputs.map((inputs) => inputs.ack)
          });
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

    // The sliders a match starts with are the ones the first player to sit
    // down brought (their last-used set, saved in their browser).
    createRoomState(options) {
      return {
        jabble: createMatch(2, id, options?.settings),
        // Per seat: inputs waiting to be spent, the newest seq received, and
        // the last seq spent (what snapshots acknowledge).
        jabbleInputs: [0, 1].map(() => ({ queue: [], received: 0, ack: 0 }))
      };
    },

    emitState,

    onRoomCreated(roomId) {
      startLoop(roomId);
    },

    registerHandlers(socket) {
      socket.on("jabble_input", ({ roomId, inputs } = {}) => {
        const at = seated(socket, roomId);
        if (!at || !Array.isArray(inputs)) return;
        const mine = at.room.jabbleInputs[at.seat];
        for (const input of inputs.slice(0, MAX_BATCH)) {
          const [seq, keys, jab] = Array.isArray(input) ? input.map(Number) : [];
          if (!Number.isInteger(seq) || seq <= mine.received) continue;
          mine.received = seq;
          mine.queue.push({ seq, keys: (keys || 0) & 15, jab: (jab || 0) & 15 });
        }
        // Too far behind (a burst after a stall): drop the oldest, keeping
        // any jab one carried by handing it to the next.
        while (mine.queue.length > MAX_QUEUE) {
          const dropped = mine.queue.shift();
          if (dropped.jab && !mine.queue[0].jab) mine.queue[0].jab = dropped.jab;
        }
      });

      // { changes: { key: value, ... } } moves sliders; { reset: true } puts
      // every one back to the game's default.
      socket.on("jabble_settings", ({ roomId, changes, reset } = {}) => {
        const at = seated(socket, roomId);
        if (!at) return;
        const moved = reset ? resetSettings(at.room.jabble) : applySettings(at.room.jabble, changes);
        if (moved) emitState(roomId, at.room);
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
