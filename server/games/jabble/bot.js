// Jabble bot (both games): a single-strength opponent that plays through the same two
// calls a human's socket does (setKeys, requestJab). Every few ticks it reads
// the field again: if the enemy ball is coming at it, it steps sideways out of
// the line; otherwise it picks whichever of the eight jab directions sends its
// ball closest to you (allowing one bank off a wall), walks round behind the
// ball, jabs, and steps aside so the ball can't come straight back into it.
// On ice it can't stop dead, so it steers by velocity instead (see steer).
import { TUNING, setKeys, requestJab, isBlocked, sceneDistance } from "./engine.js";

export const JABBLE_BOT_ID = "jabble-bot";

const THINK_TICKS = [5, 6, 7]; // ticks between decisions (its reaction time), picked at random
const LOOKAHEAD_S = 0.5; // how far ahead it sees an incoming ball
const SHOT_LENGTH = 1300; // how far it traces a kicked ball
const KEEP_AIM = 25; // stick with the last direction unless another is this much better
const HALF = TUNING.playerSize / 2;
const D = Math.SQRT1_2;

// The eight jab directions as arrow-key masks (1 up, 2 down, 4 left, 8 right)
// and the unit vectors they mean.
const DIRS = [
  { mask: 8, x: 1, y: 0 },
  { mask: 10, x: D, y: D },
  { mask: 2, x: 0, y: 1 },
  { mask: 6, x: -D, y: D },
  { mask: 4, x: -1, y: 0 },
  { mask: 5, x: -D, y: -D },
  { mask: 1, x: 0, y: -1 },
  { mask: 9, x: D, y: -D }
];

export function createBotBrain() {
  return { nextThink: 0, lastX: null, lastY: null, stuck: 0, sidestep: null, aim: null };
}

// Movement keys for heading along (dx, dy), snapped to the nearest of the
// eight directions; nothing at all once it's inside the dead zone.
function keysToward(dx, dy, deadZone = 4) {
  const len = Math.hypot(dx, dy);
  if (len < deadZone) return 0;
  const lean = len * 0.38; // sin 22.5°: the edge between one octant and the next
  let mask = 0;
  if (dx > lean) mask |= 8;
  else if (dx < -lean) mask |= 4;
  if (dy > lean) mask |= 2;
  else if (dy < -lean) mask |= 1;
  return mask;
}

// Keys that take it to (gx, gy). With grip it just heads there. On ice it asks
// for the speed it could still brake from in the distance left (braking at
// half its push, to allow for its reaction time) and pushes toward the
// difference between that and how it's sliding now.
function steer(state, me, gx, gy) {
  const dx = gx - me.x;
  const dy = gy - me.y;
  const { tune } = state;
  if (!tune.ice) return keysToward(dx, dy);
  const dist = Math.hypot(dx, dy);
  const want = dist < 4 ? 0 : Math.min(tune.iceMaxSpeed, Math.sqrt(tune.iceAccel * dist));
  const wx = dist ? (dx / dist) * want : 0;
  const wy = dist ? (dy / dist) * want : 0;
  return keysToward(wx - me.vx, wy - me.vy, 25);
}

// Where to stand to jab a ball of radius r along `dir`: close enough that the
// arm reaches it, far enough that the square isn't already bumping it.
function standoff(dir, r) {
  const diagonal = dir.x !== 0 && dir.y !== 0;
  return (diagonal ? HALF * Math.SQRT2 : HALF) + r + 3;
}

