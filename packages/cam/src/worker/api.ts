// The Comlink-facing API of the CAM worker (T5.1g; ADR 0014 decision 7, ADR 0007's CAM worker
// amendment): `CamWorkerApi`. It has no dependency on a real worker, so tests expose it on a
// MessageChannel.
//
// - **Coarse calls.** `generate` takes one evaluated setup and generates its operations (or the
//   ones named in `only`), each through the generator registered for its kind.
// - **Generations.** Every `generate` and `simulate` carries a `generation`; a newer request on the
//   same call supersedes every older one. Work runs in chunks that `checkpoint()` between passes,
//   which yields to the event loop when its time slice is used up, so a newer request (or
//   `cancel`) arriving meanwhile is seen and the stale request returns `cancelled`.
// - **The cache.** Each operation's toolpath is cached in memory by its key (ADR 0014 decision 9),
//   from the request or computed with `toolpathKey`. A hit never reaches the generator. Results
//   finished before a request was superseded stay cached.
// - **Errors as data.** Expected failures come back per operation as `{ ok: false, error }`; a
//   generator that throws is a bug, reported as an `internal` error value, never an exception
//   through Comlink.
// - **Transferred buffers.** Toolpaths travel packed (`pack.ts`) and heightmaps as `Float32Array`s,
//   their buffers transferred.

import * as Comlink from 'comlink';
import { LruCache } from '../cache/lru';
import { DEFAULT_KEY_VERSIONS, toolpathKey, type ToolpathKeyVersions } from '../cache/key';
import {
  toolpathBounds,
  toolpathStats,
  type StatsOptions,
  type ToolpathBounds,
  type ToolpathStats,
} from '../stats';
import type {
  Box3,
  CamErrorCode,
  OperationInput,
  OperationKind,
  Setup,
  Tool,
  Vec2,
} from '../types';
import { validateToolpath, type IrIssue } from '../validate';
import {
  clonePacked,
  packToolpath,
  packedBytes,
  packedTransferables,
  unpackToolpath,
  type PackedToolpath,
} from './pack';
import {
  CamCancelled,
  defaultOperations,
  type CamWarning,
  type OperationContext,
  type OperationRegistry,
  type WorkContext,
} from './registry';
import { createYield, now } from './yield';
import {
  SimulationSession,
  frameTransferables,
  type CamSimulateProgramReply,
  type CamSimulateProgramRequest,
} from '../sim/session';

// ---------------------------------------------------------------------------------------------
// Generation

export interface CamGenerateRequest {
  generation: number;
  /** The evaluated setup, with every operation it holds in cut order. */
  setup: Setup;
  /** Generate only these operation ids; every operation of the setup when absent. */
  only?: readonly string[];
  /** Cache keys by operation id, as the app computed them; `toolpathKey` for any missing. */
  keys?: Readonly<Record<string, string>>;
  /** The machine table row the setup uses, hashed into computed keys. */
  machine?: unknown;
}

export type OperationErrorCode =
  | CamErrorCode
  /** No generator is registered for the operation's kind. */
  | 'no-generator'
  /** The generator threw, or returned something that is not a `CamResult`: a bug. */
  | 'internal'
  /** The generator returned a toolpath the IR validator refuses: a bug. */
  | 'invalid-toolpath';

export interface OperationError {
  readonly code: OperationErrorCode;
  readonly message: string;
  /** `invalid-toolpath`: what the validator found. */
  readonly issues?: readonly IrIssue[];
  /** `internal`: the thrown error's stack, for the console. */
  readonly stack?: string;
}

interface OperationResultBase {
  /** The operation id. */
  readonly id: string;
  readonly kind: OperationKind;
  readonly key: string;
  /** Served from the cache, with no call to the generator. */
  readonly cached: boolean;
  /** Time spent generating, ms (0 for a cache hit). */
  readonly ms: number;
}

export type CamOperationResult =
  | (OperationResultBase & {
      readonly ok: true;
      /** The operation's toolpath; its buffers are transferred. `unpackToolpath` gives the IR. */
      readonly toolpath: PackedToolpath;
      readonly warnings: readonly CamWarning[];
    })
  | (OperationResultBase & { readonly ok: false; readonly error: OperationError });

