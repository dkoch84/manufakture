# spikes/opencamlib: OpenCAMLib in WASM against a TypeScript drop-cutter (T5.0b)

Probes for M5's 3D surfacing: OpenCAMLib (OCL) built by us with Emscripten as an ES module plus a
separate `.wasm`, run on the M1 bracket and on a 99,200-triangle filleted part; and a TypeScript
drop-cutter for flat, ball and V cutters compared with it point by point. Findings and the
recommendation are in [docs/spikes/T5.0b-opencamlib.md](../../docs/spikes/T5.0b-opencamlib.md).

## Building OCL

```bash
spikes/opencamlib/build/build-ocl.sh [workdir]   # default workdir /tmp/ocl-build
```

No root and no container (a local script; not yet run in CI): the script fetches emsdk (checkout
and SDK version pinned), cmake and ninja (pinned PyPI versions, in a venv), Boost 1.89.0 headers (checked against a SHA-256) and `aewallin/opencamlib` at a pinned commit
into the work directory, replaces upstream's `src/emscriptenlib/emscriptenlib.cmake` with
[`build/emscriptenlib.cmake`](build/emscriptenlib.cmake) in a scratch copy, and builds. The
bindings themselves (`emscriptenlib.cpp`) are upstream's, unchanged. Output goes to `build/dist/`
(gitignored, and skipped by lint and format like every `dist/`): `ocl.mjs`, `ocl.wasm`,
`build-info.json` (Emscripten, emsdk commit, cmake, ninja, OCL and Boost versions, sizes, SHA-256) and `licenses/`. The build takes 8 to 14 seconds
once the downloads are in place.

## Running

The spike has no `package.json` (so it adds nothing to the workspace or the lockfile). It runs with
the repository's own Vitest, from the repository root, after `pnpm install`:

```bash
node_modules/.bin/vitest run --root spikes/opencamlib                       # everything, about 12 minutes
node_modules/.bin/vitest run --root spikes/opencamlib src/dropcutter.test.ts  # the TS cutter alone, seconds
node_modules/.bin/vitest run --root spikes/opencamlib --silent=false --reporter=verbose  # with the probes' rows
node_modules/.bin/tsc --noEmit -p spikes/opencamlib                         # typecheck
```

Without `build/dist/` the OCL probes are skipped and only the TypeScript cutter's tests run.
`OCL_RUNS=n` sets the timed runs per cell in `compare.test.ts` (default 3, after one first run).
Test files run one at a time so timings do not compete; each probe writes its numbers to
`results/<probe>.json` with the machine and the OCL build it ran on.

The browser half of `worker.test.ts` launches headless Chromium through `apps/web`'s
`@playwright/test`. It is skipped when that package or its browser is missing. On a machine without
Chromium's system libraries, unpack them somewhere and pass
`PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH=<dir>/usr/lib FONTCONFIG_FILE=<dir>/fonts.conf`.

## Files

| File                        | What it is                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `build/build-ocl.sh`        | The reproducible OCL build: pinned emsdk, Boost and OCL commit; ES module plus separate `.wasm` |
| `build/emscriptenlib.cmake` | Our replacement for upstream's link setup (no `SINGLE_FILE`, no closure, C++17 for embind)      |
| `src/dropcutter.ts`         | The TypeScript drop-cutter: flat, ball and V cutters, vertex, facet and edge tests, XY grid     |
| `src/geometry.ts`           | Mesh type, bounds, raster lines sampled like OCL's PathDropCutter, point-triangle distance      |
| `src/meshes.ts`             | The M1 bracket and the filleted part, built with `packages/kernel`, welded with `packages/io`   |
| `src/ocl.ts`                | Loading the build and wrapping the upstream embind API (every object deleted)                   |
| `src/cases.ts`              | Shared cutters and raster, and checks that trust neither cutter (distance, brute-force bound)   |
| `src/dropcutter.test.ts`    | The TS cutter against closed-form answers and a brute-force bound on random meshes              |
| `src/compare.test.ts`       | OCL PathDropCutter against the TS cutter: time and max Z difference, both meshes, four tools    |
| `src/ocl.test.ts`           | AdaptivePathDropCutter, Waterline and AdaptiveWaterline sanity; heap over repeated runs         |
| `src/worker.test.ts`        | OCL in a Node worker thread and in a browser module worker (the `.wasm` as its own request)     |
| `src/node-worker.ts`        | The Node worker (plain Node type stripping)                                                     |
| `src/browser/worker.js`     | The browser worker                                                                              |
| `src/meshes.test.ts`        | Builds and caches the meshes (`.cache/`, gitignored)                                            |
| `results/`                  | The numbers behind the report                                                                   |
