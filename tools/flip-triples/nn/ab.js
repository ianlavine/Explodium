// Net-vs-hand-eval A/B match runner.
//
//   node tools/flip-triples/nn/ab.js --deals 100 [--ms 250] [--weights weights.json]
//                       [--workers 6] [--seed 700000]
//
// Each deal is played twice with seats swapped (mirrored pairs). Both agents
// run the SAME JS engine (solver.js search; the wasm core is never used since
// its eval is baked in) at the same per-move budget — the only difference is
// the leaf eval, toggled via setEvalNet(true/false) before every search.
// Play is blunder-free, so a mirrored pair is fully deterministic given the
// deal; all variance comes from deals. The persistent TT is shared between
// agents within a game, which is sound: only exact (solved) values cross
// searches, and those are eval-independent.
//
// Gate (from the plan): net scores >55% of points at n >= 200 games.
import { fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  search,
  setEvalNet,
  makeRandomDeal,
  genMoves,
  isPhaseOver,
  applyMove,
  computeWinner,
  mulberry32
} from "../../../server/games/flip-triples/solver.js";

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

// netSide: player index (0 = first/blue, 1 = second/red) played by the net.
// depth > 0 switches to equal-fixed-depth mode (speed-neutral eval-quality
// diagnostic; per the parity lesson, both agents always search the SAME depth).
function playGame(seed, netSide, ms, depth) {
  const state = makeRandomDeal({}, mulberry32(seed));
  let side = 0;
  while (!isPhaseOver(state)) {
    if (genMoves(state, side).length === 0) {
      side = 1 - side;
      continue;
    }
    setEvalNet(side === netSide);
    const r = depth > 0
      ? search(state, side, { timeMs: 600000, maxDepth: depth })
      : search(state, side, { timeMs: ms });
    applyMove(state, r.move);
    side = 1 - side;
  }
  const res = computeWinner(state);
  const netPoints = netSide === 1 ? res.redPoints : res.bluePoints;
  const oppPoints = netSide === 1 ? res.bluePoints : res.redPoints;
  return {
    seed,
    netSide,
    margin: Number((netPoints - oppPoints).toFixed(1)),
    winner: res.winner === "tie" ? "tie" : (res.winner === "red") === (netSide === 1) ? "net" : "hand"
  };
}

const args = parseArgs(process.argv.slice(2));

if (args.child) {
  const [lo, hi] = String(args.seeds).split("-").map(Number);
  const ms = Number(args.ms);
  const depth = Number(args.depth ?? 0);
  setEvalNet(JSON.parse(fs.readFileSync(String(args.weights), "utf8")));
  for (let seed = lo; seed < hi; seed += 1) {
    for (const netSide of [0, 1]) {
      const rec = playGame(seed, netSide, ms, depth);
      if (process.send) process.send(rec);
    }
  }
  process.exit(0);
}

const deals = Number(args.deals ?? 100);
const ms = Number(args.ms ?? 250);
const depth = Number(args.depth ?? 0);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const seedBase = Number(args.seed ?? 700000);
const weightsPath = String(args.weights ?? path.join(__dirname, "weights.json"));

console.log(
  `ab: ${deals} mirrored deals (${deals * 2} games) at ${depth > 0 ? `fixed depth ${depth}` : `${ms}ms/move`}, net=${weightsPath}, seeds ${seedBase}.., ${workers} workers`
);
const t0 = Date.now();
const per = Math.ceil(deals / workers);
let running = 0;
const results = [];
for (let w = 0; w < workers; w += 1) {
  const lo = seedBase + w * per;
  const hi = Math.min(seedBase + deals, lo + per);
  if (lo >= hi) continue;
  const child = fork(__filename, [
    "--child",
    "--seeds",
    `${lo}-${hi}`,
    "--ms",
    String(ms),
    "--depth",
    String(depth),
    "--weights",
    weightsPath
  ]);
  running += 1;
  child.on("message", (rec) => {
    results.push(rec);
    if (results.length % 20 === 0) {
      const netW = results.filter((r) => r.winner === "net").length;
      const handW = results.filter((r) => r.winner === "hand").length;
      console.log(
        `  ${results.length}/${deals * 2} games: net ${netW}, hand ${handW}, ties ${results.length - netW - handW} (${((Date.now() - t0) / 60000).toFixed(1)} min)`
      );
    }
  });
  child.on("exit", () => {
    running -= 1;
    if (running === 0) summarize();
  });
}

function summarize() {
  const n = results.length;
  const netW = results.filter((r) => r.winner === "net").length;
  const handW = results.filter((r) => r.winner === "hand").length;
  const ties = n - netW - handW;
  const score = (netW + ties / 2) / n;
  const margins = results.map((r) => r.margin);
  const mean = margins.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(margins.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  // Score SE treating each mirrored PAIR as the independent unit.
  const pairs = new Map();
  for (const r of results) {
    const p = pairs.get(r.seed) ?? [];
    p.push(r.winner === "net" ? 1 : r.winner === "tie" ? 0.5 : 0);
    pairs.set(r.seed, p);
  }
  const pairScores = [...pairs.values()].map((p) => p.reduce((a, b) => a + b, 0) / p.length);
  const pMean = pairScores.reduce((a, b) => a + b, 0) / pairScores.length;
  const pSe = Math.sqrt(
    pairScores.reduce((a, b) => a + (b - pMean) * (b - pMean), 0) / pairScores.length / pairScores.length
  );
  const bySeat = (s) => {
    const g = results.filter((r) => r.netSide === s);
    return `${g.filter((r) => r.winner === "net").length}W-${g.filter((r) => r.winner === "hand").length}L-${g.filter((r) => r.winner === "tie").length}T`;
  };
  console.log("");
  console.log(`A/B result (${n} games, ${ms}ms/move):`);
  console.log(`  net ${netW}, hand ${handW}, ties ${ties} -> net score ${(100 * score).toFixed(1)}% ± ${(100 * 1.96 * pSe).toFixed(1)}pp (95% CI)`);
  console.log(`  net avg margin ${mean.toFixed(2)} ± ${((1.96 * sd) / Math.sqrt(n)).toFixed(2)} pts`);
  console.log(`  net as first: ${bySeat(0)}, as second: ${bySeat(1)}`);
  console.log(`  wall time ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
