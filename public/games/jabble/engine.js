// Jabble: real-time top-down stadium game. Two teams, each with its own balls
// (one to three). Your own balls bounce off you like off anything else, and a
// jab (an arm thrown out in one of eight directions) launches one hard that
// way. The OTHER team's balls kill whatever of yours they touch — your square,
// or your arm mid-jab. A jab that lands on an opposing PLAYER sends them flying
// the way a kick sends a ball. Last team standing takes the round; first to
// `winScore` rounds wins. The arena is set out once a match, and the teams
// change ends every round.
//
// The stadium's four sides bow gently outward, so a ball that hits one
// square-on still comes back a little off its line — by how much depends on
// where it struck, never on chance. Inside stand a few long, thin, straight
// bars, each at an angle of its own. Each solid is just a distance function:
// a ball pushes off it directly, and a player's square tests it at points
// round its rim.
//
// A match carries its numbers as `tune`: TUNING with whatever the table has
// set on the sliders (SETTINGS) on top, so everything below reads `tune`,
// never TUNING. That includes the surface: grass gives players grip, ice
// makes them slide, and switching changes nothing else.
//
// It runs on BOTH sides. The server (server/games/jabble) owns the real match
// at a fixed TICK_HZ. Each browser runs it too, in "predict" mode, to move
// its own square the instant a key goes down rather than a round trip later
// (see predict.js) — so this file must stay free of anything Node-only.

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
// Collision runs in enough substeps per tick that nothing moves further than
// MAX_STEP between checks, so even the hardest kick can't carry the smallest
// ball through a 16-unit bar.
const MAX_STEP = 8;
const MIN_SUBSTEPS = 2;
const MAX_SUBSTEPS = 12;

export const TUNING = {
  arenaW: 1200,
  arenaH: 720,
  edgeBow: 36, // how far each side of the stadium bows outward at its middle

  playerSize: 40,
  ice: 1, // the surface: 0 grass, 1 ice
  playerSpeed: 280, // units/s at full tilt
  playerAccel: 2600, // units/s² toward the held direction (and back to a stop)
  // On ice (`ice: 1`, a setting) there's no grip: keys PUSH you at iceAccel
  // rather than set your speed, you coast, losing only iceFriction of your
  // speed a second, and you come off walls with a little iceWallBounce.
  iceAccel: 800,
  iceFriction: 0.5,
  iceMaxSpeed: 380,
  iceWallBounce: 0.35,

  ballsPerTeam: 2,
  ballRadius: 30,
  ballDrag: 0.55, // speed bled per second, as e^-drag (0.55 ≈ 42% a second)
  ballStopSpeed: 6, // below this a ball comes to rest
  ballMaxSpeed: 1400, // or 1.35 × kickSpeed, whichever is more
  wallBounce: 1.1, // restitution off walls (balls, and players sent flying); over 1 adds speed
  bodyBounce: 0.3, // off a player's body — soft, so you can trap your ball
  ballBounce: 0.9, // ball against ball

  kickSpeed: 1300, // a jab sets your ball to exactly this, in the jab direction
  // ...and an opponent it lands on to this. A player sent flying can't steer:
  // they slow by flightDrag, bounce off walls like a ball, and get control
  // back once they're down to their normal top speed.
  playerKickSpeed: 900,
  flightDrag: 2.5,
  jabReach: 100, // how far the fist travels past the edge of your square
  fistRadius: 12,
  armRadius: 5, // the arm behind the fist is a hitbox too, just a thinner one
  jabOutTicks: 3, // arm extending
  jabHoldTicks: 4, // fully out
  jabBackTicks: 3, // retracting — still a hitbox while it's out at all
  jabCooldownTicks: 21, // 0.35 s from one jab's start to the next
  jabBufferTicks: 8, // a jab pressed this close to being ready fires when it is

  obstacles: 0, // straight bars, set out once a match

  countdownTicks: 36, // frozen "ready" before each round (0.6 s)
  overTicks: 54, // pause after a round is decided (0.9 s)
  winScore: 11
};

// The sliders a table can move mid-match, and how far. Most change the match
// the moment they move; those marked `nextRound` change what gets set out
// (how many balls, how big things are, the obstacles), so they wait for the
// next round rather than, say, growing a ball into someone. `only` keeps a
// slider to the surface it means something on; `choices` makes a setting a
// pick of named options (its value is the option's index). The server clamps
// every change to these bounds; the client draws the panel from this list.
export const SETTINGS = [
  { key: "ballsPerTeam", group: "Balls", label: "Balls per team", min: 1, max: 3, step: 1, nextRound: true },
  { key: "ballRadius", group: "Balls", label: "Ball size", min: 8, max: 80, step: 1, nextRound: true },
  { key: "ballDrag", group: "Balls", label: "Ball friction", min: 0, max: 2.5, step: 0.05 },
  { key: "wallBounce", group: "Balls", label: "Wall bounce", min: 0.2, max: 1.2, step: 0.05 },
  { key: "bodyBounce", group: "Balls", label: "Bounce off players", min: 0, max: 1.2, step: 0.05 },
  { key: "jabReach", group: "Jab", label: "Reach", min: 10, max: 320, step: 2 },
  { key: "kickSpeed", group: "Jab", label: "Kick power", min: 300, max: 2600, step: 25 },
  { key: "playerKickSpeed", group: "Jab", label: "Player knockback", min: 0, max: 2500, step: 25 },
  { key: "jabCooldownTicks", group: "Jab", label: "Cooldown", min: 6, max: 72, step: 1 },
  { key: "ice", group: "Player", label: "Surface", min: 0, max: 1, step: 1, choices: ["Grass", "Ice"] },
  { key: "playerSpeed", group: "Player", label: "Speed", min: 120, max: 650, step: 10, only: "grip" },
  { key: "playerAccel", group: "Player", label: "Grip", min: 400, max: 8000, step: 100, only: "grip" },
  { key: "iceAccel", group: "Player", label: "Push", min: 150, max: 3000, step: 25, only: "ice" },
  { key: "iceMaxSpeed", group: "Player", label: "Top speed", min: 150, max: 900, step: 10, only: "ice" },
  { key: "iceFriction", group: "Player", label: "Ice friction", min: 0, max: 4, step: 0.05, only: "ice" },
  { key: "iceWallBounce", group: "Player", label: "Wall rebound", min: 0, max: 1, step: 0.05, only: "ice" },
  { key: "playerSize", group: "Player", label: "Size", min: 18, max: 72, step: 2, nextRound: true },
  { key: "obstacles", group: "Arena", label: "Obstacles", min: 0, max: 8, step: 1, nextRound: true },
  { key: "winScore", group: "Arena", label: "First to", min: 1, max: 21, step: 1 }
];
const SETTING_BY_KEY = new Map(SETTINGS.map((def) => [def.key, def]));

