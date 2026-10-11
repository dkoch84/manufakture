// The main thread's side of the rep and session simulation (T9.4b): a `Simulator` runs a job
// (`simulationJob` builds one from a load case) and reports progress. `workerSimulator` sends it
// to the simulation worker (started on the first run, so a document never simulated never starts
// it); `localSimulator` runs it in-process, in slices (tests, and hosts with no workers). The
// worker's side is `serveSimulations`, so the protocol lives in one file. Runs are independent:
// several load cases may run at once, each cancelled through its own signal. The model itself is
// pure TypeScript in `@manufakture/domain-mech`, which an agent's Node session calls directly.

import { runSimulation, type SimJob, type SimResult } from '@manufakture/domain-mech';

export type SimRequest = { type: 'run'; id: number; job: SimJob } | { type: 'cancel'; id: number };

export type SimReply =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; result: SimResult }
  | { type: 'error'; id: number; message: string };

export interface SimRunOptions {
  /** Aborting resolves the run with status `cancelled` (the partial result). */
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface Simulator {
  /**
   * Run `job`. Resolves with the result: status `done`, `budget` (stopped at the job's budget) or
   * `cancelled`. Rejects only when the run failed (a job the model refuses, a dead worker).
   */
  run(job: SimJob, options?: SimRunOptions): Promise<SimResult>;
  /** End the worker; pending runs reject. A new run starts a new worker. */
  terminate(): void;
}

/**
 * The worker's side: handles requests, posting replies through `post`. Returns the message
 * handler. Each run yields between slices, so a cancel arriving mid-run is heard.
 */
export function serveSimulations(post: (reply: SimReply) => void): (request: SimRequest) => void {
  const running = new Map<number, AbortController>();
  return (request) => {
    if (request.type === 'cancel') {
      running.get(request.id)?.abort();
      return;
    }
    const controller = new AbortController();
    running.set(request.id, controller);
    runSimulation(request.job, {
      signal: controller.signal,
      onProgress: (fraction) => post({ type: 'progress', id: request.id, fraction }),
    })
      .then((result) => post({ type: 'done', id: request.id, result }))
      .catch((error: unknown) =>
        post({
          type: 'error',
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => running.delete(request.id));
  };
}

/** The part of a `Worker` the simulator uses (a fake in tests). */
export type SimWorker = Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'>;

/** A simulator on a worker made by `spawn` (on the first run). */
export function workerSimulator(spawn: () => SimWorker): Simulator {
  let worker: SimWorker | null = null;
  let next = 1;
  const pending = new Map<
    number,
    {
      resolve: (r: SimResult) => void;
      reject: (e: Error) => void;
      onProgress?: ((f: number) => void) | undefined;
      unlisten: () => void;
    }
  >();
  const failAll = (message: string) => {
    for (const p of pending.values()) {
      p.unlisten();
      p.reject(new Error(message));
    }
    pending.clear();
  };
  const start = (): SimWorker => {
    const w = spawn();
    w.addEventListener('message', (event: MessageEvent<SimReply>) => {
      const reply = event.data;
      const p = pending.get(reply.id);
      if (p === undefined) return;
      if (reply.type === 'progress') {
        p.onProgress?.(reply.fraction);
        return;
      }
      pending.delete(reply.id);
      p.unlisten();
      if (reply.type === 'done') p.resolve(reply.result);
      else p.reject(new Error(reply.message));
    });
    w.addEventListener('error', (event: ErrorEvent) => {
      failAll(event.message || 'the simulation worker failed');
      w.terminate();
      if (worker === w) worker = null;
    });
    return w;
  };
  return {
    run(job, options = {}) {
      worker ??= start();
      const w = worker;
      const id = next++;
      return new Promise((resolve, reject) => {
        const { signal } = options;
        const onAbort = () => w.postMessage({ type: 'cancel', id } satisfies SimRequest);
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          resolve,
          reject,
          onProgress: options.onProgress,
          unlisten: () => signal?.removeEventListener('abort', onAbort),
        });
        w.postMessage({ type: 'run', id, job } satisfies SimRequest);
        if (signal?.aborted) onAbort();
      });
    },
    terminate() {
      failAll('the simulator was ended');
      worker?.terminate();
      worker = null;
    },
  };
}

/** A simulator on this thread, in slices, so the page stays responsive. */
export function localSimulator(): Simulator {
  const controllers = new Set<AbortController>();
  return {
    async run(job, options = {}) {
      const controller = new AbortController();
      controllers.add(controller);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) controller.abort();
      try {
        return await runSimulation(job, {
          signal: controller.signal,
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        controllers.delete(controller);
      }
    },
    terminate() {
      for (const c of controllers) c.abort();
    },
  };
}
