// Batch near-perfect game runner for setup-luck analysis.
//
//   node tools/flip-triples/solve-games.js --games 500 [--ms 5000] [--workers 6] [--seed 1000]
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
import { search } from "../../server/games/flip-triples/engine.js";
import {
  makeRandomDeal,
  genMoves,
  applyMove,
  isPhaseOver,
  computeWinner,
  mulberry32,
  RED,
  BLUE
} from "../../server/games/flip-triples/solver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// firstSide: which player index moves first (0 = blue, the rulebook default;
// 1 = red, for pie-rule / color-choice analysis on the same deals).
function playOne(seed, ms, firstSide = 0) {
  const state = makeRandomDeal({}, mulberry32(seed));
  const setup = setupString(state);
  let side = firstSide;
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
      // red-perspective -> first-player perspective
      solvedValue = firstSide === 1 ? r.value : -r.value;
    }
    applyMove(state, r.move);
    side = 1 - side;
    plies += 1;
  }
  const res = computeWinner(state);
  const firstPts = firstSide === 1 ? res.redPoints : res.bluePoints;
  const secondPts = firstSide === 1 ? res.bluePoints : res.redPoints;
  const firstColor = firstSide === 1 ? "red" : "blue";
  return {
    seed,
    setup,
    first: firstSide,
    winner: res.winner === "tie" ? "tie" : res.winner === firstColor ? "first" : "second",
    diff: Number((firstPts - secondPts).toFixed(1)),
    firstPoints: Number(firstPts.toFixed(1)),
    secondPoints: Number(secondPts.toFixed(1)),
    plies,
    solvedFromPly,
    solvedValue,
    ms
  };
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.child) {
  // Child mode: play the given seed range (or explicit comma-joined list),
  // append results, report via IPC.
  const seedList = args.seedList
    ? String(args.seedList).split(",").map(Number)
    : (() => {
        const [lo, hi] = String(args.seeds).split("-").map(Number);
        return Array.from({ length: hi - lo }, (_, i) => lo + i);
      })();
  const ms = Number(args.ms);
  const firstSide = Number(args.first ?? 0);
  const out = String(args.out);
  for (const seed of seedList) {
    const rec = playOne(seed, ms, firstSide);
    fs.appendFileSync(out, JSON.stringify(rec) + "\n");
    if (process.send) process.send({ done: seed });
  }
  process.exit(0);
}

// --seedFile <path>: JSON array of explicit seeds to play (e.g. to mirror an
// existing run's exact deals); overrides --games/--seed range mode.
const explicitSeeds = args.seedFile ? JSON.parse(fs.readFileSync(String(args.seedFile), "utf8")) : null;
const games = explicitSeeds ? explicitSeeds.length : Number(args.games ?? 100);
const ms = Number(args.ms ?? 5000);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const seedBase = Number(args.seed ?? 100000);
const out = String(args.out ?? path.join(__dirname, "analysis/solved-games.jsonl"));
fs.mkdirSync(path.dirname(out), { recursive: true });

console.log(
  `solve-games: ${games} games at ${ms}ms/move on ${workers} workers, seeds ${
    explicitSeeds ? `from ${args.seedFile}` : `${seedBase}..${seedBase + games - 1}`
  } -> ${out}`
);
const t0 = Date.now();
const per = Math.ceil(games / workers);
let running = 0;
let completed = 0;
for (let w = 0; w < workers; w += 1) {
  const lo = seedBase + w * per;
  const hi = Math.min(seedBase + games, lo + per);
  if (!explicitSeeds && lo >= hi) continue;
  const chunk = explicitSeeds ? explicitSeeds.slice(w * per, (w + 1) * per) : null;
  if (explicitSeeds && chunk.length === 0) continue;
  const child = fork(__filename, [
    "--child",
    ...(explicitSeeds ? ["--seedList", chunk.join(",")] : ["--seeds", `${lo}-${hi}`]),
    "--ms",
    String(ms),
    "--first",
    String(args.first ?? 0),
    "--out",
    out
  ]);
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
  const seedSet = explicitSeeds ? new Set(explicitSeeds) : null;
  const mine = lines.filter(
    (r) => (seedSet ? seedSet.has(r.seed) : r.seed >= seedBase && r.seed < seedBase + games) && r.ms === ms
  );
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
