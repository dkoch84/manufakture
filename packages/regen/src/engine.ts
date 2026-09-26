// The regeneration engine: a core document in, geometry out, rebuilding only what changed.
//
// It runs next to the kernel (ADR 0007 decision 1: the regen engine lives in the kernel worker)
// and drives it through the kernel service's batch API: one `feature` op per kernel feature,
// with `applyFeature` semantics, chained by `{ result }` references inside a batch. Every
// feature's result is cached under a key that covers everything its output depends on (see
// `cache.ts`), so a regen walks the whole part but only sends ops for keys it has never built.
//
// Batches: a feature that depends on another one (by id or by face name) needs to know whether
// that one failed before it runs (it is then an upstream error, not attempted), so the pending
// batch is flushed first. Features that only share the body do not wait: a failed feature passes
// the body through and the next one builds on it. A sketch placed on a face needs the face's
// plane, so it adds a `resolve` op and flushes. In the worker a batch costs no structured clone,
// and the service yields between ops anyway, so flushing is cheap.
//
// Cancellation: every regen has a generation. A newer regen cancels the kernel batches of the
// older one (`KernelService.cancel`) and the older one stops at its next await, returning null.
// Regens run one at a time, so they never race on the cache.

import type { DocumentChange, Feature, ManufaktureDocument, Part } from '@manufakture/core';
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
} from '@manufakture/kernel';
import type { SketchPlacement } from '@manufakture/sketch';
import {
  DEFAULT_KERNEL_BUILD,
  DEFAULT_SOLVER_BUILD,
  MemoryCache,
  REGEN_IMPLEMENTATION_VERSION,
  cacheKey,
  type CacheEntry,
  type FeatureCache,
  type KeyVersions,
} from './cache';
import { mapFailure, mapOutcome, planeReport } from './errors';
import { buildGraph, dirtyFeaturesOf, readsBody } from './graph';
import { explicitPlacement, solveSketch, type RegenSolver, type SketchResult } from './sketches';
import { faceRef, translateFeature } from './translate';
import type {
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

type BodyRef = ShapeId | { result: number } | null;

interface BodyState {
  ref: BodyRef;
  /** Cache key of the body: `empty` before the first kernel feature. */
  key: string;
  /** An op-level failure left no usable body; kernel features after it are not attempted. */
  broken: boolean;
  /** The kernel instance `ref` lives in, when it is a concrete shape id. */
  instance: number | null;
}

type Meta =
  | { type: 'feature'; feature: Feature; key: string; result: FeatureResult; started: number }
  | { type: 'resolve'; take: (r: OpResult) => void }
  | { type: 'mesh'; partId: string };

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
}

