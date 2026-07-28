// Self-play telemetry for the current strongest bot (a single named heuristic,
// default `basic`) playing itself at EQUAL time on both sides. One game per
// random deal; no seat mirroring, because the whole point is to measure the
// ROLE asymmetry created by the color-pick pre-game:
//
//   Player one (the "chooser") looks at the deal, picks a color, and then moves
//   SECOND. Player two (the "first-mover") gets the opening move but no choice.
//
// We model a competent chooser: it runs a fixed shallow search (--pickDepth,
// default 6) for each color option and keeps whichever leaves it better off,
// then the game is played out at the real time control. (The LIVE bot currently
// picks its color at RANDOM — game.js finalizeColorPick — so this also measures
// the ceiling that random pick is leaving on the table.)
//
// Per game we log: who won by role, the color the chooser took and by how much,
// the opening moves (first 3 by each player: was the LOCKED piece own/opp/
// neutral, and where did it land), and end-of-game center control.
//
//   node tools/flip-triples/selfplay-lab.js --bot basic --games 100 --ms 250
//
// Endgames are solved exactly, so every non-tie winner is certain.
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
const CELLS = 24;
const COLS = 4; // board is 6 rows x 4 cols
const RED = 0; // SHAPE codes (shapes[] array): red-x=0, blue-o=1, neutral=2
const BLUE = 1;
const NEUTRAL = 2;
// PLAYER/side convention (solver.js redSign + search comment): side 1 = RED,
// side 0 = BLUE — the OPPOSITE of the shape codes. sideShape/sideName map a side
// index to the color it actually plays.
const sideShape = (side) => (side === 1 ? RED : BLUE);
const sideName = (side) => (side === 1 ? "red" : "blue");
// The 4 geometric-center cells (rows 2-3, cols 1-2).
const CENTER = [2 * COLS + 1, 2 * COLS + 2, 3 * COLS + 1, 3 * COLS + 2];

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

// The chooser moves SECOND and picks which side (color) to be; firstMover =
// 1 - chooser moves first. search().value is RED-perspective. If the chooser
// takes side 1 (RED), firstMover = side 0 moves first => chooser value =
// +search(state, 0).value. If it takes side 0 (BLUE), firstMover = side 1 moves
// first => chooser value = -search(state, 1).value. The pick uses a fixed
// bounded budget (pickMs): the opening is far from terminal, so more time does
// not resolve the color, and a per-move budget would just waste wall time.
// Exact ties (the common case — the eval can't tell the colors apart) break
// RANDOMLY so neither seat is structurally favored. Returns the chooser SIDE,
// the margin over the alternative, and whether the pick was decisive (nonzero).
function pickColor(state, pickMs, w, rng) {
  setHeuristic(w);
  clearTT();
  const vChooserRed = search(state, 0, { timeMs: pickMs }).value; // chooser=side1(RED), side0 to move
  clearTT();
  const vChooserBlue = -search(state, 1, { timeMs: pickMs }).value; // chooser=side0(BLUE), side1 to move
  let chooser;
  if (vChooserRed > vChooserBlue) chooser = 1;
  else if (vChooserBlue > vChooserRed) chooser = 0;
  else chooser = rng() < 0.5 ? 1 : 0; // indistinguishable -> coin flip
  return {
    chooser,
    pickMargin: Number((Math.abs(vChooserRed - vChooserBlue)).toFixed(2)),
    pickDecisive: vChooserRed !== vChooserBlue
  };
}

function lockedCategory(lockedShape, moverColor) {
  if (lockedShape === NEUTRAL) return "neutral";
  return lockedShape === moverColor ? "own" : "opp";
}

