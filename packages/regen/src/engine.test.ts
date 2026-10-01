// The engine's logic against a scripted kernel and solver: which ops go out, what comes from
// the cache, how errors propagate, rollback, suppression, eviction, recycles and cancellation.
// The real kernel and solver are in integration.test.ts.

import { createHash } from 'node:crypto';
import {
  MAX_DERIVED_DEPTH,
  configured,
  serialize,
  type Command,
  type DerivedFeature,
  type DerivedSource,
  type ExtrudeFeature,
  type ImportFeature,
  type ImportSource,
  type ManufaktureDocument,
  type PatternFeature,
} from '@manufakture/core';
import type {
  BatchReply,
  BatchRequest,
  ConnectorReport,
  FeatureError,
  FeatureInput,
  FeatureOutcome,
  FeatureWarning,
  InterferenceResult,
  KernelOp,
  MeshData,
  OpResult,
  ShapeId,
} from '@manufakture/kernel';
import type { SketchInput, SolveResult } from '@manufakture/sketch';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from './cache';
import { RegenEngine, type RegenKernel } from './engine';
import { importSourceMatches, keyInput } from './imports';
import type { RegenSolver } from './sketches';
import {
  ASSEMBLY,
  LID,
  PART,
  add,
  addTo,
  apply,
  block,
  build,
  centroid,
  derivedOf,
  extrude,
  fillet,
  instance,
  mate,
  mm,
  pin,
  pinText,
  pocket,
  rectangle,
  setVariable,
  statuses,
  twoBodies,
  unwrap,
  withRows,
} from './test-helpers';

interface Behaviour {
  errors?: FeatureError[];
  warnings?: FeatureWarning[];
  /** The bodies (of those read) the feature changes; default every one. */
  touch?: string[];
  /** Fuse the touched bodies into the first of them. */
  merge?: boolean;
}

/** A kernel that makes numbered shapes, fails features on request and supports cancellation. */
class FakeKernel implements RegenKernel {
  instance = 1;
  next = 100;
  readonly live = new Set<number>();
  latest = 0;
  cancelledThrough = 0;
  /** Feature ids of every `feature` op run, in order. */
  readonly featureOps: string[] = [];
  /** The body shapes each feature op got, by feature id (last run). */
  readonly bodies = new Map<string, number[]>();
  /** The body ids each feature op got, by feature id (last run). */
  readonly sets = new Map<string, string[]>();
  readonly inputs = new Map<string, FeatureInput>();
  readonly released: number[] = [];
  readonly cancels: number[] = [];
  readonly behaviours = new Map<string, Behaviour>();
  /** Connector origins asked for, one entry per `connector` op (the names, in order). */
  readonly connectorOps: string[][] = [];
  /** Every `interference` op run. */
  readonly interferenceOps: Extract<KernelOp, { op: 'interference' }>[] = [];
  gate: Promise<void> | null = null;
  onRun: (() => void) | null = null;

  stats() {
    return { generation: this.latest };
  }

  cancel(generation?: number) {
    const g = generation ?? this.latest;
    this.cancels.push(g);
    this.cancelledThrough = Math.max(this.cancelledThrough, g);
  }

  async release(shapes: readonly ShapeId[]) {
    for (const s of shapes) {
      this.live.delete(s);
      this.released.push(s);
    }
  }

  /** Lose every shape, as a recycle does (without telling anyone). */
  recycle() {
    this.instance++;
    this.live.clear();
  }

  #stale(g: number) {
    return g < this.latest || g <= this.cancelledThrough;
  }

  async run(request: BatchRequest): Promise<BatchReply> {
    this.latest = Math.max(this.latest, request.generation);
    this.onRun?.();
    if (this.gate) await this.gate;
    const reply = (status: 'done' | 'cancelled', results: OpResult[]): BatchReply => ({
      generation: request.generation,
      instance: this.instance,
      status,
      results: results as never,
      completedOps: results.length,
      names: ['a-name'],
      heapBytes: 0,
      shapeCount: this.live.size,
      ms: 0,
      recycle: null,
    });
    if (this.#stale(request.generation)) return reply('cancelled', []);
    const results: OpResult[] = [];
    for (const op of request.ops as readonly KernelOp[]) {
      results.push(this.#op(op, results));
    }
    return reply('done', results);
  }

  /**
   * A shape op on an id that is not live fails the op with `unknown-shape`, as the real service
   * does for `resolve` and `tessellate`. (A `feature` op does not: see `#op`.)
   */
  #shape(ref: unknown, results: OpResult[]): number | { fail: OpResult } | null {
    if (ref === null) return null;
    if (typeof ref === 'number') {
      if (!this.live.has(ref)) {
        return {
          fail: {
            ok: false,
            op: 'feature',
            error: { code: 'unknown-shape', operation: 'feature', message: `unknown ${ref}` },
            ms: 0,
          },
        };
      }
      return ref;
    }
    const earlier = results[(ref as { result: number }).result]!;
    if (!earlier.ok) {
      return {
        fail: {
          ok: false,
          op: 'feature',
          error: { code: 'dependency', operation: 'feature', message: 'input failed' },
          ms: 0,
        },
      };
    }
    // A feature op's value is a body set: a bare { result } takes its first body; others carry `shape`.
    const value = earlier.value as { shape?: number | null; bodies?: { shape: number }[] };
    return value.bodies !== undefined ? (value.bodies[0]?.shape ?? null) : (value.shape ?? null);
  }

  #op(op: KernelOp, results: OpResult[]): OpResult {
    switch (op.op) {
      case 'feature': {
        const id = op.feature.id;
        expect('join' in op).toBe(false);
        // Regen sends the bodies a feature reads, listed with their ids.
        expect(Array.isArray(op.bodies)).toBe(true);
        const given = op.bodies as readonly { id: string; shape: number }[];
        this.featureOps.push(id);
        this.bodies.set(
          id,
          given.map((g) => g.shape),
        );
        this.sets.set(
          id,
          given.map((g) => g.id),
        );
        this.inputs.set(id, op.feature);
        const passed = (names: boolean) =>
          given.map((g) => ({
            id: g.id,
            shape: g.shape as ShapeId,
            names: names ? { faces: [], edges: [] } : null,
            solids: names ? 1 : 0,
          }));
        const fail = (errors: FeatureError[], names = true): OpResult => {
          const value: FeatureOutcome = {
            featureId: id,
            kind: op.feature.kind,
            ok: false,
            bodies: passed(names),
            created: [],
            changed: [],
            consumed: [],
            errors,
            warnings: [],
            resolved: [],
          };
          return { ok: true, op: 'feature', value, ms: 0 };
        };
        const dead = given.find((g) => !this.live.has(g.shape));
        if (dead !== undefined) {
          // What `applyFeature` does with an unknown body id: a normal feature result that
          // passes the ids through with a `no-body` error and no names, not a failed op.
          return fail(
            [{ featureId: id, code: 'no-body', message: `unknown shape id ${dead.shape}` }],
            false,
          );
        }
        if (op.feature.kind === 'derive') {
          // The real kernel reads a derive's sources as it reads bodies: a dead one is `no-body`
          // on `sources`.
          const gone = op.feature.sources.find((x) => !this.live.has(x.shape));
          if (gone !== undefined) {
            return fail([
              {
                featureId: id,
                code: 'no-body',
                ref: 'sources',
                target: gone.id,
                message: `unknown shape id ${gone.shape}`,
              },
            ]);
          }
        }
        const b = this.behaviours.get(id) ?? {};
        if ((b.errors ?? []).length > 0) return fail(b.errors!);
        const input = op.feature as { mode?: string; body?: string };
        const mint = () => {
          const shape = this.next++ as ShapeId;
          this.live.add(shape);
          return shape;
        };
        // A live body always has names (the engine never reads them).
        const bodies = passed(true);
        const created: string[] = [];
        const changed: string[] = [];
        let consumed: string[] = [];
        if (input.mode === 'new' || given.length === 0) {
          const made =
            op.feature.kind === 'derive'
              ? op.feature.sources.map((x) => `${id}:from/${x.id}`)
              : [input.body ?? id];
          for (const bodyId of made) {
            bodies.push({ id: bodyId, shape: mint(), names: { faces: [], edges: [] }, solids: 1 });
            created.push(bodyId);
          }
        } else {
          // Every body read is changed (a scripted `touch` narrows it), and `merge` fuses them.
          const touched = given.filter((g) => b.touch?.includes(g.id) ?? true).map((g) => g.id);
          if (b.merge) consumed = touched.slice(1);
          for (const body of bodies) {
            if (touched[0] === body.id || (!b.merge && touched.includes(body.id))) {
              body.shape = mint();
              changed.push(body.id);
            }
          }
        }
        const value: FeatureOutcome = {
          featureId: id,
          kind: op.feature.kind,
          ok: true,
          bodies: bodies.filter((x) => !consumed.includes(x.id)),
          created,
          changed,
          consumed,
          errors: [],
          warnings: b.warnings ?? [],
          resolved: [],
        };
        return { ok: true, op: 'feature', value, ms: 1 };
      }
      case 'resolve': {
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        return {
          ok: true,
          op: 'resolve',
          value: {
            results: [
              {
                ok: true,
                index: 1,
                via: 'exact',
                fragile: false,
                geometry: { kind: 'plane', origin: [0, 0, 20], direction: [0, 0, 1] },
              },
            ],
          },
          ms: 0,
        };
      }
      case 'connector': {
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        const names = op.connectors.map((c) =>
          'face' in c.origin ? c.origin.face : c.origin.faces.join('&'),
        );
        this.connectorOps.push(names);
        // Every connector sits at the origin of the part with the world axes; a name with
        // `gone` in it is lost.
        const reports: ConnectorReport[] = names.map((name): ConnectorReport =>
          name.includes('gone')
            ? { ok: false, status: 'lost', missing: [name], message: `${name} is lost` }
            : {
                ok: true,
                frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
                kind: 'face',
                index: 1,
                via: 'exact',
                fragile: false,
                oriented: true,
              },
        );
        return { ok: true, op: 'connector', value: { results: reports }, ms: 0 };
      }
      case 'tessellate': {
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        const mesh = { faceNames: new Uint32Array(0) } as unknown as MeshData;
        return { ok: true, op: 'tessellate', value: mesh, ms: 0 };
      }
      case 'topology': {
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        const topology = { faces: [], edges: [], vertices: [] };
        return { ok: true, op: 'topology', value: topology, ms: 0 };
      }
      case 'interference': {
        this.interferenceOps.push(op);
        for (const item of op.items) {
          for (const ref of item.shapes) {
            const body = this.#shape(ref, results);
            if (body !== null && typeof body === 'object') return body.fail;
          }
        }
        // Every pair is a candidate; a checked pair overlaps by the sum of its x translations.
        const n = op.items.length;
        const all: [number, number][] = [];
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([i, j]);
        const pairs = (op.pairs ?? all).map(([a, b]) => [a, b] as [number, number]);
        const x = (i: number) => op.items[i]!.transform?.translation[0] ?? 0;
        const value: InterferenceResult = {
          candidates: pairs,
          booleans: op.prefilterOnly ? 0 : pairs.length,
          pairs: op.prefilterOnly ? [] : pairs.map(([a, b]) => ({ a, b, volume: x(a) + x(b) })),
          failures: [],
        };
        return { ok: true, op: 'interference', value, ms: 0 };
      }
      default:
        throw new Error(`fake kernel: no ${op.op}`);
    }
  }
}

