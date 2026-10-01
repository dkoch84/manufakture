// @manufakture/regen: turns a core document into geometry, rebuilding only what changed.
// See README.md for the design (where it runs, caching, errors, cancellation).

export const packageName = '@manufakture/regen';

export {
  RegenEngine,
  type EngineStats,
  type AssemblyOptions,
  type RegenEngineOptions,
  type RegenKernel,
  type RegenOptions,
} from './engine';
export {
  DEFAULT_KERNEL_BUILD,
  DEFAULT_SOLVER_BUILD,
  MemoryCache,
  REGEN_IMPLEMENTATION_VERSION,
  cacheKey,
  holdsShapes,
  type CacheEntry,
  type CachedBody,
  type CachedOutcome,
  type FeatureCache,
  type KeyVersions,
  type MemoryCacheOptions,
} from './cache';
export {
  BODY_KINDS,
  bodyUse,
  buildGraph,
  changedVariables,
  dirtyFeatures,
  dirtyFeaturesOf,
  isBodyFeature,
  readsBody,
  regenOrder,
  routeBodies,
  sameInputs,
  topologicalOrder,
  variableClosure,
  type BodyUse,
  type DependencyGraph,
  type DirtyOptions,
  type RoutedBody,
} from './graph';
export {
  evaluateFeature,
  evaluateField,
  evaluateVariables,
  pathKey,
  type FeatureValues,
  type VariableValues,
} from './values';
export {
  explicitPlacement,
  profileOf,
  selectRegions,
  sketchOutcome,
  solveSketch,
  type RegenSolver,
  type SketchResult,
  type SolveOutcome,
} from './sketches';
export {
  edgeRef,
  faceRef,
  referenceIdOf,
  topoRef,
  translateFeature,
  type TranslateContext,
  type Translation,
} from './translate';
export {
  connectorOrigin,
  connectorPose,
  framePose,
  instanceSourceKey,
  posesDiffer,
} from './assembly';
export { mapFailure, mapKernelError, mapKernelWarning, mapOutcome } from './errors';
export { hashString, hashValue, stableStringify } from './hash';
export { regenTransferables } from './transfer';
export {
  createRegenWorkerApi,
  type RegenWorkerApi,
  type RegenWorkerApiOptions,
} from './worker-api';
export type * from './types';
