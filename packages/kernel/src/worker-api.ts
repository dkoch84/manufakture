// The Comlink-facing API of the kernel worker (ADR 0007, decision 2). It is a
// thin layer over KernelService that adds loading (with progress for the
// splash screen) and marks mesh buffers for transfer. It has no dependency on
// a real worker, so tests expose it on a MessageChannel.

import * as Comlink from 'comlink';
import { OcctLoader, type LoadProgress, type LoaderOptions, type WasmSource } from './loader';
import type { KernelOp, ReleaseResult } from './ops';
import {
  collectTransferables,
  KernelService,
  type BatchReply,
  type BatchRequest,
  type KernelServiceConfig,
  type KernelServiceOptions,
  type KernelStats,
  type KernelStatus,
  type RecycleReport,
} from './service';
import type { ShapeId, ShapeRecord } from './types';

export interface InitReport {
  instance: number;
  heapBytes: number;
  /** From the start of loading to a usable kernel, measured in the worker. */
  ms: number;
}

export interface KernelWorkerApi {
  /**
   * Wait for the kernel, loading it first if needed, and subscribe `onStatus`
   * (a `Comlink.proxy`) to loading progress and later status events. The
   * latest loading progress is replayed to a new subscriber. Idempotent: every
   * call returns the same report. Rejects when the kernel cannot be loaded.
   */
  init(
    config?: KernelServiceConfig,
    onStatus?: (status: KernelStatus) => void,
  ): Promise<InitReport>;
  /** Run a batch; mesh buffers in the reply are transferred, not copied. */
  run<const T extends readonly KernelOp[]>(request: BatchRequest<T>): Promise<BatchReply<T>>;
  /**
   * Release shapes outside any batch; never cancelled, and it does not count
   * as a newer request (see `KernelService.release`).
   */
  release(shapes: readonly ShapeId[]): Promise<ReleaseResult>;
  cancel(generation?: number): Promise<void>;
  recycle(): Promise<RecycleReport>;
  stats(): Promise<KernelStats>;
  leaks(): Promise<ShapeRecord[]>;
}

export interface WorkerApiOptions {
  source: WasmSource;
  loader?: Omit<LoaderOptions, 'onProgress'>;
  /** Start loading right away, before `init` (ADR 0002: overlap kernel start-up with UI start-up). */
  eager?: boolean;
  /** Passed through to the service, for tests. */
  service?: Omit<KernelServiceOptions, 'createInstance'>;
}

/** Build the API object, for a worker entry to pass to `Comlink.expose` (regen's `worker.ts`). */
export function createKernelWorkerApi(options: WorkerApiOptions): KernelWorkerApi & {
  /** The service, once loaded; for code running in the same worker (the regen engine). */
  readonly service: KernelService | null;
} {
  const subscribers = new Set<(status: KernelStatus) => void>();
  let lastLoading: KernelStatus | null = null;
  let service: KernelService | null = null;
  let starting: Promise<{ service: KernelService; ms: number }> | null = null;

  const send = (status: KernelStatus) => {
    for (const s of subscribers) {
      // A proxied callback returns a promise, which rejects when the page is
      // gone; that must not surface as an unhandled rejection.
      Promise.resolve()
        .then(() => s(status))
        .catch(() => subscribers.delete(s));
    }
  };

  const loader = new OcctLoader(options.source, {
    ...options.loader,
    onProgress: (progress: LoadProgress) => {
      lastLoading = { type: 'loading', progress };
      send(lastLoading);
    },
  });

  const start = () => {
    if (starting === null) {
      const t0 = performance.now();
      const attempt = KernelService.create({
        ...options.service,
        createInstance: () => loader.instantiate(),
      }).then((created) => {
        service = created;
        created.onStatus(send);
        send({ type: 'ready', instance: created.instance, heapBytes: created.kernel.heapBytes() });
        return { service: created, ms: performance.now() - t0 };
      });
      attempt.catch((error: unknown) => {
        starting = null;
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
      starting = attempt;
    }
    return starting;
  };

  const ready = async () => (await start()).service;

  if (options.eager) void start().catch(() => undefined);

  return {
    get service() {
      return service;
    },

    async init(config, onStatus) {
      if (onStatus) {
        subscribers.add(onStatus);
        const replay = lastLoading;
        if (replay !== null && service === null) {
          Promise.resolve()
            .then(() => onStatus(replay))
            .catch(() => subscribers.delete(onStatus));
        }
      }
      const { service: s, ms } = await start();
      if (config) s.configure(config);
      return { instance: s.instance, heapBytes: s.kernel.heapBytes(), ms };
    },

    async run(request) {
      const reply = await (await ready()).run(request);
      return Comlink.transfer(reply, collectTransferables(reply));
    },

    async release(shapes) {
      return (await ready()).release(shapes);
    },

    async cancel(generation) {
      (await ready()).cancel(generation);
    },

    async recycle() {
      return (await ready()).recycle();
    },

    async stats() {
      return (await ready()).stats();
    },

    async leaks() {
      return (await ready()).leaks();
    },
  };
}
