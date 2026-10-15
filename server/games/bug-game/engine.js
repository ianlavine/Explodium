// Bug Game (Topsoil): the rules. The socket layer is ./game.js; the rulebook
// is public/games/bug-game/Topsoil rules.txt. Regular version only — the four
// special bug abilities are not in.
//
// Soil cards are 3-wide, 4-tall grids. One starts in the middle and everyone
// is dealt one, face up. On your turn you must lay the card you hold, turned
// and/or mirrored, snapped to the grid, and you draw the next at the END of
// your turn. Cards are printed both sides, so every held card and the top of
// the pile are open — you always know the card you'll draw. The BOARD is every card cell plus every token cell — a token laid
// off the cards extends it. A card has to overlap a card or share a side with
// the board (a corner doesn't count), and may never cover a showing rock or
// any token. Laying one of YOUR bugs exactly on a showing sprout (consume)
// earns a poop token; on a showing bug of your own (reproduce) earns a baby
// bug token. Tokens go down any time on your turn, on a free board cell that
// isn't showing another PLAYER's bug, or on an empty cell sharing a side with
// the board, and stay put. A poop token can be laid rock side up instead. A
// baby is one of your bugs in every way — including that laying it on a
// sprout or on your own bug consumes or reproduces — except it can never be
// covered.
//
// Everyone's dance is open. Starting dances are the four 3-pointers. The
// player on turn may take back their most recent action (one step only).
// When the pile runs out, players play the card they hold without drawing;
// the game ends once every card is down.
//
// Scoring, per player: every one of your bugs on top (baby tokens included)
// is 1; each of those next to a poop token is +2; groups of 2+ score (number
// of groups) x (size of the biggest); plus the colony dances completed. Ties
// go to more bugs on top.
//
// Soil rows read top to bottom, as printed:
//   S scorpion   R roach   P pill bug   G spider   X rock   L sprout   . empty
// Card n is cards/card-nn.jpg in the client folder (IMG_4018+n in bug-files).
export const CARDS = [
  ["..S", "SLR", "PG.", ".X."],
  ["GLP", ".S.", "X..", "R.."],
  ["G.S", ".X.", ".X.", "PLR"],
  ["..R", "P.X", ".P.", "GLS"],
  ["...", "GSX", "X..", "PSR"],
  ["X.R", "P..", ".RP", "GLS"],
  ["LP.", ".S.", "XGL", "..R"],
  ["RLS", ".G.", "...", "X.P"],
  ["P..", "LXR", "RG.", "XS."],
  [".GL", ".XP", "S.X", "LR."],
  ["..X", "SR.", "GP.", "..L"],
  ["X..", "LP.", "RX.", ".GS"],
  ["R.X", "SLG", "...", "P.."],
  ["..G", "RLS", "GP.", "X.S"],
  [".P.", ".GX", "L.P", "RGS"],
  ["..G", "LP.", "RS.", "X.."],
  ["G.X", "...", "P..", "LRS"],
  ["P.R", "XSL", "G.G", "..."],
  ["..P", "RX.", "S.G", "..."],
  ["...", "XPL", "GSR", "..."],
  ["GLP", ".R.", "RXS", "..."],
  ["S.X", "...", ".R.", "PLG"],
  [".SG", ".LP", ".R.", "X.."],
  ["XP.", ".LR", "...", "SLG"],
  ["RL.", ".GL", "S..", "PX."]
];

