// Depth-analysis harness for Flip Triples (4x6, unique swap, white tie-breaker).
//
//   node tools/flip-triples/analyze.js selfplay [--deals 10] [--ms 300] [--seed 1]
//     Solver-vs-solver on random deals. Reports the winner split (how fair the
//     random setup is under strong play), game length, branching factor, and
//     the ply from which the game was solved exactly within the budget.
//
//   node tools/flip-triples/analyze.js report [--json analysis/data.json] [--out analysis/report.html]
//     Renders the accumulated JSON dataset into a chart page.
//
//   node tools/flip-triples/analyze.js ladder [--deals 20] [--rungs random,10,50,250,1000] [--seed 1]
//     Skill ladder: each adjacent pair of rungs plays a match (colors swapped
//     halfway). Rungs are "random" or a per-move time budget in ms. The number
//     of rungs where the stronger agent still reliably beats the weaker one is
//     a direct measure of how much depth the game has.
//
// Deal settings mirror the game defaults: 9 red, 9 blue, 6 neutrals on 4x6,
// unique swap on. Player 0 (blue) moves first, as in the real game.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeRandomDeal,
  cloneState,
  search,
  genMoves,
  applyMove,
  isPhaseOver,
  computeWinner,
  mulberry32,
  RED,
  BLUE
} from "../../server/games/flip-triples/solver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pass --json analysis/data.json to persist results. Runs merge into the file
// (ladder pairs keyed by matchup, selfplay runs keyed by ms/deals/seed) so the
// dataset accumulates across sessions; `node tools/flip-triples/analyze.js report` renders it.
function loadData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      settings: {
        board: "4x6",
        pieces: "9 red + 9 blue + 6 neutral",
        uniqueSwap: true,
        tiebreak: "more unflipped (white) own pieces"
      },
      ladder: { rungs: [], deals: null, pairs: [] },
      selfplay: []
    };
  }
}

