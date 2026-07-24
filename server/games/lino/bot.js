// Lino AI. Real-time, so the bot isn't turn-driven: it wakes on a timer and
// asks one question — "what's the cheapest remaining route from shrine to
// shrine, and can I afford its next hop?"
//
// The route is a Dijkstra shortest path over the dots where lines it already
// owns cost 0, so it naturally extends its own chain instead of restarting.
// Hops longer than MAX_HOP are excluded, which keeps it chaining through
// intermediate dots rather than saving for one huge span — chaining grows its
// largest group, and group size is income, so it also plays the economy right.
import {
  SHRINE_A_ID,
  SHRINE_B_ID,
  distance,
  lineCost,
  evaluateBuild,
  resolveDestruction,
  largestGroupSize,
  playerComponents,
  connectsShrines,
  DEFAULT_SETTINGS
} from "../../../public/games/lino/rules.js";

export const LINO_BOT_ID = "__lino_bot__";
export const LINO_BOT_SEAT = 1; // start_bot seats the bot second

// One strength: play as well as we know how. Difficulty levels were removed —
// the interesting knobs turned out to be spending discipline, not speed.
//
// MAX_HOP is the economy lever: short hops chain through more dots, and group
// size *is* income, so the ramp compounds. Simulation over 60 maps: hop cap 30
// wins in ~36s, cap 100 in ~48s, and a single direct $140 line — the cheapest
// possible route — is the *worst* at ~62s.
const THINK_MS = 400;
// In board units; at COST_PER_UNIT 0.7 this caps a hop at ~$29 — the sweet
// spot the 60-map simulation found (chaining beats long spans).
const MAX_HOP = 42;
const THREAT_HOP = 60; // hop cap used when sizing up the opponent's progress

// Only bother trying to sabotage once the opponent is genuinely close.
const THREAT_COST = 60;

// Defense: hunt cheap cuts that split the opponent's group. A cut is worth it
// when it costs at most PAYBACK dollars per point of group income destroyed
// (their group pays out every 2s, so damage compounds fast).
const HARASS_MAX_COST = 50;
const HARASS_PAYBACK = 15; // $ per point of foe-group damage
const HARASS_COOLDOWN_MS = 8000; // don't turn into a pure griefer

// Economy phase: before racing for the shrines, grow one dense network by
// repeatedly adding the shortest possible link. Group size IS income, so a
// 15-dot net pays +15 every 2s — that war chest then funds the race and the
// cutting. Racing starts only once the net hits target AND the opponent isn't
// close to connecting.
const ECON_TARGET = 15; // dots in our largest group before we race
const ECON_MAX_HOP = 30; // never "expand" with a long expensive line
const DENSE_R = 22; // radius used to find the densest seed area

// Kept for the lobby's bot interface; levels no longer exist.
export function normalizeBotLevel() {
  return 0;
}

const edgeKey = (a, b) => [a, b].sort().join(":");

// Cheapest shrine-to-shrine route for `seat`, treating its own lines as free.
// Returns { path: [dotId], cost } or null when no route exists.
export function shortestRoute(dots, lines, seat, blocked, maxHop, settings) {
  const rules = settings || DEFAULT_SETTINGS;
  const index = new Map(dots.map((dot, i) => [dot.id, i]));
  const owned = new Set(
    lines.filter((line) => line.player === seat).map((line) => edgeKey(line.from, line.to))
  );
  // Unless the house rules allow it, dots the opponent has a line on can't be
  // built to at all — the planner has to route around them, not just discover
  // that hop-by-hop.
  const foeHeld = new Set();
  if (!rules.allowOpponentDots) {
    lines.forEach((line) => {
      if (line.player === seat) return;
      // Shrines are never claimable, so they never count as blocked.
      if (line.from !== SHRINE_A_ID && line.from !== SHRINE_B_ID) foeHeld.add(line.from);
      if (line.to !== SHRINE_A_ID && line.to !== SHRINE_B_ID) foeHeld.add(line.to);
    });
  }
  const start = index.get(SHRINE_A_ID);
  const goal = index.get(SHRINE_B_ID);
  if (start === undefined || goal === undefined) return null;

  const weight = (a, b) => {
    const key = edgeKey(a.id, b.id);
    if (owned.has(key)) return 0; // already built — free to reuse
    if (blocked.has(key)) return Infinity;
    if (foeHeld.has(a.id) || foeHeld.has(b.id)) return Infinity;
    const span = distance(a, b);
    if (span > maxHop) return Infinity;
    return lineCost(a, b, rules);
  };

  const dist = dots.map(() => Infinity);
  const prev = dots.map(() => -1);
  const done = dots.map(() => false);
  dist[start] = 0;

  for (;;) {
    let current = -1;
    let best = Infinity;
    for (let i = 0; i < dots.length; i += 1) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        current = i;
      }
    }
    if (current === -1 || current === goal) break;
    done[current] = true;
    for (let next = 0; next < dots.length; next += 1) {
      if (done[next] || next === current) continue;
      const w = weight(dots[current], dots[next]);
      if (!Number.isFinite(w)) continue;
      if (dist[current] + w < dist[next]) {
        dist[next] = dist[current] + w;
        prev[next] = current;
      }
    }
  }

  if (!Number.isFinite(dist[goal])) return null;
  const path = [];
  for (let at = goal; at !== -1; at = prev[at]) path.unshift(dots[at].id);
  return { path, cost: dist[goal] };
}

