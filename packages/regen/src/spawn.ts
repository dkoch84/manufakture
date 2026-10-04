// Starts regen's own worker (`worker.ts`: the kernel and the regen engine) and connects to it. A
// module of its own, apart from `client.ts`: Vite bundles the worker of every module that holds a
// `new Worker(new URL(...))` call, used or not, so a host that starts a worker entry of its own
// (apps/web's regen-worker.ts, with its domains registered) imports `RegenClient` from
// `@manufakture/regen/client` and never pulls this worker into its build.

import { RegenClient, type RegenClientOptions } from './client';

/** Start the regen worker (the kernel plus the regen engine) and connect to it. */
export function spawnRegenWorker(options: RegenClientOptions = {}): RegenClient {
  return new RegenClient(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-kernel',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  }, options);
}
