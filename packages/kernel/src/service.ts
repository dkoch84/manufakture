// The kernel service: what the kernel worker runs behind Comlink (ADR 0007).
// It owns the kernel instance and adds, on top of the synchronous Kernel:
//
// - batching: a list of ops in, one reply out (decision 3);
// - cancellation by generation (decision 4): a newer request supersedes an
//   older one, checked between ops. OCCT calls cannot be interrupted, so one
//   op is the unit of cancellation; the batch yields to the event loop between
//   ops so that a newer request or a `cancel` can arrive at all;
// - errors as data (decision 5): every failure is a KernelFailure in the
//   reply, nothing an op does can throw through the worker boundary;
// - instance recycling (ADR 0002, decision 5): at a heap threshold, only at an
//   idle point, or after a wasm trap, the instance is replaced by a new one
//   from the cached module, and registered replay hooks run;
// - leak reports: every live shape records the op, feature and generation
//   that made it (and in debug mode the stack).
//
// It has no worker or Comlink dependency, so Node tests drive it directly.

import { KernelError, type KernelFailure } from './errors';
import { Kernel } from './kernel';
import type { LoadProgress } from './loader';
import { meshBuffers } from './mesh';
import { NameTable } from './names';
import type { Oc } from './occt';
import type { FeatureBody } from './features';
import {
  bodiesOf,
  executeOp,
  failureOf,
  shapeOf,
  shapesOf,
  validateOp,
  type KernelOp,
  type OpResult,
  type OpResults,
  type ReleaseResult,
  type ShapeRef,
} from './ops';
import type { InterferenceResult, MeshData, ShapeId, ShapeRecord } from './types';

export interface BatchRequest<T extends readonly KernelOp[] = readonly KernelOp[]> {
  /**
   * Increases with every edit (ADR 0007, decision 4). A batch is abandoned
   * when a request with a higher generation arrives before it finishes, or
   * when `cancel` covers its generation. Batches with equal generations do
   * not cancel each other.
   */
  generation: number;
  ops: T;
}

export type RecycleReason = 'heap-threshold' | 'fatal' | 'requested';

export interface BatchReply<T extends readonly KernelOp[] = readonly KernelOp[]> {
  generation: number;
  /** The kernel instance that ran the batch; it increases with every recycle. */
  instance: number;
  /**
   * `cancelled`: superseded or cancelled between two ops, or after the last
   * one. Every shape the batch made has been released and `results` is
   * empty. A batch cancelled after its last op has run all of its ops, so its
   * `release` ops have taken effect even though their results are not
   * reported. A batch at a stale generation is `cancelled` even when empty.
   */
  status: 'done' | 'cancelled';
  /** One result per op, in order. */
  results: OpResults<T>;
  /** Ops that ran before the batch finished or was cancelled. */
  completedOps: number;
  /**
   * Name table for the meshes' name slots (ADR 0007, decision 7). Meshes of
   * bodies made by `feature` ops have every slot filled from it; meshes of raw
   * shapes leave their slots UNNAMED. Empty when no named body was meshed.
   */
  names: string[];
  heapBytes: number;
  shapeCount: number;
  ms: number;
  /** A recycle that will run right after this reply, before the next batch. */
  recycle: RecycleReason | null;
}

/**
 * A synchronous session on the kernel (ADR 0010 amendment, item 2): `fn` gets the synchronous
 * `Kernel` in the service's exclusive slot, so nothing else runs on the kernel meanwhile, and a
 * script's operations and queries are plain function calls, not batches. A newer generation
 * cannot stop it once it has started (only its own limits can); a session queued behind a newer
 * request is `cancelled` without running, and one that finishes after a newer request arrived is
 * `cancelled` and keeps nothing.
 */
export interface SessionRequest {
  /** As for a batch. */
  generation: number;
  /** Stamped on every shape the session makes (leak reports). */
  featureId?: string;
}

/**
 * What a session function gives back: its value, and the shapes it made that the caller owns
 * from now on. Every other shape made during the session is released when it ends.
 */
export type SessionFunction<T> = (
  kernel: Kernel,
) => { value: T; keep: readonly ShapeId[] } | Promise<{ value: T; keep: readonly ShapeId[] }>;

