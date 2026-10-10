// Starts the FEA worker in a browser: a module worker of its own. Kept apart from client.ts so
// that importing the runner does not make a bundler emit the worker (Vite bundles any
// `new Worker(new URL(...))` it sees in an imported module).

import * as Comlink from 'comlink';
import type { FeaWorkerHandle } from './client';
import type { FeaWorkerApi } from './worker/api';

export function spawnBrowserFeaWorker(): FeaWorkerHandle {
  const worker = new Worker(new URL('./worker/browser.ts', import.meta.url), {
    type: 'module',
    name: 'fea',
  });
  type Listener = Parameters<FeaWorkerHandle['onExit']>[0];
  const listeners: Listener[] = [];
  let ended = false;
  // A dedicated worker reports a crash, and also any uncaught error in a worker that is still
  // alive, as an `error` event: there is no telling them apart from here. Either way the worker
  // is ended, so an orphan never keeps running beside the next run's worker, and the listeners
  // hear about it once. (A browser that kills a worker for running out of memory usually sends
  // no event at all; the runner's time limit settles that run.)
  worker.addEventListener('error', (event: Event) => {
    if (ended) return;
    ended = true;
    worker.terminate();
    const message = (event as ErrorEvent).message ?? '';
    for (const listener of listeners.splice(0)) {
      listener({
        message: message || 'the worker crashed',
        outOfMemory: /memory/i.test(message),
      });
    }
  });
  return {
    api: Comlink.wrap<FeaWorkerApi>(worker),
    terminate() {
      ended = true;
      listeners.length = 0;
      worker.terminate();
    },
    onExit(listener) {
      if (!ended) listeners.push(listener);
    },
  };
}
