// Jabble's sounds, all made on the spot with Web Audio — there are no files to
// fetch. A handful of voices cover every bump in the game: each takes how hard
// the hit was (0..1) and where across the arena it happened (-1 left .. 1
// right), so a glancing tap off the far wall and a full-power kick beside you
// come out as different sounds from the same code.
//
// Browsers only let a page make sound after the player has pressed something,
// so nothing is created until wake() is called from a key or click.

const MUTE_KEY = "jabble-muted";
const VOLUME = 0.55;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function createSounds() {
  let ctx = null;
  let master = null;
  let noise = null; // a second of white noise, shared by every hissing voice
  let muted = loadMuted();
  const lastPlayed = new Map(); // voice -> ctx time, so a rattle can't machine-gun

  function wake() {
    if (!ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      ctx = new Context();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      // A soft limiter: a pile-up of hits gets squeezed rather than clipping.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      master.connect(limiter).connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  const audible = () => ctx && ctx.state === "running" && !muted;

  // At most one of `voice` every `gapMs`.
  function allowed(voice, gapMs) {
    const t = ctx.currentTime;
    if (t - (lastPlayed.get(voice) ?? -1) < gapMs / 1000) return false;
    lastPlayed.set(voice, t);
    return true;
  }

  function output(pan) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1) * 0.7;
    panner.connect(master);
    return panner;
  }

  // A gain that leaps to `peak` and dies away exponentially over `dur`.
  function envelope(at, peak, dur, attack = 0.004) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + dur);
    return gain;
  }

  // A pitched blip sliding from `from` Hz to `to` Hz.
  function tone({ type = "sine", from, to = from, dur, gain, pan = 0, delay = 0 }) {
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
    osc.connect(envelope(at, gain, dur)).connect(output(pan));
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  // A burst of noise through a filter whose centre slides from `from` to `to`.
  function hiss({ filter = "bandpass", from, to = from, q = 1, dur, gain, pan = 0, delay = 0 }) {
    const at = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const shape = ctx.createBiquadFilter();
    shape.type = filter;
    shape.Q.value = q;
    shape.frequency.setValueAtTime(from, at);
    shape.frequency.exponentialRampToValueAtTime(Math.max(30, to), at + dur);
    src.connect(shape).connect(envelope(at, gain, dur)).connect(output(pan));
    src.start(at, Math.random() * 0.5);
    src.stop(at + dur + 0.05);
  }

  return {
    wake,

    get muted() {
      return muted;
    },

    toggleMute() {
      muted = !muted;
      try {
        localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
      } catch {
        // stays muted (or not) for this visit only
      }
      if (master) master.gain.value = muted ? 0 : VOLUME;
      return muted;
    },

    // A jab connecting with your own ball: a slap, a thump, a snap.
    kick(power, pan) {
      if (!audible()) return;
      hiss({ from: 2200, to: 700, q: 0.8, dur: 0.09, gain: 0.5 * power, pan });
      tone({ from: 170, to: 55, dur: 0.15, gain: 0.75 * power, pan });
      tone({ type: "triangle", from: 640, to: 300, dur: 0.05, gain: 0.18 * power, pan });
    },

    // A jab connecting with a player: the kick's bigger, nastier cousin.
    knock(pan) {
      if (!audible()) return;
      hiss({ from: 1600, to: 260, q: 0.9, dur: 0.18, gain: 0.7, pan });
      tone({ from: 130, to: 38, dur: 0.28, gain: 0.95, pan });
      tone({ type: "square", from: 340, to: 90, dur: 0.12, gain: 0.12, pan });
    },

    // A ball off a wall: a hollow knock, higher and louder the harder it hit.
    wall(power, pan, ball) {
      if (!audible() || !allowed(`wall${ball}`, 45)) return;
      const pitch = 260 + 460 * power;
      tone({ type: "triangle", from: pitch, to: pitch * 0.65, dur: 0.08, gain: 0.08 + 0.32 * power, pan });
      hiss({ filter: "highpass", from: 3500, dur: 0.03, gain: 0.14 * power, pan });
    },

    // Two balls cracking together.
    clack(power, pan) {
      if (!audible() || !allowed("clack", 35)) return;
      tone({ type: "square", from: 950 + 450 * power, to: 720, dur: 0.04, gain: 0.1 + 0.16 * power, pan });
      tone({ type: "triangle", from: 1500, to: 1150, dur: 0.06, gain: 0.12 * power, pan });
      hiss({ filter: "highpass", from: 4200, dur: 0.025, gain: 0.18 * power, pan });
    },

    // A ball off someone's body: soft and dull.
    body(power, pan) {
      if (!audible() || !allowed("body", 60)) return;
      tone({ from: 210, to: 110, dur: 0.09, gain: 0.28 * power, pan });
      hiss({ filter: "lowpass", from: 700, dur: 0.06, gain: 0.16 * power, pan });
    },

    // A knocked-flying player hitting a wall.
    slam(power, pan) {
      if (!audible() || !allowed("slam", 80)) return;
      tone({ from: 95, to: 42, dur: 0.22, gain: 0.75 * power, pan });
      hiss({ filter: "lowpass", from: 1100, to: 220, dur: 0.2, gain: 0.45 * power, pan });
    },

    // An arm thrown: a swish, quieter when it isn't yours.
    jab(pan, mine) {
      if (!audible()) return;
      hiss({ from: 450, to: 2400, q: 2.2, dur: 0.1, gain: mine ? 0.17 : 0.08, pan });
    },

    // Someone's out: a crack, a falling roar, a sub-bass drop, a zap, and a
    // few late crackles of debris.
    death(pan) {
      if (!audible()) return;
      hiss({ from: 3200, to: 900, q: 1, dur: 0.12, gain: 0.6, pan });
      hiss({ filter: "lowpass", from: 5000, to: 140, dur: 0.75, gain: 0.95, pan });
      tone({ from: 130, to: 26, dur: 0.65, gain: 1, pan });
      tone({ type: "sawtooth", from: 760, to: 55, dur: 0.38, gain: 0.16, pan });
      for (let i = 0; i < 5; i += 1) {
        hiss({ filter: "highpass", from: 2500 + Math.random() * 2500, dur: 0.03, gain: 0.2, pan, delay: 0.08 + Math.random() * 0.35 });
      }
    },

    // Round start and "Go!".
    ready() {
      if (!audible()) return;
      tone({ type: "triangle", from: 440, dur: 0.14, gain: 0.22 });
    },

    go() {
      if (!audible()) return;
      tone({ type: "triangle", from: 880, dur: 0.12, gain: 0.25 });
      tone({ type: "triangle", from: 1320, dur: 0.18, gain: 0.2, delay: 0.07 });
    },

    // A point: rising if it's yours, falling if it isn't, flat for a trade.
    // It waits a beat, so the death that won it is heard first.
    point(good) {
      if (!audible()) return;
      const notes = good === null ? [392, 392] : good ? [523, 659, 784] : [392, 311, 233];
      notes.forEach((f, i) => tone({ type: "triangle", from: f, dur: 0.12, gain: 0.22, delay: 0.35 + 0.1 * i }));
    },

    // The match: a fanfare or a slump.
    fanfare(won) {
      if (!audible()) return;
      const notes = won ? [523, 659, 784, 1047, 1319] : [392, 330, 262, 196];
      notes.forEach((f, i) =>
        tone({ type: won ? "square" : "triangle", from: f, dur: won ? 0.16 : 0.24, gain: won ? 0.1 : 0.2, delay: (won ? 0.11 : 0.18) * i })
      );
    }
  };
}
