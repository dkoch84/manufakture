// Kernel worker entry (ADR 0007, decision 1). Start it from the main thread
// with `spawnKernelWorker()` from `@manufakture/kernel/client`, which creates
// `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
//
// `?url` makes Vite emit the .wasm as its own content-hashed asset, never
// inlined into JavaScript (ADR 0002, decision 4). Loading starts as soon as
// the worker starts, so it overlaps the UI's start-up.

import * as Comlink from 'comlink';
import wasmUrl from 'libcascade/single/wasm?url';
import { createKernelWorkerApi } from './worker-api';

Comlink.expose(createKernelWorkerApi({ source: { url: wasmUrl }, eager: true }));
