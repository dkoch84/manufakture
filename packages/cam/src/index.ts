// @manufakture/cam: computer-aided machining for the Shapeoko and other GRBL routers (M5 plan;
// ADR 0014). Pure TypeScript on plain data in internal units. T5.1c: evaluated input types, the
// toolpath IR, WCS and stock math, IR statistics, bounds and the IR validator.

export { ok, err } from './types';
export type {
  ArcSegment2,
  Box3,
  CamError,
  CamErrorCode,
  CamResult,
  DepthRange,
  DrillInput,
  DrillPoint,
  Entry,
  FacingInput,
  Feeds,
  Heights,
  Lead,
  LineSegment2,
  Loop2,
  MachineDrillPoint,
  MachineLoops,
  Mesh,
  OperationInput,
  OperationKind,
  PlanarLoops,
  PocketInput,
  ProfileInput,
  Segment2,
  Setup,
  SourceTag,
  Stock,
  StockMargins,
  Surface3dInput,
  Tool,
  ToolKind,
  UpAxis,
  VCarveInput,
  Vec2,
  Vec3,
  Wcs,
  WcsCorner,
  WcsFrame,
  WcsUp,
} from './types';

export { FEED_CLASSES, isCycleMarker, isFeedMove, isMove } from './ir';
export type {
  ArcMove,
  Comment,
  CycleEnd,
  CycleStart,
  DrillCycle,
  Dwell,
  FeedClass,
  IrEntry,
  LinearMove,
  Move,
  MoveTag,
  RapidMove,
  Spindle,
  ToolChange,
  Toolpath,
} from './ir';

export { angleAbout, arcBounds, arcLength, arcSweep, normalizeAngle, radiusAbout } from './arc';
export type { Arc3 } from './arc';

export {
  PARALLEL_TOLERANCE,
  boundsInSetup,
  directionToMachine,
  drillPointToMachine,
  planarLoopsToMachine,
  pointsBoundsInSetup,
  reverseLoop,
  setupRotation,
  toMachine,
  toModel,
  toSetup,
  wcsFrame,
  wcsOriginInSetup,
} from './wcs';
export type { SetupRotation } from './wcs';

export { stockFromBounds, stockFromSize, stockSize, uniformMargins } from './stock';

export { arcFrom, toolpathBounds, toolpathStats } from './stats';
export type { StatsOptions, ToolpathBounds, ToolpathStats } from './stats';

export { DEFAULT_ARC_TOLERANCE, validateToolpath } from './validate';
export type { IrIssue, IrIssueCode, ValidateOptions } from './validate';

// T5.2a: the offset engine (Clipper2 adapter, flattening, booleans, tagged arc refit).
export {
  CLIPPER_SCALE,
  FLATTEN_TOLERANCE,
  JOIN_TOLERANCE,
  MAX_COORD_MM,
  REFIT_TOLERANCE,
  arcRadius,
  differenceLoops,
  distToLoops,
  distToSegment,
  flattenSegments,
  intersectLoops,
  kerfLoops,
  loopArea,
  loopLength,
  offsetLoops,
  offsetOpenPaths,
  regionArea,
  regionLoops,
  segmentLength,
  segmentPoint,
  signedSweep,
  unionLoops,
} from './offset';
export type { KerfResult, OffsetOptions, OpenOffsetOptions, OpenPath2, Region2 } from './offset';

// T5.4a: the post-processor engine (dialect records, formatting, Grbl arc checks, the writer).
// T5.4b: the GRBL post (`GRBL_DIALECT`, `postGrbl`) and posted file names, from the same module.
export * from './post';

// T5.1g: the CAM worker's API, operation registry and packed toolpaths, and the toolpath cache.
// The worker entry is `@manufakture/cam/worker` and the main-thread client `@manufakture/cam/client`.
export * from './worker';
export * from './cache';

// T5.2b: the profile operation (registered on the worker by `registerBuiltinOperations`).
export {
  MAX_DEPTH_LEVELS,
  PROFILE_SAFE_ABOVE,
  PROFILE_TAB_MARGIN,
  PROFILE_TAB_MIN_INSIDE_SIZE,
  generateProfile,
} from './ops/profile';
export type { ProfileExtras, ProfileOperation } from './ops/profile';