function saveData(file, data) {
  data.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\nsaved -> ${file}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function pickMove(state, side, agent, rand) {
  const moves = genMoves(state, side);
  if (moves.length === 0) return null;
  if (agent === "random") {
    return { move: moves[Math.floor(rand() * moves.length)], solved: false, branching: moves.length };
  }
  const r = search(state, side, { timeMs: agent });
  return { move: r.move, solved: r.solved, branching: moves.length, depth: r.depth };
}

// agents = [blueAgent, redAgent]; blue (index 0) moves first. `onMove` (if
// given) is called with (state, side, move, ply) BEFORE the move is applied,
// so the flipped piece can still be read at its origin cell.
function playGame(state, agents, rand, onMove = null) {
  let side = 0;
  let plies = 0;
  let branchSum = 0;
  let solvedFromPly = null;
  while (!isPhaseOver(state)) {
    if (genMoves(state, side).length === 0) {
      side = 1 - side;
      continue;
    }
    const picked = pickMove(state, side, agents[side], rand);
    if (onMove) onMove(state, side, picked.move, plies);
    branchSum += picked.branching;
    // solvedFromPly = first ply after which every remaining move was an exact solve.
    if (picked.solved) {
      if (solvedFromPly === null) solvedFromPly = plies;
    } else {
      solvedFromPly = null;
    }
    applyMove(state, picked.move);
    side = 1 - side;
    plies += 1;
  }
  const result = computeWinner(state);
  return {
    winner: result.winner,
    red: result.red,
    blue: result.blue,
    redPoints: result.redPoints,
    bluePoints: result.bluePoints,
    plies,
    avgBranching: branchSum / Math.max(plies, 1),
    solvedFromPly
  };
}

function pct(n, total) {
  return `${((100 * n) / total).toFixed(1)}%`;
}

function runSelfplay(args) {
  const deals = Number(args.deals ?? 10);
  const ms = Number(args.ms ?? 300);
  const seed = Number(args.seed ?? 1);
  const rand = mulberry32(seed);
  const tally = { red: 0, blue: 0, tie: 0 };
  let plySum = 0;
  let branchSum = 0;
  const solvedGaps = [];
  console.log(`selfplay: ${deals} deals, ${ms}ms/move, seed ${seed}`);
  for (let i = 0; i < deals; i += 1) {
    const state = makeRandomDeal({}, rand);
    const g = playGame(state, [ms, ms], rand);
    tally[g.winner] += 1;
    plySum += g.plies;
    branchSum += g.avgBranching;
    if (g.solvedFromPly !== null) solvedGaps.push(g.plies - g.solvedFromPly);
    console.log(
      `  deal ${String(i + 1).padStart(2)}: ${g.winner.padEnd(4)} ${g.red}-${g.blue}  plies=${g.plies}  ` +
        `avgBranch=${g.avgBranching.toFixed(1)}  solvedFromPly=${g.solvedFromPly ?? "never"}`
    );
  }
  console.log("");
  console.log(
    `winners: red(2nd) ${tally.red} (${pct(tally.red, deals)}), blue(1st) ${tally.blue} (${pct(tally.blue, deals)}), ties ${tally.tie} (${pct(tally.tie, deals)})`
  );
  console.log(`avg plies: ${(plySum / deals).toFixed(1)}, avg branching: ${(branchSum / deals).toFixed(1)}`);
  if (solvedGaps.length) {
    const avgGap = solvedGaps.reduce((a, b) => a + b, 0) / solvedGaps.length;
    console.log(
      `exactly solved for the last ${avgGap.toFixed(1)} plies on average (${solvedGaps.length}/${deals} games reached a solve)`
    );
  }

  if (args.json) {
    const data = loadData(args.json);
    const run = {
      ms,
      deals,
      seed,
      blue: tally.blue,
      red: tally.red,
      tie: tally.tie,
      avgPlies: Number((plySum / deals).toFixed(2)),
      avgBranching: Number((branchSum / deals).toFixed(2)),
      avgSolvedTailPlies: solvedGaps.length
        ? Number((solvedGaps.reduce((a, b) => a + b, 0) / solvedGaps.length).toFixed(2))
        : null,
      solvedGames: solvedGaps.length,
      date: new Date().toISOString()
    };
    const idx = data.selfplay.findIndex((r) => r.ms === ms && r.deals === deals && r.seed === seed);
    if (idx >= 0) data.selfplay[idx] = run;
    else data.selfplay.push(run);
    saveData(args.json, data);
  }
}

function agentLabel(a) {
  return a === "random" ? "random" : `${a}ms`;
}

function runLadder(args) {
  const deals = Number(args.deals ?? 20);
  const seed = Number(args.seed ?? 1);
  const rungs = (args.rungs ?? "random,10,50,250,1000")
    .split(",")
    .map((r) => (r === "random" ? "random" : Number(r)));
  console.log(
    `ladder: rungs [${rungs.map(agentLabel).join(" < ")}], ${deals} games per pair ` +
      `(mirrored deals: each deal played once per color), seed ${seed}`
  );
  console.log("");

  // Merge one pair result into the JSON file right away, so long ladders
  // publish progress incrementally instead of only at the end. With --append,
  // an existing matchup accumulates games instead of being replaced.
  const savePair = (pair) => {
    if (!args.json) return;
    const data = loadData(args.json);
    const idx = data.ladder.pairs.findIndex((p) => p.weak === pair.weak && p.strong === pair.strong);
    if (idx >= 0 && args.append !== undefined) {
      const prev = data.ladder.pairs[idx];
      data.ladder.pairs[idx] = {
        ...pair,
        games: prev.games + pair.games,
        strongWins: prev.strongWins + pair.strongWins,
        weakWins: prev.weakWins + pair.weakWins,
        ties: prev.ties + pair.ties,
        // Margin/tiebreak tracking arrived later, so older entries contribute
        // no measured games; sums accumulate only over games that measured it.
        diffGames: (prev.diffGames ?? 0) + pair.diffGames,
        diffSum: (prev.diffSum ?? 0) + pair.diffSum,
        splitGames: (prev.splitGames ?? 0) + pair.splitGames,
        tbWins: (prev.tbWins ?? 0) + pair.tbWins,
        tripleWins: (prev.tripleWins ?? 0) + pair.tripleWins,
        tbDiffSum: (prev.tbDiffSum ?? 0) + pair.tbDiffSum,
        ntbDiffSum: (prev.ntbDiffSum ?? 0) + pair.ntbDiffSum,
        seed: `${prev.seed}+${pair.seed}`
      };
    } else if (idx >= 0) data.ladder.pairs[idx] = pair;
    else data.ladder.pairs.push(pair);
    for (const rung of rungs.map(agentLabel)) {
      if (!data.ladder.rungs.includes(rung)) data.ladder.rungs.push(rung);
    }
    data.ladder.deals = deals;
    saveData(args.json, data);
  };

  for (let i = 0; i + 1 < rungs.length; i += 1) {
    const weak = rungs[i];
    const strong = rungs[i + 1];
    const rand = mulberry32(seed + i * 7919);
    const t0 = Date.now();
    let strongWins = 0;
    let weakWins = 0;
    let ties = 0;
    let diffSum = 0;
    let tbWins = 0; // decided games where triples were equal (whites decided)
    let tripleWins = 0; // decided games where triple counts differed
    let tbDiffSum = 0;
    let ntbDiffSum = 0;
    let deal = null;
    for (let g = 0; g < deals; g += 1) {
      // Even games draw a fresh deal with the stronger agent as red (moving
      // second); odd games replay the same deal with colors swapped, so both
      // agents face identical deals from both seats.
      if (g % 2 === 0) deal = makeRandomDeal({}, rand);
      const state = cloneState(deal);
      const strongIsRed = g % 2 === 0;
      const agents = strongIsRed ? [weak, strong] : [strong, weak];
      const result = playGame(state, agents, rand);
      if (result.winner === "tie") ties += 1;
      else if ((result.winner === "red") === strongIsRed) strongWins += 1;
      else weakWins += 1;
      const diff = strongIsRed
        ? result.redPoints - result.bluePoints
        : result.bluePoints - result.redPoints;
      diffSum += diff;
      if (result.winner !== "tie") {
        if (result.red === result.blue) {
          tbWins += 1;
          tbDiffSum += diff;
        } else {
          tripleWins += 1;
          ntbDiffSum += diff;
        }
      }
    }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(
      `${agentLabel(strong).padStart(7)} vs ${agentLabel(weak).padEnd(7)} -> ` +
        `stronger wins ${strongWins}/${deals} (${pct(strongWins, deals)}), loses ${weakWins}, ties ${ties}, ` +
        `avg margin ${(diffSum / deals).toFixed(2)} pts ` +
        `(tiebreak-decided ${tbWins}: avg ${(tbWins ? tbDiffSum / tbWins : 0).toFixed(2)}, ` +
        `triple-decided ${tripleWins}: avg ${(tripleWins ? ntbDiffSum / tripleWins : 0).toFixed(2)}) [${mins}min]`
    );
    savePair({
      weak: agentLabel(weak),
      strong: agentLabel(strong),
      games: deals,
      strongWins,
      weakWins,
      ties,
      diffGames: deals,
      diffSum: Number(diffSum.toFixed(3)),
      splitGames: deals,
      tbWins,
      tripleWins,
      tbDiffSum: Number(tbDiffSum.toFixed(3)),
      ntbDiffSum: Number(ntbDiffSum.toFixed(3)),
      seed,
      date: new Date().toISOString()
    });
  }
  console.log("");
  console.log("A rung 'exists' when the stronger side wins well above 50%. The");
  console.log("number of live rungs approximates the game's strategic depth.");
}

const MOVE_PHASES = ["early", "mid", "late"];
const MOVE_PIECES = ["own", "opponent", "neutral"];
const MOVE_ZONES = ["corner", "edge", "middle"];

function emptyMoveCounts() {
  const counts = {};
  for (const phase of MOVE_PHASES) {
    counts[phase] = {};
    for (const piece of MOVE_PIECES) {
      counts[phase][piece] = { corner: 0, edge: 0, middle: 0 };
    }
  }
  return counts;
}

// Move anatomy: what kind of piece gets flipped, and into which board zone,
// at each stage of the game (thirds), for a given solver strength.
//   node tools/flip-triples/analyze.js moves --deals 30 --ms 250 [--seed 1] [--json analysis/data.json]
function runMoves(args) {
  const deals = Number(args.deals ?? 30);
  const ms = Number(args.ms ?? 250);
  const seed = Number(args.seed ?? 1);
  const rand = mulberry32(seed);
  const counts = emptyMoveCounts();
  let moves = 0;
  console.log(`moves: ${deals} deals, ${ms}ms/move, seed ${seed}`);
  for (let i = 0; i < deals; i += 1) {
    const state = makeRandomDeal({}, rand);
    const rec = [];
    playGame(state, [ms, ms], rand, (s, side, m, ply) => {
      const cells = s.geom.cells;
      const from = Math.floor(m / cells);
      const to = m % cells;
      const moverShape = side === 1 ? RED : BLUE;
      const shape = s.shapes[from];
      const piece =
        shape === moverShape ? "own" : shape === RED || shape === BLUE ? "opponent" : "neutral";
      const { rows, cols } = s.geom;
      const r = Math.floor(to / cols);
      const c = to % cols;
      const onRowEdge = r === 0 || r === rows - 1;
      const onColEdge = c === 0 || c === cols - 1;
      const zone = onRowEdge && onColEdge ? "corner" : onRowEdge || onColEdge ? "edge" : "middle";
      rec.push({ piece, zone, ply });
    });
    // Classify plies into thirds once the game's true length is known.
    for (const { piece, zone, ply } of rec) {
      const phase = MOVE_PHASES[Math.min(2, Math.floor((3 * ply) / rec.length))];
      counts[phase][piece][zone] += 1;
      moves += 1;
    }
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${deals} games tracked`);
  }
  for (const phase of MOVE_PHASES) {
    const phaseTotal = MOVE_PIECES.reduce(
      (a, p) => a + MOVE_ZONES.reduce((b, z) => b + counts[phase][p][z], 0),
      0
    );
    const pieceLine = MOVE_PIECES.map(
      (p) => `${p} ${pct(MOVE_ZONES.reduce((b, z) => b + counts[phase][p][z], 0), phaseTotal)}`
    ).join(", ");
    const zoneLine = MOVE_ZONES.map(
      (z) => `${z} ${pct(MOVE_PIECES.reduce((b, p) => b + counts[phase][p][z], 0), phaseTotal)}`
    ).join(", ");
    console.log(`  ${phase.padEnd(5)} flips: ${pieceLine} | lands: ${zoneLine}`);
  }
  if (args.json) {
    const data = loadData(args.json);
    if (!Array.isArray(data.moveProfile)) data.moveProfile = [];
    const run = { ms, deals, seed, moves, counts, date: new Date().toISOString() };
    const idx = data.moveProfile.findIndex((r) => r.ms === ms && r.deals === deals && r.seed === seed);
    if (idx >= 0) data.moveProfile[idx] = run;
    else data.moveProfile.push(run);
    saveData(args.json, data);
  }
}

async function runReport(args) {
  const file = args.json ?? path.join(__dirname, "analysis/data.json");
  const out = args.out ?? path.join(__dirname, "analysis/report.html");
  const { generateReport } = await import("./report.js");
  const data = loadData(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, generateReport(data));
  console.log(`report -> ${out}`);
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] ?? "selfplay";
if (mode === "selfplay") runSelfplay(args);
else if (mode === "ladder") runLadder(args);
else if (mode === "moves") runMoves(args);
else if (mode === "report") runReport(args);
else {
  console.error(`unknown mode "${mode}" (use: selfplay | ladder | moves | report)`);
  process.exit(1);
}
