# flip-engine.wasm

Built from `../assembly/engine.ts` with the AssemblyScript compiler pinned in
the repo's devDependencies:

    node_modules/.bin/asc server/games/flip-triples/assembly/engine.ts \
      --outFile server/games/flip-triples/build/flip-engine.wasm \
      -O3 --runtime stub --noAssert

The build is reproducible — the command above is byte-for-byte deterministic
for a given source and compiler version.

There is only one binary now. Table size used to be a compile-time constant,
which is why older `flip-engine-big.wasm` / `flip-engine-frozen.wasm` variants
exist; both are superseded:

  * table size is a runtime knob — `setTTBits(n)`, driven by `FLIP_TT_BITS`
  * leaf eval is a runtime knob — `setEvalMode(0|1)`

After changing `engine.ts`, rebuild and re-run the cross-engine check, which
compares fixed-depth search values against the JS reference implementation in
both rule sets:

    node tools/flip-triples/wasm-exact-verify.js --positions 25 --depth 5
    node tools/flip-triples/wasm-exact-verify.js --positions 25 --depth 5 --classic
