// A test worker that dies in the middle of an analysis or of loading the mesher, as one that runs
// out of memory does.

import { workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';

const die = async (): Promise<never> => {
  setTimeout(() => process.exit(3), 10);
  return new Promise<never>(() => undefined);
};

const { port } = workerData as { port: MessagePort };
Comlink.expose(
  { analyse: die, analyseMesh: die, prepare: die },
  port as unknown as Comlink.Endpoint,
);
