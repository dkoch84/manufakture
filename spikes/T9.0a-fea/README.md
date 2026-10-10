# spikes/T9.0a-fea: FEA in the browser (T9.0a)

Linear static stress analysis of kernel solids in a browser worker: the kernel (libcascade through
`packages/kernel`) writes a body as STEP, gmsh compiled to WebAssembly (`@loumalouomega/gmsh-wasm`)
meshes it into quadratic tetrahedra (TET10), and a TypeScript solver assembles, solves with
conjugate gradients preconditioned by smoothed-aggregation algebraic multigrid (AMG), and recovers
nodal stresses. Benchmarks against beam theory, Peterson's Kt and Lame; time and memory at 50k,
200k and 500k degrees of freedom in Node, Chromium, Firefox and WebKit. fTetWild
(`float-tetwild-wasm`) is tried as the alternative mesher. Findings are in
[docs/spikes/T9.0a-fea.md](../../docs/spikes/T9.0a-fea.md).

## Running

The spike has a `package.json` for its two npm dependencies only (the meshers); it imports the
kernel by relative path (`../../../packages/kernel/src/node.ts`). Install them into this folder with
npm, which leaves the workspace and `pnpm-lock.yaml` alone (`node_modules/` is ignored by git):

```bash
cd spikes/T9.0a-fea && npm install --no-package-lock && cd ../..
```

Adding the folder to `pnpm-workspace.yaml` and running `pnpm install`, as
[spikes/README.md](../README.md) describes, works as well. Then, from the repository root, with
the repository's own Vitest:

```bash
V="node_modules/.bin/vitest run --root spikes/T9.0a-fea --silent=false --reporter=verbose"
$V src/accuracy.test.ts         # the three benchmarks at three densities: about 10 s
$V src/scaling.test.ts          # 50k, 200k, 500k DOF, AMG and IC(0), two solids: about 3 min
$V src/preconditioners.test.ts  # Jacobi, block Jacobi, IC(0) (two orders), AMG: about 1 min
$V src/meshing.test.ts          # gmsh threads and 3D algorithms at about 500k DOF
$V src/faces.test.ts            # kernel face order against gmsh surface tags after STEP
$V src/tetwild.test.ts          # fTetWild on the thick-walled cylinder: about 30 s
$V src/browser.test.ts          # the same pipeline in a browser worker: about 1 min per browser
node_modules/.bin/tsc --noEmit -p spikes/T9.0a-fea   # typecheck
```

Test files run one at a time (`fileParallelism: false`). Each writes `results/<probe>.json` with the
machine it ran on (and the load average, for the timing probes). The kernel builds the benchmark
solids once and caches their STEP files in `dist/step/` (ignored by git); delete it to rebuild.

`scaling.test.ts` takes `TARGETS=50000,200000`, `PRECONDITIONERS=amg,ic0`, `SOLIDS=bracket` and
`OUT=<name>` to run a subset. `browser.test.ts` reads the mesh sizes from
`results/scaling-node.json`, so run the Node scaling probe first; it takes `BROWSER=chromium`
(default), `firefox` or `webkit`, `ACCURACY=0` to skip the benchmarks,
`SCALING=bracket:1000000:1.365` (solid:target:mesh size) to time other sizes, and `OUT=<name>`.

### Browsers without root

The browser probe builds `src/browser/` with Vite into `dist/page` and serves it, with gmsh's files
as they are and the STEP files, from an HTTP server on 127.0.0.1 on a port the system picks, with
COOP/COEP headers (gmsh-wasm is a pthreads build, so it needs `SharedArrayBuffer`). Playwright comes
from `apps/web`: `apps/web/node_modules/.bin/playwright install chromium firefox webkit` (never
`--with-deps`; the install's host check fails without the system libraries, but the browsers are
downloaded anyway).

