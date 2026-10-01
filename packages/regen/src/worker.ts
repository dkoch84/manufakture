// Regen worker entry: the kernel and the regen engine in one worker (ADR 0007 decision 1). Start
// it from the main thread with `spawnRegenWorker()` from `@manufakture/regen/client`.
//
// `?url` makes Vite emit the kernel's .wasm as its own content-hashed asset, never inlined (ADR
// 0002 decision 4); planegcs.wasm is found by its Emscripten glue next to the bundled JS. Loading
// the kernel starts as soon as the worker starts, so it overlaps the UI's start-up; the solver
// loads on the first sketch solve.
//
// Text is laid out in a text worker of its own, started on the first text and run under a
// watchdog: a font that hangs or runs out of memory costs that worker, never this one (ADR 0011's
// amendment; README, "Text").

import * as Comlink from 'comlink';
import wasmUrl from 'libcascade/single/wasm?url';
import { createWatchdogOutliner } from './text';
import { spawnTextWorker } from './text-spawn';
import { createRegenWorkerApi } from './worker-api';

Comlink.expose(
  createRegenWorkerApi({
    source: { url: wasmUrl },
    eager: true,
    engine: { text: createWatchdogOutliner(spawnTextWorker) },
  }),
);