// Named sets of slider values a table can switch to in one go. Each lists
// every setting, so a preset stays exactly as it was made even when the
// defaults move on.
export const PRESETS = [
  {
    id: "bunda",
    name: "Bunda mode",
    // The user's own favourite, saved from their sliders on Oct 30 2026:
    // grass, quick on your feet, smaller balls, four bars.
    settings: {
      ballsPerTeam: 2,
      ballRadius: 26,
      ballDrag: 0.55,
      wallBounce: 1.1,
      bodyBounce: 0.3,
      jabReach: 100,
      kickSpeed: 1300,
      playerKickSpeed: 900,
      jabCooldownTicks: 21,
      ice: 0,
      playerSpeed: 440,
      playerAccel: 2600,
      iceAccel: 800,
      iceMaxSpeed: 380,
      iceFriction: 0.5,
      iceWallBounce: 0.35,
      playerSize: 40,
      obstacles: 4,
      winScore: 11
    }
  }
];

// A slider value pulled onto its step and inside its bounds; null if it isn't
// a number at all.
function settle(def, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const stepped = def.min + Math.round((v - def.min) / def.step) * def.step;
  return Math.min(def.max, Math.max(def.min, Math.round(stepped * 1000) / 1000));
}

export function defaultSettings() {
  return Object.fromEntries(SETTINGS.map((def) => [def.key, TUNING[def.key]]));
}

// A table's chosen values (from a saved set, say), with anything missing or
// out of bounds put back to the game's default.
export function sanitizeSettings(raw) {
  const out = defaultSettings();
  if (!raw || typeof raw !== "object") return out;
  for (const def of SETTINGS) {
    if (!(def.key in raw)) continue;
    const v = settle(def, raw[def.key]);
    if (v !== null) out[def.key] = v;
  }
  return out;
}

const KEY_UP = 1;
const KEY_DOWN = 2;
const KEY_LEFT = 4;
const KEY_RIGHT = 8;

// --- arena ------------------------------------------------------------------

// The stadium's sides are arcs of four big circles, and the floor is whatever
// lies inside all four. Each side touches the arena's box at its middle; the
// corners sit edgeBow in from the box's corners, where neighbouring sides meet
// at a little over 90°, so nothing wedges there. Every side carries the
// angles it runs between, clockwise, which is how the client traces the floor.
const RIMS = (() => {
  const { arenaW: W, arenaH: H, edgeBow: s } = TUNING;
  const rLong = ((W / 2 - s) ** 2 + s ** 2) / (2 * s); // top and bottom
  const rShort = ((H / 2 - s) ** 2 + s ** 2) / (2 * s); // left and right
  const corners = [
    { x: s, y: s },
    { x: W - s, y: s },
    { x: W - s, y: H - s },
    { x: s, y: H - s }
  ];
  const circles = [
    { x: W / 2, y: rLong, r: rLong },
    { x: W - rShort, y: H / 2, r: rShort },
    { x: W / 2, y: H - rLong, r: rLong },
    { x: rShort, y: H / 2, r: rShort }
  ];
  return circles.map((c, i) => {
    const from = corners[i];
    const to = corners[(i + 1) % 4];
    return {
      kind: "rim",
      ...c,
      a0: Math.atan2(from.y - c.y, from.x - c.x),
      a1: Math.atan2(to.y - c.y, to.x - c.x)
    };
  });
})();

// Everything a round's balls and players can hit: the rims plus its obstacles.
export function collidersFor(solids) {
  return RIMS.concat(solids);
}

