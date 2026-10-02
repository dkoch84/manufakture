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

export { FEED_CLASSES, isFeedMove, isMove } from './ir';
export type {
  ArcMove,
  Comment,
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