export type CamGenerateReply =
  | {
      status: 'done';
      generation: number;
      /** The setup id. */
      setup: string;
      /** In the setup's operation order. */
      operations: CamOperationResult[];
      /** Time spent in the worker, ms. */
      ms: number;
    }
  | { status: 'cancelled'; generation: number }
  | { status: 'failed'; generation: number; message: string };

// ---------------------------------------------------------------------------------------------
// Simulation

/** A heightmap of the stock top: `nx` by `ny` cells of `cell` mm from `origin`, row by row in X. */
export interface Heightmap {
  readonly origin: Vec2;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  /** Machine Z of the material top per cell, `nx * ny` values; transferred. */
  readonly heights: Float32Array;
}

export interface CamSimulateRequest {
  generation: number;
  /** Cached toolpaths by key, in cut order, each with the tool that cuts it. */
  toolpaths: readonly { readonly key: string; readonly tool: Tool }[];
  /** The stock box in machine coordinates. */
  stock: Box3;
  /** Heightmap cell size, mm. */
  cell: number;
}

/** What a simulator gets: the request with the cached toolpaths filled in. */
export interface SimulationInput {
  readonly toolpaths: readonly {
    readonly key: string;
    readonly tool: Tool;
    readonly toolpath: PackedToolpath;
  }[];
  readonly stock: Box3;
  readonly cell: number;
}

export type SimulationOutcome =
  | { readonly ok: true; readonly heightmap: Heightmap }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/**
 * The material-removal simulation (T5.3c) plugs in here. Like a generator it must
 * `await context.checkpoint()` between chunks of work to stay cancellable.
 *
 * The toolpaths in its input are the cache's own entries, not copies: a simulator must never
 * mutate them or transfer their buffers (that would detach the cached arrays). The `heights` of
 * the heightmap it returns are transferred to the main thread, so it must not keep or reuse that
 * buffer afterwards.
 */
export type Simulator = (
  input: SimulationInput,
  context: WorkContext,
) => SimulationOutcome | Promise<SimulationOutcome>;

export type CamSimulateReply =
  | { status: 'done'; generation: number; heightmap: Heightmap; ms: number }
  | { status: 'cancelled'; generation: number }
  | {
      status: 'failed';
      generation: number;
      /** `no-simulator`, `missing-toolpath` (a key not in the cache), `internal`, or the simulator's. */
      code: string;
      message: string;
      /** `missing-toolpath`: the keys not in the cache. */
      missing?: string[];
    };

// ---------------------------------------------------------------------------------------------
// Statistics and the API

export interface CamToolpathStats {
  readonly key: string;
  readonly stats: ToolpathStats;
  readonly bounds: ToolpathBounds;
}

/** Which stream of requests a generation belongs to. */
export type CamChannel = 'generate' | 'simulate';

export interface CamCacheInfo {
  entries: number;
  /** About how many bytes the cached toolpaths hold. */
  bytes: number;
  hits: number;
  misses: number;
}

export interface CamWorkerApi {
  /**
   * Generate a setup's operations at `generation`, superseding every older `generate` still
   * running; resolves `cancelled` when a newer one or `cancel` superseded it.
   */
  generate(request: CamGenerateRequest): Promise<CamGenerateReply>;
  /** Simulate cached toolpaths; superseded like `generate`, on a channel of its own. */
  simulate(request: CamSimulateRequest): Promise<CamSimulateReply>;
  /**
   * Simulate a whole program (T5.3c, `sim/`) up to a move, against the part's mesh when given:
   * the heightmap, the gouge and leftover classes per cell, and the rapids through material. The
   * worker keeps the program last sent under its `programId`, so playback sends it once and then
   * only move numbers (`needs-program` when it is not held). On the `simulate` channel.
   */
  simulateProgram(request: CamSimulateProgramRequest): Promise<CamSimulateProgramReply>;
  /**
   * Statistics and bounds of cached toolpaths, by key: null for a key not in the cache (or whose
   * statistics fail, as for a rapid rate of zero).
   */
  stats(keys: readonly string[], options: StatsOptions): Promise<(CamToolpathStats | null)[]>;
  /** Cancel running work on `channel`: up to `generation`, or all of it without one. */
  cancel(channel: CamChannel, generation?: number): Promise<void>;
  cacheInfo(): Promise<CamCacheInfo>;
  clearCache(): Promise<void>;
}

