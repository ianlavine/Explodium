// Engine facade: WASM search core when the position qualifies (standard
// red/blue/neutral pieces on a bitboard-capable board), JS engine otherwise
// (exotic pieces, rootMoves-restricted analysis searches, or when the wasm
// binary is missing). Result shape matches solver.js `search`.
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
} catch (err) {
  console.error("flip-engine: wasm unavailable, using JS engine only:", err.message);
}

let wasmCtx = "";

function wasmPrepare(state) {
  const g = state.geom;
  const ctx = `${g.rows}x${g.cols}|${state.phase}|${state.uniqueSwap}|${state.staticNeutrals}|${state.blockedCenter}|${state.carryDiff}|${state.noTiebreak}`;
  if (ctx !== wasmCtx) {
    const ok = wasm.init(
      g.rows,
      g.cols,
      state.uniqueSwap ? 1 : 0,
      state.staticNeutrals ? 1 : 0,
      state.blockedCenter,
      state.phase,
      state.noTiebreak ? 1 : 0,
      state.carryDiff
    );
    if (!ok) return false;
    wasmCtx = ctx;
  }
  return true;
}

// Same contract as flip-solver.js search(); `value` is red-perspective.
export function search(state, player, opts = {}) {
  // The wasm core has the hand eval baked in, so a loaded value net forces
  // the JS engine.
  if (!wasm || !state.simple || opts.rootMoves || evalNetActive()) {
    return searchJs(state, player, opts);
  }
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
