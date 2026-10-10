# @manufakture/fea

Linear static stress analysis on real geometry (M9 plan, task T9.6a; [ADR 0017](../../docs/adr/0017-mechanical-domain.md) decision 13; the [T9.0a spike](../../docs/spikes/T9.0a-fea.md) as a package). One or more bonded bodies, given as the kernel's STEP, are meshed into quadratic tetrahedra (TET10) by gmsh compiled to WebAssembly in this package, and solved by our own TypeScript solver: isotropic linear elasticity, conjugate gradients preconditioned by smoothed-aggregation algebraic multigrid (AMG) to a relative residual of 1e-8, nodal displacements, stresses, von Mises and principal stresses.

It runs where the client runs, never on the sync server (maintainer decisions 1 and 6 of #1226/#1254): in a browser module worker and in a Node worker thread (an agent's local MCP session), with the same limits. It reports numbers; it labels nothing safe (decision 2). Margins against a factor are the calc records' job (T9.6c), and so is saying that the model is isotropic, linear, elastic, bonded and small-deflection.

GPL-3.0-or-later. Runtime dependency: `comlink` (Apache-2.0). The mesher is a separate `.wasm` whose licences are listed under [Licences](#licences).

## Units

Lengths and displacements in **millimetres** (the kernel's STEP unit), forces in **newtons**, stresses, pressures and moduli in **pascals** (as `packages/core`'s materials and `packages/calc`). Inside, the solver works in mm, N and MPa; the conversion happens once at each end.

## Use

```ts
import { createFeaRunner } from '@manufakture/fea/client';
import { spawnBrowserFeaWorker } from '@manufakture/fea/browser'; // or spawnNodeFeaWorker from '@manufakture/fea/node'

const fea = createFeaRunner(spawnBrowserFeaWorker);
const outcome = await fea.run(
  {
    bodies: [{ step, material: { elasticModulus: 200e9, poissonRatio: 0.3 }, faceCount: 12 }],
    mesh: {}, // default size: about 175k DOF; or { size: 4, refine: [{ faces: [{ body: 0, face: 7 }], size: 0.5 }] }
    fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
    loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -2000] }],
  },
  { onProgress: (p) => show(p.phase, p.iteration), signal: abort.signal },
);
if (outcome.ok) draw(outcome.result.vonMises);
else report(outcome.error.code, outcome.error.message);
```

- **`FeaRequest`** (`src/types.ts`): `bodies` (STEP bytes, material, and optionally the kernel's `faceCount`), `mesh` (`size`, `sizeMin`, `curvature` in elements per circle, `refine` per face, `algorithm` `'hxt'` (default) or `'delaunay'`), `fixtures` (faces held in all or some of x, y, z), `loads` (a total `force` spread over the faces' area, a `traction`, or a `pressure` into the body), optional `limits` and `tolerance`.
- **Faces** are `{ body, face }`, `face` being the kernel's face index: after gmsh imports a body's STEP, its surfaces in tag order are the kernel's faces in order (T9.0a). A fixture, load or refinement may not name the same face twice (a force would count its area twice); different items may share a face. Pass `faceCount` (the kernel's count) and a mismatch stops the run with `face-mapping` instead of loading the wrong faces. Bonded bodies are fragmented so shared faces mesh conformally; each kernel face follows its pieces, so loads and fixtures still land on the right triangles.
- **`FeaResult`**: `nodes`, `elements` (10 per element, corners then edge nodes 01 12 02 03 13 23), `elementBody`, boundary `triangles` (6 nodes each) with their `triangleFace` (body, face) for display, and per node `displacement` (mm), `stress` (Pa, Voigt xx yy zz yz xz xy, averaged over the elements at the node), `vonMises` and `principal` (s1 >= s2 >= s3). `summary` has the counts, the DOF estimate, iterations and residual, the peaks with their location and body, the applied force, the worst element quality, the memory used, per-phase timings and warnings (`large-model` above 200k DOF, `poor-elements`, `load-off-mesh`). The arrays are transferred from the worker, not copied.
- **Errors are data** (`FeaError`, ADR 0007 decision 5): `invalid-input` (with the path of the field), `dof-limit` (`estimated: true` when refused before meshing), `memory-limit`, `time-limit`, `cancelled`, `mesher-unavailable`, `mesh-failed` (gmsh's message and log tail), `face-mapping`, `invalid-element`, `unconstrained` (with the bodies not held), `not-converged`, `worker-failed`, `busy`. `run` never rejects for any of them, and every run settles.
- **One analysis at a time per runner** (`busy` otherwise). `runMesh(model, input)` solves a mesh that is already built, under the same protocol; `analyse` and `analyseMesh` (from the package root) run in the calling thread. `prepare()` downloads and compiles the mesher ahead of the first run; it takes its turn with the runs (`busy`), settles with `time-limit` after `prepareTimeoutMs` (default 120 s; the worker is terminated) and with `worker-failed` or `memory-limit` if the worker dies. `dispose()` settles a run or prepare in flight with `worker-failed`.
- **A fresh worker after a failure that may leave it dirty**: a run that ends in `memory-limit` or `mesh-failed` terminates its worker, so the next run starts in a new one (and compiles the mesher again). A browser worker that reports any `error` event is terminated too, since an uncaught error in a live worker and a crash look alike from the page.
- **A browser that kills a worker for running out of memory usually sends no `error` event**, so the page cannot tell it happened: such a run settles at its time limit as `time-limit`, not `memory-limit`. A Node worker thread that runs out of its heap does report it, as `memory-limit`.
- **Progress** reports the phase (`load-mesher`, `import`, `mesh`, `prepare`, `assemble`, `precondition`, `solve`, `stress`), the elapsed time, the DOF once known and, while solving, the iteration and residual.
- **Cancellation**: an `AbortSignal`. The worker checks a shared flag between phases, every few thousand elements and between iterations; a gmsh call cannot be interrupted, so if the worker has not answered 3 s after a cancel (or the time limit), the runner terminates it and answers `cancelled` (or `time-limit`), and starts a new worker on the next run. Without `SharedArrayBuffer` (a page that is not cross-origin isolated) cancelling terminates at once.

## Limits

Every limit ends with a typed error, checked before anything is allocated (resource limits as denial of service in shared documents; security review follows).

| Limit              | Default           | Ceiling (`HARD_LIMITS`) | Enforced                                                                                                          |
| ------------------ | ----------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Degrees of freedom | 500,000           | 500,000                 | estimate before meshing, then the real count before assembly                                                      |
| Warning            | above 200,000     |                         | `large-model` warning on the result                                                                               |
| Default mesh       | about 175,000 DOF |                         | `mesh.size` left out                                                                                              |
| Memory             | 1.5 GiB           | 4 GiB                   | gmsh's memory is created with its share as the maximum; the solver accounts for its arrays before allocating each |
| Time               | 300 s             | 600 s                   | the worker between phases and iterations; the host terminates it 3 s later                                        |

The request itself (`REQUEST_LIMITS`): at most 16 bodies, 32 MiB of STEP per body and 64 MiB in all, 1,000 fixtures, 1,000 loads, 1,000 refinements, 500 refined faces in all, 10,000 faces per item and 10,000 across all fixtures and loads, no face twice in one item, 100,000 faces per body; element sizes from 0.1 µm to 100 m, the smallest no finer than size / 50; curvature 0 to 100 elements per circle; magnitudes up to 1e15; Poisson's ratio in (-0.99, 0.495]; every number finite. A Node worker's V8 heap is limited to 512 MiB (typed arrays are outside it and counted by the memory account); gmsh gets half the memory limit and at most 1 GiB, which meshes far past the DOF cap (T9.0a: 153 MiB at 1.36M DOF), and never more than its half: an analysis that meshes needs a memory limit of at least 256 MiB (`memory-limit` before the mesher loads otherwise). A prebuilt mesh (`runMesh`, `analyseMesh`) may have at most 2 elements per node, every node in an element, at most 100,000 faces per body and no more boundary triangles than its elements have faces.

**DOF estimate.** Fit on gmsh's meshes of the benchmark solids, a bonded two-body model and the bracket (20k to 330k DOF: within 6.3 %; the bracket from 50k to 330k within 4 %): `15 * volume / size³ + 16 * surface / size²`, plus for each refinement its band (the faces' area times the integral of 1 / size³ from the face out to where the size has grown back, which is 2 refined sizes plus 2.5 times the difference). It undershoots thin, locally refined parts (the plate with a hole: 5,157 estimated, 10,722 meshed), and refinement by curvature (small holes) is not estimated: a mesh that comes out over the cap anyway is refused by its real count, after meshing and before any solver array exists.

## Accuracy and time

The spike's three benchmarks are tests, within 5 % (`src/solver.test.ts` on structured meshes in every run; `src/gmsh.test.ts` on gmsh's meshes of kernel solids when the mesher is built). Measured 2026-10-10:

