# spikes/T8.0a-headless: a headless session in Node (T8.0a)

A prototype of the M8 headless session ([docs/plans/agent-surface.md](../../docs/plans/agent-surface.md),
"The headless session model"): a library on a throwaway Node file system backend, a core
`DocumentStore`, a `RegenEngine` on `createNodeService` and the planegcs solver, text with the bundled
font, and the app's domains. It opens the M1 bracket, the M4 bookshelf and the M6 shed on an agent
branch, applies batches, regenerates, measures, saves and reopens, runs a thousand batches per
fixture, and regenerates the same documents in headless Chromium through the app's own regen worker
to compare them bit for bit. Findings are in
[docs/spikes/T8.0a-headless.md](../../docs/spikes/T8.0a-headless.md).

## Running

The spike has no `package.json` (so it adds nothing to the workspace or the lockfile). It runs with
the repository's own Vitest, from the repository root, after `pnpm install`:

```bash
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/session.test.ts    # sessions, limits, lock: about 15 s
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/cold-              # cold start, a fresh process per fixture
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/longrun-           # 1,000 batches per fixture: about 12 min
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/gc.test.ts         # 1,000 batches with forced collections: about 3 min
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/sessions.test.ts   # several sessions in one process
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/risks.test.ts      # what a Node host must inject
node_modules/.bin/vitest run --root spikes/T8.0a-headless src/browser.test.ts    # Node against Chromium: about 1 min
node_modules/.bin/tsc --noEmit -p spikes/T8.0a-headless                          # typecheck
```

Test files run one at a time (`fileParallelism: false`), each in its own process, so timings and
resident memory are not measured against each other. Each probe writes its numbers to
`results/<probe>.json` with the machine it ran on. `LONG_RUN_BATCHES=n` shortens the long run.
Libraries and the browser build go to `dist/` (git ignores it).

The browser half builds `src/browser/` with Vite into `dist/page` and serves it to Playwright from an HTTP
server on 127.0.0.1 on a port the system picks (a secure context, with COOP/COEP as the app's
development server sends them). A Playwright route on `https://spike.test` is kept only as the
failing control: the text worker the regen worker starts does not load through it. Playwright and Chromium come from `apps/web`
(`apps/web/node_modules/.bin/playwright install chromium`, never `--with-deps`). Without root and
without Chromium's system libraries, unpack them into a directory and set `BROWSER_LIBS` (default
`/tmp/chromelibs/usr/lib`, used when it exists) and `FONTCONFIG_FILE` (default
`/tmp/chromelibs/fonts.conf`).

The code imports workspace packages by relative path (`../../../packages/...`) and the app's e2e
fixtures and regen worker entry read-only (`apps/web/e2e/m4-fixtures.ts`, `shed-fixture.ts`,
`apps/web/src/viewport/regen-spawn.ts`), so it always runs the pinned kernel, solver and font.

## Files

| File                                  | What it is                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session.ts`                      | The prototype session: open on an agent branch (or resume), apply a batch with limits, undo, close                                                          |
| `src/host.ts`                         | The Node host: kernel service, solver, the bundled font read from disk, the app's domains on a registry of its own                                          |
| `src/fs-backend.ts`                   | `StorageBackend` on `node:fs`, and the branch lock (an O_EXCL lock file)                                                                                    |
| `src/vendor/persistence/`             | The library as it was in `apps/web/src/persistence` at 8465bfe (before T8.1a moved it), imports pointed at packages; `mfk.ts` a stub (no `.mfk` files here) |
| `src/fixtures.ts`                     | The three documents and their batches: the story per fixture, and the long run's never-repeating edits                                                      |
| `src/summary.ts`                      | What Node and Chromium are compared on: mesh hashes, name tables, feature results, exact measurements                                                       |
| `src/mathprobe.ts`                    | JavaScript `Math` over fixed inputs, as raw bits, to trace a Node and Chromium difference                                                                   |
| `src/node-summary.ts`                 | A complete regen on a fresh engine in Node, summarized                                                                                                      |
| `src/open.ts`                         | Shared setup: a library on disk with a fixture on Main, a session on it                                                                                     |
| `src/session.test.ts`                 | Each fixture: open, story, ten edits, undo, close, reopen from disk; the limits and the lock                                                                |
| `src/cold.ts`, `cold-*.test.ts`       | Cold start in a fresh process: code, kernel, open with its first regen, first batches, memory at each step                                                  |
| `src/longrun.ts`, `longrun-*.test.ts` | 1,000 batches per fixture: time, wasm heap, recycles, disk, reopen check                                                                                    |
| `src/sessions.test.ts`                | Several sessions per process: memory, taking turns, two sessions on one kernel service                                                                      |
| `src/gc.test.ts`                      | The bracket long run with a full collection every 100 batches: are recycled instances freed                                                                 |
| `src/risks.test.ts`                   | What breaks when a Node host leaves out the font reader or the domains                                                                                      |
| `src/browser.test.ts`                 | Builds the page, regenerates in Node and in Chromium, compares                                                                                              |
| `src/browser/`                        | The page: the app's regen worker per document, summarized with `summary.ts`                                                                                 |
| `results/`                            | The numbers behind the report                                                                                                                               |
