// Per-run limits (ADR 0010 decision 4, starting values from the T7.0c spike). All are reported as
// typed ScriptErrors. The hard bound on a run, terminating the regen worker, is not here: the
// regen worker owns it (T7.2c), and `RECOMMENDED_HARD_TIMEOUT_MS` is the value it should use.

const KIB = 1024;
const MIB = 1024 * KIB;

export interface ScriptLimits {
  /**
   * Soft time budget per run, in ms: checked by QuickJS's interrupt handler, in every host call,
   * and before and after the heavy builtins the sandbox guards. Module evaluation counts.
   */
  timeMs: number;
  /**
   * Heap per instance, in bytes. Enforced by the instance's `WebAssembly.Memory` maximum (the
   * 16 MiB the .wasm needs plus this), because QuickJS's own `setMemoryLimit` does not count the
   * bytes behind small allocations in this build (T7.0c). Read when an instance is created.
   */
  heapBytes: number;
  /** QuickJS stack limit, in bytes. Must stay below the smallest browser worker stack (T7.0c). */
  stackBytes: number;
  /** Host calls that change geometry (functions marked `kernelOp`), per run. */
  kernelOps: number;
  /** Host calls of any kind, per run. */
  hostCalls: number;
  /** Longest string crossing the boundary, in UTF-16 code units (keys included). */
  maxStringLength: number;
  /** Array elements plus object properties in one value crossing the boundary, at any depth. */
  maxElements: number;
  /** Deepest nesting of arrays and objects in one value crossing the boundary. */
  maxDepth: number;
  /** Encoded size of one value crossing the boundary, in UTF-16 code units. */
  maxPayloadLength: number;
  /**
   * An instance whose linear memory has grown past this many bytes is replaced after the run.
   * WebAssembly memory never shrinks, so this bounds what an idle document holds (T7.0c).
   */
  recycleAboveBytes: number;
}

export const DEFAULT_LIMITS: Readonly<ScriptLimits> = Object.freeze({
  timeMs: 2000,
  heapBytes: 64 * MIB,
  stackBytes: 128 * KIB,
  kernelOps: 1000,
  hostCalls: 100_000,
  maxStringLength: 1 * MIB,
  maxElements: 100_000,
  maxDepth: 64,
  maxPayloadLength: 8 * MIB,
  recycleAboveBytes: 16 * MIB + 32 * MIB,
});

/**
 * What the regen worker's watchdog should allow a request with a script run before it terminates
 * and recycles the worker (T7.2c): the only bound on a single builtin call or a native loop the
 * soft limit cannot interrupt (T7.0c measured one `sort()` loop running 8 to 12 s past its
 * deadline before the guards this package adds).
 */
export const RECOMMENDED_HARD_TIMEOUT_MS = 10_000;

/** The linear memory every instance starts with: the 256 pages the .wasm declares. */
export const BASE_MEMORY_BYTES = 16 * MIB;

export function resolveLimits(overrides: Partial<ScriptLimits> = {}): ScriptLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`script limit ${key} must be a positive number, got ${value}`);
    }
  }
  return limits;
}
