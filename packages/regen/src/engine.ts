// The regeneration engine: a core document in, geometry out, rebuilding only what changed.
//
// It runs next to the kernel (ADR 0007 decision 1: the regen engine lives in the kernel worker)
// and drives it through the kernel service's batch API: one `feature` op per kernel feature,
// with `applyFeature` semantics, on the bodies the feature reads. A part carries a set of bodies
// (M2 plan, decisions 1 to 3): every feature reads only some of them (its scope, the bodies its
// references lie on, or all of them), and its result is cached under a key that covers its input
// and the keys of those bodies (see `cache.ts`), so an edit to one body is a cache hit for the
// features of the others. A regen walks the whole part but only sends ops for keys it has never
// built.
//
// Batches: the next feature's key depends on what the previous one did to the body set (which
// bodies it made, changed or merged away), so every `feature` op is flushed before the next
// feature is looked at. A sketch placed on a face needs the face's plane, so it adds a `resolve`
// op and flushes too. In the worker a batch costs no structured clone, so flushing is cheap.
//
// Derived parts: a derived feature's pinned source part is regenerated first, in this same
// kernel and by this same engine, with the source document's own variables and under a cache
// namespace of its own (`derived.ts`), then its bodies are copied in by a kernel `derive` op.
// Every derived feature of one pinned part in a regen shares that one build.
//
// Cancellation: every regen has a generation. A newer regen cancels the kernel batches of the
// older one (`KernelService.cancel`) and the older one stops at its next await, returning null.
// Regens run one at a time, so they never race on the cache.

import type {
  BodyPropsFields,
  DerivedFeature,
  DocumentChange,
  Feature,
  ImportSource,
  ManufaktureDocument,
  Part,
} from '@manufakture/core';
import {
  frameOnPlane,
  type BatchReply,
  type BatchRequest,
  type Deflection,
  type FeatureInput,
  type FeatureOutcome,
  type KernelOp,
  type MeshData,
  type OpResult,
  type ReferenceReport,
  type ShapeId,
  type TessellateOp,
  type Topology,
} from '@manufakture/kernel';
import type { SketchPlacement } from '@manufakture/sketch';
import {
  DEFAULT_KERNEL_BUILD,
  DEFAULT_SOLVER_BUILD,
  MemoryCache,
  REGEN_IMPLEMENTATION_VERSION,
  cacheKey,
  holdsShapes,
  type CacheEntry,
  type CachedOutcome,
  type FeatureCache,
  type KeyVersions,
} from './cache';
import { DerivedSources, carriedProps, effectiveProps, sourceNamespace, tooDeep } from './derived';
import { mapFailure, mapOutcome, planeReport } from './errors';
import {
  bodyUse,
  buildGraph,
  dirtyFeaturesOf,
  readsBody,
  routeBodies,
  type RoutedBody,
} from './graph';
import { importSourceMatches, keyInput } from './imports';
import { explicitPlacement, solveSketch, type RegenSolver, type SketchResult } from './sketches';
import { faceRef, translateFeature } from './translate';
import type {
  BodyResult,
  ConsumedBody,
  FeatureResult,
  PartResult,
  RegenCounters,
  RegenError,
  RegenResult,
  RegenWarning,
} from './types';
import { evaluateFeature, evaluateVariables, type VariableValues } from './values';

/**
 * What the engine needs from the kernel: the batch API of `KernelService` (which satisfies it
 * as it is), so tests and the worker drive the real service in-process.
 */
export interface RegenKernel {
  run(request: BatchRequest): Promise<BatchReply>;
  /** Release shapes outside any batch; never cancelled (`KernelService.release`). */
  release(shapes: readonly ShapeId[]): Promise<unknown>;
  /** Cancel every batch up to `generation`. */
  cancel(generation?: number): unknown;
  /** Called after every instance recycle, when every shape id is gone. */
  onRecycle?(hook: () => void): () => void;
  /**
   * The newest generation the kernel has seen. A default generation is made newer than it, so
   * an engine never submits batches the kernel would treat as stale.
   */
  stats?(): { generation: number };
}

export interface RegenEngineOptions {
  kernel: RegenKernel;
  solver: RegenSolver;
  /** Default: a `MemoryCache`. */
  cache?: FeatureCache;
  /** Kernel build identity for cache keys. */
  kernelBuild?: string;
  /** Sketch solver build identity for sketch cache keys. */
  solverBuild?: string;
  /** Tessellation of the final bodies. */
  deflection?: Partial<Deflection>;
  /**
   * The kernel recycled its instance, so every cached body is gone. The host should regen the
   * current document again (the next regen rebuilds; nothing is lost but time).
   */
  onKernelRecycled?: () => void;
}