// Signed distance from (x, y) to a solid (negative inside it), with the unit
// normal pointing out of the solid toward open floor. The two kinds:
//   rim - the outside of one of the stadium's four circles
//   bar - a straight bar from (x1, y1) to (x2, y2), half-width w, round ends
function distanceTo(solid, x, y) {
  if (solid.kind === "rim") {
    const dx = solid.x - x;
    const dy = solid.y - y;
    const len = Math.hypot(dx, dy);
    return { d: solid.r - len, nx: dx / len, ny: dy / len };
  }
  const abx = solid.x2 - solid.x1;
  const aby = solid.y2 - solid.y1;
  const t = Math.max(0, Math.min(1, ((x - solid.x1) * abx + (y - solid.y1) * aby) / (abx * abx + aby * aby)));
  const dx = x - (solid.x1 + abx * t);
  const dy = y - (solid.y1 + aby * t);
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) return { d: len - solid.w, nx: dx / len, ny: dy / len };
  // Dead on the centre line: out through the nearer face, at right angles.
  const ab = Math.hypot(abx, aby);
  return { d: -solid.w, nx: -aby / ab, ny: abx / ab };
}

const EDGE_GAP = 56; // obstacles keep off the edge: a lane runs all the way round
const OBSTACLE_GAP = 64; // and off each other, so every pocket is reachable
// ...or wider, whatever a ball or player would need to fit through a gap: a
// ball shoved into a gap narrower than itself would sit wedged between two
// walls being pushed back and forth by both.
function gapsFor(tune) {
  const fits = Math.max(2 * tune.ballRadius, tune.playerSize * Math.SQRT2) + 16;
  return { edge: Math.max(EDGE_GAP, fits), between: Math.max(OBSTACLE_GAP, fits) };
}

// A height for one end's start, drawn once per match: the two ends get
// different ones, and the teams swap ends every round, so each team plays
// both.
function randomStartHeight() {
  return TUNING.arenaH / 2 + Math.round((Math.random() - 0.5) * 300);
}

// Each team starts at an end — blue on the left unless `swapped` — at that
// end's height (`heights`, left then right), with its balls in a column in
// front of it (squeezed together if a column of big ones wouldn't otherwise
// fit).
function spawnLayout(tune, teamSizes, heights, swapped) {
  const { arenaW: W, arenaH: H, edgeBow } = TUNING;
  const half = tune.playerSize / 2;
  const r = tune.ballRadius;
  const n = tune.ballsPerTeam;
  const margin = edgeBow + r + 24;
  const ballGap = n > 1 ? Math.min(2 * r + 30, (H - 2 * margin) / (n - 1)) : 0;
  const playerGap = tune.playerSize + 56;
  const players = [];
  const balls = [];
  teamSizes.forEach((count, team) => {
    const end = swapped ? 1 - team : team; // 0 left, 1 right
    const extent =
      Math.max(ballGap * (n - 1), playerGap * (count - 1)) / 2 + Math.max(margin, half + edgeBow + 30);
    const y0 = extent >= H / 2 ? H / 2 : Math.min(H - extent, Math.max(extent, heights[end]));
    const inward = end === 0 ? 1 : -1;
    const playerX = (end === 0 ? 0 : W) + inward * (edgeBow + 74);
    const ballX = playerX + inward * (half + r + 107);
    for (let k = 0; k < count; k += 1) {
      players.push({ team, x: playerX, y: y0 + (k - (count - 1) / 2) * playerGap });
    }
    for (let k = 0; k < n; k += 1) {
      balls.push({ team, x: ballX, y: y0 + (k - (n - 1) / 2) * ballGap });
    }
  });
  return { players, balls };
}

// A long, thin, straight bar centred anywhere, at any angle.
const BAR_LENGTH = [140, 210];
const BAR_HALF_WIDTH = 8;

function randomObstacle() {
  const { arenaW: W, arenaH: H } = TUNING;
  const x = EDGE_GAP + Math.random() * (W - 2 * EDGE_GAP);
  const y = EDGE_GAP + Math.random() * (H - 2 * EDGE_GAP);
  const half = (BAR_LENGTH[0] + Math.random() * (BAR_LENGTH[1] - BAR_LENGTH[0])) / 2;
  const angle = Math.random() * Math.PI;
  const dx = Math.cos(angle) * half;
  const dy = Math.sin(angle) * half;
  return { kind: "bar", x1: x - dx, y1: y - dy, x2: x + dx, y2: y + dy, w: BAR_HALF_WIDTH };
}

// An obstacle as a row of discs down its middle, close enough together to
// measure clearances against.
function spine(solid) {
  const steps = Math.max(2, Math.ceil(Math.hypot(solid.x2 - solid.x1, solid.y2 - solid.y1) / 8));
  const discs = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    discs.push({ x: solid.x1 + (solid.x2 - solid.x1) * t, y: solid.y1 + (solid.y2 - solid.y1) * t, r: solid.w });
  }
  return discs;
}

// Bars scattered anywhere, spaced so that nothing seals off a pocket, with
// every layout in `spawnSets` left clear. The bars in `keep` (last round's)
// stay wherever they still fit, so an arena lasts the whole match and a
// slider only changes what it has to; new ones top it up to `count`. A
// crowded arena may come up short.
function generateObstacles(tune, spawnSets, count, keep = []) {
  const clear = spawnSets.flatMap((spawns) => [
    ...spawns.players.map((point) => ({ point, radius: Math.max(95, tune.playerSize + 61) })),
    ...spawns.balls.map((point) => ({ point, radius: tune.ballRadius + 59 }))
  ]);
  const gaps = gapsFor(tune);
  const placed = [];
  const fits = (solid) =>
    spine(solid).every(
      (disc) =>
        RIMS.every((rim) => distanceTo(rim, disc.x, disc.y).d - disc.r >= gaps.edge) &&
        placed.every((other) => distanceTo(other, disc.x, disc.y).d - disc.r >= gaps.between)
    ) && !clear.some((c) => distanceTo(solid, c.point.x, c.point.y).d < c.radius);
  for (const solid of keep) {
    if (placed.length < count && fits(solid)) placed.push(solid);
  }
  for (let attempt = 0; attempt < 100 * count && placed.length < count; attempt += 1) {
    const solid = randomObstacle();
    if (fits(solid)) placed.push(solid);
  }
  return placed;
}