// A direction to step to get out of the enemy ball's way, or null if it isn't
// a threat in the next LOOKAHEAD_S. Straight-line only — it doesn't foresee
// bounces.
function dodgeFrom(state, me, ball) {
  const rx = me.x - ball.x;
  const ry = me.y - ball.y;
  const danger = HALF * Math.SQRT2 + state.tune.ballRadius;
  const speed2 = ball.vx * ball.vx + ball.vy * ball.vy;
  if (speed2 < 40 * 40) {
    const d = Math.hypot(rx, ry);
    if (d >= danger + 30) return null;
    return d > 1e-6 ? { x: rx / d, y: ry / d } : DIRS[Math.floor(Math.random() * 8)];
  }
  const t = (rx * ball.vx + ry * ball.vy) / speed2;
  if (t < 0 || t > LOOKAHEAD_S) return null;
  // Where we'd be relative to the ball at its closest pass.
  const cx = rx - ball.vx * t;
  const cy = ry - ball.vy * t;
  if (Math.hypot(cx, cy) > danger + 16) return null;
  const speed = Math.sqrt(speed2);
  let px = -ball.vy / speed;
  let py = ball.vx / speed;
  if (px * cx + py * cy < 0) {
    px = -px;
    py = -py;
  }
  if (isBlocked(state, me.x + px * 40, me.y + py * 40)) {
    px = -px;
    py = -py;
  }
  return { x: px, y: py };
}

// How close a ball kicked from (x, y) along `dir` would pass the target,
// following it off one wall. The ball is marched forward by its clearance
// from the nearest solid until it touches something, then reflected off that
// surface's normal — so curved walls bend the trace the way they bend a shot.
function shotMiss(state, x, y, dir, target) {
  const r = state.tune.ballRadius;
  let dx = dir.x;
  let dy = dir.y;
  let travelled = 0;
  let miss = Infinity;
  let bounced = false;
  let legX = x;
  let legY = y;
  const passBy = (ex, ey) => {
    const len = Math.hypot(ex - legX, ey - legY);
    const along = Math.max(0, Math.min(len, (target.x - legX) * dx + (target.y - legY) * dy));
    miss = Math.min(miss, Math.hypot(target.x - (legX + dx * along), target.y - (legY + dy * along)));
  };
  for (let i = 0; i < 80 && travelled < SHOT_LENGTH; i += 1) {
    const hit = sceneDistance(state, x, y);
    const clearance = hit.d - r;
    if (clearance < 1 && hit.nx * dx + hit.ny * dy < 0) {
      passBy(x, y);
      if (bounced) return miss;
      bounced = true;
      const dot = dx * hit.nx + dy * hit.ny;
      dx -= 2 * dot * hit.nx;
      dy -= 2 * dot * hit.ny;
      legX = x;
      legY = y;
      continue;
    }
    const stride = Math.max(clearance, 2);
    x += dx * stride;
    y += dy * stride;
    travelled += stride;
  }
  passBy(x, y);
  return miss;
}

// Of the directions it can actually get behind the ball for, the one whose
// shot passes nearest the target — sticking with its last choice if that's
// still about as good, so it doesn't dither between two.
function chooseAim(state, brain, ball, target) {
  let best = null;
  let kept = null;
  for (const dir of DIRS) {
    const gap = standoff(dir, state.tune.ballRadius);
    if (isBlocked(state, ball.x - dir.x * gap, ball.y - dir.y * gap)) continue;
    const miss = shotMiss(state, ball.x, ball.y, dir, target);
    if (!best || miss < best.miss) best = { dir, miss };
    if (dir === brain.aim) kept = { dir, miss };
  }
  if (kept && best && kept.miss <= best.miss + KEEP_AIM) best = kept;
  return best?.dir ?? null;
}

// Whether the arm, thrown along `dir`, would come anywhere near the enemy ball.
function safeToJab(me, dir, foeBall, r) {
  if (!foeBall) return true;
  const reach = HALF + TUNING.jabReach;
  const ax = me.x;
  const ay = me.y;
  const bx = me.x + dir.x * reach;
  const by = me.y + dir.y * reach;
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((foeBall.x - ax) * abx + (foeBall.y - ay) * aby) / (reach * reach)));
  const d = Math.hypot(foeBall.x - (ax + abx * t), foeBall.y - (ay + aby * t));
  return d > TUNING.fistRadius + r + 30;
}

