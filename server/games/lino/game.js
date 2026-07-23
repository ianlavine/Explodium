// Lino: real-time line building. The field starts with a scatter of dots;
// every player earns $1 of game currency each 0.5s and spends it building
// lines between dots. Line cost scales linearly with the distance between
// the two dots. No turns — both players act whenever they can afford to.

// Board coordinate space (the client renders it as an SVG viewBox).
const WIDTH = 160;
const HEIGHT = 100;
const MARGIN = 6;

const DOT_COUNT = 40;
const MIN_SPACING = 8; // rejection-sampling distance between dots

const COST_PER_UNIT = 1; // dollars per board unit of length
const INCOME_MS = 500;
const INCOME_AMOUNT = 1;
const STARTING_MONEY = 15;

function generateDots() {
  const dots = [];
  let attempts = 0;
  while (dots.length < DOT_COUNT && attempts < 5000) {
    attempts += 1;
    const x = MARGIN + Math.random() * (WIDTH - MARGIN * 2);
    const y = MARGIN + Math.random() * (HEIGHT - MARGIN * 2);
    const tooClose = dots.some((dot) => Math.hypot(dot.x - x, dot.y - y) < MIN_SPACING);
    if (tooClose) continue;
    dots.push({ id: `d${dots.length}`, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return dots;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lineCost(a, b) {
  return Math.max(1, Math.ceil(distance(a, b) * COST_PER_UNIT));
}

function lineKey(fromId, toId) {
  return [fromId, toId].sort().join(":");
}

function createLinoState() {
  return {
    dots: generateDots(),
    lines: [],
    lineKeys: new Set(),
    money: [STARTING_MONEY, STARTING_MONEY]
  };
}

export function createLinoGame({ io, rooms }) {
  const incomeTimers = new Map(); // roomId -> interval handle

  function stopIncome(roomId) {
    const timer = incomeTimers.get(roomId);
    if (timer) clearInterval(timer);
    incomeTimers.delete(roomId);
  }

  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      lino: {
        dots: room.lino.dots,
        lines: room.lino.lines,
        money: room.lino.money,
        costPerUnit: COST_PER_UNIT
      },
      turn: room.turn
    });
  }

  return {
    id: "lino",

    createRoomState() {
      return { lino: createLinoState() };
    },

    emitState,

    // The lobby deletes rooms directly on disconnect/leave, so the income
    // loop re-checks the room each tick and shuts itself down when it's gone.
    onRoomCreated(roomId) {
      stopIncome(roomId);
      incomeTimers.set(
        roomId,
        setInterval(() => {
          const room = rooms.get(roomId);
          if (!room || room.gameId !== "lino") {
            stopIncome(roomId);
            return;
          }
          room.lino.money[0] += INCOME_AMOUNT;
          room.lino.money[1] += INCOME_AMOUNT;
          io.to(roomId).emit("lino_tick", { money: room.lino.money });
        }, INCOME_MS)
      );
    },

    registerHandlers(socket) {
      socket.on("lino_build", ({ roomId, fromId, toId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "lino") return;
        const seat = room.players.indexOf(socket.id);
        if (seat === -1) return;
        if (fromId === toId) return;

        const from = room.lino.dots.find((dot) => dot.id === fromId);
        const to = room.lino.dots.find((dot) => dot.id === toId);
        if (!from || !to) return;

        const key = lineKey(fromId, toId);
        if (room.lino.lineKeys.has(key)) return;

        const cost = lineCost(from, to);
        if (room.lino.money[seat] < cost) return;

        room.lino.money[seat] -= cost;
        room.lino.lineKeys.add(key);
        room.lino.lines.push({
          id: `l${room.lino.lines.length}`,
          from: fromId,
          to: toId,
          player: seat,
          cost
        });
        emitState(roomId, room);
      });
    }
  };
}
