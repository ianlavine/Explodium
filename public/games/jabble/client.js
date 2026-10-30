// Jabble client: draws the stadium on a canvas and sends the controls. WASD
// steers your square; an arrow key throws a jab that way, and two arrows
// pressed together jab on the diagonal. A controller works too (see pollPad).
//
// The server owns the match, but waiting on it would put a round trip between
// a key and your square moving. So the browser runs the same engine itself
// (predict.js): each 1/60 s it turns the controls into one input, steps its
// own copy of the match and sends the input on; each snapshot from the server
// resets the copy and replays whatever the server hasn't reached yet. What's
// drawn is that copy — the present, not the past — with any correction the
// server forces (the other player turned; their jab moved a ball) eased in
// rather than snapped.
//
// It takes the whole window: its own layer over the page, a slim bar along
// the top and the arena scaled up to fill the rest. A Settings button in the
// corner drops down a panel of sliders over the engine's SETTINGS —
// reach, kick power, ball size and count, and so on. Moving one changes the
// match for everyone at the table (the server says when it's in force), and
// the last set you used is kept in this browser and brought to your next game.
//
// It's loud on purpose: the engine reports every contact (kick, knockback,
// bounce) as an event, and those become sound (sound.js) and sparks, shake,
// squash and hit-stop (juice.js). Your own hits come from this browser's copy
// of the match, so they land the instant they happen; anything the server
// reveals later still plays, once.
//
// createJabbleClient keeps all of a game's state to itself and only answers
// while it's the game being played.
import { socket, els, app, prefersReducedMotion } from "../../shared/context.js";
import { TICK_MS, SETTINGS, PRESETS, defaultSettings, jabExtension } from "./engine.js";
import { createPredictor } from "./predict.js";
import { createSounds } from "./sound.js";
import { createJuice } from "./juice.js";

const MOVE_BITS = { KeyW: 1, KeyS: 2, KeyA: 4, KeyD: 8 };
const JAB_BITS = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8 };
// Arrows pressed within this many ms of each other count as one diagonal jab.
const CHORD_MS = 35;
// A correction from the server is worked off over roughly this long, unless
// it's so big that easing would look stranger than a jump.
const EASE_MS = 80;
const SNAP_DIST = 260;
// After a stall (a background tab), don't race to catch up — start afresh.
const MAX_TICKS_PER_FRAME = 5;
// The same contact can be reported more than once — this browser predicted it,
// then replayed it after a correction — so one that matches something heard
// this recently, this close by, is taken to be the same and stays quiet.
const ECHO_MS = 450;
const ECHO_DIST = 40;
const TAU = Math.PI * 2;