export interface RegenOptions {
  /**
   * Increases with every edit (ADR 0007 decision 4). Default: one more than the newest seen,
   * here or by the kernel.
   * A regen whose generation is not newer than one already requested returns null at once.
   */
  generation?: number;
  /** The document before this edit and the store's change, to find the dirty subgraph faster. */
  previous?: ManufaktureDocument;
  change?: DocumentChange;
}

export interface EngineStats extends RegenCounters {
  regens: number;
  superseded: number;
  retries: number;
}

class Superseded extends Error {
  constructor() {
    super('superseded by a newer regen');
  }
}

/**
 * A shape id the batch used was not live: the kernel recycled since it was made. The regen
 * starts over without the lost bodies. Thrown before anything from that batch is cached.
 */
class StaleShapes extends Error {
  constructor(readonly instance: number) {
    super('kernel shapes were lost to a recycle');
  }
}

/** A body of the part while a regen walks its features. */
interface LiveBody extends RoutedBody {
  id: string;
  /** The feature that made it. */
  creator: string;
  shape: ShapeId;
  /** The kernel instance `shape` lives in. */
  instance: number | null;
  /** Cache key of the body: the key of the feature that last changed it, and its id. */
  key: string;
  solids: number;
}

/** A `shapesFrom` for a batch reading shapes of two instances: one of them is stale. */
const MIXED_INSTANCES = -1;

type Meta =
  | { type: 'feature'; feature: Feature; key: string; result: FeatureResult; started: number }
  | { type: 'resolve'; take: (r: OpResult) => void }
  | { type: 'mesh'; slot: string }
  | { type: 'topology'; slot: string };

interface Batch {
  ops: KernelOp[];
  metas: Meta[];
  /**
   * The kernel instance the batch's concrete shape ids come from (a cached body, or a body an
   * earlier batch made), or null when it uses none. A reply from another instance means those
   * ids are gone.
   */
  shapesFrom: number | null;
}

interface Run {
  generation: number;
  counters: RegenCounters;
  used: Set<string>;
  /** Kernel instance of the latest reply. */
  instance: number | null;
  versions: KeyVersions;
  /** Source parts of derived features built in this regen, by `sourceNamespace`. */
  sources: Map<string, PartState>;
}

/** Where a part is built: the document being regenerated, or a derived part's source. */
interface BuildScope {
  /** Cache namespace: null for the document's own parts, `sourceNamespace` for a source. */
  ns: string | null;
  /** 0 for the document's own parts, 1 for a source of one of them, and so on. */
  depth: number;
  /** The key versions of the document the part is in (its own naming scheme). */
  versions: KeyVersions;
}

interface PartState extends BuildScope {
  part: Part;
  /** The bodies after the features so far, in creator order. */
  bodies: LiveBody[];
  /** Bodies merged away so far. */
  consumed: ConsumedBody[];
  /** An op-level failure left no usable bodies; kernel features after it are not attempted. */
  broken: boolean;
  batch: Batch;
  results: Map<string, FeatureResult>;
  /** Features whose dependents cannot be built, and why. */
  unavailable: Map<string, 'error' | 'suppressed' | 'upstream-error'>;
  sketches: Map<string, SketchResult>;
  inputs: Map<string, FeatureInput>;
  /** Reference imports seen so far (not part of the body, never in the kernel). */
  references: Set<string>;
  /**
   * What bodies a derived feature makes carry over from their source (name, colour, material),
   * by the body id they would have (`derived#1:from/<source body id>`).
   */
  inherited: Map<string, BodyPropsFields>;
}

const now = (): number => performance.now();

const emptyBatch = (): Batch => ({ ops: [], metas: [], shapesFrom: null });

/**
 * A feature op the kernel passed through because its concrete input body is not a live shape:
 * `applyFeature` reports that as a feature result (`no-body`, nothing created, no names), not
 * as a failed op. A live body always has names (every body the engine uses comes from a
 * feature op), and a `no-body` failure on a live body (an empty one) keeps them.
 */
function staleBody(op: KernelOp, r: OpResult): boolean {
  if (op.op !== 'feature' || !r.ok) return false;
  const outcome = r.value as FeatureOutcome;
  // A derive whose source shape is gone says so on `sources`; the engine only sends live ones.
  if (
    op.feature.kind === 'derive' &&
    outcome.errors.some((e) => e.code === 'no-body' && e.ref === 'sources')
  ) {
    return true;
  }
  if (!Array.isArray(op.bodies) || op.bodies.length === 0) return false;
  return (
    outcome.bodies.some((b) => b.names === null) && outcome.errors.some((e) => e.code === 'no-body')
  );
}

/** The key `#reported` and the mesh batch use for a body of a part. */
const slotOf = (partId: string, bodyId: string): string => `${partId}\n${bodyId}`;

function emptyCounters(): RegenCounters {
  return { featureOps: 0, otherOps: 0, batches: 0, solves: 0, cacheHits: 0, cacheMisses: 0 };
}

