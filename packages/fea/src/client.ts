// The host side of the FEA worker: one analysis at a time, cancellation, and the hard limits a
// busy worker cannot enforce on itself. The worker checks the time limit and the cancel flag
// between phases and iterations; a gmsh call cannot be interrupted, so when the worker has not
// answered `graceMs` after a cancel or the time limit, the host terminates it and answers with
// the typed error. A worker that dies (out of memory, a wasm abort) answers `worker-failed` or
// `memory-limit`. `prepare` runs under the same guard: one call at a time with the runs, a
// timeout that terminates the worker, and an answer when the worker dies. Never a hang: every
// run and every prepare settles.
//
// Environment-neutral: the worker comes from a `spawn` function (`spawnBrowserFeaWorker` in
// ./browser, `spawnNodeFeaWorker` in ./node), so this module bundles no worker.

import * as Comlink from 'comlink';
import { duration } from './context';
import { DEFAULT_LIMITS, resolveLimits } from './limits';
import type { MeshedModel, SolveInput } from './solve';
import type { FeaError, FeaLimits, FeaOutcome, FeaProgress, FeaRequest } from './types';
import type { FeaWorkerApi } from './worker/api';

/** A started worker, whatever its kind. */
export interface FeaWorkerHandle {
  api: Comlink.Remote<FeaWorkerApi>;
  /** Stop it at once. */
  terminate(): void;
  /** Called once if the worker dies on its own; `outOfMemory` when the platform says so. */
  onExit(listener: (reason: { message: string; outOfMemory: boolean }) => void): void;
}

export interface FeaRunOptions {
  onProgress?: (p: FeaProgress) => void;
  signal?: AbortSignal;
}

export interface FeaRunner {
  /** Run one analysis. Resolves with the outcome; never rejects for an expected failure. */
  run(request: FeaRequest, options?: FeaRunOptions): Promise<FeaOutcome>;
  /** Solve a mesh that is already built, under the same limits, cancellation and watchdog. */
  runMesh(
    model: MeshedModel,
    input: SolveInput & { limits?: Partial<FeaLimits> },
    options?: FeaRunOptions,
  ): Promise<FeaOutcome>;
  /**
   * Load the mesher ahead of time (optional). One call at a time with the runs (`busy`
   * otherwise); settles with `time-limit` after `prepareTimeoutMs` (the worker is terminated)
   * and with `worker-failed` or `memory-limit` if the worker dies.
   */
  prepare(): Promise<{ ok: true } | { ok: false; error: FeaError }>;
  /** End the worker. The runner starts a new one if used again. */
  dispose(): void;
}

export interface FeaRunnerOptions {
  /** How long a cancelled or overdue worker may take to answer before it is terminated, ms. */
  graceMs?: number;
  /** How long `prepare` may take to download and compile the mesher, ms. */
  prepareTimeoutMs?: number;
}

const DEFAULT_GRACE_MS = 3_000;
export const DEFAULT_PREPARE_TIMEOUT_MS = 120_000;

/**
 * Outcomes after which the worker is ended, so the next run starts in a fresh one: after running
 * out of memory, or a mesher that failed, a worker's heap may be fragmented or left large.
 */
const RESTART_AFTER: ReadonlySet<FeaError['code']> = new Set(['memory-limit', 'mesh-failed']);

type ExitReason = { message: string; outOfMemory: boolean };

const busyError = (): FeaError => ({
  code: 'busy',
  message: 'Another analysis is running; one runs at a time.',
});

/** The error a worker that died on its own answers with. */
const exitError = (reason: ExitReason, memoryLimit: number): FeaError =>
  reason.outOfMemory
    ? {
        code: 'memory-limit',
        message: `The FEA worker ran out of memory: ${reason.message}`,
        bytes: 0,
        limit: memoryLimit,
      }
    : { code: 'worker-failed', message: `The FEA worker stopped: ${reason.message}` };

const failedError = (error: unknown): FeaError => ({
  code: 'worker-failed',
  message: `The FEA worker failed: ${error instanceof Error ? error.message : String(error)}`,
});

const sharedFlag = (): SharedArrayBuffer | null => {
  try {
    return typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : null;
  } catch {
    return null;
  }
};