/** Solves nothing: returns the stored coordinates. A constraint `k99` makes it conflict. */
class FakeSolver implements RegenSolver {
  solves = 0;
  async solve(sketch: SketchInput): Promise<SolveResult> {
    this.solves++;
    const conflict = sketch.constraints.some((c) => c.id === 'k99');
    return {
      status: conflict ? 'conflicting' : 'solved',
      entities: [...sketch.entities],
      diagnosis: {
        dof: conflict ? null : 0,
        conflicting: conflict ? ['k98', 'k99'] : [],
        redundant: [],
        partiallyRedundant: [],
        entities: {},
      },
      issues: [],
    };
  }
}

function setup(options: { spare?: number } = {}) {
  const kernel = new FakeKernel();
  const solver = new FakeSolver();
  const engine = new RegenEngine({
    kernel,
    solver,
    cache: new MemoryCache(options.spare === undefined ? {} : { spare: options.spare }),
  });
  return { kernel, solver, engine };
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument) {
  const r = await engine.regen(doc);
  if (r === null) throw new Error('superseded');
  return r;
}

const suppress = (featureId: string, suppressed = true): Command => ({
  type: 'suppressFeature',
  partId: PART,
  featureId,
  suppressed,
});

/**
 * Three independent blocks: extrude#2 is the one made to fail, fillet#1 rounds one of its edges,
 * extrude#3 has nothing to do with it.
 */
function threeBlocks(): ManufaktureDocument {
  return build([
    add(rectangle('sketch#1', { width: '40', depth: '30' })),
    add(extrude('extrude#1', 'sketch#1', '20')),
    add(
      rectangle('sketch#2', {
        width: '40',
        depth: '30',
        at: [100, 0],
        ids: ['e5', 'e6', 'e7', 'e8'],
        firstConstraint: 12,
      }),
    ),
    add(extrude('extrude#2', 'sketch#2', '20', 'add')),
    add(fillet('fillet#1', ['extrude#2:side:e5', 'extrude#2:side:e6'], '2mm')),
    add(
      rectangle('sketch#3', {
        width: '40',
        depth: '30',
        at: [200, 0],
        ids: ['e9', 'e10', 'e11', 'e12'],
        firstConstraint: 23,
      }),
    ),
    add(extrude('extrude#3', 'sketch#3', '20', 'add')),
  ]);
}

describe('cache and minimal rebuilds', () => {
  it('builds everything once, then nothing for an edit that changes no geometry', async () => {
    const { kernel, solver, engine } = setup();
    const doc = block();
    const first = await regen(engine, doc);
    expect(statuses(first)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
    expect(solver.solves).toBe(1);
    expect(first.parts[0]!.bodies[0]!.meshChanged).toBe(true);
    // The fillet waited for the extrude it names: two batches, plus the mesh.
    expect(first.counters).toMatchObject({ batches: 3, featureOps: 2, cacheMisses: 3 });

    const renamed = apply(doc, {
      type: 'renameFeature',
      partId: PART,
      featureId: 'extrude#1',
      name: 'Base',
    });
    const second = await regen(engine, renamed);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
    expect(solver.solves).toBe(1);
    expect(second.counters).toMatchObject({ batches: 0, cacheHits: 3, cacheMisses: 0 });
    expect(second.parts[0]!.dirty).toEqual([]);
    expect(second.parts[0]!.features.every((f) => f.cached)).toBe(true);
    expect(second.parts[0]!.bodies[0]!.shape).toBe(first.parts[0]!.bodies[0]!.shape);
    expect(second.parts[0]!.bodies[0]!.meshChanged).toBe(false);
  });

  it('rebuilds only the feature that reads an edited variable', async () => {
    const { kernel, solver, engine } = setup();
    const doc = block();
    await regen(engine, doc);
    const edited = await regen(engine, apply(doc, setVariable('radius', '4mm')));
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'fillet#1']);
    expect(solver.solves).toBe(1);
    expect(edited.parts[0]!.dirty).toEqual(['fillet#1']);
    expect(edited.parts[0]!.features.map((f) => f.cached)).toEqual([true, true, false]);
    // The fillet was applied to the cached extrude body.
    expect(kernel.bodies.get('fillet#1')).toEqual([100]);
    expect(kernel.sets.get('fillet#1')).toEqual(['extrude#1']);
    expect(kernel.inputs.get('fillet#1')).toMatchObject({ radius: 4 });
  });

  it('adds a feature at the end with one op on the cached body', async () => {
    const { kernel, engine } = setup();
    const doc = block();
    const first = await regen(engine, doc);
    const more = apply(
      doc,
      add(
        rectangle('sketch#2', {
          width: '10',
          depth: '10',
          at: [5, 5],
          ids: ['e5', 'e6', 'e7', 'e8'],
          firstConstraint: 12,
        }),
      ),
      add(extrude('extrude#2', 'sketch#2', '5', 'cut')),
    );
    const next = await regen(engine, more);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'extrude#2']);
    expect(kernel.bodies.get('extrude#2')).toEqual([first.parts[0]!.bodies[0]!.shape]);
    expect(next.parts[0]!.dirty).toEqual(['sketch#2', 'extrude#2']);
  });

  it('does not rebuild when a variable is rewritten to the same value', async () => {
    const { kernel, engine } = setup();
    const doc = block();
    await regen(engine, doc);
    const same = await regen(engine, apply(doc, setVariable('radius', '1mm + 2mm')));
    // Dirty (it reads a changed variable), but its evaluated input is identical: a cache hit.
    expect(same.parts[0]!.dirty).toEqual(['fillet#1']);
    expect(same.counters.cacheMisses).toBe(0);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
  });

  it('releases the shapes of evicted entries', async () => {
    const { kernel, engine } = setup({ spare: 0 });
    const doc = block();
    const first = await regen(engine, doc);
    const oldFillet = first.parts[0]!.bodies[0]!.shape!;
    await regen(engine, apply(doc, setVariable('radius', '4mm')));
    expect(kernel.released).toEqual([oldFillet]);
    await engine.dispose();
    expect(kernel.live.size).toBe(0);
  });

  it('keeps spare entries, so undoing an edit is served from the cache', async () => {
    const { kernel, engine } = setup();
    const doc = block();
    const first = await regen(engine, doc);
    await regen(engine, apply(doc, setVariable('radius', '4mm')));
    const back = await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'fillet#1']);
    expect(back.parts[0]!.bodies[0]!.shape).toBe(first.parts[0]!.bodies[0]!.shape);
    expect(back.parts[0]!.bodies[0]!.meshChanged).toBe(true);
    expect(kernel.released).toEqual([]);
  });

  it('keys solved sketches by the solver build', async () => {
    const cache = new MemoryCache();
    const kernel = new FakeKernel();
    const solver = new FakeSolver();
    const doc = block();
    await regen(new RegenEngine({ kernel, solver, cache, solverBuild: 'planegcs@1' }), doc);
    const same = await regen(
      new RegenEngine({ kernel, solver, cache, solverBuild: 'planegcs@1' }),
      doc,
    );
    expect(same.counters.solves).toBe(0);
    const other = await regen(
      new RegenEngine({ kernel, solver, cache, solverBuild: 'planegcs@2' }),
      doc,
    );
    expect(other.counters.solves).toBe(1);
    expect(solver.solves).toBe(2);
  });
});

