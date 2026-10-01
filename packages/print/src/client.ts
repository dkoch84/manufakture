// Main-thread entry of the print-analysis worker: `createPrintAnalysisClient`, which starts the
// worker (worker.ts) on the client's first analysis. Kept apart from `PrintAnalysisClient`
// (analysis-client.ts), since Vite bundles the worker of every module that contains a
// `new Worker(new URL(...))` call, used or not.

import { PrintAnalysisClient } from './analysis-client';

export {
  PrintAnalysisClient,
  type PrintAnalysisResult,
  type PrintEndpoint,
} from './analysis-client';

/** A client whose worker starts lazily, the first time a print workspace asks for an analysis. */
export function createPrintAnalysisClient(): PrintAnalysisClient {
  return new PrintAnalysisClient(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-print',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  });
}
