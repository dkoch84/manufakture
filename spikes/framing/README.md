# spikes/framing: framing representation and performance (T6.5a)

Measures three ways to represent framing members (studs, plates, headers, joists, rafters) on two
scripted buildings, a 12' x 16' shed and a 2,000 sq ft house: (A) a B-rep body per member through
`packages/kernel`, (B) member data in TypeScript with box meshes computed directly and drawn
instanced, (C) as B with cut members meshed by `manifold-3d`. Findings and the recommendation are
in [docs/spikes/T6.5a-framing.md](../../docs/spikes/T6.5a-framing.md).

## Running

From the repository root, after `pnpm install`:

```bash
pnpm --filter @manufakture/spike-framing test        # checks, about 3 s
pnpm --filter @manufakture/spike-framing measure     # every table in the report, about 15 min
pnpm --filter @manufakture/spike-framing typecheck
```

Or in this folder: `node scripts/measure.ts` and `../../node_modules/.bin/vitest run`.

`measure` prints Markdown tables and writes `results/measure.json` with the machine it ran on.
Environment knobs: `ONLY=node,kernel,browser` runs some parts (the file is then
`results/measure-<parts>.json`), `RUNS=n` sets the fresh processes per cold measurement (default 5
for B and C, 3 for A), `FRAMES=n` the frames per viewport case (default 60).

The viewport part runs Chromium headless through Playwright with SwiftShader (software WebGL), so
its frame times are a CPU rasterizer's, not a GPU's. The page is served through a Playwright
route, so no port is opened. In a container without Chromium's shared libraries, point
`PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH` at an unpacked copy (passed to the browser only, as in
`apps/web/playwright.config.ts`) and `FONTCONFIG_FILE` at a `fonts.conf`; if the browser itself is
missing, `pnpm exec playwright install chromium`.

Every measurement that depends on process state runs in a fresh Node process
(`scripts/node-child.ts` for B and C, `dist/node/kernel-child.js` for A). The kernel's sources need
Vite's resolver, so `measure` first bundles `scripts/kernel-child.ts` with Vite (SSR build, into
`dist/`, which git ignores); everything else runs in plain Node.

The package is private, in the workspace (root typecheck and lint include it) and not part of the
root test run. `manifold-3d` 3.5.4 is a dependency of this spike only.

## Files

| File                      | What it is                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/members.ts`          | The member data shape (stock, length, placement, cuts in the member's frame, group), shape keys, mm         |
| `src/generator.ts`        | The throwaway framing generator: walls with openings, corners and tees, floors, gable and hip rafters       |
| `src/fixtures.ts`         | The shed and the house, as groups (features) of members; the moved opening for warm regens                  |
| `src/geom.ts`             | Vectors, planes, placements                                                                                 |
| `src/clip.ts`             | B's mesher: boxes and convex planar clipping, a notch as two convex pieces; mesh volume                     |
| `src/manifold.ts`         | C's mesher (`trimByPlane`, `subtract`), object counting, the module's allocator for the heap probe          |
| `src/member-set.ts`       | A member set: one mesh per distinct shape, instance lists, warm regen of one group                          |
| `src/brep.ts`             | A: `extrude` and `tools` features per member through `KernelService`, `tessellate` and `topology`, transfer |
| `src/viewport/main.ts`    | The browser page: object per member, `InstancedMesh`, `BatchedMesh`, merged LOD; frame timing; GPU picking  |
| `src/spike.test.ts`       | Checks: counts, all three meshers agree on every cut shape's volume, mesh sharing, Manifold deletes         |
| `scripts/measure.ts`      | All measurements; `results/measure.json` is its last output                                                 |
| `scripts/node-child.ts`   | B and C measurements in a fresh process                                                                     |
| `scripts/kernel-child.ts` | A measurements in a fresh process (bundled first)                                                           |
| `scripts/bundle.ts`       | The Vite builds of the kernel child and the viewport page                                                   |
| `scripts/lib.ts`          | Child processes, results file, host info                                                                    |

The heap probe used for A and for Manifold's `delete()` check is `heapInUse` from
`@manufakture/kernel/testing` (`packages/kernel/src/heap-probe.ts`), ported there from the T0.2
spike so T6.5d's benchmark uses the same one.
