// Starts the app's regen worker (regen-worker.ts: regen's worker with the app's domains
// registered). A module of its own, since Vite bundles the worker of every module that holds a
// `new Worker(new URL(...))` call; only the kernel scene loader imports it.

import { RegenClient, type RegenClientOptions } from '@manufakture/regen/client';

export function spawnAppRegenWorker(options: RegenClientOptions = {}): RegenClient {
  return new RegenClient(() => {
    const worker = new Worker(new URL('./regen-worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-kernel',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  }, options);
}
