// Starts the text worker. Kept in a module of its own: a bundler emits the worker for every module
// that holds a `new Worker(new URL(...))`, used or not, so only `worker.ts` imports this one.

import type { WorkerLike } from './watchdog';

export function spawnTextWorker(): WorkerLike {
  return new Worker(new URL('./text-worker.ts', import.meta.url), {
    type: 'module',
    name: 'manufakture-text',
  });
}