export interface SessionReply<T> {
  generation: number;
  /** The kernel instance the session ran on (and its kept shapes live in). */
  instance: number;
  status: 'done' | 'cancelled';
  /**
   * The function's value, or the failure it threw (errors as data, ADR 0007 decision 5): a trap
   * is `fatal` and recycles the instance, as for a batch op. Absent when cancelled.
   */
  result?: { ok: true; value: T } | { ok: false; error: KernelFailure };
  heapBytes: number;
  shapeCount: number;
  ms: number;
  recycle: RecycleReason | null;
}

export interface RecycleReport {
  reason: RecycleReason;
  /** The new instance number. */
  instance: number;
  heapBytesBefore: number;
  heapBytesAfter: number;
  /** Shapes that were live in the old instance; their ids are now unknown. */
  lostShapes: number;
  ms: number;
  /** Messages of replay hooks that threw. */
  hookErrors: string[];
}

export type KernelStatus =
  | { type: 'loading'; progress: LoadProgress }
  | { type: 'ready'; instance: number; heapBytes: number }
  | { type: 'recycling'; instance: number; reason: RecycleReason; heapBytes: number }
  | ({ type: 'recycled' } & RecycleReport)
  | { type: 'leak-warning'; liveShapes: number; oldest: ShapeRecord[] }
  | { type: 'error'; message: string };

export interface KernelStats {
  instance: number;
  /** Newest generation seen. */
  generation: number;
  /** Batches with a generation up to this one are cancelled. */
  cancelledThrough: number;
  shapeCount: number;
  heapBytes: number;
  heapThresholdBytes: number;
  /** Batches waiting for the one running. */
  queued: number;
}

export interface KernelServiceConfig {
  /**
   * Recycle at an idle point once the wasm heap is larger than this. Default
   * `DEFAULT_HEAP_THRESHOLD`, 512 MiB (ADR 0002).
   */
  heapThresholdBytes?: number;
  /** Recycle automatically at the threshold (default true). A trap always recycles. */
  autoRecycle?: boolean;
  /** Record creation stacks, and warn about live shape counts. */
  debug?: boolean;
  /** In debug mode, warn once when more shapes than this are live. Default 10,000. */
  maxLiveShapes?: number;
}

export interface KernelServiceOptions extends KernelServiceConfig {
  /** Make a new libcascade instance: `OcctLoader.instantiate`, bound. */
  createInstance: () => Promise<Oc>;
  /** How a batch yields between ops; the default is a macrotask. */
  yieldToEventLoop?: () => Promise<void>;
}

/** Called after a recycle with the new kernel, to replay the document into it. */
export type ReplayHook = (kernel: Kernel, report: RecycleReport) => void | Promise<void>;

/**
 * 512 MiB, set at the end-of-M1 checkpoint from measurements on the M1 to M6 acceptance models
 * (docs/research/end-of-m1-checkpoints.md): they leak 0.1 to 5 MiB per regen, a recycle plus a
 * replay costs 0.4 to 2.4 s, so at this threshold the heaviest model recycles after about 80 full
 * regens (under 2 % of regen time), while the memory a tab holds stays near 550 MiB instead of
 * more than 1 GiB. Every model's single regen fits in the initial 128 MiB, far below it.
 */
export const DEFAULT_HEAP_THRESHOLD = 512 * 1024 * 1024;

/** Let queued messages (a newer request, a cancel) run. */
export function yieldToEventLoop(): Promise<void> {
  // Node's setImmediate, when the host has one. Looked up on globalThis with a
  // local type, so browser apps that compile this file need no Node types.
  const { setImmediate } = globalThis as { setImmediate?: (callback: () => void) => unknown };
  if (typeof setImmediate === 'function') {
    return new Promise((resolve) => setImmediate(() => resolve()));
  }
  // setTimeout(0) is clamped to 4 ms after a few nested calls; a message is not.
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** The buffers of every mesh and exported file in a reply, for `Comlink.transfer`. */
export function collectTransferables(reply: BatchReply): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const r of reply.results as readonly OpResult[]) {
    if (r.ok && r.op === 'tessellate') out.push(...meshBuffers(r.value as MeshData));
    if (r.ok && r.op === 'exportStep')
      out.push((r.value as { data: Uint8Array }).data.buffer as ArrayBuffer);
    if (r.ok && r.op === 'interference') {
      for (const p of (r.value as InterferenceResult).pairs) {
        if (p.mesh) out.push(...meshBuffers(p.mesh));
      }
    }
  }
  return out;
}

