// Bug Game: the socket layer. Rules live in ./engine.js.
//
// 1-4 humans, no AI. Opening the game makes you a table of your own (the
// lobby's solo room). While a table is still in setup, anyone sitting alone at
// theirs sees it in a list and can join it: their own room is dropped and they
// take the next seat. Everyone picks a bug, then the host (seat 0) starts.
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
  swapDance,
  chooseDance,
  endTurn,
  scoreOf
} from "./engine.js";

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
    seats: s.seats.map((x) => ({ bug: x.bug }))
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
    current: s.pile.length ? s.pile[0] : null,
    pileLeft: s.pile.length,
    total: CARDS.length,
    turn: s.turn,
    laid: s.laid,
    choosing: s.choosing,
    market: s.market,
    poopLeft: s.poopLeft,
    seats: s.seats.map((x, i) => ({
      bug: x.bug,
      poop: x.poop,
      babies: x.babies,
      done: x.done,
      // Your own dance only; the others' stay face down.
      dance: i === seat ? x.dance : null,
      hasDance: x.dance !== null,
      score: scoreOf(s, i)
    })),
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
      io.to(socketId).emit("state_update", { bugGame: view(roomId, room, seat, tables), turn: null });
    });
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
    return seat === -1 ? null : { room, seat, s: room.bugGame };
  }

  function on(socket, event, fn) {
    socket.on(event, (payload = {}, ack) => {
      const at = seatOf(socket, payload.roomId);
      const ok = at ? !!fn(at, payload) : false;
      if (ok) {
        send(payload.roomId, at.room);
        if (at.s.phase === "setup" || event === "bug_game_start") sendSetupTables();
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
      on(socket, "bug_game_start", ({ s, seat }) => seat === 0 && canStart(s) && start(s));
      on(socket, "bug_game_again", ({ s, seat }) => seat === 0 && s.phase === "over" && start(s));
      on(socket, "bug_game_card", ({ s, seat }, move) => layCard(s, seat, move));
      on(socket, "bug_game_token", ({ s, seat }, move) => layToken(s, seat, move));
      on(socket, "bug_game_complete", ({ s, seat }) => completeDance(s, seat));
      on(socket, "bug_game_swap", ({ s, seat }) => swapDance(s, seat));
      on(socket, "bug_game_choose", ({ s, seat }, { slot }) => chooseDance(s, seat, slot));
      on(socket, "bug_game_end", ({ s, seat }) => endTurn(s, seat));
    }
  };
}
