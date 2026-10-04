// Every way a script run can fail, as data (ADR 0007 decision 5: errors are values). Regen turns a
// ScriptError into the scripted feature's FeatureError (T7.2c); the editor puts a marker at
// `line` and `column` (T7.2d).

import type { SourcePosition } from './sourcemap';

export type ScriptErrorCode =
  /** The run took longer than `limits.timeMs`. */
  | 'timeout'
  /** The script ran out of heap (`limits.heapBytes`). The instance is replaced. */
  | 'heap-limit'
  /** The script recursed deeper than `limits.stackBytes` allows. */
  | 'stack-limit'
  /** More kernel operations than `limits.kernelOps` in one run. */
  | 'op-limit'
  /** More host calls than `limits.hostCalls` in one run. */
  | 'call-limit'
  /** A value crossing the boundary was too large (string, element count, depth or total size). */
  | 'value-too-large'
  /** The source does not parse. */
  | 'syntax'
  /** TypeScript the sandbox refuses (`namespace`, `module` blocks, `import x = require()`), or an `import`. */
  | 'unsupported-syntax'
  /** The script needs a script API version this build does not have. */
  | 'api-version'
  /** The script's declarations (`params`, `apiVersion`, `run`) are missing or malformed. */
  | 'bad-declaration'
  /** A parameter value does not fit its declaration. */
  | 'bad-param'
  /** The script threw, or a value it returned or passed cannot cross the boundary. */
  | 'runtime'
  /** A host function failed in a way that is a bug on our side, not the script's. */
  | 'host-error'
  /** The interpreter itself failed (a trap or a host exception). The instance is replaced. */
  | 'internal';

export interface ScriptError {
  code: ScriptErrorCode;
  /** One sentence for the user, for example "The script ran longer than 2 s". */
  message: string;
  /** Where in the source, when known (1-based, in the source as written, TypeScript included). */
  line?: number;
  column?: number;
  /** The script's backtrace with positions mapped to the source, when there is one. */
  stack?: string;
}

/** Limit errors end the run whatever the script does; it cannot catch them. */
export const LIMIT_CODES: ReadonlySet<ScriptErrorCode> = new Set([
  'timeout',
  'heap-limit',
  'stack-limit',
  'op-limit',
  'call-limit',
  'value-too-large',
]);

export function scriptError(
  code: ScriptErrorCode,
  message: string,
  position?: SourcePosition,
): ScriptError {
  return position === undefined
    ? { code, message }
    : { code, message, line: position.line, column: position.column };
}

/**
 * Thrown by a host function to fail the call with a message the script sees as an ordinary,
 * catchable `Error` (for example "extrude: distance must be positive"). Anything else a host
 * function throws ends the run with a `host-error`.
 */
export class ScriptHostError extends Error {
  override readonly name = 'ScriptHostError';
}
