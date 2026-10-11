// Starts the simulation worker. A module of its own, since Vite bundles the worker of every module
// that holds a `new Worker(new URL(...))` call; only what runs a simulation imports it, lazily.

import { workerSimulator, type Simulator } from './simulator';

export function spawnSimulator(): Simulator {
  return workerSimulator(
    () =>
      new Worker(new URL('./sim-worker.ts', import.meta.url), {
        type: 'module',
        name: 'manufakture-simulation',
      }),
  );
}
