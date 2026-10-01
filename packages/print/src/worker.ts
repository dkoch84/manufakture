// Print-analysis worker entry (ADR 0012 decision 5). Start it from the main thread with
// `PrintAnalysisClient` from `@manufakture/print/client`, which creates it lazily on the first
// analysis, so a document with no print setup never starts it. Pure TypeScript: nothing to load.

import * as Comlink from 'comlink';
import { createPrintWorkerApi } from './worker-api';

Comlink.expose(createPrintWorkerApi());