// Colony dances, transcribed from IMG_3778..3797: the [row, col] cells of the
// printed 6-wide, 4-tall grid that must be your bugs. Any turn or mirror.
export const DANCES = [
  { pts: 5, cells: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { pts: 5, cells: [[1, 1], [1, 4], [2, 1], [2, 4]] },
  { pts: 5, cells: [[1, 2], [1, 4], [2, 1], [2, 3]] },
  { pts: 5, cells: [[1, 1], [2, 2], [2, 3], [3, 4]] },
  { pts: 5, cells: [[0, 3], [0, 4], [2, 1], [2, 3]] },
  { pts: 5, cells: [[1, 2], [1, 3], [2, 1], [2, 4]] },
  { pts: 5, cells: [[1, 2], [1, 4], [2, 0], [2, 2]] },
  { pts: 5, cells: [[0, 2], [1, 1], [1, 3], [2, 2]] },
  { pts: 5, cells: [[0, 2], [1, 2], [2, 1], [2, 3]] },
  { pts: 5, cells: [[0, 4], [1, 1], [1, 2], [2, 4]] },
  { pts: 5, cells: [[0, 1], [0, 3], [2, 1], [2, 3]] },
  { pts: 5, cells: [[0, 3], [1, 1], [1, 4], [2, 3]] },
  { pts: 5, cells: [[1, 0], [1, 2], [1, 4], [3, 2]] },
  { pts: 5, cells: [[1, 1], [1, 3], [2, 0], [2, 4]] },
  { pts: 5, cells: [[1, 3], [2, 1], [2, 2], [2, 4]] },
  { pts: 5, cells: [[1, 1], [1, 2], [2, 3], [2, 4]] },
  { pts: 3, cells: [[1, 1], [2, 2], [2, 3]] },
  { pts: 3, cells: [[1, 3], [2, 2], [2, 4]] },
  { pts: 3, cells: [[1, 1], [1, 3], [1, 4]] },
  { pts: 3, cells: [[1, 2], [2, 2], [2, 4]] }
];

export const BUGS = ["S", "R", "P", "G"];
export const MAX_SEATS = 4;
const ROCK = "X";
const SPROUT = "L";
const POOP_TOKENS = 26;
const BABIES_PER_BUG = 6;
const MARKET = 3;
const LIMIT = 80; // how far from the start card anything may go
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const key = (x, y) => `${x},${y}`;

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// A card's grid mirrored left-right (if asked), then turned `rot` quarter
// turns clockwise, as an array of rows.
export function oriented(cardIndex, rot, mirror) {
  let g = CARDS[cardIndex].map((row) => row.split(""));
  if (mirror) g = g.map((row) => [...row].reverse());
  for (let k = 0; k < rot; k += 1) {
    const h = g.length;
    const w = g[0].length;
    g = Array.from({ length: w }, (_, y) => Array.from({ length: h }, (_, x) => g[h - 1 - x][y]));
  }
  return g;
}

// The symbol of the topmost card in each cell: "x,y" -> symbol.
export function topCells(placed) {
  const top = new Map();
  for (const p of placed) {
    oriented(p.card, p.rot, p.mirror).forEach((row, dy) =>
      row.forEach((sym, dx) => top.set(key(p.x + dx, p.y + dy), sym))
    );
  }
  return top;
}

const tokenMap = (tokens) => new Map(tokens.map((t) => [key(t.x, t.y), t]));

// Does (x, y) share a side with the board (a card cell or a token)?
const besideBoard = (top, tokens, x, y) =>
  SIDES.some(([sx, sy]) => top.has(key(x + sx, y + sy)) || tokens.has(key(x + sx, y + sy)));

// Why a card can't go here, or null if it can.
export function cardProblem(state, cardIndex, x, y, rot, mirror) {
  const top = topCells(state.placed);
  const tokens = tokenMap(state.tokens);
  let connected = false;
  const grid = oriented(cardIndex, rot, mirror);
  for (let dy = 0; dy < grid.length; dy += 1) {
    for (let dx = 0; dx < grid[0].length; dx += 1) {
      const k = key(x + dx, y + dy);
      if (tokens.has(k)) return "token";
      const below = top.get(k);
      if (below === ROCK) return "rock";
      if (below !== undefined || besideBoard(top, tokens, x + dx, y + dy)) connected = true;
    }
  }
  return connected ? null : "apart";
}

// Why a token can't go here, or null if it can. Bugs belonging to no player
// may be covered; another player's may not. Off the cards it needs a side on
// the board.
export function tokenProblem(state, seat, x, y) {
  if (Math.abs(x) > LIMIT || Math.abs(y) > LIMIT) return "far";
  const top = topCells(state.placed);
  const tokens = tokenMap(state.tokens);
  if (tokens.has(key(x, y))) return "token";
  const sym = top.get(key(x, y));
  if (sym === undefined) return besideBoard(top, tokens, x, y) ? null : "far";
  const owner = state.seats.findIndex((s) => s.bug === sym);
  if (owner !== -1 && owner !== seat) return "opponent";
  return null;
}

// Every cell where this bug shows on top: card cells not under a token, plus
// its baby tokens.
export function bugCells(state, bug) {
  const top = topCells(state.placed);
  const tokens = tokenMap(state.tokens);
  const cells = new Set();
  for (const [k, sym] of top) if (sym === bug && !tokens.has(k)) cells.add(k);
  for (const t of state.tokens) if (t.type === "baby" && t.bug === bug) cells.add(key(t.x, t.y));
  return cells;
}

export function scoreOf(state, seat) {
  const bug = state.seats[seat].bug;
  const cells = bugCells(state, bug);
  const poops = new Set(state.tokens.filter((t) => t.type === "poop").map((t) => key(t.x, t.y)));
  const at = (k) => k.split(",").map(Number);
  let poop = 0;
  for (const k of cells) {
    const [x, y] = at(k);
    if (SIDES.some(([sx, sy]) => poops.has(key(x + sx, y + sy)))) poop += 2;
  }
  // Groups: orthogonally connected, two or more.
  const seen = new Set();
  const sizes = [];
  for (const k of cells) {
    if (seen.has(k)) continue;
    let size = 0;
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const [x, y] = at(stack.pop());
      size += 1;
      for (const [sx, sy] of SIDES) {
        const n = key(x + sx, y + sy);
        if (cells.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    if (size >= 2) sizes.push(size);
  }
  const group = sizes.length ? sizes.length * Math.max(...sizes) : 0;
  const dance = state.seats[seat].done.reduce((sum, d) => sum + DANCES[d].pts, 0);
  return { bugs: cells.size, poop, group, dance, total: cells.size + poop + group + dance };
}

// The 8 turns and mirrors of a dance, each shifted to start at 0,0.
function danceShapes(index) {
  const shapes = [];
  let cells = DANCES[index].cells.map(([r, c]) => [c, r]);
  for (let m = 0; m < 2; m += 1) {
    for (let r = 0; r < 4; r += 1) {
      const minX = Math.min(...cells.map((p) => p[0]));
      const minY = Math.min(...cells.map((p) => p[1]));
      shapes.push(cells.map(([x, y]) => [x - minX, y - minY]));
      cells = cells.map(([x, y]) => [-y, x]);
    }
    cells = cells.map(([x, y]) => [-x, y]);
  }
  return shapes;
}

export function danceMade(state, seat, index) {
  const cells = bugCells(state, state.seats[seat].bug);
  const mine = [...cells].map((k) => k.split(",").map(Number));
  return danceShapes(index).some((shape) =>
    mine.some(([ax, ay]) => {
      const [fx, fy] = shape[0];
      return shape.every(([x, y]) => cells.has(key(ax - fx + x, ay - fy + y)));
    })
  );
}

// --- the game -------------------------------------------------------------------

export function createState() {
  return { phase: "setup", seats: [] };
}

export function addSeat(state) {
  if (state.phase !== "setup" || state.seats.length >= MAX_SEATS) return false;
  state.seats.push({ bug: null });
  return true;
}

export function removeSeat(state, seat) {
  if (state.phase !== "setup") return false;
  state.seats.splice(seat, 1);
  return true;
}

export function pickBug(state, seat, bug) {
  if (state.phase !== "setup" || !BUGS.includes(bug)) return false;
  if (state.seats.some((s, i) => i !== seat && s.bug === bug)) return false;
  state.seats[seat].bug = bug;
  return true;
}

export function canStart(state) {
  return state.phase === "setup" && state.seats.length > 0 && state.seats.every((s) => s.bug);
}

// Deals a game for the seats as they stand.
export function start(state) {
  if (!canStart(state) && state.phase !== "over") return false;
  const pile = shuffle(CARDS.map((_, i) => i));
  // Everyone starts on a 3-pointer; the 3s left over go into the pile.
  const threes = shuffle(DANCES.map((_, i) => i).filter((i) => DANCES[i].pts === 3));
  const starting = threes.splice(0, state.seats.length);
  const dances = shuffle([...threes, ...DANCES.map((_, i) => i).filter((i) => DANCES[i].pts !== 3)]);
  state.phase = "play";
  state.placed = [{ card: pile.shift(), x: 0, y: 0, rot: 0, mirror: false }];
  state.pile = pile;
  state.tokens = [];
  state.poopLeft = POOP_TOKENS;
  state.babiesLeft = Object.fromEntries(BUGS.map((b) => [b, BABIES_PER_BUG]));
  for (const s of state.seats) {
    s.hand = pile.shift();
    s.poop = 1;
    s.babies = 1;
    state.poopLeft -= 1;
    state.babiesLeft[s.bug] -= 1;
    s.dance = starting.shift();
    s.done = [];
  }
  state.dancePile = dances;
  state.market = dances.splice(0, MARKET);
  // "The person who last saw a bug gets to go first."
  state.turn = Math.floor(Math.random() * state.seats.length);
  state.laid = false; // has the player on turn laid their soil card yet
  state.choosing = false; // must take a dance from the market before anything else
  state.log = [];
  state.gains = null;
  state.undo = null;
  state.result = null;
  return true;
}

const say = (state, seat, text) => {
  state.log.push({ seat, text });
  if (state.log.length > 40) state.log.shift();
};

const onTurn = (state, seat) => state.phase === "play" && state.turn === seat && !state.choosing;

// --- undo: one step, the player on turn's most recent action -------------------

const UNDOABLE = ["placed", "pile", "tokens", "poopLeft", "babiesLeft", "seats", "dancePile", "market", "laid", "choosing", "log"];

// Called by each action just before it changes anything. `state.noUndo` (the
// bot lab) skips the copying.
function remember(state) {
  if (state.noUndo) return;
  state.undo = JSON.stringify(Object.fromEntries(UNDOABLE.map((k) => [k, state[k]])));
}

export function undo(state, seat) {
  if (state.phase !== "play" || state.turn !== seat || !state.undo) return false;
  Object.assign(state, JSON.parse(state.undo));
  state.undo = null;
  // A fresh, empty batch, so no client replays the gains it just took back.
  state.gains = { n: (state.gains?.n ?? 0) + 1, seat, items: [] };
  return true;
}

// Tokens earned this action, and the cells that made them.
function gain(state, seat, eaten, bred) {
  const s = state.seats[seat];
  const bug = s.bug;
  const poops = Math.min(eaten.length, state.poopLeft);
  const babies = Math.min(bred.length, state.babiesLeft[bug]);
  s.poop += poops;
  state.poopLeft -= poops;
  s.babies += babies;
  state.babiesLeft[bug] -= babies;
  if (eaten.length) say(state, seat, `consumed ${eaten.length === 1 ? "a sprout" : `${eaten.length} sprouts`}: +${poops} poop`);
  if (bred.length) say(state, seat, `reproduced${bred.length > 1 ? ` ×${bred.length}` : ""}: +${babies} baby`);
  // Where each token earned was made, so the client can send it from there.
  state.gains = {
    n: (state.gains?.n ?? 0) + 1,
    seat,
    items: [
      ...eaten.slice(0, poops).map((c) => ({ ...c, type: "poop" })),
      ...bred.slice(0, babies).map((c) => ({ ...c, type: "baby" }))
    ]
  };
}

export function layCard(state, seat, { x, y, rot, mirror } = {}) {
  if (!onTurn(state, seat) || state.laid || state.seats[seat].hand === null) return false;
  if (![x, y, rot].every(Number.isInteger) || rot < 0 || rot > 3) return false;
  if (Math.abs(x) > LIMIT || Math.abs(y) > LIMIT) return false;
  mirror = !!mirror;
  const card = state.seats[seat].hand;
  if (cardProblem(state, card, x, y, rot, mirror)) return false;

  // Consume and reproduce: only the bugs of the player laying the card count.
  const bug = state.seats[seat].bug;
  const top = topCells(state.placed);
  const eaten = [];
  const bred = [];
  oriented(card, rot, mirror).forEach((row, dy) =>
    row.forEach((sym, dx) => {
      if (sym !== bug) return;
      const below = top.get(key(x + dx, y + dy));
      if (below === SPROUT) eaten.push({ x: x + dx, y: y + dy });
      else if (below === bug) bred.push({ x: x + dx, y: y + dy });
    })
  );

  remember(state);
  state.placed.push({ card, x, y, rot, mirror });
  state.seats[seat].hand = null;
  state.laid = true;
  gain(state, seat, eaten, bred);
  return true;
}

// type: "poop", "rock" (a poop token laid rock side up) or "baby".
export function layToken(state, seat, { x, y, type } = {}) {
  if (!onTurn(state, seat) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const s = state.seats[seat];
  const stock = type === "baby" ? "babies" : type === "poop" || type === "rock" ? "poop" : null;
  if (!stock || s[stock] < 1) return false;
  if (tokenProblem(state, seat, x, y)) return false;
  // A baby is a bug: on a sprout it eats, on its own kind it breeds.
  const below = topCells(state.placed).get(key(x, y));
  remember(state);
  s[stock] -= 1;
  state.tokens.push({ x, y, type, seat, bug: type === "baby" ? s.bug : null });
  if (type === "baby" && (below === SPROUT || below === s.bug)) {
    gain(state, seat, below === SPROUT ? [{ x, y }] : [], below === s.bug ? [{ x, y }] : []);
  }
  return true;
}

export function completeDance(state, seat) {
  if (!onTurn(state, seat)) return false;
  const s = state.seats[seat];
  if (s.dance === null || !danceMade(state, seat, s.dance)) return false;
  remember(state);
  s.done.push(s.dance);
  say(state, seat, `danced for +${DANCES[s.dance].pts}`);
  s.dance = null;
  state.choosing = state.market.length > 0;
  return true;
}

export function chooseDance(state, seat, slot) {
  if (state.phase !== "play" || state.turn !== seat || !state.choosing) return false;
  if (!Number.isInteger(slot) || slot < 0 || slot >= state.market.length) return false;
  remember(state);
  state.seats[seat].dance = state.market[slot];
  if (state.dancePile.length) state.market[slot] = state.dancePile.shift();
  else state.market.splice(slot, 1);
  state.choosing = false;
  return true;
}

export function endTurn(state, seat) {
  if (!onTurn(state, seat) || !state.laid) return false;
  state.undo = null;
  if (state.pile.length) state.seats[seat].hand = state.pile.shift();
  if (state.seats.every((s) => s.hand === null)) {
    state.phase = "over";
    const scores = state.seats.map((_, i) => scoreOf(state, i));
    const best = (a, b) => b.total - a.total || b.bugs - a.bugs;
    const top = [...scores].sort(best)[0];
    state.result = {
      scores,
      winners: scores.map((sc, i) => (sc.total === top.total && sc.bugs === top.bugs ? i : -1)).filter((i) => i >= 0)
    };
    return true;
  }
  state.turn = (state.turn + 1) % state.seats.length;
  state.laid = false;
  return true;
}
