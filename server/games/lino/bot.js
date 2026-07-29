// Lino AI. Real-time, so the bot isn't turn-driven: it wakes on a timer and
// asks one question — "what's the cheapest remaining route from shrine to
// shrine, and can I afford its next hop?"
//
// The route is a Dijkstra shortest path over the dots where lines it already
// owns cost 0, so it naturally extends its own chain instead of restarting.
// Hops longer than the per-match cap (see boardMetrics) are excluded, which
// keeps it chaining through intermediate dots rather than saving for one huge
// span — chaining grows its largest group, and group size is income, so it
// also plays the economy right.
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  SHRINE_A_ID,
  SHRINE_B_ID,
  distance,
  costPerUnit,
  lineCost,
  segmentsCross,
  evaluateBuild,
  resolveDestruction,
  largestGroupSize,
  playerComponents,
  connectsShrines,
  DEFAULT_SETTINGS
} from "../../../public/games/lino/rules.js";

// The board is far bigger than the shrine corridor, and every search here used
// to be O(dots²). A uniform grid keeps them proportional to the number of dots
// actually within reach instead.
function spatialGrid(dots, cell) {
  const size = Math.max(1, cell);
  const buckets = new Map();
  const key = (col, row) => `${col},${row}`;
  dots.forEach((dot) => {
    const k = key(Math.floor(dot.x / size), Math.floor(dot.y / size));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(dot);
  });
  return {
    within(point, radius) {
      const span = Math.ceil(radius / size);
      const col = Math.floor(point.x / size);
      const row = Math.floor(point.y / size);
      const found = [];
      for (let c = col - span; c <= col + span; c += 1) {
        for (let r = row - span; r <= row + span; r += 1) {
          const bucket = buckets.get(key(c, r));
          if (!bucket) continue;
          for (const dot of bucket) {
            if (distance(dot, point) <= radius) found.push(dot);
          }
        }
      }
      return found;
    }
  };
}

// Binary heap keyed by distance, so Dijkstra costs O(E log V) instead of
// rescanning every dot for the nearest unvisited one.
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(value, key) {
    const items = this.items;
    items.push({ value, key });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].key <= items[i].key) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < items.length && items[left].key < items[best].key) best = left;
        if (right < items.length && items[right].key < items[best].key) best = right;
        if (best === i) break;
        [items[best], items[i]] = [items[i], items[best]];
        i = best;
      }
    }
    return top.value;
  }
}

// Distance from a point to the shrine-to-shrine segment. The bot uses it to
// keep its network in the corridor that actually matters: on a board this size
// the densest cluster can be nowhere near the race.
function distanceToCorridor(point, shrineA, shrineB) {
  const dx = shrineB.x - shrineA.x;
  const dy = shrineB.y - shrineA.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, shrineA);
  let t = ((point.x - shrineA.x) * dx + (point.y - shrineA.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (shrineA.x + dx * t), point.y - (shrineA.y + dy * t));
}

export const LINO_BOT_ID = "__lino_bot__";
export const LINO_BOT_SEAT = 1; // start_bot seats the bot second

// One strength: play as well as we know how. Difficulty levels were removed —
// the interesting knobs turned out to be spending discipline, not speed.
//
// The hop cap is the economy lever: short hops chain through more dots, and
// group size *is* income, so the ramp compounds. Simulation over 60 maps: a
// $30 hop cap wins in ~36s, $70 in ~48s, and a single direct $140 line — the
// cheapest possible route — is the *worst* at ~62s.
const THINK_MS = 400;
// Dollar ceilings on a single hop — the sweet spot the 60-map simulation found
// (chaining beats long spans). They are converted to board units per match by
// boardMetrics, because both the cost dial and the dot count move that number.
const MAX_HOP_COST = 30;
const ECON_HOP_COST = 21;

// Only bother trying to sabotage once the opponent is genuinely close.
const THREAT_COST = 60;