/** A cached outcome: a toolpath, or an expected failure (bugs are never cached). */
export type CachedOutcome =
  | {
      readonly ok: true;
      readonly toolpath: PackedToolpath;
      readonly warnings: readonly CamWarning[];
    }
  | { readonly ok: false; readonly error: OperationError };

export interface CamWorkerApiOptions {
  /** The generators to dispatch to; default `defaultOperations`. */
  operations?: OperationRegistry;
  /** The simulation; without one `simulate` fails with `no-simulator`. */
  simulator?: Simulator;
  /** Holds `simulateProgram`'s program; default a new `SimulationSession`. */
  session?: SimulationSession;
  /** The toolpath cache; default 512 entries or 256 MiB. */
  cache?: LruCache<CachedOutcome>;
  /** Versions hashed into computed keys; default `DEFAULT_KEY_VERSIONS`. */
  keyVersions?: ToolpathKeyVersions;
  /** Longest run between two yields to the event loop, ms; default 8. */
  slice?: number;
  /** How to yield; default `createYield()`. */
  yieldNow?: () => Promise<void>;
}

/** The toolpath cache the API makes by default. */
export function createToolpathCache(
  options: { maxEntries?: number; maxBytes?: number } = {},
): LruCache<CachedOutcome> {
  return new LruCache<CachedOutcome>({
    maxEntries: options.maxEntries ?? 512,
    maxSize: options.maxBytes ?? 256 * 1024 * 1024,
    sizeOf: (o) => (o.ok ? packedBytes(o.toolpath) : 256),
  });
}

/**
 * IR issues an operation's own toolpath may have: linking (T5.2g) adds the tool change and the
 * spindle start in front of it, so feed moves with no tool and the spindle off are expected here.
 */
const LINKING_ISSUES = new Set<string>(['no-tool', 'spindle-off']);

/** The transferable buffers of a reply. */
export function generateTransferables(reply: CamGenerateReply): ArrayBuffer[] {
  if (reply.status !== 'done') return [];
  return reply.operations.flatMap((o) => (o.ok ? packedTransferables(o.toolpath) : []));
}

/** One stream of generations: the newest seen, and how far `cancel` reached. */
class Generations {
  private latest = -Infinity;
  private cancelledUpTo = -Infinity;

  /** Note a new request; false when it is already stale. */
  begin(generation: number): boolean {
    if (generation > this.latest) this.latest = generation;
    return !this.stale(generation);
  }

  stale(generation: number): boolean {
    return generation < this.latest || generation <= this.cancelledUpTo;
  }

