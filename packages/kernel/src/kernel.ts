// The synchronous kernel (ADR 0001): a thin wrapper of our own over the raw
// libcascade bindings. It runs inside the kernel worker, next to the regen
// engine; the worker's message API (service.ts) is a coarse layer on top.
//
// - Shapes live in an arena and cross the API as integer ids. No OCCT object
//   leaves this package.
// - Every temporary OCCT object is owned by a Scope and released before
//   delete (T0.2).
// - Topology-changing operations return kinded history (ADR 0007, decision 9).
// - Every failure is a KernelError, with the decoded OCCT exception.
//
// Ported and hardened from spikes/topo-naming/src/kernel.ts and
// spikes/kernel-wrapper/src/own/kernel.ts.

import type { TopoDS_Edge, TopoDS_Shape } from 'libcascade/single/init';
import { KernelError, isFatalWasmError } from './errors';
import { collectHistory, resultMaps } from './history';
import { tessellate } from './mesh';
import { mapShapes, norm, Scope, type Oc } from './occt';
import { buildProfile } from './profile';
import { topologyOf } from './topology';
import type {
  Deflection,
  ExtrudeResult,
  MeshData,
  OperationOptions,
  OperationResult,
  ProfileLoop,
  ShapeId,
  ShapeProperties,
  ShapeRecord,
  SubShapeKind,
  Topology,
  Vec3,
  Frame,
} from './types';

export type BooleanKind = 'fuse' | 'cut' | 'common';

export interface BooleanOptions extends OperationOptions {
  /**
   * Run OCCT's SimplifyResult (unify same-domain faces and edges). Its
   * history is merged into the builder's, so merged faces show up as several
   * inputs with one result.
   */
  simplify?: boolean;
}

export interface KernelOptions {
  /** First shape id to hand out; a recycled kernel continues its predecessor's sequence. */
  firstId?: number;
  /** Record a creation stack for every shape, for leak reports. */
  debug?: boolean;
}

/** Who is creating shapes right now, stamped on every new arena entry. */
export interface KernelContext {
  featureId?: string;
  generation?: number;
}

interface Entry {
  shape: TopoDS_Shape;
  record: ShapeRecord;
  /** Set for shapes made by `profile`: its edges in loop and entity order. */
  profile?: { loops: TopoDS_Edge[][]; normal: Vec3 };
}

export const DEFAULT_DEFLECTION: Deflection = { linear: 0.1, angular: 0.5 };

function finite(operation: string, name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KernelError(operation, `${name} must be a finite number`, {
      code: 'invalid-argument',
    });
  }
}

function positive(operation: string, name: string, value: number): void {
  finite(operation, name, value);
  if (!(value > 0)) {
    throw new KernelError(operation, `${name} must be positive`, { code: 'invalid-argument' });
  }
}

function vector(operation: string, name: string, v: Vec3): void {
  v.forEach((c, i) => finite(operation, `${name}[${i}]`, c));
}

export class Kernel {
  readonly oc: Oc;
  private readonly arena = new Map<number, Entry>();
  private nextShapeId: number;
  private debug: boolean;
  private context: KernelContext = {};
  private lost: string | null = null;

  constructor(oc: Oc, options: KernelOptions = {}) {
    this.oc = oc;
    this.nextShapeId = options.firstId ?? 1;
    this.debug = options.debug ?? false;
  }

  // Lifetime and health ---------------------------------------------------------

  /** Live shapes in the arena. */
  get shapeCount(): number {
    return this.arena.size;
  }

  /** The id the next new shape will get. */
  get nextId(): number {
    return this.nextShapeId;
  }

  /** Why the kernel is unusable (a wasm trap, or it was abandoned), or null. */
  get lostReason(): string | null {
    return this.lost;
  }

  has(id: ShapeId): boolean {
    return this.arena.has(id);
  }

  /** Current size of the wasm linear memory. It only ever grows (ADR 0002). */
  heapBytes(): number {
    return this.oc.wasmMemory.buffer.byteLength;
  }

  /** Record a creation stack for shapes created from now on. */
  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  /** Stamp shapes created from now on with a feature id and generation. */
  setContext(context: KernelContext): void {
    this.context = context;
  }

  /** Release a shape. Returns false when the id was not live. */
  release(id: ShapeId): boolean {
    const entry = this.arena.get(id);
    if (!entry) return false;
    this.arena.delete(id);
    if (this.lost !== null) return true;
    const s = new Scope(this.oc);
    // Clear before delete (T0.2): Nullify drops the B-rep.
    s.own(entry.shape);
    for (const loop of entry.profile?.loops ?? []) for (const e of loop) s.own(e);
    s.dispose();
    return true;
  }

