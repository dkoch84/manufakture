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

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'libcascade/single/init';
import { KernelError, isFatalWasmError } from './errors';
import { collectHistory, resultMaps, type HistorySource, type ResultMaps } from './history';
import { tessellate } from './mesh';
import {
  measureShape,
  type MeasureOptions,
  type MeasureResult,
  type MeasureTarget,
} from './measure';
import { mapShapes, norm, Scope, toVec3, type Oc, type ShapeList } from './occt';
import type { Names } from './naming';
import { buildProfile } from './profile';
import { topologyOf } from './topology';
import type {
  Axis,
  ChamferEdge,
  ChamferSize,
  Deflection,
  ExtrudeResult,
  Plane,
  RevolveResult,
  SubShapeGeometry,
  SubShapeRef,
  Transform,
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
  /** Set for shapes made by `profile`: its edges and entity ids in loop and entity order. */
  profile?: { loops: TopoDS_Edge[][]; ids: (string | null)[][]; normal: Vec3 };
  /** Set for bodies made by feature operations: face and edge names, and the topology they index. */
  named?: NamedShape;
}

/** A body's names with the topology they are indexed by (plain data). */
export interface NamedShape {
  names: Names;
  topology: Topology;
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

  /** Attach names (and the topology they index) to a live shape; they go when it is released. */
  setNames(id: ShapeId, named: NamedShape): void {
    this.entry(id, 'names').named = named;
  }

