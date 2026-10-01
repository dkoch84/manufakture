// A watchdog around a worker: one request at a time, each with a time limit, and the worker
// terminated (and a fresh one started for the next request) when a request passes the limit or
// the worker dies. Untrusted input whose cost cannot be bounded from outside the code that reads
// it (a CFF font's subroutine fan-out inside opentype.js, ADR 0011's amendment) is handled this
// way: a hang or an out-of-memory crash costs the time limit and a new worker, never the regen
// worker, the kernel next to it or the page.
//
// The protocol is plain `postMessage`: the request goes out as `{ id, request }` and the worker
// answers `{ id, reply }`. A reply to a request that already timed out is ignored. A caller that
// no longer wants a reply (a newer regen superseded its own) aborts the request's signal: the
// worker is terminated if it is running that request, and a request still queued never runs.

/** What the watchdog needs of a worker: a browser `Worker` fits as it is. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}

/**
 * Why a request got no reply: it passed the time limit, the worker died, the caller aborted it,
 * or no worker could be started (`spawn`, which says nothing about the request).
 */
export class WatchdogError extends Error {
  constructor(
    readonly reason: 'timeout' | 'crashed' | 'cancelled' | 'spawn',
    message: string,
  ) {
    super(message);
    this.name = 'WatchdogError';
  }
}

export interface WatchdogOptions {
  /** Most milliseconds one request may run before the worker is terminated. */
  timeLimit: number;
  /**
   * The worker posts `{ ready: true }` once it has started (`serveText` does). A worker that
   * dies or passes the time limit before that never started: its request fails as `spawn`, not
   * as `timeout` or `crashed`, so the caller does not blame the request. Default false.
   */
  ready?: boolean;
}

interface Pending {
  id: number;
  resolve: (reply: unknown) => void;
  reject: (error: WatchdogError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A worker run under a time limit; see the module comment. */
export class Watchdog<Request, Reply> {
  readonly #spawn: () => WorkerLike;
  readonly #timeLimit: number;
  readonly #waitsForReady: boolean;
  #worker: WorkerLike | null = null;
  /** The current worker said it started (always true without `ready`). */
  #started = false;
  #generation = 0;
  #nextId = 1;
  #pending: Pending | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(spawn: () => WorkerLike, options: WatchdogOptions) {
    if (!(options.timeLimit > 0)) throw new RangeError('The time limit must be above 0');
    this.#spawn = spawn;
    this.#timeLimit = options.timeLimit;
    this.#waitsForReady = options.ready ?? false;
  }

  /**
   * Counts the workers started so far: it changes whenever a worker was replaced, so a caller
   * that keeps state in the worker (fonts already sent) knows to send it again.
   */
  get generation(): number {
    return this.#generation;
  }

  /** Whether a worker is running now. */
  get running(): boolean {
    return this.#worker !== null;
  }

  /**
   * Send one request, after every earlier one has finished. Rejects with a `WatchdogError` when
   * it passes the time limit or the worker dies; the worker is then gone, and the next request
   * starts a new one. Aborting `signal` rejects it as `cancelled`: before it ran, it never runs;
   * while it runs, the worker is terminated.
   */
  call(request: Request, transfer: Transferable[] = [], signal?: AbortSignal): Promise<Reply> {
    const run = this.#queue.then(() => this.#run(request, transfer, signal));
    // Keep the queue going whatever this request does.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Stop the worker; a later request starts a new one. A request in flight fails as crashed. */
  terminate(): void {
    this.#kill(new WatchdogError('crashed', 'The worker was stopped.'));
  }

  #ensure(): WorkerLike {
    if (this.#worker) return this.#worker;
    const worker = this.#spawn();
    this.#generation++;
    this.#started = !this.#waitsForReady;
    worker.onmessage = (event) => {
      const data = event.data as { id?: unknown; reply?: unknown; ready?: unknown } | null;
      if (worker === this.#worker) this.#started = true;
      if (data?.ready === true) return;
      const pending = this.#pending;
      if (!pending || worker !== this.#worker || data?.id !== pending.id) return;
      this.#settle();
      pending.resolve(data.reply);
    };
    const crashed = () =>
      this.#kill(new WatchdogError('crashed', 'The worker stopped (out of memory, or a crash).'));
    worker.onerror = (event) => {
      event?.preventDefault?.();
      if (worker === this.#worker) crashed();
    };
    worker.onmessageerror = () => {
      if (worker === this.#worker) crashed();
    };
    this.#worker = worker;
    return worker;
  }

  #run(request: Request, transfer: Transferable[], signal?: AbortSignal): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new WatchdogError('cancelled', 'The request was cancelled.'));
        return;
      }
      let worker: WorkerLike;
      try {
        worker = this.#ensure();
      } catch (error) {
        reject(new WatchdogError('spawn', `The worker could not be started: ${String(error)}`));
        return;
      }
      const id = this.#nextId++;
      const onAbort = () => {
        if (this.#pending === pending) {
          this.#kill(new WatchdogError('cancelled', 'The request was cancelled.'));
        }
      };
      const pending: Pending = {
        id,
        resolve: (reply) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(reply as Reply);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer: null,
      };
      this.#pending = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.timer = setTimeout(() => {
        if (this.#pending !== pending) return;
        this.#kill(
          new WatchdogError('timeout', `The worker took longer than ${this.#timeLimit} ms.`),
        );
      }, this.#timeLimit);
      try {
        worker.postMessage({ id, request }, transfer);
      } catch (error) {
        this.#kill(new WatchdogError('crashed', `The request could not be sent: ${String(error)}`));
      }
    });
  }

  #settle(): void {
    const pending = this.#pending;
    if (pending?.timer) clearTimeout(pending.timer);
    this.#pending = null;
  }

  #kill(error: WatchdogError): void {
    if (!this.#started && this.#worker && error.reason !== 'cancelled') {
      error = new WatchdogError('spawn', `The worker did not start: ${error.message}`);
    }
    const pending = this.#pending;
    this.#settle();
    const worker = this.#worker;
    this.#worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try {
        worker.terminate();
      } catch {
        // Already gone.
      }
    }
    pending?.reject(error);
  }
}
