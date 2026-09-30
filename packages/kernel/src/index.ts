// @manufakture/kernel: the only path by which the app touches OCCT.
//
// - The synchronous `Kernel` runs inside the kernel worker (ADR 0001).
// - `KernelService` adds batching, generation cancellation, errors as data and
//   instance recycling (ADR 0002, ADR 0007); `createKernelWorkerApi` exposes
//   it through Comlink.
// - The main thread uses `@manufakture/kernel/client`; Node tests use
//   `@manufakture/kernel/node`.

export const packageName = '@manufakture/kernel';

export * from './types';
export { KernelError, isFatalWasmError } from './errors';
export type { KernelFailure, KernelFailureCode } from './errors';
export { Kernel, DEFAULT_DEFLECTION } from './kernel';
export type {
  BooleanKind,
  BooleanOptions,
  KernelContext,
  KernelOptions,
  NamedShape,
} from './kernel';
export {
  MAX_PATTERN_COUNT,
  applyFeature,
  frameOnPlane,
  orientedGeometry,
  pickReference,
  resolveReferences,
  sketchFrame,
  validateFeature,
} from './features';
export type {
  ChamferInput,
  EdgeReference,
  ExtrudeExtent,
  ExtrudeInput,
  FaceReference,
  FeatureBody,
  FeatureError,
  FeatureErrorCode,
  FeatureInput,
  FeatureKind,
  FeatureOutcome,
  FeatureWarning,
  FilletInput,
  HoleHead,
  HoleInput,
  ImportInput,
  InstanceSource,
  MirrorInput,
  OutcomeBody,
  PatternInput,
  PatternLayout,
  ReferenceReport,
  ResolvedRef,
  ResultMode,
  RevolveInput,
  ShellInput,
  SketchProfile,
  ToolInput,
} from './features';
export {
  UNNAMED_PREFIX,
  describeFailure,
  edgeRefName,
  importedFace,
  invalidFeatureId,
  invalidSketchId,
  isPositional,
  isUnnamed,
  pickEdge,
  pickFace,
  refName,
  resolveEdge,
  resolveFace,
  splitParent,
} from './naming';
export type {
  EdgeName,
  EdgeRef,
  FaceName,
  FaceRef,
  Failure,
  Names,
  Resolution,
  TopoRef,
  Via,
} from './naming';
export { HOLE_SIZES, clearanceDiameter, holeSize } from './holes';
export type { HoleFit, HoleStandardSize } from './holes';
export { validateOp } from './ops';
export type {
  BatchContext,
  BodySetRef,
  BooleanOp,
  BoxOp,
  CylinderOp,
  ExportStepOp,
  ExtrudeOp,
  FeatureOp,
  FilletOp,
  ImportStepOp,
  KernelOp,
  MeasureOp,
  OpName,
  OpResult,
  OpResults,
  OpValue,
  OpValues,
  PickOp,
  ProfileOp,
  PropertiesOp,
  ReleaseOp,
  ReleaseResult,
  ResolveOp,
  ShapeRef,
  TessellateOp,
  TopologyOp,
} from './ops';
export type {
  AngleMeasure,
  BodyMeasure,
  DistanceMeasure,
  MeasureAxis,
  MeasureItemReport,
  MeasureOptions,
  MeasureResult,
  MeasureTarget,
  MeasuredEdge,
  MeasuredFace,
  MeasuredItem,
  MeasuredVertex,
} from './measure';
export { NameTable, applyNames, faceNameOfTriangle } from './names';
export type { SubShapeName } from './names';
export { meshBuffers } from './mesh';
export { LIBCASCADE_WASM_BYTES, OcctLoader } from './loader';
export type { LoadProgress, LoaderOptions, WasmSource } from './loader';
export {
  DEFAULT_HEAP_THRESHOLD,
  KernelService,
  collectTransferables,
  yieldToEventLoop,
} from './service';
export type {
  BatchReply,
  BatchRequest,
  KernelServiceConfig,
  KernelServiceOptions,
  KernelStats,
  KernelStatus,
  RecycleReason,
  RecycleReport,
  ReplayHook,
} from './service';
export { createKernelWorkerApi } from './worker-api';
export type { InitReport, KernelWorkerApi, WorkerApiOptions } from './worker-api';
export { MAX_STEP_BYTES } from './exchange';
