// Pure Lino rules: geometry, costs, and graph queries. No DOM, no sockets.
// Imported by BOTH the server (authoritative validation) and the client
// (cost preview) so the two can never disagree about what's legal.

export const BOARD_WIDTH = 220;
export const BOARD_HEIGHT = 120;

// Tuned together with the board size: the shrine gap is 200 units, so at 0.7
// a direct span still costs ~$140 — the same as on the old 160x100 board.
// Bigger screen, same economy.
export const COST_PER_UNIT = 0.7; // dollars per board unit of line length
export const SHRINE_A_ID = "shrine-a";
export const SHRINE_B_ID = "shrine-b";

// Per-match rules, chosen in the pre-game setup screen. All default off, so
// the plain game is: cut anything you can pay for, keep off dots the enemy
// holds, don't weave through yourself, and cutting removes only the line.
export const DEFAULT_SETTINGS = {
  // A line that destroys another turns to brass: permanently indestructible,
  // and therefore an uncrossable wall. Cuts can't loop — every battle closes
  // a corridor for good. On by default; it's the game's anti-stalemate.
  brassPipes: true,
  // A cutting line must be strictly longer than the line it destroys.
  requireLonger: false,
  // You may connect to a dot the opponent already has a line on.
  allowOpponentDots: false,
  // You may cross your own lines. Doing so is free and destroys nothing.
  allowSelfCross: false,
  // Cutting a line also destroys its two end dots, and every line touching
  // them. Deliberately one level deep — no further cascade.
  destroyDots: false,
  // --- economy dials (sliders in the setup screen) ---
  // Line price knob: 50 keeps the baseline COST_PER_UNIT, 100 doubles it,
  // 0 makes every line the $1 minimum.
  costScale: 50,
  // $1 of base income every this many seconds.
  baseIncomeSecs: 0.5,
  // The largest group pays its size every this many seconds.
  groupIncomeSecs: 2,
  // Dots scattered on the board (plus the two shrines).
  dotCount: 65
};

// Slider bounds, shared by the setup UI and server-side sanitizing.
// dotCount tops out where MIN_SPACING still lets the sampler place them all.
export const SETTING_RANGES = {
  costScale: { min: 0, max: 100, step: 1 },
  baseIncomeSecs: { min: 0.1, max: 5, step: 0.1 },
  groupIncomeSecs: { min: 0.1, max: 5, step: 0.1 },
  dotCount: { min: 10, max: 110, step: 5 }
};

// Client input is untrusted: keep known boolean keys and clamp the numbers.
export function sanitizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object") {
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      const range = SETTING_RANGES[key];
      if (range) {
        const value = Number(raw[key]);
        if (Number.isFinite(value)) {
          settings[key] = Math.min(range.max, Math.max(range.min, value));
        }
      } else if (typeof raw[key] === "boolean") {
        settings[key] = raw[key];
      }
    });
  }
  return settings;
}

