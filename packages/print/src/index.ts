// @manufakture/print: printability checks for FDM printing (plan M3, T3.1b). Pure functions on
// plain data: the printer table, orientation transforms, overhang classes and bed fit. No kernel
// or DOM dependency at run time; mesh and box shapes are the kernel's types.

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
