// Regen worker entry: the kernel and the regen engine in one worker (ADR 0007 decision 1). Start
// it from the main thread with `spawnRegenWorker()` from `@manufakture/regen/client`.
//
// `?url` makes Vite emit the kernel's .wasm as its own content-hashed asset, never inlined (ADR
// 0002 decision 4); planegcs.wasm is found by its Emscripten glue next to the bundled JS. Loading
// the kernel starts as soon as the worker starts, so it overlaps the UI's start-up; the solver
// loads on the first sketch solve.

import * as Comlink from 'comlink';
import wasmUrl from 'libcascade/single/wasm?url';
import { createRegenWorkerApi } from './worker-api';

Comlink.expose(createRegenWorkerApi({ source: { url: wasmUrl }, eager: true }));
