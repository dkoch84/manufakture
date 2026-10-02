// Starts the nesting worker. A module of its own, since Vite bundles the worker of every module
// that holds a `new Worker(new URL(...))` call; only the Cut list panel's default imports it.

import { workerNester, type Nester } from './nester';

export function spawnNester(): Nester {
  return workerNester(
    () =>
      new Worker(new URL('./nesting-worker.ts', import.meta.url), {
        type: 'module',
        name: 'manufakture-nesting',
      }),
  );
}
