# spikes/clipper2: Clipper2 in JS/WASM for offsets and arc refit (T5.0a)

Compares the two live Clipper2 ports for `packages/cam`'s offset engine, `clipper2-ts` 2.0.1-18
(pure TypeScript) and `clipper2-wasm` 0.4.0 (Emscripten), on sketch regions from
`packages/sketch`'s `detectRegions`, and prototypes rebuilding G2/G3 arcs from Clipper's polyline
output. Findings and the recommendation are in
[docs/spikes/T5.0a-clipper2.md](../../docs/spikes/T5.0a-clipper2.md).

## Running

From the repository root, after `pnpm install`:

```bash
pnpm --filter @manufakture/spike-clipper2 test        # checks, about 1 s
pnpm --filter @manufakture/spike-clipper2 measure     # every table in the report, about 70 s
pnpm --filter @manufakture/spike-clipper2 typecheck
RUNS=3 pnpm --filter @manufakture/spike-clipper2 measure   # three times the timing repetitions
```

Or with the repository's own Vitest, without pnpm:

```bash
./node_modules/.bin/vitest run --root spikes/clipper2   # the checks; the measurements:
./node_modules/.bin/vitest run --root spikes/clipper2 --config vitest.measure.config.ts
```

`measure` runs `scripts/measure.ts` under Vitest (the sketch package's extensionless imports need
Vite's resolver), prints the tables as Markdown and writes them to `results/measure.json` with the
machine they ran on. The package is private and not part of the root test run; root typecheck and
lint include it.

## Files

| File                    | What it is                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/geometry.ts`       | Exact line/arc loops, conversion from `detectRegions` regions, flattening with one Z tag per vertex      |
| `src/engines.ts`        | The candidates behind one `offset()`: clipper2-ts, clipper2-wasm `Path64` and `PathD` APIs               |
| `src/fixtures.ts`       | The cases: bracket, frame with island, dumbbell, narrow slots, 10,000-vertex outlines, 50 rings          |
| `src/metrics.ts`        | Hausdorff distance against the exact offset (both directions), grid index for nearest queries            |
| `src/refit.ts`          | Arc refit, untagged (greedy circle fit) and tagged (circles named by Z tags); Grbl arc check; arcs to G1 |
| `src/spike.test.ts`     | Checks on the above and on the findings the report relies on                                             |
| `src/clipper2z.d.ts`    | Types for clipper2-wasm's ES entry (the package's `types` path points at a file it does not ship)        |
| `scripts/measure.ts`    | All measurements; `results/measure.json` is its last output                                              |
| `scripts/load-probe.ts` | Cold load of one library in a fresh worker thread (plain Node)                                           |
