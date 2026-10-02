// The CAM worker's spawn, in a module of its own: Vite bundles the worker of every module that
// contains a `new Worker(new URL(...))` call, used or not, so everything else in the CAM workspace
// imports only `CamClient` and types from `@manufakture/cam/client`. Creating the client starts
// nothing; its worker starts on the first call, so a document with no CAM setup never starts it.

import { CamClient } from '@manufakture/cam/client';

export function spawnCamClient(): CamClient {
  return new CamClient(() => {
    const worker = new Worker(new URL('./cam-worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-cam',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  });
}