describe('bodies', () => {
  /** The document with extrusion `id` 25 mm deep instead of 20 (the fake solver moves nothing). */
  const deeper = (doc: ManufaktureDocument, id: string) => {
    const f = doc.parts[0]!.features.find((x) => x.id === id) as ExtrudeFeature;
    return apply(doc, {
      type: 'editFeature',
      partId: PART,
      feature: { ...f, extent: { type: 'blind', distance: mm('25') } },
    });
  };
  const ids = (r: { parts: { bodies: { bodyId: string }[] }[] }) =>
    r.parts[0]!.bodies.map((b) => b.bodyId);

  it('sends each feature only the bodies it reads, and rebuilds only the edited body', async () => {
    const { kernel, engine } = setup();
    const doc = twoBodies();
    const first = await regen(engine, doc);
    expect(ids(first)).toEqual(['extrude#1', 'extrude#2']);
    expect(first.parts[0]!.bodies.map((b) => [b.creator, b.meshChanged])).toEqual([
      ['extrude#1', true],
      ['extrude#2', true],
    ]);
    expect(kernel.featureOps).toEqual(['extrude#1', 'extrude#2', 'fillet#1', 'fillet#2']);
    // A new body reads none; each fillet reads the body its edge is on.
    expect(kernel.sets.get('extrude#2')).toEqual([]);
    expect(kernel.sets.get('fillet#1')).toEqual(['extrude#1']);
    expect(kernel.sets.get('fillet#2')).toEqual(['extrude#2']);
    expect(kernel.inputs.get('extrude#2')).toMatchObject({ mode: 'new', body: 'extrude#2' });

    // Body 2's radius: one op, on body 2, and only its mesh.
    const r2 = await regen(engine, apply(doc, setVariable('r2', '4mm')));
    expect(kernel.featureOps.slice(4)).toEqual(['fillet#2']);
    expect(r2.parts[0]!.bodies.map((b) => [b.bodyId, b.meshChanged, b.mesh !== null])).toEqual([
      ['extrude#1', false, false],
      ['extrude#2', true, true],
    ]);
    expect(r2.parts[0]!.bodies[0]!.bodyKey).toBe(first.parts[0]!.bodies[0]!.bodyKey);

    // Body 1's height: its extrusion and fillet; body 2 is all cache hits.
    const taller = await regen(engine, deeper(doc, 'extrude#1'));
    expect(kernel.featureOps.slice(5)).toEqual(['extrude#1', 'fillet#1']);
    // Body 2 is back to the radius of the first regen: its first body again, re-sent.
    expect(taller.parts[0]!.bodies.map((b) => b.meshChanged)).toEqual([true, true]);
    expect(taller.parts[0]!.bodies[1]!.bodyKey).toBe(first.parts[0]!.bodies[1]!.bodyKey);
  });

  it('reads every body for a feature without a scope, and the scoped ones for one with', async () => {
    const withCut = (scope?: string[]) =>
      twoBodies([
        add(pocket('sketch#3', [5, 5])),
        add({ ...extrude('extrude#3', 'sketch#3', '5', 'cut'), ...(scope ? { scope } : {}) }),
      ]);
    const open = setup();
    open.kernel.behaviours.set('extrude#3', { touch: ['extrude#1'] });
    const a = withCut();
    await regen(open.engine, a);
    expect(open.kernel.sets.get('extrude#3')).toEqual(['extrude#1', 'extrude#2']);
    await regen(open.engine, deeper(a, 'extrude#2'));
    // The cut read body 2, so body 1's fillet after it is rebuilt too.
    expect(open.kernel.featureOps.slice(5)).toEqual([
      'extrude#2',
      'extrude#3',
      'fillet#1',
      'fillet#2',
    ]);

    const scoped = setup();
    const b = withCut(['extrude#1']);
    await regen(scoped.engine, b);
    expect(scoped.kernel.sets.get('extrude#3')).toEqual(['extrude#1']);
    expect(scoped.kernel.inputs.get('extrude#3')).toMatchObject({ scope: ['extrude#1'] });
    await regen(scoped.engine, deeper(b, 'extrude#2'));
    expect(scoped.kernel.featureOps.slice(5)).toEqual(['extrude#2', 'fillet#2']);
  });

  it('lists merged bodies as consumed and routes their faces to the body they went into', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('extrude#3', { merge: true });
    const doc = twoBodies([
      add(pocket('sketch#3', [30, 5])),
      add(extrude('extrude#3', 'sketch#3', '5', 'add')),
    ]);
    const result = await regen(engine, doc);
    expect(ids(result)).toEqual(['extrude#1']);
    expect(result.parts[0]!.consumed).toEqual([{ bodyId: 'extrude#2', featureId: 'extrude#3' }]);
    // fillet#2 names body 2's faces, which are on body 1 now.
    expect(kernel.sets.get('fillet#2')).toEqual(['extrude#1']);
    expect(statuses(result)['fillet#2']).toBe('ok');
    // From the cache, the same.
    const again = await regen(engine, apply(doc, setVariable('r2', '4mm')));
    expect(again.parts[0]!.consumed).toEqual([{ bodyId: 'extrude#2', featureId: 'extrude#3' }]);
    expect(kernel.featureOps.slice(-1)).toEqual(['fillet#2']);
    expect(kernel.sets.get('fillet#2')).toEqual(['extrude#1']);
  });

  it('fails a scope naming a body that is not there, without sending it', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('extrude#3', { merge: true });
    const doc = twoBodies([
      add(pocket('sketch#3', [30, 5])),
      add(extrude('extrude#3', 'sketch#3', '5', 'add')),
      add(pocket('sketch#4', [110, 5], 1)),
      add({ ...extrude('extrude#4', 'sketch#4', '5', 'cut'), scope: ['extrude#2'] }),
    ]);
    const result = await regen(engine, doc);
    expect(result.parts[0]!.features.find((f) => f.featureId === 'extrude#4')).toMatchObject({
      status: 'error',
      errors: [{ code: 'reference-lost', referenceId: 'scope', missing: ['extrude#2'] }],
    });
    expect(kernel.featureOps).not.toContain('extrude#4');
  });
});

describe('errors', () => {
  it('marks dependents of a failed feature as upstream errors and still builds independent ones', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('extrude#2', {
      errors: [
        {
          featureId: 'extrude#2',
          code: 'kernel',
          message: 'BRepAlgoAPI_Fuse failed',
          occtMessage: 'StdFail_NotDone',
        },
      ],
    });
    const result = await regen(engine, threeBlocks());
    expect(statuses(result)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'sketch#2': 'ok',
      'extrude#2': 'error',
      'fillet#1': 'upstream-error',
      'sketch#3': 'ok',
      'extrude#3': 'ok',
    });
    const features = result.parts[0]!.features;
    expect(features[3]!.errors).toEqual([
      { code: 'kernel', message: 'BRepAlgoAPI_Fuse failed', occtMessage: 'StdFail_NotDone' },
    ]);
    expect(features[4]!.errors).toEqual([
      { code: 'upstream', upstream: ['extrude#2'], message: 'Depends on extrude#2, which failed' },
    ]);
    // The fillet never reached the kernel; extrude#3 got the body extrude#1 made, passed through.
    expect(kernel.featureOps).toEqual(['extrude#1', 'extrude#2', 'extrude#3']);
    expect(kernel.bodies.get('extrude#3')).toEqual(kernel.bodies.get('extrude#2'));
    expect(kernel.bodies.get('extrude#2')).toEqual([100]);
  });

  it('caches failures too: an unrelated edit does not retry them', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('extrude#2', {
      errors: [{ featureId: 'extrude#2', code: 'empty', message: 'nothing left' }],
    });
    const doc = threeBlocks();
    await regen(engine, doc);
    const again = await regen(
      engine,
      apply(doc, { type: 'renameFeature', partId: PART, featureId: 'extrude#3', name: 'X' }),
    );
    expect(kernel.featureOps).toEqual(['extrude#1', 'extrude#2', 'extrude#3']);
    expect(statuses(again)['extrude#2']).toBe('error');
    expect(again.parts[0]!.features[3]!.errors).toEqual([
      { code: 'empty', message: 'nothing left' },
    ]);
  });

  it('maps lost and ambiguous references to re-pick errors with the reference id', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('fillet#1', {
      errors: [
        {
          featureId: 'fillet#1',
          code: 'lost',
          ref: 'r1',
          target: 'extrude#1:side:e1|extrude#1:side:e2',
          missing: ['extrude#1:side:e2'],
          message: 'extrude#1:side:e1|extrude#1:side:e2 is lost',
        },
      ],
    });
    const result = await regen(engine, block());
    expect(result.parts[0]!.features[2]).toMatchObject({
      status: 'error',
      errors: [
        {
          code: 'reference-lost',
          referenceId: 'r1',
          missing: ['extrude#1:side:e2'],
          target: 'extrude#1:side:e1|extrude#1:side:e2',
          message: 'extrude#1:side:e1|extrude#1:side:e2 is lost: re-pick it',
        },
      ],
    });
  });

  it('surfaces fragile and non-exact resolutions as warnings', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('fillet#1', {
      warnings: [
        {
          featureId: 'fillet#1',
          code: 'reference',
          ref: 'r1',
          target: 'extrude#1:side:e1|extrude#1:side:e2',
          kind: 'edge',
          index: 3,
          via: 'ends',
          fragile: true,
          message: 'resolved by its end faces',
        },
      ],
    });
    const result = await regen(engine, block());
    expect(result.parts[0]!.features[2]).toMatchObject({
      status: 'ok',
      warnings: [
        {
          code: 'reference',
          referenceId: 'r1',
          via: 'ends',
          fragile: true,
          target: 'extrude#1:side:e1|extrude#1:side:e2',
        },
      ],
    });
  });

  it('reports a sketch conflict with its constraint ids; the extrude of it is an upstream error', async () => {
    const { kernel, engine } = setup();
    const sketch = rectangle('sketch#1', { width: '40', depth: '30' });
    sketch.constraints.push({ id: 'k99', kind: 'horizontal', line: 'e2' });
    const doc = build([add(sketch), add(extrude('extrude#1', 'sketch#1', '20'))]);
    const result = await regen(engine, doc);
    expect(result.parts[0]!.features[0]).toMatchObject({
      status: 'error',
      errors: [{ code: 'sketch', conflicting: ['k98', 'k99'], redundant: [] }],
    });
    expect(statuses(result)['extrude#1']).toBe('upstream-error');
    expect(kernel.featureOps).toEqual([]);
    expect(result.parts[0]!.bodies).toEqual([]);
  });

  it('checks the dimension an expression evaluates to', async () => {
    const { kernel, engine } = setup();
    const doc = build([
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '30deg')),
    ]);
    const result = await regen(engine, doc);
    expect(result.parts[0]!.features[1]).toMatchObject({
      status: 'error',
      errors: [
        {
          code: 'expression',
          field: ['extent', 'distance'],
          error: { code: 'dimension', start: 0, end: 5 },
        },
      ],
    });
    expect(kernel.featureOps).toEqual([]);
  });

  it('range-checks a pattern count computed from an expression', async () => {
    const { kernel, engine } = setup();
    const pattern = (count: string): PatternFeature => ({
      id: 'pattern#1',
      kind: 'pattern',
      name: 'Pattern 1',
      suppressed: false,
      features: ['extrude#2'],
      layout: {
        type: 'linear',
        direction: { id: 'r2', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } },
        count: mm(count),
        spacing: mm('10'),
      },
    });
    const base = build([
      setVariable('n', '500'),
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add(
        rectangle('sketch#2', {
          width: '4',
          depth: '4',
          at: [2, 2],
          ids: ['e5', 'e6', 'e7', 'e8'],
          firstConstraint: 12,
        }),
      ),
      add(extrude('extrude#2', 'sketch#2', '5', 'cut')),
      add(pattern('n * 2 + 1')),
    ]);
    const tooMany = await regen(engine, base);
    expect(tooMany.parts[0]!.features[4]).toMatchObject({
      status: 'error',
      errors: [{ code: 'invalid', field: ['layout', 'count'] }],
    });
    expect(tooMany.parts[0]!.features[4]!.errors[0]!.message).toContain('1001');

    const fraction = await regen(engine, apply(base, setVariable('n', '2.25')));
    expect(fraction.parts[0]!.features[4]!.errors[0]!.message).toContain('whole number');

    const fine = await regen(engine, apply(base, setVariable('n', '2')));
    expect(statuses(fine)['pattern#1']).toBe('ok');
    const input = kernel.inputs.get('pattern#1');
    expect(input).toMatchObject({
      kind: 'pattern',
      layout: { type: 'linear', count: 5, spacing: 10 },
      source: { type: 'features', features: [{ kind: 'extrude', id: 'extrude#2' }] },
    });
    expect(kernel.featureOps.filter((f) => f === 'pattern#1')).toHaveLength(1);
  });
});

