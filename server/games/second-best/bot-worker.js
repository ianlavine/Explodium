// Second Best bot worker: keeps the search off the server's main thread. Each
// request carries a per-room sequence number the server uses to drop replies a
// restart or a human move has made stale.
import { parentPort } from "worker_threads";
import { chooseSecondBestMove } from "./bot.js";

parentPort.on("message", ({ seq, roomId, board, meColor, timeMs, maxDepth, pickWeights, neutralsLeft }) => {
  let move = null;
  try {
    move = chooseSecondBestMove(board, meColor, { timeMs, maxDepth, pickWeights, neutralsLeft });
  } catch (err) {
    console.error("second-best bot worker search failed:", err);
  }
  parentPort.postMessage({
    seq,
    roomId,
    move: move ? { cell: move.cell, color: move.color } : null
  });
});
