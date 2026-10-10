// The FEA worker in a browser: a module worker of its own, so an out-of-memory crash takes only
// the analysis (ADR 0017 decision 13). Started by `spawnBrowserFeaWorker` (../browser.ts).

import * as Comlink from 'comlink';
import { feaWorkerApi } from './api';

Comlink.expose(feaWorkerApi());
