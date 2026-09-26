export const packageName = '@manufakture/sketch';

// Everything but the solver (also importable alone as '@manufakture/sketch/geometry', which
// loads no planegcs; the data model alone is '@manufakture/sketch/model').
export * from './geometry';

// Solving.
export type { SketchSolverBackend, SketchSystem, SolveOptions } from './solver';
export { SolverAbortedError, type PlanegcsLoadOptions } from './planegcs/module';
export { loadPlanegcsBackend } from './planegcs/system';
export {
  SolverService,
  createSolverService,
  type SketchSolverApi,
  type SolverServiceOptions,
  type Variables,
} from './service';
export {
  connectSolver,
  serveSolver,
  type MessageEndpoint,
  type SolverReply,
  type SolverRequest,
} from './rpc';
