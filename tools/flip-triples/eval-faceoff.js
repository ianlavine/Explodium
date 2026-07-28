// Head-to-head between two NAMED heuristics (see
// server/games/flip-triples/heuristics.js). Same engine, same search — only the
// leaf eval differs, swapped per move via setHeuristic().
//
//   node tools/flip-triples/eval-faceoff.js --a classic --b frozen --games 50 --mode time --ms 250
//   node tools/flip-triples/eval-faceoff.js --a classic --b frozen --games 50 --mode depth --depth 6
//
// Endgames are solved exactly by the search, so every winner is certain. Seat
// advantage is large under strong play, so deals are MIRRORED: each seed is
// played twice, once with B moving first and once moving second (--games N =>
// N/2 seeds x 2 seats). Results are reported from B's perspective, split by seat.
//
// A fair A/B needs each search to start from a clean transposition table (else
// the cheaper eval banks exact solves the other reads); we clearTT() before
// every move by default (--sharedTT to disable).
import { fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  search,
  setHeuristic,
  clearTT,
  makeRandomDeal,
  genMoves,
  applyMove,
  isPhaseOver,
  computeWinner,
  mulberry32
} from "../../server/games/flip-triples/solver.js";
import { HEURISTICS, describe } from "../../server/games/flip-triples/heuristics.js";

const __filename = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

// Play one game. bSide is the mover index (0 = first, 1 = second) using
// heuristic B; the other side uses A. Result is from B's perspective.
function playOne(seed, bSide, aW, bW, mode, param, freshTT) {
  const state = makeRandomDeal({}, mulberry32(seed));
  const rng = mulberry32(seed ^ 0x5bd1e995); // deterministic stream for random movers
  let side = 0;
  let plies = 0;
  let solvedFromPly = null;
  while (!isPhaseOver(state)) {
    const moves = genMoves(state, side);
    if (moves.length === 0) {
      side = 1 - side;
      continue;
    }
    const moverW = side === bSide ? bW : aW;
    if (moverW === RANDOM) {
      applyMove(state, moves[Math.floor(rng() * moves.length)]);
      side = 1 - side;
      plies += 1;
      continue;
    }
    setHeuristic(moverW);
    if (freshTT) clearTT();
    const opts = mode === "depth" ? { timeMs: 3600000, maxDepth: param } : { timeMs: param };
    const r = search(state, side, opts);
    if (r.solved && solvedFromPly === null) solvedFromPly = plies;
    applyMove(state, r.move);
    side = 1 - side;
    plies += 1;
  }
  const res = computeWinner(state);
  // Player-index convention (solver.js redSign / search): side 0 = BLUE, side 1 = RED.
  // (This is the OPPOSITE of the shape codes RED=0/BLUE=1 — an easy trap.)
  const bColor = bSide === 0 ? "blue" : "red";
  const bPts = bSide === 0 ? res.bluePoints : res.redPoints;
  const aPts = bSide === 0 ? res.redPoints : res.bluePoints;
  const outcome = res.winner === "tie" ? "tie" : res.winner === bColor ? "b" : "a";
  return { seed, bSide, outcome, margin: Number((bPts - aPts).toFixed(1)), plies, solvedFromPly };
}

// Sentinel for the special name "random": a side that plays a uniformly random
// legal move (no search, no exact endgame solve) — the weakest possible player,
// used to sanity-check the harness (a real eval must beat it ~always).
const RANDOM = "__random__";
const resolve = (name) => (name === "random" ? RANDOM : HEURISTICS[name]);
const describeName = (name, w) => (name === "random" ? "uniform random moves" : describe(w));

const args = parseArgs(process.argv.slice(2));
const aName = String(args.a ?? "classic");
const bName = String(args.b ?? "frozen");
const aW = resolve(aName);
const bW = resolve(bName);
if (!aW || !bW) {
  console.error(`unknown heuristic. available: random, ${Object.keys(HEURISTICS).join(", ")}`);
  process.exit(1);
}
const mode = String(args.mode ?? "time");
const param = mode === "depth" ? Number(args.depth ?? 6) : Number(args.ms ?? 250);
const freshTT = !args.sharedTT;