describe('suppression and rollback', () => {
  it('skips a suppressed feature; its dependents are upstream errors', async () => {
    const { kernel, engine } = setup();
    const doc = apply(block(), suppress('extrude#1'));
    const result = await regen(engine, doc);
    expect(statuses(result)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'suppressed',
      'fillet#1': 'upstream-error',
    });
    expect(result.parts[0]!.features[2]!.errors[0]!.message).toBe(
      'Depends on extrude#1, which is suppressed',
    );
    expect(kernel.featureOps).toEqual([]);
    const back = await regen(engine, block());
    expect(statuses(back)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
  });

  it('regenerates only up to the rollback bar and reports the rest as rolled back', async () => {
    const { kernel, engine } = setup();
    const doc = block();
    const rolled = apply(doc, { type: 'setRollback', partId: PART, index: 2 });
    const result = await regen(engine, rolled);
    expect(statuses(result)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'fillet#1': 'rolled-back',
    });
    expect(result.parts[0]!.dirty).toEqual(['sketch#1', 'extrude#1']);
    expect(kernel.featureOps).toEqual(['extrude#1']);
    // Moving the bar back to the end builds only what it uncovers.
    const all = await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
    expect(all.parts[0]!.dirty).toEqual(['fillet#1']);
  });
});

describe('cancellation and recycling', () => {
  it('abandons a regen whose kernel batch is superseded', async () => {
    const { kernel, engine } = setup();
    let release!: () => void;
    kernel.gate = new Promise((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    kernel.onRun = () => started();
    const doc = block();
    const a = engine.regen(doc);
    await running;
    const b = engine.regen(apply(doc, setVariable('radius', '4mm')));
    kernel.onRun = null;
    release();
    kernel.gate = null;
    expect(await a).toBeNull();
    const result = await b;
    expect(result).not.toBeNull();
    expect(kernel.cancels).toEqual([1]);
    // The abandoned batch made nothing; the newer regen built everything once.
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
    expect(kernel.inputs.get('fillet#1')).toMatchObject({ radius: 4 });
    expect(engine.stats.superseded).toBe(1);
  });

  it('answers a stale generation with null without doing any work', async () => {
    const { kernel, engine } = setup();
    expect(await engine.regen(block(), { generation: 5 })).not.toBeNull();
    expect(await engine.regen(block(), { generation: 3 })).toBeNull();
    expect(await engine.regen(block(), { generation: 5 })).toBeNull();
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
  });

  it('rebuilds when cached shapes were lost to a recycle', async () => {
    const { kernel, engine } = setup();
    const doc = block();
    await regen(engine, doc);
    kernel.recycle();
    const result = await regen(engine, apply(doc, setVariable('radius', '4mm')));
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    // The fillet op hit the dead extrude shape; the retry rebuilt the extrude, not the sketch.
    expect(kernel.featureOps).toEqual([
      'extrude#1',
      'fillet#1',
      'fillet#1',
      'extrude#1',
      'fillet#1',
    ]);
    expect(engine.stats.retries).toBe(1);
    expect(kernel.live.has(result.parts[0]!.bodies[0]!.shape!)).toBe(true);
    // The pass-through the kernel gave the fillet on the dead body was never cached.
    const again = await regen(engine, apply(doc, setVariable('radius', '4mm')));
    expect(again.counters).toMatchObject({ featureOps: 0, cacheHits: 3 });
    expect(again.parts[0]!.features[2]).toMatchObject({ status: 'ok', errors: [], cached: true });
  });

  it('rebuilds a part served from the cache when a recycle lands during another part', async () => {
    const { kernel, engine } = setup();
    const one = block();
    const doc: ManufaktureDocument = {
      ...one,
      parts: [one.parts[0]!, { ...one.parts[0]!, id: 'part#2', name: 'Part 2' }],
      nextIds: { part: 3 },
    };
    const first = await regen(engine, doc);
    const shapeOfA = first.parts[0]!.bodies[0]!.shape!;
    // Part 2's first kernel feature changes: its batch uses no cached shape, so only the
    // check after the part loop can see that part 1's cached body died with the recycle.
    const extrude2 = doc.parts[1]!.features[1]! as ExtrudeFeature;
    const edited = apply(doc, {
      type: 'editFeature',
      partId: 'part#2',
      feature: { ...extrude2, extent: { type: 'blind', distance: mm('25') } },
    });
    let recycled = false;
    kernel.onRun = () => {
      if (recycled) return;
      recycled = true;
      kernel.recycle();
    };
    const result = await regen(engine, edited);
    expect(engine.stats.retries).toBe(1);
    expect(kernel.live.has(shapeOfA)).toBe(false);
    for (const p of result.parts) expect(kernel.live.has(p.bodies[0]!.shape)).toBe(true);
    expect(result.parts.map((p) => statuses({ parts: [p] }))).toEqual([
      { 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' },
      { 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' },
    ]);
  });

  it('sends the topology of a changed body with its mesh, and neither when it is unchanged', async () => {
    const { engine } = setup();
    const doc = block();
    const first = await regen(engine, doc);
    expect(first.parts[0]!.bodies[0]!.mesh).not.toBeNull();
    expect(first.parts[0]!.bodies[0]!.topology).toEqual({ faces: [], edges: [], vertices: [] });
    const renamed = await regen(
      engine,
      apply(doc, { type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'Round' }),
    );
    expect(renamed.parts[0]!.bodies[0]).toMatchObject({
      meshChanged: false,
      mesh: null,
      topology: null,
    });
  });

  it('never caches the pass-through of a body the kernel no longer has, whatever the instance says', async () => {
    const cache = new MemoryCache();
    const kernel = new FakeKernel();
    const engine = new RegenEngine({ kernel, solver: new FakeSolver(), cache });
    const doc = block();
    await regen(engine, doc);
    // Shapes lost without a new instance number: only the kernel's own result tells.
    kernel.live.clear();
    await expect(engine.regen(apply(doc, setVariable('radius', '4mm')))).rejects.toThrow(
      /lost to a recycle/,
    );
    const entries = cache.keys().map((k) => cache.get(k)!);
    expect(entries.filter((e) => e.errors.some((x) => x.code === 'no-body'))).toEqual([]);
  });

  it('keeps a real no-body failure on a live body: it is not a lost shape', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('fillet#1', {
      errors: [{ featureId: 'fillet#1', code: 'no-body', message: 'the body is empty' }],
    });
    const doc = block();
    const first = await regen(engine, doc);
    expect(first.parts[0]!.features[2]).toMatchObject({ status: 'error', cached: false });
    expect(engine.stats.retries).toBe(0);
    const again = await regen(engine, doc);
    expect(again.parts[0]!.features[2]).toMatchObject({ status: 'error', cached: true });
  });
});

describe('sketches on faces', () => {
  it('resolves the face on the body before it and caches the solved sketch against that body', async () => {
    const { kernel, solver, engine } = setup();
    const onTop = rectangle('sketch#2', {
      width: '10',
      depth: '10',
      at: [5, 5],
      ids: ['e5', 'e6', 'e7', 'e8'],
      firstConstraint: 12,
      plane: { type: 'face', face: { id: 'r2', ref: { face: 'extrude#1:cap:end' } } },
    });
    const doc = apply(block(), add(onTop), add(extrude('extrude#2', 'sketch#2', '5', 'cut')));
    const result = await regen(engine, doc);
    expect(statuses(result)).toMatchObject({ 'sketch#2': 'ok', 'extrude#2': 'ok' });
    expect(result.parts[0]!.features[3]!.references).toEqual([
      { referenceId: 'r2', target: 'extrude#1:cap:end', via: 'exact', fragile: false },
    ]);
    // The profile sits on the resolved plane (z = 20).
    expect(kernel.inputs.get('extrude#2')).toMatchObject({
      profile: { frame: { origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] } },
    });
    expect(result.counters.otherOps).toBe(3); // resolve, tessellate, topology
    // The result carries the plane the sketch was solved on.
    expect(result.parts[0]!.features[3]!.placement).toEqual({
      origin: [0, 0, 20],
      normal: [0, 0, 1],
      xDir: [1, 0, 0],
    });
    // A change to the fillet changes the body the sketch sits on: it is solved again.
    await regen(engine, apply(doc, setVariable('radius', '4mm')));
    expect(solver.solves).toBe(3);
  });
});

describe('imports', () => {
  const bytes = new TextEncoder().encode('ISO-10303-21;\nDATA;\nENDSEC;\n');
  const source = (data: Uint8Array = bytes, sha256?: string): ImportSource => ({
    format: 'step',
    fileName: 'cube.step',
    size: data.length,
    sha256: sha256 ?? createHash('sha256').update(data).digest('hex'),
    data: Buffer.from(data).toString('base64'),
  });
  const cube = (src: ImportSource): ImportFeature => ({
    id: 'import#1',
    kind: 'import',
    name: 'cube',
    suppressed: false,
    source: src,
    operation: 'cut',
  });
  const withImport = (src: ImportSource) =>
    build([
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add(cube(src)),
    ]);

  it('checks the stored hash once per file and builds a matching one from its data', async () => {
    const { kernel, engine } = setup();
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      const doc = withImport(source());
      const first = await regen(engine, doc);
      expect(statuses(first)['import#1']).toBe('ok');
      expect(kernel.featureOps).toEqual(['extrude#1', 'import#1']);
      expect(kernel.inputs.get('import#1')).toMatchObject({
        step: source().data,
        mode: 'subtract',
      });
      expect(digest).toHaveBeenCalledTimes(1);

      // An edit elsewhere shares the source object: no second hash, and a cache hit.
      const renamed = apply(doc, {
        type: 'renameFeature',
        partId: PART,
        featureId: 'extrude#1',
        name: 'Base',
      });
      const second = await regen(engine, renamed);
      expect(second.counters.featureOps).toBe(0);
      expect(digest).toHaveBeenCalledTimes(1);
    } finally {
      digest.mockRestore();
    }
  });

  it('fails an import whose data does not match its SHA-256, without sending it to the kernel', async () => {
    const { kernel, engine } = setup();
    const other = new TextEncoder().encode('ISO-10303-21;\nDATA;\nENDSEC;\n'.toLowerCase());
    // The hash of other bytes of the same length: valid to the schema, wrong for the data.
    const damaged = source(bytes, createHash('sha256').update(other).digest('hex'));
    const r = await regen(engine, withImport(damaged));
    expect(statuses(r)).toMatchObject({ 'extrude#1': 'ok', 'import#1': 'error' });
    expect(r.parts[0]!.features[2]!.errors).toMatchObject([
      { code: 'invalid', field: ['source', 'sha256'], message: /does not match its SHA-256/ },
    ]);
    expect(kernel.featureOps).toEqual(['extrude#1']);
  });

  it('keys an import by its hash and size, not its text', () => {
    const input = { kind: 'import', id: 'import#1', step: 'QUJD', mode: 'new' } as FeatureInput;
    const src = source();
    expect(keyInput(input, src)).toEqual({
      kind: 'import',
      id: 'import#1',
      mode: 'new',
      step: { sha256: src.sha256, size: src.size },
    });
    const extrusion = { kind: 'extrude' } as FeatureInput;
    expect(keyInput(extrusion, null)).toBe(extrusion);
  });

  it('rejects data that is not the stored size or not base64', async () => {
    const src = source();
    expect(await importSourceMatches(src)).toBe(true);
    expect(await importSourceMatches({ ...src, size: src.size + 1 })).toBe(false);
    expect(await importSourceMatches({ ...src, data: '!!!!' })).toBe(false);
  });
});

/** A document of one part holding `features` (derived features need no sketch). */
const holding = (...features: DerivedFeature[]) =>
  build([setVariable('unrelated', '1'), ...features.map((f) => add(f))]);

/** Replace a feature of the part, as an edit would. */
function withFeature(doc: ManufaktureDocument, feature: DerivedFeature): ManufaktureDocument {
  const part = doc.parts[0]!;
  return {
    ...doc,
    parts: [{ ...part, features: part.features.map((f) => (f.id === feature.id ? feature : f)) }],
  };
}

describe('derived features', () => {
  it('fails on a pin whose data does not match its hash, without sending anything', async () => {
    const { kernel, engine } = setup();
    const damaged = { ...pin(block()), sha256: '0'.repeat(64) };
    const doc = apply(
      block(),
      add(derivedOf('derived#1', damaged)),
      add(
        fillet(
          'fillet#2',
          ['derived#1:from/extrude#1:cap:end', 'derived#1:from/extrude#1:side:e1'],
          '1',
          'r2',
        ),
      ),
    );
    const r = await regen(engine, doc);
    expect(statuses(r)).toMatchObject({
      'extrude#1': 'ok',
      'fillet#1': 'ok',
      'derived#1': 'error',
      'fillet#2': 'upstream-error',
    });
    expect(r.parts[0]!.features[3]!.errors).toMatchObject([
      { code: 'source', field: ['source', 'sha256'] },
    ]);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
  });

  it('two derived features of one source regenerate it once; an unrelated edit is a cache hit', async () => {
    const { kernel, solver, engine } = setup();
    const source = pin(block());
    const doc = holding(
      derivedOf('derived#1', source),
      derivedOf('derived#2', source, {
        placement: {
          translation: [mm('100'), mm('0'), mm('0')],
          rotation: [mm('0'), mm('0'), mm('90deg')],
        },
      }),
    );
    const first = await regen(engine, doc);
    expect(statuses(first)).toEqual({ 'derived#1': 'ok', 'derived#2': 'ok' });
    // The source's sketch, extrude and fillet once, then one derive per feature.
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'derived#1', 'derived#2']);
    expect(solver.solves).toBe(1);
    const one = kernel.inputs.get('derived#1') as Extract<FeatureInput, { kind: 'derive' }>;
    const two = kernel.inputs.get('derived#2') as Extract<FeatureInput, { kind: 'derive' }>;
    expect(one.sources).toEqual(two.sources);
    expect(one.sources.map((b) => b.id)).toEqual(['extrude#1']);
    expect(two).toMatchObject({ translation: [100, 0, 0], mode: 'new' });
    expect(two.rotation[2]).toBeCloseTo(Math.PI / 2, 12);
    expect(first.parts[0]!.bodies.map((b) => [b.bodyId, b.creator])).toEqual([
      ['derived#1:from/extrude#1', 'derived#1'],
      ['derived#2:from/extrude#1', 'derived#2'],
    ]);
    // The source's parts are built, not reported.
    expect(first.parts.map((p) => p.partId)).toEqual([PART]);

    const edited = await regen(engine, apply(doc, setVariable('unrelated', '2')));
    expect(edited.counters).toMatchObject({ featureOps: 0, solves: 0, cacheMisses: 0 });
    expect(edited.parts[0]!.features.every((f) => f.cached)).toBe(true);
    expect(edited.parts[0]!.bodies.map((b) => b.meshChanged)).toEqual([false, false]);

    // Updating one pin rebuilds that source, under its own namespace; the other stays cached.
    const changed = pin(apply(block(), setVariable('radius', '5mm')));
    const updated = await regen(engine, withFeature(doc, derivedOf('derived#1', changed)));
    expect(kernel.featureOps.slice(4)).toEqual(['extrude#1', 'fillet#1', 'derived#1']);
    expect(updated.parts[0]!.features.map((f) => f.cached)).toEqual([false, true]);
    expect(updated.parts[0]!.bodies.map((b) => b.meshChanged)).toEqual([true, false]);
  });

  it('reports what is wrong with a source on the feature', async () => {
    const { kernel, engine } = setup();
    const text = serialize(block());
    const newer = JSON.stringify({ ...(JSON.parse(text) as object), version: 99 });
    const cases: [DerivedSource, string[], RegExp][] = [
      [pinText('{"format":"something else"}'), ['source', 'data'], /cannot be read/],
      [pinText(newer), ['source', 'data'], /newer version of manufakture \(file format 99/],
      [pinText(text, 'part#9'), ['source', 'partId'], /has no part part#9/],
    ];
    for (const [source, field, message] of cases) {
      const r = await regen(engine, holding(derivedOf('derived#1', source)));
      expect(r.parts[0]!.features[0]).toMatchObject({
        status: 'error',
        errors: [{ code: 'source', field }],
      });
      expect(r.parts[0]!.features[0]!.errors[0]!.message).toMatch(message);
    }
    expect(kernel.featureOps).toEqual([]);

    // A body the source does not have at that version: the source is built, nothing derived.
    const lost = await regen(
      engine,
      holding(derivedOf('derived#1', pinText(text), { bodies: ['extrude#1', 'extrude#7'] })),
    );
    expect(lost.parts[0]!.features[0]!.errors).toMatchObject([
      { code: 'reference-lost', referenceId: 'bodies', missing: ['extrude#7'] },
    ]);
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1']);
  });

  it('warns when source features failed, from the kernel and from the cache alike', async () => {
    const { kernel, engine } = setup();
    kernel.behaviours.set('fillet#1', {
      errors: [{ featureId: 'fillet#1', code: 'kernel', message: 'refused' }],
    });
    const doc = holding(derivedOf('derived#1', pin(block())));
    for (const next of [doc, apply(doc, setVariable('unrelated', '3'))]) {
      const r = await regen(engine, next);
      expect(r.parts[0]!.features[0]).toMatchObject({
        status: 'ok',
        warnings: [{ code: 'derived-source', features: ['fillet#1'] }],
      });
    }
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'derived#1']);
  });

  it('carries the source body name, colour and material over unless the part sets its own', async () => {
    const { engine } = setup();
    const src = block();
    const styled: ManufaktureDocument = {
      ...src,
      parts: [
        {
          ...src.parts[0]!,
          material: 'pla',
          bodies: [{ id: 'extrude#1', name: 'Plate', color: '#ff0000' }],
        },
      ],
    };
    const doc = holding(derivedOf('derived#1', pin(styled)));
    const own: ManufaktureDocument = {
      ...doc,
      parts: [{ ...doc.parts[0]!, bodies: [{ id: 'derived#1:from/extrude#1', color: '#00ff00' }] }],
    };
    const r = await regen(engine, own);
    expect(r.parts[0]!.bodies[0]!.inherited).toEqual({ name: 'Plate', material: 'pla' });
    const plain = await regen(engine, holding(derivedOf('derived#1', pin(block()))));
    expect(plain.parts[0]!.bodies[0]!.inherited).toBeUndefined();
  });

  it('refuses a chain of sources deeper than MAX_DERIVED_DEPTH before building any of it', async () => {
    const base = build([
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
    ]);
    // chain[n] derives chain[n - 1]: regenerating it opens n levels of sources.
    const chain = [base];
    for (let n = 1; n <= MAX_DERIVED_DEPTH + 1; n++) {
      chain.push(build([add(derivedOf('derived#1', pin(chain[n - 1]!)))]));
    }
    const deep = setup();
    const refused = await regen(deep.engine, chain[MAX_DERIVED_DEPTH + 1]!);
    expect(refused.parts[0]!.features[0]).toMatchObject({
      status: 'error',
      errors: [{ code: 'source', field: ['source'] }],
    });
    expect(refused.parts[0]!.features[0]!.errors[0]!.message).toMatch(/more than 8 deep/);
    expect(deep.kernel.featureOps).toEqual([]);

    const fits = setup();
    const built = await regen(fits.engine, chain[MAX_DERIVED_DEPTH]!);
    expect(statuses(built)).toEqual({ 'derived#1': 'ok' });
    expect(fits.kernel.featureOps).toEqual([
      'extrude#1',
      ...Array.from({ length: MAX_DERIVED_DEPTH }, () => 'derived#1'),
    ]);
    // Names nest: the top body is derived from a derived body, eight levels down.
    expect(built.parts[0]!.bodies[0]!.bodyId).toBe(
      `${'derived#1:from/'.repeat(MAX_DERIVED_DEPTH)}extrude#1`,
    );
  });

  it('restarts when the kernel recycles in the middle of building a source', async () => {
    const { kernel, engine } = setup();
    let recycled = false;
    kernel.onRun = () => {
      // The batch after the source's fillet is the derive: its source shapes are now gone.
      if (!recycled && kernel.featureOps.at(-1) === 'fillet#1') {
        recycled = true;
        kernel.recycle();
      }
    };
    const r = await regen(engine, holding(derivedOf('derived#1', pin(block()))));
    expect(statuses(r)).toEqual({ 'derived#1': 'ok' });
    expect(engine.stats.retries).toBe(1);
    // The derive ran on the new instance with dead sources and was thrown away; the source is
    // rebuilt there, then derived from.
    expect(kernel.featureOps).toEqual([
      'extrude#1',
      'fillet#1',
      'derived#1',
      'extrude#1',
      'fillet#1',
      'derived#1',
    ]);
    const input = kernel.inputs.get('derived#1') as Extract<FeatureInput, { kind: 'derive' }>;
    expect(input.sources.every((b) => kernel.live.has(b.shape))).toBe(true);
    // Nothing built on the dead shapes was cached: the next regen is all hits.
    const again = await regen(
      engine,
      apply(holding(derivedOf('derived#1', pin(block()))), setVariable('unrelated', '5')),
    );
    expect(again.counters).toMatchObject({ featureOps: 0, cacheMisses: 0 });
    expect(statuses(again)).toEqual({ 'derived#1': 'ok' });
  });
});