// T5.2c: the pocket operation (registered on the worker by `registerBuiltinOperations`); its
// geometry and layer clearing are reused by V-carve (T5.2f) and 3D roughing (T5.5a).
export {
  POCKET_MIN_HELIX_FACTOR,
  POCKET_SAFE_ABOVE,
  POCKET_UNREACHABLE_MIN_AREA_FACTOR,
  generatePocket,
  generatePocketLayers,
  pocketGeometry,
} from './ops/pocket';
export type {
  PocketExtras,
  PocketGeometry,
  PocketGeometryOptions,
  PocketLayer,
  PocketNode,
  PocketOperation,
  PocketRing,
  PocketSpot,
  UncutArea,
} from './ops/pocket';

// T5.2d: the facing operation (registered on the worker by `registerBuiltinOperations`).
export { FACING_SAFE_ABOVE, facingRaster, generateFacing } from './ops/facing';
export type {
  FacingChord,
  FacingExtras,
  FacingOperation,
  FacingPattern,
  FacingRaster,
  FacingRasterOptions,
} from './ops/facing';

// T5.2e: the drill operation (registered on the worker by `registerBuiltinOperations`).
export {
  DRILL_BORE_STEPOVER,
  DRILL_BREAKTHROUGH_MARGIN,
  DRILL_CAVITY_CLEARANCE,
  DRILL_DEFAULT_POINT_ANGLE,
  DRILL_HELIX_ANGLE,
  DRILL_MATCH_TOLERANCE,
  DRILL_MIN_BORE_RADIUS,
  DRILL_PECK_CLEARANCE,
  DRILL_SAFE_ABOVE,
  DRILL_SLOPED_ENTRY,
  DRILL_UNDERSIZE_TOLERANCE,
  generateDrill,
  nearestNeighbourOrder,
  toolTipLength,
} from './ops/drill';
export type { DrillExtras, DrillOperation } from './ops/drill';

// T5.2f: the V-carve operation (registered on the worker by `registerBuiltinOperations`), and the
// clearing of its flat floor by an end mill as a toolpath of its own.
export {
  OutlineDistance,
  VCARVE_FLAT_RIDGE,
  VCARVE_INSET_STEP,
  VCARVE_MAX_FLAT_RINGS,
  VCARVE_MAX_LEVELS,
  VCARVE_SAFE_ABOVE,
  VCARVE_SAMPLE,
  VCARVE_TOLERANCE,
  generateVCarve,
  generateVCarveClearing,
} from './ops/vcarve';
export type { VCarveClearing, VCarveExtras, VCarveOperation } from './ops/vcarve';

// T5.5a: 3D surfacing (registered on the worker by `registerBuiltinOperations`): parallel
// finishing on our TypeScript drop-cutter, and z-level roughing through the pocket's layers.
export {
  SURFACE3D_ROUGH_ENTRY,
  SURFACE3D_SAFE_ABOVE,
  SURFACE3D_SLICE_CELL,
  SURFACE3D_SLICE_SIMPLIFY,
  SURFACE3D_TOLERANCE,
  generateSurface3d,
  scallopHeight,
} from './ops/surface3d';
export type { Surface3dExtras, Surface3dOperation, Surface3dStrategy } from './ops/surface3d';
export { DropCutter, cutterForTool, meshBounds } from './mesh/dropcutter';
export type { CutterShape, DropCutterOptions, SurfaceSampler } from './mesh/dropcutter';
export { distToSegment3, fitPolyline } from './mesh/fit';
export type { FitElement } from './mesh/fit';
export {
  MAX_GRID_NODES,
  heightGrid,
  polygonArea,
  simplifyClosed,
  superLevelLoops,
} from './mesh/slices';
export type { HeightGrid } from './mesh/slices';

// T5.3c: the material-removal simulation and gouge check (served by the CAM worker's
// `simulateProgram` and `simulate`).
export * from './sim';

// T5.2g: linking and job assembly (a setup's operations as one program for the posts).
export {
  JOB_LINK_OP,
  JOB_SAFE_ABOVE,
  JOB_SPINDLE_DWELL,
  JOB_TWO_OPT_LIMIT,
  assembleJob,
  cyclePieces,
  jobOperations,
  orderPieces,
  stockTopZ,
} from './job';
export type {
  Job,
  JobError,
  JobFailure,
  JobOperation,
  JobOperationOutcome,
  JobOptions,
  JobPiece,
  JobResult,
  JobSetup,
  JobSpan,
  JobWarning,
} from './job';

// T5.1d: the tool library, feed presets and machine profiles (also `@manufakture/cam/library`).
export * from './library';
