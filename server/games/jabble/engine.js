// Jabble: real-time top-down stadium game. Two teams, one ball each. Your own
// ball bounces off you like off anything else, and a jab (an arm thrown out in
// one of eight directions) launches it hard that way. The OTHER team's ball
// kills whatever of yours it touches — your square, or your arm mid-jab. Last
// team standing takes the round; first to TUNING.winScore rounds wins.
//
// Nothing in the stadium is flat. Its four sides bow gently outward and every
// obstacle is a round pillar or a curved bar, so a ball that hits a wall
// square-on still comes back a little off its line — by how much depends on
// where it struck, never on chance. Each solid is just a distance function:
// a ball pushes off it directly, and a player's square tests it at points
// round its rim.
//
// Two games run on this engine — Jabble and Jabble Ice — and VARIANTS holds
// what's different about each; a match carries its merged numbers as `tune`.
// The server runs this at a fixed TICK_HZ; clients only ever draw snapshots of
// it. Every number worth tuning lives in TUNING or VARIANTS.

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
// Collision runs this many times per tick, so a kicked ball (≈ 9 units per
// substep at kick speed) can never skip through a 22-unit bar.
const SUBSTEPS = 2;
const DT = 1 / TICK_HZ / SUBSTEPS;

export const TUNING = {
  arenaW: 1200,
  arenaH: 720,
  edgeBow: 36, // how far each side of the stadium bows outward at its middle

  playerSize: 34,
  playerSpeed: 280, // units/s at full tilt
  playerAccel: 2600, // units/s² toward the held direction (and back to a stop)
  // On ice (a variant's `ice: true`) there's no grip: keys PUSH you at iceAccel
  // rather than set your speed, you coast, losing only iceFriction of your
  // speed a second, and you come off walls with a little iceWallBounce.
  iceAccel: 800,
  iceFriction: 0.5,
  iceMaxSpeed: 380,
  iceWallBounce: 0.35,

  ballRadius: 16,
  ballDrag: 0.55, // speed bled per second, as e^-drag (0.55 ≈ 42% a second)
  ballStopSpeed: 6, // below this a ball comes to rest
  ballMaxSpeed: 1400,
  wallBounce: 0.85, // restitution off walls
  bodyBounce: 0.3, // off a player's body — soft, so you can trap your ball
  ballBounce: 0.9, // ball against ball

  kickSpeed: 1050, // a jab sets your ball to exactly this, in the jab direction
  jabReach: 34, // how far the fist travels past the edge of your square
  fistRadius: 12,
  armRadius: 5, // the arm behind the fist is a hitbox too, just a thinner one
  jabOutTicks: 3, // arm extending
  jabHoldTicks: 4, // fully out
  jabBackTicks: 3, // retracting — still a hitbox while it's out at all
  jabCooldownTicks: 21, // 0.35 s from one jab's start to the next
  jabBufferTicks: 8, // a jab pressed this close to being ready fires when it is

  countdownTicks: 90, // frozen "ready" before each round
  overTicks: 120, // pause after a round is decided
  winScore: 3
};

// What each game changes from TUNING. Keyed by the lobby's game id.
export const VARIANTS = {
  jabble: { obstacles: true, ice: false },
  "jabble-ice": { obstacles: false, ice: true, ballRadius: 32 }
};

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