// Route hops this seat hasn't built yet, in order from shrine A outward.
function missingHops(path, lines, seat) {
  const owned = new Set(
    lines.filter((line) => line.player === seat).map((line) => edgeKey(line.from, line.to))
  );
  const hops = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!owned.has(edgeKey(path[i], path[i + 1]))) hops.push([path[i], path[i + 1]]);
  }
  return hops;
}

// Cheapest legal build that destroys at least one opponent line. Only called
// when the opponent is close to winning, since it scans every dot pair.
function findCut(state, seat) {
  const { dots, lines, money, settings } = state;
  let best = null;
  for (const a of dots) {
    for (const b of dots) {
      if (a.id >= b.id) continue; // each unordered pair once
      const result = evaluateBuild({
        dots,
        lines,
        seat,
        money: money[seat],
        fromId: a.id,
        toId: b.id,
        settings
      });
      if (!result.ok || !result.destroys.length) continue;
      if (!best || result.cost < best.cost) {
        best = { fromId: a.id, toId: b.id, cost: result.cost };
      }
    }
  }
  return best;
}

// Defensive play: the best cheap cut on the opponent's network, judged by how
// much of their largest group (= income) it severs per dollar. Short victim
// lines cost little to destroy and short cutting lines cost little to build,
// so "snip the weak middle link" falls out of the scoring naturally. All house
// rules (requireLonger, brass, taken dots…) are enforced by evaluateBuild.
function findHarassCut(state, seat) {
  const { dots, lines, money, settings } = state;
  const foe = 1 - seat;
  const foeBefore = largestGroupSize(lines, foe);
  if (foeBefore < 3) return null; // nothing worth splitting yet

  const ourBefore = largestGroupSize(lines, seat);
  let best = null;
  for (const a of dots) {
    for (const b of dots) {
      if (a.id >= b.id) continue; // each unordered pair once
      const result = evaluateBuild({
        dots,
        lines,
        seat,
        money: money[seat],
        fromId: a.id,
        toId: b.id,
        settings
      });
      if (!result.ok || !result.destroys.length) continue;
      if (result.cost > HARASS_MAX_COST) continue;

      // Full damage including any destroyDots cascade.
      const { lineIds } = resolveDestruction({
        dots,
        lines,
        cutLineIds: result.destroys,
        settings
      });
      const remaining = lines.filter((line) => !lineIds.has(line.id));
      const damage = foeBefore - largestGroupSize(remaining, foe);
      // Only middle links: severing a leaf (damage 1) isn't worth tempo.
      if (damage < 2) continue;
      // Never a cut that takes our own network down with it (cascades can).
      if (largestGroupSize(remaining, seat) < ourBefore) continue;
      if (result.cost > damage * HARASS_PAYBACK) continue;

      const score = damage / result.cost;
      if (!best || score > best.score) {
        best = { fromId: a.id, toId: b.id, cost: result.cost, score };
      }
    }
  }
  return best;
}

