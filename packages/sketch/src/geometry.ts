// The sketch package without its solver: the data model, ids, splitting, placement, regions,
// region fills, outlines (paths to region loops), validation. Pure TypeScript with no planegcs at
// runtime, so the app's main bundle (drawing, snapping, region fills, placement maths) loads none
// of the solver's glue; the solver runs in its worker (`./worker`), reached through `./rpc`.

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
  MAX_OUTLINE_PLACEMENT_WORK,
  MAX_OUTLINE_POLYGON_POINTS,
  detectRegions,
  loopPolygon,
  type OutlineShape,
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
  MAX_FLATTEN_POINTS,
  MAX_REFINE_WORK,
  flattenRegion,
  regionFill,
  regionFills,
  triangulateRegion2D,
  type FillDeflection,
  type FlattenOptions,
  type RegionFill,
} from './region-mesh';
export {
  MAX_OUTLINE_COMMANDS,
  MAX_OUTLINE_POINTS,
  MAX_OUTLINE_WORK,
  OutlineBudget,
  bezierPoint,
  flattenSegment,
  loopArea,
  outlinePartsRegions,
  outlinePartsSize,
  outlineRegionArea,
  outlineRegions,
  type OutlineIssue,
  type OutlinePartIssue,
  type OutlinePartLoop,
  type OutlinePartRegion,
  type OutlinePartSegment,
  type OutlinePartsResult,
  type OutlinePartsSize,
  type OutlineIssueCode,
  type OutlineLoop,
  type OutlineOptions,
  type OutlineRegion,
  type OutlineResult,
  type OutlineSegment,
  type PathCommand,
} from './outline';
export { outlineEdgeId, placeOutline } from './outline-entity';
export { MAX_SVG_OUTLINE_COMMANDS, svgIssueShapes, svgOutlineRegions } from './outline-svg';
export {
  evaluateValues,
  pointKey,
  referencedEntities,
  validateSketch,
  type EvaluatedValues,
} from './validate';
