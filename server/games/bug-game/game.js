// Bug Game: the socket layer. Rules live in ./engine.js.
//
// 1-4 humans, or one human against the bot. Opening the game makes you a table
// of your own (the lobby's solo room). While a table is still in setup, anyone
// sitting alone at theirs sees it in a list and can join it: their own room is
// dropped and they take the next seat. Everyone picks a bug, then the host
// (seat 0) starts. Alone, the host can instead play the bot 1v1: it takes a
// bug of its own and the game starts at once, who goes first at random.
//
// The bot (bot/bots.js, breeder5) works out its whole turn on a copy of the
// state, then its moves are replayed on the real one a beat apart, so the
// table sees the card land and each token go down.
//
// `room.bgSockets[seat]` is the socket in that seat, and `room.players` holds
// the same sockets so the lobby's leave/disconnect handling sees them all.
// Leaving during setup just frees the seat (unless it's the host's table to
// lose); once the deal is out, anyone leaving ends the game for everyone.
import {
  CARDS,
  DANCES,
  BUGS,
  MAX_SEATS,
  createState,
  addSeat,
  removeSeat,
  pickBug,
  canStart,
  start,
  layCard,
  layToken,
  completeDance,
  undo,
  chooseDance,
  endTurn,
  scoreOf
} from "./engine.js";
import * as E from "./engine.js";
import { BOTS, recordTurn } from "./bot/bots.js";

const BOT = BOTS.breeder5;
const BOT_THINK_MS = 900; // before the bot's first move
const BOT_STEP_MS = 750; // between its moves

let nextTable = 1;

function view(roomId, room, seat, tables) {
  const s = room.bugGame;
  const base = {
    roomId,
    table: room.bgTable,
    phase: s.phase,
    mySeat: seat,
    bugs: BUGS,
    maxSeats: MAX_SEATS,
    canStart: canStart(s),
    seats: s.seats.map((x, i) => ({ bug: x.bug, isBot: room.bgSockets[i] === null }))
  };
  if (s.phase === "setup") {
    // Only someone alone at their table can go and join another.
    return { ...base, tables: s.seats.length === 1 ? tables.filter((t) => t.roomId !== roomId) : [] };
  }
  return {
    ...base,
    cards: CARDS,
    dances: DANCES,
    placed: s.placed,
    tokens: s.tokens,
    // Cards are printed both sides: the pile's top card shows.
    pileTop: s.pile.length ? s.pile[0] : null,
    pileLeft: s.pile.length,
    total: CARDS.length,
    turn: s.turn,
    laid: s.laid,
    choosing: s.choosing,
    market: s.market,
    poopLeft: s.poopLeft,
    seats: s.seats.map((x, i) => ({
      bug: x.bug,
      isBot: room.bgSockets[i] === null,
      hand: x.hand,
      poop: x.poop,
      babies: x.babies,
      done: x.done,
      dance: x.dance, // open information
      score: scoreOf(s, i)
    })),
    canUndo: !!s.undo,
    log: s.log.slice(-8),
    gains: s.gains,
    result: s.result
  };
}