function checkRequest(request: unknown): asserts request is BatchRequest {
  // A malformed envelope is a programming error: it throws (ADR 0007,
  // decision 5). Malformed ops inside a good envelope are data.
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('a batch request must be an object');
  }
  const { generation, ops } = request as Partial<BatchRequest>;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) {
    throw new TypeError('a batch request needs an integer generation');
  }
  if (!Array.isArray(ops)) throw new TypeError('a batch request needs an ops array');
}

export class KernelService {
  private current: Kernel;
  private instanceNo = 1;
  private readonly createInstance: () => Promise<Oc>;
  private readonly yield: () => Promise<void>;
  private config: Required<KernelServiceConfig>;
  private readonly listeners = new Set<(status: KernelStatus) => void>();
  private readonly hooks = new Set<ReplayHook>();
  private latest = Number.NEGATIVE_INFINITY;
  private cancelledThrough = Number.NEGATIVE_INFINITY;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private scheduled: RecycleReason | null = null;
  private leakWarned = false;

  private constructor(oc: Oc, options: KernelServiceOptions) {
    this.createInstance = options.createInstance;
    this.yield = options.yieldToEventLoop ?? yieldToEventLoop;
    this.config = {
      heapThresholdBytes: DEFAULT_HEAP_THRESHOLD,
      autoRecycle: true,
      debug: false,
      maxLiveShapes: 10_000,
    };
    this.configure(options);
    this.current = new Kernel(oc, { debug: this.config.debug });
  }

  static async create(options: KernelServiceOptions): Promise<KernelService> {
    return new KernelService(await options.createInstance(), options);
  }

  /** The synchronous kernel, for code running in the worker (the regen engine). */
  get kernel(): Kernel {
    return this.current;
  }

  get instance(): number {
    return this.instanceNo;
  }

  configure(config: KernelServiceConfig): void {
    const next = { ...this.config };
    if (config.heapThresholdBytes !== undefined)
      next.heapThresholdBytes = config.heapThresholdBytes;
    if (config.autoRecycle !== undefined) next.autoRecycle = config.autoRecycle;
    if (config.debug !== undefined) next.debug = config.debug;
    if (config.maxLiveShapes !== undefined) next.maxLiveShapes = config.maxLiveShapes;
    this.config = next;
    // Undefined only while the constructor runs.
    (this.current as Kernel | undefined)?.setDebug(next.debug);
  }

