// Main-thread side of the kernel worker (ADR 0007): `KernelClient` (see
// kernel-client.ts) and `spawnKernelWorker`, which starts the kernel's own
// worker entry.

import { KernelClient, type KernelClientOptions } from './kernel-client';

export { KernelClient, type KernelClientOptions, type KernelEndpoint } from './kernel-client';

/** Start the kernel worker and connect to it. Call it at app start-up (ADR 0002). */
export function spawnKernelWorker(options: KernelClientOptions = {}): KernelClient {
  return new KernelClient(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-kernel',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  }, options);
}
