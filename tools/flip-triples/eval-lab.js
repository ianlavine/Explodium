// ===========================================================================
// Flip Triples — EVALUATION LAB
// ===========================================================================
//
// A sandbox for the ONE thing that gives the bot its "taste": the heuristic it
// uses to score a non-final position. Everything else (search, alpha-beta, TT)
// just looks ahead — this file is what a leaf of that lookahead is worth.
//
// Use it to:
//   1. SEE the current heuristic, term by term, on any board.
//   2. TWEAK the weights and watch the score (and the chosen move) change.
//   3. ADD brand-new "things worth points" — write a compute() and give it a
//      weight. Templates are provided at the bottom.
//
// Run:
//   node tools/flip-triples/eval-lab.js                 # random deal, breakdown
//   node tools/flip-triples/eval-lab.js 12345           # a specific deal (seed)
//   node tools/flip-triples/eval-lab.js 12345 --move 4  # + best move at depth 4
//   node tools/flip-triples/eval-lab.js --check         # verify vs the engine
//
// ---------------------------------------------------------------------------
// HOW THE REAL BOT SCORES A LEAF  (staticEval in solver.js, RED's perspective:
// positive = good for red, the side with index 0)
//
//     value =  lockedTripleDiff * 2000     // banked, unmovable 3-in-a-rows
//            + softTripleDiff    *  250     // any current 3-in-a-row (still movable)
//            + whiteDiff         *   10     // your unflipped pieces (the tiebreak)
//            + tempo                        // small side-to-move nudge (default 0)
//
//   Every "*Diff" is (red count − blue count). A GAME-OVER position instead
//   uses the exact rule: tripleDiff*100000 + tiebreak*10 (triples dominate;
//   whites/center only break ties). The weights above only steer the guesswork
//   at unfinished leaves.
//
// The live engine reads EVAL_LOCKED / EVAL_SOFT / EVAL_WHITE / EVAL_TEMPO from
// the environment, so you can A/B the FOUR EXISTING weights in real play with
// no code change, e.g.:
//     EVAL_WHITE=100 node server/... (whatever launches the bot)
// NEW features you invent here are NOT in the engine's hot path; to promote one,
// port its compute() into staticEval() in solver.js. This lab lets you feel it
// first (breakdown + a shallow search that actually uses your weights).
// ===========================================================================

import { fileURLToPath } from "url";
import {
  makeRandomDeal,
  cloneState,
  genMoves,
  applyMove,
  undoMove,
  decodeMove,
  isPhaseOver,
  isActive,
  countTriples,
  countLockedTriples,
  whiteDiffGeneric,
  lineMatchesTarget,
  tripleValue,
  isColorOrWild,
  // Frozen-piece features live in the engine (single source of truth) so the
  // face-off bot and this lab score identically. Their derivation is documented
  // just below; the code is in solver.js.
  computePermanentMask,
  countPermanentTriples,
  countCompletionSpaces,
  mulberry32,
  RED,
  BLUE,
  NEUTRAL,
  PURPLE,
  YELLOW
} from "../../server/games/flip-triples/solver.js";

