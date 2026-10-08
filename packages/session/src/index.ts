// @manufakture/session: headless document sessions (ADR 0016; M8 plan T8.1c). One agent on one
// agent branch of one document, with its own kernel, applying batches of core commands and
// answering the read queries of the MCP tools. No transport. Node only. See README.md.

export {
  BackendBundleStore,
  MAX_BUNDLE_BYTES,
  MAX_NOTE,
  MemoryBundleStore,
  type BundleBase,
  type BundleBuilder,
  type BundleHead,
  type BundleStore,
  type StoredBundle,
} from './bundles';
export {
  EngineLost,
  InProcessEngine,
  KernelTimeout,
  WORKER_START_MS,
  WorkerEngine,
  startEngine,
  type Engine,
  type EngineApi,
  type EngineKind,
  type EngineOptions,
  type WorkerEngineOptions,
} from './engine';
export {
  type Refusal,
  type SessionError,
  type SessionErrorCode,
  type SessionResult,
} from './errors';
export { References, referenceImports, type ReferenceBody } from './imports';
export {
  DEFAULT_LIMITS,
  IN_PROCESS_SESSIONS_PER_PROCESS,
  WORKER_SESSIONS_PER_PROCESS,
  sessionLimits,
  type SessionLimits,
} from './limits';
export { SessionManager, type SessionManagerOptions } from './manager';
export { ModelState, type BodyGeometry, type NamedEdge, type NamedFace } from './model';
export { nodeExtensions, readBundledFont, sessionEngineApi } from './node-host';
export {
  MAX_GEOMETRY_RESULTS,
  MAX_MEASURE_ITEMS,
  type BodyRef,
  type ErrorLine,
  type GeometryHit,
  type GeometryQuery,
  type MeasureQuery,
  type ObjectQuery,
  type Quantities,
} from './queries';
export { schemaIndex, schemaOf } from './schema';
export {
  MAX_LABEL,
  MAX_REPORTED,
  Session,
  commandCount,
  type ApplyInput,
  type BatchReport,
  type BodySummary,
  type HistoryItem,
  type OpenOptions,
  type ResumeOptions,
  type SessionHost,
  type SessionInfo,
  type SessionLogEvent,
  type StatusChange,
  type UpdateReport,
} from './session';
export {
  MAX_BATCH_DEPTH,
  MAX_JSON_DEPTH,
  MAX_SYMBOLS,
  PLACEHOLDER_BASE,
  batchProblem,
  hasSymbols,
  resolveSymbols,
  type BatchProblem,
} from './symbols';