  cancel(generation?: number): void {
    this.cancelledUpTo = Math.max(this.cancelledUpTo, generation ?? this.latest);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LooseResult =
  | { ok: true; value: { toolpath: unknown; warnings?: CamWarning[] } }
  | { ok: false; error: OperationError };

function isCamResult(value: unknown): value is LooseResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

/** Build the API object; the worker entry passes it to `Comlink.expose`. */
export function createCamWorkerApi(options: CamWorkerApiOptions = {}): CamWorkerApi {
  const operations = options.operations ?? defaultOperations;
  const cache = options.cache ?? createToolpathCache();
  const keyVersions = options.keyVersions ?? DEFAULT_KEY_VERSIONS;
  const slice = options.slice ?? 8;
  const yieldNow = options.yieldNow ?? createYield();
  const session = options.session ?? new SimulationSession();
  const channels: Record<CamChannel, Generations> = {
    generate: new Generations(),
    simulate: new Generations(),
  };

  /** A context for one request: a time slice shared by all its work. */
  function workContext(channel: Generations, generation: number): WorkContext {
    let sliceStart = now();
    return {
      generation,
      get cancelled() {
        return channel.stale(generation);
      },
      async checkpoint() {
        if (now() - sliceStart >= slice) {
          await yieldNow();
          sliceStart = now();
        }
        if (channel.stale(generation)) throw new CamCancelled();
      },
    };
  }

  /** Run one operation's generator; throws only `CamCancelled`. */
  async function run(
    op: OperationInput,
    context: OperationContext,
  ): Promise<{ outcome: CachedOutcome; cacheable: boolean }> {
    const generator = operations.get(op.kind);
    if (!generator) {
      // Not cached: the registry may gain the kind later.
      return {
        outcome: {
          ok: false,
          error: { code: 'no-generator', message: `No generator for ${op.kind} operations.` },
        },
        cacheable: false,
      };
    }
    let result: unknown;
    try {
      result = await generator(op, context);
    } catch (error) {
      if (error instanceof CamCancelled) throw error;
      return {
        outcome: {
          ok: false,
          error: {
            code: 'internal',
            message: `The ${op.kind} generator failed: ${errorMessage(error)}`,
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
        },
        cacheable: false,
      };
    }
    if (!isCamResult(result)) {
      return {
        outcome: {
          ok: false,
          error: { code: 'internal', message: `The ${op.kind} generator returned no result.` },
        },
        cacheable: false,
      };
    }
    if (!result.ok) {
      return { outcome: { ok: false, error: result.error }, cacheable: true };
    }
    const { value } = result;
    try {
      const toolpath = value.toolpath as Parameters<typeof validateToolpath>[0];
      const issues = validateToolpath(toolpath).filter((i) => !LINKING_ISSUES.has(i.code));
      if (issues.length > 0) {
        return {
          outcome: {
            ok: false,
            error: {
              code: 'invalid-toolpath',
              message: `The ${op.kind} generator made an invalid toolpath: ${issues[0]!.message}`,
              issues,
            },
          },
          cacheable: false,
        };
      }
      return {
        outcome: { ok: true, toolpath: packToolpath(toolpath), warnings: value.warnings ?? [] },
        cacheable: true,
      };
    } catch (error) {
      // A malformed toolpath object (no entries, say) breaks the validator itself.
      return {
        outcome: {
          ok: false,
          error: {
            code: 'internal',
            message: `The ${op.kind} generator returned a malformed toolpath: ${errorMessage(error)}`,
          },
        },
        cacheable: false,
      };
    }
  }

  return {
    async generate(request) {
      const { generation } = request;
      const channel = channels.generate;
      if (!channel.begin(generation)) return { status: 'cancelled', generation };
      const started = now();
      const setup = request.setup;
      if (!setup || !Array.isArray(setup.operations)) {
        return { status: 'failed', generation, message: 'The request has no setup operations.' };
      }
      const only = request.only ? new Set(request.only) : null;
      const work = workContext(channel, generation);
      const context: OperationContext = {
        setup,
        machine: request.machine,
        generation,
        get cancelled() {
          return work.cancelled;
        },
        checkpoint: () => work.checkpoint(),
      };
      const results: CamOperationResult[] = [];
      try {
        for (const op of setup.operations) {
          if (only && !only.has(op.id)) continue;
          await context.checkpoint();
          const key =
            request.keys?.[op.id] ??
            toolpathKey({ operation: op, setup, machine: request.machine }, keyVersions);
          const base = { id: op.id, kind: op.kind, key };
          const hit = cache.get(key);
          if (hit) {
            results.push(result(base, hit, true, 0));
            continue;
          }
          const opStarted = now();
          const { outcome, cacheable } = await run(op, context);
          // A generator that caught `CamCancelled` may have returned an error or a partial
          // toolpath: once the request is stale, nothing it returned is trusted for the cache.
          if (cacheable && !context.cancelled) cache.set(key, outcome);
          results.push(result(base, outcome, false, now() - opStarted));
        }
        // A request that arrived during the last slice still wins.
        await yieldNow();
        if (channel.stale(generation)) return { status: 'cancelled', generation };
      } catch (error) {
        if (error instanceof CamCancelled) return { status: 'cancelled', generation };
        return { status: 'failed', generation, message: errorMessage(error) };
      }
      const reply: CamGenerateReply = {
        status: 'done',
        generation,
        setup: setup.id,
        operations: results,
        ms: now() - started,
      };
      return Comlink.transfer(reply, generateTransferables(reply));
    },

    async simulate(request) {
      const { generation } = request;
      const channel = channels.simulate;
      if (!channel.begin(generation)) return { status: 'cancelled', generation };
      const simulator = options.simulator;
      if (!simulator) {
        return {
          status: 'failed',
          generation,
          code: 'no-simulator',
          message: 'No simulation is registered.',
        };
      }
      const missing: string[] = [];
      const toolpaths: SimulationInput['toolpaths'][number][] = [];
      for (const { key, tool } of request.toolpaths) {
        const entry = cache.get(key);
        if (entry?.ok) toolpaths.push({ key, tool, toolpath: entry.toolpath });
        else missing.push(key);
      }
      if (missing.length > 0) {
        return {
          status: 'failed',
          generation,
          code: 'missing-toolpath',
          message: `${missing.length} toolpath(s) are not in the cache; generate them first.`,
          missing,
        };
      }
      const started = now();
      let outcome: SimulationOutcome;
      try {
        outcome = await simulator(
          { toolpaths, stock: request.stock, cell: request.cell },
          workContext(channel, generation),
        );
        await yieldNow();
        if (channel.stale(generation)) return { status: 'cancelled', generation };
      } catch (error) {
        if (error instanceof CamCancelled) return { status: 'cancelled', generation };
        return { status: 'failed', generation, code: 'internal', message: errorMessage(error) };
      }
      if (!outcome.ok) {
        return { status: 'failed', generation, ...outcome.error };
      }
      const reply: CamSimulateReply = {
        status: 'done',
        generation,
        heightmap: outcome.heightmap,
        ms: now() - started,
      };
      return Comlink.transfer(reply, [outcome.heightmap.heights.buffer as ArrayBuffer]);
    },

    async simulateProgram(request) {
      const { generation } = request;
      const channel = channels.simulate;
      if (!channel.begin(generation)) return { status: 'cancelled', generation };
      const started = now();
      let outcome;
      try {
        outcome = await session.run(request, workContext(channel, generation));
        await yieldNow();
        if (channel.stale(generation)) return { status: 'cancelled', generation };
      } catch (error) {
        if (error instanceof CamCancelled) return { status: 'cancelled', generation };
        return { status: 'failed', generation, code: 'internal', message: errorMessage(error) };
      }
      if (!outcome.ok) {
        return outcome.needsProgram
          ? { status: 'needs-program', generation, programId: request.programId }
          : { status: 'failed', generation, ...outcome.error };
      }
      const reply: CamSimulateProgramReply = {
        status: 'done',
        generation,
        frame: outcome.frame,
        ms: now() - started,
      };
      return Comlink.transfer(reply, frameTransferables(outcome.frame));
    },

    async stats(keys, statsOptions) {
      return keys.map((key) => {
        const entry = cache.peek(key);
        if (!entry?.ok) return null;
        const toolpath = unpackToolpath(entry.toolpath);
        const stats = toolpathStats(toolpath, statsOptions);
        if (!stats.ok) return null;
        return { key, stats: stats.value, bounds: toolpathBounds(toolpath) };
      });
    },

    async cancel(channel, generation) {
      channels[channel].cancel(generation);
    },

    async cacheInfo() {
      return {
        entries: cache.size,
        bytes: cache.totalSize,
        hits: cache.hits,
        misses: cache.misses,
      };
    },

    async clearCache() {
      cache.clear();
    },
  };
}

/** A result for the reply, with buffers of its own so the cached entry stays intact. */
function result(
  base: { id: string; kind: OperationKind; key: string },
  outcome: CachedOutcome,
  cached: boolean,
  ms: number,
): CamOperationResult {
  return outcome.ok
    ? {
        ...base,
        cached,
        ms,
        ok: true,
        toolpath: clonePacked(outcome.toolpath),
        warnings: outcome.warnings,
      }
    : { ...base, cached, ms, ok: false, error: outcome.error };
}
