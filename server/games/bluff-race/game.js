// Bluff Race: Coup Path laid out round, played like a real board game on a
// table. There are NO RULES here: the server only holds where things are --
// the pieces, the lost lives, the die, the deck, everyone's hand -- and keeps
// each hand private. The players move the pieces, make their claims, call
// each other out loud and take their own lives off, the way they would with
// the physical game.
//
// ONE TABLE. There's only ever one Bluff Race running: whoever opens the game
// sits down at it as it stands (the lobby's solo room is just the way in --
// it's dropped and the socket moves to the table's room). The first one in
// makes it; when the last one leaves it's gone.
//
// Seats: numbered (Player 1, 2, ...), up to five, held by a key the browser
// keeps, so a refresh sits you back down in your own seat with your own
// hand. Players have no colour. Leaving changes NOTHING on the table -- your
// seat and hand stay as they are, marked away. Someone new takes a new seat,
// then an empty one (and whatever was left in it); with all five taken
// they watch.
//
// The deck is always shuffled: a draw takes a random card from it, and a
// card returned just goes back in.
//
// Pieces belong to the table, not to the seats: five stacks of three discs,
// one a life. A disc taken off a stack goes to the LOST LIVES tray in the
// middle, stacked with that colour's other lost discs; a disc clicked there
// goes back to its stack, or starts a new one on the start. A game starts
// with every stack in the tray. Charged = the stack flipped over (only a
// stack on the board can be; one that runs out of discs isn't charged).
//
// `room.ct` is the table. `room.players` mirrors the connected sockets so the
// lobby's own leave/disconnect handling finds nothing left to close.

const COLORS = ["Blue", "Black", "Orange", "Purple", "Green"];
const CHARS = ["Sticky", "Zoomie", "Magician", "Thief", "Sheriff"];
const COPIES = 3;
const LIVES = 3;
const MAX_SEATS = 5;
const LOG_KEEP = 40;
const LOG_SENT = 14;

// The board: one letter a space -- S start, R backward, G forward, Y bonus,
// . blank, F finish (the Coup Path editor's codes). Default: board A2, the
// 60-space board the v10 rules were balanced on.
export const DEFAULT_BOARD = "SG.YRRYG.YYR.RYR.GRY..Y.G..GYG.GR.R.G.R.YGY.RYYR.GY.RY.RGYRF";
const MIN_SPACES = 20;
const MAX_SPACES = 80;

// A board code, tidied, or null if it isn't one. The ends are always the
// start and the finish, whatever letters a code has there.
function cleanBoard(code) {
  const s = String(code ?? "").replace(/\s+/g, "").toUpperCase();
  if (s.length < MIN_SPACES || s.length > MAX_SPACES) return null;
  const inner = s.slice(1, -1);
  if ([...inner].some((c) => !"RGY.".includes(c))) return null;
  return `S${inner}F`;
}

const charOf = (card) => CHARS[Math.floor(card / COPIES)];
const allCards = () => Array.from({ length: CHARS.length * COPIES }, (_, i) => i);

// Every stack in the tray, nothing on the board.
function freshPieces(t) {
  t.pieces = Object.fromEntries(COLORS.map((c) => [c, { space: null, x: null, y: null, lives: 0, charged: false }]));
  t.dead = Object.fromEntries(COLORS.map((c) => [c, LIVES]));
}

function createTable() {
  const t = {
    board: DEFAULT_BOARD,
    seats: [], // { n, key, socket (null while away), hand: [card], shown: [card] }
    nextSeat: 1,
    watchers: [], // sockets with no seat
    deck: allCards(), // in no order that matters: draws are random
    die: { value: 1, n: 0, by: null },
    log: [],
    logN: 0
  };
  freshPieces(t);
  return t;
}

