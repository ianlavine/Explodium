// Jabble client-side prediction. The browser keeps its own copy of the match
// and steps it the moment you press something, so your square (and the ball
// you kick) moves at once instead of a round trip later.
//
// Every fixed tick the browser records one input — [seq, keys, jab] — steps
// its copy with it and sends it. The server applies each player's inputs one
// per tick, in order, and every snapshot says which it has reached (`ack`).
// When a snapshot lands the copy is rebuilt from it and the inputs the server
// hasn't got to yet are replayed on top, which lands it back on the present.
// Everyone else is run forward on whatever they were last pressing; when that
// guess was wrong, the next snapshot puts it right (the renderer eases the
// jump). Nothing in the copy can die — deaths wait for the server.
//
// No DOM in here, so the same code runs under Node for testing.
import { step, setKeys, requestJab, worldFromSnapshot } from "./engine.js";

const MAX_HISTORY = 120; // two seconds of unanswered inputs, then the oldest go

export function createPredictor(seat) {
  let world = null;
  let history = []; // inputs the server hasn't acknowledged, oldest first
  let seq = 0;

  function apply([, keys, jab]) {
    setKeys(world, seat, keys);
    if (jab) requestJab(world, seat, jab);
    step(world, true);
  }

  return {
    get world() {
      return world;
    },

    // One fixed tick of local input: recorded, applied, and returned to send.
    tick(keys, jab) {
      seq += 1;
      const input = [seq, keys, jab];
      history.push(input);
      if (history.length > MAX_HISTORY) history.shift();
      if (world) apply(input);
      return input;
    },

    // A snapshot from the server: start again from the truth and replay what
    // it hasn't seen yet. `tune` (the numbers in force, sliders included),
    // `solids` and `teams` come from the round's state.
    reconcile(snap, tune, solids, teams) {
      const ack = snap.ack?.[seat] ?? 0;
      history = history.filter(([n]) => n > ack);
      world = worldFromSnapshot(snap, tune, solids, teams);
      history.forEach(apply);
    }
  };
}