// Play one game. Returns a full telemetry record.
function playOne(seed, w, mode, param, pickMs) {
  const rng = mulberry32(seed ^ 0x9e3779b9); // independent stream for tie-breaks
  const state = makeRandomDeal({}, mulberry32(seed));
  clearTT();
  const { chooser, pickMargin, pickDecisive } = pickColor(state, pickMs, w, rng);
  const firstMover = 1 - chooser; // the OTHER side moves first
  clearTT();

  let side = firstMover;
  let plies = 0;
  const roleMoveCount = { [firstMover]: 0, [chooser]: 0 };
  const opening = []; // {role, color, moveNum, lockedCat, dest}

  while (!isPhaseOver(state)) {
    if (genMoves(state, side).length === 0) {
      side = 1 - side;
      continue;
    }
    setHeuristic(w);
    const opts = mode === "depth" ? { timeMs: 3600000, maxDepth: param } : { timeMs: param };
    const r = search(state, side, opts);
    const a = Math.floor(r.move / CELLS); // first piece: the one that locks
    const b = r.move % CELLS; // destination it slides to (and locks at)
    const lockedShape = state.shapes[a];
    const moveNum = roleMoveCount[side] + 1;
    if (moveNum <= 3) {
      opening.push({
        role: side === firstMover ? "first" : "chooser",
        color: sideName(side),
        moveNum,
        lockedCat: lockedCategory(lockedShape, sideShape(side)),
        dest: b
      });
    }
    roleMoveCount[side] += 1;
    applyMove(state, r.move);
    side = 1 - side;
    plies += 1;
  }

  const res = computeWinner(state);
  const winner = res.winner; // 'red' | 'blue' | 'tie'
  const chooserColor = sideName(chooser);
  const firstColor = sideName(firstMover);
  // Center control at game end, per color.
  let centerRed = 0;
  let centerBlue = 0;
  for (const c of CENTER) {
    if (state.shapes[c] === RED) centerRed += 1;
    else if (state.shapes[c] === BLUE) centerBlue += 1;
  }
  const winnerColor = winner === "tie" ? null : winner;
  const centerWinner = winnerColor === "red" ? centerRed : winnerColor === "blue" ? centerBlue : null;
  const chooserPts = chooserColor === "red" ? res.redPoints : res.bluePoints;
  const firstPts = chooserColor === "red" ? res.bluePoints : res.redPoints;

  return {
    seed,
    chooserColor,
    firstColor,
    pickMargin,
    pickDecisive,
    winner,
    winnerRole: winner === "tie" ? "tie" : winner === chooserColor ? "chooser" : "first",
    margin: Number((chooserPts - firstPts).toFixed(1)), // + => chooser ahead
    plies,
    centerRed,
    centerBlue,
    centerWinner,
    centerChooser: chooserColor === "red" ? centerRed : centerBlue,
    opening
  };
}

const args = parseArgs(process.argv.slice(2));
const botName = String(args.bot ?? "basic");
const w = HEURISTICS[botName];
if (!w) {
  console.error(`unknown heuristic '${botName}'. available: ${Object.keys(HEURISTICS).join(", ")}`);
  process.exit(1);
}
const mode = String(args.mode ?? "time");
const param = mode === "depth" ? Number(args.depth ?? 6) : Number(args.ms ?? 250);
const pickMs = Number(args.pickMs ?? 250); // bounded budget for the color pick

