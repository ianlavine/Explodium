// Downstream AI. Plays the real engine forward one ply: every (tile, square)
// it could play is simulated, forks included, and scored on what the turn
// actually pays out — its own points minus what it hands the table, minus the
// tiles it would lose to a drowning. Ties and near-ties are broken with a
// little noise so three bots at the same table don't play the same game.
import {
  neighborsFor,
  CELLS,
  COMPLETE_BONUS,
  levelOf,
  canPlace,
  cloneState,
  place,
  tokenAt,
  tokenById,
  wantedValues,
  activeTokens
} from "./engine.js";

// A table of four shares one pot: a point to a single rival costs us a third
// of a point of standing, not a whole one. Scoring a run 1-for-1 with the
// player whose tile it lands on is still clearly worth doing, which is the
// whole game — this is what the earlier flat 0.75 penalty threw away.
const rivalShare = (state) => 1 / Math.max(1, state.scores.length - 1);
// Parking a big number where a token could suffocate against it is how you
// bleed points later — but that loss is speculative and a long way off, so it
// is priced well under a point. Heavy enough here and the bot talks itself out
// of real runs, since the tile a token travels over ends up beside it.
const CHOKE_WEIGHT = 0.18;
// …except when one open square is all that stands between that token and
// drowning, where the loss is neither speculative nor far off.
const CHOKE_URGENT = 3;
// Laying a number a nearby token will want on its way past. Deliberately
// smaller than a single real point, so a scoring move always outranks a hunch.
const SETUP_BONUS = 0.3;
// What one level of a token's descent is worth beyond the points it pays now.
const DESCENT_BONUS = 0.35;
// A long run is worth more than the same squares taken one at a time: it uses
// the board that is already there instead of spending a tile to buy a point.
const RUN_BONUS = 0.3;
const NOISE = 0.2;
// How far ahead a run is traced when comparing forks. Runs can be long now
// that a token also steps sideways onto its own number, so this is capped.
const LOOKAHEAD = 8;

// What a single hop pays under the scoring in force: every square counts under
// movement scoring, only a step down counts under decrease scoring.
const hopPays = (state, from, to) =>
  state.settings?.scoring === "movement" ? 1 : to < from ? from - to : 0;

// What one hop is worth to us: what it pays plus what the run looks like paying
// on from there, less the share that goes to the owner it lands on.
function optionValue(state, seat, option) {
  const tile = state.board[option.cell];
  const token = tokenById(state, option.tokenId);
  const visited = new Set(state.run?.visited ?? [token.cell]);
  visited.add(option.cell);
  const paid =
    hopPays(state, levelOf(state, token), tile.value) +
    (tile.value === 0 ? 0 : runLength(state, option.cell, tile.value, seat, visited, 0));
  const share = rivalShare(state);
  let value = paid;
  if (tile.owner !== seat) value -= paid * share;
  if (tile.value === 0) {
    const bonus = state.settings?.completionBonus ?? COMPLETE_BONUS;
    value += bonus * (tile.owner === seat ? 1 : -share);
  }
  return value;
}

// Chooser used inside simulations: take the hop worth most, and when the rules
// allow the token to stop (only sideways moves left) stop rather than hand a
// rival a landing.
function greedyChoice(state, seat, options, canStop = false) {
  let best = options[0];
  let bestValue = optionValue(state, seat, options[0]);
  for (const option of options.slice(1)) {
    const value = optionValue(state, seat, option);
    if (value > bestValue) {
      bestValue = value;
      best = option;
    }
  }
  return canStop && bestValue <= 0 ? null : best;
}

// Optimistic look at what the rest of a run from `cell` would pay. Honours the
// no-revisit rule so it matches what the engine will actually allow, and prices
// each hop by the scoring in force — under decrease scoring a lap around the
// same number is worth nothing and this says so.
function runLength(state, cell, value, seat, visited, depth) {
  if (value <= 0 || depth >= LOOKAHEAD) return 0;
  let best = 0;
  for (const next of neighborsFor(state)[cell]) {
    if (visited.has(next)) continue;
    const tile = state.board[next];
    if (!tile || (tile.value !== value && tile.value !== value - 1)) continue;
    if (tokenAt(state, next)) continue;
    visited.add(next);
    const score =
      hopPays(state, value, tile.value) + runLength(state, next, tile.value, seat, visited, depth + 1);
    visited.delete(next);
    if (score > best) best = score;
  }
  return best;
}

