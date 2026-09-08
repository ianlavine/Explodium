// Engine facade: WASM search core when the position qualifies (standard
// red/blue/neutral pieces on a bitboard-capable board), JS engine otherwise
// (exotic pieces, group variants, rootMoves-restricted analysis searches, or
// when the wasm binary is missing). Result shape matches solver.js `search`.
//
// Exact Mode — the shipped default rule set — used to be on that fallback list,
// which meant the live bot ran the JS engine at roughly a quarter of the node
// rate. It has a bitboard path now; coreFor() reports which engine answers.
import fs from "fs";
import { fileURLToPath } from "url";
import {
  search as searchJs,
  stateFromGame,
  decodeMove,
  evalNetActive,
  RED,
  BLUE
} from "./solver.js";

let wasm = null;
// Does the loaded binary implement Exact Mode scoring? (older builds do not)
let wasmExact = false;
try {
  // FLIP_WASM_PATH selects an alternate build (e.g. the big-TT solver variant
  // used by offline analysis tools).
  const wasmPath = process.env.FLIP_WASM_PATH
    ? process.env.FLIP_WASM_PATH
    : fileURLToPath(new URL("./build/flip-engine.wasm", import.meta.url));
  const module = new WebAssembly.Module(fs.readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(module, {
    env: {
      now: () => Date.now(),
      abort: () => {
        throw new Error("wasm abort");
      }
    }
  });
  wasm = instance.exports;
  // Deployed leaf eval = frozen (permanent triples + completion threats + white),
  // the corrected-faceoff champion. setEvalMode(1) selects it; the binary keeps
  // mode 0 (basic) available for A/B harnesses. Older binaries lack the export.
  if (typeof wasm.setEvalMode === "function") wasm.setEvalMode(1);
  wasmExact = typeof wasm.supportsExactMode === "function" && wasm.supportsExactMode() === 1;
  // FLIP_TT_BITS sizes the wasm transposition table too, not just the JS one.
  // The live bot leaves this alone (21 = ~25 MB); long analysis searches that
  // saturate the table want 24+, which is worth ~10x at multi-minute budgets.
  if (process.env.FLIP_TT_BITS && typeof wasm.setTTBits === "function") {
    wasm.setTTBits(Number(process.env.FLIP_TT_BITS));
  }
} catch (err) {
  console.error("flip-engine: wasm unavailable, using JS engine only:", err.message);
}

let wasmCtx = "";

function wasmPrepare(state) {
  const g = state.geom;
  const ctx = `${g.rows}x${g.cols}|${state.phase}|${state.uniqueSwap}|${state.staticNeutrals}|${state.blockedCenter}|${state.carryDiff}|${state.noTiebreak}|${state.exactMode}`;
  if (ctx !== wasmCtx) {
    const ok = wasm.init(
      g.rows,
      g.cols,
      state.uniqueSwap ? 1 : 0,
      state.staticNeutrals ? 1 : 0,
      state.blockedCenter,
      state.phase,
      state.noTiebreak ? 1 : 0,
      state.carryDiff,
      state.exactMode ? 1 : 0
    );
    if (!ok) return false;
    wasmCtx = ctx;
  }
  return true;
}

// Which core will answer for this position? Exported so tools and tests can
// assert the fast path is actually being taken rather than inferring it from
// throughput (which is meaningless on a loaded machine).
export function coreFor(state, opts = {}) {
  if (!wasm) return "js:no-wasm";
  if (!state.simple) return "js:exotic-pieces";
  if (state.exactMode && !wasmExact) return "js:wasm-lacks-exact-mode";
  if (state.groupRule) return "js:group-variant";
  if (opts.rootMoves) return "js:root-restricted";
  if (evalNetActive()) return "js:eval-net";
  return "wasm";
}

// Same contract as flip-solver.js search(); `value` is red-perspective.
export function search(state, player, opts = {}) {
  // The wasm core has the hand eval baked in, so a loaded value net forces
  // the JS engine — as do the group variants, whose scoring rules the wasm
  // bitboards do not implement. (Exact Mode does have a bitboard path now.)
  if (coreFor(state, opts) !== "wasm") return searchJs(state, player, opts);
  if (!wasmPrepare(state)) return searchJs(state, player, opts);

  const { timeMs = 1000, maxDepth = 60 } = opts;
  for (let i = 0; i < state.geom.cells; i += 1) {
    wasm.setCell(i, state.shapes[i], state.flipped[i]);
  }
  wasm.beginPosition();
  const best = wasm.searchRoot(player, maxDepth, timeMs);
  if (best < 0) return null;

  const sign = player === 1 ? 1 : -1;
  const n = wasm.getRankedCount();
  const ranked = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const m = wasm.getRankedMove(i);
    const v = wasm.getRankedValue(i);
    ranked[i] = {
      move: m,
      ...decodeMove(state, m),
      value: v <= -1000000000 ? null : sign * v
    };
  }
  return {
    move: best,
    ...decodeMove(state, best),
    value: sign * wasm.getValue(),
    depth: wasm.getDepth(),
    solved: wasm.getSolved() === 1,
    nodes: wasm.getNodes(),
    ranked
  };
}

export const wasmAvailable = !!wasm;

// Drop-in replacement for solver.js chooseSolverMove, using the facade.
export function chooseSolverMove(gameState, playerIndex, opts = {}) {
  const { pickWeights = null, rand = Math.random, ...searchOpts } = opts;
  const state = stateFromGame(gameState);
  const result = search(state, playerIndex, searchOpts);
  if (!result) return null;
  let choice = result;
  if (pickWeights && result.ranked.length > 1) {
    const n = Math.min(pickWeights.length, result.ranked.length);
    let total = 0;
    for (let i = 0; i < n; i += 1) total += pickWeights[i];
    let roll = rand() * total;
    let idx = 0;
    for (let i = 0; i < n; i += 1) {
      roll -= pickWeights[i];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    choice = result.ranked[idx];
  }
  return { from: choice.from, to: choice.to, info: result };
}

export { RED, BLUE, stateFromGame };