// Defense: hunt cheap cuts that split the opponent's group. A cut is worth it
// when it costs at most PAYBACK dollars per point of group income destroyed
// (every dot in their group pays every second, so damage compounds fast).
const HARASS_MAX_COST = 50;
const HARASS_PAYBACK = 15; // $ per point of foe-group damage
const HARASS_COOLDOWN_MS = 8000; // don't turn into a pure griefer

// Economy phase: before racing for the shrines, grow one dense network by
// repeatedly adding the shortest possible link. Group size IS income, so a
// 15-dot net pays $3/s at the default rate — that war chest then funds the
// race and the cutting. Racing starts only once the net hits target AND the
// opponent isn't close to connecting.
const ECON_TARGET = 15; // dots in our largest group before we race

// Every distance the bot works at, derived per match rather than hardcoded:
// the cost dial and the dot count both move them, and the values that used to
// be constants were only correct for one particular pair of settings.
//
// `spacing` is the mean gap between dots. The hop caps are dollar ceilings, but
// never shorter than ~2.1 spacings — that keeps roughly 14 dots within reach of
// each dot, below which the graph of legal hops stops being connected and the
// planner simply finds no route at all.
function boardMetrics(dots, settings) {
  const spacing = Math.sqrt((BOARD_WIDTH * BOARD_HEIGHT) / Math.max(1, dots.length));
  const perUnit = costPerUnit(settings);
  const race = Math.max(spacing * 2.1, MAX_HOP_COST / perUnit);
  return {
    race, // longest hop on the shrine route
    econ: Math.max(spacing * 1.5, ECON_HOP_COST / perUnit), // longest economy link
    threat: race * 1.45, // looser cap when sizing up the opponent
    dense: spacing * 1.1, // radius used to find the densest seed area
    cutReach: spacing * 1.5, // how far from an enemy pipe a cut may be anchored
    cutSpan: Math.max(race, HARASS_MAX_COST / perUnit), // longest cutting line
    // How far off the shrine-to-shrine line the economy net may stray. The
    // board extends well past this; out there a net earns money but builds no
    // roadbed for the race.
    corridor: spacing * 2.7
  };
}

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

  // Lines we already own are free roadbed and may be longer than maxHop, so
  // they're walked as explicit edges rather than found by the radius search.
  const freeEdges = new Map(); // dotId -> [dotId]
  const link = (a, b) => {
    if (!freeEdges.has(a)) freeEdges.set(a, []);
    freeEdges.get(a).push(b);
  };
  lines.forEach((line) => {
    if (line.player !== seat) return;
    link(line.from, line.to);
    link(line.to, line.from);
  });

  // Hops the house rules make outright impossible are excluded here rather
  // than discovered one failed build at a time. Without this the planner keeps
  // proposing hops across our own network; every one gets blocklisted, and
  // since the blocklist only clears when a line is built, nothing ever gets
  // built again — a permanent deadlock.
  const byId = new Map(dots.map((dot) => [dot.id, dot]));
  const walls = lines.filter(
    (line) => line.brass || (!rules.allowSelfCross && line.player === seat)
  );
  const hitsWall = (a, b) =>
    walls.some((line) => {
      if (line.from === a.id || line.to === a.id) return false;
      if (line.from === b.id || line.to === b.id) return false;
      const p = byId.get(line.from);
      const q = byId.get(line.to);
      return p && q && segmentsCross(a, b, p, q);
    });

  const grid = spatialGrid(dots, maxHop);
  const dist = dots.map(() => Infinity);
  const prev = dots.map(() => -1);
  const done = dots.map(() => false);
  dist[start] = 0;

  const heap = new MinHeap();
  heap.push(start, 0);
  while (heap.size) {
    const current = heap.pop();
    if (done[current]) continue;
    done[current] = true;
    if (current === goal) break;
    const from = dots[current];

    const relax = (toId, weight) => {
      const next = index.get(toId);
      if (next === undefined || done[next]) return;
      const total = dist[current] + weight;
      if (total >= dist[next]) return;
      dist[next] = total;
      prev[next] = current;
      heap.push(next, total);
    };

    // Own lines first: free, and they bypass the foe-held rule the same way
    // the old weight function did by checking `owned` before anything else.
    (freeEdges.get(from.id) || []).forEach((toId) => relax(toId, 0));

    if (foeHeld.has(from.id)) continue; // no new line may start here
    grid.within(from, maxHop).forEach((to) => {
      if (to.id === from.id || foeHeld.has(to.id)) return;
      const key = edgeKey(from.id, to.id);
      if (owned.has(key) || blocked.has(key)) return;
      if (hitsWall(from, to)) return;
      relax(to.id, lineCost(from, to, rules));
    });
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

// Every pair of dots worth testing as a cut: both ends have to sit near an
// opponent line for the new segment to have any chance of crossing one, and
// the segment itself is capped at CUT_SPAN. On the full board this is the
// difference between a few thousand checks and a few hundred thousand.
function forEachCutPair(dots, lines, seat, metrics, visit) {
  const byId = new Map(dots.map((dot) => [dot.id, dot]));
  const foeLines = lines.filter((line) => line.player !== seat && !line.brass);
  if (!foeLines.length) return;

  const { cutReach, cutSpan } = metrics;
  const grid = spatialGrid(dots, cutReach);
  const anchors = new Map();
  foeLines.forEach((line) => {
    const a = byId.get(line.from);
    const b = byId.get(line.to);
    if (!a || !b) return;
    // Sample along the pipe so a long one is covered end to end.
    const steps = Math.max(1, Math.ceil(distance(a, b) / cutReach));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      grid.within(point, cutReach).forEach((dot) => anchors.set(dot.id, dot));
    }
  });

  const reach = spatialGrid([...anchors.values()], cutSpan);
  anchors.forEach((a) => {
    reach.within(a, cutSpan).forEach((b) => {
      if (a.id >= b.id) return; // each unordered pair once
      visit(a, b);
    });
  });
}