| Benchmark (gmsh mesh)                           | DOF    | Error                    |
| ----------------------------------------------- | ------ | ------------------------ |
| Cantilever, Timoshenko tip deflection, M c / I  | 20,511 | -0.78 %, 0.00 %          |
| Plate with a hole, Peterson Kt (mid-plane, max) | 10,722 | +0.47 %, +0.85 %         |
| Thick-walled cylinder, Lame (hoop in/out, u_r)  | 18,807 | -0.10 %, -0.03 %, 0.00 % |

One analysis of the spike's bracket from STEP bytes to nodal stresses (HXT, AMG; Ryzen 5 7600X shared with other agents):

| DOF     | Node 26 | Chromium 153 worker | Mesh  | AMG setup | Solve | Iterations | Solver arrays |
| ------- | ------- | ------------------- | ----- | --------- | ----- | ---------- | ------------- |
| 49,821  | 1.3 s   | 1.5 s               | 0.2 s | 0.4 s     | 0.5 s | 25         | 107 MiB       |
| 182,523 | 4.3 s   | 4.8 s               | 0.6 s | 1.4 s     | 1.9 s | 24         | 362 MiB       |
| 328,170 | 8.2 s   | 9.9 s               | 0.9 s | 2.7 s     | 3.7 s | 26         | 674 MiB       |

