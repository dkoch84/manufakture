// The print-analysis worker's spawn, in a module of its own: Vite bundles the worker of every
// module that contains a `new Worker(new URL(...))` call (here, through
// `@manufakture/print/client`), so everything else in the print workspace imports only types from
// the client. Creating the client starts nothing; its worker starts on the first analysis.

import { createPrintAnalysisClient } from '@manufakture/print/client';
import type { PrintAnalyzer } from './analysis';

export function spawnPrintAnalyzer(): PrintAnalyzer {
  return createPrintAnalysisClient();
}
