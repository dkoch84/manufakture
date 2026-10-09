// Where `render` and `export` regenerate a session's document: one kernel service for the whole
// server, in this thread, and a fresh `RegenEngine` per call (disposed after it), one call at a
// time. A session's own engine cannot serve them: its regen sends a body's mesh only when it
// changed, and the exports need the in-process stages (CAM geometry, drawing sheets, member
// B-reps, the kernel's STEP and meshes) that a session's worker does not offer.
//
// One kernel, used by one engine at a time, is not shared in the sense ADR 0016 decision 3
// forbids: every call regenerates from scratch on it, so a recycle between calls loses nothing.
// The kernel never recycles in the middle of a call (`autoRecycle: false`); after a call whose
// heap ended past the threshold it is recycled, and the old instance collected when the host
// runs with `--expose-gc` (the start script does).
//
// The kernel runs in this thread, so a regen over its limit is cancelled between kernel
// operations, and so is an export's own work over its limit (`workMs`). Either way the caller is
// answered with the timeout at once, but the call keeps the workshop until what it started has
// settled: the engine is disposed, and the kernel recycled, only then, and the next call waits.
// What has not settled `stopMs` after the deadline is left to finish on its own: its kernel is
// dropped (never disposed or recycled under it) and the next call starts a new one. A single
// kernel operation that never returns cannot be stopped here (the session's worker engines can
// be; README, "Not done").

import { DEFAULT_HEAP_THRESHOLD, type KernelService } from '@manufakture/kernel';
import { STDERR_OUTPUT, createNodeService } from '@manufakture/kernel/node';
import { RegenEngine, createTextOutliner, type RegenResult } from '@manufakture/regen';
import { nodeExtensions, readBundledFont } from '@manufakture/session';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import type { ManufaktureDocument } from '@manufakture/core';

export interface Bench {
  engine: RegenEngine;
  kernel: KernelService;
  result: RegenResult;
}

/** A call ran over its deadline: its regen (`regen`) or the work after it (`work`). */
export class WorkshopTimeout extends Error {
  constructor(
    readonly ms: number,
    readonly stage: 'regen' | 'work' = 'regen',
  ) {
    super(
      stage === 'regen'
        ? `The regen took longer than ${ms} ms.`
        : `The work took longer than ${ms} ms.`,
    );
    this.name = 'WorkshopTimeout';
  }
}

export interface WorkshopOptions {
  /** Kernel heap past which the kernel is recycled after a call. */
  heapThresholdBytes?: number;
  /**
   * How long a call past its deadline may take to stop before its kernel is dropped, ms
   * (default 5000, the session's `regenStopMs`).
   */
  stopMs?: number;
}

export interface RunOptions {
  /** The time `use` may take, ms (default: no limit). */
  workMs?: number;
}

/** How a call ended, for the workshop's own counts (tests). */
export interface WorkshopStats {
  /** Kernels dropped because a call did not stop in time. */
  dropped: number;
}

function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** `p` settled within `ms`, or null when it did not. */
async function within<T>(p: Promise<Settled<T>>, ms: number): Promise<Settled<T> | null> {
  if (!Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

interface Reply<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class Workshop {
  readonly #heapThreshold: number;
  readonly #stopMs: number;
  #kernel: Promise<KernelService> | null = null;
  #solver: SolverService | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #dropped = 0;

  constructor(options: WorkshopOptions = {}) {
    this.#heapThreshold = options.heapThresholdBytes ?? DEFAULT_HEAP_THRESHOLD;
    this.#stopMs = options.stopMs ?? 5_000;
  }

  stats(): WorkshopStats {
    return { dropped: this.#dropped };
  }

  #services(): Promise<{ kernel: KernelService; solver: SolverService }> {
    this.#kernel ??= createNodeService({
      heapThresholdBytes: this.#heapThreshold,
      autoRecycle: false,
      // stdout carries the MCP protocol: OCCT's chatter (the STEP writer's) goes to stderr.
      output: STDERR_OUTPUT,
    });
    this.#solver ??= createSolverService();
    const solver = this.#solver;
    return this.#kernel.then((kernel) => ({ kernel, solver }));
  }

  /**
   * Regenerate `document` on a fresh engine, then run `use` while its shapes are live. Calls run
   * one at a time. Rejects with `WorkshopTimeout` when the regen runs over `regenMs` (stage
   * `regen`) or `use` over `options.workMs` (stage `work`); the next call still waits until the
   * late one has stopped (or its kernel was dropped).
   */
  run<T>(
    document: ManufaktureDocument,
    regenMs: number,
    use: (bench: Bench) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    let reply!: Reply<T>;
    let answered = false;
    const answer = new Promise<T>((resolve, reject) => {
      reply = {
        resolve: (v) => {
          answered = true;
          resolve(v);
        },
        reject: (e) => {
          answered = true;
          reject(e);
        },
      };
    });
    const task = this.#queue
      .then(() => this.#run(document, regenMs, use, options.workMs ?? Infinity, reply))
      .catch((e: unknown) => {
        if (!answered) reply.reject(e);
      });
    this.#queue = task;
    return answer;
  }

  /** Runs one call; answers `reply` as soon as the answer is known, resolves when it settled. */
  async #run<T>(
    document: ManufaktureDocument,
    regenMs: number,
    use: (bench: Bench) => Promise<T>,
    workMs: number,
    reply: Reply<T>,
  ): Promise<void> {
    if (this.#closed) throw new Error('The workshop is closed.');
    const { kernel, solver } = await this.#services();
    const engine = new RegenEngine({
      kernel,
      solver,
      text: createTextOutliner({ fetchImpl: readBundledFont }),
      extensions: nodeExtensions(),
    });
    // What is still running on the kernel when the call stops waiting for it, if anything.
    let running: Promise<unknown> | null = null;
    try {
      const s = kernel.stats();
      const generation = Math.max(0, s.generation, s.cancelledThrough) + 1;
      const regen = settle(engine.regen(document, { generation }));
      const first = await within(regen, regenMs);
      if (first === null) {
        reply.reject(new WorkshopTimeout(regenMs, 'regen'));
        // Cancelled between operations: wait for it to stop before the engine is disposed.
        kernel.cancel(generation);
        if ((await within(regen, this.#stopMs)) === null) running = regen;
        return;
      }
      if (!first.ok) throw first.error;
      if (first.value === null) throw new Error('The regen was superseded.');
      const work = settle(use({ engine, kernel, result: first.value }));
      const done = await within(work, workMs);
      if (done === null) {
        reply.reject(new WorkshopTimeout(workMs, 'work'));
        // The work's kernel batches (a STEP write, CAM geometry) belong to the engine's
        // generations: cancel them all, then wait for the work to stop.
        kernel.cancel();
        if ((await within(work, this.#stopMs)) === null) running = work;
        return;
      }
      if (done.ok) reply.resolve(done.value);
      else reply.reject(done.error);
    } finally {
      if (running !== null) {
        // It did not stop: leave it its kernel, and never use that kernel again (calls run one
        // at a time, so the kernel held now is this call's).
        this.#kernel = null;
        this.#dropped++;
        void running.finally(() => engine.dispose().catch(() => undefined));
      } else {
        await engine.dispose().catch(() => undefined);
        if (kernel.stats().heapBytes > this.#heapThreshold) {
          await kernel.recycle('heap-threshold').catch(() => undefined);
          setTimeout(collect, 0).unref();
        }
      }
    }
  }

  /** Waits for the call in flight, then drops the kernel. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    this.#kernel = null;
    this.#solver = null;
    collect();
  }
}
