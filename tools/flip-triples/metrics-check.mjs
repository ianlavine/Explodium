// Assert the browser metrics module matches the engine's metric functions.
import {
  createState, makeRandomDeal, genMoves, applyMove, mulberry32,
  computePermanentMask as engPerm, countLockedTriples, countTriples,
  countPermanentTriples, countCompletionSpaces, RED, BLUE
} from "../../server/games/flip-triples/solver.js";
import * as M from "../../public/games/flip-triples/metrics.js";

const geom = M.buildGeom(6, 4);
let checks = 0, fails = 0;
const eq = (a, b, msg) => { checks++; if (a !== b) { fails++; if (fails <= 8) console.log("MISMATCH", msg, a, "!=", b); } };

for (let s = 0; s < 400; s++) {
  // varied positions: random deal with occasional exotic pieces, walked a few plies
  const opts = s % 3 === 0 ? { purple: 2, yellow: 1, rings: 1, hopper: 1 } : {};
  const eng = makeRandomDeal(opts, mulberry32(500000 + s));
  let side = 0;
  for (let k = 0; k < (s % 10); k++) {
    const mv = genMoves(eng, side); if (!mv.length) { side = 1 - side; continue; }
    applyMove(eng, mv[(s * 7 + k) % mv.length]); side = 1 - side;
  }
  const st = M.makeState(Uint8Array.from(eng.shapes), Uint8Array.from(eng.flipped), geom);
  const ep = engPerm(eng), mp = M.computePermanentMask(st);
  for (let i = 0; i < geom.cells; i++) eq(mp[i], ep[i], `perm[${i}] s${s}`);
  const mPerm = M.computePermanentMask(st);
  for (const T of [RED, BLUE]) {
    eq(M.locateLockedTriples(st, T).count, countLockedTriples(eng, T), `locked T${T} s${s}`);
    eq(M.locateAllTriples(st, T).count, countTriples(eng, T), `soft T${T} s${s}`);
    eq(M.locatePermanentTriples(st, T, mPerm).count, countPermanentTriples(eng, T, ep), `perm△ T${T} s${s}`);
    eq(M.locateCompletionSpaces(st, T).count, countCompletionSpaces(eng, T), `comp T${T} s${s}`);
  }
}
console.log(fails === 0 ? `metrics-check OK: ${checks} assertions across 400 positions, all match the engine.` : `FAILED: ${fails}/${checks} mismatches.`);
process.exit(fails ? 1 : 0);