  /** Subscribe to status events. Returns the unsubscribe function. */
  onStatus(listener: (status: KernelStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Register a replay hook, run after every recycle. Returns the unregister function. */
  onRecycle(hook: ReplayHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** Run a batch. Resolves when it is done or cancelled; rejects only for a malformed envelope. */
  run<const T extends readonly KernelOp[]>(request: BatchRequest<T>): Promise<BatchReply<T>> {
    checkRequest(request);
    this.latest = Math.max(this.latest, request.generation);
    this.queued++;
    return this.exclusive(async () => {
      this.queued--;
      return (await this.runBatch(request)) as BatchReply<T>;
    });
  }

  /**
   * Run a synchronous session on the kernel in the exclusive slot (see `SessionRequest`). Kept
   * shapes that are not live, or were made before the session, are ignored. Rejects only for a
   * malformed request.
   */
  session<T>(request: SessionRequest, fn: SessionFunction<T>): Promise<SessionReply<T>> {
    if (
      typeof request !== 'object' ||
      request === null ||
      !Number.isSafeInteger(request.generation)
    ) {
      return Promise.reject(new TypeError('a session request needs an integer generation'));
    }
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('a session needs a function'));
    }
    const { generation, featureId } = request;
    this.latest = Math.max(this.latest, generation);
    this.queued++;
    return this.exclusive(async () => {
      this.queued--;
      return this.runSession(generation, featureId, fn);
    });
  }

  /**
   * Release shapes outside any batch: after everything queued before it, but
   * never cancelled, and without making its caller the newest request. For
   * shapes nobody will ever ask about again, such as those a dropped reply
   * kept, whose release must survive the edits that keep coming. Ids that are
   * not live (released already, or lost to a recycle) come back as `unknown`.
   * Rejects only when `shapes` is not an array of integers.
   */
  release(shapes: readonly ShapeId[]): Promise<ReleaseResult> {
    if (!Array.isArray(shapes) || !shapes.every((id) => Number.isSafeInteger(id))) {
      return Promise.reject(new TypeError('release needs an array of integer shape ids'));
    }
    const ids = [...shapes];
    return this.exclusive(async () => {
      // On a lost kernel the arena may still list shapes until the recycle
      // abandons them; `Kernel.release` forgets them without touching wasm.
      const kernel = this.current;
      const out: ReleaseResult = { released: [], unknown: [] };
      for (const id of ids) (kernel.release(id) ? out.released : out.unknown).push(id);
      return out;
    });
  }

  /** Cancel every batch up to `generation` (default: the newest seen), queued or running. */
  cancel(generation?: number): void {
    const g = generation ?? this.latest;
    this.cancelledThrough = Math.max(this.cancelledThrough, g);
  }

  /** Recycle now (after the running batch). Every live shape id becomes unknown. */
  recycle(reason: RecycleReason = 'requested'): Promise<RecycleReport> {
    // A recycle already pending (after a trap) is the one that runs; its reason wins.
    return this.exclusive(() => this.doRecycle(this.scheduled ?? reason));
  }

  stats(): KernelStats {
    return {
      instance: this.instanceNo,
      generation: this.latest,
      cancelledThrough: this.cancelledThrough,
      shapeCount: this.current.shapeCount,
      heapBytes: this.current.heapBytes(),
      heapThresholdBytes: this.config.heapThresholdBytes,
      queued: this.queued,
    };
  }

  /** Every live shape with its provenance, oldest first. */
  leaks(): ShapeRecord[] {
    return this.current.liveShapes();
  }

  /** Resolves when everything submitted so far, including a scheduled recycle, has run. */
  idle(): Promise<void> {
    return this.exclusive(async () => undefined);
  }

  // Internals --------------------------------------------------------------------

  private emit(status: KernelStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // A broken listener must not break the kernel.
      }
    }
  }

  private isStale(generation: number): boolean {
    return generation < this.latest || generation <= this.cancelledThrough;
  }

  /** Run `fn` after everything queued before it; nothing runs concurrently. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runBatch(request: BatchRequest): Promise<BatchReply> {
    const t0 = performance.now();
    const { generation, ops } = request;
    // A batch that was queued before a trap must not run on the dead
    // instance: the pending recycle runs first, and its queued task then has
    // nothing left to do.
    if (this.scheduled !== null) {
      try {
        await this.doRecycle(this.scheduled);
      } catch {
        // Reported through an 'error' status; the ops below fail as 'fatal'.
      }
    }
    const kernel = this.current;
    const results: OpResult[] = [];
    const names = new NameTable();
    const created: ShapeId[] = [];
    const transient: ShapeId[] = [];
    let cancelled = false;

    for (let i = 0; i < ops.length; i++) {
      await this.yield();
      if (this.isStale(generation)) {
        cancelled = true;
        break;
      }
      const op: unknown = ops[i];
      const started = performance.now();
      const featureId =
        typeof op === 'object' && op !== null && typeof (op as KernelOp).featureId === 'string'
          ? (op as KernelOp).featureId
          : featureOpId(op);
      const name =
        typeof op === 'object' && op !== null && typeof (op as KernelOp).op === 'string'
          ? (op as KernelOp).op
          : 'unknown';
      const fail = (error: KernelFailure): void => {
        results.push({
          ok: false,
          op: name,
          ...(featureId === undefined ? {} : { featureId }),
          error,
          ms: performance.now() - started,
        });
      };
      const invalid = validateOp(op);
      if (invalid !== null) {
        fail({
          code: 'invalid-op',
          operation: name,
          message: invalid,
          ...(featureId === undefined ? {} : { featureId }),
        });
        continue;
      }
      const valid = op as KernelOp;
      const earlierOk = (j: number, operation: string): OpResult & { ok: true } => {
        if (!(Number.isInteger(j) && j >= 0 && j < i)) {
          throw new KernelError(operation, `{ result: ${j} } is not an earlier op of this batch`, {
            code: 'invalid-op',
          });
        }
        const earlier = results[j]!;
        if (!earlier.ok) {
          throw new KernelError(operation, `op ${j} (${earlier.op}) failed`, {
            code: 'dependency',
          });
        }
        return earlier;
      };
      const resolve = (ref: ShapeRef, operation: string): ShapeId => {
        if (typeof ref === 'number') return ref;
        const j = ref.result;
        const earlier = earlierOk(j, operation);
        const shape = shapeOf(earlier.value, ref.body);
        if (shape === null) {
          const what =
            ref.body !== undefined
              ? `has no body ${ref.body}`
              : bodiesOf(earlier.value) !== null
                ? 'left several bodies or none: name one with { result, body }'
                : 'made no shape';
          throw new KernelError(operation, `op ${j} (${earlier.op}) ${what}`, {
            code: 'invalid-op',
          });
        }
        return shape;
      };
      const resolveBodies = (ref: { result: number }, operation: string): FeatureBody[] => {
        const earlier = earlierOk(ref.result, operation);
        const bodies = bodiesOf(earlier.value);
        if (bodies === null) {
          throw new KernelError(
            operation,
            `op ${ref.result} (${earlier.op}) is not a feature op: it has no bodies`,
            { code: 'invalid-op' },
          );
        }
        return bodies;
      };
      kernel.setContext({ generation, ...(featureId === undefined ? {} : { featureId }) });
      // Every shape an op makes has an id from here on; a feature op that
      // passes its input body through returns an older one, not its own.
      const mark = kernel.checkpoint();
      try {
        const value = executeOp(kernel, valid, resolve, { names, resolveBodies });
        for (const shape of new Set(shapesOf(value))) {
          if (shape < mark) continue;
          created.push(shape);
          if (valid.keep === false) transient.push(shape);
        }
        results.push({
          ok: true,
          op: valid.op,
          ...(featureId === undefined ? {} : { featureId }),
          value,
          ms: performance.now() - started,
        } as OpResult);
      } catch (error) {
        fail(failureOf(error, name, featureId));
      } finally {
        kernel.setContext({});
      }
    }
    if (!cancelled) {
      // A newer request that arrived during the last op is only seen after one
      // more yield. Replying 'done' to it would hand kept shapes to a caller
      // that drops the reply, so the batch is cancelled and they are released.
      // `release` ops that ran are not undone. An empty batch has nothing to
      // wait for, but a stale one is cancelled like any other.
      if (ops.length > 0) await this.yield();
      cancelled = this.isStale(generation);
    }

    if (kernel.lostReason === null) {
      // A cancelled batch keeps nothing: its reply is dropped by the caller.
      for (const id of cancelled ? created : transient) kernel.release(id);
    }
    this.afterBatch(kernel);
    return {
      generation,
      instance: this.instanceNo,
      status: cancelled ? 'cancelled' : 'done',
      results: (cancelled ? [] : results) as unknown as OpResults<readonly KernelOp[]>,
      completedOps: results.length,
      names: cancelled ? [] : names.names,
      heapBytes: kernel.heapBytes(),
      shapeCount: kernel.shapeCount,
      ms: performance.now() - t0,
      recycle: this.scheduled,
    };
  }

  private async runSession<T>(
    generation: number,
    featureId: string | undefined,
    fn: SessionFunction<T>,
  ): Promise<SessionReply<T>> {
    const t0 = performance.now();
    if (this.scheduled !== null) {
      try {
        await this.doRecycle(this.scheduled);
      } catch {
        // Reported through an 'error' status; the session below fails as 'fatal'.
      }
    }
    const kernel = this.current;
    const reply = (
      status: 'done' | 'cancelled',
      result?: SessionReply<T>['result'],
    ): SessionReply<T> => ({
      generation,
      instance: this.instanceNo,
      status,
      ...(result === undefined ? {} : { result }),
      heapBytes: kernel.heapBytes(),
      shapeCount: kernel.shapeCount,
      ms: performance.now() - t0,
      recycle: this.scheduled,
    });
    if (this.isStale(generation)) return reply('cancelled');
    const mark = kernel.checkpoint();
    const releaseSince = (keep: ReadonlySet<ShapeId>) => {
      if (kernel.lostReason !== null) return;
      for (const shape of kernel.liveShapes()) {
        if (shape.id >= mark && !keep.has(shape.id)) kernel.release(shape.id);
      }
    };
    kernel.setContext({ generation, ...(featureId === undefined ? {} : { featureId }) });
    let out: { value: T; keep: readonly ShapeId[] };
    try {
      out = await fn(kernel);
    } catch (error) {
      kernel.setContext({});
      releaseSince(new Set());
      this.afterBatch(kernel);
      return reply('done', { ok: false, error: failureOf(error, 'session', featureId) });
    }
    kernel.setContext({});
    // As after a batch: a newer request seen only now makes the session cancelled.
    await this.yield();
    const cancelled = this.isStale(generation) || kernel.lostReason !== null;
    releaseSince(cancelled ? new Set() : new Set(out.keep));
    this.afterBatch(kernel);
    if (kernel.lostReason !== null) {
      return reply('done', {
        ok: false,
        error: failureOf(new Error(kernel.lostReason), 'session', featureId),
      });
    }
    return cancelled ? reply('cancelled') : reply('done', { ok: true, value: out.value });
  }

  private afterBatch(kernel: Kernel): void {
    if (kernel.lostReason !== null) {
      this.scheduleRecycle('fatal');
    } else if (
      this.config.autoRecycle &&
      this.queued === 0 &&
      kernel.heapBytes() > this.config.heapThresholdBytes
    ) {
      this.scheduleRecycle('heap-threshold');
    }
    if (this.config.debug) {
      const live = kernel.shapeCount;
      if (live > this.config.maxLiveShapes && !this.leakWarned) {
        this.leakWarned = true;
        this.emit({
          type: 'leak-warning',
          liveShapes: live,
          oldest: kernel.liveShapes().slice(0, 20),
        });
      } else if (live <= this.config.maxLiveShapes) {
        this.leakWarned = false;
      }
    }
  }

  /**
   * Make a recycle pending. It runs before the next batch: at the start of a
   * batch that was already queued (see `runBatch`), or else as its own queued
   * task, which finds nothing to do when a batch got there first.
   */
  private scheduleRecycle(reason: RecycleReason): void {
    if (this.scheduled !== null) return;
    this.scheduled = reason;
    this.exclusive(async () => {
      if (this.scheduled !== null) await this.doRecycle(this.scheduled);
    }).catch(() => {
      // Reported through an 'error' status by doRecycle.
    });
  }

  private async doRecycle(reason: RecycleReason): Promise<RecycleReport> {
    const t0 = performance.now();
    const old = this.current;
    const heapBytesBefore = old.heapBytes();
    this.emit({ type: 'recycling', instance: this.instanceNo, reason, heapBytes: heapBytesBefore });
    // The old instance may be poisoned: its shapes are forgotten, not
    // released. Dropping it is what returns its memory.
    const lostShapes = old.abandon(`recycled (${reason})`);
    this.leakWarned = false;
    let oc: Oc;
    try {
      oc = await this.createInstance();
    } catch (error) {
      this.scheduled = null;
      const message = `recycle failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit({ type: 'error', message });
      throw new Error(message, { cause: error });
    }
    this.current = new Kernel(oc, { firstId: old.nextId, debug: this.config.debug });
    this.instanceNo++;
    this.scheduled = null;
    const report: RecycleReport = {
      reason,
      instance: this.instanceNo,
      heapBytesBefore,
      heapBytesAfter: this.current.heapBytes(),
      lostShapes,
      ms: 0,
      hookErrors: [],
    };
    for (const hook of this.hooks) {
      try {
        await hook(this.current, report);
      } catch (error) {
        report.hookErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    report.ms = performance.now() - t0;
    report.heapBytesAfter = this.current.heapBytes();
    this.emit({ type: 'recycled', ...report });
    return report;
  }
}

/** The feature id of a `feature` op, so its shapes and failures carry it without `featureId`. */
function featureOpId(op: unknown): string | undefined {
  if (typeof op !== 'object' || op === null || (op as { op?: unknown }).op !== 'feature') {
    return undefined;
  }
  const feature = (op as { feature?: unknown }).feature;
  const id =
    typeof feature === 'object' && feature !== null ? (feature as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
}