// Cheapest legal build that destroys at least one opponent line.
function findCut(state, seat, metrics) {
  const { dots, lines, money, settings } = state;
  let best = null;
  forEachCutPair(dots, lines, seat, metrics, (a, b) => {
    if (best && lineCost(a, b, settings) >= best.cost) return;
    const result = evaluateBuild({
      dots,
      lines,
      seat,
      money: money[seat],
      fromId: a.id,
      toId: b.id,
      settings
    });
    if (!result.ok || !result.destroys.length) return;
    if (!best || result.cost < best.cost) {
      best = { fromId: a.id, toId: b.id, cost: result.cost };
    }
  });
  return best;
}

// Defensive play: the best cheap cut on the opponent's network, judged by how
// much of their largest group (= income) it severs per dollar. Short victim
// lines cost little to destroy and short cutting lines cost little to build,
// so "snip the weak middle link" falls out of the scoring naturally. All house
// rules (requireLonger, brass, taken dots…) are enforced by evaluateBuild.
function findHarassCut(state, seat, metrics) {
  const { dots, lines, money, settings } = state;
  const foe = 1 - seat;
  const foeBefore = largestGroupSize(lines, foe);
  if (foeBefore < 3) return null; // nothing worth splitting yet

  const ourBefore = largestGroupSize(lines, seat);
  let best = null;
  forEachCutPair(dots, lines, seat, metrics, (a, b) => {
    if (lineCost(a, b, settings) > HARASS_MAX_COST) return;
    const result = evaluateBuild({
      dots,
      lines,
      seat,
      money: money[seat],
      fromId: a.id,
      toId: b.id,
      settings
    });
    if (!result.ok || !result.destroys.length) return;
    if (result.cost > HARASS_MAX_COST) return;

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
    if (damage < 2) return;
    // Never a cut that takes our own network down with it (cascades can).
    if (largestGroupSize(remaining, seat) < ourBefore) return;
    if (result.cost > damage * HARASS_PAYBACK) return;

    const score = damage / result.cost;
    if (!best || score > best.score) {
      best = { fromId: a.id, toId: b.id, cost: result.cost, score };
    }
  });
  return best;
}

