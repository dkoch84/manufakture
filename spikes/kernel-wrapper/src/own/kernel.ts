// Sketch of a thin wrapper of our own over the raw libcascade bindings: the
// shape of the API `packages/kernel` would expose, not a complete kernel.
//
// Design, borrowing from both candidates:
// - Shapes live in an arena and cross the API as plain integer ids (occt-wasm's
//   idea). No embind object ever leaves this module, so callers cannot leak
//   one, and the implementation can move into C++ helpers later without an API
//   change.
// - Every temporary OCCT object is owned by a Scope and released before it is
//   deleted, the T0.2 mitigation for libcascade's empty destructors.
// - Operations that change topology return a History built from OCCT's own
//   Modified / Generated / IsDeleted, with sub-shapes named by their index in
//   TopExp.MapShapes order of the input and the result (for T0.5).
// - Failures are thrown as KernelError with the decoded OCCT exception.

import type {
  OpenCascadeInstance,
  TopAbs_ShapeEnum,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  gp_Trsf,
} from 'libcascade/single/init';

export type Oc = OpenCascadeInstance;

declare const shapeIdBrand: unique symbol;
/** A shape in the kernel's arena. Only valid on the kernel that returned it. */
export type ShapeId = number & { readonly [shapeIdBrand]: true };

export type SubShapeKind = 'face' | 'edge' | 'vertex';

/** A sub-shape of a given shape, by 1-based index in TopExp.MapShapes order. */
export interface SubShapeRef {
  kind: SubShapeKind;
  index: number;
}

/**
 * What an operation did to each sub-shape of its inputs. `operand` is the
 * position of the input in the call (0 = the shape, 1 = the tool). Output
 * indices are result face indices.
 */
export interface HistoryEntry {
  operand: number;
  input: SubShapeRef;
  /** Faces of the result this input became (OCCT Modified). */
  modified: number[];
  /** Faces of the result this input gave rise to (OCCT Generated). */
  generated: number[];
  deleted: boolean;
  /** Result face index when the face passed through untouched, else 0. */
  kept: number;
}

export interface OperationResult {
  shape: ShapeId;
  /** Empty unless requested with `{ history: true }`. */
  history: HistoryEntry[];
}

export interface OperationOptions {
  /** Collect the sub-shape history of the operation. */
  history?: boolean;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per B-rep face (result face order): [firstIndex, indexCount]. */
  faceRanges: Uint32Array;
}

export class KernelError extends Error {
  readonly operation: string;
  constructor(operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'KernelError';
    this.operation = operation;
  }
}

interface Deletable {
  delete(): void;
}

type Releasable = Deletable & Record<string, unknown>;

/**
 * Release what an object owns without relying on its destructor (libcascade
 * 3.0.x registers an empty destructor for 2102 classes; see T0.2).
 */
function release(oc: Oc, item: Deletable): void {
  const o = item as Releasable;
  const name = (o.constructor as { name?: string }).name ?? '';
  if (name.startsWith('TopoDS_')) {
    (o.Nullify as () => void).call(o);
  } else if (name === 'TopLoc_Location') {
    (o.Clear as () => void).call(o);
  } else if (name.startsWith('BRepAlgoAPI_')) {
    (o.Clear as () => void).call(o);
    const empty = new oc.NCollection_List_TopoDS_Shape();
    try {
      (o.SetArguments as (l: unknown) => void).call(o, empty);
      if (typeof o.SetTools === 'function') (o.SetTools as (l: unknown) => void).call(o, empty);
    } finally {
      empty.delete();
    }
  } else if (name === 'BRepFilletAPI_MakeFillet') {
    (o.Reset as () => void).call(o);
  }
}

