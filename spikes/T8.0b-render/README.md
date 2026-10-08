# spikes/T8.0b-render: rendering views without a browser (T8.0b)

Three ways for a headless session to make images of a model, compared on the M1 bracket, the M4
bookshelf and the M6 shed (plus the T6.5d house, for the cost of many framing members): a
TypeScript software rasteriser of regen meshes, hidden-line SVG from the drawing pipeline
rasterised to PNG, and, as a reference, the T7.3b viewer in headless Chromium. Findings and the
recommendation are in [docs/spikes/T8.0b-render.md](../../docs/spikes/T8.0b-render.md).

## Running

The spike has no `package.json` (so it adds nothing to the workspace or the lockfile). It runs with
the repository's own Vitest, from the repository root, after `pnpm install`:

```bash
node_modules/.bin/vitest run --root spikes/T8.0b-render src/software.test.ts   # approach 1, about 1 minute
node_modules/.bin/vitest run --root spikes/T8.0b-render src/hlr.test.ts        # approach 2, about 15 s
node_modules/.bin/vitest run --root spikes/T8.0b-render src/chromium.test.ts   # approach 3 (setup below)
node_modules/.bin/vitest run --root spikes/T8.0b-render src/samples.test.ts    # detail crops, after 1 and 2
node_modules/.bin/vitest run --root spikes/T8.0b-render --silent=false --reporter=verbose   # all, with the log lines
node_modules/.bin/tsc --noEmit -p spikes/T8.0b-render                          # typecheck
```

Test files run one at a time (`fileParallelism: false`) so timings do not compete. `RENDER_RUNS=n`
sets the timed runs per image (default 5, after one warm-up). Each test writes its numbers to
`results/<approach>.json` with the machine it ran on, full-size renders to `/tmp/t80b-render`
(`T80B_SCRATCH`), and the samples kept in `docs/spikes/T8.0b-render/`.

Determinism is checked twice: every timed run of an image must give the same PNG bytes, and each
test stores its PNG hashes in `results/<approach>-hashes.json` and compares them with the previous
run's. Run a test twice; the second run fails if any image changed. Delete the hash file after
changing a renderer on purpose.

## What it uses, and how

- **Workspace packages by path** (`packages/core`, `regen`, `kernel`, `sketch`, `stock`,
  `domain-wood`, `domain-construction`, `drawing`, `io`): the real kernel (libcascade through
  `createNodeService`) and solver, as `packages/regen/src/integration.test.ts` does.
- **The app's e2e fixtures by path**: `apps/web/e2e/m4-fixtures.ts` (the bookshelf batch) and
  `apps/web/e2e/shed-fixture.ts` (the shed batch). They import `@playwright/test`, which
  `vitest.config.ts` points at a stub, since only their command builders are used. The M1 bracket
  is built through the UI in the e2e tests, so `src/fixtures.ts` rebuilds it with commands to the
  same dimensions and checks its volume against the e2e test's hand computation.
- **fflate** from `packages/io/node_modules` (the PNG encoder); **sharp** from
  `node_modules/.pnpm/node_modules` (a transitive dependency of gltf-transform, used only as the
  SVG rasteriser to compare against); **playwright-core** through `apps/web`'s Playwright.

## Setup for the Chromium reference

`chromium.test.ts` skips itself when the viewer build is missing. It needs:

1. **The viewer, as a test build, outside the repository.** `window.__manufakture` exists only in
   `VITE_E2E=1` builds. When other work is in progress in the checkout, build from a clean copy of
   `HEAD` (symlink the root `node_modules`, copy each workspace package's `node_modules` links):

   ```bash
   git archive HEAD | tar -x -C /tmp/t80b-src
   cd /tmp/t80b-src/apps/web
   VITE_E2E=1 <repo>/node_modules/.bin/vite build --outDir /tmp/t80b-viewer --emptyOutDir
   ```

   `T80B_VIEWER` points elsewhere. Pages and bundles are served through `page.route`, so no port
   is opened.

2. **Chromium.** `apps/web/node_modules/.bin/playwright install chromium` (without
   `--with-deps`, which wants root). In a minimal container its shared libraries and a font are
   missing; unpack them without root (`T80B_CHROME_LIBS`, default `/tmp/chromelibs`):

   ```bash
   cp -r /var/lib/pacman/local /tmp/pac/db/ && pacman -Sy --dbpath /tmp/pac/db
   pacman -Sw --dbpath /tmp/pac/db --cachedir /tmp/pac/cache nss nspr atk at-spi2-core libx11 \
     libxcomposite libxdamage libxext libxfixes libxrandr mesa libxcb libxkbcommon alsa-lib \
     fontconfig freetype2 ttf-dejavu
   # unpack every package into /tmp/chromelibs, then write /tmp/chromelibs/fonts.conf with
   # <dir>/tmp/chromelibs/usr/share/fonts</dir>
   ```

   The same `fonts.conf` is given to librsvg (through sharp) in `hlr.ts` when present: without
   fonts, the dimension text of the framing elevation renders as boxes.

## Files

| File                     | What it is                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/fixtures.ts`        | The documents (bracket, bookshelf, shed, house), the regen session, the scene (bodies and member instances) |
| `src/raster.ts`          | Approach 1: the software rasteriser (orthographic, depth buffer, flat shading, edges, silhouettes, SSAA)    |
| `src/png.ts`             | PNG encoder: adaptive row filters, zlib through fflate                                                      |
| `src/hlr.ts`             | Approach 2: a drawing per view through `drawingView`/`drawingSheet`, `drawingToSvg`, sharp and a TS stroker |
| `src/chromium.ts`        | Approach 3: `.mfkview` from the scene (members baked into bodies), the viewer in Chromium, screenshots      |
| `src/results.ts`         | Results, images, timing helpers                                                                             |
| `src/software.test.ts`   | Approach 1 measured: four views per fixture, variants, framing only, highlight, tiled houses                |
| `src/hlr.test.ts`        | Approach 2 measured: four views per fixture plus the framing elevations                                     |
| `src/chromium.test.ts`   | Approach 3 measured: four views per fixture, two browser launches                                           |
| `src/samples.test.ts`    | Detail crops of approaches 1 and 2 for the write-up                                                         |
| `src/playwright-stub.ts` | Stands in for `@playwright/test` when the e2e fixture modules load in Node                                  |