// --- match lifecycle --------------------------------------------------------

// One seat per player; seats alternate teams (0 blue, 1 red, 2 blue, ...).
// `settings` are the sliders the table starts with (anything left out, or out
// of bounds, is the game's default).
export function createMatch(seatCount = 2, settings = null) {
  const players = [];
  for (let seat = 0; seat < seatCount; seat += 1) {
    players.push({
      seat,
      team: seat % 2,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      keys: 0,
      alive: true,
      jab: null, // { dx, dy, t, hit, hitPlayers } — a bit per ball / seat it has already struck
      cooldown: 0,
      pendingJab: null, // { dx, dy, ttl }
      flying: false // knocked away by a jab, and not yet slowed to a walk
    });
  }
  const state = {
    tune: { ...TUNING }, // the numbers in force (round-start ones refresh each round)
    settings: sanitizeSettings(settings), // what the sliders say
    tick: 0,
    round: 0,
    phase: "countdown", // countdown | play | over | matchover
    phaseTicks: 0,
    score: [0, 0],
    solids: [], // the arena's bars, kept from round to round until the match ends
    startHeights: null, // where each end's team starts (left, right), also kept for the match
    swapped: false, // blue starts on the right this round (the teams change ends every round)
    collide: RIMS, // the rims plus the obstacles: everything solid
    players,
    balls: [], // { team, x, y, vx, vy }, set out each round
    lastRound: null, // { winner: team | null }
    rematch: new Set()
  };
  startRound(state);
  return state;
}

// A new match gets a new arena.
export function resetMatch(state) {
  state.score = [0, 0];
  state.round = 0;
  state.lastRound = null;
  state.rematch.clear();
  state.solids = [];
  state.startHeights = null;
  startRound(state);
}

// Moves sliders. Changes that only matter at a round's start are kept in
// `settings` until then; the rest go straight into `tune`. Returns whether
// anything moved.
export function applySettings(state, changes) {
  let moved = false;
  for (const [key, value] of Object.entries(changes ?? {})) {
    const def = SETTING_BY_KEY.get(key);
    const v = def ? settle(def, value) : null;
    if (v === null || v === state.settings[key]) continue;
    state.settings[key] = v;
    if (!def.nextRound) state.tune[key] = v;
    moved = true;
  }
  return moved;
}

export function resetSettings(state) {
  return applySettings(state, defaultSettings());
}

// The arena stays put all match (unless a slider means it has to change);
// only the teams' ends swap, so neither side keeps the better start.
function startRound(state) {
  Object.assign(state.tune, state.settings);
  const { tune } = state;
  state.round += 1;
  state.swapped = state.round % 2 === 0;
  state.startHeights ??= [randomStartHeight(), randomStartHeight()];
  const teamSizes = [0, 0];
  state.players.forEach((p) => (teamSizes[p.team] += 1));
  const spawns = spawnLayout(tune, teamSizes, state.startHeights, state.swapped);
  // Bars keep clear of both ends' starts either way round.
  const otherWay = spawnLayout(tune, teamSizes, state.startHeights, !state.swapped);
  state.solids = generateObstacles(tune, [spawns, otherWay], tune.obstacles, state.solids);
  state.collide = collidersFor(state.solids);

  const next = [0, 0];
  state.players.forEach((p) => {
    const spot = spawns.players.filter((s) => s.team === p.team)[next[p.team]++];
    Object.assign(p, { x: spot.x, y: spot.y, vx: 0, vy: 0 });
    p.alive = true;
    p.jab = null;
    p.cooldown = 0;
    p.pendingJab = null;
    p.flying = false;
    // keys survive the reset: whatever you're holding moves you on "go"
  });
  state.balls = spawns.balls.map(({ team, x, y }) => ({ team, x, y, vx: 0, vy: 0 }));

  state.phase = "countdown";
  state.phaseTicks = tune.countdownTicks;
}

// --- input ------------------------------------------------------------------

export function setKeys(state, seat, mask) {
  const p = state.players[seat];
  if (p) p.keys = mask & 15;
}

// `mask` is the arrow keys pressed together (same bits as movement). Opposite
// pairs cancel; nothing left means no jab.
export function requestJab(state, seat, mask) {
  const p = state.players[seat];
  if (!p || !p.alive || state.phase === "countdown") return;
  const dx = (mask & KEY_RIGHT ? 1 : 0) - (mask & KEY_LEFT ? 1 : 0);
  const dy = (mask & KEY_DOWN ? 1 : 0) - (mask & KEY_UP ? 1 : 0);
  if (!dx && !dy) return;
  const len = Math.hypot(dx, dy);
  p.pendingJab = { dx: dx / len, dy: dy / len, ttl: state.tune.jabBufferTicks };
}

// --- events -----------------------------------------------------------------

