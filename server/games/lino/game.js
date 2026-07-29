// Lino: real-time race to link two shrines. Both players build lines on a
// shared scatter of dots; the first to hold both shrines in one connected
// group wins. Income is continuous: your largest group pays $0.20 per dot per
// second (never less than $1/s), so consolidating your network is the economy.
// Lines may be cut by building a strictly longer line across them, paying for
// both.
//
// Rules/geometry live in public/games/lino/rules.js and are shared verbatim
// with the client, so previewed costs always match what the server enforces.
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  SHRINE_POSITIONS,
  distance,
  lineCost,
  evaluateBuild,
  resolveDestruction,
  sanitizeSettings,
  largestGroupSize,
  productionFor,
  quantizeMoney,
  MONEY_STEP,
  connectsShrines
} from "../../../public/games/lino/rules.js";
import { createLinoBot, normalizeBotLevel, LINO_BOT_ID } from "./bot.js";

const MARGIN = 6;
const MIN_SPACING = 8; // rejection-sampling distance between dots

// One income stream, paid continuously: production dollars per second, moved
// into the bank in whole $0.20 steps so stored money stays exactly divisible.
const MASTER_TICK_MS = 100;
const STARTING_MONEY = 15;

function generateDots(count) {
  const dots = SHRINE_POSITIONS.map((shrine) => ({ ...shrine, shrine: true }));
  let placed = 0;
  let attempts = 0;
  // Dart-throwing jams well before a full packing, so the budget scales with
  // the request rather than being a flat cap tuned to the old small board.
  const maxAttempts = count * 200;

  // Spacing is checked against a MIN_SPACING-sized grid, so each dart looks at
  // its nine neighbouring cells instead of the whole (now much longer) list.
  const grid = new Map(); // "col,row" -> dots in that cell
  const cellOf = (x, y) => `${Math.floor(x / MIN_SPACING)},${Math.floor(y / MIN_SPACING)}`;
  const tooClose = (x, y) => {
    const col = Math.floor(x / MIN_SPACING);
    const row = Math.floor(y / MIN_SPACING);
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        const bucket = grid.get(`${col + dc},${row + dr}`);
        if (bucket?.some((dot) => distance(dot, { x, y }) < MIN_SPACING)) return true;
      }
    }
    return false;
  };
  const index = (dot) => {
    const key = cellOf(dot.x, dot.y);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(dot);
  };
  dots.forEach(index);

  while (placed < count && attempts < maxAttempts) {
    attempts += 1;
    const x = MARGIN + Math.random() * (BOARD_WIDTH - MARGIN * 2);
    const y = MARGIN + Math.random() * (BOARD_HEIGHT - MARGIN * 2);
    if (tooClose(x, y)) continue;
    const dot = {
      id: `d${placed}`,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      shrine: false
    };
    dots.push(dot);
    index(dot);
    placed += 1;
  }
  return dots;
}

function createLinoState(options) {
  const settings = sanitizeSettings(options?.settings);
  return {
    dots: generateDots(settings.dotCount),
    lines: [],
    money: [STARTING_MONEY, STARTING_MONEY],
    winner: null,
    nextLineId: 1,
    settings
  };
}