  /** A mark for `releaseSince`: every shape created after it has an id at least this big. */
  checkpoint(): number {
    return this.nextShapeId;
  }

  /** Release every live shape created since `mark`. Returns how many were released. */
  releaseSince(mark: number): number {
    let count = 0;
    for (const id of [...this.arena.keys()]) {
      if (id >= mark && this.release(id as ShapeId)) count++;
    }
    return count;
  }

  /** Every live shape with where it came from, oldest first. */
  liveShapes(): ShapeRecord[] {
    return [...this.arena.values()].map((e) => ({ ...e.record }));
  }

  /**
   * Forget every shape without touching the wasm instance, which may be
   * poisoned or about to be dropped. The kernel is unusable afterwards.
   */
  abandon(reason: string): number {
    const count = this.arena.size;
    this.arena.clear();
    this.lost ??= reason;
    return count;
  }

  // Construction ------------------------------------------------------------------

  box(dx: number, dy: number, dz: number, at: Vec3 = [0, 0, 0]): ShapeId {
    return this.op('box', (s) => {
      positive('box', 'dx', dx);
      positive('box', 'dy', dy);
      positive('box', 'dz', dz);
      vector('box', 'at', at);
      const corner = s.own(new this.oc.gp_Pnt(at[0], at[1], at[2]));
      const maker = s.own(new this.oc.BRepPrimAPI_MakeBox(corner, dx, dy, dz));
      maker.Build();
      if (!maker.IsDone()) throw new Error('box failed');
      return this.store('box', maker.Shape());
    });
  }

  cylinder(radius: number, height: number, at: Vec3 = [0, 0, 0], axis: Vec3 = [0, 0, 1]): ShapeId {
    return this.op('cylinder', (s) => {
      positive('cylinder', 'radius', radius);
      positive('cylinder', 'height', height);
      vector('cylinder', 'at', at);
      vector('cylinder', 'axis', axis);
      if (!(norm(axis) > 1e-12)) {
        throw new KernelError('cylinder', 'axis is a zero vector', { code: 'invalid-argument' });
      }
      const origin = s.own(new this.oc.gp_Pnt(at[0], at[1], at[2]));
      const dir = s.own(new this.oc.gp_Dir(axis[0], axis[1], axis[2]));
      const ax2 = s.own(new this.oc.gp_Ax2(origin, dir));
      const maker = s.own(new this.oc.BRepPrimAPI_MakeCylinder(ax2, radius, height));
      maker.Build();
      if (!maker.IsDone()) throw new Error('cylinder failed');
      return this.store('cylinder', maker.Shape());
    });
  }

  /** A planar face from solved sketch loops: the first is the outer boundary, the rest holes. */
  profile(frame: Frame, loops: readonly ProfileLoop[]): ShapeId {
    return this.op('profile', (s) => {
      vector('profile', 'frame.origin', frame.origin);
      vector('profile', 'frame.xDir', frame.xDir);
      vector('profile', 'frame.normal', frame.normal);
      const built = buildProfile(this.oc, s, frame, loops);
      return this.store('profile', built.face, { loops: built.loops, normal: built.normal });
    });
  }

  /**
   * Extrude a profile by `distance` along its normal (negative goes the other
   * way), or along a vector. Returns the caps and, per loop, the side face each
   * entity generated.
   */
  extrude(
    profile: ShapeId,
    distance: number | Vec3,
    options: OperationOptions = {},
  ): ExtrudeResult {
    return this.op('extrude', (s) => {
      const entry = this.entry(profile, 'extrude');
      if (!entry.profile) {
        throw new KernelError('extrude', `shape ${profile} is not a profile`, {
          code: 'invalid-argument',
        });
      }
      const n = entry.profile.normal;
      let v: Vec3;
      if (typeof distance === 'number') {
        finite('extrude', 'distance', distance);
        v = [n[0] * distance, n[1] * distance, n[2] * distance];
      } else {
        vector('extrude', 'distance', distance);
        v = distance;
      }
      if (!(norm(v) > 1e-9)) {
        throw new KernelError('extrude', 'zero-length extrusion', { code: 'invalid-argument' });
      }
      const face = entry.shape;
      const vec = s.own(new this.oc.gp_Vec(v[0], v[1], v[2]));
      const prism = s.own(new this.oc.BRepPrimAPI_MakePrism(face, vec, false, true));
      prism.Build();
      if (!prism.IsDone()) throw new Error('prism failed');
      const result = prism.Shape();
      return this.storeWith('extrude', result, (id) => {
        const maps = resultMaps(this.oc, s, result);
        const sides = entry.profile!.loops.map((loop, li) =>
          loop.map((edge, i) => {
            const generated = s.own(prism.Generated(edge));
            if (generated.Size() !== 1) {
              throw new Error(`loop ${li} entity ${i} generated ${generated.Size()} faces`);
            }
            return maps.face.FindIndex(s.own(generated.First()));
          }),
        );
        const capStart = maps.face.FindIndex(s.own(prism.FirstShape()));
        const capEnd = maps.face.FindIndex(s.own(prism.LastShape()));
        if (capStart === 0 || capEnd === 0 || sides.some((l) => l.includes(0))) {
          throw new Error('prism history did not resolve to result faces');
        }
        const history =
          options.history === false ? [] : collectHistory(this.oc, s, prism, [face], maps);
        return { shape: id, history, capStart, capEnd, sides };
      });
    });
  }

