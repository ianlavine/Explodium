// Downstream: rules engine. Pure state transforms — no sockets, no timers, so
// the bot can simulate a turn with exactly the code that plays it.
//
// Five water tokens sit on a 10x10 grid. Players take turns dropping a
// numbered tile (0-6) on any empty square. A token that is still dry starts
// moving when a 6 lands beside it; after that it runs onto any neighbouring
// tile showing its own number or one below, and keeps running as long as it
// can — but never back onto a square it has already touched during that one
// run, which is what stops it circling forever. You score one point per square
// a token you set in motion travels, and so does whoever owns the tile it comes
// to rest on. Reaching a 0 ends that token's journey and pays the owner of the
// 0 seven points. A token walled in on every side can never be moved again: it
// drowns, and everyone touching it pays its price.
import { shuffle } from "../../lib/util.js";

export const SIZE = 10;
export const CELLS = SIZE * SIZE;
export const TOKEN_COUNT = 5;
export const MAX_VALUE = 6;
export const HAND_SIZE = 5;
export const COPIES_PER_VALUE = 3;
export const COMPLETE_BONUS = 7; // the default; live value is settings.completionBonus

export const SEATS = 4;
export const TOKEN_NAMES = ["A", "B", "C", "D", "E"];

// Tunable rules, adjustable from the game screen. Each entry carries its
// default, the range the client's slider offers, and whether it can take hold
// in the game already running or only shapes the next one.
export const SETTINGS = {
  completionBonus: {
    label: "Completion bonus",
    hint: "Paid to the owner of the 0 a token finishes on.",
    value: COMPLETE_BONUS, min: 0, max: 10, step: 1, applies: "now"
  },
  handSize: {
    label: "Tiles in hand",
    hint: "How many of your tiles you can see and choose from.",
    value: HAND_SIZE, min: 1, max: 10, step: 1, applies: "now"
  },
  maxValue: {
    label: "Highest tile",
    hint: "Tiles run 0 up to this. A dry token waits for the highest.",
    value: MAX_VALUE, min: 2, max: 12, step: 1, applies: "next"
  },
  copies: {
    label: "Copies of each tile",
    hint: "How many of every number each player's pile holds.",
    value: COPIES_PER_VALUE, min: 1, max: 8, step: 1, applies: "next"
  },
  scoring: {
    label: "Scoring",
    hint: "Decrease pays for how far a token's number falls over a run. Movement pays a point a square, so circling sideways on one number still scores.",
    type: "choice",
    value: "decrease",
    options: [
      { value: "decrease", label: "Decrease" },
      { value: "movement", label: "Movement" }
    ],
    applies: "now"
  },
  shape: {
    label: "Board shape",
    hint: "Hex gives every square six sides instead of four: more ways to run, and far harder to drown.",
    type: "choice",
    value: "square",
    options: [
      { value: "square", label: "Square" },
      { value: "hex", label: "Hex" }
    ],
    applies: "next"
  }
};

export const defaultSettings = () =>
  Object.fromEntries(Object.entries(SETTINGS).map(([key, spec]) => [key, spec.value]));

// Brings every hand back to the size the dials call for: top up from the pile,
// or hand the surplus back to the bottom of it.
export function reconcileHands(state) {
  const size = state.settings.handSize;
  state.hands.forEach((hand, seat) => {
    while (hand.length > size) state.decks[seat].unshift(hand.pop());
    while (hand.length < size && state.decks[seat].length > 0) hand.push(state.decks[seat].pop());
  });
}