// ===========================================================================
// PERMANENCE  — the algorithm behind the `permanentTriples` feature.
// ===========================================================================
//
// The engine's `lockedTriples` only trusts the flip FLAG: a triple counts as
// banked once all three pieces are locked (black). But a WHITE piece can also
// be truly frozen, and this catches that case.
//
// Movement rule (default game): a piece moves ONLY by swapping with a piece
// that is (a) an 8-way neighbour, (b) also movable (white/active), and (c) a
// DIFFERENT shape. Same-shape pieces can't swap with each other; locked pieces
// can't swap at all.
//
// So consider a maximal blob of same-shape movable pieces, connected 8-way:
//   * If NO member touches a movable piece of a different shape anywhere on its
//     border, nothing can ever swap into or out of the blob — every piece in it
//     is frozen forever.
//   * If even ONE member touches a different-shape movable piece, that piece can
//     migrate through the connected blob and free every member in turn, so NONE
//     of them are permanent.
// A lone piece with no same-shape neighbours is just a blob of size 1.
//
//   cellPermanent(i) = piece is locked  OR  its movable blob is sealed.
//
// "movable" here means isActive() (unflipped in phase 1, flipped in phase 2) so
// this lines up with the engine's own locked/active bookkeeping.
//
//   computePermanentMask(state) -> Uint8Array (1 = frozen forever)
//   countPermanentTriples(state, target[, mask]) -> permanent triples for a colour
//
// ===========================================================================
// COMPLETION SPACES — the algorithm behind the `completionSpaces` feature.
// ===========================================================================
//
// Idea (yours): a soft triple that isn't permanent is fragile — e.g. two locked
// X's plus one white X. The white X will likely be swapped away (only a non-X
// piece can swap with it), so that "triple" probably won't survive. What's
// actually worth points is a THREAT to lock a triple in.
//
// A completion space for X is a cell C where, in a SINGLE move, X can slide a
// white X into C and lock it there to make a triple:
//   1. C is non-black   (movable — otherwise nothing can be swapped into it)
//   2. C is non-X       (doesn't already count as X for a triple)
//   3. locking an X at C would complete an X line whose other two cells are
//      BOTH PERMANENT — so the completed triple is itself permanent (can't be
//      broken). Geometrically: two permanent X cells adjacent with C at the end,
//      or two permanent X cells straddling C.
//   4. a white X sits next to C  (the piece that slides in and locks)
//
// Multiplicity: if locking an X at C completes 2+ lines at once, it counts that
// many times. (The filler is always external to the line — the line's other two
// cells are permanent/frozen while the filler is movable.)
//
//   countCompletionSpaces(state, target) -> completion-space count for a colour
//
// (Standard pieces / default swap rule. One-move threats only.)  All three
// functions are implemented in solver.js and imported above.

// ===========================================================================
// THE KNOBS.  Edit these freely.
// ===========================================================================
//
// Each feature is { name, weight, note, compute(state) -> red_minus_blue }.
// The board score is simply  Σ  weight * compute(state)   (+ the tempo term,
// which is handled specially because it depends on whose turn it is).
//
// `compute` MUST return a single number = (something about red) − (same about
// blue). Positive helps red. Set a weight to 0 to switch a feature off.

export const FEATURES = [
  {
    name: "lockedTriples",
    weight: 2000,
    note: "3-in-a-rows that can no longer be broken this phase. The real currency.",
    compute: (s) => countLockedTriples(s, RED) - countLockedTriples(s, BLUE) + s.carryDiff
  },
  {
    name: "softTriples",
    weight: 250,
    note: "Any current 3-in-a-row, even if a piece in it can still move away.",
    compute: (s) => countTriples(s, RED) - countTriples(s, BLUE)
  },
  {
    name: "whitePieces",
    weight: 10,
    note: "Your own unflipped pieces — the tie-breaker when triples are equal.",
    compute: (s) => whiteDiffGeneric(s)
  },
  {
    name: "permanentTriples",
    weight: 0, // off by default so the current eval is unchanged; give it a weight to test
    note:
      "Like lockedTriples, but also counts triples frozen by sealed same-shape " +
      "movable groups (a white triple that physically can't move). This is a " +
      "SUPERSET of lockedTriples — a fully-locked triple counts in both. If you " +
      "give this a weight, drop lockedTriples' weight (or zero it) so you don't " +
      "pay twice for the ones that are both locked and permanent.",
    compute: (s) => {
      const perm = computePermanentMask(s);
      return countPermanentTriples(s, RED, perm) - countPermanentTriples(s, BLUE, perm) + s.carryDiff;
    }
  },
  {
    name: "completionSpaces",
    weight: 0, // off by default; give it a weight to test
    note:
      "One-move threats to LOCK in a triple (see the algorithm section above). " +
      "The intended pairing with your redesign: drop softTriples toward 0 and " +
      "value permanentTriples (banked) + completionSpaces (threats) instead. A " +
      "space that completes 2+ lines at once is counted that many times.",
    compute: (s) => countCompletionSpaces(s, RED) - countCompletionSpaces(s, BLUE)
  }

  // ----- add your own below (see TEMPLATES near the bottom, then move them up
  //       here with a non-zero weight to make them count) -----
];

// The side-to-move nudge. `+TEMPO` if it's red's turn at this leaf, `-TEMPO` if
// blue's. Default 0 — calibration found it didn't help, but it's yours to play
// with.
export const TEMPO = 0;

// ===========================================================================
// The evaluator.  You normally don't need to touch anything below this line —
// it just adds up whatever is in FEATURES.
// ===========================================================================

