// The run context threaded through every phase: the limits, the clock, the cancellation flag,
// progress reporting and the memory account. Checks throw `FeaAbort`, which the pipeline turns
// back into a typed error at its boundary.

import type { FeaError, FeaLimits, FeaPhase, FeaProgress } from './types';

/** An expected failure on its way out of the pipeline. */
export class FeaAbort extends Error {
  readonly error: FeaError;
  constructor(error: FeaError) {
    super(error.message);
    this.error = error;
  }
}

export interface RunContextOptions {
  limits: FeaLimits;
  /** Set to non-zero by the host to cancel (a SharedArrayBuffer view, so a busy worker sees it). */
  cancel?: Int32Array | null;
  onProgress?: (p: FeaProgress) => void;
  /** Clock, ms (tests may pass their own). */
  now?: () => number;
}

export class RunContext {
  readonly limits: FeaLimits;
  readonly start: number;
  private readonly cancel: Int32Array | null;
  private readonly onProgress: ((p: FeaProgress) => void) | undefined;
  private readonly now: () => number;
  /** Bytes of the solver's live arrays, and the highest it reached. */
  private live = 0;
  peak = 0;
  /** gmsh's heap, held only while meshing. */
  mesherBytes = 0;
  phase: FeaPhase = 'load-mesher';
  dof: number | undefined;
  private lastProgress = -Infinity;

  constructor(options: RunContextOptions) {
    this.limits = options.limits;
    this.cancel = options.cancel ?? null;
    this.onProgress = options.onProgress;
    this.now = options.now ?? (() => performance.now());
    this.start = this.now();
  }

  elapsed(): number {
    return this.now() - this.start;
  }

  /** Throws when cancelled or out of time. Cheap enough to call every iteration. */
  check(): void {
    if (this.cancel && Atomics.load(this.cancel, 0) !== 0) {
      throw new FeaAbort({ code: 'cancelled', message: 'The analysis was cancelled.' });
    }
    const t = this.elapsed();
    if (t > this.limits.timeMs) {
      throw new FeaAbort({
        code: 'time-limit',
        message: `The analysis ran past its time limit of ${duration(this.limits.timeMs)}.`,
        elapsedMs: t,
        limit: this.limits.timeMs,
      });
    }
  }

  /** Enter a phase: report it and check. */
  enter(phase: FeaPhase): void {
    this.phase = phase;
    this.check();
    this.report({}, true);
  }

  /** Report progress within the current phase, at most every 50 ms unless forced. */
  report(extra: Omit<FeaProgress, 'phase' | 'elapsedMs'>, force = false): void {
    if (!this.onProgress) return;
    const t = this.elapsed();
    if (!force && t - this.lastProgress < 50) return;
    this.lastProgress = t;
    this.onProgress({
      phase: this.phase,
      elapsedMs: t,
      ...(this.dof !== undefined ? { dof: this.dof } : {}),
      ...extra,
    });
  }

  /** Account for `bytes` the solver is about to allocate; refuses past the memory limit. */
  use(bytes: number, what: string): void {
    const next = this.live + bytes + this.mesherBytes;
    if (next > this.limits.memoryBytes) {
      throw new FeaAbort({
        code: 'memory-limit',
        message: `The analysis would need more than its memory limit of ${mib(this.limits.memoryBytes)} (at ${what}: ${mib(next)}).`,
        bytes: next,
        limit: this.limits.memoryBytes,
      });
    }
    this.live += bytes;
    this.peak = Math.max(this.peak, this.live);
  }

  release(bytes: number): void {
    this.live = Math.max(0, this.live - bytes);
  }
}

export const mib = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(0)} MiB`;

/** A duration for messages: ms below 10 s, whole seconds above. */
export const duration = (ms: number): string =>
  ms < 10_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`;
