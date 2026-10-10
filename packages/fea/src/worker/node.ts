// The FEA worker in a Node worker thread (an agent's session, ADR 0016; tests). The host sends a
// MessagePort in `workerData` and talks Comlink over it, as the session's own worker does.
// Terminating the thread frees everything the analysis held.

import { workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { feaWorkerApi } from './api';

const { port } = workerData as { port: MessagePort };
Comlink.expose(feaWorkerApi(), port as unknown as Comlink.Endpoint);
