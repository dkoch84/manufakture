// Solver worker entry (ADR 0007: the solver has its own worker). Start it as
// a module worker from the app:
//
//   new Worker(new URL('@manufakture/sketch/worker', import.meta.url), { type: 'module' })
//
// and talk to it with `connectSolver(worker)`. In the browser, planegcs.wasm
// is a separate asset: pass its URL (Vite: import it with `?url`) as the
// `wasm` query parameter of the worker URL, or rely on the Emscripten glue's
// own lookup next to the bundled JS.

import { PlanegcsBackend } from './planegcs/system';
import { PlanegcsModule } from './planegcs/module';
import { serveSolver, type MessageEndpoint } from './rpc';
import { createSolverService } from './service';

declare const self: MessageEndpoint & { location?: { search?: string } };

// `?wasm=<url>` on the worker URL overrides where planegcs.wasm is loaded from.
const wasmUrl = new URLSearchParams(self.location?.search ?? '').get('wasm') ?? undefined;

serveSolver(
  self,
  createSolverService({
    loadBackend: async () =>
      new PlanegcsBackend(await PlanegcsModule.load(wasmUrl ? { wasmUrl } : {})),
  }),
);