/** Owns embind objects and releases them in reverse order. */
export class Scope {
  private readonly items: Deletable[] = [];
  private readonly oc: Oc;
  constructor(oc: Oc) {
    this.oc = oc;
  }
  own<T extends Deletable>(item: T): T {
    this.items.push(item);
    return item;
  }
  free(item: Deletable): void {
    try {
      release(this.oc, item);
    } finally {
      item.delete();
    }
  }
  dispose(): void {
    let first: unknown = null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.free(this.items[i]!);
      } catch (error) {
        first ??= error;
      }
    }
    this.items.length = 0;
    if (first !== null) throw first;
  }
}

type IndexedMap = InstanceType<Oc['NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher']>;

export class OwnKernel {
  readonly oc: Oc;
  private readonly arena = new Map<number, TopoDS_Shape>();
  private nextId = 1;

  constructor(oc: Oc) {
    this.oc = oc;
  }

  // Lifetime ------------------------------------------------------------------

  /** Number of live shapes in the arena. */
  get shapeCount(): number {
    return this.arena.size;
  }

  release(id: ShapeId): void {
    const shape = this.arena.get(id);
    if (!shape) return;
    this.arena.delete(id);
    shape.Nullify();
    shape.delete();
  }

  /** The next id to be handed out; pass it to releaseSince to free everything after it. */
  checkpoint(): number {
    return this.nextId;
  }

  releaseSince(mark: number): void {
    for (const id of [...this.arena.keys()]) if (id >= mark) this.release(id as ShapeId);
  }

  // Construction ----------------------------------------------------------------

  box(dx: number, dy: number, dz: number): ShapeId {
    return this.op('box', (s) => {
      const maker = s.own(new this.oc.BRepPrimAPI_MakeBox(dx, dy, dz));
      return this.store(maker.Shape());
    });
  }

  cylinder(
    radius: number,
    height: number,
    at: readonly [number, number, number],
    axis: readonly [number, number, number],
  ): ShapeId {
    return this.op('cylinder', (s) => {
      const origin = s.own(new this.oc.gp_Pnt(at[0], at[1], at[2]));
      const dir = s.own(new this.oc.gp_Dir(axis[0], axis[1], axis[2]));
      const ax2 = s.own(new this.oc.gp_Ax2(origin, dir));
      const maker = s.own(new this.oc.BRepPrimAPI_MakeCylinder(ax2, radius, height));
      return this.store(maker.Shape());
    });
  }

  /** A closed polyline in the XY plane, made into a face and extruded along +Z. */
  extrudePolyline(points: ReadonlyArray<readonly [number, number]>, height: number): ShapeId {
    return this.op('extrudePolyline', (s) => {
      const poly = s.own(new this.oc.BRepBuilderAPI_MakePolygon());
      for (const [x, y] of points) {
        const p = new this.oc.gp_Pnt(x, y, 0);
        try {
          poly.Add(p);
        } finally {
          s.free(p);
        }
      }
      poly.Close();
      if (!poly.IsDone()) throw new Error('polygon failed');
      const wire = s.own(poly.Wire());
      const faceMaker = s.own(new this.oc.BRepBuilderAPI_MakeFace(wire, true));
      if (!faceMaker.IsDone()) throw new Error('face failed');
      const face = s.own(faceMaker.Face());
      const vec = s.own(new this.oc.gp_Vec(0, 0, height));
      const prism = s.own(new this.oc.BRepPrimAPI_MakePrism(face, vec, false, true));
      return this.store(prism.Shape());
    });
  }

  // Operations with history -------------------------------------------------------

  cut(shape: ShapeId, tool: ShapeId, options: OperationOptions = {}): OperationResult {
    return this.op('cut', (s) => {
      const a = this.get(shape);
      const b = this.get(tool);
      const builder = s.own(new this.oc.BRepAlgoAPI_Cut(a, b));
      if (!builder.IsDone() || builder.HasErrors()) throw new Error('boolean failed');
      const result = builder.Shape();
      return this.storeWith(result, (id) => ({
        shape: id,
        history: options.history
          ? collectHistory(this.oc, s, builder, [a, b], result, ['face'])
          : [],
      }));
    });
  }

