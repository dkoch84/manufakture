// Main-thread side of the CAM worker (T5.1g; ADR 0014 decisions 1 and 7): `CamClient`, a thin
// wrapper that starts the worker lazily, on the first call that needs it, numbers requests by
// generation and drops replies a newer request has superseded (ADR 0007 decision 4): UI code sees
// `null` for a stale reply and must not assume one reply per request. Expression evaluation, the
// geometry stage, cache keys and stale flags are the app's (ADR 0014 decision 7).
//
// This module holds no `new Worker(...)`: Vite bundles the worker of every module that contains
// one, used or not, so the host spawns it (apps/web/src/cam/spawn.ts) and passes `connect`.

import * as Comlink from 'comlink';
import type { StatsOptions } from './stats';
import type { Setup } from './types';
import type {
  CamCacheInfo,
  CamChannel,
  CamGenerateReply,
  CamSimulateReply,
  CamSimulateRequest,
  CamToolpathStats,
  CamWorkerApi,
} from './worker/api';

/** Something to talk to, and a way to stop it. */
export interface CamEndpoint {
  endpoint: Comlink.Endpoint;
  terminate(): void;
}

export type CamGenerateResult = Extract<CamGenerateReply, { status: 'done' | 'failed' }>;
export type CamSimulateResult = Extract<CamSimulateReply, { status: 'done' | 'failed' }>;

export interface CamGenerateOptions {
  /** Generate only these operation ids. */
  only?: readonly string[];
  /** Cache keys by operation id, as the app computed them (`toolpathKey`). */
  keys?: Readonly<Record<string, string>>;
  /** The machine table row the setup uses. */
  machine?: unknown;
  /**
   * Transfer the `surface3d` meshes' buffers into the worker instead of copying them (ADR 0014
   * decision 7): the caller's arrays are detached afterwards.
   */
  transferMeshes?: boolean;
}

export class CamClient {
  private readonly connect: () => CamEndpoint;
  private current: CamEndpoint | null = null;
  private remote: Comlink.Remote<CamWorkerApi> | null = null;
  private readonly generations: Record<CamChannel, number> = { generate: 0, simulate: 0 };
  /** Resolvers of the calls in flight, so that `terminate` can settle them with null. */
  private readonly pending = new Set<(value: null) => void>();

  constructor(connect: () => CamEndpoint) {
    this.connect = connect;
  }

  /** True once the worker has been started. */
  get started(): boolean {
    return this.current !== null;
  }

  /** The newest generation handed out on a channel. */
  latestGeneration(channel: CamChannel = 'generate'): number {
    return this.generations[channel];
  }

  /**
   * Generate a setup's operations, superseding every earlier `generate`. Resolves to null when
   * the reply is stale (a newer request was made meanwhile, or the client was terminated).
   */
  async generate(
    setup: Setup,
    options: CamGenerateOptions = {},
  ): Promise<CamGenerateResult | null> {
    const generation = ++this.generations.generate;
    const { transferMeshes, ...rest } = options;
    let request = { generation, setup, ...rest };
    if (transferMeshes) {
      const buffers = setup.operations.flatMap((op) =>
        op.kind === 'surface3d'
          ? [op.mesh.positions.buffer as ArrayBuffer, op.mesh.indices.buffer as ArrayBuffer]
          : [],
      );
      request = Comlink.transfer(request, [...new Set(buffers)]);
    }
    const reply = await this.call<CamGenerateReply>((remote) => remote.generate(request));
    if (reply === null || generation !== this.generations.generate) return null;
    return reply.status === 'cancelled' ? null : reply;
  }

  /** Simulate cached toolpaths, superseding every earlier `simulate`; null when stale. */
  async simulate(
    request: Omit<CamSimulateRequest, 'generation'>,
  ): Promise<CamSimulateResult | null> {
    const generation = ++this.generations.simulate;
    const reply = await this.call<CamSimulateReply>((remote) =>
      remote.simulate({ ...request, generation }),
    );
    if (reply === null || generation !== this.generations.simulate) return null;
    return reply.status === 'cancelled' ? null : reply;
  }

  /** Statistics of cached toolpaths by key; all null (and no worker started) before any call. */
  async stats(
    keys: readonly string[],
    options: StatsOptions,
  ): Promise<(CamToolpathStats | null)[]> {
    if (!this.remote) return keys.map(() => null);
    return (await this.call((remote) => remote.stats(keys, options))) ?? keys.map(() => null);
  }

  /** Cancel whatever runs on `channel`; its call resolves to null. */
  async cancel(channel: CamChannel = 'generate'): Promise<void> {
    const generation = ++this.generations[channel];
    if (this.remote) await this.remote.cancel(channel, generation);
  }

  /** The worker's cache size and counts; null before the worker started. */
  async cacheInfo(): Promise<CamCacheInfo | null> {
    if (!this.remote) return null;
    return this.call((remote) => remote.cacheInfo());
  }

  async clearCache(): Promise<void> {
    if (this.remote) await this.remote.clearCache();
  }

  /** Stop the worker (its cache goes with it); calls in flight resolve to null. */
  terminate(): void {
    this.generations.generate++;
    this.generations.simulate++;
    for (const settle of this.pending) settle(null);
    this.pending.clear();
    this.remote?.[Comlink.releaseProxy]();
    this.current?.terminate();
    this.current = null;
    this.remote = null;
  }

  /** Run a call on the worker, resolving to null if `terminate` drops it. */
  private async call<T>(
    fn: (remote: Comlink.Remote<CamWorkerApi>) => PromiseLike<T>,
  ): Promise<T | null> {
    const remote = this.worker();
    let settle!: (value: null) => void;
    const dropped = new Promise<null>((resolve) => (settle = resolve));
    this.pending.add(settle);
    try {
      return await Promise.race([fn(remote), dropped]);
    } finally {
      this.pending.delete(settle);
    }
  }

  private worker(): Comlink.Remote<CamWorkerApi> {
    if (!this.remote) {
      this.current = this.connect();
      this.remote = Comlink.wrap<CamWorkerApi>(this.current.endpoint);
    }
    return this.remote;
  }
}
