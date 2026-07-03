// Depth-analysis harness for Flip Triples (4x6, unique swap, white tie-breaker).
//
//   node analyze.js selfplay [--deals 10] [--ms 300] [--seed 1]
//     Solver-vs-solver on random deals. Reports the winner split (how fair the
//     random setup is under strong play), game length, branching factor, and
//     the ply from which the game was solved exactly within the budget.
//
//   node analyze.js ladder [--deals 20] [--rungs random,10,50,250,1000] [--seed 1]
//     Skill ladder: each adjacent pair of rungs plays a match (colors swapped
//     halfway). Rungs are "random" or a per-move time budget in ms. The number
//     of rungs where the stronger agent still reliably beats the weaker one is
//     a direct measure of how much depth the game has.
//
// Deal settings mirror the game defaults: 9 red, 9 blue, 6 neutrals on 4x6,
// unique swap on. Player 0 (blue) moves first, as in the real game.

import {
  makeRandomDeal,
  search,
  genMoves,
  applyMove,
  isPhaseOver,
  computeWinner,
  mulberry32
} from "./flip-solver.js";

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

// agents = [blueAgent, redAgent]; blue (index 0) moves first.
function playGame(state, agents, rand) {
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
  console.log(`ladder: rungs [${rungs.map(agentLabel).join(" < ")}], ${deals} games per pair, seed ${seed}`);
  console.log("");
  for (let i = 0; i + 1 < rungs.length; i += 1) {
    const weak = rungs[i];
    const strong = rungs[i + 1];
    const rand = mulberry32(seed + i * 7919);
    let strongWins = 0;
    let weakWins = 0;
    let ties = 0;
    for (let g = 0; g < deals; g += 1) {
      const state = makeRandomDeal({}, rand);
      // Swap colors halfway so first-move/color advantage cancels out.
      const strongIsRed = g % 2 === 0;
      const agents = strongIsRed ? [weak, strong] : [strong, weak];
      const result = playGame(state, agents, rand);
      if (result.winner === "tie") ties += 1;
      else if ((result.winner === "red") === strongIsRed) strongWins += 1;
      else weakWins += 1;
    }
    console.log(
      `${agentLabel(strong).padStart(7)} vs ${agentLabel(weak).padEnd(7)} -> ` +
        `stronger wins ${strongWins}/${deals} (${pct(strongWins, deals)}), loses ${weakWins}, ties ${ties}`
    );
  }
  console.log("");
  console.log("A rung 'exists' when the stronger side wins well above 50%. The");
  console.log("number of live rungs approximates the game's strategic depth.");
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] ?? "selfplay";
if (mode === "selfplay") runSelfplay(args);
else if (mode === "ladder") runLadder(args);
else {
  console.error(`unknown mode "${mode}" (use: selfplay | ladder)`);
  process.exit(1);
}