// Positional value of a placement no token reacts to. Cheap, and it is what
// keeps the bot from scattering tiles at random for most of the game.
function quiet(state, seat, value, cell) {
  const neighbors = neighborsFor(state);
  let score = 0;
  for (const token of activeTokens(state)) {
    const wants = wantedValues(state, token);
    if (neighbors[token.cell].includes(cell)) {
      // Beside a token but not a number it will take: dead weight that may
      // cost us its face value, and the tighter the box the worse it is.
      const open = neighbors[token.cell].filter((n) => state.board[n] === null).length;
      score -= value * CHOKE_WEIGHT * (open <= 1 ? CHOKE_URGENT : 1 / open);
    } else if (wants.includes(value) || wants.includes(value + 1)) {
      // A cell that shares a neighbour with the token is track along the way,
      // and worth a little.
      if (neighbors[cell].some((n) => neighbors[token.cell].includes(n))) score += SETUP_BONUS;
    }
  }
  // A trickle of preference for the middle, where runs have room to develop.
  const row = Math.floor(cell / 10);
  const col = cell % 10;
  score += (4.5 - Math.abs(4.5 - row) + (4.5 - Math.abs(4.5 - col))) * 0.02;
  return score;
}

function scorePlacement(state, seat, tileIndex, cell) {
  const value = state.hands[seat][tileIndex];
  const touchesToken = state.tokens.some(
    (token) => token.status === "active" && neighborsFor(state)[cell].includes(token.cell)
  );
  // Nothing beside it can react — no token moves and none can drown, since
  // both need the new tile to be adjacent — so the cheap score will do.
  if (!touchesToken) return quiet(state, seat, value, cell);

  const sim = cloneState(state);
  sim.turn = seat;
  const before = [...sim.scores];
  place(sim, seat, tileIndex, cell, greedyChoice);
  // Standing gained: our points, less the average the rest of the table took.
  let own = 0;
  let rivals = 0;
  sim.scores.forEach((after, s) => {
    const delta = after - before[s];
    if (s === seat) own = delta;
    else rivals += delta;
  });
  let score = own - rivals * rivalShare(sim);
  // Points are not the whole of it: driving a token down a level brings it
  // nearer the sea and the 7 that pays out there, and keeps it off the board
  // edge of stagnation. Without this the bot cannot tell a two-square run it
  // shares with a rival from a one-square hop it keeps to itself.
  let descent = 0;
  sim.tokens.forEach((after, index) => {
    descent += Math.max(0, levelOf(state, state.tokens[index]) - levelOf(sim, after));
  });
  score += descent * DESCENT_BONUS;
  const squares = sim.anim.reduce((total, path) => total + path.path.length - 1, 0);
  const units = sim.settings?.scoring === "movement" ? squares : descent;
  score += Math.max(0, units - 1) * RUN_BONUS;
  // Whatever survives the turn is still a hostage: value the standing risk.
  score += quiet(sim, seat, value, cell) * 0.5;
  return score;
}

export function chooseMove(state, seat) {
  let best = null;
  let bestScore = -Infinity;
  // Duplicate numbers in hand play identically, so only try each value once.
  const seen = new Set();
  const tileIndexes = state.hands[seat]
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => (seen.has(value) ? false : seen.add(value)));

  for (let cell = 0; cell < CELLS; cell += 1) {
    if (!canPlace(state, cell)) continue;
    for (const { index } of tileIndexes) {
      const score = scorePlacement(state, seat, index, cell) + Math.random() * NOISE;
      if (score > bestScore) {
        bestScore = score;
        best = { tileIndex: index, cell };
      }
    }
  }
  return best;
}

export { greedyChoice };