// Applies one dial. Returns false if the key or the value was not on offer.
export function setSetting(state, key, value) {
  const spec = SETTINGS[key];
  if (!spec) return false;
  if (spec.type === "choice") {
    if (!spec.options.some((option) => option.value === value)) return false;
    state.settings[key] = value;
    return true;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  state.settings[key] = Math.min(spec.max, Math.max(spec.min, Math.round(number / spec.step) * spec.step));
  return true;
}


// Adjacency, precomputed once per board shape — movement, drowning and the
// bot's placement scan all walk these tables.
//
// A square board joins the four orthogonal neighbours. A hex board keeps the
// same ten rows of ten, but every odd row is shifted half a cell right and each
// cell touches six others: the two beside it and four on the diagonals, which
// side depending on whether its row is one of the shifted ones. Six ways out
// makes a token much harder to drown and gives runs far more to work with.
export const SHAPES = ["square", "hex"];

function buildNeighbors(shape) {
  return Array.from({ length: CELLS }, (_, cell) => {
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;
    const steps =
      shape === "hex"
        ? row % 2 === 0
          ? [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]]
          : [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
        : [[-1, 0], [1, 0], [0, -1], [0, 1]];
    return steps
      .map(([dr, dc]) => [row + dr, col + dc])
      .filter(([r, c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE)
      .map(([r, c]) => r * SIZE + c);
  });
}

const NEIGHBOR_TABLES = Object.fromEntries(SHAPES.map((shape) => [shape, buildNeighbors(shape)]));

// Every rule that asks "what is next to this?" goes through here, so the board
// shape is a setting rather than a constant.
export const neighborsFor = (state) => NEIGHBOR_TABLES[state.settings?.shape] ?? NEIGHBOR_TABLES.square;
export const neighborTable = (shape) => NEIGHBOR_TABLES[shape] ?? NEIGHBOR_TABLES.square;

function createDeck(settings) {
  const tiles = [];
  for (let value = 0; value <= settings.maxValue; value += 1) {
    for (let copy = 0; copy < settings.copies; copy += 1) tiles.push(value);
  }
  return shuffle(tiles);
}

// Tokens start on empty squares, never adjacent to each other — two tokens
// side by side would spend the whole game blocking each other's exits.
function placeTokens(settings) {
  const neighbors = neighborTable(settings.shape);
  const taken = new Set();
  const tokens = [];
  while (tokens.length < TOKEN_COUNT) {
    const cell = Math.floor(Math.random() * CELLS);
    if (taken.has(cell)) continue;
    if (neighbors[cell].some((n) => taken.has(n))) continue;
    taken.add(cell);
    tokens.push({
      id: TOKEN_NAMES[tokens.length],
      cell,
      value: null, // dry: waiting for the highest tile
      status: "active",
      steps: 0, // squares travelled so far in the run being resolved
      runStart: 0 // how high it stood when that run began
    });
  }
  return tokens;
}

export function createState(seatCount = SEATS, settings = defaultSettings()) {
  const decks = Array.from({ length: seatCount }, () => createDeck(settings));
  return {
    settings,
    board: new Array(CELLS).fill(null), // { value, owner } | null
    tokens: placeTokens(settings),
    scores: new Array(seatCount).fill(0),
    hands: decks.map((deck) => deck.splice(0, settings.handSize)),
    decks,
    turn: 0,
    // The run in progress: which token is moving and every square it has
    // touched since it set off. Cleared the moment it comes to rest.
    run: null, // { tokenId, visited: Set<cell> }
    // A run with more than one way to go stops here until the player whose
    // turn it is picks. `tokenId` is null while the choice is which token
    // takes the new tile rather than where a moving one goes next.
    pending: null, // { seat, tokenId, options: [{ tokenId, cell }] }
    // Everything the last resolved segment did, for the client's replay.
    anim: [], // [{ tokenId, path: [cell, ...] }]
    lastTurn: null, // { seat, gains: [..], events: [string] }
    log: [],
    gameOver: false,
    winners: []
  };
}

export const tokenById = (state, id) => state.tokens.find((token) => token.id === id) ?? null;

export const tokenAt = (state, cell) =>
  state.tokens.find((token) => token.cell === cell && token.status !== "done") ?? null;

export const canPlace = (state, cell) =>
  cell >= 0 && cell < CELLS && state.board[cell] === null && tokenAt(state, cell) === null;

// The highest number in play — what a dry token is waiting for.
export const topValue = (state) => state.settings?.maxValue ?? MAX_VALUE;

// The numbers a token will step onto: the highest while it is dry, otherwise
// its own number or one below.
export function wantedValues(state, token) {
  if (token.value === null) return [topValue(state)];
  if (token.value === 0) return [];
  return [token.value, token.value - 1];
}

// Where this token could go right now. `visited` is the set of squares it has
// already touched on this run — passing null asks the question fresh.
export function destinationsFor(state, token, visited) {
  if (token.status !== "active") return [];
  const wants = wantedValues(state, token);
  if (wants.length === 0) return [];
  return neighborsFor(state)[token.cell].filter((cell) => {
    if (visited?.has(cell)) return false;
    const tile = state.board[cell];
    return tile !== null && wants.includes(tile.value) && tokenAt(state, cell) === null;
  });
}

// Would a tile just played on `cell` set this token going?
export const acceptsTile = (state, token, cell) =>
  destinationsFor(state, token, null).includes(cell);

// The number one below where the token stands — the step it is obliged to
// take. A dry token's wake-up counts as its downward step: it is compulsory.
// How high up the ladder a token still is. A dry one sits a notch above the
// highest tile, so waking up counts as falling one like any other step.
export const levelOf = (state, token) => (token.value === null ? topValue(state) + 1 : token.value);

export const downValue = (state, token) => (token.value === null ? topValue(state) : token.value - 1);

export const isDownward = (state, token, cell) => state.board[cell]?.value === downValue(state, token);

// Walled in. Every neighbour holds a tile, so no one can ever place beside it
// again — and a token only ever moves in answer to a placement, so nothing
// will move it. A token standing on a 0 has finished, not drowned.
export function isDead(state, token) {
  if (token.status !== "active") return false;
  if (token.value === 0) return false;
  return neighborsFor(state)[token.cell].every((cell) => state.board[cell] !== null);
}

function pushLog(state, line) {
  state.log.push(line);
  if (state.log.length > 40) state.log.shift();
}

// --- turn resolution --------------------------------------------------------

const nameOf = (state, seat) => state.players?.[seat]?.name ?? `P${seat + 1}`;

function settle(state, seat, token, ctx) {
  if (token.steps === 0) return;
  const tile = state.board[token.cell];
  const steps = token.steps;
  // Under decrease scoring a run pays for how far the token's number actually
  // fell, so wandering sideways over the same number earns nobody anything.
  // Under movement scoring every square counts, sideways included.
  const fell = Math.max(0, token.runStart - levelOf(state, token));
  const earned = state.settings?.scoring === "movement" ? steps : fell;
  token.steps = 0;
  ctx.gains[seat] += earned;
  ctx.events.push(
    state.settings?.scoring === "movement"
      ? `${token.id} ran ${steps} (+${steps})`
      : `${token.id} ran ${steps}, fell ${fell} (+${fell})`
  );
  // Whoever owns the square it stopped on shares in the run.
  if (tile && earned > 0 && tile.owner !== seat) {
    ctx.gains[tile.owner] += earned;
    ctx.events.push(`${nameOf(state, tile.owner)} +${earned} (landing)`);
  }
  if (tile && token.value === 0) {
    const bonus = state.settings?.completionBonus ?? COMPLETE_BONUS;
    token.status = "done";
    ctx.gains[tile.owner] += bonus;
    if (bonus) ctx.events.push(`${token.id} reached the sea → ${nameOf(state, tile.owner)} +${bonus}`);
    else ctx.events.push(`${token.id} reached the sea`);
  }
}

// One square. `choice` is an option as offered: which token, and where to.
function applyStep(state, seat, choice, ctx) {
  const token = tokenById(state, choice.tokenId);
  if (!state.run || state.run.tokenId !== token.id) {
    state.run = { tokenId: token.id, visited: new Set([token.cell]) };
    token.runStart = levelOf(state, token); // where this run began, for scoring
  }
  const from = token.cell;
  token.cell = choice.cell;
  token.value = state.board[choice.cell].value;
  token.steps += 1;
  state.run.visited.add(choice.cell);
  // Consecutive hops by the same token extend one path; anything else starts a
  // new one, so the client replays the turn in the order it happened.
  const last = ctx.anim[ctx.anim.length - 1];
  if (last && last.tokenId === token.id && last.path[last.path.length - 1] === from) last.path.push(choice.cell);
  else ctx.anim.push({ tokenId: token.id, path: [from, choice.cell] });
}

function endRun(state, seat, ctx) {
  const token = tokenById(state, state.run.tokenId);
  state.run = null;
  if (token) settle(state, seat, token, ctx);
}

// Hands the paths walked so far to the client and starts a fresh segment —
// used when a run stops mid-way to ask the player which way to go.
function flushAnim(state, ctx) {
  state.anim = ctx.anim;
  ctx.anim = [];
}

// Runs the token in motion until it comes to rest or reaches a fork. `chooser`
// is null for a human (we stop and record `pending` instead); the bot passes
// one so the whole turn resolves in a single call, and may return null to let
// a token stop where it is.
function drive(state, seat, ctx, chooser) {
  while (state.run) {
    const token = tokenById(state, state.run.tokenId);
    // The sea: a token that reaches a 0 stops there for good.
    if (!token || token.value === 0) {
      endRun(state, seat, ctx);
      break;
    }
    const options = destinationsFor(state, token, state.run.visited).map((cell) => ({
      tokenId: token.id,
      cell
    }));
    if (options.length === 0) {
      endRun(state, seat, ctx);
      break;
    }
    // Water keeps falling: while a step down is on offer the token must take
    // one of the moves available. Once only sideways moves are left the player
    // may let it come to rest instead.
    const canStop = !options.some((option) => isDownward(state, token, option.cell));
    let choice = options[0];
    if (canStop || options.length > 1) {
      if (!chooser) {
        state.pending = { seat, tokenId: token.id, options, canStop };
        return false;
      }
      choice = chooser(state, seat, options, canStop);
      if (!choice) {
        endRun(state, seat, ctx);
        break;
      }
    }
    applyStep(state, seat, choice, ctx);
  }
  return true;
}

// Tokens that drowned this turn take the neighbourhood with them: every tile
// touching one costs its owner its face value.
function reapDead(state, ctx) {
  state.tokens.forEach((token) => {
    if (!isDead(state, token)) return;
    token.status = "dead";
    const losses = new Array(state.scores.length).fill(0);
    neighborsFor(state)[token.cell].forEach((cell) => {
      const tile = state.board[cell];
      if (tile) losses[tile.owner] += tile.value;
    });
    losses.forEach((loss, seat) => {
      if (loss > 0) ctx.gains[seat] -= loss;
    });
    const who = losses
      .map((loss, seat) => (loss > 0 ? `${nameOf(state, seat)} −${loss}` : null))
      .filter(Boolean)
      .join(", ");
    ctx.events.push(`Token ${token.id} drowned${who ? ` → ${who}` : ""}`);
  });
}

export const activeTokens = (state) => state.tokens.filter((token) => token.status === "active");

export function hasAnyPlacement(state) {
  if (state.hands.every((hand) => hand.length === 0)) return false;
  for (let cell = 0; cell < CELLS; cell += 1) if (canPlace(state, cell)) return true;
  return false;
}

function finishTurn(state, ctx) {
  reapDead(state, ctx);
  ctx.gains.forEach((gain, seat) => {
    state.scores[seat] += gain;
  });
  state.anim = ctx.anim;
  state.lastTurn = { seat: ctx.seat, gains: ctx.gains, events: ctx.events };
  if (ctx.events.length) pushLog(state, `${nameOf(state, ctx.seat)}: ${ctx.events.join(" · ")}`);

  if (activeTokens(state).length === 0 || !hasAnyPlacement(state)) {
    state.gameOver = true;
    const best = Math.max(...state.scores);
    state.winners = state.scores.map((score, seat) => (score === best ? seat : -1)).filter((seat) => seat >= 0);
    return;
  }

  // Skip anyone who has run dry, and hand the turn on.
  let next = state.turn;
  for (let i = 0; i < state.scores.length; i += 1) {
    next = (next + 1) % state.scores.length;
    if (state.hands[next].length > 0) break;
  }
  state.turn = next;
}

function newCtx(state, seat) {
  return { seat, gains: new Array(state.scores.length).fill(0), events: [], anim: [] };
}

function close(state, seat, ctx, settled) {
  if (settled) {
    state.resolving = null;
    finishTurn(state, ctx);
  } else {
    flushAnim(state, ctx);
  }
}

// The one path by which a tile ever reaches the board. Returns false if the
// placement was illegal. `chooser` (bot only) resolves forks inline.
export function place(state, seat, tileIndex, cell, chooser = null) {
  if (state.gameOver || state.pending) return false;
  if (state.turn !== seat) return false;
  const value = state.hands[seat][tileIndex];
  if (value === undefined) return false;
  if (!canPlace(state, cell)) return false;

  state.hands[seat].splice(tileIndex, 1);
  if (state.decks[seat].length > 0) state.hands[seat].push(state.decks[seat].pop());
  state.board[cell] = { value, owner: seat };

  const ctx = newCtx(state, seat);
  state.resolving = ctx;
  state.run = null;
  // Only a token beside the new tile can react to it — and now and then more
  // than one could take it, which is the player's call as well.
  const starters = state.tokens
    .filter((token) => token.status === "active" && acceptsTile(state, token, cell))
    .map((token) => ({ tokenId: token.id, cell }));

  if (starters.length === 0) {
    close(state, seat, ctx, true);
    return true;
  }
  // A tile that is only a sideways step for every token beside it is an offer,
  // not an order — the player may leave them all where they are.
  const canStop = !starters.some((option) => isDownward(state, tokenById(state, option.tokenId), cell));
  if (starters.length > 1 || canStop) {
    if (!chooser) {
      state.pending = { seat, tokenId: null, options: starters, canStop };
      close(state, seat, ctx, false);
      return true;
    }
    const choice = chooser(state, seat, starters, canStop);
    if (!choice) {
      close(state, seat, ctx, true);
      return true;
    }
    applyStep(state, seat, choice, ctx);
  } else {
    applyStep(state, seat, starters[0], ctx);
  }
  close(state, seat, ctx, drive(state, seat, ctx, chooser));
  return true;
}

// Answer to a `pending` fork: a square to move to, or `stop` to let the token
// come to rest. Returns false if that answer was not on offer.
export function chooseMove(state, seat, tokenId, cell, stop = false) {
  const pending = state.pending;
  if (!pending || pending.seat !== seat) return false;
  const ctx = state.resolving ?? newCtx(state, seat);

  if (stop) {
    if (!pending.canStop) return false;
    state.pending = null;
    if (state.run) endRun(state, seat, ctx);
    close(state, seat, ctx, true);
    return true;
  }

  const choice = pending.options.find(
    (option) => option.cell === cell && (tokenId == null || option.tokenId === tokenId)
  );
  if (!choice) return false;
  state.pending = null;
  applyStep(state, seat, choice, ctx);
  close(state, seat, ctx, drive(state, seat, ctx, null));
  return true;
}

// A deep-enough copy for the bot to play a turn on: everything the rules touch.
export function cloneState(state) {
  return {
    settings: state.settings, // read-only during a simulation
    board: state.board.map((tile) => (tile ? { value: tile.value, owner: tile.owner } : null)),
    tokens: state.tokens.map((token) => ({ ...token })),
    scores: [...state.scores],
    hands: state.hands.map((hand) => [...hand]),
    decks: state.decks.map((deck) => [...deck]),
    turn: state.turn,
    run: null,
    pending: null,
    anim: [],
    lastTurn: null,
    log: [],
    gameOver: state.gameOver,
    winners: [],
    players: state.players
  };
}
