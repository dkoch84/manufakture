// The main thread's side of nesting (M4 plan T4.3d): a `Nester` runs a job and reports progress.
// `workerNester` sends it to the nesting worker (started on the first job, so a document never
// laid out never starts it); `localNester` runs it in-process (tests, and hosts with no workers).
// A new job cancels the one before it: only the latest layout is wanted.

import {
  runNesting,
  type JobProgress,
  type NestingJob,
  type NestingResult,
} from '@manufakture/domain-wood/nesting';

export type NesterRequest =
  { type: 'run'; id: number; job: NestingJob } | { type: 'cancel'; id: number };

export type NesterReply =
  | { type: 'progress'; id: number; progress: JobProgress }
  | { type: 'done'; id: number; result: NestingResult }
  | { type: 'error'; id: number; message: string; cancelled: boolean };

export interface Nester {
  /**
   * Lay out `job`. Resolves to null when a newer job (or `terminate`) cancelled it; rejects when
   * the layout failed.
   */
  layout(job: NestingJob, onProgress?: (p: JobProgress) => void): Promise<NestingResult | null>;
  /** Cancel the running job, if any (its `layout` resolves to null); the nester stays usable. */
  cancel(): void;
  terminate(): void;
}

/** A nester on a worker made by `spawn` (on the first job). */
export function workerNester(spawn: () => Worker): Nester {
  let worker: Worker | null = null;
  let next = 1;
  const pending = new Map<
    number,
    {
      resolve: (r: NestingResult | null) => void;
      reject: (e: Error) => void;
      onProgress?: ((p: JobProgress) => void) | undefined;
    }
  >();
  const cancelAll = () => {
    for (const [id, p] of pending) {
      worker?.postMessage({ type: 'cancel', id } satisfies NesterRequest);
      p.resolve(null);
    }
    pending.clear();
  };
  const start = (): Worker => {
    const w = spawn();
    w.addEventListener('message', (event: MessageEvent<NesterReply>) => {
      const reply = event.data;
      const p = pending.get(reply.id);
      if (p === undefined) return;
      if (reply.type === 'progress') {
        p.onProgress?.(reply.progress);
        return;
      }
      pending.delete(reply.id);
      if (reply.type === 'done') p.resolve(reply.result);
      else if (reply.cancelled) p.resolve(null);
      else p.reject(new Error(reply.message));
    });
    w.addEventListener('error', (event) => {
      for (const p of pending.values())
        p.reject(new Error(event.message || 'the nesting worker failed'));
      pending.clear();
      w.terminate();
      if (worker === w) worker = null;
    });
    return w;
  };
  return {
    layout(job, onProgress) {
      cancelAll();
      worker ??= start();
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        worker!.postMessage({ type: 'run', id, job } satisfies NesterRequest);
      });
    },
    cancel() {
      cancelAll();
    },
    terminate() {
      cancelAll();
      worker?.terminate();
      worker = null;
    },
  };
}

/** A nester on this thread (it still yields between attempts, so the page stays responsive). */
export function localNester(): Nester {
  let current: AbortController | null = null;
  return {
    async layout(job, onProgress) {
      current?.abort(new Error('cancelled'));
      const controller = new AbortController();
      current = controller;
      try {
        return await runNesting(job, {
          signal: controller.signal,
          ...(onProgress ? { onProgress } : {}),
        });
      } catch (error) {
        if (controller.signal.aborted) return null;
        throw error;
      }
    },
    cancel() {
      current?.abort(new Error('cancelled'));
    },
    terminate() {
      current?.abort(new Error('cancelled'));
    },
  };
}