// Signed distance from (x, y) to a solid (negative inside it), with the unit
// normal pointing out of the solid toward open floor. The three kinds:
//   rim    - the outside of one of the stadium's four circles
//   pillar - a disc
//   arc    - a curved bar: a band of half-width w along part of a circle
//            (centre x, y, radius r, centred on angle `mid`, ± `half`),
//            with rounded ends
function distanceTo(solid, x, y) {
  if (solid.kind === "rim") {
    const dx = solid.x - x;
    const dy = solid.y - y;
    const len = Math.hypot(dx, dy);
    return { d: solid.r - len, nx: dx / len, ny: dy / len };
  }
  const dx = x - solid.x;
  const dy = y - solid.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  if (solid.kind === "pillar") return { d: len - solid.r, nx: dx / len, ny: dy / len };

  let off = Math.atan2(dy, dx) - solid.mid;
  off -= Math.round(off / (2 * Math.PI)) * 2 * Math.PI;
  if (Math.abs(off) <= solid.half) {
    const sign = len >= solid.r ? 1 : -1;
    return { d: Math.abs(len - solid.r) - solid.w, nx: (sign * dx) / len, ny: (sign * dy) / len };
  }
  const end = solid.mid + Math.sign(off) * solid.half;
  const ex = x - (solid.x + Math.cos(end) * solid.r);
  const ey = y - (solid.y + Math.sin(end) * solid.r);
  const elen = Math.hypot(ex, ey) || 1e-9;
  return { d: elen - solid.w, nx: ex / elen, ny: ey / elen };
}

const EDGE_GAP = 56; // obstacles keep off the edge: a lane runs all the way round
const OBSTACLE_GAP = 64; // and off each other, so every pocket is reachable

// Each team starts at its own end, at a height of its own.
function spawnLayout(teamSizes) {
  const { arenaW: W, arenaH: H } = TUNING;
  const spots = [];
  teamSizes.forEach((count, team) => {
    const y0 = H / 2 + Math.round((Math.random() - 0.5) * 300);
    const fromX = team === 0 ? 0 : W;
    const inward = team === 0 ? 1 : -1;
    for (let k = 0; k < count; k += 1) {
      const spread = (k - (count - 1) / 2) * 90;
      spots.push({
        team,
        player: { x: fromX + inward * 110, y: y0 + spread },
        ball: { x: fromX + inward * 250, y: y0 }
      });
    }
  });
  return spots;
}

function randomObstacle() {
  const { arenaW: W, arenaH: H } = TUNING;
  const x = EDGE_GAP + Math.random() * (W - 2 * EDGE_GAP);
  const y = EDGE_GAP + Math.random() * (H - 2 * EDGE_GAP);
  const roll = Math.random();
  if (roll < 0.3) return { kind: "pillar", x, y, r: 20 + Math.random() * 20 };
  // A curved bar: a chord of `length` bowed out by `sag`, at any angle, with
  // (x, y) the middle of the chord. Short fat ones are beans, long thin ones
  // walls.
  const bean = roll < 0.5;
  const length = bean ? 60 + Math.random() * 40 : 120 + Math.random() * 150;
  const sag = bean ? 14 + Math.random() * 12 : 14 + Math.random() * 26;
  const r = (length * length) / 4 / (2 * sag) + sag / 2;
  const mid = Math.random() * Math.PI * 2; // from the circle's centre toward the bar's apex
  return {
    kind: "arc",
    x: x - Math.cos(mid) * (r - sag),
    y: y - Math.sin(mid) * (r - sag),
    r,
    mid,
    half: Math.asin(length / 2 / r),
    w: bean ? 17 + Math.random() * 6 : 11
  };
}

// An obstacle as a row of discs down its middle, close enough together to
// measure clearances against.
function spine(solid) {
  if (solid.kind === "pillar") return [{ x: solid.x, y: solid.y, r: solid.r }];
  const steps = Math.max(2, Math.ceil((2 * solid.half * solid.r) / 8));
  const discs = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = solid.mid - solid.half + (2 * solid.half * i) / steps;
    discs.push({ x: solid.x + Math.cos(a) * solid.r, y: solid.y + Math.sin(a) * solid.r, r: solid.w });
  }
  return discs;
}

// Pillars and curved bars scattered anywhere, spaced so that nothing seals
// off a pocket, with the spawns left clear.
function generateObstacles(spawns) {
  const clear = spawns.flatMap((s) => [
    { point: s.player, radius: 95 },
    { point: s.ball, radius: 75 }
  ]);
  const placed = [];
  const target = 7 + Math.floor(Math.random() * 5);
  for (let attempt = 0; attempt < 800 && placed.length < target; attempt += 1) {
    const solid = randomObstacle();
    const roomy = spine(solid).every(
      (disc) =>
        RIMS.every((rim) => distanceTo(rim, disc.x, disc.y).d - disc.r >= EDGE_GAP) &&
        placed.every((other) => distanceTo(other, disc.x, disc.y).d - disc.r >= OBSTACLE_GAP)
    );
    if (!roomy) continue;
    if (clear.some((c) => distanceTo(solid, c.point.x, c.point.y).d < c.radius)) continue;
    placed.push(solid);
  }
  return placed;
}

