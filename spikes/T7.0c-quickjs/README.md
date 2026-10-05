# spikes/T7.0c-quickjs: QuickJS in the regen worker (T7.0c)

Measures quickjs-emscripten 0.32.0 (Bellard's QuickJS and QuickJS-ng, each as the synchronous
release build and the asyncified one) for ADR 0010: `.wasm` sizes, load and first run, per host
call overhead, a script driving the kernel synchronously against the asyncified build awaiting
`KernelService.run`, interrupt latency, memory and stack limits, values crossing the binding, the
cost of one more instance from a compiled module, the Asyncify exception to context isolation,
an arithmetic loop against the host JIT, the TypeScript erasure candidates, and a determinism
script compared bit for bit across Node, Chromium, Firefox and WebKit. Findings are in
[docs/spikes/T7.0c-quickjs.md](../../docs/spikes/T7.0c-quickjs.md).

## Running

From the repository root, after adding the spike to the workspace and running `pnpm install`
(see [spikes/README.md](../README.md)):

```bash
pnpm --filter @manufakture/spike-t7-0c-quickjs test        # checks, a few seconds
pnpm --filter @manufakture/spike-t7-0c-quickjs measure     # every number in the report, about 10 min
pnpm --filter @manufakture/spike-t7-0c-quickjs typecheck
```

`measure` writes `results/sizes.json`, `results/node.json`, `results/browsers.json` and
`results/determinism.json`. `ONLY=sizes,node,browsers` runs some parts; the browser part compares
against the Node determinism output, so run `node` first (it is cached in `dist/`, which git
ignores).

The browser part builds `index.html` and `src/worker.ts` with Vite into `dist/` and serves it to
Playwright through a route on `https://spike.test` (no port, and a secure context, so the
COOP/COEP headers make the page cross-origin isolated for the finest timers). It needs the three
browsers (`pnpm exec playwright install chromium firefox webkit`, never `--with-deps`).

Without root and without the browsers' system libraries, unpack them into a directory and point
the run at it:

- `BROWSER_LIBS` (default `/tmp/chromelibs/usr/lib`) becomes `LD_LIBRARY_PATH` for the browsers,
  and `FONTCONFIG_FILE` a `fonts.conf` whose `<dir>` points at unpacked fonts;
- `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`, since Playwright checks the system paths, not
  `LD_LIBRARY_PATH`;
- `WEBKIT_EXECUTABLE`: WebKit's own launcher (`minibrowser-wpe/MiniBrowser`) overwrites
  `LD_LIBRARY_PATH`, so point this at a copy of that wrapper that appends the unpacked libraries
  (WebKit 26.6 also wanted ICU 74, `libxml2.so.2`, GStreamer, libmanette, flite and hyphen, and
  `__EGL_VENDOR_LIBRARY_DIRS` plus `EGL_PLATFORM=surfaceless` for Mesa's EGL).

## Files

| File                   | What it is                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `src/variants.ts`      | The four variants, instantiated from a compiled `WebAssembly.Module` and a caller's `Memory` |
| `src/sandbox.ts`       | A minimal ADR 0010 host: no `Date`, seeded `Math.random`, `host.*` functions, plain data     |
| `src/bench.ts`         | Every measurement, written once against a small `BenchEnv` (Node or browser worker)          |
| `src/tasks.ts`         | The task list both harnesses run                                                             |
| `src/determinism.ts`   | The determinism script (Math, `Math.pow`, number formatting, sort) and the comparison        |
| `src/worker.ts`        | The browser module worker: QuickJS and the kernel loaded as the regen worker would           |
| `src/main.ts`          | The page that starts the worker and publishes the reply for Playwright                       |
| `src/spike.test.ts`    | The fast checks                                                                              |
| `scripts/measure.ts`   | The measurement run (a vitest file, so the kernel's TypeScript resolves)                     |
| `scripts/browser.ts`   | Vite build plus the Playwright runner                                                        |
| `scripts/erasure.ts`   | TypeScript erasure: bundle sizes, erase time, positions, syntax cases                        |
| `scripts/entries/*.ts` | Bundle-size entries for the erasure tools and the QuickJS host JavaScript                    |
| `scripts/node-env.ts`  | The Node side of `BenchEnv`                                                                  |

The package is private and outside the workspace, so the root typecheck, lint and test do not
cover it.
