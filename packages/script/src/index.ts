// @manufakture/script: runs a user's JavaScript or TypeScript in QuickJS (WebAssembly) against a
// host API it is given, with the limits and determinism rules of ADR 0010. See README.md.

export {
  QUICKJS_BUILD,
  ScriptEngine,
  ScriptInstance,
  type ScriptInstanceOptions,
  type ScriptOutcome,
  type ScriptRunRequest,
  type ScriptRunStats,
  type ScriptSource,
  type WasmSource,
} from './engine';
export {
  MAX_SOURCE_LENGTH,
  prepareSource,
  type PreparedSource,
  type PrepareResult,
  type ScriptLanguage,
} from './erase';
export {
  LIMIT_CODES,
  ScriptHostError,
  scriptError,
  type ScriptError,
  type ScriptErrorCode,
} from './errors';
export {
  KernelOp,
  ScriptHandle,
  kernelOp,
  type HostApi,
  type HostFunction,
  type ScriptValue,
} from './host';
export {
  BASE_MEMORY_BYTES,
  DEFAULT_LIMITS,
  RECOMMENDED_HARD_TIMEOUT_MS,
  resolveLimits,
  type ScriptLimits,
} from './limits';
export {
  MAX_PARAMS,
  parseParamDeclarations,
  resolveParams,
  type BooleanParam,
  type ChoiceParam,
  type NumericParam,
  type ParamDeclaration,
  type ParamKind,
  type ParamSpec,
  type ReferenceParam,
  type ReferenceSelect,
  type ScriptDeclarations,
} from './params';
export { hashSource, randomSeed } from './random';
export type { SourcePosition } from './sourcemap';
export {
  CURRENT_SCRIPT_API_VERSION,
  SCRIPT_API_VERSIONS,
  checkApiVersion,
  isSupportedApiVersion,
} from './version';