export function createFeaRunner(
  spawn: () => FeaWorkerHandle,
  options: FeaRunnerOptions = {},
): FeaRunner {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const prepareTimeoutMs = options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
  let worker: FeaWorkerHandle | null = null;
  let busy = false;
  let exitListener: ((reason: ExitReason) => void) | null = null;

  const current = (): FeaWorkerHandle => {
    if (worker) return worker;
    const w = spawn();
    worker = w;
    w.onExit((reason) => {
      if (worker === w) worker = null;
      exitListener?.(reason);
    });
    return w;
  };
  const kill = () => {
    const w = worker;
    worker = null;
    w?.terminate();
  };

  type Call = (
    w: FeaWorkerHandle,
    flag: SharedArrayBuffer | null,
    progress: ((p: FeaProgress) => void) | undefined,
  ) => Promise<FeaOutcome>;

  const execute = (
    requested: Partial<FeaLimits> | undefined,
    runOptions: FeaRunOptions,
    call: Call,
  ): Promise<FeaOutcome> => {
    if (busy) return Promise.resolve({ ok: false, error: busyError() });
    const limits = resolveLimits(requested);
    if ('code' in limits) return Promise.resolve({ ok: false, error: limits });
    busy = true;
    const flag = sharedFlag();
    const view = flag ? new Int32Array(flag) : null;
    return new Promise<FeaOutcome>((resolve) => {
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (outcome: FeaOutcome) => {
        if (settled) return;
        settled = true;
        busy = false;
        exitListener = null;
        for (const t of timers) clearTimeout(t);
        runOptions.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      // Ask the worker to stop; terminate it if it does not answer in time. The worker sees
      // only the flag and answers `cancelled`; the reason the host stopped it wins.
      let stopped: FeaError | null = null;
      const stop = (error: FeaError) => {
        if (settled || stopped) return;
        stopped = error;
        if (view) Atomics.store(view, 0, 1);
        const hard = () => {
          kill();
          finish({ ok: false, error });
        };
        if (!view) hard();
        else timers.push(setTimeout(hard, graceMs));
      };
      const onAbort = () => stop({ code: 'cancelled', message: 'The analysis was cancelled.' });
      if (runOptions.signal?.aborted) {
        busy = false;
        resolve({
          ok: false,
          error: { code: 'cancelled', message: 'The analysis was cancelled.' },
        });
        return;
      }
      runOptions.signal?.addEventListener('abort', onAbort);
      timers.push(
        setTimeout(
          () =>
            stop({
              code: 'time-limit',
              message: `The analysis ran past its time limit of ${duration(limits.timeMs)}.`,
              elapsedMs: limits.timeMs,
              limit: limits.timeMs,
            }),
          limits.timeMs,
        ),
      );
      exitListener = (reason) =>
        finish({ ok: false, error: exitError(reason, limits.memoryBytes) });
      let w: FeaWorkerHandle;
      try {
        w = current();
      } catch (error) {
        finish({
          ok: false,
          error: {
            code: 'worker-failed',
            message: `The FEA worker could not start: ${String(error)}`,
          },
        });
        return;
      }
      const progress = runOptions.onProgress
        ? Comlink.proxy((p: FeaProgress) => {
            if (!settled) runOptions.onProgress!(p);
          })
        : undefined;
      call(w, flag, progress).then(
        (outcome) => {
          if (settled) return;
          if (!outcome.ok && RESTART_AFTER.has(outcome.error.code)) kill();
          finish(
            stopped && !outcome.ok && outcome.error.code === 'cancelled'
              ? { ok: false, error: stopped }
              : outcome,
          );
        },
        (error: unknown) => finish({ ok: false, error: failedError(error) }),
      );
    });
  };

  return {
    run(request, runOptions = {}) {
      return execute(request?.limits, runOptions, (w, flag, progress) =>
        w.api.analyse(request, flag, progress),
      );
    },
    runMesh(model, input, runOptions = {}) {
      return execute(input?.limits, runOptions, (w, flag, progress) =>
        w.api.analyseMesh(model, input, flag, progress),
      );
    },
    prepare() {
      type Prepared = { ok: true } | { ok: false; error: FeaError };
      if (busy) return Promise.resolve<Prepared>({ ok: false, error: busyError() });
      busy = true;
      return new Promise<Prepared>((resolve) => {
        let settled = false;
        const finish = (outcome: Prepared) => {
          if (settled) return;
          settled = true;
          busy = false;
          exitListener = null;
          clearTimeout(timer);
          resolve(outcome);
        };
        // Comlink never rejects a call whose worker died or hangs: the timeout and the exit
        // listener are what settle it then.
        const timer = setTimeout(() => {
          kill();
          finish({
            ok: false,
            error: {
              code: 'time-limit',
              message: `The mesher did not load within ${duration(prepareTimeoutMs)}.`,
              elapsedMs: prepareTimeoutMs,
              limit: prepareTimeoutMs,
            },
          });
        }, prepareTimeoutMs);
        exitListener = (reason) =>
          finish({ ok: false, error: exitError(reason, DEFAULT_LIMITS.memoryBytes) });
        let w: FeaWorkerHandle;
        try {
          w = current();
        } catch (error) {
          finish({
            ok: false,
            error: {
              code: 'worker-failed',
              message: `The FEA worker could not start: ${String(error)}`,
            },
          });
          return;
        }
        w.api
          .prepare()
          .then(finish, (error: unknown) => finish({ ok: false, error: failedError(error) }));
      });
    },
    dispose() {
      // A run or prepare in flight settles now rather than at its timeout.
      const listener = exitListener;
      kill();
      listener?.({ message: 'the runner was disposed', outOfMemory: false });
    },
  };
}