// Returns { total, tempo, terms:[{name, weight, raw, points}] }, RED's view.
export function evaluate(state, side) {
  const terms = FEATURES.map((f) => {
    const raw = f.compute(state);
    return { name: f.name, weight: f.weight, raw, points: f.weight * raw };
  });
  const tempo = side === RED ? TEMPO : -TEMPO;
  const total = terms.reduce((a, t) => a + t.points, 0) + tempo;
  return { total, tempo, terms };
}

// Exact score of a FINISHED position (mirrors the rulebook: triples dominate,
// whites break ties). Used as the leaf value once the game is over.
function terminalScore(state) {
  const tripleDiff = countTriples(state, RED) - countTriples(state, BLUE) + state.carryDiff;
  const tb = state.geom.centerIdx >= 0
    ? -(state.shapes[state.geom.centerIdx] === RED) + (state.shapes[state.geom.centerIdx] === BLUE)
    : whiteDiffGeneric(state);
  return tripleDiff * 100000 + (state.noTiebreak ? 0 : tb * 10);
}

// ===========================================================================
// A tiny search that USES your weights, so you can watch move choice change.
// (This is a plain, slow negamax — a teaching tool, not the real engine.)
// ===========================================================================
function leafValueRed(state, side) {
  if (isPhaseOver(state)) return terminalScore(state);
  return evaluate(state, side).total;
}

// Negamax to a fixed depth; returns { move, valueRed } (value from red's view).
export function bestMove(state, side, depth) {
  const moves = genMoves(state, side);
  if (moves.length === 0 || depth === 0 || isPhaseOver(state)) {
    return { move: null, valueRed: leafValueRed(state, side) };
  }
  let best = null;
  // Red maximizes red's value; blue minimizes it.
  let bestVal = side === RED ? -Infinity : Infinity;
  for (const m of moves) {
    applyMove(state, m);
    const { valueRed } = bestMove(state, 1 - side, depth - 1);
    undoMove(state, m);
    if (side === RED ? valueRed > bestVal : valueRed < bestVal) {
      bestVal = valueRed;
      best = m;
    }
  }
  return { move: best, valueRed: bestVal };
}

// ===========================================================================
// Pretty-printing
// ===========================================================================
const GLYPH = { [RED]: "R", [BLUE]: "B", [NEUTRAL]: ".", [PURPLE]: "P", [YELLOW]: "Y" };

function renderBoard(state) {
  const { rows, cols } = state.geom;
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let row = "";
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      const g = GLYPH[state.shapes[i]] ?? "?";
      // lowercase = still movable (unflipped/active); UPPERCASE = locked
      row += (isActive(state, i) ? g.toLowerCase() : g) + " ";
    }
    lines.push("   " + row);
  }
  return lines.join("\n");
}

function printBreakdown(state, side) {
  const e = evaluate(state, side);
  console.log(renderBoard(state));
  console.log("   (lowercase = still movable, UPPERCASE = locked)\n");
  console.log(`   side to move: ${side === RED ? "RED" : "BLUE"}`);
  console.log("   " + "term".padEnd(16) + "raw".padStart(6) + "  x weight".padStart(10) + "= points".padStart(12));
  for (const t of e.terms) {
    console.log(
      "   " +
        t.name.padEnd(16) +
        String(t.raw).padStart(6) +
        String(t.weight).padStart(10) +
        String(t.points).padStart(12)
    );
  }
  if (e.tempo) console.log("   " + "tempo".padEnd(16) + "".padStart(6) + "".padStart(10) + String(e.tempo).padStart(12));
  console.log("   " + "".padEnd(16) + "".padStart(6) + "TOTAL".padStart(10) + String(e.total).padStart(12));
  console.log(`\n   (positive = good for RED. one locked triple of margin ≈ ${FEATURES[0].weight})`);
}

