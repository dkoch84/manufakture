// A test worker that never answers: its analysis spins without checking anything, like a gmsh
// call that cannot be interrupted, and so does loading the mesher. The runner must terminate it
// at the time limit.

import { workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';

const spin = (): never => {
  for (;;) {
    // busy, never yields
  }
};

const { port } = workerData as { port: MessagePort };
Comlink.expose(
  { analyse: spin, analyseMesh: spin, prepare: spin },
  port as unknown as Comlink.Endpoint,
);