  /** The names attached to a shape, or null for a shape no feature operation named. */
  named(id: ShapeId): NamedShape | null {
    return this.arena.get(id)?.named ?? null;
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
      return this.store('profile', built.face, {
        loops: built.loops,
        ids: built.ids,
        normal: built.normal,
      });
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
        const { sides, sideIds } = sweptSides(s, prism, entry.profile!, maps, false);
        const capStart = maps.face.FindIndex(s.own(prism.FirstShape()));
        const capEnd = maps.face.FindIndex(s.own(prism.LastShape()));
        if (capStart === 0 || capEnd === 0) {
          throw new Error('prism history did not resolve to result faces');
        }
        const history =
          options.history === false ? [] : collectHistory(this.oc, s, prism, [face], maps);
        return { shape: id, history, capStart, capEnd, sides, sideIds };
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

  /**
   * Revolve a profile about an axis by `angle` radians (up to 2 pi, a full
   * revolution). The axis must not cross the profile. Returns the caps (none
   * for a full revolution) and the face each entity swept; an entity lying on
   * the axis sweeps none.
   */
  revolve(
    profile: ShapeId,
    axis: Axis,
    angle: number,
    options: OperationOptions = {},
  ): RevolveResult {
    return this.op('revolve', (s) => {
      const entry = this.entry(profile, 'revolve');
      if (!entry.profile) {
        throw new KernelError('revolve', `shape ${profile} is not a profile`, {
          code: 'invalid-argument',
        });
      }
      finite('revolve', 'angle', angle);
      if (!(angle > 1e-9 && angle <= 2 * Math.PI + 1e-9)) {
        throw new KernelError('revolve', 'angle must be in (0, 2 pi]', {
          code: 'invalid-argument',
        });
      }
      const ax1 = this.ax1(s, 'revolve', axis);
      const full = angle >= 2 * Math.PI - 1e-9;
      const face = entry.shape;
      const maker = s.own(
        full
          ? new this.oc.BRepPrimAPI_MakeRevol(face, ax1, true)
          : new this.oc.BRepPrimAPI_MakeRevol(face, ax1, angle, true),
      );
      maker.Build();
      if (!maker.IsDone()) throw new Error('revolve failed');
      const result = maker.Shape();
      return this.storeWith('revolve', result, (id) => {
        const maps = resultMaps(this.oc, s, result);
        const { sides, sideIds } = sweptSides(s, maker, entry.profile!, maps, true);
        let capStart = 0;
        let capEnd = 0;
        if (!full) {
          capStart = maps.face.FindIndex(s.own(maker.FirstShape()));
          capEnd = maps.face.FindIndex(s.own(maker.LastShape()));
          if (capStart === 0 || capEnd === 0) {
            throw new Error('revolve history did not resolve to result faces');
          }
        }
        if (sides.every((l) => l.every((f) => f === 0))) {
          throw new KernelError('revolve', 'the profile sweeps no face about this axis', {
            code: 'invalid-argument',
          });
        }
        const history =
          options.history === false ? [] : collectHistory(this.oc, s, maker, [face], maps);
        return { shape: id, history, capStart, capEnd, sides, sideIds };
      });
    });
  }

  /** Chamfer edges (1-based indices), each with the face asymmetric sizes are measured on. */
  chamfer(
    shape: ShapeId,
    edges: readonly ChamferEdge[],
    size: ChamferSize,
    options: OperationOptions = {},
  ): OperationResult {
    return this.op('chamfer', (s) => {
      positive('chamfer', 'distance', size.distance);
      if (size.kind === 'distances') positive('chamfer', 'distance2', size.distance2);
      if (size.kind === 'distance-angle') {
        finite('chamfer', 'angle', size.angle);
        if (!(size.angle > 0 && size.angle < Math.PI / 2)) {
          throw new KernelError('chamfer', 'angle must be between 0 and pi/2', {
            code: 'invalid-argument',
          });
        }
      }
      if (edges.length === 0) {
        throw new KernelError('chamfer', 'no edges given', { code: 'invalid-argument' });
      }
      const input = this.get(shape, 'chamfer');
      const edgeMap = mapShapes(this.oc, s, input, 'edge');
      const faceMap = mapShapes(this.oc, s, input, 'face');
      const maker = s.own(new this.oc.BRepFilletAPI_MakeChamfer(input));
      for (const { edge: i, face: f } of edges) {
        const edge = this.subEdge(s, edgeMap, i, 'chamfer', shape);
        if (size.kind === 'distance') {
          maker.Add(size.distance, edge);
          continue;
        }
        if (f === undefined || !Number.isInteger(f) || f < 1 || f > faceMap.Extent()) {
          throw new KernelError('chamfer', `edge ${i} needs a reference face of shape ${shape}`, {
            code: 'invalid-argument',
          });
        }
        const face: TopoDS_Face = s.own(this.oc.TopoDS.Face(s.own(faceMap.FindKey(f))));
        if (size.kind === 'distances') maker.Add(size.distance, size.distance2, edge, face);
        else maker.AddDA(size.distance, size.angle, edge, face);
      }
      maker.Build();
      if (!maker.IsDone()) throw new Error('chamfer failed');
      const result = maker.Shape();
      return this.storeWith('chamfer', result, (id) => ({
        shape: id,
        history:
          options.history === false
            ? []
            : collectHistory(this.oc, s, maker, [input], resultMaps(this.oc, s, result)),
      }));
    });
  }

  /**
   * Hollow a solid: remove `faces` (1-based; at least one) and give the rest a
   * wall of `thickness`, inward, or outward with `outward`.
   */
  shell(
    shape: ShapeId,
    faces: readonly number[],
    thickness: number,
    outward = false,
    options: OperationOptions = {},
  ): OperationResult {
    return this.op('shell', (s) => {
      positive('shell', 'thickness', thickness);
      if (faces.length === 0) {
        throw new KernelError('shell', 'a shell needs at least one face to remove', {
          code: 'invalid-argument',
        });
      }
      const input = this.get(shape, 'shell');
      const faceMap = mapShapes(this.oc, s, input, 'face');
      const closing: TopoDS_Shape[] = [];
      for (const f of faces) {
        if (!Number.isInteger(f) || f < 1 || f > faceMap.Extent()) {
          throw new KernelError('shell', `shape ${shape} has no face ${f}`, {
            code: 'invalid-argument',
          });
        }
        closing.push(s.own(faceMap.FindKey(f)));
      }
      const list = s.own(new this.oc.NCollection_List_TopoDS_Shape(closing));
      const maker = s.own(new this.oc.BRepOffsetAPI_MakeThickSolid());
      maker.MakeThickSolidByJoin(
        input,
        list,
        outward ? thickness : -thickness,
        1e-6,
        this.oc.BRepOffset_Mode.BRepOffset_Skin,
        true,
        false,
        this.oc.GeomAbs_JoinType.GeomAbs_Intersection,
        false,
      );
      if (!maker.IsDone()) throw new Error('shell failed');
      const result = maker.Shape();
      return this.storeWith('shell', result, (id) => {
        if (mapShapes(this.oc, s, result, 'face').Extent() === 0) {
          throw new Error('shell made an empty shape');
        }
        return {
          shape: id,
          history:
            options.history === false
              ? []
              : collectHistory(this.oc, s, maker, [input], resultMaps(this.oc, s, result)),
        };
      });
    });
  }

  /**
   * The solid bounded by the faces of `shape` moved `distance` along their
   * outward normals (negative: inward), with sharp (intersection) joins. Every
   * result face comes from a face of the input.
   */
  offset(shape: ShapeId, distance: number, options: OperationOptions = {}): OperationResult {
    return this.op('offset', (s) => {
      finite('offset', 'distance', distance);
      if (distance === 0) {
        throw new KernelError('offset', 'distance must not be zero', { code: 'invalid-argument' });
      }
      const input = this.get(shape, 'offset');
      const maker = s.own(new this.oc.BRepOffsetAPI_MakeOffsetShape());
      maker.PerformByJoin(
        input,
        distance,
        1e-6,
        this.oc.BRepOffset_Mode.BRepOffset_Skin,
        true,
        false,
        this.oc.GeomAbs_JoinType.GeomAbs_Intersection,
        false,
      );
      if (!maker.IsDone()) throw new Error('offset failed');
      const result = maker.Shape();
      return this.storeWith('offset', result, (id) => {
        if (mapShapes(this.oc, s, result, 'face').Extent() === 0) {
          throw new Error('offset made an empty shape');
        }
        return {
          shape: id,
          history:
            options.history === false
              ? []
              : collectHistory(this.oc, s, maker, [input], resultMaps(this.oc, s, result)),
        };
      });
    });
  }

  /**
   * Tilt `faces` (1-based) by `angle` radians about their intersection with
   * the neutral plane, away from `direction` (the pull direction): a positive
   * angle makes a prism's sides taper as they go along `direction`.
   */
  draft(
    shape: ShapeId,
    faces: readonly number[],
    direction: Vec3,
    angle: number,
    neutral: Plane,
    options: OperationOptions = {},
  ): OperationResult {
    return this.op('draft', (s) => {
      finite('draft', 'angle', angle);
      if (!(Math.abs(angle) < Math.PI / 2)) {
        throw new KernelError('draft', 'angle must be within (-pi/2, pi/2)', {
          code: 'invalid-argument',
        });
      }
      vector('draft', 'direction', direction);
      const input = this.get(shape, 'draft');
      const faceMap = mapShapes(this.oc, s, input, 'face');
      const dir = this.dir(s, 'draft', 'direction', direction);
      const pln = s.own(
        new this.oc.gp_Pln(
          this.pnt(s, neutral.origin),
          this.dir(s, 'draft', 'neutral.normal', neutral.normal),
        ),
      );
      const maker = s.own(new this.oc.BRepOffsetAPI_DraftAngle(input));
      for (const f of faces) {
        if (!Number.isInteger(f) || f < 1 || f > faceMap.Extent()) {
          throw new KernelError('draft', `shape ${shape} has no face ${f}`, {
            code: 'invalid-argument',
          });
        }
        const face: TopoDS_Face = s.own(this.oc.TopoDS.Face(s.own(faceMap.FindKey(f))));
        maker.Add(face, dir, angle, pln, true);
        if (!maker.AddDone()) throw new Error(`draft cannot tilt face ${f}`);
      }
      maker.Build();
      if (!maker.IsDone()) throw new Error('draft failed');
      const result = maker.Shape();
      return this.storeWith('draft', result, (id) => ({
        shape: id,
        history:
          options.history === false
            ? []
            : collectHistory(this.oc, s, maker, [input], resultMaps(this.oc, s, result)),
      }));
    });
  }

  /** A moved (or mirrored) copy of a shape; the history maps every sub-shape to its image. */
  transform(shape: ShapeId, motion: Transform, options: OperationOptions = {}): OperationResult {
    return this.op('transform', (s) => {
      const input = this.get(shape, 'transform');
      const trsf = s.own(new this.oc.gp_Trsf());
      if (motion.kind === 'translate') {
        vector('transform', 'vector', motion.vector);
        const v = motion.vector;
        trsf.SetTranslation(s.own(new this.oc.gp_Vec(v[0], v[1], v[2])));
      } else if (motion.kind === 'rotate') {
        finite('transform', 'angle', motion.angle);
        trsf.SetRotation(this.ax1(s, 'transform', motion.axis), motion.angle);
      } else {
        vector('transform', 'plane.origin', motion.plane.origin);
        const ax2 = s.own(
          new this.oc.gp_Ax2(
            this.pnt(s, motion.plane.origin),
            this.dir(s, 'transform', 'plane.normal', motion.plane.normal),
          ),
        );
        trsf.SetMirror(ax2);
      }
      const maker = s.own(new this.oc.BRepBuilderAPI_Transform(input, trsf, true, false));
      if (!maker.IsDone()) throw new Error('transform failed');
      const result = maker.Shape();
      return this.storeWith('transform', result, (id) => ({
        shape: id,
        history:
          options.history === false
            ? []
            : collectHistory(this.oc, s, maker, [input], resultMaps(this.oc, s, result)),
      }));
    });
  }

  /**
   * Several shapes as one compound, unchanged: separate bodies of one part.
   * Every sub-shape is kept, so the history maps each operand into it.
   */
  compound(shapes: readonly ShapeId[], options: OperationOptions = {}): OperationResult {
    return this.op('compound', (s) => {
      if (shapes.length === 0) {
        throw new KernelError('compound', 'needs at least one shape', { code: 'invalid-argument' });
      }
      const inputs = shapes.map((id) => this.get(id, 'compound'));
      const builder = s.own(new this.oc.BRep_Builder());
      const result = new this.oc.TopoDS_Compound();
      builder.MakeCompound(result);
      for (const input of inputs) builder.Add(result, input);
      return this.storeWith('compound', result, (id) => {
        const oc = this.oc;
        const none: HistorySource = {
          Modified: () => new oc.NCollection_List_TopoDS_Shape(),
          Generated: () => new oc.NCollection_List_TopoDS_Shape(),
          IsDeleted: () => false,
        };
        return {
          shape: id,
          history:
            options.history === false
              ? []
              : collectHistory(oc, s, none, inputs, resultMaps(oc, s, result)),
        };
      });
    });
  }

  /** The analytic geometry of a face or edge (a line, circle, plane or axis), or null. */
  geometry(shape: ShapeId, ref: SubShapeRef): SubShapeGeometry | null {
    return this.op('geometry', (s) => {
      const oc = this.oc;
      const input = this.get(shape, 'geometry');
      if (ref.kind === 'vertex') return null;
      const map = mapShapes(oc, s, input, ref.kind);
      if (!Number.isInteger(ref.index) || ref.index < 1 || ref.index > map.Extent()) {
        throw new KernelError('geometry', `shape ${shape} has no ${ref.kind} ${ref.index}`, {
          code: 'invalid-argument',
        });
      }
      const unit = (v: Vec3): Vec3 => {
        const n = norm(v);
        return [v[0] / n, v[1] / n, v[2] / n];
      };
      const axisOf = (ax: { Location(): unknown; Direction(): unknown }) => ({
        origin: toVec3(s.own(ax.Location() as InstanceType<Oc['gp_Pnt']>)),
        direction: unit(toVec3(s.own(ax.Direction() as InstanceType<Oc['gp_Dir']>))),
      });
      if (ref.kind === 'edge') {
        const edge: TopoDS_Edge = s.own(oc.TopoDS.Edge(s.own(map.FindKey(ref.index))));
        if (oc.BRep_Tool.Degenerated(edge)) return null;
        const curve = s.own(new oc.BRepAdaptor_Curve(edge));
        const type = curve.GetType();
        if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
          const a = toVec3(s.own(curve.Value(curve.FirstParameter())));
          const b = toVec3(s.own(curve.Value(curve.LastParameter())));
          const reversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
          const d = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
          return {
            kind: 'line',
            origin: reversed ? b : a,
            direction: reversed ? [-d[0], -d[1], -d[2]] : d,
          };
        }
        if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
          return { kind: 'circle', ...axisOf(s.own(s.own(curve.Circle()).Axis())) };
        }
        return null;
      }
      const face: TopoDS_Face = s.own(oc.TopoDS.Face(s.own(map.FindKey(ref.index))));
      const adaptor = s.own(new oc.BRepAdaptor_Surface(face, true));
      const type = adaptor.GetType();
      const T = oc.GeomAbs_SurfaceType;
      if (type === T.GeomAbs_Plane) {
        const plane = s.own(adaptor.Plane());
        const d = toVec3(s.own(s.own(plane.Axis()).Direction()));
        const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        const sign = (reversed ? -1 : 1) * (plane.Direct() ? 1 : -1);
        const props = s.own(new oc.GProp_GProps());
        oc.BRepGProp.SurfaceProperties(face, props, false, false);
        return {
          kind: 'plane',
          origin: toVec3(s.own(props.CentreOfMass())),
          direction: unit([sign * d[0], sign * d[1], sign * d[2]]),
        };
      }
      if (type === T.GeomAbs_Cylinder) {
        return { kind: 'cylinder', ...axisOf(s.own(s.own(adaptor.Cylinder()).Axis())) };
      }
      if (type === T.GeomAbs_Cone) {
        return { kind: 'cone', ...axisOf(s.own(s.own(adaptor.Cone()).Axis())) };
      }
      if (type === T.GeomAbs_Sphere) {
        return { kind: 'sphere', ...axisOf(s.own(s.own(adaptor.Sphere()).Position())) };
      }
      if (type === T.GeomAbs_Torus) {
        return { kind: 'torus', ...axisOf(s.own(s.own(adaptor.Torus()).Axis())) };
      }
      return null;
    });
  }

  // Queries ------------------------------------------------------------------------

  count(shape: ShapeId, kind: SubShapeKind): number {
    return this.op('count', (s) => mapShapes(this.oc, s, this.get(shape, 'count'), kind).Extent());
  }

  /** `BRepCheck_Analyzer`'s verdict alone: cheaper than `properties` when only validity matters. */
  isValid(shape: ShapeId): boolean {
    return this.op('valid', (s) => {
      const analyzer = s.own(
        new this.oc.BRepCheck_Analyzer(this.get(shape, 'valid'), true, false, false),
      );
      return analyzer.IsValid();
    });
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

  /**
   * Exact measurements of faces, edges and vertices of a shape (by name on a
   * named body, or by index), the distance and angle between two of them,
   * and with `body` the shape's mass properties. See measure.ts.
   */
  measure(
    shape: ShapeId,
    targets: readonly MeasureTarget[],
    options: MeasureOptions = {},
  ): MeasureResult {
    return this.op('measure', (s) =>
      measureShape(this.oc, s, this.get(shape, 'measure'), this.named(shape), targets, options),
    );
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

  private pnt(s: Scope, p: Vec3) {
    return s.own(new this.oc.gp_Pnt(p[0], p[1], p[2]));
  }

  private dir(s: Scope, operation: string, name: string, d: Vec3) {
    vector(operation, name, d);
    if (!(norm(d) > 1e-12)) {
      throw new KernelError(operation, `${name} is a zero vector`, { code: 'invalid-argument' });
    }
    return s.own(new this.oc.gp_Dir(d[0], d[1], d[2]));
  }

  private ax1(s: Scope, operation: string, axis: Axis) {
    vector(operation, 'axis.origin', axis.origin);
    return s.own(
      new this.oc.gp_Ax1(
        this.pnt(s, axis.origin),
        this.dir(s, operation, 'axis.direction', axis.direction),
      ),
    );
  }

  private subEdge(
    s: Scope,
    edgeMap: ReturnType<typeof mapShapes>,
    i: number,
    operation: string,
    shape: ShapeId,
  ): TopoDS_Edge {
    if (!Number.isInteger(i) || i < 1 || i > edgeMap.Extent()) {
      throw new KernelError(operation, `shape ${shape} has no edge ${i}`, {
        code: 'invalid-argument',
      });
    }
    return s.own(this.oc.TopoDS.Edge(s.own(edgeMap.FindKey(i))));
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

/**
 * The result face each profile entity swept, per loop in entity order, and
 * by entity id. With `allowNone`, an entity that swept no face (an edge on a
 * revolve axis) gets 0; otherwise it is an error, as is an entity that swept
 * several faces.
 */
function sweptSides(
  s: Scope,
  builder: { Generated(x: TopoDS_Shape): ShapeList },
  profile: NonNullable<Entry['profile']>,
  maps: ResultMaps,
  allowNone: boolean,
): { sides: number[][]; sideIds: Record<string, number> } {
  const sides = profile.loops.map((loop, li) =>
    loop.map((edge, i) => {
      // `Generated` returns a copy of the list, owned here and drained.
      const copy = s.own(builder.Generated(edge));
      const faces: number[] = [];
      while (copy.Size() > 0) {
        const item = s.own(copy.First());
        copy.RemoveFirst();
        const f = maps.face.FindIndex(item);
        if (f > 0) faces.push(f);
      }
      if (faces.length === 0 && allowNone) return 0;
      if (faces.length !== 1) {
        throw new Error(`loop ${li} entity ${i} generated ${faces.length} faces`);
      }
      return faces[0]!;
    }),
  );
  const sideIds: Record<string, number> = {};
  profile.ids.forEach((loop, li) =>
    loop.forEach((entityId, i) => {
      const face = sides[li]![i]!;
      if (entityId !== null && face > 0) sideIds[entityId] = face;
    }),
  );
  return { sides, sideIds };
}