if (args.child) {
  const seeds = JSON.parse(args.seeds);
  const out = String(args.out);
  for (const seed of seeds) {
    const rec = playOne(seed, w, mode, param, pickMs);
    fs.appendFileSync(out, JSON.stringify(rec) + "\n");
    if (process.send) process.send({ done: 1 });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
const games = Number(args.games ?? 100);
const seedBase = Number(args.seed ?? 700000);
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 2));
const tag = mode === "depth" ? `depth${param}` : `time${param}ms`;
const out = String(args.out ?? path.join(path.dirname(__filename), `analysis/selfplay-${botName}-${tag}.jsonl`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "");

const seeds = Array.from({ length: games }, (_, i) => seedBase + i);
console.log(`selfplay [${tag}]  bot=${botName} (${describe(w)}), pickMs=${pickMs}`);
console.log(`  ${games} games on ${workers} workers -> ${out}`);

const chunks = Array.from({ length: workers }, () => []);
seeds.forEach((s, i) => chunks[i % workers].push(s));

const t0 = Date.now();
let completed = 0;
let running = 0;
for (const chunk of chunks) {
  if (chunk.length === 0) continue;
  const child = fork(__filename, [
    "--child",
    "--seeds",
    JSON.stringify(chunk),
    "--bot",
    botName,
    "--mode",
    mode,
    mode === "depth" ? "--depth" : "--ms",
    String(param),
    "--pickMs",
    String(pickMs),
    "--out",
    out
  ]);
  running += 1;
  child.on("message", () => {
    completed += 1;
    if (completed % 10 === 0 || completed === games) {
      console.log(`  ${completed}/${games} games (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  });
  child.on("exit", () => {
    running -= 1;
    if (running === 0) summarize();
  });
}

function pct(n, d) {
  return `${((100 * n) / Math.max(d, 1)).toFixed(0)}%`;
}

function summarize() {
  const recs = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const n = recs.length;

  // --- 1. Role win rates (chooser/2nd vs first-mover) ---------------------
  const chooserWins = recs.filter((r) => r.winnerRole === "chooser").length;
  const firstWins = recs.filter((r) => r.winnerRole === "first").length;
  const ties = recs.filter((r) => r.winnerRole === "tie").length;
  const avgMargin = recs.reduce((a, r) => a + r.margin, 0) / n; // chooser-perspective

  // --- color-pick behavior ---
  const pickedRed = recs.filter((r) => r.chooserColor === "red").length;
  const decisive = recs.filter((r) => r.pickDecisive);
  const decChooserWins = decisive.filter((r) => r.winnerRole === "chooser").length;
  const decFirstWins = decisive.filter((r) => r.winnerRole === "first").length;

  console.log(`\n================ selfplay summary [${tag}] — ${botName}, ${n} games ================`);
  console.log(`\n[1] ROLE WIN RATES  (chooser = picks color, moves 2nd;  first = opening move)`);
  console.log(`    chooser (2nd) ${chooserWins}  (${pct(chooserWins, n)})   first (1st) ${firstWins}  (${pct(firstWins, n)})   tie ${ties}  (${pct(ties, n)})`);
  console.log(`    avg margin (chooser - first): ${avgMargin >= 0 ? "+" : ""}${avgMargin.toFixed(2)} pts`);
  console.log(`    chooser took red ${pct(pickedRed, n)} / blue ${pct(n - pickedRed, n)}  (should be ~50/50 since the pick rarely decides)`);
  console.log(`    color pick was DECISIVE (eval could tell colors apart) in ${decisive.length}/${n} (${pct(decisive.length, n)})`);
  if (decisive.length) {
    console.log(`      among those: chooser ${pct(decChooserWins, decisive.length)}  first ${pct(decFirstWins, decisive.length)}  (did picking the better color rescue the 2nd-mover?)`);
  }

  // --- 2. Opening move breakdown -----------------------------------------
  console.log(`\n[2] OPENING MOVES  (first 3 moves by each role: what shape got LOCKED)`);
  for (const role of ["first", "chooser"]) {
    console.log(`  ${role === "first" ? "first-mover (1st)" : "chooser (2nd)   "}:`);
    for (let mv = 1; mv <= 3; mv += 1) {
      const moves = recs.flatMap((r) => r.opening.filter((o) => o.role === role && o.moveNum === mv));
      const d = moves.length;
      const own = moves.filter((o) => o.lockedCat === "own").length;
      const opp = moves.filter((o) => o.lockedCat === "opp").length;
      const neu = moves.filter((o) => o.lockedCat === "neutral").length;
      const inCenter = moves.filter((o) => CENTER.includes(o.dest)).length;
      console.log(`     move ${mv}:  own ${pct(own, d)}   opp ${pct(opp, d)}   neutral ${pct(neu, d)}    |  locked into center ${pct(inCenter, d)}`);
    }
  }

  // Lock-destination heatmap for the very first move of each role (6x4 grid).
  for (const role of ["first", "chooser"]) {
    const dests = recs.flatMap((r) => r.opening.filter((o) => o.role === role && o.moveNum === 1).map((o) => o.dest));
    const grid = new Array(CELLS).fill(0);
    for (const d of dests) grid[d] += 1;
    console.log(`\n  lock-destination heatmap, ${role} move 1 (${dests.length} moves; * = center):`);
    for (let r = 0; r < 6; r += 1) {
      let row = "     ";
      for (let c = 0; c < COLS; c += 1) {
        const idx = r * COLS + c;
        const mark = CENTER.includes(idx) ? "*" : " ";
        row += `${String(grid[idx]).padStart(3)}${mark} `;
      }
      console.log(row);
    }
  }

  // --- 3. Center control vs winning --------------------------------------
  console.log(`\n[3] CENTER CONTROL vs WINNING  (of the 4 center cells, how many the WINNER owns)`);
  const decided = recs.filter((r) => r.centerWinner !== null);
  const dist = [0, 0, 0, 0, 0];
  for (const r of decided) dist[r.centerWinner] += 1;
  const avgWinnerCenter = decided.reduce((a, r) => a + r.centerWinner, 0) / Math.max(decided.length, 1);
  // baseline: average center cells of a random color = 9 pieces / 24 cells * 4
  const baseline = (9 / 24) * 4;
  console.log(`    distribution of winner's center cells (0..4):  ${dist.map((c, i) => `${i}:${c}`).join("  ")}`);
  console.log(`    avg center cells owned by WINNER: ${avgWinnerCenter.toFixed(2)}  (random-color baseline ${baseline.toFixed(2)})`);
  const winnerMajority = decided.filter((r) => r.centerWinner >= 3).length;
  console.log(`    winner owns >=3 of 4 center cells in ${pct(winnerMajority, decided.length)} of decided games`);
  // Loser's center count for the same decided games (center cells also hold neutrals).
  const avgLoserCenter =
    decided.reduce((a, r) => a + (r.winner === "red" ? r.centerBlue : r.centerRed), 0) / Math.max(decided.length, 1);
  console.log(`    avg center cells owned by LOSER: ${avgLoserCenter.toFixed(2)}  (rest are neutral)  ->  winner edge +${(avgWinnerCenter - avgLoserCenter).toFixed(2)}`);

  console.log(`\n  wall ${((Date.now() - t0) / 1000).toFixed(0)}s, avg ${(recs.reduce((a, r) => a + r.plies, 0) / n).toFixed(1)} plies/game`);
}