  // Modelling with history -----------------------------------------------------------

  boolean(
    kind: BooleanKind,
    shape: ShapeId,
    tools: readonly ShapeId[],
    options: BooleanOptions = {},
  ): OperationResult {
    return this.op(kind, (s) => {
      if (tools.length === 0) {
        throw new KernelError(kind, 'needs at least one tool', { code: 'invalid-argument' });
      }
      const a = this.get(shape, kind);
      const bs = tools.map((t) => this.get(t, kind));
      const oc = this.oc;
      const builder = s.own(
        kind === 'cut'
          ? new oc.BRepAlgoAPI_Cut()
          : kind === 'fuse'
            ? new oc.BRepAlgoAPI_Fuse()
            : new oc.BRepAlgoAPI_Common(),
      );
      const args = s.own(new oc.NCollection_List_TopoDS_Shape([a]));
      const toolList = s.own(new oc.NCollection_List_TopoDS_Shape(bs));
      builder.SetArguments(args);
      builder.SetTools(toolList);
      builder.Build();
      if (!builder.IsDone() || builder.HasErrors()) throw new Error(`${kind} failed`);
      if (options.simplify) builder.SimplifyResult(true, true);
      const result = builder.Shape();
      return this.storeWith(kind, result, (id) => ({
        shape: id,
        history:
          options.history === false
            ? []
            : collectHistory(oc, s, builder, [a, ...bs], resultMaps(oc, s, result)),
      }));
    });
  }

  /** Fillet edges given as 1-based indices into the shape's edge map. */
  fillet(
    shape: ShapeId,
    edges: readonly number[],
    radius: number,
    options: OperationOptions = {},
  ): OperationResult {
    return this.op('fillet', (s) => {
      positive('fillet', 'radius', radius);
      if (edges.length === 0) {
        throw new KernelError('fillet', 'no edges given', { code: 'invalid-argument' });
      }
      const input = this.get(shape, 'fillet');
      const edgeMap = mapShapes(this.oc, s, input, 'edge');
      const maker = s.own(new this.oc.BRepFilletAPI_MakeFillet(input));
      for (const i of edges) {
        if (!Number.isInteger(i) || i < 1 || i > edgeMap.Extent()) {
          throw new KernelError('fillet', `shape ${shape} has no edge ${i}`, {
            code: 'invalid-argument',
          });
        }
        const edge: TopoDS_Edge = s.own(this.oc.TopoDS.Edge(s.own(edgeMap.FindKey(i))));
        maker.Add(radius, edge);
      }
      maker.Build();
      if (!maker.IsDone()) {
        const faulty = maker.NbFaultyContours();
        throw new Error(`fillet failed (${faulty} faulty contour${faulty === 1 ? '' : 's'})`);
      }
      const result = maker.Shape();
      return this.storeWith('fillet', result, (id) => ({
        shape: id,
        history:
          options.history === false
            ? []
            : collectHistory(this.oc, s, maker, [input], resultMaps(this.oc, s, result)),
      }));
    });
  }

  // Queries ------------------------------------------------------------------------

  count(shape: ShapeId, kind: SubShapeKind): number {
    return this.op('count', (s) => mapShapes(this.oc, s, this.get(shape, 'count'), kind).Extent());
  }

  topology(shape: ShapeId): Topology {
    return this.op('topology', (s) => topologyOf(this.oc, s, this.get(shape, 'topology')));
  }

