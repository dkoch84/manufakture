// @manufakture/print: printability checks for FDM printing (plan M3, T3.1b). Pure functions on
// plain data: the printer table, orientation transforms, overhang classes and bed fit. No kernel
// or DOM dependency at run time; mesh and box shapes are the kernel's types. Fit defaults (T3.2g).
// Wall thickness, gaps, small holes and teardrops, and the print-analysis worker's API (T3.1c).

export {
  PRINTERS,
  PRINTER_IDS,
  LINE_WIDTHS,
  MIN_FEATURE_FRACTION,
  defaultLineWidth,
  findPrinter,
  hasNozzle,
  minFeatureSize,
} from './printers';
export type { ExcludedArea, NozzleArea, Printer, PrinterId } from './printers';

export {
  eulerRotation,
  layFlatRotation,
  lowestZ,
  orientationPlacement,
  orientationRotation,
} from './orientation';
export type { Orientation } from './orientation';

export {
  ANGLE_TOLERANCE,
  DEFAULT_BED_TOLERANCE,
  DEFAULT_OVERHANG_THRESHOLD,
  DEFAULT_WARNING_BAND,
  OVERHANG_CLASSES,
  OVERHANG_SEVERITY,
  angleFromVertical,
  classifyAngle,
  classifyOverhangs,
  overhangToSupportThreshold,
  supportThresholdToOverhang,
} from './overhang';
export type {
  FaceOverhang,
  OverhangClass,
  OverhangMesh,
  OverhangOptions,
  OverhangResult,
} from './overhang';

export { DEFAULT_FIT_TOLERANCE, boundingBox, checkBedFit, usableRegion } from './bedFit';
export type { BedFitBody, BedFitOptions, BedFitResult, UsableRegion } from './bedFit';

export {
  IDENTITY_PLACEMENT,
  applyPlacement,
  placementMatrix,
  quatFromAxisAngle,
  quatMultiply,
  rotateDirection,
} from './geometry';
export type { Mat3, Placement, Quat, Vec2, Vec3 } from './geometry';

export {
  COUPON_CLEARANCES,
  FIT_DESCRIPTIONS,
  FIT_KINDS,
  FIT_TABLE,
  FIT_VARIABLES,
  HEAT_SET_INSERTS,
  REFERENCE_NOZZLE,
  SCREW_SIZES,
  SELF_TAPPING_HOLES,
  fitDefaults,
  heatSetInsert,
  printerFamily,
  selfTappingHole,
} from './fits';
export type {
  FitClearances,
  FitDefaults,
  FitKind,
  FitProvenance,
  FitRow,
  HeatSetInsert,
  PrinterFamily,
  ScrewSize,
  SelfTappingHole,
} from './fits';

export {
  DEFAULT_MIN_GAP,
  DEFAULT_TEARDROP,
  MIN_HOLE_NOZZLES,
  MIN_WALL_LINES,
  printThresholds,
} from './thresholds';
export type { PrintThresholds } from './thresholds';

export {
  DEFAULT_MAX_SPLIT,
  DEFAULT_RANGE,
  DEFAULT_SPACING,
  GRAZING_ANGLE,
  LENGTH_TOLERANCE,
  RAY_OFFSET,
  THICKNESS_FLAGS,
  ThicknessJob,
  analyzeThickness,
} from './thickness';
export type {
  BodyThickness,
  FaceThickness,
  ThicknessBody,
  ThicknessIssue,
  ThicknessIssueKind,
  ThicknessMesh,
  ThicknessOptions,
  ThicknessResult,
} from './thickness';

export {
  AXIS_ANGLE_TOLERANCE,
  AXIS_DISTANCE_TOLERANCE,
  DIAMETER_TOLERANCE,
  HORIZONTAL_TOLERANCE,
  RADIUS_TOLERANCE,
  THREAD_SEGMENT,
  analyzeHoles,
  isThreadFace,
  lineAngle,
  pointLineDistance,
  sameLine,
} from './features';
export type { CylinderGroup, FaceNameSource, HoleIssue, HoleOptions, HoleReport } from './features';

export { TriangleBvh } from './bvh';
export type { RayHit } from './bvh';

export { createPrintWorkerApi, replyTransferables } from './worker-api';
export type {
  PrintAnalysisBody,
  PrintAnalysisBodyResult,
  PrintAnalysisReply,
  PrintAnalysisRequest,
  PrintWorkerApi,
  PrintWorkerApiOptions,
} from './worker-api';
