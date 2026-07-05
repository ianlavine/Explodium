// Batch near-perfect game runner for setup-luck analysis.
//
//   node solve-games.js --games 500 [--ms 5000] [--workers 6] [--seed 1000]
//                       [--out analysis/solved-games.jsonl]
//
// Each game: a random deal played by the full-strength solver on BOTH sides
// (no blunders) at --ms per move. The engine reports when its search has
// exactly solved the remainder, so every game record carries:
//   seed, setup (24-char board string, reading order: R/B/N),
//   winner (first/second/tie), diff (first-player points minus second's;
//   triple = 1, white = 0.1), plies, solvedFromPly (rest of game provably
//   perfect from here), solvedValue (exact value at that ply, first-player
//   perspective), ms.
// Games run across worker processes (one deal per process at a time) and
// append JSONL lines to --out; rerun with a different --seed to grow the set.
import { fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { search } from "./flip-engine.js";
import {
  makeRandomDeal,
  genMoves,
  applyMove,
  isPhaseOver,
  computeWinner,
  mulberry32,
  RED,
  BLUE
} from "./flip-solver.js";

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

const SETUP_CHAR = ["R", "B", "N", "P", "H", "b", "B2"];

function setupString(state) {
  let s = "";
  for (let i = 0; i < state.geom.cells; i += 1) s += SETUP_CHAR[state.shapes[i]] ?? "?";
  return s;
}

function playOne(seed, ms) {
  const state = makeRandomDeal({}, mulberry32(seed));
  const setup = setupString(state);
  let side = 0;
  let plies = 0;
  let solvedFromPly = null;
  let solvedValue = null;
  while (!isPhaseOver(state)) {
    if (genMoves(state, side).length === 0) {
      side = 1 - side;
      continue;
    }
    const r = search(state, side, { timeMs: ms });
    if (r.solved && solvedFromPly === null) {
      solvedFromPly = plies;
      solvedValue = -r.value; // red-perspective -> first-player (blue) perspective
    }
    applyMove(state, r.move);
    side = 1 - side;
    plies += 1;
  }
  const res = computeWinner(state);
  const diff = Number((res.bluePoints - res.redPoints).toFixed(1)); // first minus second
  return {
    seed,
    setup,
    winner: res.winner === "blue" ? "first" : res.winner === "red" ? "second" : "tie",
    diff,
    firstPoints: Number(res.bluePoints.toFixed(1)),
    secondPoints: Number(res.redPoints.toFixed(1)),
    plies,
    solvedFromPly,
    solvedValue,
    ms
  };
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.child) {
  // Child mode: play the given seed range, append results, report via IPC.
  const [lo, hi] = String(args.seeds).split("-").map(Number);
  const ms = Number(args.ms);
  const out = String(args.out);
  for (let seed = lo; seed < hi; seed += 1) {
    const rec = playOne(seed, ms);
    fs.appendFileSync(out, JSON.stringify(rec) + "\n");
    if (process.send) process.send({ done: seed });
  }
  process.exit(0);
}

const games = Number(args.games ?? 100);
const ms = Number(args.ms ?? 5000);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const seedBase = Number(args.seed ?? 100000);
const out = String(args.out ?? "analysis/solved-games.jsonl");
fs.mkdirSync(path.dirname(out), { recursive: true });

console.log(
  `solve-games: ${games} games at ${ms}ms/move on ${workers} workers, seeds ${seedBase}..${seedBase + games - 1} -> ${out}`
);
const t0 = Date.now();
const per = Math.ceil(games / workers);
let running = 0;
let completed = 0;
for (let w = 0; w < workers; w += 1) {
  const lo = seedBase + w * per;
  const hi = Math.min(seedBase + games, lo + per);
  if (lo >= hi) continue;
  const child = fork(__filename, ["--child", "--seeds", `${lo}-${hi}`, "--ms", String(ms), "--out", out]);
  running += 1;
  child.on("message", () => {
    completed += 1;
    if (completed % 25 === 0 || completed === games) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  ${completed}/${games} games (${mins} min, ~${((Date.now() - t0) / completed / 1000).toFixed(0)}s/game overall)`);
    }
  });
  child.on("exit", () => {
    running -= 1;
    if (running === 0) summarize();
  });
}

function summarize() {
  const lines = fs
    .readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const mine = lines.filter((r) => r.seed >= seedBase && r.seed < seedBase + games && r.ms === ms);
  const n = mine.length;
  const first = mine.filter((r) => r.winner === "first").length;
  const second = mine.filter((r) => r.winner === "second").length;
  const ties = n - first - second;
  const diffs = mine.map((r) => r.diff);
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const varc = diffs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const absMean = diffs.reduce((a, b) => a + Math.abs(b), 0) / n;
  const solved = mine.filter((r) => r.solvedFromPly !== null);
  const avgSolveTail =
    solved.reduce((a, r) => a + (r.plies - r.solvedFromPly), 0) / Math.max(solved.length, 1);
  const agree = solved.filter((r) => {
    const sign = r.solvedValue > 0 ? "first" : r.solvedValue < 0 ? "second" : "tie";
    return sign === r.winner;
  }).length;
  console.log("");
  console.log(`batch summary (${n} games, ${ms}ms/move):`);
  console.log(`  first ${first} (${((100 * first) / n).toFixed(1)}%), second ${second} (${((100 * second) / n).toFixed(1)}%), ties ${ties}`);
  console.log(`  diff (first minus second): mean ${mean.toFixed(2)}, sd ${Math.sqrt(varc).toFixed(2)}, mean|diff| ${absMean.toFixed(2)} pts`);
  console.log(`  provably perfect for the last ${avgSolveTail.toFixed(1)} plies on average (${solved.length}/${n} reached a solve)`);
  console.log(`  solved-value sign matched final result in ${agree}/${solved.length} (should be ~all; play after solving is optimal)`);
  console.log(`  total wall time ${(Date.now() - t0) / 60000 | 0} min`);
}