// Economy growth: the cheapest structurally-legal link that attaches one new
// dot to our biggest component (or seeds a component in the densest area of
// the board). Returns a move, "wait" when the best link exists but isn't
// affordable yet, or null when there's nothing left worth expanding into.
function findEconomyBuild(state, seat) {
  const { dots, lines, money, settings } = state;
  const evalPair = (a, b) =>
    evaluateBuild({ dots, lines, seat, money: money[seat], fromId: a.id, toId: b.id, settings });

  const components = playerComponents(lines, seat);
  let main = [];
  components.forEach((c) => {
    if (c.length > main.length) main = c;
  });
  const inNet = new Set(main);

  // Candidate endpoints: the whole net, or — before the first line exists —
  // the dots sitting in the densest neighbourhoods.
  let sources;
  if (inNet.size === 0) {
    const density = (dot) =>
      dots.reduce((n, o) => (o.id !== dot.id && distance(dot, o) <= DENSE_R ? n + 1 : n), 0);
    sources = dots
      .map((dot) => ({ dot, n: density(dot) }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 8)
      .map((x) => x.dot);
  } else {
    sources = dots.filter((dot) => inNet.has(dot.id));
  }

  let best = null; // { move, span, reason }
  for (const from of sources) {
    for (const to of dots) {
      if (to.id === from.id || inNet.has(to.id)) continue;
      const span = distance(from, to);
      if (span > ECON_MAX_HOP) continue;
      if (best && span >= best.span) continue; // only shorter can win
      const result = evalPair(from, to);
      if (result.ok || result.reason === "poor") {
        best = { move: { fromId: from.id, toId: to.id }, span, reason: result.reason };
      }
    }
  }
  if (!best) return null;
  return best.reason === "poor" ? "wait" : best.move;
}

// Decide this tick's move, or null to keep saving.
export function chooseBotMove(state, seat, memory) {
  const { dots, lines, money, settings } = state;

  // A changed board can unblock hops that were previously illegal.
  if (memory.lineCount !== lines.length) {
    memory.blocked.clear();
    memory.lineCount = lines.length;
  }

  const route = shortestRoute(dots, lines, seat, memory.blocked, MAX_HOP, settings);
  const hops = route ? missingHops(route.path, lines, seat) : [];

  const evalHop = ([fromId, toId]) =>
    evaluateBuild({ dots, lines, seat, money: money[seat], fromId, toId, settings });

  // 1. Take the win if any single affordable hop completes the connection
  //    (this may legitimately jump the queue — e.g. joining two chains).
  for (const hop of hops) {
    const result = evalHop(hop);
    if (!result.ok) continue;
    const trial = [...lines, { from: hop[0], to: hop[1], player: seat }];
    if (connectsShrines(trial, seat)) return { fromId: hop[0], toId: hop[1] };
  }

  // 2. The opponent is close to connecting: blocking beats everything else.
  const foe = 1 - seat;
  const foeRoute = shortestRoute(dots, lines, foe, new Set(), THREAT_HOP, settings);
  const foeClose = !!foeRoute && foeRoute.cost < THREAT_COST;
  if (foeClose) {
    const cut = findCut(state, seat);
    if (cut) return cut;
  }

  // 3. Deny their economy: snip a cheap middle link in their network when the
  //    income damage clearly outweighs the price. Rate-limited so the bot
  //    stays a builder that harasses, not a griefer that never advances.
  const now = Date.now();
  if (now - (memory.lastHarass ?? 0) > HARASS_COOLDOWN_MS) {
    const harass = findHarassCut(state, seat);
    if (harass) {
      memory.lastHarass = now;
      return harass;
    }
  }

  // 4. Economy phase: until our net is big enough (income "a lot per second"),
  //    grow one dense network via shortest-possible links instead of racing.
  //    The shrine race only starts once the net hits ECON_TARGET and the
  //    opponent isn't threatening — exactly then does the fall-through happen.
  const netSize = largestGroupSize(lines, seat);
  if (netSize < ECON_TARGET && !foeClose) {
    const econ = findEconomyBuild(state, seat);
    if (econ === "wait") return null; // saving for the next short link
    if (econ) return econ;
    // nothing left to expand into — fall through to the race
  }

  // Boxed in — every route is blocked (usually brass across the corridor).
  // Breaking one of their lines is the only way back into the game.
  if (!route) return findCut(state, seat);

  // 5. Race: extend the shrine route strictly in path order. The route starts
  //    at shrine A and our own lines weigh 0, so it reuses the economy net as
  //    free roadbed and the first missing hop keeps everything connected.
  //    If the next hop isn't affordable yet, wait and save.
  const next = hops[0];
  if (!next) return null;
  const result = evalHop(next);
  if (result.ok) return { fromId: next[0], toId: next[1] };
  if (result.reason !== "poor") {
    // Structurally impossible — remember it and replan around it next tick.
    memory.blocked.add(edgeKey(next[0], next[1]));
  }
  return null;
}

// Wires the timer loop. `applyBuild` and `emitState` come from the game module
// so the bot builds through exactly the same validation as a human.
export function createLinoBot({ rooms, applyBuild, emitState }) {
  const timers = new Map(); // roomId -> interval handle
  const memories = new Map(); // roomId -> { blocked, lineCount }

  function stop(roomId) {
    const timer = timers.get(roomId);
    if (timer) clearInterval(timer);
    timers.delete(roomId);
    memories.delete(roomId);
  }

  function start(roomId) {
    stop(roomId);
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "lino") return;
    memories.set(roomId, { blocked: new Set(), lineCount: -1, lastHarass: 0 });

    timers.set(
      roomId,
      setInterval(() => {
        const current = rooms.get(roomId);
        // The lobby deletes rooms without telling game modules, so re-check.
        if (!current || current.gameId !== "lino" || !current.isBot) {
          stop(roomId);
          return;
        }
        if (current.lino.winner !== null) {
          stop(roomId);
          return;
        }
        const memory = memories.get(roomId);
        const move = chooseBotMove(current.lino, LINO_BOT_SEAT, memory);
        if (!move) return;
        if (applyBuild(roomId, current, LINO_BOT_SEAT, move.fromId, move.toId)) {
          emitState(roomId, current);
        }
      }, THINK_MS)
    );
  }

  return { start, stop };
}