interface PartState {
  part: Part;
  body: BodyState;
  batch: Batch;
  results: Map<string, FeatureResult>;
  /** Features whose dependents cannot be built, and why. */
  unavailable: Map<string, 'error' | 'suppressed' | 'upstream-error'>;
  pending: Set<string>;
  sketches: Map<string, SketchResult>;
  inputs: Map<string, FeatureInput>;
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
  if (op.op !== 'feature' || typeof op.body !== 'number' || !r.ok) return false;
  const outcome = r.value as FeatureOutcome;
  return (
    !outcome.created && outcome.names === null && outcome.errors.some((e) => e.code === 'no-body')
  );
}

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
  #latest = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #instance: number | null = null;
  #lastDocument: ManufaktureDocument | null = null;
  /** Body key per part as last reported, to send meshes only when a body changed. */
  readonly #reported = new Map<string, string | null>();
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
      const state = await this.#buildPart(run, part, document, variables);
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

    // Meshes of the bodies that changed since the last completed regen, in one batch, so they
    // share one name table.
    const meshes = new Map<string, MeshData>();
    const batch = emptyBatch();
    for (const { state } of built) {
      const { ref, key } = state.body;
      const bodyKey = ref === null ? null : key;
      if (ref !== null && this.#reported.get(state.part.id) !== bodyKey) {
        const op: TessellateOp = { op: 'tessellate', shape: ref as ShapeId };
        if (this.#deflection !== undefined) op.deflection = this.#deflection;
        batch.ops.push(op);
        batch.metas.push({ type: 'mesh', partId: state.part.id });
        if (state.body.instance !== null) batch.shapesFrom = state.body.instance;
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
        if (meta.type !== 'mesh') return;
        if (!r.ok) {
          if (r.error.code === 'unknown-shape') throw new StaleShapes(reply.instance);
          throw new Error(`tessellating ${meta.partId} failed: ${r.error.message}`);
        }
        meshes.set(meta.partId, r.value as MeshData);
      });
    }
    this.#checkStale(run);

    // Completed: this is now the state the next edit is compared with.
    const parts: PartResult[] = built.map(({ state, features, dirty }) => {
      const shape = state.body.ref as ShapeId | null;
      const bodyKey = shape === null ? null : state.body.key;
      const before = this.#reported.get(state.part.id);
      const meshChanged = before === undefined || before !== bodyKey;
      this.#reported.set(state.part.id, bodyKey);
      return {
        partId: state.part.id,
        features,
        dirty,
        shape,
        bodyKey,
        meshChanged,
        mesh: meshes.get(state.part.id) ?? null,
      };
    });
    for (const id of [...this.#reported.keys()]) {
      if (!document.parts.some((p) => p.id === id)) this.#reported.delete(id);
    }
    this.#lastDocument = document;
    const dropped = await this.#cache.retain(run.used);
    await this.#releaseEntries(dropped);
    this.#addStats(run.counters);
    return { generation: run.generation, names, parts, counters: run.counters, ms: 0 };
  }

  async #releaseEntries(entries: readonly CacheEntry[]): Promise<void> {
    const shapes: ShapeId[] = [];
    for (const e of entries) {
      if (e.body !== undefined && e.body !== 'passthrough' && e.body.instance === this.#instance) {
        shapes.push(e.body.shape);
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

  async #buildPart(
    run: Run,
    part: Part,
    document: ManufaktureDocument,
    variables: VariableValues,
  ): Promise<PartState> {
    const graph = buildGraph(part, document.variables);
    const state: PartState = {
      part,
      body: { ref: null, key: 'empty', broken: false, instance: null },
      batch: emptyBatch(),
      results: new Map(),
      unavailable: new Map(),
      pending: new Set(),
      sketches: new Map(),
      inputs: new Map(),
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
      // A dependency still in the pending batch: find out how it went first.
      if (deps.some((d) => state.pending.has(d))) await this.#flush(run, state);
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
      if (readsBody(f) && state.body.broken) {
        fail('upstream-error', [
          {
            code: 'upstream',
            upstream: [],
            message: 'The kernel failed earlier in this regen; nothing after it was built',
          },
        ]);
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
        await this.#sketch(run, state, f, values.values, variables, result, started);
        continue;
      }

      const t = translateFeature(f, {
        values: values.values,
        sketches: state.sketches,
        inputs: state.inputs,
      });
      if (!t.ok) {
        fail('error', t.errors);
        continue;
      }
      state.inputs.set(f.id, t.input);
      const key = cacheKey(run.versions, { input: t.input, body: state.body.key });
      run.used.add(key);
      const hit = await this.#cache.get(key);
      if (hit !== undefined && hit.type === 'body' && hit.body !== undefined) {
        run.counters.cacheHits++;
        if (hit.body !== 'passthrough') {
          state.body.ref = hit.body.shape;
          state.body.instance = hit.body.instance;
        }
        state.body.key = key;
        this.#fill(result, hit, started);
        result.cached = true;
        if (!hit.ok) state.unavailable.set(f.id, 'error');
        continue;
      }
      run.counters.cacheMisses++;
      this.#usesBody(state);
      state.batch.ops.push({ op: 'feature', body: state.body.ref, feature: t.input });
      state.batch.metas.push({ type: 'feature', feature: f, key, result, started });
      state.pending.add(f.id);
      state.body.ref = { result: state.batch.ops.length - 1 };
      state.body.key = key;
    }
    await this.#flush(run, state);
    return state;
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
  ): Promise<void> {
    const { name: _name, ...definition } = f;
    void _name;
    const plane =
      f.plane.type === 'plane'
        ? { placement: explicitPlacement(f.plane) }
        : { body: state.body.key, ref: f.plane.face.ref };
    const key = cacheKey(run.versions, {
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
      if (state.body.ref === null) {
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
      let report: ReferenceReport | undefined;
      let failure: RegenError | undefined;
      this.#usesBody(state);
      state.batch.ops.push({
        op: 'resolve',
        shape: state.body.ref,
        refs: [faceRef(reference.ref)],
      });
      state.batch.metas.push({
        type: 'resolve',
        take: (r) => {
          if (r.ok) report = (r.value as { results: ReferenceReport[] }).results[0];
          else failure = mapFailure(r.error);
        },
      });
      run.counters.otherOps++;
      await this.#flush(run, state);
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
    await store({
      ok: true,
      errors: [],
      warnings: [...warnings, ...solved.warnings],
      references,
      sketch: solved.sketch,
    });
  }

  /** The next op reads the current body: note which instance its shape id is from. */
  #usesBody(state: PartState): void {
    if (typeof state.body.ref === 'number') state.batch.shapesFrom = state.body.instance;
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
    state.pending.clear();
    run.counters.featureOps += batch.metas.filter((m) => m.type === 'feature').length;
    const reply = await this.#submit(run, batch.ops);
    this.#checkLive(batch, reply);

    const opFailed = new Map<number, string>();
    for (const [j, meta] of batch.metas.entries()) {
      const r = reply.results[j]!;
      if (meta.type === 'resolve') {
        meta.take(r);
        continue;
      }
      if (meta.type !== 'feature') continue;
      const { feature, key, result, started } = meta;
      if (!r.ok) {
        opFailed.set(j, feature.id);
        const failedBody =
          r.error.code === 'dependency' ? this.#failedInput(batch.ops[j]!, opFailed) : undefined;
        result.status = failedBody !== undefined ? 'upstream-error' : 'error';
        result.errors =
          failedBody !== undefined
            ? [
                {
                  code: 'upstream',
                  upstream: [failedBody],
                  message: `${failedBody} failed in the kernel`,
                },
              ]
            : [mapFailure(r.error)];
        result.ms = now() - started;
        state.unavailable.set(feature.id, result.status);
        continue;
      }
      const outcome = r.value as FeatureOutcome;
      const mapped = mapOutcome(feature, outcome);
      const entry: CacheEntry = {
        key,
        featureId: feature.id,
        type: 'body',
        ok: outcome.ok,
        ...mapped,
        body:
          outcome.created && outcome.shape !== null
            ? { shape: outcome.shape, instance: reply.instance }
            : 'passthrough',
        ms: r.ms,
      };
      await this.#cache.set(key, entry);
      this.#fill(result, entry, started);
      if (!outcome.ok) state.unavailable.set(feature.id, 'error');
    }

    // The body is now a real shape id (or gone, after an op-level failure).
    const ref = state.body.ref;
    if (ref !== null && typeof ref === 'object') {
      const r = reply.results[ref.result]!;
      const shape = r.ok ? (r.value as { shape?: ShapeId | null }).shape : undefined;
      if (shape === undefined) {
        state.body.ref = null;
        state.body.broken = true;
      } else {
        state.body.ref = shape;
        state.body.instance = shape === null ? null : reply.instance;
      }
    }
  }

  /** The feature whose failed op made op `op`'s body input fail. */
  #failedInput(op: KernelOp, failed: ReadonlyMap<number, string>): string | undefined {
    if (op.op !== 'feature' || op.body === null || typeof op.body !== 'object') return undefined;
    return failed.get(op.body.result);
  }
}