Without root, unpack the browsers' libraries into a directory (the `pacman -Sw --dbpath` recipe:
copy `/var/lib/pacman/local` to a scratch db, `pacman -Sy` and `pacman -Sw` into a scratch cache,
`tar --zstd -xf` each package) and point the run at it:

- `BROWSER_LIBS` (default `/tmp/chromelibs/usr/lib`) becomes `LD_LIBRARY_PATH`, and
  `FONTCONFIG_FILE` (default `/tmp/chromelibs/fonts.conf`) a `fonts.conf` whose `<dir>` points at
  the unpacked fonts.
- Chromium: `nss nspr atk at-spi2-core libx11 libxcomposite libxdamage libxext libxfixes libxrandr
mesa libxcb libxkbcommon alsa-lib fontconfig freetype2 ttf-dejavu`.
- Firefox: add `gtk3 pango cairo gdk-pixbuf2 libxcursor libxi libxrender dbus-glib`, and set
  `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.
- WebKit: add `libavif enchant flite gstreamer gst-plugins-base-libs gst-plugins-bad-libs
harfbuzz-icu hyphen libmanette opus libxml2-legacy libxslt woff2`, ICU 74 from the Arch archive,
  symlinks for the six flite voices Arch lacks, and `WEBKIT_EXECUTABLE` pointing at a copy of
  `minibrowser-wpe/MiniBrowser` that appends the unpacked libraries to `LD_LIBRARY_PATH` (the
  original overwrites it) and sets `__EGL_VENDOR_LIBRARY_DIRS` and `EGL_PLATFORM=surfaceless`.

The browser probe samples the resident memory of the browser's processes from `/proc` every 100 ms
while the worker reports a run in progress, so it needs Linux.

## Files

| File                               | What it is                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/tet10.ts`                     | TET10 shape functions, element stiffness (isotropic, 4-point Gauss), stress at the element's nodes, von Mises                    |
| `src/mesh.ts`                      | gmsh: STEP in, TET10 out (node order mapped geometrically to ours); boundary faces                                               |
| `src/order.ts`                     | Reverse Cuthill-McKee renumbering of the nodes                                                                                   |
| `src/solver.ts`                    | Block-sparse assembly (upper 3x3 blocks), constraints, surface tractions and pressures, Jacobi, block Jacobi, IC(0), PCG, stress |
| `src/amg.ts`                       | Smoothed-aggregation AMG: rigid body modes, aggregation, smoothed prolongator, Galerkin coarse levels, Chebyshev V-cycle         |
| `src/run.ts`                       | One analysis, start to finish, with a timing per phase; shared by Node and the browser worker                                    |
| `src/cases.ts`                     | The benchmarks (geometry sizes, densities, constraints, loads, analytical values) and the scaling problem                        |
| `src/geometry.ts`                  | The benchmark solids built by the kernel and written as STEP (Node only)                                                         |
| `src/node-env.ts`                  | Node helpers: load gmsh, cache STEP files, write results                                                                         |
| `src/browser/`                     | The page and the FEA worker for the browser probe                                                                                |
| `src/*.test.ts`                    | The probes listed above                                                                                                          |
| `results/accuracy.json`            | Each benchmark at three densities against its analytical values (Node)                                                           |
| `results/scaling-node.json`        | 50k, 200k, 500k DOF on two solids, AMG and IC(0), timing per phase and memory (Node)                                             |
| `results/browser-*.json`           | The benchmarks and the AMG scaling runs in Chromium, Firefox and WebKit, with per-run peak resident memory                       |
| `results/browser-chromium-1m.json` | One run at about 940k DOF in Chromium, in a fresh page                                                                           |
| `results/preconditioners.json`     | Five preconditioners on the medium and fine cantilever                                                                           |
| `results/meshing.json`             | gmsh's Delaunay against HXT, one thread against all cores                                                                        |
| `results/faces.json`               | Kernel face index against gmsh surface tag after the STEP hand-over                                                              |
| `results/tetwild.json`             | fTetWild on the thick-walled cylinder at three edge lengths                                                                      |
