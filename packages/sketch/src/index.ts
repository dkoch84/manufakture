export const packageName = '@manufakture/sketch';

// Plain data model (also importable alone as '@manufakture/sketch/model').
export * from './model';
export {
  isValidSketchId,
  sketchIdProblem,
  splitAncestors,
  splitIds,
  splitParent,
  splitSuffix,
} from './ids';
export { splitEntity, type SplitResult } from './split';
export {
  XY_PLANE,
  XZ_PLANE,
  YZ_PLANE,
  distanceFromPlane,
  isValidPlacement,
  placementFrame,
  placementFromNormal,
  placementMatrix,
  sketchDirectionToWorld,
  sketchToWorld,
  worldToSketch,
  type PlacementFrame,
  type SketchPlacement,
} from './placement';
export {
  evaluateValues,
  pointKey,
  referencedEntities,
  validateSketch,
  type EvaluatedValues,
} from './validate';

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
