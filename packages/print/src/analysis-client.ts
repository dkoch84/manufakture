// Main-thread side of the print-analysis worker (ADR 0012 decision 5), apart from the worker's
// spawn (client.ts), so that tests and other hosts can connect it to any endpoint. The client
// starts its worker lazily, on the first analysis, numbers requests by generation and drops
// replies a newer request has superseded (ADR 0007 decision 4): UI code sees `null` for a stale
// reply and must not assume one reply per request. Bodies are copied into the worker (the main
// thread keeps its meshes for drawing); the reply's arrays arrive transferred.

import * as Comlink from 'comlink';
import type { ThicknessOptions } from './thickness';
import type { PrintThresholds } from './thresholds';
import type { PrintAnalysisBody, PrintAnalysisReply, PrintWorkerApi } from './worker-api';

/** Something to talk to, and a way to stop it. */
export interface PrintEndpoint {
  endpoint: Comlink.Endpoint;
  terminate(): void;
}

export type PrintAnalysisResult = Extract<PrintAnalysisReply, { status: 'done' | 'failed' }>;

export class PrintAnalysisClient {
  private readonly connect: () => PrintEndpoint;
  private current: PrintEndpoint | null = null;
  private remote: Comlink.Remote<PrintWorkerApi> | null = null;
  private generation = 0;
  /** Resolvers of the analyses in flight, so that `terminate` can settle them with null. */
  private readonly pending = new Set<(value: null) => void>();

  constructor(connect: () => PrintEndpoint) {
    this.connect = connect;
  }

  /** True once the worker has been started (by the first `analyze`). */
  get started(): boolean {
    return this.current !== null;
  }

  /** The newest generation handed out. */
  get latestGeneration(): number {
    return this.generation;
  }

  /**
   * Analyse a setup's oriented bodies, superseding every earlier request. Resolves to null when
   * the reply is stale (a newer request was made meanwhile, or the client was terminated).
   */
  async analyze(
    bodies: PrintAnalysisBody[],
    thresholds: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>,
    options?: Omit<ThicknessOptions, 'thresholds'>,
  ): Promise<PrintAnalysisResult | null> {
    const generation = ++this.generation;
    const remote = this.worker();
    let settle!: (value: null) => void;
    const dropped = new Promise<null>((resolve) => (settle = resolve));
    this.pending.add(settle);
    try {
      const reply = await Promise.race([
        remote.analyze({ generation, bodies, thresholds, ...(options ? { options } : {}) }),
        dropped,
      ]);
      if (reply === null || generation !== this.generation || reply.status === 'cancelled') {
        return null;
      }
      return reply;
    } finally {
      this.pending.delete(settle);
    }
  }

  /** Cancel whatever is running; its `analyze` resolves to null. */
  async cancel(): Promise<void> {
    const generation = ++this.generation;
    if (this.remote) await this.remote.cancel(generation);
  }

  /** Stop the worker; analyses in flight resolve to null. A later `analyze` starts a new one. */
  terminate(): void {
    this.generation++;
    for (const settle of this.pending) settle(null);
    this.pending.clear();
    this.remote?.[Comlink.releaseProxy]();
    this.current?.terminate();
    this.current = null;
    this.remote = null;
  }

  private worker(): Comlink.Remote<PrintWorkerApi> {
    if (!this.remote) {
      this.current = this.connect();
      this.remote = Comlink.wrap<PrintWorkerApi>(this.current.endpoint);
    }
    return this.remote;
  }
}