// --- match lifecycle --------------------------------------------------------

// One seat per player; seats alternate teams (0 blue, 1 red, 2 blue, ...).
export function createMatch(seatCount = 2, variant = "jabble") {
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
      jab: null, // { dx, dy, t, hit }
      cooldown: 0,
      pendingJab: null // { dx, dy, ttl }
    });
  }
  const state = {
    tune: { ...TUNING, ...VARIANTS[variant] },
    tick: 0,
    round: 0,
    phase: "countdown", // countdown | play | over | matchover
    phaseTicks: 0,
    score: [0, 0],
    solids: [], // this round's obstacles
    collide: RIMS, // the rims plus the obstacles: everything solid
    players,
    balls: [0, 1].map((team) => ({ team, x: 0, y: 0, vx: 0, vy: 0 })),
    lastRound: null, // { winner: team | null }
    rematch: new Set()
  };
  startRound(state);
  return state;
}

export function resetMatch(state) {
  state.score = [0, 0];
  state.round = 0;
  state.lastRound = null;
  state.rematch.clear();
  startRound(state);
}

function startRound(state) {
  const teamSizes = [0, 0];
  state.players.forEach((p) => (teamSizes[p.team] += 1));
  const spawns = spawnLayout(teamSizes);
  state.solids = state.tune.obstacles ? generateObstacles(spawns) : [];
  state.collide = RIMS.concat(state.solids);

  const next = [0, 0];
  state.players.forEach((p) => {
    const spot = spawns.filter((s) => s.team === p.team)[next[p.team]++];
    Object.assign(p, { x: spot.player.x, y: spot.player.y, vx: 0, vy: 0 });
    p.alive = true;
    p.jab = null;
    p.cooldown = 0;
    p.pendingJab = null;
    // keys survive the reset: whatever you're holding moves you on "go"
  });
  state.balls.forEach((ball) => {
    const spot = spawns.find((s) => s.team === ball.team);
    Object.assign(ball, { x: spot.ball.x, y: spot.ball.y, vx: 0, vy: 0 });
  });

  state.round += 1;
  state.phase = "countdown";
  state.phaseTicks = TUNING.countdownTicks;
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
  p.pendingJab = { dx: dx / len, dy: dy / len, ttl: TUNING.jabBufferTicks };
}

// --- geometry ---------------------------------------------------------------

function playerRect(p) {
  const half = TUNING.playerSize / 2;
  return { x: p.x - half, y: p.y - half, w: TUNING.playerSize, h: TUNING.playerSize };
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
  const half = TUNING.playerSize / 2;
  const rebound = state.tune.ice ? state.tune.iceWallBounce : 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const hit = squareContact(state, p.x, p.y, half);
    if (!hit) return;
    p.x -= hit.nx * hit.d;
    p.y -= hit.ny * hit.d;
    const vn = p.vx * hit.nx + p.vy * hit.ny;
    if (vn < 0) {
      p.vx -= (1 + rebound) * vn * hit.nx;
      p.vy -= (1 + rebound) * vn * hit.ny;
    }
  }
}

// Whether a square of half-width `half` centred at (x, y) would overlap any
// wall or the arena's edge (the bot uses this to test where it can stand).
export function isBlocked(state, x, y, half = TUNING.playerSize / 2) {
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
function bounce(ball, contact, vx, vy, restitution) {
  ball.x += contact.nx * contact.depth;
  ball.y += contact.ny * contact.depth;
  const vn = (ball.vx - vx) * contact.nx + (ball.vy - vy) * contact.ny;
  if (vn < 0) {
    ball.vx -= (1 + restitution) * vn * contact.nx;
    ball.vy -= (1 + restitution) * vn * contact.ny;
  }
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
function jabSegment(p) {
  const half = TUNING.playerSize / 2;
  const reach = half + TUNING.jabReach * jabExtension(p.jab.t);
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
      p.jab = { dx: p.pendingJab.dx, dy: p.pendingJab.dy, t: 0, hit: false };
      p.cooldown = TUNING.jabCooldownTicks;
      p.pendingJab = null;
    } else if (--p.pendingJab.ttl <= 0) {
      p.pendingJab = null;
    }
  }
}

