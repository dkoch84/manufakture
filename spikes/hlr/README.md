# spikes/hlr: hidden-line removal and the dimension model (T4.4a)

Probes for the M4 drawing pipeline: OCCT's hidden-line removal (HLR) in libcascade 3.0.2, run on
real bodies, checked against views drawn by hand, timed, and measured for memory; and a prototype
of dimensions stored as model references. Findings and recommendations are in
[docs/spikes/T4.4a-hlr.md](../../docs/spikes/T4.4a-hlr.md).

## Running

The spike has no `package.json` (so it adds nothing to the workspace or the lockfile). It runs
with the repository's own Vitest, from the repository root, after `pnpm install`:

```bash
node_modules/.bin/vitest run --root spikes/hlr                       # everything, about 1 minute
node_modules/.bin/vitest run --root spikes/hlr src/timing.test.ts    # one probe
node_modules/.bin/vitest run --root spikes/hlr --silent=false --reporter=verbose   # with the probes' log lines
node_modules/.bin/tsc --noEmit -p spikes/hlr                         # typecheck
```

Test files run one at a time (`fileParallelism: false`) so timings do not compete. Each probe
writes its numbers to `results/<probe>.json` with the machine it ran on; `HLR_RUNS=n` sets the
number of timed runs per cell in `timing.test.ts` (default 5, after one first run).

The code imports `packages/kernel` and `packages/units` by relative path, and uses libcascade
through the kernel (`Kernel.oc`), so it always runs the pinned build.

## Files

| File                    | What it is                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/hlr.ts`            | The `project` op prototype: exact and poly HLR, edge classes, 2D curve extraction, release rules, 3D source pieces |
| `src/views.ts`          | View frames (front, top, right, iso) and the TypeScript projection of points and circles                           |
| `src/fixtures.ts`       | The bodies: box with a hole, cylinder, 40-hole board, filleted and chamfered box, vase, M1 bracket, boards, STEP   |
| `src/compare.ts`        | Edge-by-edge geometric comparison of a result with a hand-drawn view, and coverage between two results             |
| `src/source.ts`         | Model edges from the mesh, 3D source matching, and picking (nearest projected edge, with a depth tie-break)        |
| `src/dimension.ts`      | The dimension model prototype: references, resolution, projection, value                                           |
| `src/audit.ts`          | Destructor audit (which classes' `delete()` frees nothing), from `spikes/kernel-wrapper`                           |
| `src/timing.test.ts`    | Time, edge counts and curve types per fixture, view and algorithm; exact against poly                              |
| `src/expected.test.ts`  | Box, cylinder and bracket against hand-drawn views; HLR coordinates against `HLRAlgo_Projector` and `views.ts`     |
| `src/memory.test.ts`    | Destructor audit, embind tracker, heap per projection on fresh instances, memory of one large projection           |
| `src/bodies.test.ts`    | Per-body layers, bodies projected alone against together, a translated instance, a section view                    |
| `src/assoc.test.ts`     | HLR edges to model edges (3D), and picking hit rates                                                               |
| `src/dimension.test.ts` | Dimensions on the bracket through a wall change and a deleted fillet; `packages/units` formatting                  |