if (args.child) {
  const specs = JSON.parse(args.specs); // [[seed,bSide],...]
  const out = String(args.out);
  for (const [seed, bSide] of specs) {
    const rec = playOne(seed, bSide, aW, bW, mode, param, freshTT);
    fs.appendFileSync(out, JSON.stringify({ ...rec, mode, param, aName, bName }) + "\n");
    if (process.send) process.send({ done: 1 });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
const games = Number(args.games ?? 50);
const pairs = Math.floor(games / 2);
const seedBase = Number(args.seed ?? 300000);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const tag = mode === "depth" ? `depth${param}` : `time${param}ms`;
const out = String(args.out ?? path.join(path.dirname(__filename), `analysis/faceoff-${aName}-vs-${bName}-${tag}.jsonl`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "");

const specs = [];
for (let p = 0; p < pairs; p += 1) {
  specs.push([seedBase + p, 0]);
  specs.push([seedBase + p, 1]);
}
const total = specs.length;
console.log(`faceoff [${tag}]  A=${aName} (${describeName(aName, aW)})  vs  B=${bName} (${describeName(bName, bW)})`);
console.log(`  ${total} games (${pairs} mirrored pairs) on ${workers} workers -> ${out}`);

const chunks = Array.from({ length: workers }, () => []);
specs.forEach((s, i) => chunks[i % workers].push(s));

const t0 = Date.now();
let completed = 0;
let running = 0;
for (const chunk of chunks) {
  if (chunk.length === 0) continue;
  const child = fork(__filename, [
    "--child",
    "--specs",
    JSON.stringify(chunk),
    "--a",
    aName,
    "--b",
    bName,
    "--mode",
    mode,
    mode === "depth" ? "--depth" : "--ms",
    String(param),
    ...(args.sharedTT ? ["--sharedTT"] : []),
    "--out",
    out
  ]);
  running += 1;
  child.on("message", () => {
    completed += 1;
    if (completed % 10 === 0 || completed === total) {
      console.log(`  ${completed}/${total} games (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  });
  child.on("exit", () => {
    running -= 1;
    if (running === 0) summarize();
  });
}

function summarize() {
  const recs = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const n = recs.length;
  const tally = (rs) => {
    const bw = rs.filter((r) => r.outcome === "b").length;
    const aw = rs.filter((r) => r.outcome === "a").length;
    const t = rs.length - bw - aw;
    const m = rs.reduce((a, r) => a + r.margin, 0) / Math.max(rs.length, 1);
    return { bw, aw, t, m, n: rs.length };
  };
  const all = tally(recs);
  const first = tally(recs.filter((r) => r.bSide === 0));
  const second = tally(recs.filter((r) => r.bSide === 1));
  const solved = recs.filter((r) => r.solvedFromPly !== null);
  const avgSolve = solved.reduce((a, r) => a + r.solvedFromPly, 0) / Math.max(solved.length, 1);
  const line = (name, x) =>
    `  ${name.padEnd(16)} ${bName} ${x.bw}  ${aName} ${x.aw}  tie ${x.t}   (${bName} win ${((100 * x.bw) / x.n).toFixed(0)}%, margin ${x.m >= 0 ? "+" : ""}${x.m.toFixed(2)})`;
  console.log(`\nfaceoff summary [${tag}] — B=${bName} vs A=${aName}, ${n} games:`);
  console.log(line("overall", all));
  console.log(line(`${bName} first`, first));
  console.log(line(`${bName} second`, second));
  console.log(
    `  exact-solved from ply ${avgSolve.toFixed(1)} on avg (${solved.length}/${n}); wall ${((Date.now() - t0) / 1000).toFixed(0)}s`
  );
}
