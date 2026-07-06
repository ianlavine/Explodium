// Bot search worker: runs chooseSolverMove off the server's main thread so a
// long think (God bot: 4.5s) never blocks other sockets. Requests are handled
// serially; each carries a per-room sequence number the server uses to drop
// replies that a restart/undo has made stale.
import { parentPort } from "worker_threads";
// engine.js prefers the WASM core and falls back to the JS engine for
// exotic pieces or if the wasm binary is missing.
import { chooseSolverMove } from "./engine.js";

parentPort.on("message", ({ seq, roomId, gameState, playerIndex, timeMs, pickWeights }) => {
  let move = null;
  try {
    move = chooseSolverMove(gameState, playerIndex, { timeMs, pickWeights });
  } catch (err) {
    console.error("bot worker search failed:", err);
  }
  parentPort.postMessage({
    seq,
    roomId,
    move: move ? { from: move.from, to: move.to } : null
  });
});
