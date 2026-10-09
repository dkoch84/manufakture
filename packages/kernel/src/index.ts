// @manufakture/kernel: the only path by which the app touches OCCT.
//
// - The synchronous `Kernel` runs inside the kernel worker (ADR 0001).
// - `KernelService` adds batching, generation cancellation, errors as data and
//   instance recycling (ADR 0002, ADR 0007); `createKernelWorkerApi` exposes
//   it through Comlink.
// - The main thread uses `@manufakture/kernel/kernel-client`; Node tests use
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
  TOOL_OVERLAP,
  applyFeature,
  connectorFrame,
  connectorTarget,
  frameOnPlane,
  orientedGeometry,
  pickReference,
  pickVertex,
  profileRegions,
  resolveReferences,
  resolveVertex,
  sketchFrame,
  validateFeature,
} from './features';
export type {
  ChamferInput,
  CombineInput,
  ConnectorInference,
  ConnectorOrigin,
  ConnectorReport,
  DeriveInput,
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
  MoveInput,
  OutcomeBody,
  PatternInput,
  PatternLayout,
  ProfileRegion,
  ReferenceReport,
  ResolvedRef,
  ResultMode,
  RevolveInput,
  ShellInput,
  SketchProfile,
  ThreadFaceInput,
  ThreadInput,
  ThreadReport,
  ThreadRepresentation,
  ToolInput,
  ToolItem,
  ToolPrimitive,
  ToolsInput,
  VertexRef,
} from './features';
export {
  UNNAMED_PREFIX,
  answersTo,
  derivedName,
  describeFailure,
  edgeRefName,
  importedFace,
  invalidFeatureId,
  invalidSketchId,
  isPositional,
  isUnnamed,
  nameShape,
  pickEdge,
  pickFace,
  refName,
  resolveEdge,
  resolveFace,
  splitParent,
  sweepRegionKeys,
  sweepRegionOrder,
  threadFace,
  toolFace,
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
export { HOLE_SIZES, HOLE_SIZE_SOURCES, clearanceDiameter, holeSize } from './holes';
export type { HoleFit, HoleStandardSize } from './holes';
export {
  THREAD_SIZES,
  threadLimits,
  threadProblem,
  threadProfile,
  threadSize,
  threadSolid,
  threadTurns,
} from './threads';
export type {
  ThreadEnd,
  ThreadFacePart,
  ThreadGeometry,
  ThreadHand,
  ThreadLimits,
  ThreadPart,
  ThreadProfile,
  ThreadSide,
  ThreadStandardSize,
  ThreadSystem,
  ThreadTool,
  ThreadTools,
} from './threads';
export { validateOp } from './ops';
export type {
  BatchContext,
  BodySetRef,
  BooleanOp,
  BoxOp,
  ConnectorOp,
  CylinderOp,
  ExportStepOp,
  ExtrudeOp,
  FaceLoopsOp,
  FeatureOp,
  FilletOp,
  ImportStepOp,
  InterferenceOp,
  KernelOp,
  MeasureOp,
  ObbOp,
  OpName,
  OpResult,
  OpResults,
  OpValue,
  OpValues,
  PickOp,
  ProfileOp,
  ProjectOp,
  PropertiesOp,
  ReleaseOp,
  ReleaseResult,
  ResolveOp,
  SectionOp,
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
export { DEFAULT_LOOP_DEFLECTION } from './loops';
export type {
  FaceLoopsReport,
  FaceLoopsTarget,
  Loop,
  LoopRegion,
  LoopSegment,
  LoopSource,
  SectionLoops,
} from './loops';
export type { OrientedBox, OrientedBoxOptions } from './obb';
export { DEFAULT_PROJECT_DEFLECTION, boundsOf, endsOf, projectPoint, viewFrame } from './project';
export type {
  Bounds2,
  Curve2,
  EdgeClass,
  ItemSection,
  ProjectItem,
  ProjectOptions,
  ProjectResult,
  ProjectView,
  ProjectedEdge,
  SectionFace,
  SectionPlane,
  ViewFrame,
} from './project';
export { NameTable, applyNames, faceNameOfTriangle } from './names';
export type { SubShapeName } from './names';
export { meshBuffers } from './mesh';
export { LIBCASCADE_WASM_BYTES, OcctLoader } from './loader';
export type { KernelOutput, LoadProgress, LoaderOptions, WasmSource } from './loader';
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
  SessionFunction,
  SessionReply,
  SessionRequest,
} from './service';
export { createKernelWorkerApi } from './worker-api';
export type { InitReport, KernelWorkerApi, WorkerApiOptions } from './worker-api';
export type { StepAssemblyLayout, StepPose } from './exchange';
export { MAX_STEP_BYTES } from './exchange';
export { DEFAULT_INTERFERENCE_TOLERANCE } from './interference';