// Grip: your velocity swings quickly toward the held direction at full speed.
function gripVelocity(tune, p, ix, iy) {
  const len = Math.hypot(ix, iy) || 1;
  const tx = (ix / len) * tune.playerSpeed;
  const ty = (iy / len) * tune.playerSpeed;
  const dvx = tx - p.vx;
  const dvy = ty - p.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = tune.playerAccel * DT;
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
function iceVelocity(tune, p, ix, iy) {
  const len = Math.hypot(ix, iy);
  if (len) {
    p.vx += (ix / len) * tune.iceAccel * DT;
    p.vy += (iy / len) * tune.iceAccel * DT;
  }
  const keep = Math.exp(-tune.iceFriction * DT);
  p.vx *= keep;
  p.vy *= keep;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > tune.iceMaxSpeed) {
    p.vx *= tune.iceMaxSpeed / speed;
    p.vy *= tune.iceMaxSpeed / speed;
  }
}

function movePlayer(state, p) {
  const ix = (p.keys & KEY_RIGHT ? 1 : 0) - (p.keys & KEY_LEFT ? 1 : 0);
  const iy = (p.keys & KEY_DOWN ? 1 : 0) - (p.keys & KEY_UP ? 1 : 0);
  if (state.tune.ice) iceVelocity(state.tune, p, ix, iy);
  else gripVelocity(state.tune, p, ix, iy);
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  pushOutOfWalls(state, p);
}