// A browser running the engine (predict mode) sets `state.events` to an array,
// and the contacts worth a sound or a spark are pushed onto it as they happen:
//   kick  - a jab launched a ball      { ball, team, seat, x, y, dx, dy, speed }
//   knock - a jab launched a player    { seat, by, x, y, dx, dy, speed }
//   wall  - a ball hit a wall          { ball, team, x, y, nx, ny, speed }
//   clack - two balls hit              { a, b, teams, x, y, speed }
//   body  - a ball came off a player   { ball, team, seat, x, y, speed }
//   slam  - a flying player hit a wall { seat, x, y, speed }
// (x, y) is where it happened and speed how hard. The server never sets it, so
// none of this costs it anything. Deaths aren't here: only the server decides.
const IMPACT_MIN = 70; // softer contacts than this (rolling, resting) say nothing

function emit(state, event) {
  if (state.events) state.events.push(event);
}

// --- geometry ---------------------------------------------------------------

function playerRect(p, size) {
  return { x: p.x - size / 2, y: p.y - size / 2, w: size, h: size };
}

// Points round the rim of a player's square, corners included, in units of
// its half-width. The square meets walls at these, so it sits flush against
// anything rounder than the 8-unit gap between two of them.
const RIM_POINTS = (() => {
  const points = [];
  for (let i = 0; i < 4; i += 1) {
    const t = -1 + i / 2;
    points.push([t, -1], [1, t], [-t, 1], [-1, -t]);
  }
  return points;
})();

// The deepest any rim point of a square centred at (x, y) sits inside a solid
// (d < 0, with that solid's normal there), or null if it's clear.
function squareContact(state, x, y, half) {
  let worst = null;
  for (const solid of state.collide) {
    // Distances change no faster than position, so a centre further off than
    // the square's corners reach rules out every rim point at once.
    if (distanceTo(solid, x, y).d > half * Math.SQRT2) continue;
    for (const [sx, sy] of RIM_POINTS) {
      const hit = distanceTo(solid, x + sx * half, y + sy * half);
      if (hit.d < 0 && (!worst || hit.d < worst.d)) worst = hit;
    }
  }
  return worst;
}

// Slides a player's square out of whatever it has walked into, and takes away
// the part of its velocity that was heading in (on ice, turns a little of it
// back the other way).
function pushOutOfWalls(state, p) {
  const half = state.tune.playerSize / 2;
  const rebound = p.flying ? state.tune.wallBounce : state.tune.ice ? state.tune.iceWallBounce : 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const hit = squareContact(state, p.x, p.y, half);
    if (!hit) return;
    p.x -= hit.nx * hit.d;
    p.y -= hit.ny * hit.d;
    const vn = p.vx * hit.nx + p.vy * hit.ny;
    if (vn < 0) {
      p.vx -= (1 + rebound) * vn * hit.nx;
      p.vy -= (1 + rebound) * vn * hit.ny;
      if (p.flying && -vn > 2 * IMPACT_MIN) {
        emit(state, { type: "slam", seat: p.seat, x: p.x - hit.nx * half, y: p.y - hit.ny * half, speed: -vn });
      }
    }
  }
}

// Whether a square of half-width `half` centred at (x, y) would overlap any
// wall or the arena's edge (the bot uses this to test where it can stand).
export function isBlocked(state, x, y, half = state.tune.playerSize / 2) {
  return squareContact(state, x, y, half) !== null;
}

// The nearest solid to (x, y): its signed distance and outward normal. The bot
// marches shots through the stadium with this.
export function sceneDistance(state, x, y) {
  let best = null;
  for (const solid of state.collide) {
    const hit = distanceTo(solid, x, y);
    if (!best || hit.d < best.d) best = hit;
  }
  return best;
}

// Contact between a circle and a rectangle: the outward normal and how deep
// the circle sits, or null if they don't touch.
function circleRectContact(c, radius, rect) {
  const cx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const cy = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  const dx = c.x - cx;
  const dy = c.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= radius * radius) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: radius - d };
  }
  // Centre is inside the rectangle: leave by the nearest face.
  const faces = [
    { nx: -1, ny: 0, depth: c.x - rect.x + radius },
    { nx: 1, ny: 0, depth: rect.x + rect.w - c.x + radius },
    { nx: 0, ny: -1, depth: c.y - rect.y + radius },
    { nx: 0, ny: 1, depth: rect.y + rect.h - c.y + radius }
  ];
  return faces.reduce((a, b) => (b.depth < a.depth ? b : a));
}

// Moves the ball out along the contact normal and reflects the part of its
// velocity (relative to whatever it hit, moving at vx, vy) that points in.
// Returns how fast it was coming in, 0 if it wasn't.
function bounce(ball, contact, vx, vy, restitution) {
  ball.x += contact.nx * contact.depth;
  ball.y += contact.ny * contact.depth;
  const vn = (ball.vx - vx) * contact.nx + (ball.vy - vy) * contact.ny;
  if (vn >= 0) return 0;
  ball.vx -= (1 + restitution) * vn * contact.nx;
  ball.vy -= (1 + restitution) * vn * contact.ny;
  return -vn;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2)) : 0;
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// 0..1 — how far the arm is out on this tick of the jab.
export function jabExtension(t) {
  const { jabOutTicks: out, jabHoldTicks: hold, jabBackTicks: back } = TUNING;
  if (t < out) return (t + 1) / out;
  if (t < out + hold) return 1;
  return Math.max(0, 1 - (t - out - hold + 1) / back);
}

const JAB_TICKS = TUNING.jabOutTicks + TUNING.jabHoldTicks + TUNING.jabBackTicks;