export function createLinoGame({ io, rooms }) {
  const incomeTimers = new Map(); // roomId -> interval handle

  function stopIncome(roomId) {
    const timer = incomeTimers.get(roomId);
    if (timer) clearInterval(timer);
    incomeTimers.delete(roomId);
  }

  const bot = createLinoBot({
    rooms,
    applyBuild: (roomId, room, seat, fromId, toId) =>
      applyBuild(roomId, room, seat, fromId, toId),
    emitState: (roomId, room) => emitState(roomId, room)
  });

  function groupSizes(room) {
    return [largestGroupSize(room.lino.lines, 0), largestGroupSize(room.lino.lines, 1)];
  }

  function production(room) {
    const { lines, settings } = room.lino;
    return [productionFor(lines, 0, settings), productionFor(lines, 1, settings)];
  }

  // The one path by which a line ever gets built, for humans and the bot
  // alike. Returns whether the build actually happened.
  function applyBuild(roomId, room, seat, fromId, toId) {
    if (room.lino.winner !== null) return false;
    const result = evaluateBuild({
      dots: room.lino.dots,
      lines: room.lino.lines,
      seat,
      money: room.lino.money[seat],
      fromId,
      toId,
      settings: room.lino.settings
    });
    if (!result.ok) return false;

    room.lino.money[seat] = quantizeMoney(room.lino.money[seat] - result.cost);
    if (result.destroys.length) {
      // With destroyDots on this also takes out the end dots and the lines
      // hanging off them. The new line can never be caught: a line that
      // shares a dot with it is skipped as a crossing in the first place.
      const { lineIds, dotIds } = resolveDestruction({
        dots: room.lino.dots,
        lines: room.lino.lines,
        cutLineIds: result.destroys,
        settings: room.lino.settings
      });
      room.lino.lines = room.lino.lines.filter((line) => !lineIds.has(line.id));
      if (dotIds.size) {
        room.lino.dots = room.lino.dots.filter((dot) => !dotIds.has(dot.id));
      }
    }
    const from = room.lino.dots.find((dot) => dot.id === fromId);
    const to = room.lino.dots.find((dot) => dot.id === toId);
    room.lino.lines.push({
      id: `l${room.lino.nextLineId++}`,
      from: fromId,
      to: toId,
      player: seat,
      // What it costs an opponent to cut this line later. Normally its own
      // length. Under consumption it inherits the full price this build paid
      // (length + every strength it just consumed), so killers harden over
      // time — result.cost already equals lineCost when nothing was cut.
      cost: room.lino.settings.consumption
        ? result.cost
        : lineCost(from, to, room.lino.settings),
      len: result.length,
      // The kill tempers this line into brass: indestructible from here on.
      brass: !!result.becomesBrass
    });

    if (connectsShrines(room.lino.lines, seat)) {
      room.lino.winner = seat;
      stopIncome(roomId);
    }
    return true;
  }

  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      lino: {
        dots: room.lino.dots,
        lines: room.lino.lines,
        money: room.lino.money,
        groups: groupSizes(room),
        production: production(room),
        winner: room.lino.winner,
        settings: room.lino.settings
      },
      turn: room.turn
    });
  }

  return {
    id: "lino",

    createRoomState(options) {
      return { lino: createLinoState(options) };
    },

    emitState,

    // The lobby deletes rooms directly on disconnect/leave, so the income loop
    // re-checks the room each tick and shuts itself down when it's gone.
    onRoomCreated(roomId) {
      stopIncome(roomId);
      // Income is continuous — production dollars per second — but the bank
      // only ever moves in whole MONEY_STEP units, so each seat carries the
      // sub-step remainder here rather than letting it into `money`. That is
      // what keeps stored money exactly divisible by $0.20.
      const remainder = [0, 0];
      incomeTimers.set(
        roomId,
        setInterval(() => {
          const room = rooms.get(roomId);
          if (!room || room.gameId !== "lino") {
            stopIncome(roomId);
            return;
          }
          if (room.lino.winner !== null) {
            stopIncome(roomId);
            return;
          }
          const rates = production(room);
          let paid = false;

          for (let seat = 0; seat < 2; seat += 1) {
            // Count in whole steps: how many $0.20 units this tick earned.
            remainder[seat] += (rates[seat] * MASTER_TICK_MS) / 1000 / MONEY_STEP;
            const steps = Math.floor(remainder[seat] + 1e-9);
            if (steps <= 0) continue;
            remainder[seat] -= steps;
            room.lino.money[seat] = quantizeMoney(
              room.lino.money[seat] + steps * MONEY_STEP
            );
            paid = true;
          }

          if (paid) {
            io.to(roomId).emit("lino_tick", {
              money: room.lino.money,
              groups: groupSizes(room),
              production: rates
            });
          }
        }, MASTER_TICK_MS)
      );
    },

    registerHandlers(socket) {
      socket.on("lino_build", ({ roomId, fromId, toId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "lino") return;
        const seat = room.players.indexOf(socket.id);
        if (seat === -1) return;
        if (applyBuild(roomId, room, seat, fromId, toId)) emitState(roomId, room);
      });
    },

    bot: {
      id: LINO_BOT_ID,
      normalizeLevel: normalizeBotLevel,
      onRoomCreated(roomId) {
        bot.start(roomId);
      }
    }
  };
}