  /** Fillet the given edges (1-based indices into the shape's edge map), or all. */
  fillet(
    shape: ShapeId,
    radius: number,
    edges?: number[],
    options: OperationOptions = {},
  ): OperationResult {
    return this.op('fillet', (s) => {
      const input = this.get(shape);
      const edgeMap = this.map(s, input, 'edge');
      const maker = s.own(new this.oc.BRepFilletAPI_MakeFillet(input));
      const indices = edges ?? Array.from({ length: edgeMap.Extent() }, (_, i) => i + 1);
      for (const i of indices) {
        const key = s.own(edgeMap.FindKey(i));
        const edge: TopoDS_Edge = s.own(this.oc.TopoDS.Edge(key));
        maker.Add(radius, edge);
      }
      maker.Build();
      if (!maker.IsDone()) throw new Error('fillet failed');
      const result = maker.Shape();
      return this.storeWith(result, (id) => ({
        shape: id,
        history: options.history
          ? collectHistory(this.oc, s, maker, [input], result, ['face', 'edge', 'vertex'])
          : [],
      }));
    });
  }

  // Queries -----------------------------------------------------------------------

  volume(shape: ShapeId): number {
    return this.op('volume', (s) => {
      const props = s.own(new this.oc.GProp_GProps());
      this.oc.BRepGProp.VolumeProperties(this.get(shape), props, false, false, false);
      return props.Mass();
    });
  }

  count(shape: ShapeId, kind: SubShapeKind): number {
    return this.op('count', (s) => this.map(s, this.get(shape), kind).Extent());
  }

  /**
   * Mesh the shape and copy the triangulation out, per face in face-map order.
   * With the stock bindings this costs several embind calls per node and
   * triangle (T0.2); a C++ helper would do it in one call.
   */
  mesh(shape: ShapeId, linear: number, angular: number): MeshData {
    return this.op('mesh', (s) => {
      const body = this.get(shape);
      const mesher = s.own(
        new this.oc.BRepMesh_IncrementalMesh(body, linear, false, angular, false),
      );
      if (!mesher.IsDone()) throw new Error('meshing failed');
      const faces = this.map(s, body, 'face');
      const chunks: Array<{ positions: number[]; normals: number[]; indices: number[] }> = [];
      for (let i = 1; i <= faces.Extent(); i++) {
        const fs = new Scope(this.oc);
        try {
          const key = fs.own(faces.FindKey(i));
          chunks.push(this.extractFace(fs, fs.own(this.oc.TopoDS.Face(key))));
        } finally {
          fs.dispose();
        }
      }
      this.oc.BRepTools.Clean(body, true);
      return pack(chunks);
    });
  }

  // Internals ---------------------------------------------------------------------

  private op<T>(name: string, fn: (s: Scope) => T): T {
    const s = new Scope(this.oc);
    try {
      return fn(s);
    } catch (error) {
      throw this.toError(name, error);
    } finally {
      s.dispose();
    }
  }

  private toError(operation: string, error: unknown): Error {
    if (error instanceof KernelError) return error;
    if (typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception) {
      try {
        const [type, message] = this.oc.getExceptionMessage(error);
        return new KernelError(operation, `OCCT ${type}: ${message}`);
      } finally {
        this.oc.decrementExceptionRefcount(error);
      }
    }
    return new KernelError(operation, error instanceof Error ? error.message : String(error));
  }

  private get(id: ShapeId): TopoDS_Shape {
    const shape = this.arena.get(id);
    if (!shape) throw new KernelError('get', `unknown shape id ${id}`);
    return shape;
  }

  /**
   * Move `shape` into the arena. It must be a handle nobody else deletes: the
   * value returned by a builder's Shape(), which embind returns as a copy.
   */
  private store(shape: TopoDS_Shape): ShapeId {
    const id = this.nextId++ as ShapeId;
    this.arena.set(id, shape);
    return id;
  }

