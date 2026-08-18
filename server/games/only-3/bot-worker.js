// Only 3 bot worker: keeps the search (God bot: several seconds) off the
// server's main thread. Each request carries a per-room sequence number the
// server uses to drop replies a restart has made stale.
import { parentPort } from "worker_threads";
import { chooseOnly3Move } from "./bot.js";

parentPort.on("message", ({ seq, roomId, board, meColor, timeMs, maxDepth, pickWeights }) => {
  let move = null;
  try {
    move = chooseOnly3Move(board, meColor, { timeMs, maxDepth, pickWeights });
  } catch (err) {
    console.error("only-3 bot worker search failed:", err);
  }
  parentPort.postMessage({
    seq,
    roomId,
    move: move ? { cell: move.cell, color: move.color } : null
  });
});
