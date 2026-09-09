// Flip Triples difficulty ladder — the single source of truth, imported by BOTH
// the server (game.js, which runs the search) and the browser (the solo picker,
// which shows the numbers). One table means what a player reads is what the bot
// actually gets.
//
// The level number IS the search depth: Level N looks exactly N moves ahead and
// stops, however much time it has left. `capMs` is only a safety valve —
// openings branch about 93 wide, so without it a deep level could think for
// minutes on move one. When the cap bites, the bot plays the best move from the
// last depth it finished.
//
// WHY DEPTH AND NOT A CLOCK. Time cannot produce a gentle opponent in this
// game. A 17-ply game means the engine proves the last ~9 plies exactly on
// almost no clock, so every time-limited bot has a flawless endgame: measured,
// a 5ms always-best-move bot beat the old blunder-based Baby bot 98.5% of the
// time (+727 Elo). A depth-1 bot cannot see 9 plies ahead by construction, and
// comes in at +179 Elo over that same Baby bot — an actual beginner rung, with
// no deliberate blunders anywhere.
//
// EVERY STEP IS A REAL STEP. Measured head-to-head at these caps
// (tools/flip-triples/depth-faceoff.js), deeper side's score:
//
//   1 -> 2   82.7% (+272 Elo, n=820)     4 -> 5   77.8% (+217, n=600)
//   2 -> 3   83.9% (+287 Elo, n=820)     5 -> 6   71.6% (+160, n=320)
//   3 -> 4   75.8% (+199 Elo, n=600)     6 -> 7   75.6% (+197, n=320)
//
// Nothing is filler: the narrowest rung still wins seven games in ten, which is
// wider than any step of the thinking-time ladder this replaced (~98 Elo each).
//
// COST (measured, this laptop; the worst case is always ply 0, and the median
// is far lower — depth 7 typically answers in 49ms):
//   depth   1     2     3      4       5       6       7
//   median  0ms   0ms   0ms    1ms     6ms     19ms    49ms
//   worst   1ms   1ms   5ms    28ms    329ms   3.6s    over 10s
// Caps sit well above the measured worst case so a slower host still reaches
// the depth. Depth 7 is the deliberate exception, where the cap genuinely binds
// in about 4% of positions and the bot plays a shade shallower there.
export const FLIP_BOT_LEVELS = [
  { depth: 1, capMs: 100, name: "Level 1", blurb: "Grabs whatever looks best right now" },
  { depth: 2, capMs: 100, name: "Level 2", blurb: "Checks your reply before committing" },
  { depth: 3, capMs: 100, name: "Level 3", blurb: "Sets up threats it can follow through" },
  { depth: 4, capMs: 250, name: "Level 4", blurb: "Sees whether your answer refutes it" },
  { depth: 5, capMs: 1000, name: "Level 5", blurb: "Reads a whole exchange to the end" },
  { depth: 6, capMs: 6000, name: "Level 6", blurb: "Plans past the exchange" },
  { depth: 7, capMs: 10000, name: "Level 7", blurb: "Bring your best" }
];

// Middle of the ladder: enough to punish a loose move, still beatable.
export const FLIP_BOT_DEFAULT_LEVEL = 3;

// "100ms" / "1s" / "10s" — sub-second budgets read better in milliseconds.
export function formatThinkTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

// What defines the level, in words a player can act on. Depth is in plies —
// one move by one player — which is the natural reading of "moves ahead".
export function describeLevel(level) {
  return `${level.depth} ${level.depth === 1 ? "move" : "moves"} ahead`;
}
