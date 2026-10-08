// A session's worker thread (`WorkerEngine`): the regen worker API (engine, kernel, solver,
// bundled fonts, domains) on the libcascade module the main thread compiled, exposed over Comlink
// on the port the main thread sent. Terminating the worker frees its kernel instance at once.

import { workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { sessionEngineApi } from '../node-host';

const { port, module } = workerData as { port: MessagePort; module: WebAssembly.Module };

Comlink.expose(sessionEngineApi({ module }), port as unknown as Comlink.Endpoint);