// Effective $ per board unit under this match's cost dial.
export function costPerUnit(settings) {
  const scale = (settings?.costScale ?? DEFAULT_SETTINGS.costScale) / 50;
  return COST_PER_UNIT * scale;
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lineCost(a, b, settings) {
  return Math.max(1, Math.ceil(distance(a, b) * costPerUnit(settings)));
}

function orient(p, q, r) {
  const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}

// Proper crossing only: segments that merely touch at an endpoint, or that are
// collinear, do not count. Lines meeting at a shared dot are joins, not cuts.
export function segmentsCross(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function dotMapOf(dots) {
  return new Map(dots.map((dot) => [dot.id, dot]));
}

// Decide whether `seat` may connect fromId->toId right now, and at what price.
// Always reports `cost` and `destroys` even when it fails, so the UI can show
// the player *why* a build is out of reach.
export function evaluateBuild({ dots, lines, seat, money, fromId, toId, settings }) {
  const rules = settings || DEFAULT_SETTINGS;
  const byId = dotMapOf(dots);
  const from = byId.get(fromId);
  const to = byId.get(toId);
  const fail = (reason, cost = 0, destroys = [], length = 0) => ({
    ok: false,
    reason,
    cost,
    destroys,
    length
  });

  if (!from || !to || fromId === toId) return fail("invalid");
  const duplicate = lines.some(
    (line) =>
      (line.from === fromId && line.to === toId) ||
      (line.from === toId && line.to === fromId)
  );
  if (duplicate) return fail("exists");

  // A dot counts as the opponent's once any of their lines touches it — but
  // shrines are never claimable, so either player can always build to them.
  if (!rules.allowOpponentDots) {
    const heldByFoe = (dot) =>
      !dot.shrine &&
      lines.some((line) => line.player !== seat && (line.from === dot.id || line.to === dot.id));
    if (heldByFoe(from) || heldByFoe(to)) return fail("taken");
  }

  const length = distance(from, to);
  const baseCost = lineCost(from, to, rules);

  // Everything the new segment properly crosses, skipping lines that share a
  // dot with it (those touch by construction).
  const crossed = [];
  for (const line of lines) {
    if (
      line.from === fromId ||
      line.to === fromId ||
      line.from === toId ||
      line.to === toId
    ) {
      continue;
    }
    const a = byId.get(line.from);
    const b = byId.get(line.to);
    if (!a || !b) continue;
    if (segmentsCross(from, to, a, b)) crossed.push({ line, len: distance(a, b) });
  }

  // Crossing your own lines is either forbidden or free — never a cut.
  if (!rules.allowSelfCross && crossed.some((c) => c.line.player === seat)) {
    return fail("self-cross", 0, [], length);
  }

  const enemy = crossed.filter((c) => c.line.player !== seat);

  // Brass is forever: it can't be destroyed, so it can't be built across.
  if (enemy.some((c) => c.line.brass)) {
    return fail("brass", 0, [], length);
  }

  const destroys = enemy.map((c) => c.line.id);
  // Pay for the new line plus every line it cuts.
  const cost = baseCost + enemy.reduce((sum, c) => sum + c.line.cost, 0);

  if (rules.requireLonger && enemy.some((c) => length <= c.len)) {
    return { ok: false, reason: "too-short", cost, destroys, length };
  }
  if (money < cost) return { ok: false, reason: "poor", cost, destroys, length };

  // The kill is what tempers the new line into brass.
  const becomesBrass = rules.brassPipes && enemy.length > 0;
  return { ok: true, reason: null, cost, destroys, length, becomesBrass };
}

// Everything that actually disappears when `cutLineIds` are destroyed.
//
// With `destroyDots` on, the cut lines take their end dots with them, and any
// line touching those dots dies too — but the dots at the FAR end of those
// lines survive, which is what stops the cascade from running away. Shrines
// are never destroyed (losing one would make the match unwinnable), and dots
// with a brass line attached are blast-proof — brass is indestructible, so it
// can never be left dangling on a dead dot.
export function resolveDestruction({ dots, lines, cutLineIds, settings }) {
  const rules = settings || DEFAULT_SETTINGS;
  const cut = new Set(cutLineIds);
  if (!rules.destroyDots || cut.size === 0) {
    return { lineIds: cut, dotIds: new Set() };
  }

  const brassHeld = new Set();
  lines.forEach((line) => {
    if (line.brass) {
      brassHeld.add(line.from);
      brassHeld.add(line.to);
    }
  });

  const byId = dotMapOf(dots);
  const dotIds = new Set();
  lines.forEach((line) => {
    if (!cut.has(line.id)) return;
    [line.from, line.to].forEach((dotId) => {
      const dot = byId.get(dotId);
      if (dot && !dot.shrine && !brassHeld.has(dotId)) dotIds.add(dotId);
    });
  });

  const lineIds = new Set(cut);
  lines.forEach((line) => {
    if (dotIds.has(line.from) || dotIds.has(line.to)) lineIds.add(line.id);
  });
  return { lineIds, dotIds };
}

// Connected components of one player's network, as arrays of dot ids.
export function playerComponents(lines, seat) {
  const adjacency = new Map();
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push(b);
  };
  lines.forEach((line) => {
    if (line.player !== seat) return;
    link(line.from, line.to);
    link(line.to, line.from);
  });

  const seen = new Set();
  const components = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const component = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

// This is the player's periodic income: the size of their biggest group.
export function largestGroupSize(lines, seat) {
  return playerComponents(lines, seat).reduce(
    (best, component) => Math.max(best, component.length),
    0
  );
}

export function connectsShrines(lines, seat) {
  return playerComponents(lines, seat).some(
    (component) => component.includes(SHRINE_A_ID) && component.includes(SHRINE_B_ID)
  );
}