// Players are solid to one another: overlapping squares split the difference.
function separatePlayers(state, alive) {
  for (let i = 0; i < alive.length; i += 1) {
    for (let j = i + 1; j < alive.length; j += 1) {
      const a = alive[i];
      const b = alive[j];
      const ox = TUNING.playerSize - Math.abs(a.x - b.x);
      const oy = TUNING.playerSize - Math.abs(a.y - b.y);
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

function moveBall(ball) {
  let speed = Math.hypot(ball.vx, ball.vy);
  if (speed > TUNING.ballMaxSpeed) {
    ball.vx *= TUNING.ballMaxSpeed / speed;
    ball.vy *= TUNING.ballMaxSpeed / speed;
    speed = TUNING.ballMaxSpeed;
  }
  const drag = Math.exp(-TUNING.ballDrag * DT);
  ball.vx *= drag;
  ball.vy *= drag;
  if (speed * drag < TUNING.ballStopSpeed) {
    ball.vx = 0;
    ball.vy = 0;
  }
  ball.x += ball.vx * DT;
  ball.y += ball.vy * DT;
}

function collideBalls(a, b, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d >= 2 * r) return;
  const nx = d > 1e-9 ? dx / d : 1;
  const ny = d > 1e-9 ? dy / d : 0;
  const push = (2 * r - d) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn >= 0) return;
  const impulse = (-(1 + TUNING.ballBounce) * vn) / 2;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
}

function substep(state, lethal) {
  const alive = state.players.filter((p) => p.alive);
  alive.forEach((p) => movePlayer(state, p));
  separatePlayers(state, alive);

  const deaths = new Set();
  const r = state.tune.ballRadius;
  for (const ball of state.balls) {
    moveBall(ball);
    for (const p of alive) {
      const contact = circleRectContact(ball, r, playerRect(p));
      if (!contact) continue;
      if (lethal && ball.team !== p.team) deaths.add(p);
      bounce(ball, contact, p.vx, p.vy, TUNING.bodyBounce);
    }
    // Jabs: your own ball gets kicked (once per jab), the enemy's kills you.
    for (const p of alive) {
      if (!p.jab || jabExtension(p.jab.t) <= 0) continue;
      const seg = jabSegment(p);
      const touches =
        Math.hypot(ball.x - seg.bx, ball.y - seg.by) < r + TUNING.fistRadius ||
        distToSegment(ball.x, ball.y, seg.ax, seg.ay, seg.bx, seg.by) < r + TUNING.armRadius;
      if (!touches) continue;
      if (ball.team !== p.team) {
        if (lethal) deaths.add(p);
      } else if (!p.jab.hit) {
        p.jab.hit = true;
        ball.vx = p.jab.dx * TUNING.kickSpeed;
        ball.vy = p.jab.dy * TUNING.kickSpeed;
      }
    }
  }

  for (let i = 0; i < state.balls.length; i += 1) {
    for (let j = i + 1; j < state.balls.length; j += 1) {
      collideBalls(state.balls[i], state.balls[j], r);
    }
  }

  for (const ball of state.balls) {
    for (const solid of state.collide) {
      const hit = distanceTo(solid, ball.x, ball.y);
      if (hit.d < r) {
        bounce(ball, { nx: hit.nx, ny: hit.ny, depth: r - hit.d }, 0, 0, TUNING.wallBounce);
      }
    }
    // A ball the walls just shoved back into a player was pinched between
    // them; the player gives way instead.
    for (const p of alive) {
      const contact = circleRectContact(ball, r, playerRect(p));
      if (!contact) continue;
      if (lethal && ball.team !== p.team) deaths.add(p);
      p.x -= contact.nx * contact.depth;
      p.y -= contact.ny * contact.depth;
      pushOutOfWalls(state, p);
    }
  }

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
// just positions) changed — the phase, the score, a new arena.
export function step(state) {
  state.tick += 1;

  if (state.phase === "countdown") {
    state.phaseTicks -= 1;
    if (state.phaseTicks > 0) return false;
    state.phase = "play";
    return true;
  }

  // Once a round is decided everyone still standing can roam, but nothing
  // more can die.
  const lethal = state.phase === "play";
  advanceJabs(state);
  for (let i = 0; i < SUBSTEPS; i += 1) substep(state, lethal);

  if (state.phase === "play") {
    const standing = aliveTeams(state);
    if (standing.length === 2) return false;
    const winner = standing.length === 1 ? standing[0] : null;
    if (winner !== null) state.score[winner] += 1;
    state.lastRound = { winner };
    state.phase = "over";
    state.phaseTicks = TUNING.overTicks;
    return true;
  }

  if (state.phase === "over") {
    state.phaseTicks -= 1;
    if (state.phaseTicks > 0) return false;
    if (state.score.some((s) => s >= TUNING.winScore)) {
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

const round1 = (v) => Math.round(v * 10) / 10;

// The fast-changing part, sent many times a second. Positions to one decimal;
// a player is [x, y, alive, jabDx×100, jabDy×100, jabExtension×100].
export function snapshot(state) {
  return {
    t: state.tick,
    r: state.round,
    pl: state.players.map((p) => {
      const jab = p.jab ? jabExtension(p.jab.t) : 0;
      return [
        round1(p.x),
        round1(p.y),
        p.alive ? 1 : 0,
        jab ? Math.round(p.jab.dx * 100) : 0,
        jab ? Math.round(p.jab.dy * 100) : 0,
        Math.round(jab * 100)
      ];
    }),
    b: state.balls.map((ball) => [ball.team, round1(ball.x), round1(ball.y)])
  };
}

// Everything else, sent only when it changes.
export function publicState(state) {
  return {
    config: {
      arenaW: TUNING.arenaW,
      arenaH: TUNING.arenaH,
      playerSize: TUNING.playerSize,
      ballRadius: state.tune.ballRadius,
      surface: state.tune.ice ? "ice" : "turf",
      jabReach: TUNING.jabReach,
      fistRadius: TUNING.fistRadius,
      armRadius: TUNING.armRadius,
      tickMs: TICK_MS,
      winScore: TUNING.winScore
    },
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
