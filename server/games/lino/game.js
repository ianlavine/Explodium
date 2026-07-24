// Lino: real-time race to link two shrines. Both players build lines on a
// shared scatter of dots; the first to hold both shrines in one connected
// group wins. Income is flat cash plus the size of your largest group, so
// consolidating your network is the economy. Lines may be cut by building a
// strictly longer line across them, paying for both.
//
// Rules/geometry live in public/games/lino/rules.js and are shared verbatim
// with the client, so previewed costs always match what the server enforces.
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  SHRINE_A_ID,
  SHRINE_B_ID,
  distance,
  lineCost,
  evaluateBuild,
  resolveDestruction,
  sanitizeSettings,
  largestGroupSize,
  connectsShrines
} from "../../../public/games/lino/rules.js";
import { createLinoBot, normalizeBotLevel, LINO_BOT_ID } from "./bot.js";

const MARGIN = 6;
const MIN_SPACING = 8; // rejection-sampling distance between dots

// Income clocks are per-match settings now; the room runs one fast master
// tick and pays each stream whenever its own period has elapsed.
const MASTER_TICK_MS = 100;
const BASE_INCOME = 1;
const STARTING_MONEY = 15;

// Shrines sit on opposite edges, level with each other: both players race for
// the same pair, so the map is identical for each of them.
const SHRINE_POSITIONS = [
  { id: SHRINE_A_ID, x: 10, y: BOARD_HEIGHT / 2 },
  { id: SHRINE_B_ID, x: BOARD_WIDTH - 10, y: BOARD_HEIGHT / 2 }
];

function generateDots(count) {
  const dots = SHRINE_POSITIONS.map((shrine) => ({ ...shrine, shrine: true }));
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < 8000) {
    attempts += 1;
    const x = MARGIN + Math.random() * (BOARD_WIDTH - MARGIN * 2);
    const y = MARGIN + Math.random() * (BOARD_HEIGHT - MARGIN * 2);
    if (dots.some((dot) => distance(dot, { x, y }) < MIN_SPACING)) continue;
    dots.push({
      id: `d${placed}`,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      shrine: false
    });
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

    room.lino.money[seat] -= result.cost;
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
      // What it costs an opponent to cut this line later: its own length,
      // never the surcharge paid for the cuts this build made.
      cost: lineCost(from, to, room.lino.settings),
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
      // Two independent income clocks (both per-match settings) run off one
      // master tick; an emit goes out only on ticks where money moved.
      let baseAcc = 0;
      let groupAcc = 0;
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
          const settings = room.lino.settings;
          const baseMs = Math.max(MASTER_TICK_MS, settings.baseIncomeSecs * 1000);
          const groupMs = Math.max(MASTER_TICK_MS, settings.groupIncomeSecs * 1000);
          let paid = false;

          baseAcc += MASTER_TICK_MS;
          if (baseAcc >= baseMs) {
            const times = Math.floor(baseAcc / baseMs);
            baseAcc -= times * baseMs;
            room.lino.money[0] += BASE_INCOME * times;
            room.lino.money[1] += BASE_INCOME * times;
            paid = true;
          }

          groupAcc += MASTER_TICK_MS;
          if (groupAcc >= groupMs) {
            const times = Math.floor(groupAcc / groupMs);
            groupAcc -= times * groupMs;
            const groups = groupSizes(room);
            room.lino.money[0] += groups[0] * times;
            room.lino.money[1] += groups[1] * times;
            paid = true;
          }

          if (paid) {
            io.to(roomId).emit("lino_tick", {
              money: room.lino.money,
              groups: groupSizes(room)
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
