// Test-only: a scripted kernel and solver for engine tests (engine.test.ts, extensions.test.ts).
// The kernel makes numbered shapes, fails features on request and supports cancellation; the
// solver returns the stored coordinates. Not exported from the package.

import type {
  MeasureResult,
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
  OrientedBox,
  ShapeId,
} from '@manufakture/kernel';
import type { SketchInput, SolveResult } from '@manufakture/sketch';
import { expect } from 'vitest';
import type { RegenKernel } from './engine';
import type { RegenSolver } from './sketches';

export interface Behaviour {
  errors?: FeatureError[];
  warnings?: FeatureWarning[];
  /** The bodies (of those read) the feature changes; default every one. */
  touch?: string[];
  /** Fuse the touched bodies into the first of them. */
  merge?: boolean;
}

/** A kernel that makes numbered shapes, fails features on request and supports cancellation. */
export class FakeKernel implements RegenKernel {
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
  readonly measureOps: Extract<KernelOp, { op: 'measure' }>[] = [];
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
        // A name with `gone` in it is lost.
        const lost = op.refs
          .flatMap((r) => ('face' in r ? [r.face] : r.faces))
          .filter((n) => n.includes('gone'));
        if (lost.length > 0) {
          return {
            ok: true,
            op: 'resolve',
            value: { results: [{ ok: false, status: 'lost', missing: lost }] },
            ms: 0,
          };
        }
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
      case 'obb': {
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        // Every body is a 40 x 30 x 20 box at the origin.
        const value: OrientedBox = {
          center: [20, 15, 10],
          axes: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          halfSizes: [20, 15, 10],
          sizes: [40, 30, 20],
          source: 'aabb',
        };
        return { ok: true, op: 'obb', value, ms: 0 };
      }
      case 'measure': {
        this.measureOps.push(op);
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        // Every body is the 40 x 30 x 20 box `obb` gives, measured whole when asked.
        const w = 40;
        const d = 30;
        const h = 20;
        const v = w * d * h;
        const value: MeasureResult = {
          items: [],
          distance: null,
          angle: null,
          body: op.body
            ? {
                volume: v,
                area: 2 * (w * d + w * h + d * h),
                centerOfMass: [20, 15, 10],
                volumeInertia: [
                  [(v * (d * d + h * h)) / 12, 0, 0],
                  [0, (v * (w * w + h * h)) / 12, 0],
                  [0, 0, (v * (w * w + d * d)) / 12],
                ],
                boundingBox: { min: [0, 0, 0], max: [w, d, h] },
              }
            : null,
        };
        return { ok: true, op: 'measure', value, ms: 0 };
      }
      case 'holeWalls': {
        const body = this.#shape(op.shape, results);
        if (body !== null && typeof body === 'object') return body.fail;
        // No geometry to cast rays through: no wall is measured.
        return { ok: true, op: 'holeWalls', value: { walls: [] }, ms: 0 };
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
export class FakeSolver implements RegenSolver {
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
