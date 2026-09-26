// The sketch package without its solver: the data model, ids, splitting, placement, regions and
// region fills, validation. Pure TypeScript with no planegcs at runtime, so the app's main bundle
// (drawing, snapping, region fills, placement maths) loads none of the solver's glue; the solver
// runs in its worker (`./worker`), reached through `./rpc`.

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
  detectRegions,
  type Region,
  type RegionCurve,
  type RegionDiagnostic,
  type RegionDiagnosticCode,
  type RegionLoop,
  type RegionOptions,
  type SketchRegions,
} from './regions';
export {
  regionProfile,
  type RegionProfile,
  type RegionProfileEdge,
  type RegionProfileEntity,
  type RegionProfileLoop,
} from './region-profile';
export {
  DEFAULT_FILL_DEFLECTION,
  flattenRegion,
  regionFill,
  regionFills,
  triangulateRegion2D,
  type FillDeflection,
  type RegionFill,
} from './region-mesh';
export {
  evaluateValues,
  pointKey,
  referencedEntities,
  validateSketch,
  type EvaluatedValues,
} from './validate';
