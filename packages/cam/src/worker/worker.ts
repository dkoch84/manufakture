// CAM worker entry (T5.1g; ADR 0014 decision 7): toolpath generation and the simulation, off the
// main thread and away from the kernel. Start it from the main thread with `CamClient` from
// `@manufakture/cam/client`, which creates it lazily on the first call, so a document with no CAM
// setup never starts it. Pure TypeScript: nothing to load.
//
// The operations this package ships are registered on `defaultOperations` here, before the worker
// handles its first message. A host entry (apps/web's cam-worker.ts) imports this module and may
// register more on the same registry.

import * as Comlink from 'comlink';
import { createCamWorkerApi } from './api';
import { registerBuiltinOperations } from './builtin';
import { defaultOperations } from './registry';

registerBuiltinOperations(defaultOperations);
Comlink.expose(createCamWorkerApi({ operations: defaultOperations }));
