// Main-thread side of the regen worker: the kernel client (batches for pick, measure, export,
// numbered by generation, ADR 0007 decision 4) plus `regen`. Every request of every kind takes
// its generation from the one sequence the client keeps, because the kernel service cancels by
// generation whoever sent the batch: a regen cancels the batches of older requests, and a pick
// or measure sent at the current generation never cancels a regen. Only a regen may take a new
// generation: any other batch that did would cancel the regen in flight, with nothing to report
// in its place.

import type { DragTarget } from '@manufakture/assembly';
import type { ManufaktureDocument } from '@manufakture/core';
import { KernelClient, type KernelClientOptions } from '@manufakture/kernel/kernel-client';
import type { EngineStats } from './engine';
import type { AssemblyResult, DragResult, RegenResult } from './types';
import type { RegenWorkerApi } from './worker-api';

export class RegenClient extends KernelClient {
  /**
   * Regenerate `document` at a new generation. Resolves to null when a newer request superseded
   * it in the worker (a newer regen, or any batch submitted at a new generation), or when the
   * worker was stopped (`restart`, `terminate`) before it answered; after a restart the owner
   * hears of it through `onRestarted` and asks again. A regen that completed is always returned,
   * even when a newer request was made meanwhile: the engine reports each changed mesh once (to
   * the regen that built it), so a caller that drops a completed result must not rely on
   * `meshChanged` afterwards.
   */
  regen(document: ManufaktureDocument): Promise<RegenResult | null> {
    const generation = this.nextGeneration();
    return this.droppable(
      this.worker<RegenWorkerApi>().regen(document, { generation }) as Promise<RegenResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * Solve an assembly of `document` for a preview, at the current generation (never cancelling
   * a regen). A mate dialog shows the result, then commits the mate and the solved poses of the
   * instances that `moved` in one `batch`. Null when superseded or when the worker was stopped.
   */
  solveAssembly(document: ManufaktureDocument, assemblyId: string): Promise<AssemblyResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().solveAssembly(document, assemblyId, {
        generation: this.latestGeneration,
      }) as Promise<AssemblyResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * One step of a pointer drag of an instance, at the current generation, from where the last
   * step left the assembly (after a regen: its solved poses). Send one per pointer move: the
   * worker coalesces them and answers only the latest (the others resolve to null). On release,
   * commit `setPoses` with the last result's `moved` instances.
   */
  dragInstance(
    assemblyId: string,
    instanceId: string,
    target: DragTarget,
  ): Promise<DragResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().dragInstance(assemblyId, instanceId, target, {
        generation: this.latestGeneration,
      }) as Promise<DragResult | null>,
    ).then((result) => result ?? null);
  }

  regenStats(): Promise<EngineStats> {
    return this.worker<RegenWorkerApi>().regenStats() as Promise<EngineStats>;
  }
}

/** Start the regen worker (the kernel plus the regen engine) and connect to it. */
export function spawnRegenWorker(options: KernelClientOptions = {}): RegenClient {
  return new RegenClient(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'manufakture-kernel',
    });
    return { endpoint: worker, terminate: () => worker.terminate() };
  }, options);
}