export function createBugGame({ io, rooms }) {
  const bugRooms = () => [...rooms.entries()].filter(([, room]) => room.gameId === "bug-game" && room.bugGame);

  const openTables = () =>
    bugRooms()
      .filter(([, room]) => room.bugGame.phase === "setup" && room.bgSockets.length < MAX_SEATS)
      .map(([roomId, room]) => ({ roomId, table: room.bgTable, seated: room.bgSockets.length }));

  function send(roomId, room, tables = openTables()) {
    room.bgSockets.forEach((socketId, seat) => {
      if (socketId) io.to(socketId).emit("state_update", { bugGame: view(roomId, room, seat, tables), turn: null });
    });
  }

  // If it's the bot's turn, work the turn out and play it a move at a time.
  function maybeBot(roomId, room) {
    const s = room.bugGame;
    const seat = room.bgSockets.indexOf(null);
    if (seat === -1 || room.bgBotBusy || s.phase !== "play" || s.turn !== seat) return;
    room.bgBotBusy = true;
    const live = () => rooms.get(roomId) === room && room.bugGame === s;
    setTimeout(() => {
      if (!live()) return;
      let moves;
      try {
        const copy = JSON.parse(JSON.stringify(s));
        copy.noUndo = true;
        moves = recordTurn(BOT, copy, seat);
      } catch (err) {
        console.error("bug game bot:", err);
        moves = [];
      }
      moves.push(["endTurn", [seat]]);
      const step = () => {
        if (!live()) return;
        const [name, args] = moves.shift();
        if (!E[name](s, ...args) && name === "endTurn") {
          // Should never happen; don't leave the table stuck on the bot.
          console.error("bug game bot: could not end its turn");
        }
        send(roomId, room);
        if (moves.length) return setTimeout(step, BOT_STEP_MS);
        room.bgBotBusy = false;
        maybeBot(roomId, room);
      };
      step();
    }, BOT_THINK_MS);
  }

  // Every table still in setup shows the list of the others, so any change to
  // one of them goes out to all of them.
  function sendSetupTables() {
    const tables = openTables();
    for (const [roomId, room] of bugRooms()) if (room.bugGame.phase === "setup") send(roomId, room, tables);
  }

  function emitState(roomId, room) {
    if (!room.bugGame) return;
    if (!room.bgSockets) {
      room.bgSockets = [room.players[0]];
      room.players = [room.players[0]];
      room.bgTable = nextTable++;
      addSeat(room.bugGame);
    }
    send(roomId, room);
    if (room.bugGame.phase === "setup") sendSetupTables();
  }

  // The room and seat this socket plays in.
  function seatOf(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "bug-game" || !room.bugGame || !room.bgSockets) return null;
    const seat = room.bgSockets.indexOf(socket.id);
    return seat === -1 || !socket.id ? null : { room, seat, s: room.bugGame };
  }

  function on(socket, event, fn) {
    socket.on(event, (payload = {}, ack) => {
      const at = seatOf(socket, payload.roomId);
      const ok = at ? !!fn(at, payload) : false;
      if (ok) {
        send(payload.roomId, at.room);
        if (at.s.phase === "setup" || event === "bug_game_start" || event === "bug_game_bot") sendSetupTables();
        maybeBot(payload.roomId, at.room);
      }
      if (typeof ack === "function") ack({ ok });
    });
  }

  // Free a seat at a table still in setup. Returns whether it did.
  function leaveSetup(socket) {
    for (const [roomId, room] of bugRooms()) {
      const seat = room.bgSockets?.indexOf(socket.id) ?? -1;
      if (seat <= 0 || room.bugGame.phase !== "setup") continue; // the host's leaving closes the table
      removeSeat(room.bugGame, seat);
      room.bgSockets.splice(seat, 1);
      room.players = [...room.bgSockets];
      socket.leave(roomId);
      send(roomId, room);
      return true;
    }
    return false;
  }

  return {
    id: "bug-game",

    createRoomState() {
      return { bugGame: createState() };
    },

    emitState,

    registerHandlers(socket) {
      socket.on("bug_game_join", ({ roomId, target } = {}) => {
        const mine = seatOf(socket, roomId);
        const there = rooms.get(target);
        if (!mine || mine.room.bgSockets.length !== 1 || mine.s.phase !== "setup") return;
        if (!there || there.gameId !== "bug-game" || !there.bgSockets || there.bugGame.phase !== "setup") return;
        if (!addSeat(there.bugGame)) return;
        rooms.delete(roomId);
        socket.leave(roomId);
        socket.join(target);
        there.bgSockets.push(socket.id);
        there.players = [...there.bgSockets];
        sendSetupTables();
      });

      // These run before the lobby's own handlers, which would otherwise close
      // the table on anyone leaving it.
      // Either way the open-table lists change, so they go out again once the
      // lobby has had its turn.
      const gone = () => {
        leaveSetup(socket);
        setImmediate(sendSetupTables);
      };
      socket.on("leave_room", gone);
      socket.on("disconnect", gone);

      on(socket, "bug_game_pick", ({ s, seat }, { bug }) => pickBug(s, seat, bug));
      // Alone at the table with a bug picked: play the bot, 1v1.
      on(socket, "bug_game_bot", ({ room, s, seat }) => {
        if (seat !== 0 || s.phase !== "setup" || s.seats.length !== 1 || !s.seats[0].bug) return false;
        const free = BUGS.filter((b) => b !== s.seats[0].bug);
        addSeat(s);
        pickBug(s, 1, free[Math.floor(Math.random() * free.length)]);
        room.bgSockets.push(null);
        return start(s);
      });
      on(socket, "bug_game_start", ({ s, seat }) => seat === 0 && canStart(s) && start(s));
      on(socket, "bug_game_again", ({ s, seat }) => seat === 0 && s.phase === "over" && start(s));
      on(socket, "bug_game_card", ({ s, seat }, move) => layCard(s, seat, move));
      on(socket, "bug_game_token", ({ s, seat }, move) => layToken(s, seat, move));
      on(socket, "bug_game_complete", ({ s, seat }) => completeDance(s, seat));
      on(socket, "bug_game_undo", ({ s, seat }) => undo(s, seat));
      on(socket, "bug_game_choose", ({ s, seat }, { slot }) => chooseDance(s, seat, slot));
      on(socket, "bug_game_end", ({ s, seat }) => endTurn(s, seat));
    }
  };
}
