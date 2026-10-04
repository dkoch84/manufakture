// Regen worker entry: the kernel and the regen engine in one worker (ADR 0007 decision 1). Start
// it from the main thread with `spawnRegenWorker()` from `@manufakture/regen/spawn`.
//
// `?url` makes Vite emit the kernel's .wasm as its own content-hashed asset, never inlined (ADR
// 0002 decision 4); planegcs.wasm is found by its Emscripten glue next to the bundled JS. Loading
// the kernel starts as soon as the worker starts, so it overlaps the UI's start-up; the solver
// loads on the first sketch solve. web-ifc's single-threaded `.wasm` (IFC export, T6.6a) is its own
// asset too, fetched only on the first export: only its URL is known up front.
//
// QuickJS's `.wasm` (scripted features, ADR 0010) is an asset of its own too, fetched and compiled
// on the first scripted feature; every document then gets its own instance of it.
//
// Text is laid out in a text worker of its own, started on the first text and run under a
// watchdog: a font that hangs or runs out of memory costs that worker, never this one (ADR 0011's
// amendment; README, "Text").

import quickjsWasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { ScriptEngine } from '@manufakture/script';
import * as Comlink from 'comlink';
import wasmUrl from 'libcascade/single/wasm?url';
import ifcWasmUrl from 'web-ifc/web-ifc.wasm?url';
import { createWatchdogOutliner } from './text';
import { spawnTextWorker } from './text-spawn';
import { createRegenWorkerApi } from './worker-api';

Comlink.expose(
  createRegenWorkerApi({
    source: { url: wasmUrl },
    eager: true,
    engine: {
      text: createWatchdogOutliner(spawnTextWorker),
      scripts: { engine: () => ScriptEngine.load({ url: quickjsWasmUrl }) },
    },
    ifcWasmUrl,
  }),
);
