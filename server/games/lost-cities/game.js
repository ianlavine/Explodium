// Lost Cities: the socket layer. Rules live in ./engine.js, the bot in ./bot.js.
//
// Two seats, online or against the bot (always seat 1). Each seat is sent only
// its own hand; the other hand is a count until the round ends, when both are
// turned over. A deck draw is private to whoever drew it, a discard draw is
// public, exactly as at a real table. The bot plays its card and draws as two
// visible steps, a beat apart, so its turn can be followed.
import { createMatch, normalizeSettings, playCard, drawCard, nextRound, matchWinner } from "./engine.js";
import { LOST_CITIES_BOT_ID, BOT_LEVELS, choosePlay, chooseDraw } from "./bot.js";

const BOT_SEAT = 1;
const BOT_DEFAULT_LEVEL = 2;
const SCALE = Number(process.env.LC_DELAY_SCALE ?? 1);
const DELAY = { play: 900, draw: 750 };

const hidden = (entry, you) => entry && entry.seat !== you && entry.from === "deck";

function view(room, you) {
  const m = room.lostCities;
  const opp = 1 - you;
  const over = m.phase === "roundOver" || m.phase === "matchOver";
  const names = [0, 1].map((seat) =>
    seat === you ? "You" : room.isBot ? BOT_LEVELS[room.botLevel]?.name ?? "Bot" : "Opponent"
  );
  return {
    you,
    names,
    vsBot: !!room.isBot,
    settings: m.settings,
    round: m.round,
    totals: m.totals,
    history: m.history,
    phase: m.phase,
    toMove: m.toMove,
    starter: m.starter,
    justDiscarded: m.justDiscarded,
    hand: m.hands[you],
    oppHand: over ? m.hands[opp] : null,
    oppHandCount: m.hands[opp].length,
    deck: m.deck.length,
    expeditions: m.expeditions,
    discards: m.discards.map((pile) => ({ top: pile.length ? pile[pile.length - 1] : null, count: pile.length })),
    lastPlay: m.lastPlay,
    lastDraw: hidden(m.lastDraw, you) ? { ...m.lastDraw, card: null } : m.lastDraw,
    log: m.log.slice(-14).map((entry) => (hidden(entry, you) ? { ...entry, card: null } : entry)),
    result: m.roundResult,
    ready: m.ready,
    winner: matchWinner(m)
  };
}

export function createLostCitiesGame({ io, rooms }) {
  const seatOf = (room, socketId) => room.players.indexOf(socketId);

  function syncTurn(room) {
    const m = room.lostCities;
    room.turn = m.toMove === null ? null : room.players[m.toMove];
  }

  function emitState(roomId, room) {
    if (!room.lostCities) return;
    room.players.forEach((socketId, seat) => {
      if (socketId === LOST_CITIES_BOT_ID) return;
      io.to(socketId).emit("state_update", { lostCities: view(room, seat), turn: room.turn });
    });
  }

  function scheduleBot(roomId, room) {
    if (!room.isBot || room.lcBotTimer) return;
    const m = room.lostCities;
    if (m.toMove !== BOT_SEAT || (m.phase !== "play" && m.phase !== "draw")) return;
    room.lcBotTimer = setTimeout(() => {
      room.lcBotTimer = null;
      if (rooms.get(roomId) !== room) return;
      const match = room.lostCities;
      if (match.toMove !== BOT_SEAT) return;
      try {
        if (match.phase === "play") {
          const move = choosePlay(match, BOT_SEAT, room.botLevel);
          if (playCard(match, BOT_SEAT, move.card, move.to)) playCard(match, BOT_SEAT, match.hands[BOT_SEAT][0], "discard");
        } else if (match.phase === "draw") {
          const move = chooseDraw(match, BOT_SEAT, room.botLevel);
          if (drawCard(match, BOT_SEAT, move.from)) drawCard(match, BOT_SEAT, "deck");
        }
      } catch (err) {
        // A bot that throws must not stall the table: fall back to the plainest
        // legal move, which always exists.
        console.error("lost-cities bot", err);
        if (match.phase === "play") playCard(match, BOT_SEAT, match.hands[BOT_SEAT][0], "discard");
        else if (match.phase === "draw") drawCard(match, BOT_SEAT, "deck");
      }
      if (match.phase === "roundOver" || match.phase === "matchOver") match.ready[BOT_SEAT] = true;
      syncTurn(room);
      emitState(roomId, room);
      scheduleBot(roomId, room);
    }, (m.phase === "play" ? DELAY.play : DELAY.draw) * SCALE);
  }

  function after(roomId, room) {
    const m = room.lostCities;
    if (room.isBot && (m.phase === "roundOver" || m.phase === "matchOver")) m.ready[BOT_SEAT] = true;
    syncTurn(room);
    emitState(roomId, room);
    scheduleBot(roomId, room);
  }

  function roomFor(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "lost-cities" || !room.lostCities) return null;
    const seat = seatOf(room, socket.id);
    return seat === -1 ? null : { room, seat };
  }

  return {
    id: "lost-cities",

    createRoomState(options) {
      return { lostCities: createMatch(normalizeSettings(options?.settings)), lcBotTimer: null };
    },

    onRoomCreated(roomId, room) {
      syncTurn(room);
    },

    emitState,

    bot: {
      id: LOST_CITIES_BOT_ID,
      normalizeLevel(level) {
        return BOT_LEVELS[level] ? level : BOT_DEFAULT_LEVEL;
      },
      onRoomCreated(roomId, room) {
        scheduleBot(roomId, room);
      }
    },

    registerHandlers(socket) {
      socket.on("lc_play", ({ roomId, card, to } = {}) => {
        const found = roomFor(socket, roomId);
        if (!found) return;
        const { room, seat } = found;
        if (!Number.isInteger(card)) return;
        if (playCard(room.lostCities, seat, card, to)) return;
        after(roomId, room);
      });

      socket.on("lc_draw", ({ roomId, from } = {}) => {
        const found = roomFor(socket, roomId);
        if (!found) return;
        const { room, seat } = found;
        if (from !== "deck" && !Number.isInteger(from)) return;
        if (drawCard(room.lostCities, seat, from)) return;
        after(roomId, room);
      });

      // Between rounds, and after the last one, both seats say when they're
      // done looking; the bot is always done.
      socket.on("lc_ready", ({ roomId } = {}) => {
        const found = roomFor(socket, roomId);
        if (!found) return;
        const { room, seat } = found;
        const m = room.lostCities;
        if (m.phase !== "roundOver" && m.phase !== "matchOver") return;
        m.ready[seat] = true;
        if (room.isBot) m.ready[BOT_SEAT] = true;
        if (m.ready.every(Boolean)) {
          if (m.phase === "roundOver") nextRound(m);
          else room.lostCities = createMatch(m.settings);
        }
        after(roomId, room);
      });
    }
  };
}
