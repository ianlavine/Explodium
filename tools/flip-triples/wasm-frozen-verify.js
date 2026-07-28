// Verify the wasm frozen eval (build/flip-engine-frozen.wasm, evalMode=1) matches
// the JS weightedEval(frozen) EXACTLY, and that mode 0 still matches deployed basic.
// Method: fixed-depth search values must be identical (same negamax + same eval).
// Positions are drawn mid-game (random-move prefix) so locked/permanent structure
// actually exercises the permanence flood-fill + completion scan.
//
//   node tools/flip-triples/wasm-frozen-verify.js --n 120 --depth 5
import fs from "fs";
import { fileURLToPath } from "url";
import {
  search as searchJs,
  setHeuristic,
  clearTT as clearTTjs,
  makeRandomDeal,
  genMoves,
  applyMove,
  isPhaseOver,
  decodeMove,
  mulberry32
} from "../../server/games/flip-triples/solver.js";
import { HEURISTICS } from "../../server/games/flip-triples/heuristics.js";

const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean).map((s) => s.trim().split(/\s+/))
);
const N = Number(args.n ?? 120);
const DEPTH = Number(args.depth ?? 5);

const wasmPath = fileURLToPath(new URL("../../server/games/flip-triples/build/flip-engine-frozen.wasm", import.meta.url));
const module = new WebAssembly.Module(fs.readFileSync(wasmPath));
const instance = new WebAssembly.Instance(module, {
  env: { now: () => Date.now(), abort: () => { throw new Error("wasm abort"); } }
});
const w = instance.exports;
if (typeof w.setEvalMode !== "function") throw new Error("wasm has no setEvalMode — rebuild");

let wasmCtx = "";
function wasmValue(state, player, mode) {
  const g = state.geom;
  const ctx = `${g.rows}x${g.cols}|${state.phase}|${state.uniqueSwap}|${state.staticNeutrals}|${state.blockedCenter}|${state.carryDiff}|${state.noTiebreak}`;
  if (ctx !== wasmCtx) {
    w.init(g.rows, g.cols, state.uniqueSwap ? 1 : 0, state.staticNeutrals ? 1 : 0, state.blockedCenter, state.phase, state.noTiebreak ? 1 : 0, state.carryDiff);
    wasmCtx = ctx;
  }
  w.setEvalMode(mode);
  w.clearTT();
  for (let i = 0; i < g.cells; i += 1) w.setCell(i, state.shapes[i], state.flipped[i]);
  w.beginPosition();
  const best = w.searchRoot(player, DEPTH, 3600000);
  if (best < 0) return null;
  const sign = player === 1 ? 1 : -1;
  return sign * w.getValue();
}

function jsValue(state, player, weights) {
  setHeuristic(weights); // null => deployed basic path
  clearTTjs();
  return searchJs(state, player, { maxDepth: DEPTH, timeMs: 3600000 }).value;
}

let frozenMismatch = 0;
let basicMismatch = 0;
let checked = 0;
const examples = [];
for (let s = 0; s < N; s += 1) {
  const rng = mulberry32(1234567 + s);
  const state = makeRandomDeal({}, mulberry32(600000 + s));
  // random prefix of up to 8 plies for a varied mid-game position
  const prefix = Math.floor(rng() * 9);
  let side = 0;
  for (let p = 0; p < prefix && !isPhaseOver(state); p += 1) {
    const moves = genMoves(state, side);
    if (moves.length === 0) { side = 1 - side; continue; }
    applyMove(state, moves[Math.floor(rng() * moves.length)]);
    side = 1 - side;
  }
  if (isPhaseOver(state)) continue;
  const player = side;

  const jf = jsValue(state, player, HEURISTICS.frozen);
  const wf = wasmValue(state, player, 1);
  const jb = jsValue(state, player, null);
  const wb = wasmValue(state, player, 0);
  checked += 1;
  if (jf !== wf) { frozenMismatch += 1; if (examples.length < 5) examples.push({ s, prefix, player, kind: "frozen", js: jf, wasm: wf }); }
  if (jb !== wb) { basicMismatch += 1; if (examples.length < 5) examples.push({ s, prefix, player, kind: "basic", js: jb, wasm: wb }); }
}

console.log(`checked ${checked} mid-game positions at depth ${DEPTH}`);
console.log(`  frozen (wasm mode1 vs JS weightedEval): ${frozenMismatch} mismatches`);
console.log(`  basic  (wasm mode0 vs JS deployed):     ${basicMismatch} mismatches`);
if (examples.length) { console.log("  examples:"); for (const e of examples) console.log("   ", JSON.stringify(e)); }
console.log(frozenMismatch === 0 && basicMismatch === 0 ? "\nPASS — wasm frozen eval is faithful." : "\nFAIL — eval mismatch, do NOT trust the port.");