// The arm as a segment from the edge of the square to the fist's centre.
function jabSegment(tune, p) {
  const half = tune.playerSize / 2;
  const reach = half + tune.jabReach * jabExtension(p.jab.t);
  return {
    ax: p.x + p.jab.dx * half,
    ay: p.y + p.jab.dy * half,
    bx: p.x + p.jab.dx * reach,
    by: p.y + p.jab.dy * reach
  };
}

// --- simulation -------------------------------------------------------------

function advanceJabs(state) {
  for (const p of state.players) {
    if (p.cooldown > 0) p.cooldown -= 1;
    if (p.jab) {
      p.jab.t += 1;
      if (p.jab.t >= JAB_TICKS) p.jab = null;
    }
    if (!p.pendingJab) continue;
    if (p.alive && p.cooldown === 0) {
      p.jab = { dx: p.pendingJab.dx, dy: p.pendingJab.dy, t: 0, hit: 0, hitPlayers: 0 };
      p.cooldown = state.tune.jabCooldownTicks;
      p.pendingJab = null;
    } else if (--p.pendingJab.ttl <= 0) {
      p.pendingJab = null;
    }
  }
}

// Grip: your velocity swings quickly toward the held direction at full speed.
function gripVelocity(tune, p, ix, iy, dt) {
  const len = Math.hypot(ix, iy) || 1;
  const tx = (ix / len) * tune.playerSpeed;
  const ty = (iy / len) * tune.playerSpeed;
  const dvx = tx - p.vx;
  const dvy = ty - p.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = tune.playerAccel * dt;
  if (dv <= maxDv) {
    p.vx = tx;
    p.vy = ty;
  } else {
    p.vx += (dvx / dv) * maxDv;
    p.vy += (dvy / dv) * maxDv;
  }
}

// Ice: the held direction is a push, friction barely slows you, and turning
// round means fighting your own slide.
function iceVelocity(tune, p, ix, iy, dt) {
  const len = Math.hypot(ix, iy);
  if (len) {
    p.vx += (ix / len) * tune.iceAccel * dt;
    p.vy += (iy / len) * tune.iceAccel * dt;
  }
  const keep = Math.exp(-tune.iceFriction * dt);
  p.vx *= keep;
  p.vy *= keep;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > tune.iceMaxSpeed) {
    p.vx *= tune.iceMaxSpeed / speed;
    p.vy *= tune.iceMaxSpeed / speed;
  }
}

// The speed a player gets about at under their own power.
function topSpeed(tune) {
  return tune.ice ? tune.iceMaxSpeed : tune.playerSpeed;
}

// Coasting after a knockback: no steering, just drag, until slow enough to
// take over again.
function flightVelocity(tune, p, dt) {
  const keep = Math.exp(-tune.flightDrag * dt);
  p.vx *= keep;
  p.vy *= keep;
  if (Math.hypot(p.vx, p.vy) <= topSpeed(tune)) p.flying = false;
}

function movePlayer(state, p, dt) {
  const ix = (p.keys & KEY_RIGHT ? 1 : 0) - (p.keys & KEY_LEFT ? 1 : 0);
  const iy = (p.keys & KEY_DOWN ? 1 : 0) - (p.keys & KEY_UP ? 1 : 0);
  if (p.flying) flightVelocity(state.tune, p, dt);
  else if (state.tune.ice) iceVelocity(state.tune, p, ix, iy, dt);
  else gripVelocity(state.tune, p, ix, iy, dt);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  pushOutOfWalls(state, p);
}

// Players are solid to one another: overlapping squares split the difference.
function separatePlayers(state, alive) {
  for (let i = 0; i < alive.length; i += 1) {
    for (let j = i + 1; j < alive.length; j += 1) {
      const a = alive[i];
      const b = alive[j];
      const ox = state.tune.playerSize - Math.abs(a.x - b.x);
      const oy = state.tune.playerSize - Math.abs(a.y - b.y);
      if (ox <= 0 || oy <= 0) continue;
      if (ox < oy) {
        const s = (a.x < b.x ? -1 : 1) * (ox / 2);
        a.x += s;
        b.x -= s;
      } else {
        const s = (a.y < b.y ? -1 : 1) * (oy / 2);
        a.y += s;
        b.y -= s;
      }
      pushOutOfWalls(state, a);
      pushOutOfWalls(state, b);
    }
  }
}

function ballSpeedCap(tune) {
  return Math.max(tune.ballMaxSpeed, tune.kickSpeed * 1.35);
}

function moveBall(tune, ball, dt) {
  const cap = ballSpeedCap(tune);
  let speed = Math.hypot(ball.vx, ball.vy);
  if (speed > cap) {
    ball.vx *= cap / speed;
    ball.vy *= cap / speed;
    speed = cap;
  }
  const drag = Math.exp(-tune.ballDrag * dt);
  ball.vx *= drag;
  ball.vy *= drag;
  if (speed * drag < tune.ballStopSpeed) {
    ball.vx = 0;
    ball.vy = 0;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
}

// Returns how fast the two were closing, 0 if they weren't touching.
function collideBalls(tune, a, b) {
  const r = tune.ballRadius;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d >= 2 * r) return 0;
  const nx = d > 1e-9 ? dx / d : 1;
  const ny = d > 1e-9 ? dy / d : 0;
  const push = (2 * r - d) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn >= 0) return 0;
  const impulse = (-(1 + tune.ballBounce) * vn) / 2;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
  return -vn;
}