// Economy growth: the cheapest structurally-legal link that attaches one new
// dot to our biggest component (or seeds a component in the densest area of
// the board). Returns a move, "wait" when the best link exists but isn't
// affordable yet, or null when there's nothing left worth expanding into.
function findEconomyBuild(state, seat, metrics) {
  const { dots, lines, money, settings } = state;
  const evalPair = (a, b) =>
    evaluateBuild({ dots, lines, seat, money: money[seat], fromId: a.id, toId: b.id, settings });

  const byId = new Map(dots.map((dot) => [dot.id, dot]));
  const shrineA = byId.get(SHRINE_A_ID);
  const shrineB = byId.get(SHRINE_B_ID);
  // The net is only useful as roadbed if it lies along the race. Off the
  // corridor it is pure income with no head start, so expansion stays inside
  // a band around the shrine-to-shrine line.
  const inCorridor = (dot) =>
    !shrineA || !shrineB || distanceToCorridor(dot, shrineA, shrineB) <= metrics.corridor;

  const components = playerComponents(lines, seat);
  let main = [];
  components.forEach((c) => {
    if (c.length > main.length) main = c;
  });
  const inNet = new Set(main);

  const grid = spatialGrid(dots, Math.max(metrics.econ, metrics.dense));

  // Candidate endpoints: the whole net, or — before the first line exists —
  // the dots sitting in the densest neighbourhoods along the corridor.
  let sources;
  if (inNet.size === 0) {
    sources = dots
      .filter(inCorridor)
      .map((dot) => ({ dot, n: grid.within(dot, metrics.dense).length }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 8)
      .map((x) => x.dot);
  } else {
    sources = main.map((id) => byId.get(id)).filter(Boolean);
  }

  let best = null; // { move, span, reason }
  for (const from of sources) {
    for (const to of grid.within(from, metrics.econ)) {
      if (to.id === from.id || inNet.has(to.id) || !inCorridor(to)) continue;
      const span = distance(from, to);
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

// How many thinks in a row may produce nothing before we assume the blocklist
// itself is the problem and drop it. ~5s at THINK_MS.
const IDLE_THINKS_BEFORE_RESET = 12;

// Decide this tick's move, or null to keep saving. Wraps decideMove purely to
// keep the blocklist from becoming a trap: it is only cleared when the board
// changes, so anything that stops the bot building also stops the clear.
export function chooseBotMove(state, seat, memory) {
  const move = decideMove(state, seat, memory);
  if (move) {
    memory.idleThinks = 0;
    return move;
  }
  memory.idleThinks = (memory.idleThinks ?? 0) + 1;
  if (memory.idleThinks >= IDLE_THINKS_BEFORE_RESET) {
    memory.idleThinks = 0;
    memory.blocked.clear();
  }
  return null;
}

function decideMove(state, seat, memory) {
  const { dots, lines, money, settings } = state;

  // A changed board can unblock hops that were previously illegal.
  if (memory.lineCount !== lines.length) {
    memory.blocked.clear();
    memory.lineCount = lines.length;
  }

  const metrics = boardMetrics(dots, settings);
  const route = shortestRoute(dots, lines, seat, memory.blocked, metrics.race, settings);
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
  const foeRoute = shortestRoute(dots, lines, foe, new Set(), metrics.threat, settings);
  const foeClose = !!foeRoute && foeRoute.cost < THREAT_COST;
  if (foeClose) {
    const cut = findCut(state, seat, metrics);
    if (cut) return cut;
  }

  // 3. Deny their economy: snip a cheap middle link in their network when the
  //    income damage clearly outweighs the price. Rate-limited so the bot
  //    stays a builder that harasses, not a griefer that never advances.
  const now = Date.now();
  if (now - (memory.lastHarass ?? 0) > HARASS_COOLDOWN_MS) {
    const harass = findHarassCut(state, seat, metrics);
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
    const econ = findEconomyBuild(state, seat, metrics);
    if (econ === "wait") return null; // saving for the next short link
    if (econ) return econ;
    // nothing left to expand into — fall through to the race
  }

  // Boxed in — every route is blocked (usually brass across the corridor).
  // Breaking one of their lines is the only way back into the game.
  if (!route) return findCut(state, seat, metrics);

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