export class RegenEngine {
  readonly #kernel: RegenKernel;
  readonly #solver: RegenSolver;
  readonly #cache: FeatureCache;
  readonly #kernelBuild: string;
  readonly #solverBuild: string;
  readonly #deflection: Partial<Deflection> | undefined;
  readonly #onRecycled: (() => void) | undefined;
  /**
   * Import sources whose stored SHA-256 was checked against their data, and the outcome. Keyed by
   * the source object: documents share unchanged objects between edits, so each file is hashed
   * once, not on every regen.
   */
  readonly #checkedSources = new WeakMap<ImportSource, boolean>();
  /** Pinned sources of derived features: checked, read and measured for depth once each. */
  readonly #derived = new DerivedSources();
  #latest = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #instance: number | null = null;
  #lastDocument: ManufaktureDocument | null = null;
  /** Body key per part and body (`slotOf`) as last reported, to send meshes only when a body changed. */
  #reported = new Map<string, string>();
  readonly #stats: EngineStats = { ...emptyCounters(), regens: 0, superseded: 0, retries: 0 };
  readonly #unsubscribe: (() => void) | undefined;

  constructor(options: RegenEngineOptions) {
    this.#kernel = options.kernel;
    this.#solver = options.solver;
    this.#cache = options.cache ?? new MemoryCache();
    this.#kernelBuild = options.kernelBuild ?? DEFAULT_KERNEL_BUILD;
    this.#solverBuild = options.solverBuild ?? DEFAULT_SOLVER_BUILD;
    this.#deflection = options.deflection;
    this.#onRecycled = options.onKernelRecycled;
    this.#unsubscribe = options.kernel.onRecycle?.(() => {
      // Runs inside the service's queue: only forget, never submit from here.
      void this.#cache.dropBodies(null);
      this.#instance = null;
      this.#onRecycled?.();
    });
  }

  /** Cumulative counters over every regen. */
  get stats(): Readonly<EngineStats> {
    return { ...this.#stats };
  }

  /** The newest generation requested. */
  get generation(): number {
    return this.#latest;
  }

  /** The document of the last completed regen. */
  get document(): ManufaktureDocument | null {
    return this.#lastDocument;
  }

  /**
   * Regenerate `document`. Resolves to the result, or to null when a newer regen superseded it
   * (drop it: the newer one reports). Rejects only on programming errors.
   */
  regen(document: ManufaktureDocument, options: RegenOptions = {}): Promise<RegenResult | null> {
    const seen = this.#kernel.stats?.().generation ?? 0;
    const generation =
      options.generation ?? Math.max(this.#latest, Number.isFinite(seen) ? seen : 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      return Promise.reject(new TypeError('a regen generation must be an integer'));
    }
    if (generation <= this.#latest) return Promise.resolve(null);
    const older = this.#latest;
    this.#latest = generation;
    // Abandon the running regen's batches at the kernel's next op.
    if (older > 0) this.#kernel.cancel(older);
    const task = this.#chain.then(() => this.#regen(document, generation, options));
    this.#chain = task.catch(() => undefined);
    return task;
  }

  /** Regenerate after a store change (`store.subscribe((e) => engine.update(e))`). */
  update(event: {
    document: ManufaktureDocument;
    previous: ManufaktureDocument;
    change: DocumentChange;
  }): Promise<RegenResult | null> {
    return this.regen(event.document, { previous: event.previous, change: event.change });
  }

  /** Release every cached body and forget everything. */
  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    await this.#chain;
    const dropped = await this.#cache.clear();
    await this.#releaseEntries(dropped);
    this.#reported.clear();
    this.#lastDocument = null;
  }

  // Internals ------------------------------------------------------------------------------

  async #regen(
    document: ManufaktureDocument,
    generation: number,
    options: RegenOptions,
  ): Promise<RegenResult | null> {
    if (generation < this.#latest) {
      this.#stats.superseded++;
      return null;
    }
    const t0 = now();
    const run: Run = {
      generation,
      counters: emptyCounters(),
      used: new Set(),
      instance: this.#instance,
      versions: {
        kernelBuild: this.#kernelBuild,
        namingScheme: document.namingScheme,
        implementation: REGEN_IMPLEMENTATION_VERSION,
      },
      sources: new Map(),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.#regenOnce(run, document, options);
        result.ms = now() - t0;
        this.#stats.regens++;
        return result;
      } catch (error) {
        if (error instanceof Superseded) {
          this.#stats.superseded++;
          this.#addStats(run.counters);
          return null;
        }
        if (error instanceof StaleShapes && attempt < 2) {
          this.#stats.retries++;
          await this.#cache.dropBodies(error.instance);
          this.#instance = error.instance;
          run.instance = error.instance;
          run.used.clear();
          run.sources.clear();
          continue;
        }
        throw error;
      }
    }
  }

  #addStats(c: RegenCounters): void {
    for (const k of Object.keys(c) as (keyof RegenCounters)[]) this.#stats[k] += c[k];
  }

  #checkStale(run: Run): void {
    if (run.generation < this.#latest) throw new Superseded();
  }

  async #regenOnce(
    run: Run,
    document: ManufaktureDocument,
    options: RegenOptions,
  ): Promise<RegenResult> {
    const variables = evaluateVariables(document.variables);
    this.#derived.begin();
    const reuseChange =
      options.change !== undefined &&
      options.previous !== undefined &&
      options.previous === this.#lastDocument;

    const built: { state: PartState; features: FeatureResult[]; dirty: string[] }[] = [];
    for (const part of document.parts) {
      const partChange = reuseChange
        ? options.change!.parts.find((p) => p.partId === part.id)
        : undefined;
      const dirty = dirtyFeaturesOf(
        this.#lastDocument,
        document,
        part.id,
        reuseChange
          ? { firstAffectedIndex: partChange ? partChange.firstAffectedIndex : null }
          : {},
      );
      const state = await this.#buildPart(run, part, document, variables, {
        ns: null,
        depth: 0,
        versions: run.versions,
      });
      const features = part.features.map(
        (f, i) =>
          state.results.get(f.id) ?? {
            featureId: f.id,
            kind: f.kind,
            index: i,
            status: 'rolled-back' as const,
            errors: [],
            warnings: [],
            references: [],
            cached: false,
            ms: 0,
          },
      );
      built.push({ state, features, dirty });
    }

    // Every body must come from the kernel instance of the latest reply: a part built only from
    // cache hits can hold a shape id from before a recycle that landed during another part's
    // batch. Its tessellation would fail, or worse, a later pick or measure would.
    for (const { state } of built) {
      for (const b of state.bodies) {
        if (b.instance !== null && run.instance !== null && b.instance !== run.instance) {
          throw new StaleShapes(run.instance);
        }
      }
    }

    // Meshes (and topologies, for edge adjacency, vertices and face planes) of the bodies that
    // changed since the last completed regen, in one batch, so they share one name table.
    const meshes = new Map<string, MeshData>();
    const topologies = new Map<string, Topology>();
    const batch = emptyBatch();
    const finalBodies = (state: PartState) => (state.broken ? [] : state.bodies);
    for (const { state } of built) {
      for (const b of finalBodies(state)) {
        const slot = slotOf(state.part.id, b.id);
        if (this.#reported.get(slot) === b.key) continue;
        const op: TessellateOp = { op: 'tessellate', shape: b.shape };
        if (this.#deflection !== undefined) op.deflection = this.#deflection;
        batch.ops.push(op, { op: 'topology', shape: b.shape });
        batch.metas.push({ type: 'mesh', slot }, { type: 'topology', slot });
        this.#usesBodies(batch, [b]);
      }
    }
    let names: string[] = [];
    if (batch.ops.length > 0) {
      const reply = await this.#submit(run, batch.ops);
      run.counters.otherOps += batch.ops.length;
      this.#checkLive(batch, reply);
      names = reply.names;
      batch.metas.forEach((meta, j) => {
        const r = reply.results[j]!;
        if (meta.type !== 'mesh' && meta.type !== 'topology') return;
        if (!r.ok) {
          if (r.error.code === 'unknown-shape') throw new StaleShapes(reply.instance);
          throw new Error(
            `${meta.type} of ${meta.slot.replace('\n', ' body ')} failed: ${r.error.message}`,
          );
        }
        if (meta.type === 'mesh') meshes.set(meta.slot, r.value as MeshData);
        else topologies.set(meta.slot, r.value as Topology);
      });
    }
    this.#checkStale(run);

    // Completed: this is now the state the next edit is compared with.
    const reported = new Map<string, string>();
    const parts: PartResult[] = built.map(({ state, features, dirty }) => {
      const bodies = finalBodies(state).map((b): BodyResult => {
        const slot = slotOf(state.part.id, b.id);
        reported.set(slot, b.key);
        const inherited = carriedProps(state.part, b.id, state.inherited.get(b.id));
        return {
          ...(inherited === undefined ? {} : { inherited }),
          bodyId: b.id,
          creator: b.creator,
          shape: b.shape,
          bodyKey: b.key,
          solids: b.solids,
          meshChanged: this.#reported.get(slot) !== b.key,
          mesh: meshes.get(slot) ?? null,
          topology: topologies.get(slot) ?? null,
        };
      });
      return { partId: state.part.id, features, dirty, bodies, consumed: state.consumed };
    });
    this.#reported = reported;
    this.#lastDocument = document;
    this.#derived.retain();
    const dropped = await this.#cache.retain(run.used);
    await this.#releaseEntries(dropped);
    this.#addStats(run.counters);
    return { generation: run.generation, names, parts, counters: run.counters, ms: 0 };
  }

  async #releaseEntries(entries: readonly CacheEntry[]): Promise<void> {
    const shapes: ShapeId[] = [];
    for (const e of entries) {
      if (holdsShapes(e) && e.outcome!.instance === this.#instance) {
        for (const b of e.outcome!.bodies) shapes.push(b.shape);
      }
    }
    if (shapes.length > 0) await this.#kernel.release(shapes);
  }

  async #submit(run: Run, ops: KernelOp[]): Promise<BatchReply> {
    this.#checkStale(run);
    const reply = await this.#kernel.run({ generation: run.generation, ops });
    run.counters.batches++;
    if (reply.status === 'cancelled') throw new Superseded();
    if (this.#instance !== reply.instance) {
      // A recycle happened since the cached bodies were made.
      if (this.#instance !== null) await this.#cache.dropBodies(reply.instance);
      this.#instance = reply.instance;
    }
    run.instance = reply.instance;
    return reply;
  }

  /** A cache key of a feature of `state`'s part: its document's versions and namespace. */
  #key(state: BuildScope, parts: Record<string, unknown>): string {
    return cacheKey(state.versions, state.ns === null ? parts : { namespace: state.ns, ...parts });
  }

  async #buildPart(
    run: Run,
    part: Part,
    document: ManufaktureDocument,
    variables: VariableValues,
    scope: BuildScope,
  ): Promise<PartState> {
    const graph = buildGraph(part, document.variables);
    const lookup = (id: string) => graph.byId.get(id);
    const state: PartState = {
      ...scope,
      part,
      bodies: [],
      consumed: [],
      broken: false,
      batch: emptyBatch(),
      results: new Map(),
      unavailable: new Map(),
      sketches: new Map(),
      inputs: new Map(),
      references: new Set(),
      inherited: new Map(),
    };

    for (const [i, f] of graph.active.entries()) {
      const started = now();
      const result: FeatureResult = {
        featureId: f.id,
        kind: f.kind,
        index: i,
        status: 'ok',
        errors: [],
        warnings: [],
        references: [],
        cached: false,
        ms: 0,
      };
      state.results.set(f.id, result);
      const fail = (
        status: 'error' | 'upstream-error' | 'suppressed',
        errors: RegenError[] = [],
      ) => {
        result.status = status;
        result.errors = errors;
        result.ms = now() - started;
        state.unavailable.set(f.id, status);
      };

      if (f.suppressed) {
        fail('suppressed');
        continue;
      }
      const deps = graph.depends.get(f.id) ?? [];
      const upstream = deps.filter((d) => state.unavailable.has(d));
      if (upstream.length > 0) {
        const why = upstream.map((d) => {
          const s = state.unavailable.get(d);
          return `${d}, which ${s === 'suppressed' ? 'is suppressed' : s === 'error' ? 'failed' : 'could not be built'}`;
        });
        fail('upstream-error', [
          { code: 'upstream', upstream, message: `Depends on ${why.join('; and on ')}` },
        ]);
        continue;
      }
      if (readsBody(f) && state.broken) {
        fail('upstream-error', [
          {
            code: 'upstream',
            upstream: [],
            message: 'The kernel failed earlier in this regen; nothing after it was built',
          },
        ]);
        continue;
      }
      if (f.kind === 'import' && f.operation === 'reference') {
        // Shown and measured by the app from the file itself; never part of the body.
        state.references.add(f.id);
        result.warnings = [
          {
            code: 'reference-body',
            message: `${f.source.fileName} is a reference body: shown and measured, not part of the part's body`,
          },
        ];
        result.ms = now() - started;
        continue;
      }
      if (f.kind === 'extension') {
        result.warnings = [
          {
            code: 'extension',
            message: `Regen does not build "${f.extension}" features yet; it changes no geometry`,
          },
        ];
        result.ms = now() - started;
        continue;
      }

      const values = evaluateFeature(f, variables);
      if (values.errors.length > 0) {
        fail('error', values.errors);
        continue;
      }

      if (f.kind === 'sketch') {
        await this.#sketch(run, state, f, values.values, variables, result, started, lookup);
        continue;
      }

      if (f.kind === 'import') {
        let matches = this.#checkedSources.get(f.source);
        if (matches === undefined) {
          matches = await importSourceMatches(f.source);
          this.#checkedSources.set(f.source, matches);
        }
        if (!matches) {
          fail('error', [
            {
              code: 'invalid',
              field: ['source', 'sha256'],
              message: `The stored copy of ${f.source.fileName} does not match its SHA-256: the document is damaged; import the file again`,
            },
          ]);
          continue;
        }
      }

      // A derived feature's source part is built first; its bodies are the op's sources.
      let sources: LiveBody[] = [];
      let sourceWarnings: RegenWarning[] = [];
      if (f.kind === 'derived') {
        const got = await this.#derivedBodies(run, state, f);
        if (!got.ok) {
          fail('error', got.errors);
          continue;
        }
        sources = got.bodies;
        sourceWarnings = got.warnings;
        for (const [id, props] of got.props) state.inherited.set(`${f.id}:from/${id}`, props);
      }

      const t = translateFeature(f, {
        values: values.values,
        sketches: state.sketches,
        inputs: state.inputs,
        references: state.references,
        bodies: new Set(state.bodies.map((b) => b.id)),
        sources: new Map([[f.id, sources]]),
      });
      if (!t.ok) {
        fail('error', t.errors);
        continue;
      }
      state.inputs.set(f.id, t.input);
      // Only the bodies the feature reads go to the kernel, and only their keys into its key.
      const read = new Set(routeBodies(bodyUse(f, lookup)!, state.bodies));
      const reads = state.bodies.filter((b) => read.has(b.id));
      // An import is keyed by its (verified) hash and size, not its whole base64 text; a
      // derive by the keys of its source bodies, not their shape ids.
      const key = this.#key(state, {
        input:
          t.input.kind === 'derive'
            ? { ...t.input, sources: sources.map((b) => [b.id, b.key]) }
            : keyInput(t.input, f.kind === 'import' ? f.source : null),
        bodies: reads.map((b) => [b.id, b.key]),
      });
      run.used.add(key);
      const hit = await this.#cache.get(key);
      if (hit !== undefined && hit.type === 'body' && hit.outcome !== undefined) {
        run.counters.cacheHits++;
        this.#applyOutcome(state, f.id, key, hit.outcome);
        this.#fill(result, hit, started);
        result.cached = true;
        if (!hit.ok) state.unavailable.set(f.id, 'error');
        if (sourceWarnings.length > 0) result.warnings = [...result.warnings, ...sourceWarnings];
        continue;
      }
      run.counters.cacheMisses++;
      this.#usesBodies(state.batch, [...reads, ...sources]);
      state.batch.ops.push({
        op: 'feature',
        bodies: reads.map((b) => ({ id: b.id, shape: b.shape })),
        feature: t.input,
      });
      state.batch.metas.push({ type: 'feature', feature: f, key, result, started });
      await this.#flush(run, state);
      if (sourceWarnings.length > 0) result.warnings = [...result.warnings, ...sourceWarnings];
    }
    return state;
  }

  /**
   * The source bodies of a derived feature: its pinned source checked and opened, its nesting
   * checked against `MAX_DERIVED_DEPTH` before anything is built, then its part regenerated
   * (once per regen for every derived feature of that part) and the listed bodies picked.
   */
  async #derivedBodies(
    run: Run,
    state: PartState,
    f: DerivedFeature,
  ): Promise<
    | {
        ok: true;
        bodies: LiveBody[];
        warnings: RegenWarning[];
        props: Map<string, BodyPropsFields>;
      }
    | { ok: false; errors: RegenError[] }
  > {
    const opened = await this.#derived.open(f.source);
    this.#checkStale(run);
    if (!opened.ok) return { ok: false, errors: [opened.error] };
    const fits = await this.#derived.fits(f.source, state.depth + 1);
    this.#checkStale(run);
    if (!fits) return { ok: false, errors: [tooDeep(f.source)] };

    const ns = sourceNamespace(f.source);
    let built = run.sources.get(ns);
    if (built === undefined) {
      const { document, part } = opened;
      built = await this.#buildPart(run, part, document, evaluateVariables(document.variables), {
        ns,
        depth: state.depth + 1,
        versions: { ...run.versions, namingScheme: document.namingScheme },
      });
      run.sources.set(ns, built);
    }
    const where = `${f.source.documentName || f.source.documentId} at ${f.source.versionName || f.source.versionId}`;
    if (built.broken) {
      return {
        ok: false,
        errors: [
          {
            code: 'source',
            field: ['source'],
            message: `The kernel failed while building ${where}; nothing of it can be derived`,
          },
        ],
      };
    }
    const all = built.bodies;
    if (f.bodies !== undefined) {
      const missing = f.bodies.filter((id) => !all.some((b) => b.id === id));
      if (missing.length > 0) {
        return {
          ok: false,
          errors: [
            {
              code: 'reference-lost',
              referenceId: 'bodies',
              missing,
              message: `${where} has no body ${missing.join(', ')} (merged into another, or never made in that version): re-pick the bodies`,
            },
          ],
        };
      }
    }
    const bodies = f.bodies === undefined ? all : all.filter((b) => f.bodies!.includes(b.id));
    if (bodies.length === 0) {
      return {
        ok: false,
        errors: [
          {
            code: 'no-body',
            field: ['source'],
            message: `Part ${f.source.partId} of ${where} has no bodies to derive`,
          },
        ],
      };
    }
    const failed = built.part.features
      .filter((x) => {
        const s = built.results.get(x.id)?.status;
        return s === 'error' || s === 'upstream-error';
      })
      .map((x) => x.id);
    const warnings: RegenWarning[] =
      failed.length === 0
        ? []
        : [
            {
              code: 'derived-source',
              features: failed,
              message: `${failed.length === 1 ? 'A feature' : `${failed.length} features`} of ${where} failed (${failed.join(', ')}): the derived bodies are what it built without ${failed.length === 1 ? 'it' : 'them'}`,
            },
          ];
    const props = new Map(
      bodies.map((b) => [b.id, effectiveProps(built.part, b.id, built.inherited.get(b.id))]),
    );
    return { ok: true, bodies, warnings, props };
  }

  /**
   * Apply what a feature did (from the kernel, or from the cache) to the part's bodies: merged
   * bodies go, changed ones take their new shape and key, made ones are added at the end. A
   * body's `carries` follows merges, so a reference to a face that came from a merged body is
   * routed to the body it is now on.
   */
  #applyOutcome(state: PartState, featureId: string, key: string, outcome: CachedOutcome): void {
    if (outcome.bodies.length === 0 && outcome.consumed.length === 0) return;
    const consumed = new Set(outcome.consumed);
    const merged = new Set<string>();
    for (const b of state.bodies) {
      if (!consumed.has(b.id)) continue;
      for (const c of b.carries) merged.add(c);
      state.consumed.push({ bodyId: b.id, featureId });
    }
    state.bodies = state.bodies.filter((b) => !consumed.has(b.id));
    for (const c of outcome.bodies) {
      const next = {
        shape: c.shape,
        instance: outcome.instance,
        solids: c.solids,
        key: `${key}/${c.id}`,
      };
      const at = c.created ? -1 : state.bodies.findIndex((b) => b.id === c.id);
      if (at >= 0) {
        const old = state.bodies[at]!;
        state.bodies[at] = {
          ...old,
          ...next,
          carries: new Set([...old.carries, ...merged, featureId]),
        };
      } else {
        state.bodies.push({ id: c.id, creator: featureId, carries: new Set([featureId]), ...next });
      }
    }
  }

  #fill(result: FeatureResult, entry: CacheEntry, started: number): void {
    result.status = entry.ok ? 'ok' : 'error';
    result.errors = entry.errors;
    result.warnings = entry.warnings;
    result.references = entry.references;
    result.ms = now() - started;
  }

  async #sketch(
    run: Run,
    state: PartState,
    f: Extract<Feature, { kind: 'sketch' }>,
    values: ReadonlyMap<string, number>,
    variables: VariableValues,
    result: FeatureResult,
    started: number,
    lookup: (id: string) => Feature | undefined,
  ): Promise<void> {
    const { name: _name, ...definition } = f;
    void _name;
    // A face sketch reads the bodies its face may lie on.
    const owners =
      f.plane.type === 'face'
        ? (() => {
            const read = new Set(routeBodies(bodyUse(f, lookup)!, state.bodies));
            return state.bodies.filter((b) => read.has(b.id));
          })()
        : [];
    const plane =
      f.plane.type === 'plane'
        ? { placement: explicitPlacement(f.plane) }
        : { bodies: owners.map((b) => [b.id, b.key]), ref: f.plane.face.ref };
    const key = this.#key(state, {
      solver: this.#solverBuild,
      sketch: definition,
      values: [...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      plane,
    });
    run.used.add(key);
    const hit = await this.#cache.get(key);
    if (hit !== undefined && hit.type === 'sketch') {
      run.counters.cacheHits++;
      this.#fill(result, hit, started);
      result.cached = true;
      if (hit.sketch) result.placement = hit.sketch.placement;
      if (hit.ok && hit.sketch) state.sketches.set(f.id, hit.sketch);
      else state.unavailable.set(f.id, 'error');
      return;
    }
    run.counters.cacheMisses++;

    let placement: SketchPlacement;
    const warnings: RegenWarning[] = [];
    const references: FeatureResult['references'] = [];
    const store = async (entry: Omit<CacheEntry, 'key' | 'featureId' | 'type' | 'ms'>) => {
      const full: CacheEntry = {
        key,
        featureId: f.id,
        type: 'sketch',
        ms: now() - started,
        ...entry,
      };
      await this.#cache.set(key, full);
      this.#fill(result, full, started);
      if (!full.ok) state.unavailable.set(f.id, 'error');
    };

    if (f.plane.type === 'plane') {
      placement = explicitPlacement(f.plane);
    } else {
      const reference = f.plane.face;
      const target = reference.ref.face;
      if (owners.length === 0) {
        await store({
          ok: false,
          errors: [
            {
              code: 'no-body',
              referenceId: reference.id,
              message: `The sketch is on ${target}, but there is no body yet`,
            },
          ],
          warnings: [],
          references: [],
        });
        return;
      }
      // One resolve per body the face may lie on (usually one); face names are unique across
      // the bodies of a part, so at most one resolves.
      const reports: ReferenceReport[] = [];
      let failure: RegenError | undefined;
      this.#usesBodies(state.batch, owners);
      for (const b of owners) {
        state.batch.ops.push({ op: 'resolve', shape: b.shape, refs: [faceRef(reference.ref)] });
        state.batch.metas.push({
          type: 'resolve',
          take: (r) => {
            if (r.ok) reports.push((r.value as { results: ReferenceReport[] }).results[0]!);
            else failure ??= mapFailure(r.error);
          },
        });
        run.counters.otherOps++;
      }
      await this.#flush(run, state);
      const report = reports.find((r) => r.ok) ?? reports[0];
      if (report === undefined) {
        await store({
          ok: false,
          errors: [failure ?? { code: 'kernel', message: 'resolving the sketch plane failed' }],
          warnings: [],
          references: [],
        });
        return;
      }
      const resolved = planeReport(f, reference.id, target, report);
      if (!resolved.ok) {
        await store({ ok: false, errors: [resolved.error], warnings: [], references: [] });
        return;
      }
      const frame = frameOnPlane(resolved.origin, resolved.normal);
      placement = { origin: frame.origin, normal: frame.normal, xDir: frame.xDir };
      warnings.push(...resolved.warnings);
      references.push(resolved.reference);
    }

    run.counters.solves++;
    const solved = await solveSketch(this.#solver, f, placement, variables);
    this.#checkStale(run);
    if (!solved.ok) {
      await store({ ok: false, errors: solved.errors, warnings, references });
      return;
    }
    state.sketches.set(f.id, solved.sketch);
    result.placement = solved.sketch.placement;
    await store({
      ok: true,
      errors: [],
      warnings: [...warnings, ...solved.warnings],
      references,
      sketch: solved.sketch,
    });
  }

  /** The next op reads these bodies: note which instance their shape ids are from. */
  #usesBodies(batch: Batch, bodies: readonly LiveBody[]): void {
    for (const b of bodies) {
      if (b.instance === null) continue;
      const from = batch.shapesFrom;
      batch.shapesFrom = from === null || from === b.instance ? b.instance : MIXED_INSTANCES;
    }
  }

  /**
   * Throw `StaleShapes` when a batch ran on shape ids that are gone, before any of its results
   * are used or cached: a reply from another kernel instance than the ids came from (a recycle
   * was queued after a cache hit and ran before the batch), an op that failed on an unknown
   * shape, or a feature the kernel passed through because its input body is unknown.
   */
  #checkLive(batch: Batch, reply: BatchReply): void {
    if (batch.shapesFrom !== null && batch.shapesFrom !== reply.instance) {
      throw new StaleShapes(reply.instance);
    }
    for (const [j, r] of reply.results.entries()) {
      if ((!r.ok && r.error.code === 'unknown-shape') || staleBody(batch.ops[j]!, r)) {
        throw new StaleShapes(reply.instance);
      }
    }
  }

  /** Run the pending batch and record what each op did. */
  async #flush(run: Run, state: PartState): Promise<void> {
    const batch = state.batch;
    if (batch.ops.length === 0) return;
    state.batch = emptyBatch();
    run.counters.featureOps += batch.metas.filter((m) => m.type === 'feature').length;
    const reply = await this.#submit(run, batch.ops);
    this.#checkLive(batch, reply);

    for (const [j, meta] of batch.metas.entries()) {
      const r = reply.results[j]!;
      if (meta.type === 'resolve') {
        meta.take(r);
        continue;
      }
      if (meta.type !== 'feature') continue;
      const { feature, key, result, started } = meta;
      if (!r.ok) {
        // The op failed as a whole (a wasm trap): no usable bodies are left.
        result.status = 'error';
        result.errors = [mapFailure(r.error)];
        result.ms = now() - started;
        state.unavailable.set(feature.id, 'error');
        state.broken = true;
        continue;
      }
      const outcome = r.value as FeatureOutcome;
      const made = new Set([...outcome.created, ...outcome.changed]);
      const stored: CachedOutcome =
        made.size === 0 && outcome.consumed.length === 0
          ? { instance: null, bodies: [], consumed: [] }
          : {
              instance: reply.instance,
              bodies: outcome.bodies
                .filter((b) => made.has(b.id))
                .map((b) => ({
                  id: b.id,
                  shape: b.shape,
                  solids: b.solids,
                  created: outcome.created.includes(b.id),
                })),
              consumed: [...outcome.consumed],
            };
      const entry: CacheEntry = {
        key,
        featureId: feature.id,
        type: 'body',
        ok: outcome.ok,
        ...mapOutcome(feature, outcome),
        outcome: stored,
        ms: r.ms,
      };
      await this.#cache.set(key, entry);
      this.#applyOutcome(state, feature.id, key, stored);
      this.#fill(result, entry, started);
      if (!outcome.ok) state.unavailable.set(feature.id, 'error');
    }
  }
}