  /** Store `shape`, then run `fn`; if `fn` throws, the shape is released again. */
  private storeWith<T>(shape: TopoDS_Shape, fn: (id: ShapeId) => T): T {
    const id = this.store(shape);
    try {
      return fn(id);
    } catch (error) {
      this.release(id);
      throw error;
    }
  }

  private map(s: Scope, shape: TopoDS_Shape, kind: SubShapeKind): IndexedMap {
    return mapShapes(this.oc, s, shape, kind);
  }

  private extractFace(s: Scope, face: TopoDS_Face) {
    const oc = this.oc;
    const loc = s.own(new oc.TopLoc_Location());
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (tri === null) return { positions: [], normals: [], indices: [] };
    s.own(tri);
    if (!tri.HasNormals()) oc.BRepLib_ToolTriangulatedShape.ComputeNormals(face, tri);
    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const trsf: gp_Trsf | null = loc.IsIdentity() ? null : s.own(loc.Transformation());
    const sign = reversed ? -1 : 1;
    const nbNodes = tri.NbNodes();
    const positions = new Array<number>(nbNodes * 3);
    const normals = new Array<number>(nbNodes * 3);
    for (let i = 1; i <= nbNodes; i++) {
      const p = tri.Node(i);
      const n = tri.Normal(i);
      try {
        if (trsf) {
          p.Transform(trsf);
          n.Transform(trsf);
        }
        const o = (i - 1) * 3;
        positions[o] = p.X();
        positions[o + 1] = p.Y();
        positions[o + 2] = p.Z();
        normals[o] = sign * n.X();
        normals[o + 1] = sign * n.Y();
        normals[o + 2] = sign * n.Z();
      } finally {
        s.free(p);
        s.free(n);
      }
    }
    const nbTris = tri.NbTriangles();
    const indices = new Array<number>(nbTris * 3);
    for (let i = 1; i <= nbTris; i++) {
      const t = tri.Triangle(i);
      try {
        const { theN1, theN2, theN3 } = t.Get();
        const o = (i - 1) * 3;
        indices[o] = theN1 - 1;
        indices[o + 1] = (reversed ? theN3 : theN2) - 1;
        indices[o + 2] = (reversed ? theN2 : theN3) - 1;
      } finally {
        s.free(t);
      }
    }
    return { positions, normals, indices };
  }
}

/** The OCCT history interface shared by BRepBuilderAPI_MakeShape and BRepAlgoAPI builders. */
export interface HistorySource {
  Modified(x: TopoDS_Shape): InstanceType<Oc['NCollection_List_TopoDS_Shape']>;
  Generated(x: TopoDS_Shape): InstanceType<Oc['NCollection_List_TopoDS_Shape']>;
  IsDeleted(x: TopoDS_Shape): boolean;
}

/** Index every sub-shape of one kind, in TopExp.MapShapes order (1-based). */
export function mapShapes(oc: Oc, s: Scope, shape: TopoDS_Shape, kind: SubShapeKind): IndexedMap {
  const map = s.own(new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher());
  oc.TopExp.MapShapes(shape, shapeEnum(oc, kind), map);
  return map;
}

function shapeEnum(oc: Oc, kind: SubShapeKind): TopAbs_ShapeEnum {
  const e = oc.TopAbs_ShapeEnum;
  return kind === 'face' ? e.TopAbs_FACE : kind === 'edge' ? e.TopAbs_EDGE : e.TopAbs_VERTEX;
}

/** Numbered sub-shapes of one shape: 1-based, 0 meaning "not found". */
export interface SubShapeIndex {
  extent: number;
  key(index: number): TopoDS_Shape;
  indexOf(sub: TopoDS_Shape): number;
}

export type Indexer = (shape: TopoDS_Shape, kind: SubShapeKind) => SubShapeIndex;

