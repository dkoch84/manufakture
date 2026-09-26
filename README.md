# manufakture

Parametric CAD that runs in the browser, for 3D printing, woodworking, CNC and home construction.

The aim is the openness of FreeCAD with the usability of Onshape: sketch, constrain, build features, and export something a printer, a CNC or a builder can use.

Early days: nothing works yet.

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

The dev and preview servers send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so the page is cross-origin isolated (needed for `SharedArrayBuffer` in the geometry workers). The app logs `crossOriginIsolated` to the console on startup.

## Layout

```
apps/web            React UI
packages/core       Document model (pure TS)
packages/kernel     Worker-hosted OpenCascade (WASM) wrapper
packages/sketch     Sketch entities + planegcs solver wrapper
packages/regen      Regeneration engine
packages/units      Unit parsing/formatting, expressions
packages/io         Import/export adapters
docs/decisions      Decision records
```

Packages are consumed from source (`exports` points at `src/index.ts`), so there is no per-package build step.

## License

manufakture is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later).

The geometry kernel, OpenCascade Technology, is licensed under LGPL-2.1 (with the OCCT exception) and is loaded at runtime as a separate, replaceable `.wasm` module. See [docs/decisions/0000-product-decisions.md](docs/decisions/0000-product-decisions.md) for the reasoning.
