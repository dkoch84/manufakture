// The Comlink-facing API of the regen worker: the kernel worker's API (loading, batches, release,
// cancel, recycle, stats) plus `regen`, with the engine running next to the kernel service in the
// same worker (ADR 0007 decisions 1 and 3). Like the kernel's, it has no dependency on a real
// worker, so tests expose it on a MessageChannel with the Node kernel.
//
// The sketch solver runs in this worker too, in-process (see README, "The worker"): the engine
// awaits every solve before its next kernel op, so a solver in another worker would add a round
// trip per sketch and a dependency on that worker's lifetime, and buy no parallelism.

import type { ManufaktureDocument } from '@manufakture/core';
import {
  createKernelWorkerApi,
  type KernelService,
  type KernelWorkerApi,
  type WorkerApiOptions,
} from '@manufakture/kernel';
import { createSolverService } from '@manufakture/sketch';
import * as Comlink from 'comlink';
import { RegenEngine, type EngineStats, type RegenEngineOptions } from './engine';
import type { RegenSolver } from './sketches';
import { regenTransferables } from './transfer';
import type { RegenResult } from './types';

export interface RegenWorkerApi extends KernelWorkerApi {
  /**
   * Regenerate `document` at `generation` (from the main thread's client, which numbers every
   * request of every kind in one sequence). Resolves to null when a newer regen superseded it;
   * mesh buffers are transferred. Waits for the kernel to load.
   */
  regen(
    document: ManufaktureDocument,
    options: { generation: number },
  ): Promise<RegenResult | null>;
  /** Cumulative engine counters. */
  regenStats(): Promise<EngineStats>;
}

export interface RegenWorkerApiOptions extends WorkerApiOptions {
  /** The sketch solver; default: planegcs in this worker, loaded on the first solve. */
  solver?: RegenSolver;
  /** Passed to the engine (cache, tessellation, build identities). */
  engine?: Omit<RegenEngineOptions, 'kernel' | 'solver'>;
}

/** Build the API object; `worker.ts` passes it to `Comlink.expose`. */
export function createRegenWorkerApi(options: RegenWorkerApiOptions): RegenWorkerApi & {
  /** The engine, once the kernel has loaded; for tests. */
  readonly engine: RegenEngine | null;
} {
  const kernelApi = createKernelWorkerApi(options);
  const solver = options.solver ?? createSolverService();
  let engine: RegenEngine | null = null;

  const engineFor = async (): Promise<RegenEngine> => {
    await kernelApi.init();
    const service = kernelApi.service as KernelService;
    // After a recycle every cached body is gone. The main thread hears of it through the
    // kernel's `recycled` status and asks for a regen of its current document; the engine only
    // forgets here (its hook runs inside the service's queue, where nothing may be submitted).
    engine ??= new RegenEngine({ ...options.engine, kernel: service, solver });
    return engine;
  };

  return {
    get engine() {
      return engine;
    },
    init: (config, onStatus) => kernelApi.init(config, onStatus),
    run: (request) => kernelApi.run(request),
    release: (shapes) => kernelApi.release(shapes),
    cancel: (generation) => kernelApi.cancel(generation),
    recycle: () => kernelApi.recycle(),
    stats: () => kernelApi.stats(),
    leaks: () => kernelApi.leaks(),

    async regen(document, { generation }) {
      const result = await (await engineFor()).regen(document, { generation });
      return result === null ? null : Comlink.transfer(result, regenTransferables(result));
    },

    async regenStats() {
      return (await engineFor()).stats;
    },
  };
}
