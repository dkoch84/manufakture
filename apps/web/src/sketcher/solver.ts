// The sketch solver worker (ADR 0003, ADR 0007: the solver has a worker of its
// own, apart from the kernel's). The worker entry is `@manufakture/sketch`'s;
// Vite bundles it and planegcs.wasm, which the Emscripten glue finds next to
// itself. The worker is started on the first sketch and kept for the session.

import SolverWorker from '@manufakture/sketch/worker?worker';
import { connectSolver, type SketchSolverApi } from '@manufakture/sketch';

export interface SolverHandle {
  api: SketchSolverApi;
  terminate(): void;
}

export function spawnSolverWorker(): SolverHandle {
  const worker = new SolverWorker({ name: 'manufakture-solver' });
  return { api: connectSolver(worker), terminate: () => worker.terminate() };
}
