// Training-position harvester for the flip-triples value net.
//
//   node tools/flip-triples/nn/gen-positions.js --games 4000 [--ms 1000] [--workers 6]
//                       [--seed 500000] [--maxPrefix 8] [--out nn/data/positions.jsonl]
//
// Each game: a random deal, a random opening prefix of k plies (k uniform in
// [0, maxPrefix], uniform-random legal moves — position diversity comes from
// here, so the strong-play continuation that produces the labels stays
// blunder-free), then full-strength search at --ms per move to the end.
//
// One JSONL record per strong-play position (prefix positions are skipped:
// their continuations contain random moves, which would corrupt the
// game-outcome label):
//   seed, ply   game seed / ply at which the position occurred
//   k           random-prefix length for this game
//   board       24 chars, reading order; R/B/N = white (unflipped) red/blue/
//               neutral, r/b/n = flipped
//   side        player to move (0 = blue, 1 = red)
//   z           final margin of the game, RED perspective (triples = 1,
//               whites = 0.1) — the outcome label for unsolved positions
//   solved      true if the search exactly solved the remainder here
//   sv          exact margin (red perspective) when solved — overrides z
//   depth       completed search depth
//   ms          per-move search budget
import { fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { search } from "../../../server/games/flip-triples/engine.js";
import {
  makeRandomDeal,
  genMoves,
  applyMove,
  isPhaseOver,
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

const WHITE_CHAR = ["R", "B", "N"];
const FLIP_CHAR = ["r", "b", "n"];

function boardString(state) {
  let s = "";
  for (let i = 0; i < state.geom.cells; i += 1) {
    s += (state.flipped[i] ? FLIP_CHAR : WHITE_CHAR)[state.shapes[i]] ?? "?";
  }
  return s;
}

// Engine values are diff * 100000 + tb * 10 when exact; convert to the points
// margin (triples + 0.1 * whites, red perspective) used as the training scale.
function valueToMargin(v) {
  const diff = Math.round(v / 100000);
  const tb = Math.round((v - diff * 100000) / 10);
  return Number((diff + 0.1 * tb).toFixed(1));
}

function playOne(seed, ms, maxPrefix) {
  const rand = mulberry32(seed);
  const state = makeRandomDeal({}, rand);
  const k = Math.floor(rand() * (maxPrefix + 1));
  let side = 0;
  let plies = 0;

  // Random opening prefix: diversity without corrupting later labels.
  while (plies < k && !isPhaseOver(state)) {
    const moves = genMoves(state, side);
    if (moves.length === 0) {
      side = 1 - side;
      continue;
    }
    applyMove(state, moves[Math.floor(rand() * moves.length)]);
    side = 1 - side;
    plies += 1;
  }

  // Strong play to the end; record every position the searcher faced.
  const records = [];
  while (!isPhaseOver(state)) {
    if (genMoves(state, side).length === 0) {
      side = 1 - side;
      continue;
    }
    const r = search(state, side, { timeMs: ms });
    records.push({
      seed,
      ply: plies,
      k,
      board: boardString(state),
      side,
      solved: r.solved,
      sv: r.solved ? valueToMargin(r.value) : null,
      depth: r.depth,
      ms
    });
    applyMove(state, r.move);
    side = 1 - side;
    plies += 1;
  }

  const res = computeWinner(state);
  const z = Number((res.redPoints - res.bluePoints).toFixed(1));
  for (const rec of records) rec.z = z;
  return records;
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.child) {
  const [lo, hi] = String(args.seeds).split("-").map(Number);
  const ms = Number(args.ms);
  const maxPrefix = Number(args.maxPrefix);
  const out = String(args.out);
  for (let seed = lo; seed < hi; seed += 1) {
    const records = playOne(seed, ms, maxPrefix);
    fs.appendFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (process.send) process.send({ done: seed, positions: records.length });
  }
  process.exit(0);
}

const games = Number(args.games ?? 100);
const ms = Number(args.ms ?? 1000);
const maxPrefix = Number(args.maxPrefix ?? 8);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const seedBase = Number(args.seed ?? 500000);
const out = String(args.out ?? path.join(__dirname, "data/positions.jsonl"));
fs.mkdirSync(path.dirname(out), { recursive: true });

console.log(
  `gen-positions: ${games} games at ${ms}ms/move (prefix 0-${maxPrefix}) on ${workers} workers, seeds ${seedBase}..${seedBase + games - 1} -> ${out}`
);
const t0 = Date.now();
const per = Math.ceil(games / workers);
let running = 0;
let completed = 0;
let positions = 0;
for (let w = 0; w < workers; w += 1) {
  const lo = seedBase + w * per;
  const hi = Math.min(seedBase + games, lo + per);
  if (lo >= hi) continue;
  const child = fork(__filename, [
    "--child",
    "--seeds",
    `${lo}-${hi}`,
    "--ms",
    String(ms),
    "--maxPrefix",
    String(maxPrefix),
    "--out",
    out
  ]);
  running += 1;
  child.on("message", (msg) => {
    completed += 1;
    positions += msg.positions;
    if (completed % 25 === 0 || completed === games) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(
        `  ${completed}/${games} games, ${positions} positions (${mins} min, ~${((Date.now() - t0) / completed / 1000).toFixed(1)}s/game)`
      );
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
  const solved = mine.filter((r) => r.solved).length;
  const plyHist = {};
  for (const r of mine) plyHist[r.ply] = (plyHist[r.ply] ?? 0) + 1;
  const uniq = new Set(mine.map((r) => r.board + r.side)).size;
  console.log("");
  console.log(`batch summary: ${n} positions from ${games} games (${(n / games).toFixed(1)}/game)`);
  console.log(`  exactly solved: ${solved} (${((100 * solved) / n).toFixed(1)}%), unique (board,side): ${uniq}`);
  console.log(
    `  ply coverage: ${Object.keys(plyHist)
      .sort((a, b) => a - b)
      .map((p) => `${p}:${plyHist[p]}`)
      .join(" ")}`
  );
  console.log(`  total wall time ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