export function botThink(state, seat, brain) {
  if (state.phase === "countdown" || state.tick < brain.nextThink) return;
  const thinkEvery = THINK_TICKS[Math.floor(Math.random() * THINK_TICKS.length)];
  brain.nextThink = state.tick + thinkEvery;
  const me = state.players[seat];
  if (!me?.alive) {
    setKeys(state, seat, 0);
    return;
  }

  const moved =
    brain.lastX === null ? Infinity : Math.hypot(me.x - brain.lastX, me.y - brain.lastY);
  brain.lastX = me.x;
  brain.lastY = me.y;

  const ball = state.balls.find((b) => b.team === me.team);
  const foeBall = state.balls.find((b) => b.team !== me.team);
  const dodge = foeBall && state.phase === "play" ? dodgeFrom(state, me, foeBall) : null;
  if (dodge) {
    brain.sidestep = null;
    setKeys(state, seat, keysToward(dodge.x * 100, dodge.y * 100)); // a unit vector is inside the dead zone
    return;
  }

  // Stepping aside after a kick, or unwedging itself from a corner.
  if (brain.sidestep) {
    brain.sidestep.ticks -= thinkEvery;
    if (brain.sidestep.ticks > 0) {
      setKeys(state, seat, brain.sidestep.mask);
      return;
    }
    brain.sidestep = null;
  }
  brain.stuck = me.keys && moved < 3 ? brain.stuck + 1 : 0;
  if (brain.stuck >= 2) {
    brain.stuck = 0;
    brain.sidestep = { mask: DIRS[Math.floor(Math.random() * 8)].mask, ticks: 24 };
    setKeys(state, seat, brain.sidestep.mask);
    return;
  }

  let foe = null;
  for (const p of state.players) {
    if (p.team === me.team || !p.alive) continue;
    if (!foe || Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(foe.x - me.x, foe.y - me.y)) {
      foe = p;
    }
  }
  if (!foe || !ball || state.phase !== "play") {
    setKeys(state, seat, 0);
    return;
  }

  const dir = chooseAim(state, brain, ball, foe);
  brain.aim = dir;
  if (!dir) {
    setKeys(state, seat, steer(state, me, ball.x, ball.y));
    return;
  }
  const r = state.tune.ballRadius;
  const gap = standoff(dir, r);

  const relx = me.x - ball.x;
  const rely = me.y - ball.y;
  const behind = -(relx * dir.x + rely * dir.y); // how far back from the ball, along the shot
  const side = -relx * dir.y + rely * dir.x; // how far off the line of the shot

  if (behind > gap - 8 && Math.abs(side) < 12) {
    if (behind < HALF + TUNING.jabReach + 10 && safeToJab(me, dir, foeBall, r)) {
      requestJab(state, seat, dir.mask);
      // Step off the line of the shot, so a rebound goes past rather than
      // straight back into its own square.
      const i = DIRS.indexOf(dir);
      const sides = [DIRS[(i + 2) % 8], DIRS[(i + 6) % 8]].sort(() => Math.random() - 0.5);
      const step = sides.find((d) => !isBlocked(state, me.x + d.x * 40, me.y + d.y * 40)) ?? sides[0];
      brain.sidestep = { mask: step.mask, ticks: 14 };
      setKeys(state, seat, step.mask);
      return;
    }
    setKeys(state, seat, steer(state, me, ball.x - dir.x * gap, ball.y - dir.y * gap));
    return;
  }

  // Walk to a spot behind the ball, going round it rather than through it.
  let gx = ball.x - dir.x * (gap + 40);
  let gy = ball.y - dir.y * (gap + 40);
  if (behind < gap - 8 && Math.hypot(relx, rely) < gap + 70) {
    const s = side >= 0 ? 1 : -1;
    gx = ball.x - dir.y * s * (gap + 36) - dir.x * 10;
    gy = ball.y + dir.x * s * (gap + 36) - dir.y * 10;
  }
  setKeys(state, seat, steer(state, me, gx, gy));
}
