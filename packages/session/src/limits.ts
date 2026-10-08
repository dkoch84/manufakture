// The session limits of ADR 0016 decision 3, from the T8.0a spike's measurements. Each one ends
// in a typed `SessionError` (errors.ts), never a throw. See README.md, "Limits".

import { DEFAULT_HEAP_THRESHOLD } from '@manufakture/kernel';
import { MFK_LIMITS } from '@manufakture/library/mfk';

export interface SessionLimits {
  /** Commands in one batch, counting those inside nested batches. */
  commandsPerBatch: number;
  /** Batches (applies and undos) one session may write. */
  batchesPerSession: number;
  /** Regen time of one batch, ms: past it the batch is cancelled and rolled back. */
  regenMsPerBatch: number;
  /**
   * After a cancel, how long the regen may take to stop before the kernel is torn down (a worker
   * engine terminates its worker; an in-process one can only wait). ms.
   */
  regenStopMs: number;
  /**
   * Any other kernel call (a measurement, an interference check, a STEP read, a heap probe), ms:
   * past it a worker engine is terminated and started again and the call answers
   * `kernel-timeout`. (`close` gives a call in flight `regenStopMs` before it ends the session.)
   */
  kernelMsPerCall: number;
  /** The document as JSON, UTF-8 bytes: the `.mfk` limit (`MFK_LIMITS.maxDocumentBytes`). */
  documentBytes: number;
  /** The kernel's wasm heap, bytes, past which its instance is replaced (ADR 0002). */
  kernelHeapBytes: number;
  /** A session idle this long (no call), ms, closes itself. 0: never. */
  idleMs: number;
  /** Open sessions per `SessionManager`. */
  sessionsPerProcess: number;
}

/** 4 sessions per process when each has its kernel in a worker thread of its own (ADR 0016). */
export const WORKER_SESSIONS_PER_PROCESS = 4;
/** 2 when the kernels share the main thread (ADR 0016 decision 3). */
export const IN_PROCESS_SESSIONS_PER_PROCESS = 2;

export const DEFAULT_LIMITS: SessionLimits = {
  commandsPerBatch: 500,
  batchesPerSession: 2000,
  regenMsPerBatch: 30_000,
  regenStopMs: 5_000,
  kernelMsPerCall: 30_000,
  documentBytes: MFK_LIMITS.maxDocumentBytes,
  kernelHeapBytes: DEFAULT_HEAP_THRESHOLD,
  idleMs: 30 * 60_000,
  sessionsPerProcess: WORKER_SESSIONS_PER_PROCESS,
};

/** `DEFAULT_LIMITS` with `overrides`, each a positive integer (0 allowed for `idleMs`). */
export function sessionLimits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  const out = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(out)) {
    const min = key === 'idleMs' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < min) {
      throw new RangeError(`the session limit ${key} must be an integer of at least ${min}`);
    }
  }
  return out;
}
