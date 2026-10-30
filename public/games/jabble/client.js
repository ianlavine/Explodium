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
// Down the right-hand side is a panel of sliders over the engine's SETTINGS —
// reach, kick power, ball size and count, and so on. Moving one changes the
// match for everyone at the table (the server says when it's in force), and
// the last set you used is kept in this browser and brought to your next game.
//
// Jabble and Jabble Ice are both made by createJabbleClient. The home screen
// may load the two at once, so each keeps its own state and only answers when
// it's the game being played.
import { socket, els, app } from "../../shared/context.js";
import { TICK_MS, SETTINGS, defaultSettings, jabExtension } from "./engine.js";
import { createPredictor } from "./predict.js";

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
const BURST_MS = 650;

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
// The board spans the window, this far in from each side.
const GUTTER_PX = 24;

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
    const defaults = defaultSettings(id);
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
  { name: "Blue", body: "#3d8bff", light: "#a9cbff", glow: "rgba(61, 139, 255, 0.55)" },
  { name: "Red", body: "#ff4d5e", light: "#ffb0b7", glow: "rgba(255, 77, 94, 0.55)" }
];

// What the floor looks like, by the server's config.surface. `me` is the
// outline that marks your own square.
const SURFACES = {
  turf: {
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
  const look = SURFACES[jb.config.surface] ?? SURFACES.turf;
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

// A disc filled, or a curved bar stroked with round ends; `inset` shrinks it
// for the bevel highlight, (dx, dy) shifts it for the drop shadow.
function paintObstacle(ctx, solid, color, dx, dy, inset) {
  ctx.beginPath();
  if (solid.kind === "pillar") {
    ctx.arc(solid.x + dx, solid.y + dy, Math.max(1, solid.r - inset), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.arc(solid.x + dx, solid.y + dy, solid.r, solid.mid - solid.half, solid.mid + solid.half);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 2 * (solid.w - inset));
    ctx.stroke();
  }
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
  roundRect(ctx, p.x - half, p.y - half, size, size, 6);
  ctx.fillStyle = colors.body;
  ctx.fill();
  ctx.lineWidth = isMe ? 3.5 : 2;
  ctx.strokeStyle = isMe ? (SURFACES[jb.config.surface] ?? SURFACES.turf).me : "rgba(0, 0, 0, 0.4)";
  ctx.stroke();
}

function drawBall(ctx, r, ball) {
  const colors = TEAMS[ball.team];
  ctx.save();
  ctx.shadowColor = colors.glow;
  ctx.shadowBlur = 16;
  const gradient = ctx.createRadialGradient(ball.x - r * 0.35, ball.y - r * 0.35, r * 0.15, ball.x, ball.y, r);
  gradient.addColorStop(0, colors.light);
  gradient.addColorStop(1, colors.body);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.stroke();
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
  let bursts = []; // { x, y, team, start, spin }
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

  function decayEase(now) {
    const keep = Math.exp(-Math.max(0, now - lastFrame) / EASE_MS);
    lastFrame = now;
    [...ease.players, ...ease.balls].forEach((off) => {
      off.x *= keep;
      off.y *= keep;
    });
  }

  function drawBursts(ctx, now) {
    bursts = bursts.filter((b) => now - b.start < BURST_MS);
    bursts.forEach((b) => {
      const k = (now - b.start) / BURST_MS;
      const colors = TEAMS[b.team];
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = colors.light;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 14 + k * 50, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colors.body;
      for (let i = 0; i < 10; i += 1) {
        const angle = (i / 10) * Math.PI * 2 + b.spin;
        const d = 10 + k * 70;
        ctx.fillRect(b.x + Math.cos(angle) * d - 4, b.y + Math.sin(angle) * d - 4, 8, 8);
      }
      ctx.globalAlpha = 1;
    });
  }

  function draw() {
    frame = requestAnimationFrame(draw);
    if (!view || !jb) return;
    const now = performance.now();
    runTicks(now);
    decayEase(now);

    const { ctx, canvas } = view;
    const { arenaW: W, arenaH: H } = jb.config;
    const scale = canvas.width / W;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFloor(ctx, jb, W, H);
    drawWalls(ctx, jb.solids);

    const world = predictor?.world;
    if (world && world.round === jb.round) {
      const at = drawnPositions(world);
      world.players.forEach((p, i) => {
        if (lastAlive[i] && !p.alive) {
          bursts.push({ ...at.players[i], team: jb.teams[i], start: now, spin: Math.random() });
        }
        lastAlive[i] = p.alive;
      });
      world.balls.forEach((b, i) => drawBall(ctx, jb.tune.ballRadius, { team: b.team, ...at.balls[i] }));
      world.players.forEach((p, i) => {
        if (!p.alive) return;
        const ext = p.jab ? jabExtension(p.jab.t) : 0;
        const jab = ext > 0 ? { dx: p.jab.dx, dy: p.jab.dy, ext } : null;
        drawPlayer(ctx, jb, { ...at.players[i], jab, flying: p.flying, vx: p.vx, vy: p.vy }, jb.teams[i], i === mySeat());
      });
    }
    drawBursts(ctx, now);

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

  // Stretch the board across the window. Its container (the shell) can sit
  // anywhere — at the left of a wide window, it does — so this measures where
  // the container starts and offsets the board from there.
  function placeBoard() {
    const board = els.gameBoard;
    const container = board.parentElement;
    if (!view || !container) return;
    const windowWidth = document.documentElement.clientWidth;
    board.style.left = `${Math.round(GUTTER_PX - container.getBoundingClientRect().left)}px`;
    board.style.width = `${Math.max(320, windowWidth - 2 * GUTTER_PX)}px`;
  }

  window.addEventListener("resize", () => {
    if (isActive()) placeBoard();
  });

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

  function buildView() {
    els.gameBoard.innerHTML = "";
    els.gameBoard.classList.add("jb-board");
    els.hand.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "jb-bar";
    const you = document.createElement("div");
    you.className = "jb-you";
    const score = document.createElement("div");
    score.className = "jb-score";
    const hint = document.createElement("div");
    hint.className = "jb-hint";
    bar.append(you, score, hint);

    const stage = document.createElement("div");
    stage.className = "jb-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "jb-canvas";
    const overlay = document.createElement("div");
    overlay.className = "jb-overlay";
    stage.append(canvas, overlay);

    const panel = buildPanel();
    const main = document.createElement("div");
    main.className = "jb-main";
    main.append(stage, panel.root);

    els.gameBoard.append(bar, main);
    view = { canvas, ctx: canvas.getContext("2d"), stage, overlay, you, score, hint, panel };
    renderHint();
    renderPanel();

    overlay.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".jb-rematch")) requestRematch();
    });

    // The game screen is still hidden while this runs (it measures as
    // nothing), so the board is placed again whenever its container gets a
    // size, as well as whenever the arena's own space changes.
    resizeObserver = new ResizeObserver(() => {
      placeBoard();
      fitCanvas();
    });
    resizeObserver.observe(stage);
    if (els.gameBoard.parentElement) resizeObserver.observe(els.gameBoard.parentElement);
    placeBoard();
    fitCanvas();
    if (!frame) frame = requestAnimationFrame(draw);
  }

  // --- sliders --------------------------------------------------------------

  // Built once per match from SETTINGS, grouped as the list groups them, and
  // only the sliders that mean something in this game.
  function buildPanel() {
    const kind = jb.tune.ice ? "ice" : "grip";
    const root = document.createElement("aside");
    root.className = "jb-panel";
    root.innerHTML =
      `<div class="jb-panel-head"><strong>Tune the game</strong>` +
      `<button type="button" class="ghost-btn jb-reset">Reset</button></div>` +
      (app.isBotGame ? "" : `<p class="jb-panel-note">Changes here apply for both players.</p>`);
    const rows = new Map(); // key -> { input, value, wait }
    let group = null;
    SETTINGS.filter((def) => !def.only || def.only === kind).forEach((def) => {
      if (def.group !== group?.dataset.group) {
        group = document.createElement("section");
        group.className = "jb-group";
        group.dataset.group = def.group;
        group.innerHTML = `<h4>${def.group}</h4>`;
        root.appendChild(group);
      }
      const row = document.createElement("label");
      row.className = "jb-slider";
      row.innerHTML =
        `<span class="jb-slider-top"><span>${def.label}</span>` +
        `<span class="jb-slider-wait hidden">next round</span>` +
        `<span class="jb-slider-value"></span></span>` +
        `<input type="range" min="${def.min}" max="${def.max}" step="${def.step}">`;
      const input = row.querySelector("input");
      const value = row.querySelector(".jb-slider-value");
      input.addEventListener("pointerdown", () => (draggingKey = def.key));
      input.addEventListener("input", () => {
        const v = Number(input.value);
        value.textContent = formatSetting(def.key, v);
        queueSetting(def.key, v);
      });
      // Let go: hand the keyboard back to the game too, since a focused slider
      // would otherwise be what the next arrow key nudges.
      const release = () => {
        if (draggingKey === def.key) draggingKey = null;
        input.blur();
      };
      input.addEventListener("pointerup", release);
      input.addEventListener("pointercancel", release);
      input.addEventListener("change", release);
      rows.set(def.key, { input, value, wait: row.querySelector(".jb-slider-wait") });
      group.appendChild(row);
    });
    root.querySelector(".jb-reset").addEventListener("click", () => {
      if (!app.roomId) return;
      unsentSettings = {};
      saveSettings(id, null);
      socket.emit("jabble_settings", { roomId: app.roomId, reset: true });
    });
    return { root, rows };
  }

  // Sliders follow the server's word, except the one you're holding. A
  // "next round" tag marks a value that's set but not yet in force.
  function renderPanel() {
    if (!view?.panel || !jb) return;
    view.panel.rows.forEach(({ input, value, wait }, key) => {
      const set = jb.settings[key];
      if (key !== draggingKey && !(key in unsentSettings)) {
        input.value = String(set);
        value.textContent = formatSetting(key, set);
      }
      wait.classList.toggle("hidden", set === jb.tune[key]);
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

  function renderHint() {
    if (view) view.hint.innerHTML = padId ? PAD_HINT : KEYBOARD_HINT;
  }

  function renderHud() {
    if (!view || !jb) return;
    const team = myTeam();
    view.you.className = `jb-you jb-t${team}`;
    view.you.textContent = `You · ${TEAMS[team].name}`;
    view.score.innerHTML =
      `<span class="jb-t0">${TEAMS[0].name} ${jb.score[0]}</span>` +
      `<span class="jb-dash">–</span>` +
      `<span class="jb-t1">${jb.score[1]} ${TEAMS[1].name}</span>`;
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
    bursts = [];
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
      onReady({ settings: loadSavedSettings(id) }, mode === "solo" ? 0 : null);
    },

    handleState(payload, resetGameUi) {
      if (!payload[stateKey]) return false;
      const firstRender = !jb || !view || !els.gameBoard.contains(view.canvas);
      const prev = jb;
      jb = payload[stateKey];
      if (firstRender) {
        resetGameUi();
        predictor = createPredictor(mySeat());
        buildView();
      }
      if (!prev || prev.round !== jb.round) {
        lastAlive = [];
        bursts = [];
      }
      if (prev?.phase === "countdown" && jb.phase === "play") goUntil = performance.now() + 600;
      if (jb.phase !== "matchover") rematchSent = false;
      renderHud();
      renderPanel();
      renderOverlay();
      return true;
    },

    // The board element is shared with every other game, so take back the
    // position placeBoard gave it too.
    resetUi() {
      els.gameBoard.classList.remove("jb-board");
      els.gameBoard.style.left = "";
      els.gameBoard.style.width = "";
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