  properties(shape: ShapeId): ShapeProperties {
    return this.op('properties', (s) => {
      const oc = this.oc;
      const body = this.get(shape, 'properties');
      const vprops = s.own(new oc.GProp_GProps());
      oc.BRepGProp.VolumeProperties(body, vprops, false, false, false);
      const sprops = s.own(new oc.GProp_GProps());
      oc.BRepGProp.SurfaceProperties(body, sprops, false, false);
      const box = s.own(new oc.Bnd_Box());
      oc.BRepBndLib.Add(body, box, false);
      let boundingBox: ShapeProperties['boundingBox'] = null;
      if (!box.IsVoid()) {
        const min = s.own(box.CornerMin());
        const max = s.own(box.CornerMax());
        // Bnd_Box is enlarged by the shape's tolerance; report it as OCCT gives it.
        boundingBox = { min: [min.X(), min.Y(), min.Z()], max: [max.X(), max.Y(), max.Z()] };
      }
      const analyzer = s.own(new oc.BRepCheck_Analyzer(body, true, false, false));
      return {
        volume: vprops.Mass(),
        area: sprops.Mass(),
        boundingBox,
        valid: analyzer.IsValid(),
        faces: mapShapes(oc, s, body, 'face').Extent(),
        edges: mapShapes(oc, s, body, 'edge').Extent(),
        vertices: mapShapes(oc, s, body, 'vertex').Extent(),
      };
    });
  }

  /** Tessellate: triangles per face and polylines per edge, in face-map and edge-map order. */
  mesh(shape: ShapeId, deflection: Deflection = DEFAULT_DEFLECTION): MeshData {
    return this.op('tessellate', (s) => {
      positive('tessellate', 'deflection.linear', deflection.linear);
      positive('tessellate', 'deflection.angular', deflection.angular);
      return tessellate(this.oc, s, this.get(shape, 'tessellate'), deflection);
    });
  }

  // Internals ---------------------------------------------------------------------

  private op<T>(name: string, fn: (s: Scope) => T): T {
    if (this.lost !== null) {
      throw new KernelError(name, `the kernel instance is gone (${this.lost})`, { code: 'fatal' });
    }
    const s = new Scope(this.oc);
    let result: T;
    try {
      result = fn(s);
    } catch (error) {
      // Decode first: a trap marks the kernel lost, and then nothing more is
      // released into the dead instance.
      const failure = this.toError(name, error);
      try {
        if (this.lost === null) s.dispose();
      } catch {
        // A failure while cleaning up must not hide the operation's own.
      }
      throw failure;
    }
    try {
      s.dispose();
    } catch (error) {
      throw this.toError(name, error);
    }
    return result;
  }

  private toError(operation: string, error: unknown): KernelError {
    if (error instanceof KernelError) return error;
    if (typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception) {
      try {
        const [type, message] = this.oc.getExceptionMessage(error);
        return new KernelError(operation, `OCCT ${type}: ${message}`, {
          occtType: type,
          occtMessage: message,
        });
      } catch {
        return new KernelError(operation, 'OCCT exception that could not be decoded');
      } finally {
        try {
          this.oc.decrementExceptionRefcount(error);
        } catch {
          // Nothing more can be done about it.
        }
      }
    }
    if (isFatalWasmError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      this.lost = `wasm trap in ${operation}: ${message}`;
      return new KernelError(operation, `wasm trap: ${message}`, { code: 'fatal' });
    }
    return new KernelError(operation, error instanceof Error ? error.message : String(error));
  }

  /** The arena entry of `id`; `operation` is the op asking, for the error. */
  private entry(id: ShapeId, operation: string): Entry {
    const entry = this.arena.get(id);
    if (!entry) {
      throw new KernelError(operation, `unknown shape id ${id}`, { code: 'unknown-shape' });
    }
    return entry;
  }

  private get(id: ShapeId, operation: string): TopoDS_Shape {
    return this.entry(id, operation).shape;
  }

  /**
   * Move `shape` into the arena. It must be a handle nobody else deletes: the
   * value a builder's `Shape()` returns, which embind hands out as a copy.
   */
  private store(operation: string, shape: TopoDS_Shape, profile?: Entry['profile']): ShapeId {
    const id = this.nextShapeId++ as ShapeId;
    const record: ShapeRecord = { id, operation, createdAt: performance.now() };
    if (this.context.featureId !== undefined) record.featureId = this.context.featureId;
    if (this.context.generation !== undefined) record.generation = this.context.generation;
    if (this.debug) record.stack = new Error('shape created').stack ?? '';
    const entry: Entry = { shape, record };
    if (profile) entry.profile = profile;
    this.arena.set(id, entry);
    return id;
  }

  /** Store `shape`, then run `fn`; if `fn` throws, the shape is released again. */
  private storeWith<T>(operation: string, shape: TopoDS_Shape, fn: (id: ShapeId) => T): T {
    const id = this.store(operation, shape);
    try {
      return fn(id);
    } catch (error) {
      // `error` may be a trap that `op` has not decoded yet, so the instance
      // can be dead already: a failing release must not hide the real error.
      try {
        if (this.lost === null && !isFatalWasmError(error)) this.release(id);
      } catch {
        // Dropped below; the instance is recycled if it is broken.
      } finally {
        this.arena.delete(id);
      }
      throw error;
    }
  }
}