The mesher loads in about 60 ms from a compiled module (its first compile is separate). gmsh's memory stayed at its initial 64 MiB. The Chromium runs used a Vite build of `spawnBrowserFeaWorker` served cross-origin isolated (a manual check, not part of the test suite); cancelling during `mesh` and during `solve` both answered `cancelled`.

## The mesher

`wasm/gmsh.mjs` and `wasm/gmsh.wasm` are **built in this repository** by `build/build-gmsh.sh` (no root; about 20 minutes the first time, mostly OpenCASCADE, then 4 minutes). It pins emsdk 3.1.74, cmake and ninja from PyPI by version and SHA-256 (`build/requirements.txt`, installed with `--require-hashes`), OpenCASCADE 7.8.1 by SHA-256 and gmsh by commit, the versions `@loumalouomega/gmsh-wasm` 0.3.0 builds. Differences from that prebuilt package, which is not shipped:

- **No Blossom**, and none of the contribs FEA does not use: gmsh is configured with `DEFAULT=OFF` and `Dlopen Eigen[contrib] Hxt Mesh OpenCASCADE Post QuadMeshingTools Solver TetGen/BR tinyobjloader` (why each, in the script). The build refuses a configuration that names Blossom and a binary with Blossom's code in it; `src/gmsh.test.ts` checks again.
- **Single-threaded** (no OpenMP, no pthreads), so it needs no `SharedArrayBuffer`; the spike measured no gain from gmsh's threads.
- **The memory is imported**: each analysis gets a fresh instance in a fresh `WebAssembly.Memory` whose maximum is gmsh's share of the memory limit, freed with the instance.
- **Only the C API functions `src/gmsh.ts` calls** are exported (`build/exported-functions.json`), with a small typed wrapper instead of the package's generated bindings.
- **Nothing reaches stdout**: gmsh's `print` and `printErr` go to a bounded log that `mesh-failed` errors carry, so a Node host's stdout (the MCP stdio transport) stays clean; the Node worker's own stdout is piped to stderr. `src/gmsh.test.ts` runs an analysis in a child process and checks its stdout is empty.

28.6 MB raw, 7.4 MB gzip, 5.1 MB brotli (the prebuilt: 41.4, 11.6 and 7.8 MB). Loaded lazily by the FEA worker on the first analysis (`import()` of the glue, the `.wasm` as its own asset), never bundled, as ADR 0002 decision 4 asks. `build-info.json` records the toolchain, gmsh's configuration and the SHA-256; two builds gave the same bytes.

## Licences

The module is GPL-2.0-or-later (gmsh, HXT) with OpenCASCADE 7.8.1 (LGPL-2.1-only WITH Open-CASCADE-Exception-1.0) inside it as a separate, replaceable `.wasm` ([ADR 0006](../../docs/adr/0006-licensing.md), amendment of 2026-10-10). `build/components.json` lists every component with its licence; `wasm/licenses/` holds the texts the build copies from the sources it compiled (gmsh's `LICENSE.txt` and `CREDITS.txt`, HXT's, Eigen's, tinyobjloader's, OCCT's, Emscripten's, musl's and libc++'s). `src/licenses.test.ts` checks the record against the build.

## Known limits

- Isotropic linear elasticity only; small deflections; bodies bonded where they touch. Stresses at re-entrant corners and next to point-like fixtures grow without bound as the mesh is refined (the records of T9.6c report the peak away from them).
- Nodal stresses are averaged over the elements at a node, across bodies at a bonded interface too.
- A load on a face between two bonded bodies is applied on one side's elements.
- Faces are matched by the kernel's face order after STEP import; `faceCount` makes a mismatch an error. Proven on the benchmark solids, the bracket and a bonded two-body model.

## Testing

```bash
./node_modules/.bin/vitest run --project packages packages/fea   # all of it, about 15 s
packages/fea/build/build-gmsh.sh [workdir]                       # rebuild the mesher
```

`src/solver.test.ts` (benchmarks on structured meshes, results, solver errors), `src/limits.test.ts` (validation and limits), `src/worker.test.ts` (the protocol in Node worker threads: results, progress, cancellation, both time limits, a dying worker, one at a time, `prepare` dying, hanging and disposed, a fresh worker after `memory-limit`; over a web `MessageChannel`; and the browser handle against a stand-in `Worker`: an `error` event ends the worker once), `src/gmsh.test.ts` (kernel solids through the mesher, face mapping, early refusal, a worker run, a host process whose stdout stays empty, the committed `.wasm` against `build-info.json`'s SHA-256; skipped without `wasm/`), `src/licenses.test.ts`.
