// Jabble client: draws the stadium on a canvas and sends the keyboard. WASD
// steers your square; an arrow key throws a jab that way, and two arrows
// pressed together jab on the diagonal. The server owns every position — this
// side draws a moment in the past, interpolated between the snapshots it's
// been sent, so motion stays smooth when one arrives late.
//
// Jabble and Jabble Ice are both made by createJabbleClient. The home screen
// may load the two at once, so each keeps its own state and only answers when
// it's the game being played.
import { socket, els, app } from "../../shared/context.js";

const MOVE_BITS = { KeyW: 1, KeyS: 2, KeyA: 4, KeyD: 8 };
const JAB_BITS = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8 };
// Arrows pressed within this many ms of each other count as one diagonal jab.
const CHORD_MS = 35;
// How far behind the newest snapshot to draw. Snapshots come every ~33 ms, so
// this leaves room for one to be late without the picture stalling.
const INTERP_MS = 70;
const BURST_MS = 650;

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

const lerp = (a, b, f) => a + (b - a) * f;

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
  const { playerSize: size, jabReach, fistRadius, armRadius } = jb.config;
  const half = size / 2;
  const colors = TEAMS[team];
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
  let snaps = []; // recent snapshots of the current round, oldest first
  let clockOffset = null; // local ms minus server tick time — tracks the fastest arrival
  let view = null; // { canvas, ctx, stage, overlay, you, score }
  let frame = null;
  let resizeObserver = null;
  let moveKeys = 0;
  let sentKeys = 0;
  let chord = null; // { mask, timer } while a jab waits to see if it's a diagonal
  let lastAlive = [];
  let bursts = []; // { x, y, team, start, spin }
  let rematchSent = false;
  let goUntil = 0; // "Go!" stays up until this performance.now()

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

  function sendKeys() {
    if (moveKeys === sentKeys || !isPlaying()) return;
    sentKeys = moveKeys;
    socket.emit("jabble_input", { roomId: app.roomId, keys: moveKeys });
  }

  function fireJab() {
    let mask = chord?.mask ?? 0;
    chord = null;
    if ((mask & 3) === 3) mask &= ~3; // up + down
    if ((mask & 12) === 12) mask &= ~12; // left + right
    if (mask && isPlaying()) socket.emit("jabble_jab", { roomId: app.roomId, dir: mask });
  }

  window.addEventListener("keydown", (event) => {
    if (!isPlaying() || event.metaKey || event.ctrlKey || event.altKey) return;
    const move = MOVE_BITS[event.code];
    if (move) {
      event.preventDefault();
      moveKeys |= move;
      sendKeys();
      return;
    }
    const jab = JAB_BITS[event.code];
    if (!jab) return;
    event.preventDefault(); // arrows would otherwise scroll the page
    if (event.repeat) return; // holding an arrow is one jab, not a stream
    if (chord) {
      chord.mask |= jab;
      return;
    }
    chord = { mask: jab, timer: setTimeout(fireJab, CHORD_MS) };
  });

  window.addEventListener("keyup", (event) => {
    const move = MOVE_BITS[event.code];
    if (!move) return;
    moveKeys &= ~move;
    sendKeys();
  });

  // Keys released while the window is in the background never send a keyup.
  window.addEventListener("blur", () => {
    moveKeys = 0;
    sendKeys();
  });

  // --- snapshots ------------------------------------------------------------

  socket.on("jabble_tick", (snap) => {
    if (!isActive() || !jb || !snap) return;
    const now = performance.now();
    const sample = now - snap.t * jb.config.tickMs;
    // The smallest sample is the least-delayed arrival seen; drift upward
    // slowly so a server that runs a touch slow doesn't leave us starved.
    if (clockOffset === null || sample < clockOffset) clockOffset = sample;
    else clockOffset += (sample - clockOffset) * 0.01;
    if (snaps.length && snaps[snaps.length - 1].r !== snap.r) snaps = [];
    snaps.push(snap);
    if (snaps.length > 40) snaps.shift();
  });

  // The world as it was INTERP_MS ago, blended between the two snapshots
  // either side of that moment.
  function currentPose() {
    if (!jb || clockOffset === null) return null;
    const live = snaps.filter((s) => s.r === jb.round);
    if (!live.length) return null;
    const at = (performance.now() - clockOffset - INTERP_MS) / jb.config.tickMs;
    let a = live[0];
    let b = live[0];
    for (let i = 0; i < live.length; i += 1) {
      if (live[i].t <= at) {
        a = live[i];
        b = live[i + 1] ?? live[i];
      }
    }
    const f = b.t > a.t ? Math.max(0, Math.min(1, (at - a.t) / (b.t - a.t))) : 0;
    return {
      players: a.pl.map((pa, i) => {
        const pb = b.pl[i] ?? pa;
        const ext = lerp(pa[5], pb[5], f) / 100;
        const src = pb[5] ? pb : pa;
        return {
          x: lerp(pa[0], pb[0], f),
          y: lerp(pa[1], pb[1], f),
          alive: !!pa[2],
          jab: ext > 0 ? { dx: src[3] / 100, dy: src[4] / 100, ext } : null
        };
      }),
      balls: a.b.map((ba, i) => {
        const bb = b.b[i] ?? ba;
        return { team: ba[0], x: lerp(ba[1], bb[1], f), y: lerp(ba[2], bb[2], f) };
      })
    };
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
    const { ctx, canvas } = view;
    const { arenaW: W, arenaH: H } = jb.config;
    const scale = canvas.width / W;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFloor(ctx, jb, W, H);
    drawWalls(ctx, jb.solids);

    const now = performance.now();
    const pose = currentPose();
    if (pose) {
      pose.players.forEach((p, i) => {
        if (lastAlive[i] && !p.alive) {
          bursts.push({ x: p.x, y: p.y, team: jb.teams[i], start: now, spin: Math.random() });
        }
        lastAlive[i] = p.alive;
      });
      pose.balls.forEach((ball) => drawBall(ctx, jb.config.ballRadius, ball));
      pose.players.forEach((p, i) => {
        if (p.alive) drawPlayer(ctx, jb, p, jb.teams[i], i === mySeat());
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
    return `You are ${TEAMS[myTeam()].name} · first to ${jb.config.winScore}`;
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
    hint.innerHTML =
      "<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · " +
      "<kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> jab (two at once for a diagonal)";
    bar.append(you, score, hint);

    const stage = document.createElement("div");
    stage.className = "jb-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "jb-canvas";
    const overlay = document.createElement("div");
    overlay.className = "jb-overlay";
    stage.append(canvas, overlay);

    els.gameBoard.append(bar, stage);
    view = { canvas, ctx: canvas.getContext("2d"), stage, overlay, you, score };

    overlay.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".jb-rematch")) return;
      if (!app.roomId || rematchSent) return;
      rematchSent = true;
      socket.emit("jabble_rematch", { roomId: app.roomId });
      renderOverlay();
    });

    resizeObserver = new ResizeObserver(fitCanvas);
    resizeObserver.observe(stage);
    fitCanvas();
    if (!frame) frame = requestAnimationFrame(draw);
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
        : `<button type="button" class="primary-btn jb-rematch">Rematch</button>`;
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
    jb = null;
    view = null;
    snaps = [];
    clockOffset = null;
    moveKeys = 0;
    sentKeys = 0;
    lastAlive = [];
    bursts = [];
    rematchSent = false;
    goUntil = 0;
  }

  return {
    id,
    name,
    botName: "the bot",

    // There's nothing to set up, so this hands straight back: Solo starts a
    // game against the bot (level 0, its only one) and the card joins the
    // queue — no opponent picker in between.
    openSetup({ mode, onReady }) {
      onReady({}, mode === "solo" ? 0 : null);
    },

    handleState(payload, resetGameUi) {
      if (!payload[stateKey]) return false;
      const firstRender = !jb || !view || !els.gameBoard.contains(view.canvas);
      const prev = jb;
      jb = payload[stateKey];
      if (firstRender) {
        resetGameUi();
        buildView();
      }
      if (!prev || prev.round !== jb.round) {
        lastAlive = [];
        bursts = [];
      }
      if (prev?.phase === "countdown" && jb.phase === "play") goUntil = performance.now() + 600;
      if (jb.phase !== "matchover") rematchSent = false;
      renderHud();
      renderOverlay();
      return true;
    },

    resetUi() {
      els.gameBoard.classList.remove("jb-board");
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