// ===========================================================================
// CLI
// ===========================================================================
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--check")) return selfCheck();
  const seedArg = argv.find((a) => /^\d+$/.test(a));
  const seed = seedArg ? Number(seedArg) : (Math.random() * 1e9) | 0;
  const moveIdx = argv.indexOf("--move");
  // The teaching search has NO pruning and branching is ~100 in the opening,
  // so keep it shallow: depth 2 is instant, 3 is a few seconds, 4 is ~a minute.
  const depth = moveIdx >= 0 ? Number(argv[moveIdx + 1] ?? 2) : 0;

  const state = makeRandomDeal({}, mulberry32(seed));
  console.log(`\n=== Flip Triples eval lab — seed ${seed} ===\n`);
  // Red is player index 0. On the opening board it's the first mover's turn;
  // we just show red-to-move so the breakdown reads in red's favor sign-wise.
  printBreakdown(state, RED);

  if (depth > 0) {
    console.log(`\n   searching depth ${depth} with YOUR weights ...`);
    const t0 = Date.now();
    const { move, valueRed } = bestMove(state, RED, depth);
    const mv = move != null ? decodeMove(state, move) : null;
    const cell = (p) => `(r${p.row},c${p.col})`;
    console.log(
      `   best red move: ${mv ? `${cell(mv.from)} -> ${cell(mv.to)}` : "(none)"}  ` +
        `value(red) ${valueRed}  [${Date.now() - t0}ms]`
    );
    console.log(`   (change a weight above and re-run — watch the move flip)`);
  }
  console.log("");
}

// Confirms this lab's DEFAULT weights reproduce the engine's own leaf eval, so
// you can trust the numbers before you start changing them.
function selfCheck() {
  // staticEval isn't exported; re-derive the engine's formula from its public parts.
  let worst = 0;
  for (let s = 0; s < 200; s += 1) {
    const state = makeRandomDeal({}, mulberry32(700000 + s));
    // walk a few random plies to get varied mid-positions
    let side = RED;
    for (let k = 0; k < (s % 9); k += 1) {
      const mv = genMoves(state, side);
      if (!mv.length) break;
      applyMove(state, mv[(s * 7 + k) % mv.length]);
      side = 1 - side;
    }
    const engine =
      (countLockedTriples(state, RED) - countLockedTriples(state, BLUE) + state.carryDiff) * 2000 +
      (countTriples(state, RED) - countTriples(state, BLUE)) * 250 +
      whiteDiffGeneric(state) * 10;
    const lab = evaluate(state, side).total - (side === RED ? TEMPO : -TEMPO);
    worst = Math.max(worst, Math.abs(engine - lab));
  }
  console.log(worst === 0
    ? "self-check OK: default lab weights reproduce the engine leaf eval exactly."
    : `self-check MISMATCH: max diff ${worst} (did you change default weights? that's fine — reset to 2000/250/10 to re-verify).`);
}

// Run the CLI only when invoked directly, so this file can also be imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

// ===========================================================================
// TEMPLATES — copy one into FEATURES (above), give it a weight, re-run.
// Each returns (red measure − blue measure). These are inert until you add them.
// ===========================================================================
//
// // "Two-in-a-row" threats: a line with 2 of your color + 1 empty neutral.
// // Rewards building toward triples. (Standard pieces only; ignores rings.)
// function twoInARow(state, target) {
//   const { lines } = state.geom, sh = state.shapes;
//   let n = 0;
//   for (const [x, y, z] of lines) {
//     const cells = [sh[x], sh[y], sh[z]];
//     const mine = cells.filter((c) => c === target || c === PURPLE).length;
//     const open = cells.filter((c) => c === NEUTRAL).length;
//     if (mine === 2 && open === 1) n += 1;
//   }
//   return n;
// }
// //  -> { name:"twoThreats", weight:40, note:"open 2-in-a-rows",
// //       compute:(s)=>twoInARow(s,RED)-twoInARow(s,BLUE) }
//
// // Middle control: on 4x6 the 8 center cells (rows 1-4, cols 1-2) are where
// // most triples pass through. Count your pieces sitting there.
// function middleControl(state, target) {
//   const { rows, cols } = state.geom; let n = 0;
//   for (let r = 1; r < rows - 1; r += 1)
//     for (let c = 1; c < cols - 1; c += 1)
//       if (state.shapes[r * cols + c] === target) n += 1;
//   return n;
// }
// //  -> { name:"middle", weight:15, note:"pieces in the central 8 cells",
// //       compute:(s)=>middleControl(s,RED)-middleControl(s,BLUE) }
//
// // Mobility: how many legal moves each side has. More options = more control.
// //  -> { name:"mobility", weight:5, note:"legal-move count edge",
// //       compute:(s)=>genMoves(s,RED).length - genMoves(s,BLUE).length }
