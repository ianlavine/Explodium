// frozen-wasm vs basic-wasm at EQUAL TIME — the real deployment question: does
// frozen's stronger eval beat the ~2x-faster basic once BOTH run in the wasm core?
// Two wasm instances (evalMode 1 = frozen, 0 = basic), mirrored deals, persistent
// per-game TT (as the live bot runs). Color convention (correct!): side 1 = RED,
// side 0 = BLUE — attribute by seat->color, not the eval-faceoff bug.
//
//   node tools/flip-triples/wasm-faceoff.js --games 100 --ms 250
import { fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeRandomDeal, genMoves, applyMove, isPhaseOver, computeWinner, mulberry32
} from "../../server/games/flip-triples/solver.js";

const __filename = fileURLToPath(import.meta.url);
const WASM = fileURLToPath(new URL("../../server/games/flip-triples/build/flip-engine-frozen.wasm", import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2), n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) a[k] = true; else { a[k] = n; i += 1; }
    }
  }
  return a;
}

function makeInstance(mode) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(WASM)), {
    env: { now: () => Date.now(), abort: () => { throw new Error("wasm abort"); } }
  });
  const w = inst.exports;
  w.setEvalMode(mode);
  return w;
}

let frozenW = null, basicW = null, ctxDone = false;
function ensureCtx(w, g) {
  w.init(g.rows, g.cols, 1, 0, -1, g.phase ?? 1, 0, 0);
}

// frozenSide = seat index played by frozen (0 = first, 1 = second).
function playOne(seed, frozenSide, timeMs) {
  const state = makeRandomDeal({}, mulberry32(seed));
  const g = state.geom;
  // fresh TT each game
  ensureCtx(frozenW, g); ensureCtx(basicW, g);
  let side = 0, plies = 0;
  while (!isPhaseOver(state)) {
    const moves = genMoves(state, side);
    if (moves.length === 0) { side = 1 - side; continue; }
    const w = side === frozenSide ? frozenW : basicW;
    for (let i = 0; i < g.cells; i += 1) w.setCell(i, state.shapes[i], state.flipped[i]);
    w.beginPosition();
    const best = w.searchRoot(side, 60, timeMs);
    applyMove(state, best);
    side = 1 - side;
    plies += 1;
  }
  const res = computeWinner(state);
  const frozenColor = frozenSide === 1 ? "red" : "blue"; // side 1 = RED
  const frozenPts = frozenSide === 1 ? res.redPoints : res.bluePoints;
  const basicPts = frozenSide === 1 ? res.bluePoints : res.redPoints;
  const outcome = res.winner === "tie" ? "tie" : res.winner === frozenColor ? "frozen" : "basic";
  return { seed, frozenSide, outcome, margin: Number((frozenPts - basicPts).toFixed(1)), plies };
}

const args = parseArgs(process.argv.slice(2));
const timeMs = Number(args.ms ?? 250);

if (args.child) {
  frozenW = makeInstance(1); basicW = makeInstance(0);
  const specs = JSON.parse(args.specs);
  const out = String(args.out);
  for (const [seed, fs2] of specs) {
    const rec = playOne(seed, fs2, timeMs);
    fs.appendFileSync(out, JSON.stringify(rec) + "\n");
    if (process.send) process.send({ done: 1 });
  }
  process.exit(0);
}

// ------------------------------------------------------------------ parent
const games = Number(args.games ?? 100);
const pairs = Math.floor(games / 2);
const seedBase = Number(args.seed ?? 500000);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const out = String(args.out ?? path.join(path.dirname(__filename), `analysis/wasm-frozen-vs-basic-${timeMs}ms.jsonl`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "");

const specs = [];
for (let p = 0; p < pairs; p += 1) { specs.push([seedBase + p, 0]); specs.push([seedBase + p, 1]); }
const total = specs.length;
console.log(`wasm faceoff [${timeMs}ms]  frozen(mode1) vs basic(mode0), ${total} games (${pairs} mirrored pairs), ${workers} workers`);

const chunks = Array.from({ length: workers }, () => []);
specs.forEach((s, i) => chunks[i % workers].push(s));
const t0 = Date.now();
let completed = 0, running = 0;
for (const chunk of chunks) {
  if (chunk.length === 0) continue;
  const child = fork(__filename, ["--child", "--specs", JSON.stringify(chunk), "--ms", String(timeMs), "--out", out]);
  running += 1;
  child.on("message", () => { completed += 1; if (completed % 10 === 0 || completed === total) console.log(`  ${completed}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); });
  child.on("exit", () => { running -= 1; if (running === 0) summarize(); });
}

function summarize() {
  const recs = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const n = recs.length;
  const tally = (rs) => {
    const f = rs.filter((r) => r.outcome === "frozen").length;
    const b = rs.filter((r) => r.outcome === "basic").length;
    const t = rs.length - f - b;
    const m = rs.reduce((a, r) => a + r.margin, 0) / Math.max(rs.length, 1);
    return { f, b, t, m, n: rs.length };
  };
  const line = (name, x) => `  ${name.padEnd(16)} frozen ${x.f}  basic ${x.b}  tie ${x.t}   (frozen ${((100 * x.f) / x.n).toFixed(0)}%, margin ${x.m >= 0 ? "+" : ""}${x.m.toFixed(2)})`;
  console.log(`\nwasm faceoff summary [${timeMs}ms] — frozen vs basic, ${n} games:`);
  console.log(line("overall", tally(recs)));
  console.log(line("frozen first", tally(recs.filter((r) => r.frozenSide === 0))));
  console.log(line("frozen second", tally(recs.filter((r) => r.frozenSide === 1))));
  console.log(`  wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
