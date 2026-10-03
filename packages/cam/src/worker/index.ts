// The CAM worker's API, registry and packed toolpaths, without the worker entry (`worker.ts`,
// which exposes the API on the worker's global scope when it is evaluated).

export {
  REQUEST_MAX_MOVES,
  createCamWorkerApi,
  createToolpathCache,
  generateTransferables,
} from './api';
export type {
  CachedOutcome,
  CamCacheInfo,
  CamChannel,
  CamGenerateReply,
  CamGenerateRequest,
  CamOperationResult,
  CamSimulateReply,
  CamSimulateRequest,
  CamToolpathStats,
  CamWorkerApi,
  CamWorkerApiOptions,
  Heightmap,
  OperationError,
  OperationErrorCode,
  SimulationInput,
  SimulationOutcome,
  Simulator,
} from './api';
export { registerBuiltinOperations } from './builtin';
export {
  INT_STRIDE,
  PACKED_KINDS,
  VALUE_STRIDE,
  clonePacked,
  packToolpath,
  packedBytes,
  packedLength,
  packedTransferables,
  unpackToolpath,
} from './pack';
export type { PackedExtra, PackedToolpath } from './pack';
export { CamCancelled, OperationRegistry, defaultOperations } from './registry';
export type {
  CamWarning,
  GeneratedToolpath,
  OperationContext,
  OperationGenerator,
  OperationOfKind,
  WorkContext,
} from './registry';
export { createYield } from './yield';
