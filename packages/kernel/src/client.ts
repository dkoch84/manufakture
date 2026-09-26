// Main-thread side of the kernel worker (ADR 0007). The UI never touches the
// kernel directly: it submits batches here and gets replies with transferred
// meshes. The client numbers requests by generation and drops replies that a
// newer request has superseded (decision 4), so UI code sees `null` for a
// stale reply and must not assume one reply per request.

import * as Comlink from 'comlink';
import type { KernelOp } from './ops';
import type {
  BatchReply,
  KernelServiceConfig,
  KernelStats,
  KernelStatus,
  RecycleReport,
} from './service';
import type { ShapeId, ShapeRecord } from './types';
import type { InitReport, KernelWorkerApi } from './worker-api';

/** Something to talk to, and a way to stop it. */
export interface KernelEndpoint {
  endpoint: Comlink.Endpoint;
  terminate(): void;
}

export interface KernelClientOptions {
  /** Called with loading progress and later status events (recycles, leak warnings). */
  onStatus?: (status: KernelStatus) => void;
  config?: KernelServiceConfig;
}

export class KernelClient {
  private readonly connect: () => KernelEndpoint;
  private readonly options: KernelClientOptions;
  private current!: KernelEndpoint;
  private remote!: Comlink.Remote<KernelWorkerApi>;
  private generation = 0;
  private readonly pending = new Set<(value: null) => void>();
  /** Resolves when the (current) worker has loaded its kernel. */
  ready!: Promise<InitReport>;

  constructor(connect: () => KernelEndpoint, options: KernelClientOptions = {}) {
    this.connect = connect;
    this.options = options;
    this.start();
  }

  /** The newest generation handed out. */
  get latestGeneration(): number {
    return this.generation;
  }

  /** A new generation, superseding every earlier request. */
  nextGeneration(): number {
    return ++this.generation;
  }

  /**
   * Submit a batch. Without a generation it gets a new one, superseding every
   * earlier request. Resolves to null when the reply is stale: a newer request
   * was made meanwhile, or the worker was restarted.
   */
  async submit<const T extends readonly KernelOp[]>(
    ops: T,
    generation: number = this.nextGeneration(),
  ): Promise<BatchReply<T> | null> {
    this.generation = Math.max(this.generation, generation);
    const remote = this.remote;
    const call = remote.run({ generation, ops }) as Promise<BatchReply<T>>;
    let drop!: (value: null) => void;
    const dropped = new Promise<null>((resolve) => {
      drop = resolve;
    });
    this.pending.add(drop);
    try {
      const reply = await Promise.race([call, dropped]);
      if (reply === null) return null;
      if (reply.generation < this.generation) {
        // Superseded after it finished: nobody gets its shape ids, so release them.
        if (reply.status === 'done' && remote === this.remote) this.releaseKept(ops, reply);
        return null;
      }
      return reply;
    } finally {
      this.pending.delete(drop);
    }
  }

  /** Cancel everything submitted so far. */
  cancel(): Promise<void> {
    return this.remote.cancel(this.generation);
  }

  recycle(): Promise<RecycleReport> {
    return this.remote.recycle();
  }

  stats(): Promise<KernelStats> {
    return this.remote.stats();
  }

  leaks(): Promise<ShapeRecord[]> {
    return this.remote.leaks();
  }

  /**
   * The last resort for an operation that never returns (ADR 0007, decision
   * 4): terminate the worker and start a new one. Pending submits resolve to
   * null, and every shape id is gone; the caller replays the document.
   */
  restart(): Promise<InitReport> {
    this.shutdown();
    this.start();
    return this.ready;
  }

  /** Stop the worker for good. Pending submits resolve to null. */
  terminate(): void {
    this.shutdown();
  }

  /**
   * Release the shapes a dropped reply kept. This is not a batch: a batch at
   * any generation could be cancelled by the next edit (during a drag, the
   * usual case) and leak the shapes, and a new generation would supersede
   * the request that made this reply stale. The worker's `release` is never
   * cancelled and leaves the generations alone.
   */
  private releaseKept(ops: readonly KernelOp[], reply: BatchReply): void {
    const shapes: ShapeId[] = [];
    reply.results.forEach((r, i) => {
      if (!r.ok || ops[i]?.keep === false || r.op === 'release') return;
      const shape = (r.value as { shape?: unknown } | null)?.shape;
      if (typeof shape === 'number') shapes.push(shape as ShapeId);
    });
    if (shapes.length === 0) return;
    // Ids that are no longer live (released since, or lost to a recycle) come
    // back as `unknown`, which is fine here.
    void this.remote.release(shapes).catch(() => undefined);
  }

  private start(): void {
    this.current = this.connect();
    this.remote = Comlink.wrap<KernelWorkerApi>(this.current.endpoint);
    const onStatus = this.options.onStatus;
    this.ready = this.remote.init(
      this.options.config,
      onStatus ? Comlink.proxy(onStatus) : undefined,
    ) as Promise<InitReport>;
    // Callers await `ready`; a load failure must not also be an unhandled rejection.
    this.ready.catch(() => undefined);
  }

  private shutdown(): void {
    for (const drop of this.pending) drop(null);
    this.pending.clear();
    // After terminate() the release message is never answered; nothing waits for it.
    void Promise.resolve(this.remote[Comlink.releaseProxy]()).catch(() => undefined);
    this.current.terminate();
  }
}

/** Start the kernel worker and connect to it. Call it at app start-up (ADR 0002). */
export function spawnKernelWorker(options: KernelClientOptions = {}): KernelClient {
  return new KernelClient(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-kernel',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  }, options);
}
