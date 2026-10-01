# manufakture

Parametric CAD that runs in the browser, for 3D printing, woodworking, CNC and home construction.

The aim is the openness of FreeCAD with the usability of Onshape: sketch, constrain, build features, and export something a printer, a CNC or a builder can use.

## Status

Milestone 1 (a printable part) is done. It all runs in the browser: there is no account and no server, and documents are kept locally and move between machines as `.mfk` files. What works today:

- sketches with dimensions and constraints, solved as you draw;
- extrude, revolve, fillet, chamfer, shell, holes (standard clearance, counterbore and countersink sizes), patterns and mirror;
- document variables and expressions (`2*#thickness + 1`) that drive any dimension;
- a feature tree with a rollback bar, editing, reordering and undo;
- exact measurements: distances, angles, radii, areas, volume and mass;
- export to STL, 3MF and STEP, and import of STEP and STL as reference bodies;
- local-first storage: saving as you go, a documents list, and `.mfk` import and export.

Not there yet: multi-body parts, assemblies, and the domain tools for 3D printing, woodworking, CNC and construction (see the plans in `docs/plans`).

[docs/m1-acceptance.md](docs/m1-acceptance.md) walks through the milestone's acceptance part, a bracket, and lists the automated checks behind each step.

## Quick start

Requires Node.js 22 or newer and pnpm (the version is pinned in `package.json`; `corepack enable` will pick it up).

```sh
pnpm install
pnpm dev        # start the web app at http://localhost:5173
```

Other tasks (also available as `make <target>`):

```sh
pnpm typecheck  # TypeScript, all packages
pnpm lint       # ESLint + Prettier check
pnpm test       # Vitest, all packages
pnpm build      # production build of the web app
```

The browser tests (Playwright, headless Chromium) run from the web app:

```sh
pnpm --filter @manufakture/web e2e:install  # once: download Chromium
pnpm --filter @manufakture/web e2e
```

The dev and preview servers send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so the page is cross-origin isolated (needed for `SharedArrayBuffer` in the geometry workers). The app logs `crossOriginIsolated` to the console on startup.

## Using it

The user guide lives in `docs/user`:

- [Documents and files](docs/user/files.md): local storage, the Documents screen, `.mfk` files
- [Part studios](docs/user/part-studios.md): several parts in one document, as tabs
- [Sketches](docs/user/sketcher.md): drawing, constraints and dimensions
- [Features](docs/user/features.md): extrude, revolve, fillet, chamfer, shell, hole, pattern, mirror
- [Bodies](docs/user/bodies.md): several bodies in a part, their names, colours and materials, hiding and exporting them
- [The feature tree](docs/user/feature-tree.md): editing, reordering, suppressing, the rollback bar
- [Variables](docs/user/variables.md): named values and expressions
- [Configurations](docs/user/configurations.md): variants in a table, switching them, exporting every one
- [Version history](docs/user/history.md): named versions, the timeline, viewing and restoring a past state
- [Measuring](docs/user/measure.md): exact measurements, material and mass
- [The 3D viewport](docs/user/viewport.md): mouse, views, selection and section view
- [Importing and exporting](docs/user/import-export.md): STL, 3MF, STEP, and checking a 3MF in a slicer

## Layout

```
apps/web            React UI
packages/core       Document model (pure TS)
packages/kernel     Worker-hosted OpenCascade (WASM) wrapper
packages/sketch     Sketch entities + planegcs solver wrapper
packages/regen      Regeneration engine
packages/units      Unit parsing/formatting, expressions
packages/io         Import/export adapters
docs/decisions      Product decision records
docs/adr            Architecture decision records
docs/user           User guide
docs/plans          Plans for the milestones after M1
docs/spikes         Write-ups of the early technical spikes
docs/research       Background research (slicer hand-off, 3MF)
spikes/             Spike code and raw results behind docs/spikes (not part of the app)
```

Packages are consumed from source (`exports` points at `src/index.ts`), so there is no per-package build step.

## License

manufakture is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later).

The geometry kernel, OpenCascade Technology, is licensed under LGPL-2.1 (with the OCCT exception) and is loaded at runtime as a separate, replaceable `.wasm` module. See [docs/decisions/0000-product-decisions.md](docs/decisions/0000-product-decisions.md) for the reasoning.