// A log line; `fx` tells the pages what to animate (cards flying).
function say(t, text, fx = null) {
  t.logN += 1;
  t.log.push(fx ? { n: t.logN, text, ...fx } : { n: t.logN, text });
  if (t.log.length > LOG_KEEP) t.log.splice(0, t.log.length - LOG_KEEP);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const connected = (t) => [...t.seats.filter((s) => s.socket).map((s) => s.socket), ...t.watchers];
const who = (seat) => `Player ${seat.n}`;

// Sit a socket down: back in its own seat, else a new one, else an empty
// one; else it watches.
function sitDown(t, socket, key) {
  let seat = key ? t.seats.find((s) => s.key === key && !s.socket) : null;
  if (seat) {
    seat.socket = socket;
    say(t, `${who(seat)} is back.`);
    return;
  }
  if (t.seats.length < MAX_SEATS) {
    seat = { n: t.nextSeat++, key, socket, hand: [], shown: [] };
    t.seats.push(seat);
    say(t, `${who(seat)} sat down.`);
    return;
  }
  seat = t.seats.find((s) => !s.socket);
  if (seat) {
    seat.socket = socket;
    seat.key = key;
    say(t, `Someone took ${who(seat)}'s empty seat.`);
    return;
  }
  t.watchers.push(socket);
}

// Where a stack is put: onto a space, or (off the track) at a point.
function place(t, p, { space, x, y }) {
  const n = Math.floor(Number(space));
  if (n >= 1 && n <= t.board.length) {
    p.space = n;
    p.x = p.y = null;
    return n === 1 ? "the start" : n === t.board.length ? "the finish" : `space ${n}`;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  p.space = null;
  p.x = x;
  p.y = y;
  return "off the track";
}

function view(roomId, room, socketId) {
  const t = room.ct;
  const me = t.seats.find((s) => s.socket === socketId) ?? null;
  return {
    roomId,
    board: t.board,
    me: me?.n ?? null,
    deckCount: t.deck.length,
    die: t.die,
    log: t.log.slice(-LOG_SENT),
    seats: t.seats.map((s) => ({
      n: s.n,
      away: !s.socket,
      handCount: s.hand.length,
      // Cards turned face up are open to the whole table.
      shown: s.hand.filter((c) => s.shown.includes(c)).map((c) => ({ id: c, char: charOf(c) }))
    })),
    watchers: t.watchers.length,
    pieces: t.pieces,
    dead: t.dead,
    hand: me ? me.hand.map((c) => ({ id: c, char: charOf(c), up: me.shown.includes(c) })) : []
  };
}

export function createBluffRaceGame({ io, rooms }) {
  let tableId = null;
  const table = () => {
    const room = tableId ? rooms.get(tableId) : null;
    return room?.ct ? room : null;
  };

  function send(roomId, room) {
    for (const socketId of connected(room.ct)) {
      io.to(socketId).emit("state_update", { bluffRace: view(roomId, room, socketId), turn: null });
    }
  }

  // Called once for each new solo room (someone opening the game), and after
  // that whenever the lobby wants the table sent again.
  function emitState(roomId, room) {
    if (room.ct) return send(roomId, room);
    const socketId = room.players[0];
    let here = table();
    if (!here) {
      room.ct = createTable();
      tableId = roomId;
      here = room;
    } else {
      rooms.delete(roomId);
      const sock = io.sockets.sockets.get(socketId);
      sock?.leave(roomId);
      sock?.join(tableId);
    }
    sitDown(here.ct, socketId, room.ctKey || null);
    here.players = connected(here.ct);
    send(tableId, here);
  }

  function seatOf(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || roomId !== tableId || !room.ct || !socket.id) return null;
    const seat = room.ct.seats.find((s) => s.socket === socket.id);
    return seat ? { room, t: room.ct, seat } : null;
  }

  // A handler changes the table and returns true, or returns false to say
  // nothing happened (and nothing goes out). Watchers can't touch anything.
  function on(socket, event, fn) {
    socket.on(event, (payload = {}) => {
      const at = seatOf(socket, payload.roomId);
      if (!at) return;
      let ok = false;
      try {
        ok = fn(at, payload);
      } catch (err) {
        console.error(`bluff race ${event}:`, err);
      }
      if (ok) send(payload.roomId, at.room);
    });
  }

  // Leaving moves nothing: the seat waits, marked away. The last one out
  // closes the table.
  function leave(socket) {
    const room = table();
    if (!room) return;
    const t = room.ct;
    const seat = t.seats.find((s) => s.socket === socket.id);
    const watching = t.watchers.indexOf(socket.id);
    if (!seat && watching === -1) return;
    if (seat) seat.socket = null;
    else t.watchers.splice(watching, 1);
    room.players = connected(t);
    socket.leave(tableId);
    if (!room.players.length) {
      rooms.delete(tableId);
      tableId = null;
      return;
    }
    if (seat) say(t, `${who(seat)} left the table; their seat is kept.`);
    send(tableId, room);
  }

  const pieceOf = (t, color) => (COLORS.includes(color) ? t.pieces[color] : null);

  return {
    id: "bluff-race",

    // The browser's seat key rides in with the solo room.
    createRoomState(options) {
      return { ctKey: String(options?.key ?? "").slice(0, 64) };
    },

    emitState,

    registerHandlers(socket) {
      // These run before the lobby's own handlers, which would otherwise close
      // the table on anyone leaving it.
      socket.on("leave_room", () => leave(socket));
      socket.on("disconnect", () => leave(socket));

      on(socket, "bluff_race_roll", ({ t }) => {
        t.die = { value: 1 + Math.floor(Math.random() * 6), n: t.die.n + 1 };
        say(t, `Rolled a ${t.die.value}.`, { roll: t.die.n });
        return true;
      });

      // A random card out of the deck.
      on(socket, "bluff_race_draw", ({ t, seat }) => {
        if (!t.deck.length) return false;
        const [card] = t.deck.splice(Math.floor(Math.random() * t.deck.length), 1);
        seat.hand.push(card);
        say(t, `${who(seat)} drew a card.`, { draw: [seat.n] });
        return true;
      });

      on(socket, "bluff_race_return", ({ t, seat }, { card }) => {
        const i = seat.hand.indexOf(card);
        if (i === -1) return false;
        seat.hand.splice(i, 1);
        const wasShown = seat.shown.includes(card);
        seat.shown = seat.shown.filter((c) => c !== card);
        t.deck.push(card);
        say(t, `${who(seat)} returned ${wasShown ? charOf(card) : "a card"} to the deck.`, { back: seat.n });
        return true;
      });

      // Turn a card in your hand face up for the whole table, or back down.
      on(socket, "bluff_race_show", ({ t, seat }, { card, up }) => {
        if (!seat.hand.includes(card) || seat.shown.includes(card) === !!up) return false;
        if (up) seat.shown.push(card);
        else seat.shown = seat.shown.filter((c) => c !== card);
        say(t, up ? `${who(seat)} showed ${charOf(card)}.` : `${who(seat)} hid ${charOf(card)} again.`);
        return true;
      });

      // A stack on the board, onto a space or off the track.
      on(socket, "bluff_race_move", ({ t }, to) => {
        const p = pieceOf(t, to.color);
        if (!p || p.lives <= 0) return false;
        const was = `${p.space}|${p.x}|${p.y}`;
        const wasOff = p.space == null;
        const where = place(t, p, to);
        if (!where || was === `${p.space}|${p.x}|${p.y}`) return false;
        // Nudging a stack about off the track isn't worth a line.
        if (!(wasOff && where === "off the track")) say(t, `${to.color} moved to ${where}.`);
        return true;
      });

      // One disc off a stack, into the lost lives tray.
      on(socket, "bluff_race_lose", ({ t }, { color }) => {
        const p = pieceOf(t, color);
        if (!p || p.lives <= 0) return false;
        p.lives -= 1;
        t.dead[color] += 1;
        if (!p.lives) p.charged = false;
        say(t, `${color} lost a life (${p.lives} left).`);
        return true;
      });

      // One disc out of the tray, back onto its stack -- or onto the start
      // as a new stack, if that colour has none on the board.
      on(socket, "bluff_race_revive", ({ t }, { color }) => {
        const p = pieceOf(t, color);
        if (!p || t.dead[color] <= 0) return false;
        t.dead[color] -= 1;
        if (!p.lives) {
          place(t, p, { space: 1 });
          p.charged = false;
        }
        p.lives += 1;
        say(t, p.lives === 1 ? `${color} went on the start.` : `${color} got a life back (${p.lives} on the board).`);
        return true;
      });

      // A whole stack dropped in the tray.
      on(socket, "bluff_race_bury", ({ t }, { color }) => {
        const p = pieceOf(t, color);
        if (!p || p.lives <= 0) return false;
        t.dead[color] += p.lives;
        p.lives = 0;
        p.charged = false;
        say(t, `${color}'s whole stack went to the lost lives.`);
        return true;
      });

      // A colour's lost discs dragged out of the tray onto the board: they
      // join its stack, which stands where they were dropped.
      on(socket, "bluff_race_raise", ({ t }, to) => {
        const p = pieceOf(t, to.color);
        if (!p || t.dead[to.color] <= 0) return false;
        const k = t.dead[to.color];
        const fresh = !p.lives;
        const where = place(t, p, to);
        if (!where) return false;
        t.dead[to.color] = 0;
        p.lives += k;
        if (fresh) p.charged = false;
        say(t, `${to.color} went ${where === "off the track" ? "on the table" : `on ${where}`} (${plural(p.lives, "life")}).`);
        return true;
      });

      // Flip a stack over: charged one way up, not the other.
      on(socket, "bluff_race_charge", ({ t, seat }, { color, on: charged }) => {
        const p = pieceOf(t, color);
        if (!p || p.lives <= 0 || p.charged === !!charged) return false;
        p.charged = !!charged;
        say(t, charged ? `${color} was flipped: charged.` : `${color} was flipped back: not charged.`);
        return true;
      });

      // Everything back: every card in the deck, every stack in the tray.
      on(socket, "bluff_race_reset", ({ t, seat }) => {
        t.deck = allCards();
        for (const s of t.seats) {
          s.hand = [];
          s.shown = [];
        }
        freshPieces(t);
        t.die = { value: 1, n: t.die.n, by: null };
        say(t, `${who(seat)} reset the table.`);
        return true;
      });

      on(socket, "bluff_race_board", ({ t, seat }, { code }) => {
        const board = cleanBoard(code);
        if (!board || board === t.board) return false;
        t.board = board;
        for (const p of Object.values(t.pieces)) if (p.space != null) p.space = Math.min(p.space, board.length);
        say(t, `${who(seat)} changed the board (${board.length} spaces).`);
        return true;
      });
    }
  };
}