// Controllers, in the browser's "standard" (Xbox-shaped) button layout. The
// face buttons sit in a diamond, so they jab the way the arrow keys do.
const PAD = { A: 0, B: 1, X: 2, Y: 3, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const FACE_JABS = [
  [PAD.Y, 1],
  [PAD.A, 2],
  [PAD.X, 4],
  [PAD.B, 8]
];
const STICK_DEAD = 0.35; // left stick: ignore drift below this
const FLICK_ON = 0.65; // right stick: pushing past this jabs that way...
const FLICK_OFF = 0.4; // ...and it must fall back under this before it can again

const KEYBOARD_HINT =
  "<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · " +
  "<kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> jab (two at once for a diagonal)";
// Slider moves are sent at most this often while you drag.
const SETTINGS_SEND_MS = 50;
const percent = (v) => `${Math.round(v * 100)}%`;
// How a slider's value reads, where a bare number wouldn't say much.
const SETTING_FORMATS = {
  jabCooldownTicks: (v) => `${(v / 60).toFixed(2)} s`,
  ballDrag: (v) => v.toFixed(2),
  iceFriction: (v) => v.toFixed(2),
  wallBounce: percent,
  bodyBounce: percent,
  iceWallBounce: percent,
  playerKickSpeed: (v) => (v ? String(v) : "off")
};
const formatSetting = (key, v) => (SETTING_FORMATS[key] ?? String)(v);

// Your last-used sliders for one game, kept per browser — only the ones moved
// off the default, so a slider you never touched follows the game's default
// when that changes. Storage can be missing or refuse (private windows); the
// game just starts on defaults then.
const savedKey = (id) => `jabble-settings-v2:${id}`;

function loadSavedSettings(id) {
  try {
    return JSON.parse(localStorage.getItem(savedKey(id))) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSettings(id, settings) {
  try {
    const defaults = defaultSettings();
    const moved = Object.fromEntries(Object.entries(settings ?? {}).filter(([key, v]) => v !== defaults[key]));
    if (Object.keys(moved).length) localStorage.setItem(savedKey(id), JSON.stringify(moved));
    else localStorage.removeItem(savedKey(id));
  } catch {
    // not saved; nothing else depends on it
  }
}

const PAD_HINT =
  "Controller: left stick move · right stick flick, or " +
  "<kbd>Y</kbd><kbd>X</kbd><kbd>A</kbd><kbd>B</kbd>, jab";

const TEAMS = [
  { name: "Blue", body: "#3d8bff", light: "#a9cbff", rgb: "61, 139, 255", glow: "rgba(61, 139, 255, 0.55)" },
  { name: "Red", body: "#ff4d5e", light: "#ffb0b7", rgb: "255, 77, 94", glow: "rgba(255, 77, 94, 0.55)" }
];

// One audio context for the page, whichever match is on.
const sounds = createSounds();

// What the floor looks like on each surface (the `ice` setting). `me` is the
// outline that marks your own square.
const SURFACES = {
  grass: {
    floor: "#12301f",
    band: "rgba(255, 255, 255, 0.025)",
    line: "rgba(255, 255, 255, 0.13)",
    rim: "rgba(255, 255, 255, 0.3)",
    me: "#ffffff",
    sheen: false
  },
  ice: {
    floor: "#d6e8f1",
    band: "rgba(255, 255, 255, 0.5)",
    line: "rgba(40, 70, 110, 0.2)",
    rim: "rgba(30, 50, 70, 0.45)",
    me: "#0f1216",
    sheen: true
  }
};

const surfaceLook = (jb) => (jb.tune.ice ? SURFACES.ice : SURFACES.grass);

// Movement bits (1 up, 2 down, 4 left, 8 right) for a stick at (x, y),
// snapped to the nearest of eight directions; 0 inside the dead zone.
function stickMask(x, y, dead) {
  const len = Math.hypot(x, y);
  if (len < dead) return 0;
  const lean = len * 0.38; // sin 22.5°: the edge between one octant and the next
  let mask = 0;
  if (x > lean) mask |= 8;
  else if (x < -lean) mask |= 4;
  if (y > lean) mask |= 2;
  else if (y < -lean) mask |= 1;
  return mask;
}

// --- drawing ----------------------------------------------------------------

// The floor's outline: four gently bowed sides, corner to corner.
function floorPath(ctx, rims) {
  ctx.beginPath();
  rims.forEach((rim) => ctx.arc(rim.x, rim.y, rim.r, rim.a0, rim.a1));
  ctx.closePath();
}

function drawFloor(ctx, jb, W, H) {
  const look = surfaceLook(jb);
  // Outside the bowed sides is all stadium wall.
  ctx.fillStyle = "#2b323d";
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  floorPath(ctx, jb.rims);
  ctx.clip();
  ctx.fillStyle = look.floor;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = look.band;
  if (look.sheen) {
    // Long diagonal streaks of shine across the ice.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.5);
    for (let x = -W; x < W; x += 170) ctx.fillRect(x, -H * 1.5, 55, H * 3);
    ctx.restore();
  } else {
    for (let x = 0; x < W; x += 200) ctx.fillRect(x, 0, 100, H);
  }
  // Each half tinted faintly toward the team that starts there.
  ctx.fillStyle = "rgba(61, 139, 255, 0.05)";
  ctx.fillRect(0, 0, W / 2, H);
  ctx.fillStyle = "rgba(255, 77, 94, 0.05)";
  ctx.fillRect(W / 2, 0, W / 2, H);

  ctx.strokeStyle = look.line;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 80, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  floorPath(ctx, jb.rims);
  ctx.strokeStyle = look.rim;
  ctx.lineWidth = 4;
  ctx.stroke();
}

// A bar stroked with round ends; `inset` thins it for the bevel highlight,
// (dx, dy) shifts it for the drop shadow.
function paintObstacle(ctx, solid, color, dx, dy, inset) {
  ctx.beginPath();
  ctx.moveTo(solid.x1 + dx, solid.y1 + dy);
  ctx.lineTo(solid.x2 + dx, solid.y2 + dy);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 2 * (solid.w - inset));
  ctx.stroke();
}

function drawWalls(ctx, solids) {
  ctx.lineCap = "round";
  solids.forEach((s) => paintObstacle(ctx, s, "rgba(0, 0, 0, 0.35)", 4, 6, 0));
  solids.forEach((s) => paintObstacle(ctx, s, "#4b5565", 0, 0, 0));
  solids.forEach((s) => paintObstacle(ctx, s, "#5b6676", -1, -1.5, 4));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawPlayer(ctx, jb, p, team, isMe) {
  const { playerSize: size, jabReach, fistRadius, armRadius } = jb.tune;
  const half = size / 2;
  const colors = TEAMS[team];
  // Knocked flying: a couple of fading copies trail behind along the flight.
  if (p.flying) {
    [0.035, 0.07].forEach((lag, i) => {
      roundRect(ctx, p.x - p.vx * lag - half, p.y - p.vy * lag - half, size, size, 6);
      ctx.fillStyle = colors.body;
      ctx.globalAlpha = i ? 0.12 : 0.25;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
  if (p.jab) {
    const reach = half + jabReach * p.jab.ext;
    const tipX = p.x + p.jab.dx * reach;
    const tipY = p.y + p.jab.dy * reach;
    ctx.strokeStyle = colors.light;
    ctx.lineCap = "round";
    ctx.lineWidth = armRadius * 2;
    ctx.beginPath();
    ctx.moveTo(p.x + p.jab.dx * half * 0.6, p.y + p.jab.dy * half * 0.6);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.fillStyle = colors.light;
    ctx.beginPath();
    ctx.arc(tipX, tipY, fistRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.body;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  // `scale` swells the square for a moment after it kicks; `white` flashes it
  // after it takes a knockback.
  const drawn = size * (p.scale ?? 1);
  roundRect(ctx, p.x - drawn / 2, p.y - drawn / 2, drawn, drawn, 6);
  ctx.fillStyle = colors.body;
  ctx.fill();
  if (p.white) {
    ctx.fillStyle = `rgba(255, 255, 255, ${p.white})`;
    ctx.fill();
  }
  ctx.lineWidth = isMe ? 3.5 : 2;
  ctx.strokeStyle = isMe ? surfaceLook(jb).me : "rgba(0, 0, 0, 0.4)";
  ctx.stroke();
}

// `shape`, if any, stretches the ball `along` its axis (nx, ny) and `across`
// it: squashed flat against whatever it just hit, or drawn out by speed. A
// faster ball also glows harder.
function drawBall(ctx, r, ball, shape, speed) {
  const colors = TEAMS[ball.team];
  ctx.save();
  ctx.translate(ball.x, ball.y);
  if (shape) {
    const angle = Math.atan2(shape.ny, shape.nx);
    ctx.rotate(angle);
    ctx.scale(shape.along, shape.across);
    ctx.rotate(-angle);
  }
  ctx.shadowColor = colors.glow;
  ctx.shadowBlur = 16 + Math.min(26, speed / 60);
  const gradient = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.15, 0, 0, r);
  gradient.addColorStop(0, colors.light);
  gradient.addColorStop(1, colors.body);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.stroke();
  ctx.restore();
}

// --- one game -----------------------------------------------------------------

// `id` is the lobby's game id; `stateKey` is the key its state_update travels
// under.
export function createJabbleClient({ id, name, stateKey }) {
  let jb = null; // the latest state_update: arena, score, phase
  let predictor = null; // this browser's running copy of the match
  let ease = { players: [], balls: [] }; // corrections still being worked off, { x, y } each
  let tickClock = null; // performance.now() the fixed 60 Hz input clock has reached
  let lastFrame = 0;
  let view = null; // { canvas, ctx, stage, overlay, you, score, hint }
  let frame = null;
  let resizeObserver = null;
  let moveKeys = 0; // keyboard movement held right now
  let queuedJab = 0; // a jab waiting for the next tick to carry it
  let chord = null; // { mask, timer } while a jab waits to see if it's a diagonal
  let padId = null; // the controller in use, if any
  let padHeld = []; // its buttons as of the last frame, for spotting presses
  let aimOut = false; // right stick is past FLICK_ON (and has already jabbed)
  let lastAlive = [];
  let lastJabbing = []; // per seat: was an arm out last frame (for the swish)
  let juice = null; // this match's effects
  let heardRecently = []; // { key, x, y, t } — see ECHO_MS
  let frozenAt = null; // positions held still during a hit-stop
  let shownScore = null; // to spot a change and pop it
  let root = null; // this game's full-window layer
  let settingsOpen = false;
  let rematchSent = false;
  let goUntil = 0; // "Go!" stays up until this performance.now()
  let unsentSettings = {}; // slider moves waiting for the next send
  let settingsTimer = null;
  let draggingKey = null; // the slider under your pointer, which incoming state mustn't yank

  function isActive() {
    return app.currentGame?.id === id;
  }

  function isPlaying() {
    return isActive() && !!jb && !!app.roomId && els.screens.game.classList.contains("screen-active");
  }

  function mySeat() {
    return app.myPlayerIndex ?? 0;
  }

  function myTeam() {
    return jb?.teams?.[mySeat()] ?? 0;
  }

  // --- input ----------------------------------------------------------------

  // Arrow keys and face buttons both come through here. The first press waits
  // CHORD_MS for a second; opposite directions cancel out.
  function pressJab(bit) {
    if (chord) {
      chord.mask |= bit;
      return;
    }
    chord = { mask: bit, timer: setTimeout(fireJab, CHORD_MS) };
  }

  function fireJab() {
    let mask = chord?.mask ?? 0;
    chord = null;
    if ((mask & 3) === 3) mask &= ~3; // up + down
    if ((mask & 12) === 12) mask &= ~12; // left + right
    if (mask) queuedJab = mask;
  }

  function requestRematch() {
    if (!app.roomId || rematchSent) return;
    rematchSent = true;
    socket.emit("jabble_rematch", { roomId: app.roomId });
    renderOverlay();
  }

  // Movement from the controller, read fresh every frame; jabs and the
  // rematch fire on the frame a button goes down. Browsers only reveal a
  // controller once one of its buttons has been pressed.
  function pollPad() {
    const pad = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected) ?? null;
    if ((pad?.id ?? null) !== padId) {
      padId = pad?.id ?? null;
      renderHint();
    }
    if (!pad || !isPlaying()) {
      padHeld = [];
      aimOut = false;
      return 0;
    }
    const down = (i) => !!pad.buttons[i]?.pressed;
    const pressed = (i) => down(i) && !padHeld[i];

    let move = stickMask(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEAD);
    if (down(PAD.UP)) move |= 1;
    if (down(PAD.DOWN)) move |= 2;
    if (down(PAD.LEFT)) move |= 4;
    if (down(PAD.RIGHT)) move |= 8;

    if (jb.phase === "matchover") {
      if (pressed(PAD.A) || pressed(PAD.START)) requestRematch();
    } else {
      FACE_JABS.forEach(([button, bit]) => {
        if (pressed(button)) pressJab(bit);
      });
      const ax = pad.axes[2] ?? 0;
      const ay = pad.axes[3] ?? 0;
      const aim = Math.hypot(ax, ay);
      if (!aimOut && aim > FLICK_ON) {
        aimOut = true;
        queuedJab = stickMask(ax, ay, 0);
      } else if (aimOut && aim < FLICK_OFF) {
        aimOut = false;
      }
    }
    padHeld = pad.buttons.map((b) => b.pressed);
    return move;
  }

  // One input per 1/60 s of real time: applied to our copy at once, batched
  // to the server once per frame.
  function runTicks(now) {
    if (!predictor) return;
    if (tickClock === null || now - tickClock > TICK_MS * MAX_TICKS_PER_FRAME) tickClock = now;
    const keys = moveKeys | pollPad();
    const outbox = [];
    while (now - tickClock >= TICK_MS) {
      tickClock += TICK_MS;
      outbox.push(predictor.tick(isPlaying() ? keys : 0, queuedJab));
      queuedJab = 0;
    }
    if (outbox.length && app.roomId) socket.emit("jabble_input", { roomId: app.roomId, inputs: outbox });
  }

  // Let go of everything at once, without waiting for a frame — a background
  // tab may not get another one, and the server holds whatever it last heard.
  function releaseAll() {
    moveKeys = 0;
    if (!predictor || !app.roomId) return;
    socket.emit("jabble_input", { roomId: app.roomId, inputs: [predictor.tick(0, 0)] });
  }

  window.addEventListener("keydown", (event) => {
    if (!isPlaying() || event.metaKey || event.ctrlKey || event.altKey) return;
    sounds.wake();
    if (event.code === "KeyM" && !event.repeat) {
      toggleMute();
      return;
    }
    if (event.code === "Escape" && settingsOpen) {
      showSettings(false);
      return;
    }
    const move = MOVE_BITS[event.code];
    if (move) {
      event.preventDefault();
      moveKeys |= move;
      return;
    }
    const jab = JAB_BITS[event.code];
    if (!jab) return;
    event.preventDefault(); // arrows would otherwise scroll the page
    if (event.repeat) return; // holding an arrow is one jab, not a stream
    pressJab(jab);
  });

  window.addEventListener("keyup", (event) => {
    const move = MOVE_BITS[event.code];
    if (move) moveKeys &= ~move;
  });

  // Keys released while the window is in the background never send a keyup.
  window.addEventListener("blur", () => {
    if (isActive()) releaseAll();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isActive()) releaseAll();
  });
  window.addEventListener("gamepadconnected", () => renderHint());
  window.addEventListener("gamepaddisconnected", () => renderHint());

  // --- snapshots ------------------------------------------------------------

  // Where everything is drawn: the copy's positions plus what's left of any
  // correction being eased off.
  function drawnAt(list, i, thing) {
    const off = list[i];
    return off ? { x: thing.x + off.x, y: thing.y + off.y } : { x: thing.x, y: thing.y };
  }

  function drawnPositions(world) {
    return {
      players: world.players.map((p, i) => drawnAt(ease.players, i, p)),
      balls: world.balls.map((b, i) => drawnAt(ease.balls, i, b))
    };
  }

  // A jump from where something was drawn to where it now belongs, kept as an
  // offset that shrinks to nothing — unless it's too far to ease.
  function easeFrom(was, thing) {
    if (!was) return { x: 0, y: 0 };
    const x = was.x - thing.x;
    const y = was.y - thing.y;
    return Math.hypot(x, y) > SNAP_DIST ? { x: 0, y: 0 } : { x, y };
  }

  socket.on("jabble_tick", (snap) => {
    if (!isActive() || !jb || !predictor || !snap || snap.r !== jb.round) return;
    const old = predictor.world;
    const before = old && old.round === snap.r ? drawnPositions(old) : null;
    predictor.reconcile(snap, jb.tune, jb.solids, jb.teams);
    const world = predictor.world;
    ease = {
      players: world.players.map((p, i) => easeFrom(before?.players[i], p)),
      balls: world.balls.map((b, i) => easeFrom(before?.balls[i], b))
    };
  });

  function decayEase(dt) {
    const keep = Math.exp(-Math.max(0, dt) / EASE_MS);
    [...ease.players, ...ease.balls].forEach((off) => {
      off.x *= keep;
      off.y *= keep;
    });
  }

  // --- juice ----------------------------------------------------------------

  const panAt = (x) => (x / jb.config.arenaW) * 2 - 1;
  const power = (speed, full) => Math.min(1, speed / full);

  // Whether `event` is a repeat of one already played (see ECHO_MS).
  function heardBefore(event, now) {
    const key = `${event.type}:${event.ball ?? ""}:${event.seat ?? ""}:${event.a ?? ""}:${event.b ?? ""}`;
    heardRecently = heardRecently.filter((h) => now - h.t < ECHO_MS);
    if (heardRecently.some((h) => h.key === key && Math.hypot(h.x - event.x, h.y - event.y) < ECHO_DIST)) {
      return true;
    }
    heardRecently.push({ key, x: event.x, y: event.y, t: now });
    return false;
  }

  // Hold the picture on `at` for a beat.
  function hitStop(ms, at, now) {
    juice.freeze(ms, now);
    if (juice.frozen(now)) frozenAt = frozenAt ?? at;
  }

  function playEvent(event, world, at, now) {
    const pan = panAt(event.x);
    const mine = event.seat === mySeat();
    switch (event.type) {
      case "kick": {
        const p = power(event.speed, 2200);
        sounds.kick(0.55 + 0.45 * p, pan);
        juice.kick(event.x, event.y, event.dx, event.dy, TEAMS[event.team], p);
        juice.squash(event.ball, event.dx, event.dy, 0.3, now);
        juice.pop(event.seat, "kick", now);
        juice.shake(mine ? 3 + 3 * p : 1.5);
        break;
      }
      case "knock":
        sounds.knock(pan);
        juice.knock(event.x, event.y, event.dx, event.dy, TEAMS[jb.teams[event.seat]]);
        juice.pop(event.seat, "hit", now);
        juice.shake(mine ? 13 : 8);
        hitStop(60, at, now);
        break;
      case "wall": {
        const p = power(event.speed, 1600);
        sounds.wall(p, pan, event.ball);
        juice.wall(event.x, event.y, event.nx, event.ny, TEAMS[event.team], p);
        juice.squash(event.ball, event.nx, event.ny, 0.12 + 0.3 * p, now);
        if (p > 0.7) juice.shake(2 + 4 * (p - 0.7));
        break;
      }
      case "clack": {
        const p = power(event.speed, 1800);
        sounds.clack(p, pan);
        juice.clack(event.x, event.y, TEAMS[event.teams[0]], TEAMS[event.teams[1]], p);
        const a = world.balls[event.a];
        const b = world.balls[event.b];
        if (a && b) {
          juice.squash(event.a, b.x - a.x, b.y - a.y, 0.1 + 0.25 * p, now);
          juice.squash(event.b, a.x - b.x, a.y - b.y, 0.1 + 0.25 * p, now);
        }
        if (p > 0.6) juice.shake(2);
        break;
      }
      case "body": {
        const p = power(event.speed, 1200);
        sounds.body(p, pan);
        juice.body(event.x, event.y, TEAMS[event.team], p);
        const ball = world.balls[event.ball];
        if (ball) juice.squash(event.ball, ball.x - event.x, ball.y - event.y, 0.1 + 0.2 * p, now);
        break;
      }
      case "slam": {
        const p = power(event.speed, 1500);
        sounds.slam(0.5 + 0.5 * p, pan);
        juice.slam(event.x, event.y, p);
        juice.shake(4 + 5 * p);
        break;
      }
      default:
    }
  }

  // Someone's out (the server has said so). The pieces fly away from the
  // enemy ball that got them; it's a red flash if it was you.
  function playDeath(seat, at, world, now) {
    const team = jb.teams[seat];
    const spot = at.players[seat];
    let dir = null;
    let nearest = Infinity;
    world.balls.forEach((b) => {
      if (b.team === team) return;
      const d = Math.hypot(spot.x - b.x, spot.y - b.y);
      if (d < nearest && d > 1e-6) {
        nearest = d;
        dir = { x: (spot.x - b.x) / d, y: (spot.y - b.y) / d };
      }
    });
    const mine = seat === mySeat();
    // The server sends the point before the death, so by now the score says
    // whether this kill won the match — that one gets the KO and hits harder.
    const ko = jb.phase === "over" && jb.score.some((s) => s >= jb.tune.winScore);
    juice.death(spot.x, spot.y, TEAMS[team], jb.tune.playerSize, dir, { ko });
    juice.shake(ko ? 26 : mine ? 22 : 16);
    juice.flash(mine ? "255, 60, 70" : "255, 255, 255", ko ? 0.65 : mine ? 0.55 : 0.4);
    hitStop(ko ? 260 : 130, at, now);
    sounds.death(panAt(spot.x));
  }

  // What changed since the last frame, made audible and visible: the
  // engine's contact events, deaths, arms thrown, skate marks on the ice.
  function noticeChanges(world, at, now) {
    for (const event of predictor.takeEvents()) {
      if (!heardBefore(event, now)) playEvent(event, world, at, now);
    }
    world.players.forEach((p, i) => {
      if (lastAlive[i] && !p.alive) playDeath(i, at, world, now);
      lastAlive[i] = p.alive;
      const jabbing = !!p.jab;
      if (jabbing && !lastJabbing[i] && p.alive) sounds.jab(panAt(at.players[i].x), i === mySeat());
      lastJabbing[i] = jabbing;
      if (jb.tune.ice && p.alive && Math.hypot(p.vx, p.vy) > 60) juice.skate(i, at.players[i].x, at.players[i].y, now);
    });
  }

  function ballShape(i, b, now) {
    const squash = juice.squashOf(i, now);
    if (squash) return { nx: squash.nx, ny: squash.ny, along: 1 - squash.amount, across: 1 + squash.amount * 0.55 };
    const speed = Math.hypot(b.vx, b.vy);
    if (speed < 500) return null;
    const stretch = Math.min(0.2, (speed - 500) / 6000);
    return { nx: b.vx / speed, ny: b.vy / speed, along: 1 + stretch, across: 1 - stretch * 0.6 };
  }

  function draw() {
    frame = requestAnimationFrame(draw);
    if (!view || !jb) return;
    const now = performance.now();
    const dt = lastFrame ? now - lastFrame : 0;
    lastFrame = now;
    runTicks(now);
    decayEase(dt);

    const world = predictor?.world;
    const live = !!world && world.round === jb.round;
    let at = live ? drawnPositions(world) : null;
    if (live) noticeChanges(world, at, now);
    else predictor?.takeEvents(); // contacts from a round that's over
    if (juice.frozen(now)) at = frozenAt ?? at;
    else frozenAt = null;
    juice.update(dt, now);

    const { ctx, canvas } = view;
    const { arenaW: W, arenaH: H } = jb.config;
    const scale = canvas.width / W;
    // Clear edge to edge first: a shaken picture would otherwise leave
    // last frame's pixels along the side it moved away from.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#2b323d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const jolt = juice.shakeOffset();
    ctx.setTransform(scale, 0, 0, scale, jolt.x * scale, jolt.y * scale);
    drawFloor(ctx, jb, W, H);
    juice.drawFloor(ctx, now);
    drawWalls(ctx, jb.solids);

    if (live) {
      const r = jb.tune.ballRadius;
      world.balls.forEach((b, i) => juice.trackBall(i, at.balls[i].x, at.balls[i].y, now));
      juice.drawTrails(ctx, (i) => TEAMS[world.balls[i]?.team ?? 0].rgb, r);
      world.balls.forEach((b, i) =>
        drawBall(ctx, r, { team: b.team, ...at.balls[i] }, ballShape(i, b, now), Math.hypot(b.vx, b.vy))
      );
      world.players.forEach((p, i) => {
        if (!p.alive) return;
        const ext = p.jab ? jabExtension(p.jab.t) : 0;
        const jab = ext > 0 ? { dx: p.jab.dx, dy: p.jab.dy, ext } : null;
        const pop = juice.popOf(i, now);
        drawPlayer(
          ctx,
          jb,
          { ...at.players[i], jab, flying: p.flying, vx: p.vx, vy: p.vy, scale: pop.scale, white: pop.white },
          jb.teams[i],
          i === mySeat()
        );
      });
    }
    juice.drawTop(ctx);

    const flash = juice.flashStyle();
    if (flash) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = flash;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // The shell resets the status line on its own schedule; keep ours on it.
    const status = statusText();
    if (els.turnStatus.textContent !== status) els.turnStatus.textContent = status;
    if (goUntil && now > goUntil) {
      goUntil = 0;
      renderOverlay();
    }
  }

  // --- HUD ------------------------------------------------------------------

  function statusText() {
    return `You are ${TEAMS[myTeam()].name} · first to ${jb.tune.winScore}`;
  }

  function fitCanvas() {
    if (!view || !jb) return;
    const { arenaW: W, arenaH: H } = jb.config;
    const box = view.stage.getBoundingClientRect();
    const scale = Math.max(0.1, Math.min(box.width / W, box.height / H));
    const cssW = Math.floor(W * scale);
    const cssH = Math.floor(H * scale);
    const dpr = window.devicePixelRatio || 1;
    view.canvas.style.width = `${cssW}px`;
    view.canvas.style.height = `${cssH}px`;
    view.canvas.width = Math.round(cssW * dpr);
    view.canvas.height = Math.round(cssH * dpr);
  }

  // The game's own layer over the whole window (the shell's header and Leave
  // button sit underneath it): the bar, the arena, and the settings dropdown.
  function buildView() {
    els.gameBoard.innerHTML = "";
    els.hand.innerHTML = "";
    root = document.createElement("div");
    root.className = "jb-root";

    const bar = document.createElement("div");
    bar.className = "jb-bar";
    const you = document.createElement("div");
    you.className = "jb-you";
    const score = document.createElement("div");
    score.className = "jb-score";
    const tools = document.createElement("div");
    tools.className = "jb-tools";
    const hint = document.createElement("div");
    hint.className = "jb-hint";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "ghost-btn jb-tool";
    mute.addEventListener("click", () => {
      sounds.wake();
      toggleMute();
      mute.blur(); // the keyboard belongs to the game
    });
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "ghost-btn jb-tool jb-settings-btn";
    settings.textContent = "⚙ Settings";
    settings.addEventListener("click", () => {
      showSettings(!settingsOpen);
      settings.blur();
    });
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "ghost-btn jb-tool";
    leave.textContent = "Leave";
    // The shell's own Leave Game button is under this layer; press it for us.
    leave.addEventListener("click", () => els.exitButton.click());
    tools.append(hint, mute, settings, leave);
    bar.append(you, score, tools);

    const stage = document.createElement("div");
    stage.className = "jb-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "jb-canvas";
    const overlay = document.createElement("div");
    overlay.className = "jb-overlay";
    stage.append(canvas, overlay);
    // Clicking back on the arena puts the settings away.
    stage.addEventListener("pointerdown", () => showSettings(false));

    const panel = buildPanel();
    root.append(bar, stage, panel.root);
    root.addEventListener("pointerdown", () => sounds.wake());
    document.body.appendChild(root);

    view = { canvas, ctx: canvas.getContext("2d"), stage, overlay, you, score, hint, panel, mute, settings };
    juice = createJuice({ reducedMotion: prefersReducedMotion() });
    showSettings(false);
    renderMute();
    renderHint();
    renderPanel();

    overlay.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".jb-rematch")) requestRematch();
    });

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(fitCanvas);
    resizeObserver.observe(stage);
    fitCanvas();
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function showSettings(open) {
    settingsOpen = open;
    if (!view) return;
    view.panel.root.classList.toggle("hidden", !open);
    view.settings.classList.toggle("on", open);
    view.settings.setAttribute("aria-expanded", String(open));
  }

  // --- sliders --------------------------------------------------------------

  // Built once per match from SETTINGS, grouped as the list groups them.
  // Sliders tied to one surface are all built, and shown or hidden as the
  // surface changes (renderPanel). A setting with `choices` is a row of
  // buttons rather than a slider.
  function buildPanel() {
    const root = document.createElement("aside");
    root.className = "jb-panel";
    // Modes first: Default (every slider back) and each named preset.
    const modes = [{ id: "default", name: "Default", settings: defaultSettings() }, ...PRESETS];
    root.innerHTML =
      `<div class="jb-panel-head"><strong>Tune the game</strong></div>` +
      (app.isBotGame ? "" : `<p class="jb-panel-note">Changes here apply for both players.</p>`) +
      `<section class="jb-group"><h4>Mode</h4><div class="jb-choice jb-modes" role="group" aria-label="Mode">` +
      modes.map((mode) => `<button type="button" data-mode="${mode.id}">${mode.name}</button>`).join("") +
      `</div></section>`;
    const rows = new Map(); // key -> { def, row, wait, input?, value?, buttons? }
    let group = null;
    SETTINGS.forEach((def) => {
      if (def.group !== group?.dataset.group) {
        group = document.createElement("section");
        group.className = "jb-group";
        group.dataset.group = def.group;
        group.innerHTML = `<h4>${def.group}</h4>`;
        root.appendChild(group);
      }
      const row = document.createElement(def.choices ? "div" : "label");
      row.className = "jb-slider";
      row.innerHTML =
        `<span class="jb-slider-top"><span>${def.label}</span>` +
        `<span class="jb-slider-wait hidden">next round</span>` +
        (def.choices ? "" : `<span class="jb-slider-value"></span>`) +
        `</span>` +
        (def.choices
          ? `<div class="jb-choice" role="group" aria-label="${def.label}">` +
            def.choices.map((label, v) => `<button type="button" data-v="${v}">${label}</button>`).join("") +
            `</div>`
          : `<input type="range" min="${def.min}" max="${def.max}" step="${def.step}">`);
      const entry = { def, row, wait: row.querySelector(".jb-slider-wait") };
      if (def.choices) {
        entry.buttons = [...row.querySelectorAll("button")];
        entry.buttons.forEach((button) =>
          button.addEventListener("click", () => {
            button.blur(); // the keyboard belongs to the game
            queueSetting(def.key, Number(button.dataset.v));
            renderPanel();
          })
        );
      } else {
        const input = row.querySelector("input");
        const value = row.querySelector(".jb-slider-value");
        input.addEventListener("pointerdown", () => (draggingKey = def.key));
        input.addEventListener("input", () => {
          const v = Number(input.value);
          value.textContent = formatSetting(def.key, v);
          queueSetting(def.key, v);
        });
        // Let go: hand the keyboard back to the game too, since a focused
        // slider would otherwise be what the next arrow key nudges.
        const release = () => {
          if (draggingKey === def.key) draggingKey = null;
          input.blur();
        };
        input.addEventListener("pointerup", release);
        input.addEventListener("pointercancel", release);
        input.addEventListener("change", release);
        Object.assign(entry, { input, value });
      }
      rows.set(def.key, entry);
      group.appendChild(row);
    });
    const modeButtons = [...root.querySelectorAll(".jb-modes button")];
    modeButtons.forEach((button) =>
      button.addEventListener("click", () => {
        button.blur(); // the keyboard belongs to the game
        const mode = modes.find((m) => m.id === button.dataset.mode);
        if (!app.roomId || !mode) return;
        unsentSettings = {};
        saveSettings(id, mode.settings); // your next game starts in it too
        if (mode.id === "default") socket.emit("jabble_settings", { roomId: app.roomId, reset: true });
        else socket.emit("jabble_settings", { roomId: app.roomId, changes: mode.settings });
      })
    );
    return { root, rows, modes, modeButtons };
  }

  // Sliders follow the server's word, except the one you're holding or have
  // just moved and not yet sent. A "next round" tag marks a value that's set
  // but not yet in force. Only the current surface's movement sliders show.
  function renderPanel() {
    if (!view?.panel || !jb) return;
    const wanted = (key) => (key in unsentSettings ? unsentSettings[key] : jb.settings[key]);
    const surface = wanted("ice") ? "ice" : "grip";
    // A mode is lit while every slider matches it.
    const { modes, modeButtons } = view.panel;
    modeButtons.forEach((button) => {
      const mode = modes.find((m) => m.id === button.dataset.mode);
      button.classList.toggle("on", !!mode && SETTINGS.every((def) => wanted(def.key) === mode.settings[def.key]));
    });
    view.panel.rows.forEach(({ def, row, wait, input, value, buttons }, key) => {
      row.classList.toggle("hidden", !!def.only && def.only !== surface);
      wait.classList.toggle("hidden", jb.settings[key] === jb.tune[key]);
      if (buttons) {
        buttons.forEach((button) => button.classList.toggle("on", Number(button.dataset.v) === wanted(key)));
      } else if (key !== draggingKey && !(key in unsentSettings)) {
        input.value = String(jb.settings[key]);
        value.textContent = formatSetting(key, jb.settings[key]);
      }
    });
  }

  function queueSetting(key, v) {
    unsentSettings[key] = v;
    saveSettings(id, { ...jb.settings, ...unsentSettings });
    if (!settingsTimer) settingsTimer = setTimeout(sendSettings, SETTINGS_SEND_MS);
  }

  function sendSettings() {
    settingsTimer = null;
    if (app.roomId && Object.keys(unsentSettings).length) {
      socket.emit("jabble_settings", { roomId: app.roomId, changes: unsentSettings });
    }
    unsentSettings = {};
  }

  function toggleMute() {
    sounds.toggleMute();
    renderMute();
  }

  function renderMute() {
    if (!view?.mute) return;
    view.mute.textContent = sounds.muted ? "Sound off (M)" : "Sound on (M)";
    view.mute.setAttribute("aria-pressed", String(!sounds.muted));
  }

  function renderHint() {
    if (view) view.hint.innerHTML = padId ? PAD_HINT : KEYBOARD_HINT;
  }

  function renderHud() {
    if (!view || !jb) return;
    const team = myTeam();
    view.you.className = `jb-you jb-t${team}`;
    view.you.textContent = `You · ${TEAMS[team].name}`;
    // A side whose score just went up pops.
    const popped = (side) => (shownScore && jb.score[side] > shownScore[side] ? " jb-pop" : "");
    view.score.innerHTML =
      `<span class="jb-t0${popped(0)}">${TEAMS[0].name} ${jb.score[0]}</span>` +
      `<span class="jb-dash">–</span>` +
      `<span class="jb-t1${popped(1)}">${jb.score[1]} ${TEAMS[1].name}</span>` +
      `<small class="jb-first-to">first to ${jb.tune.winScore}</small>`;
    shownScore = [...jb.score];
  }

  function roundCall() {
    const winner = jb.lastRound?.winner;
    if (winner === null || winner === undefined) return { big: "Both out", small: "No point" };
    return winner === myTeam()
      ? { big: "Point to you", small: `${TEAMS[winner].name} ${jb.score[winner]} – ${jb.score[1 - winner]}` }
      : { big: `Point to ${TEAMS[winner].name}`, small: "You got hit" };
  }

  function renderOverlay() {
    if (!view || !jb) return;
    let html = "";
    if (jb.phase === "countdown") {
      html = `<div class="jb-call"><small>Round ${jb.round}</small><strong>Ready…</strong></div>`;
    } else if (jb.phase === "play" && goUntil) {
      html = `<div class="jb-call jb-go"><strong>Go!</strong></div>`;
    } else if (jb.phase === "over") {
      const call = roundCall();
      html = `<div class="jb-call"><strong>${call.big}</strong><small>${call.small}</small></div>`;
    } else if (jb.phase === "matchover") {
      const winner = jb.score[0] > jb.score[1] ? 0 : 1;
      const big = winner === myTeam() ? "You win!" : `${TEAMS[winner].name} wins`;
      const final = `${Math.max(...jb.score)} – ${Math.min(...jb.score)}`;
      const button = rematchSent
        ? `<span class="jb-wait">Waiting for the other player…</span>`
        : `<button type="button" class="primary-btn jb-rematch">Rematch${padId ? " (A)" : ""}</button>`;
      html = `<div class="jb-call jb-final"><strong>${big}</strong><small>${final}</small>${button}</div>`;
    }
    view.overlay.innerHTML = html;
  }

  // Round and match moments, by ear.
  function playPhase(state) {
    if (state.phase === "countdown") sounds.ready();
    else if (state.phase === "play") sounds.go();
    else if (state.phase === "over") {
      const winner = state.lastRound?.winner;
      sounds.point(winner === null || winner === undefined ? null : winner === myTeam());
    } else if (state.phase === "matchover") {
      sounds.fanfare(state.score[myTeam()] > state.score[1 - myTeam()]);
    }
  }

  // --- module ---------------------------------------------------------------

  function clearState() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    if (chord) clearTimeout(chord.timer);
    chord = null;
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = null;
    unsentSettings = {};
    draggingKey = null;
    jb = null;
    view = null;
    predictor = null;
    ease = { players: [], balls: [] };
    tickClock = null;
    moveKeys = 0;
    queuedJab = 0;
    padHeld = [];
    aimOut = false;
    lastAlive = [];
    lastJabbing = [];
    juice = null;
    root?.remove();
    root = null;
    settingsOpen = false;
    heardRecently = [];
    frozenAt = null;
    shownScore = null;
    lastFrame = 0;
    rematchSent = false;
    goUntil = 0;
  }

  return {
    id,
    name,
    botName: "the bot",

    // There's no setup screen, so this hands straight back — with your saved
    // sliders as the match's starting settings: Solo starts a game against
    // the bot (level 0, its only one) and the card joins the queue, no
    // opponent picker in between.
    openSetup({ mode, onReady }) {
      sounds.wake(); // still inside the click, which is what lets a page make sound
      onReady({ settings: loadSavedSettings(id) }, mode === "solo" ? 0 : null);
    },

    handleState(payload, resetGameUi) {
      if (!payload[stateKey]) return false;
      const firstRender = !jb || !view || !document.body.contains(view.canvas);
      const prev = jb;
      jb = payload[stateKey];
      if (firstRender) {
        resetGameUi();
        predictor = createPredictor(mySeat());
        buildView();
      }
      if (!prev || prev.round !== jb.round) {
        lastAlive = [];
        lastJabbing = [];
        heardRecently = [];
        juice?.clearRound();
      }
      if (prev && prev.phase !== jb.phase) playPhase(jb);
      if (prev?.phase === "countdown" && jb.phase === "play") goUntil = performance.now() + 400;
      if (jb.phase !== "matchover") rematchSent = false;
      renderHud();
      renderPanel();
      renderOverlay();
      return true;
    },

    // Leaving, or another game starting: take the full-window layer away.
    resetUi() {
      root?.remove();
      root = null;
    },

    clearState,

    onMatchFound() {
      clearState();
    },

    onOpponentLeft() {
      clearState();
    },

    onExit() {
      clearState();
    }
  };
}

export const jabble = createJabbleClient({ id: "jabble", name: "Jabble", stateKey: "jabble" });