// How many collision passes this tick needs: enough that the fastest thing
// about — a ball, a flying player, or a kick about to happen — moves at most
// MAX_STEP per pass.
function substepsFor(state) {
  let fastest = 0;
  for (const ball of state.balls) fastest = Math.max(fastest, Math.hypot(ball.vx, ball.vy));
  for (const p of state.players) fastest = Math.max(fastest, Math.hypot(p.vx, p.vy));
  if (state.players.some((p) => p.jab)) {
    fastest = Math.max(fastest, state.tune.kickSpeed, state.tune.playerKickSpeed);
  }
  const needed = Math.ceil(fastest / TICK_HZ / MAX_STEP);
  return Math.min(MAX_SUBSTEPS, Math.max(MIN_SUBSTEPS, needed));
}

// Whether a jab's arm or fist touches a square. The fist is a disc; the arm
// is a thinner capsule, tested as discs a radius apart along it.
function jabTouchesSquare(tune, seg, rect) {
  if (circleRectContact({ x: seg.bx, y: seg.by }, tune.fistRadius, rect)) return true;
  const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
  const steps = Math.max(1, Math.ceil(len / tune.armRadius));
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const point = { x: seg.ax + (seg.bx - seg.ax) * t, y: seg.ay + (seg.by - seg.ay) * t };
    if (circleRectContact(point, tune.armRadius, rect)) return true;
  }
  return false;
}

// A jab landing on an opponent sends them flying along it, once per jab.
function knockPlayers(state, alive) {
  const { tune } = state;
  if (!tune.playerKickSpeed) return;
  for (const p of alive) {
    if (!p.jab || jabExtension(p.jab.t) <= 0) continue;
    const seg = jabSegment(tune, p);
    for (const q of alive) {
      const bit = 1 << q.seat;
      if (q.team === p.team || p.jab.hitPlayers & bit) continue;
      if (!jabTouchesSquare(tune, seg, playerRect(q, tune.playerSize))) continue;
      p.jab.hitPlayers |= bit;
      q.vx = p.jab.dx * tune.playerKickSpeed;
      q.vy = p.jab.dy * tune.playerKickSpeed;
      q.flying = true;
      emit(state, {
        type: "knock",
        seat: q.seat,
        by: p.seat,
        x: q.x,
        y: q.y,
        dx: p.jab.dx,
        dy: p.jab.dy,
        speed: tune.playerKickSpeed
      });
    }
  }
}

function substep(state, lethal, dt) {
  const { tune } = state;
  const alive = state.players.filter((p) => p.alive);
  alive.forEach((p) => movePlayer(state, p, dt));
  separatePlayers(state, alive);
  knockPlayers(state, alive);

  const deaths = new Set();
  const r = tune.ballRadius;
  const size = tune.playerSize;
  state.balls.forEach((ball, index) => {
    moveBall(tune, ball, dt);
    for (const p of alive) {
      const contact = circleRectContact(ball, r, playerRect(p, size));
      if (!contact) continue;
      if (lethal && ball.team !== p.team) deaths.add(p);
      const speed = bounce(ball, contact, p.vx, p.vy, tune.bodyBounce);
      if (speed > IMPACT_MIN) {
        const at = { x: ball.x - contact.nx * r, y: ball.y - contact.ny * r };
        emit(state, { type: "body", ball: index, team: ball.team, seat: p.seat, ...at, speed });
      }
    }
    // Jabs: your own balls get kicked (each once per jab), an enemy's kills you.
    for (const p of alive) {
      if (!p.jab || jabExtension(p.jab.t) <= 0) continue;
      const seg = jabSegment(tune, p);
      const touches =
        Math.hypot(ball.x - seg.bx, ball.y - seg.by) < r + tune.fistRadius ||
        distToSegment(ball.x, ball.y, seg.ax, seg.ay, seg.bx, seg.by) < r + tune.armRadius;
      if (!touches) continue;
      if (ball.team !== p.team) {
        if (lethal) deaths.add(p);
      } else if (!(p.jab.hit & (1 << index))) {
        p.jab.hit |= 1 << index;
        ball.vx = p.jab.dx * tune.kickSpeed;
        ball.vy = p.jab.dy * tune.kickSpeed;
        emit(state, {
          type: "kick",
          ball: index,
          team: ball.team,
          seat: p.seat,
          x: ball.x,
          y: ball.y,
          dx: p.jab.dx,
          dy: p.jab.dy,
          speed: tune.kickSpeed
        });
      }
    }
  });

  for (let i = 0; i < state.balls.length; i += 1) {
    for (let j = i + 1; j < state.balls.length; j += 1) {
      const a = state.balls[i];
      const b = state.balls[j];
      const speed = collideBalls(tune, a, b);
      if (speed > IMPACT_MIN) {
        emit(state, { type: "clack", a: i, b: j, teams: [a.team, b.team], x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, speed });
      }
    }
  }

  state.balls.forEach((ball, index) => {
    // A few passes, so a ball pushed out of one surface into another (a
    // corner) settles against both.
    for (let pass = 0, touched = true; pass < 3 && touched; pass += 1) {
      touched = false;
      for (const solid of state.collide) {
        const hit = distanceTo(solid, ball.x, ball.y);
        if (hit.d >= r) continue;
        const speed = bounce(ball, { nx: hit.nx, ny: hit.ny, depth: r - hit.d }, 0, 0, tune.wallBounce);
        touched = true;
        if (speed > IMPACT_MIN) {
          const at = { x: ball.x - hit.nx * r, y: ball.y - hit.ny * r };
          emit(state, { type: "wall", ball: index, team: ball.team, ...at, nx: hit.nx, ny: hit.ny, speed });
        }
      }
    }
    // A ball the walls just shoved back into a player was pinched between
    // them; the player gives way instead.
    for (const p of alive) {
      const contact = circleRectContact(ball, r, playerRect(p, size));
      if (!contact) continue;
      if (lethal && ball.team !== p.team) deaths.add(p);
      p.x -= contact.nx * contact.depth;
      p.y -= contact.ny * contact.depth;
      pushOutOfWalls(state, p);
    }
  });

  deaths.forEach((p) => {
    p.alive = false;
    p.jab = null;
    p.pendingJab = null;
  });
}