describe('assemblies', () => {
  const connectorOps = (kernel: FakeKernel) => kernel.connectorOps.length;
  /** The block (part#1) and a second part studio with the same block; two instances. */
  function twoInstances(more: Command[] = []): ManufaktureDocument {
    let doc = apply(block(), { type: 'addPart', partId: LID, name: 'Lid' });
    for (const f of block().parts[0]!.features) doc = apply(doc, addTo(LID, f));
    return apply(
      doc,
      { type: 'addAssembly', assemblyId: ASSEMBLY, name: 'A' },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#1', { part: PART }, { fixed: true }),
      },
      { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#2', { part: LID }) },
      {
        type: 'addMate',
        assemblyId: ASSEMBLY,
        mate: mate(
          'mate#1',
          'slider',
          centroid('mc#1', 'inst#1', 'r1', 'extrude#1:cap:end'),
          centroid('mc#2', 'inst#2', 'r2', 'extrude#1:cap:start'),
          { limits: { min: mm('0'), max: mm('50') } },
        ),
      },
      ...more,
    );
  }

  it('finds connector frames once, and re-solves a pose-only change with no kernel op', async () => {
    const { kernel, engine } = setup();
    const doc = twoInstances();
    const first = await regen(engine, doc);
    expect(first.assemblies).toHaveLength(1);
    expect(first.assemblies![0]).toMatchObject({ outcome: 'solved', dof: 1 });
    expect(first.assemblies![0]!.mates[0]).toMatchObject({ status: 'ok', coordinates: [0] });
    // One op per body, each with the one connector on it.
    expect(kernel.connectorOps).toEqual([['extrude#1:cap:end'], ['extrude#1:cap:start']]);
    expect(first.sources).toEqual([]);

    // Move the slider's instance along the slider: committed poses change, nothing else.
    const lifted = apply(doc, {
      type: 'setPoses',
      assemblyId: ASSEMBLY,
      poses: { 'inst#2': { translation: [0, 0, 30], rotation: [0, 0, 0, 1] } },
    });
    const before = kernel.featureOps.length;
    const second = await regen(engine, lifted);
    expect(kernel.featureOps.length).toBe(before);
    expect(connectorOps(kernel)).toBe(2);
    const asm = second.assemblies![0]!;
    expect(asm.instances[1]!.transform.translation).toEqual([0, 0, 30]);
    expect(asm.instances[1]!.moved).toBe(false);
    expect(asm.mates[0]!.coordinates[0]).toBeCloseTo(30, 9);
  });

  it('keeps frames across a recycle: they are plain data keyed by body content', async () => {
    const { kernel, engine } = setup();
    const doc = twoInstances();
    await regen(engine, doc);
    kernel.recycle();
    const after = await regen(engine, apply(doc, setVariable('radius', '3mm')));
    expect(after.assemblies![0]!.mates[0]!.status).toBe('ok');
    expect(connectorOps(kernel)).toBe(2);
  });

  it('reports a lost connector, a limit that does not evaluate, and suppression per mate', async () => {
    const { engine } = setup();
    const doc = twoInstances([
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#3', { part: LID }),
      },
      {
        type: 'addMate',
        assemblyId: ASSEMBLY,
        mate: mate(
          'mate#2',
          'fastened',
          centroid('mc#3', 'inst#1', 'r3', 'extrude#1:side:gone'),
          centroid('mc#4', 'inst#3', 'r4', 'extrude#1:cap:start'),
        ),
      },
    ]);
    const lost = (await regen(engine, doc)).assemblies![0]!;
    expect(lost.mates[1]).toMatchObject({
      mateId: 'mate#2',
      status: 'error',
      errors: [
        {
          code: 'reference-lost',
          referenceId: 'r3',
          missing: ['extrude#1:side:gone'],
          message: expect.stringMatching(/re-pick it$/),
        },
      ],
    });
    // inst#3 is free of the lost mate: the rest still solves.
    expect(lost).toMatchObject({ outcome: 'solved', dof: 7 });

    const badLimit = apply(doc, {
      type: 'editMate',
      assemblyId: ASSEMBLY,
      mate: mate(
        'mate#1',
        'slider',
        centroid('mc#1', 'inst#1', 'r1', 'extrude#1:cap:end'),
        centroid('mc#2', 'inst#2', 'r2', 'extrude#1:cap:start'),
        { limits: { max: { source: '30deg', lengthUnit: 'mm', angleUnit: 'deg' } } },
      ),
    });
    const limited = (await regen(engine, badLimit)).assemblies![0]!;
    expect(limited.mates[0]).toMatchObject({
      status: 'error',
      errors: [{ code: 'expression', field: ['limits', 'max'] }],
    });

    const off = apply(
      doc,
      { type: 'suppressMate', assemblyId: ASSEMBLY, mateId: 'mate#1', suppressed: true },
      { type: 'editInstance', assemblyId: ASSEMBLY, instanceId: 'inst#3', suppressed: true },
    );
    const suppressed = (await regen(engine, off)).assemblies![0]!;
    expect(suppressed.mates.map((m) => m.status)).toEqual(['suppressed', 'suppressed']);
    expect(suppressed.mates[1]!.message).toMatch(/inst#3 is suppressed/);
    expect(suppressed.instances[2]).toMatchObject({ status: 'suppressed', bodies: [] });
  });

  it('finds connectors only on the bodies an instance shows, and calls a match on two bodies ambiguous', async () => {
    const { kernel, engine } = setup();
    const doc = apply(
      twoBodies(),
      { type: 'addAssembly', assemblyId: ASSEMBLY, name: 'A' },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#1', { part: PART }, { fixed: true, bodies: ['extrude#2'] }),
      },
      { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#2', { part: PART }) },
      {
        type: 'addMate',
        assemblyId: ASSEMBLY,
        mate: mate(
          'mate#1',
          'fastened',
          centroid('mc#1', 'inst#1', 'r1', 'extrude#2:cap:end'),
          centroid('mc#2', 'inst#2', 'r2', 'extrude#1:cap:start'),
        ),
      },
    );
    const first = (await regen(engine, doc)).assemblies![0]!;
    // One op per body. inst#1 hides extrude#1, so its connector is looked for on extrude#2
    // alone; inst#2 shows both bodies, and the fake kernel finds every name exactly on each:
    // that is ambiguous.
    expect(kernel.connectorOps).toEqual([
      ['extrude#2:cap:end', 'extrude#1:cap:start'],
      ['extrude#1:cap:start'],
    ]);
    expect(first.mates[0]).toMatchObject({
      status: 'error',
      errors: [
        {
          code: 'reference-ambiguous',
          referenceId: 'r2',
          candidates: ['extrude#1', 'extrude#2'],
          message: expect.stringMatching(/2 bodies .*re-pick it$/),
        },
      ],
    });
    expect(first.mates[0]!.connectors[0].reference?.via).toBe('exact');

    const narrowed = apply(doc, {
      type: 'editInstance',
      assemblyId: ASSEMBLY,
      instanceId: 'inst#2',
      bodies: ['extrude#1'],
    });
    const second = (await regen(engine, narrowed)).assemblies![0]!;
    expect(second.mates[0]).toMatchObject({ status: 'ok', errors: [] });
    expect(second.instances.map((x) => x.bodies)).toEqual([['extrude#2'], ['extrude#1']]);
  });

  it('warns when an instance shows a rolled-back part, and fails one in a row its source lacks', async () => {
    const { engine } = setup();
    const doc = apply(
      twoInstances(),
      { type: 'setRollback', partId: LID, index: 2 },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#3', { ...pin(block()), configuration: 'cfg#4' }),
      },
    );
    const result = await regen(engine, doc);
    const asm = result.assemblies![0]!;
    expect(asm.instances[1]!.warnings).toEqual([
      expect.objectContaining({ code: 'rollback', partId: LID }),
    ]);
    expect(asm.instances[1]!.bodies).toEqual(['extrude#1']);
    // A pinned part in a row its document does not have: an error naming the row.
    const pinned = asm.instances[2]!;
    expect(pinned).toMatchObject({
      status: 'error',
      errors: [{ code: 'source', field: ['source', 'configuration'] }],
    });
    expect(pinned.errors[0]!.message).toMatch(/has no configuration row cfg#4/);
    expect(result.sources).toEqual([]);
  });

  it('starts the next drag from the last regen again after a drag that was not committed', async () => {
    const { engine } = setup();
    const doc = twoInstances([
      { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#3', { part: LID }) },
    ]);
    const { generation } = await regen(engine, doc);
    // A free instance turned a quarter turn about Z by a pose target.
    const turned = {
      translation: [0, 0, 0] as const,
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const,
    };
    const first = await engine.drag(ASSEMBLY, 'inst#3', turned, { generation });
    expect(first!.transforms['inst#3']!.rotation[2]).toBeCloseTo(Math.SQRT1_2, 9);
    // Not committed: the next drag (a move only) starts from the unturned instance.
    engine.endDrag(ASSEMBLY);
    const point = { point: [0, 0, 0] as const, position: [5, 0, 0] as const };
    const next = await engine.drag(ASSEMBLY, 'inst#3', point, { generation });
    expect(next!.transforms['inst#3']!.rotation).toEqual([0, 0, 0, 1]);
    expect(next!.transforms['inst#3']!.translation[0]).toBeCloseTo(5, 9);
    // A step not started yet is dropped.
    const pending = engine.drag(ASSEMBLY, 'inst#3', turned, { generation });
    engine.endDrag(ASSEMBLY);
    expect(await pending).toBeNull();
  });

  it('coalesces drags, answers from the last regen without the kernel, and drops stale ones', async () => {
    const { kernel, engine } = setup();
    const doc = twoInstances();
    const r = await regen(engine, doc);
    const generation = r.generation;
    // Hold the kernel: a drag must not wait for it.
    let release!: () => void;
    kernel.gate = new Promise((resolve) => (release = resolve));
    const running = engine.regen(apply(doc, setVariable('radius', '4mm')));
    const at = (z: number) => ({
      translation: [0, 0, z] as const,
      rotation: [0, 0, 0, 1] as const,
    });
    // The regen above made these stale: nothing to answer.
    expect(await engine.drag(ASSEMBLY, 'inst#2', at(10), { generation })).toBeNull();
    release();
    kernel.gate = null;
    const next = (await running)!;
    const g = next.generation;
    const steps = [10, 20, 80].map((z) =>
      engine.drag(ASSEMBLY, 'inst#2', at(z), { generation: g }),
    );
    const [a, b, c] = await Promise.all(steps);
    expect(a).toBeNull();
    expect(b).toBeNull();
    // The slider stops at its 50 mm limit.
    expect(c).toMatchObject({ instanceId: 'inst#2', moved: ['inst#2'] });
    expect(c!.transforms['inst#2']!.translation[2]).toBeCloseTo(50, 9);
    expect(c!.target.reached).toBe(false);
    expect(await engine.drag('assembly#9', 'inst#2', at(1), { generation: g })).toBeNull();
  });
  it('checks interference only on demand: the prefilter, then one batch per candidate pair', async () => {
    const { kernel, engine } = setup();
    const doc = twoInstances([
      { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#3', { part: LID }) },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#4', { part: LID }, { suppressed: true }),
      },
    ]);
    const { generation } = await regen(engine, doc);
    // A regen never checks interference.
    expect(kernel.interferenceOps).toEqual([]);

    const found: string[] = [];
    const report = (await engine.interference(ASSEMBLY, {
      generation,
      onPair: (p) => void found.push(`${p.a}/${p.b}`),
    }))!;
    // The suppressed instance is left out; each instance's bodies are the regen's live shapes.
    expect(report.instances).toEqual(['inst#1', 'inst#2', 'inst#3']);
    const [pre, ...pairs] = kernel.interferenceOps;
    expect(pre!.prefilterOnly).toBe(true);
    expect(pre!.items).toHaveLength(3);
    for (const item of pre!.items) {
      expect(item.shapes).toHaveLength(1);
      expect(kernel.live.has(item.shapes[0] as number)).toBe(true);
    }
    expect(pairs.map((op) => op.pairs)).toEqual([[[0, 1]], [[0, 2]], [[1, 2]]]);
    expect(report).toMatchObject({ status: 'done', candidates: 3, booleans: 3, failures: [] });
    expect(found).toEqual(['inst#1/inst#2', 'inst#1/inst#3', 'inst#2/inst#3']);
    expect(report.pairs.every((p) => p.mesh === null)).toBe(true);

    // Where a drag in progress has an instance is where it is checked.
    const moved = { translation: [7, 0, 0] as const, rotation: [0, 0, 0, 1] as const };
    await engine.drag(ASSEMBLY, 'inst#3', moved, { generation });
    kernel.interferenceOps.length = 0;
    const dragged = (await engine.interference(ASSEMBLY, { generation }))!;
    expect(kernel.interferenceOps[0]!.items[2]!.transform!.translation[0]).toBeCloseTo(7, 9);
    expect(dragged.pairs.map((p) => p.volume)).toEqual([0, 7, 7].map((v) => expect.closeTo(v, 9)));

    // Shapes lost to a recycle: stale, check again after the next regen.
    kernel.recycle();
    expect((await engine.interference(ASSEMBLY, { generation }))!.status).toBe('stale');
    // Stale requests and unknown assemblies: nothing.
    const next = await regen(engine, apply(doc, setVariable('radius', '4mm')));
    expect(await engine.interference(ASSEMBLY, { generation })).toBeNull();
    expect(await engine.interference('assembly#9', { generation: next.generation })).toBeNull();
  });
});

describe('configuration rows of instances and derived sources', () => {
  /** The block in rows `cfg#1` (radius 3 mm, as stored) and `cfg#2` (5 mm), none active. */
  const radii = () => withRows(block(), 'radius', ['3mm', '5mm']);
  const radius = (kernel: FakeKernel) =>
    (kernel.inputs.get('fillet#1') as Extract<FeatureInput, { kind: 'fillet' }>).radius;
  const KEY = `part:${PART}:row:cfg#2`;

  function rowInstances(doc: ManufaktureDocument): ManufaktureDocument {
    return apply(
      doc,
      { type: 'addAssembly', assemblyId: ASSEMBLY, name: 'A' },
      { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#1', { part: PART }) },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#2', { part: PART, configuration: 'cfg#2' }),
      },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#3', { part: PART, configuration: 'cfg#2' }),
      },
    );
  }

  /**
   * The block with instances in rows: row A (`cfg#1`, active) sets #width and #radius, row B
   * (`cfg#2`) sets only #width, so in B the radius is the stored 3 mm.
   */
  function partialRows(): ManufaktureDocument {
    return rowInstances(
      apply(
        block(),
        {
          type: 'setConfigParameter',
          parameter: { id: 'cp#1', name: 'W', kind: 'variable', variable: 'width' },
        },
        {
          type: 'setConfigParameter',
          parameter: { id: 'cp#2', name: 'R', kind: 'variable', variable: 'radius' },
        },
        {
          type: 'setConfigRow',
          row: { id: 'cfg#1', name: 'A', values: { 'cp#1': mm('60'), 'cp#2': mm('5mm') } },
        },
        { type: 'setConfigRow', row: { id: 'cfg#2', name: 'B', values: { 'cp#1': mm('50') } } },
        { type: 'setActiveConfiguration', rowId: 'cfg#1' },
      ),
    );
  }

  it('builds a part again for instances in another row, sharing what the row leaves alone', async () => {
    const { kernel, engine } = setup();
    const doc = rowInstances(radii());
    const first = await regen(engine, doc);
    // The part, then only the fillet again at 5 mm: the sketch and extrude keys are the same.
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'fillet#1']);
    expect(radius(kernel)).toBe(5);
    const asm = first.assemblies![0]!;
    expect(asm.instances.map((x) => [x.status, x.source, x.bodies])).toEqual([
      ['ok', { part: PART }, ['extrude#1']],
      ['ok', { source: KEY }, ['extrude#1']],
      ['ok', { source: KEY }, ['extrude#1']],
    ]);
    // Reported once for both instances, with its own body key and mesh.
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]).toMatchObject({
      key: KEY,
      documentId: '',
      partId: PART,
      partName: doc.parts[0]!.name,
      row: { id: 'cfg#2', name: '5mm' },
    });
    const own = first.parts[0]!.bodies[0]!;
    const inRow = first.sources[0]!.bodies[0]!;
    expect(inRow.bodyKey).not.toBe(own.bodyKey);
    expect(inRow.meshChanged).toBe(true);

    // Nothing changed: nothing built, no mesh sent again.
    const again = await regen(engine, apply(doc, setVariable('unrelated', '1')));
    expect(again.counters).toMatchObject({ featureOps: 0, cacheMisses: 0 });
    expect(again.sources[0]!.bodies[0]!.meshChanged).toBe(false);

    // The document built in cfg#2, as the app builds it: those instances are the part itself,
    // all from the cache.
    const active = unwrap(
      configured(apply(doc, { type: 'setActiveConfiguration', rowId: 'cfg#2' })),
    );
    const switched = await regen(engine, active);
    expect(switched.counters.featureOps).toBe(0);
    expect(switched.sources).toEqual([]);
    expect(switched.assemblies![0]!.instances.map((x) => x.source)).toEqual([
      { part: PART },
      { part: PART },
      { part: PART },
    ]);
  });

  it('configures an instance in another row from the stored document, not from the active row', async () => {
    const { kernel, engine } = setup();
    const stored = partialRows();
    // As the app builds it: the document in its active row, with the stored one alongside.
    const r = (await engine.regen(unwrap(configured(stored)), { stored }))!;
    expect(r.sources.map((x) => x.key)).toEqual([KEY]);
    const inB = r.sources[0]!.bodies[0]!.bodyKey;
    // The same body as the document built in row B on its own.
    const direct = await regen(engine, unwrap(configured(stored, 'cfg#2')));
    expect(direct.parts[0]!.bodies[0]!.bodyKey).toBe(inB);
    expect(radius(kernel)).toBe(3);
    // Configured from the active-row document instead, it would inherit A's 5 mm radius.
    const inherited = (await engine.regen(unwrap(configured(stored))))!;
    expect(inherited.sources[0]!.bodies[0]!.bodyKey).not.toBe(inB);
    // A new active-row document from the same stored one builds nothing new.
    const again = (await engine.regen(unwrap(configured(stored)), { stored }))!;
    expect(again.sources[0]!.bodies[0]!.bodyKey).toBe(inB);
    expect(again.counters.featureOps).toBe(0);
  });

  it('previews a solve with the stored document alongside, as a regen does', async () => {
    const { kernel, engine } = setup();
    const stored = partialRows();
    const active = unwrap(configured(stored));
    // A regen without it: row B inherits row A's 5 mm radius (what the app must not do).
    const r = (await engine.regen(active))!;
    expect(radius(kernel)).toBe(5);
    const ops = kernel.featureOps.length;
    // The mate dialog's preview, with it: row B is built from the stored 3 mm radius.
    const preview = (await engine.solveAssembly(active, ASSEMBLY, {
      generation: r.generation,
      stored,
    }))!;
    expect(preview.instances.map((x) => x.status)).toEqual(['ok', 'ok', 'ok']);
    expect(kernel.featureOps.slice(ops)).toEqual(['fillet#1']);
    expect(radius(kernel)).toBe(3);
  });

  it('fails an instance in a row this document does not have, naming the row', async () => {
    const { engine } = setup();
    const doc = rowInstances(radii());
    // Load refuses this; regen still has to say what is wrong.
    const assembly = doc.assemblies[0]!;
    const broken: ManufaktureDocument = {
      ...doc,
      assemblies: [
        {
          ...assembly,
          instances: assembly.instances.map((x) =>
            x.id === 'inst#3' ? { ...x, source: { part: PART, configuration: 'cfg#9' } } : x,
          ),
        },
      ],
    };
    const r = await regen(engine, broken);
    const failed = r.assemblies![0]!.instances[2]!;
    expect(failed).toMatchObject({
      status: 'error',
      errors: [{ code: 'source', field: ['source', 'configuration'] }],
    });
    expect(failed.errors[0]!.message).toMatch(/no configuration row cfg#9/);
    expect(r.assemblies![0]!.instances[0]!.status).toBe('ok');
  });

  it('builds a pinned source in the row the pin names, else in its active row', async () => {
    const { kernel, engine } = setup();
    const named = await regen(
      engine,
      holding(derivedOf('derived#1', { ...pin(radii()), configuration: 'cfg#2' })),
    );
    expect(statuses(named)).toEqual({ 'derived#1': 'ok' });
    expect(kernel.featureOps).toEqual(['extrude#1', 'fillet#1', 'derived#1']);
    expect(radius(kernel)).toBe(5);

    // No row named: the row the source had active.
    const active = apply(radii(), { type: 'setActiveConfiguration', rowId: 'cfg#2' });
    await regen(engine, holding(derivedOf('derived#1', pin(active))));
    expect(radius(kernel)).toBe(5);
    // No row at all: as stored.
    await regen(engine, holding(derivedOf('derived#1', pin(radii()))));
    expect(radius(kernel)).toBe(3);

    // A row the source does not have: an error naming it, and nothing built.
    const ops = kernel.featureOps.length;
    const missing = await regen(
      engine,
      holding(derivedOf('derived#1', { ...pin(radii()), configuration: 'cfg#7' })),
    );
    expect(missing.parts[0]!.features[0]).toMatchObject({
      status: 'error',
      errors: [{ code: 'source', field: ['source', 'configuration'] }],
    });
    expect(missing.parts[0]!.features[0]!.errors[0]!.message).toMatch(
      /Source at One has no configuration row cfg#7/,
    );
    expect(kernel.featureOps.length).toBe(ops);
  });

  it('gives a pinned instance in a row a source of its own, keyed by the row', async () => {
    const { engine } = setup();
    const source = pin(radii());
    const doc = apply(
      radii(),
      { type: 'addAssembly', assemblyId: ASSEMBLY, name: 'A' },
      { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#1', source) },
      {
        type: 'addInstance',
        assemblyId: ASSEMBLY,
        instance: instance('inst#2', { ...source, configuration: 'cfg#2' }),
      },
    );
    const r = await regen(engine, doc);
    const plain = `source:${source.sha256}:${PART}`;
    expect(r.assemblies![0]!.instances.map((x) => x.source)).toEqual([
      { source: plain },
      { source: `${plain}:row:cfg#2` },
    ]);
    expect(r.sources.map((x) => [x.key, x.row])).toEqual([
      [plain, undefined],
      [`${plain}:row:cfg#2`, { id: 'cfg#2', name: '5mm' }],
    ]);
    expect(r.sources[0]!.bodies[0]!.bodyKey).not.toBe(r.sources[1]!.bodies[0]!.bodyKey);
  });
});