/** The normal indexer: TopExp.MapShapes into an indexed map. */
export function mapIndexer(oc: Oc, s: Scope): Indexer {
  return (shape, kind) => {
    const map = mapShapes(oc, s, shape, kind);
    return {
      extent: map.Extent(),
      key: (i) => s.own(map.FindKey(i)),
      indexOf: (sub) => map.FindIndex(sub),
    };
  };
}

/**
 * For builds that cannot construct an indexed map (replicad's trimmed build
 * binds the class but not its base): TopExp_Explorer plus IsSame, which gives
 * the same order as MapShapes, in quadratic time.
 */
export function explorerIndexer(oc: Oc, s: Scope): Indexer {
  return (shape, kind) => {
    const found: TopoDS_Shape[] = [];
    const explorer = s.own(
      new oc.TopExp_Explorer(shape, shapeEnum(oc, kind), oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    for (; explorer.More(); explorer.Next()) {
      const current = s.own(explorer.Current());
      if (!found.some((f) => f.IsSame(current))) found.push(current);
    }
    const indexOf = (sub: TopoDS_Shape) => found.findIndex((f) => f.IsSame(sub)) + 1;
    return { extent: found.length, key: (i) => found[i - 1]!, indexOf };
  };
}

/**
 * Ask the builder what became of every sub-shape of the inputs (faces always;
 * edges and vertices when they generated faces), naming inputs and outputs by
 * their index. This is the raw material for topological naming (T0.5).
 */
export function collectHistory(
  oc: Oc,
  s: Scope,
  builder: HistorySource,
  inputs: TopoDS_Shape[],
  result: TopoDS_Shape,
  kinds: SubShapeKind[],
  indexer: Indexer = mapIndexer(oc, s),
): HistoryEntry[] {
  const resultFaces = indexer(result, 'face');
  const toIndices = (list: InstanceType<Oc['NCollection_List_TopoDS_Shape']>): number[] => {
    // No list iterator is needed: pop the front of a copy until it is empty.
    const out = new Set<number>();
    const copy = s.own(new oc.NCollection_List_TopoDS_Shape(list));
    while (copy.Size() > 0) {
      const index = resultFaces.indexOf(s.own(copy.First()));
      if (index > 0) out.add(index);
      copy.RemoveFirst();
    }
    return [...out].sort((x, y) => x - y);
  };
  const entries: HistoryEntry[] = [];
  inputs.forEach((input, operand) => {
    for (const kind of kinds) {
      const index = indexer(input, kind);
      for (let i = 1; i <= index.extent; i++) {
        const sub = index.key(i);
        const modified = toIndices(s.own(builder.Modified(sub)));
        const generated = toIndices(s.own(builder.Generated(sub)));
        const deleted = builder.IsDeleted(sub);
        const kept = kind === 'face' ? resultFaces.indexOf(sub) : 0;
        if (kind !== 'face' && generated.length === 0) continue;
        entries.push({ operand, input: { kind, index: i }, modified, generated, deleted, kept });
      }
    }
  });
  return entries;
}

function pack(
  chunks: Array<{ positions: number[]; normals: number[]; indices: number[] }>,
): MeshData {
  let vertexCount = 0;
  let indexCount = 0;
  for (const c of chunks) {
    vertexCount += c.positions.length / 3;
    indexCount += c.indices.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const faceRanges = new Uint32Array(chunks.length * 2);
  let vBase = 0;
  let iBase = 0;
  chunks.forEach((c, f) => {
    positions.set(c.positions, vBase * 3);
    normals.set(c.normals, vBase * 3);
    for (let i = 0; i < c.indices.length; i++) indices[iBase + i] = c.indices[i]! + vBase;
    faceRanges[f * 2] = iBase;
    faceRanges[f * 2 + 1] = c.indices.length;
    vBase += c.positions.length / 3;
    iBase += c.indices.length;
  });
  return { positions, normals, indices, faceRanges };
}
