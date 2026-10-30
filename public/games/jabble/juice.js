// Jabble's visual juice: particles, screen shake, a full-screen flash,
// hit-stop, marks left on the floor, ball trails, and the little squash and
// pop timers that make things look like they hit something. It's all
// cosmetic and lives only in the browser — nothing here touches the match.
//
// Everything is in arena units; the renderer calls update() once a frame and
// drawFloor() / drawTrails() / drawTop() at the right moments in its paint.

const MAX_PARTICLES = 700;
const SKATE_FADE_S = 3;
const TRAIL_MS = 110;
const TAU = Math.PI * 2;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

export function createJuice({ reducedMotion = false } = {}) {
  let particles = [];
  let decals = []; // scorch marks for the round
  let skates = []; // ice marks: { x1, y1, x2, y2, born }
  const skateFrom = new Map(); // seat -> last mark point
  const trails = new Map(); // ball index -> [{ x, y, t }]
  const squashes = new Map(); // "b2" -> { nx, ny, amount, t0 }
  const pops = new Map(); // "p1" -> { kind, t0 }
  let shake = 0;
  let flash = { color: "255, 255, 255", alpha: 0 };
  let freezeUntil = 0;
  let clock = 0; // seconds of unfrozen time, for spinning things

  function add(p) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    particles.push({ age: 0, drag: 3, ...p });
  }

  // A spray of short bright streaks, mostly along (nx, ny) within `spread`.
  function sparks(x, y, nx, ny, count, color, speed = 500, spread = 1.1) {
    const base = Math.atan2(ny, nx);
    for (let i = 0; i < count; i += 1) {
      const a = base + rand(-spread, spread);
      const v = speed * rand(0.4, 1.2);
      add({ kind: "spark", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.18, 0.4), color, width: rand(1.5, 3), drag: 6 });
    }
  }

  function ring(x, y, color, r0, r1, life, width = 4) {
    add({ kind: "ring", x, y, vx: 0, vy: 0, r0, r1, life, color, width });
  }

  function puff(x, y, color, count, size, speed = 90) {
    for (let i = 0; i < count; i += 1) {
      const a = rand(0, TAU);
      const v = rand(0.3, 1) * speed;
      add({ kind: "dust", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r0: size * 0.4, r1: size * rand(1, 1.6), life: rand(0.35, 0.6), color, alpha: 0.45 });
    }
  }

  function glow(x, y, color, r0, r1, life) {
    add({ kind: "dust", x, y, vx: 0, vy: 0, r0, r1, life, color, alpha: 0.9 });
  }

  return {
    // --- the big moments ---------------------------------------------------

    // A player is out. Their square bursts into spinning shards flung the way
    // the killing blow was going (or every way, if nothing was moving), with
    // shockwaves, sparks and a scorch left on the floor — and, when it's the
    // kill that wins the match (`ko`), a big "KO!".
    death(x, y, colors, size, dir, { ko = false } = {}) {
      const shards = 22;
      for (let i = 0; i < shards; i += 1) {
        let a = rand(0, TAU);
        let v = rand(220, 760);
        if (dir) {
          // Two thirds of the pieces go with the blow, the rest scatter.
          if (i % 3) a = Math.atan2(dir.y, dir.x) + rand(-0.9, 0.9);
          v *= i % 3 ? 1.3 : 0.7;
        }
        add({
          kind: "shard",
          x: x + rand(-size / 3, size / 3),
          y: y + rand(-size / 3, size / 3),
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: rand(0.8, 1.4),
          color: i % 4 ? colors.body : colors.light,
          size: rand(size * 0.12, size * 0.32),
          rot: rand(0, TAU),
          spin: rand(-14, 14),
          drag: 2.6
        });
      }
      sparks(x, y, dir?.x ?? 1, dir?.y ?? 0, 28, "255, 255, 255", 900, dir ? 1.4 : Math.PI);
      sparks(x, y, 1, 0, 16, "255, 225, 170", 600, Math.PI); // warm embers, every way
      glow(x, y, "255, 255, 255", size * 0.6, size * 2.2, 0.22);
      ring(x, y, "255, 255, 255", size * 0.5, size * 3.4, 0.45, 7);
      ring(x, y, colors.rgb, size * 0.4, size * 5, 0.75, 4);
      puff(x, y, "40, 44, 52", 10, size * 0.9, 160);
      if (ko) add({ kind: "text", x, y: y - size, vx: 0, vy: -60, life: 1.3, text: "KO!", color: colors.body, drag: 2 });
      decals.push({
        x,
        y,
        r: size * 1.3,
        color: colors.rgb,
        dots: Array.from({ length: 14 }, () => {
          const a = rand(0, TAU);
          const d = rand(size * 0.4, size * 2.2);
          return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: rand(2, size * 0.18) };
        })
      });
    },

    // A jab landing on a player.
    knock(x, y, dx, dy, colors) {
      glow(x, y, "255, 255, 255", 10, 46, 0.16);
      ring(x, y, "255, 255, 255", 12, 70, 0.3, 5);
      sparks(x, y, dx, dy, 18, "255, 255, 255", 800, 0.8);
      sparks(x, y, -dx, -dy, 8, colors.rgb, 350, 1.2);
    },

    // A jab connecting with a ball.
    kick(x, y, dx, dy, colors, power) {
      glow(x, y, "255, 255, 255", 6, 26 + 14 * power, 0.12);
      ring(x, y, colors.rgb, 8, 40 + 30 * power, 0.25, 3);
      sparks(x, y, dx, dy, Math.round(8 + 10 * power), "255, 255, 255", 450 + 500 * power, 0.55);
    },

    // A ball off a wall, hard enough to hear.
    wall(x, y, nx, ny, colors, power) {
      sparks(x, y, nx, ny, Math.round(3 + 10 * power), colors.rgb, 250 + 450 * power, 1.2);
      if (power > 0.45) ring(x, y, colors.rgb, 4, 22 + 26 * power, 0.22, 2.5);
    },

    // Two balls cracking together.
    clack(x, y, colorsA, colorsB, power) {
      glow(x, y, "255, 255, 255", 4, 16 + 16 * power, 0.1);
      sparks(x, y, 0, -1, Math.round(4 + 6 * power), colorsA.rgb, 300 + 300 * power, Math.PI);
      sparks(x, y, 0, 1, Math.round(4 + 6 * power), colorsB.rgb, 300 + 300 * power, Math.PI);
    },

    // A ball off someone's body.
    body(x, y, colors, power) {
      puff(x, y, colors.rgb, 3 + Math.round(3 * power), 8, 60);
    },

    // A knocked-flying player smacking into a wall.
    slam(x, y, power) {
      puff(x, y, "200, 210, 220", 8, 14 + 10 * power, 140);
      ring(x, y, "255, 255, 255", 6, 40, 0.25, 3);
    },

    // --- screen-wide -------------------------------------------------------

    shake(amount) {
      if (!reducedMotion) shake = Math.min(26, Math.max(shake, amount));
    },

    flash(color, alpha) {
      flash = { color, alpha: reducedMotion ? alpha * 0.3 : alpha };
    },

    // Hold the picture still for a beat.
    freeze(ms, now) {
      if (!reducedMotion) freezeUntil = Math.max(freezeUntil, now + ms);
    },

    frozen(now) {
      return now < freezeUntil;
    },

    // This frame's camera jolt, in arena units.
    shakeOffset() {
      return shake < 0.2 ? { x: 0, y: 0 } : { x: rand(-shake, shake), y: rand(-shake, shake) };
    },

    flashStyle() {
      return flash.alpha > 0.01 ? `rgba(${flash.color}, ${flash.alpha})` : null;
    },

    // --- per-object timers --------------------------------------------------

    // Squash a ball flat against (nx, ny), springing back over ~150 ms.
    squash(ball, nx, ny, amount, now) {
      const len = Math.hypot(nx, ny) || 1;
      squashes.set(`b${ball}`, { nx: nx / len, ny: ny / len, amount: Math.min(0.45, amount), t0: now });
    },

    squashOf(ball, now) {
      const s = squashes.get(`b${ball}`);
      if (!s) return null;
      const k = (now - s.t0) / 150;
      if (k >= 1) {
        squashes.delete(`b${ball}`);
        return null;
      }
      return { nx: s.nx, ny: s.ny, amount: s.amount * (1 - k) * (1 - k) };
    },

    // "kick": the square swells for a moment; "hit": it flashes white.
    pop(seat, kind, now) {
      pops.set(`p${seat}`, { kind, t0: now });
    },

    popOf(seat, now) {
      const p = pops.get(`p${seat}`);
      if (!p) return { scale: 1, white: 0 };
      const k = (now - p.t0) / (p.kind === "hit" ? 180 : 120);
      if (k >= 1) {
        pops.delete(`p${seat}`);
        return { scale: 1, white: 0 };
      }
      return p.kind === "hit" ? { scale: 1 + 0.1 * (1 - k), white: 0.85 * (1 - k) } : { scale: 1 + 0.16 * (1 - k) * (1 - k), white: 0 };
    },

    // --- marks and trails --------------------------------------------------

    // Remember where a ball was drawn, for its trail.
    trackBall(ball, x, y, now) {
      const points = trails.get(ball) ?? [];
      points.push({ x, y, t: now });
      while (points.length && now - points[0].t > TRAIL_MS) points.shift();
      trails.set(ball, points);
    },

    // A blade line on the ice behind a moving player.
    skate(seat, x, y, now) {
      const from = skateFrom.get(seat);
      if (from && Math.hypot(x - from.x, y - from.y) < 9) return;
      if (from && Math.hypot(x - from.x, y - from.y) < 60) skates.push({ x1: from.x, y1: from.y, x2: x, y2: y, born: now });
      skateFrom.set(seat, { x, y });
      if (skates.length > 500) skates.shift();
    },

    // A new round: wipe the floor and the trails.
    clearRound() {
      decals = [];
      skates = [];
      skateFrom.clear();
      trails.clear();
      squashes.clear();
      pops.clear();
    },

    // --- the frame -----------------------------------------------------------

    update(dtMs, now) {
      const dt = Math.min(0.05, dtMs / 1000);
      shake *= Math.exp(-dt / 0.09);
      flash.alpha *= Math.exp(-dt / 0.12);
      if (now < freezeUntil) return;
      clock += dt;
      particles = particles.filter((p) => {
        p.age += dt;
        if (p.age >= p.life) return false;
        const keep = Math.exp(-p.drag * dt);
        p.vx *= keep;
        p.vy *= keep;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.spin) p.rot += p.spin * dt;
        return true;
      });
      skates = skates.filter((s) => now - s.born < SKATE_FADE_S * 1000);
    },

    // Under everything that moves: scorch marks and skate lines.
    drawFloor(ctx, now) {
      skates.forEach((s) => {
        const fade = 1 - (now - s.born) / (SKATE_FADE_S * 1000);
        ctx.strokeStyle = `rgba(95, 135, 165, ${0.28 * fade})`;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
      });
      decals.forEach((d) => {
        const scorch = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
        scorch.addColorStop(0, "rgba(15, 15, 20, 0.45)");
        scorch.addColorStop(1, "rgba(15, 15, 20, 0)");
        ctx.fillStyle = scorch;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(${d.color}, 0.55)`;
        d.dots.forEach((dot) => {
          ctx.beginPath();
          ctx.arc(d.x + dot.x, d.y + dot.y, dot.r, 0, TAU);
          ctx.fill();
        });
      });
    },

    // A ball's recent path as a tapering streak, stronger the faster it went.
    drawTrails(ctx, ballColors, radius) {
      trails.forEach((points, ball) => {
        if (points.length < 2) return;
        const a = points[0];
        const b = points[points.length - 1];
        const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, b.t - a.t); // units per ms
        const strength = Math.min(1, Math.max(0, (speed - 0.25) / 1.2));
        if (strength <= 0) return;
        const color = ballColors(ball);
        for (let i = 1; i < points.length; i += 1) {
          const k = i / points.length;
          ctx.strokeStyle = `rgba(${color}, ${0.45 * strength * k})`;
          ctx.lineWidth = Math.max(1, radius * 1.6 * k);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(points[i - 1].x, points[i - 1].y);
          ctx.lineTo(points[i].x, points[i].y);
          ctx.stroke();
        }
      });
    },

    // Over everything: the particles.
    drawTop(ctx) {
      particles.forEach((p) => {
        const k = p.age / p.life;
        if (p.kind === "spark") {
          ctx.strokeStyle = `rgba(${p.color}, ${1 - k})`;
          ctx.lineWidth = p.width;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
          ctx.stroke();
        } else if (p.kind === "shard") {
          ctx.save();
          ctx.globalAlpha = k < 0.6 ? 1 : (1 - k) / 0.4;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
          ctx.lineWidth = 1;
          ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        } else if (p.kind === "ring") {
          const ease = 1 - (1 - k) * (1 - k);
          ctx.strokeStyle = `rgba(${p.color}, ${1 - k})`;
          ctx.lineWidth = Math.max(0.5, p.width * (1 - k));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r0 + (p.r1 - p.r0) * ease, 0, TAU);
          ctx.stroke();
        } else if (p.kind === "dust") {
          ctx.fillStyle = `rgba(${p.color}, ${p.alpha * (1 - k)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r0 + (p.r1 - p.r0) * k, 0, TAU);
          ctx.fill();
        } else if (p.kind === "text") {
          const grow = k < 0.15 ? 0.6 + (k / 0.15) * 0.6 : 1.2 - 0.2 * Math.min(1, (k - 0.15) / 0.3);
          ctx.save();
          ctx.globalAlpha = k < 0.6 ? 1 : (1 - k) / 0.4;
          ctx.translate(p.x, p.y);
          ctx.scale(grow, grow);
          ctx.rotate(Math.sin(clock * 9) * 0.05);
          ctx.font = "700 46px 'Space Grotesk', system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 7;
          ctx.strokeStyle = p.color;
          ctx.strokeText(p.text, 0, 0);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(p.text, 0, 0);
          ctx.restore();
        }
      });
    }
  };
}
