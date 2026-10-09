// A session's worker thread (`WorkerEngine`): the regen worker API (engine, kernel, solver, fonts,
// scripts, domains) on the libcascade module the main thread compiled, exposed over Comlink on
// the port the main thread sent. Terminating the worker frees its kernel instance at once.
//
// Scripted features run here, on the QuickJS module the main thread compiled, under the script
// package's limits; the main thread is the hard bound (ADR 0010 amendment, item 4). Every run's
// start and end goes to it on `watch`, and the watchdog is set before the API is exposed, so no
// script ever runs unwatched; `runaway` lists the runs it stopped before, which fail with a
// timeout instead of running again. Which scripts run is the session's policy (`engine.ts`).

import { workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { sessionEngineApi, type TextWorkerOptions } from '../node-host';

const { port, module, scripts, watch, runaway, textWorker } = workerData as {
  port: MessagePort;
  module: WebAssembly.Module;
  scripts?: WebAssembly.Module;
  watch?: MessagePort;
  runaway?: string[];
  textWorker?: TextWorkerOptions;
};

// Scripts only with the watchdog's channel: without one, none runs.
const { api } = sessionEngineApi(
  { module },
  {
    ...(scripts && watch ? { scripts } : {}),
    ...(textWorker ? { textWorker } : {}),
  },
);
if (watch) await api.watchScripts((event) => watch.postMessage(event), runaway ?? []);

Comlink.expose(api, port as unknown as Comlink.Endpoint);