function aliveTeams(state) {
  return [0, 1].filter((team) => state.players.some((p) => p.team === team && p.alive));
}

// One fixed tick. Returns true when something the clients hold as STATE (not
// just positions) changed — the phase, the score, a new round.
//
// With `predict` set (a browser running ahead of the server) it's physics
// only: nothing dies and no round ends, because only the server knows what the
// other player really pressed — a death or a point waits for the server to say
// so. The countdown still runs out, so a predicted round starts on time.
export function step(state, predict = false) {
  state.tick += 1;

  if (state.phase === "countdown") {
    state.phaseTicks -= 1;
    if (state.phaseTicks > 0) return false;
    state.phase = "play";
    return true;
  }

  // Once a round is decided everyone still standing can roam, but nothing
  // more can die.
  const lethal = state.phase === "play" && !predict;
  advanceJabs(state);
  const passes = substepsFor(state);
  for (let i = 0; i < passes; i += 1) substep(state, lethal, 1 / TICK_HZ / passes);
  if (predict) return false;

  if (state.phase === "play") {
    const standing = aliveTeams(state);
    if (standing.length === 2) return false;
    const winner = standing.length === 1 ? standing[0] : null;
    if (winner !== null) state.score[winner] += 1;
    state.lastRound = { winner };
    state.phase = "over";
    state.phaseTicks = state.tune.overTicks;
    return true;
  }

  if (state.phase === "over") {
    state.phaseTicks -= 1;
    if (state.phaseTicks > 0) return false;
    if (state.score.some((s) => s >= state.tune.winScore)) {
      state.phase = "matchover";
      state.rematch.clear();
    } else {
      startRound(state);
    }
    return true;
  }

  return false; // matchover: the field idles until a rematch
}

// --- what clients see -------------------------------------------------------

const round2 = (v) => Math.round(v * 100) / 100;

// The fast-changing part, sent many times a second: everything a browser needs
// to pick the match up from this tick and run it forward itself. A player is
// [x, y, vx, vy, alive, keys, cooldown, jab, pendingJab, flying], where jab is
// [dx, dy, t, hitBalls, hitPlayers] or 0 and pendingJab is [dx, dy, ttl] or 0; a ball is
// [team, x, y, vx, vy].
export function snapshot(state) {
  return {
    t: state.tick,
    r: state.round,
    ph: state.phase,
    pt: state.phaseTicks,
    pl: state.players.map((p) => [
      round2(p.x),
      round2(p.y),
      round2(p.vx),
      round2(p.vy),
      p.alive ? 1 : 0,
      p.keys,
      p.cooldown,
      p.jab ? [round2(p.jab.dx), round2(p.jab.dy), p.jab.t, p.jab.hit, p.jab.hitPlayers] : 0,
      p.pendingJab ? [round2(p.pendingJab.dx), round2(p.pendingJab.dy), p.pendingJab.ttl] : 0,
      p.flying ? 1 : 0
    ]),
    b: state.balls.map((ball) => [ball.team, round2(ball.x), round2(ball.y), round2(ball.vx), round2(ball.vy)])
  };
}

// The inverse of snapshot(): a world predict mode can step, given the numbers
// in force (`tune`, from publicState), the round's obstacles and which team
// each seat is on.
export function worldFromSnapshot(snap, tune, solids, teams) {
  return {
    tune,
    collide: collidersFor(solids),
    tick: snap.t,
    round: snap.r,
    phase: snap.ph,
    phaseTicks: snap.pt,
    players: snap.pl.map(([x, y, vx, vy, alive, keys, cooldown, jab, pending, flying], seat) => ({
      seat,
      team: teams[seat],
      x,
      y,
      vx,
      vy,
      alive: !!alive,
      keys,
      cooldown,
      jab: jab ? { dx: jab[0], dy: jab[1], t: jab[2], hit: jab[3], hitPlayers: jab[4] } : null,
      pendingJab: pending ? { dx: pending[0], dy: pending[1], ttl: pending[2] } : null,
      flying: !!flying
    })),
    balls: snap.b.map(([team, x, y, vx, vy]) => ({ team, x, y, vx, vy }))
  };
}

// Everything else, sent only when it changes.
export function publicState(state) {
  return {
    config: {
      arenaW: TUNING.arenaW,
      arenaH: TUNING.arenaH,
      tickMs: TICK_MS
    },
    tune: state.tune, // the numbers in force — what the browser predicts and draws with
    settings: state.settings, // what the sliders say (round-start ones may not be in force yet)
    round: state.round,
    phase: state.phase,
    score: state.score,
    rims: RIMS,
    solids: state.solids,
    teams: state.players.map((p) => p.team),
    lastRound: state.lastRound,
    rematch: [...state.rematch]
  };
}
