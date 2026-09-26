// OCCT pipeline used by both the browser worker and the Node measurement script:
// build a part, fillet its edges, mesh it, and copy the triangulation out of the
// WASM heap into plain typed arrays that can be transferred to the main thread.
//
// Memory rule: every embind object created here (constructed, or returned by a
// call: shapes, builders, maps, handles, locations, points, triangles...) owns
// C++ memory in the WASM heap that JS garbage collection never frees. Each one
// is released with .delete(), either through a Scope (released in reverse order
// in a finally block) or immediately after use in hot loops.
//
// libcascade 3.0.x caveat (measured, see docs/spikes/T0.2-occt.md): for 2102 of
// its 5298 bound classes, including TopoDS_Shape, gp_Pnt, TopLoc_Location and
// every BRepPrimAPI / BRepAlgoAPI / BRepFilletAPI builder, the destructor that
// embind calls on .delete() is an empty function. delete() then frees nothing,
// and a shape handle keeps its whole B-rep alive. The "mitigated" memory mode
// therefore first calls whatever public method releases what the object owns
// (Nullify, Clear, Reset, SetArguments with an empty list) before delete().

import type {
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  gp_Trsf,
} from 'libcascade/single/init';

export type Oc = OpenCascadeInstance;

export interface Deletable {
  delete(): void;
}

export type PartKind = 'box' | 'bracket';

/**
 * - mitigated: release owned resources, then delete() (default)
 * - strict: delete() every object and nothing else, the documented embind contract
 * - none: skip every delete(); control experiment for the leak check
 */
export type MemoryMode = 'mitigated' | 'strict' | 'none';

export interface PipelineOptions {
  part: PartKind;
  filletRadius: number;
  /** Absolute linear deflection for BRepMesh_IncrementalMesh, in model units (mm). */
  linearDeflection: number;
  /** Angular deflection in radians. */
  angularDeflection: number;
  /**
   * Use OCCT's thread pool for booleans (BOPAlgo parallel mode) and meshing
   * (faces in parallel). Only has an effect on the multi-threaded build.
   */
  parallel: boolean;
  /** Defaults to 'mitigated'. */
  memory?: MemoryMode;
}

export interface PipelineTimings {
  buildMs: number;
  filletMs: number;
  meshMs: number;
  extractMs: number;
  totalMs: number;
}

export interface MeshData {
  /** xyz per vertex. Vertices are not shared between faces. */
  positions: Float32Array;
  /** Unit normal per vertex, oriented outward (face orientation applied). */
  normals: Float32Array;
  /** Triangle vertex indices, counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** Per B-rep face: [firstIndex, indexCount] into `indices` (three.js group layout). */
  faceRanges: Uint32Array;
  stats: {
    filletedEdges: number;
    faces: number;
    triangles: number;
    vertices: number;
    /** Bytes of the typed arrays above, i.e. what crosses the worker boundary. */
    transferBytes: number;
  };
  timings: PipelineTimings;
}

type Releasable = Deletable & Record<string, unknown>;

/**
 * Release what an object owns without relying on its destructor. Only calls
 * public OCCT methods; the object stays valid (but empty) until delete().
 */
export function release(oc: Oc, item: Deletable): void {
  const o = item as Releasable;
  const name = (o.constructor as { name?: string }).name ?? '';
  if (name.startsWith('TopoDS_')) {
    // Drops the TShape handle (the whole B-rep) and the location.
    (o.Nullify as () => void).call(o);
  } else if (name === 'TopLoc_Location') {
    (o.Clear as () => void).call(o);
  } else if (name.startsWith('BRepAlgoAPI_')) {
    // Frees the pave filler, builder and history; the argument and tool lists
    // hold the input shapes, so replace them with empty lists.
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

/** Collects embind objects and deletes them in reverse creation order. */
export class Scope {
  private readonly items: Deletable[] = [];
  private readonly oc: Oc;
  private readonly memory: MemoryMode;
  constructor(oc: Oc, memory: MemoryMode) {
    this.oc = oc;
    this.memory = memory;
  }

  own<T extends Deletable>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Delete one object now, honouring the memory mode. */
  free(item: Deletable): void {
    if (this.memory === 'none') return;
    try {
      if (this.memory === 'mitigated') release(this.oc, item);
    } finally {
      item.delete();
    }
  }

  dispose(): void {
    // Delete every object even if releasing one of them throws.
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

/** Run fn with a scope that is always disposed, even when OCCT throws. */
export function withScope<T>(oc: Oc, memory: MemoryMode, fn: (scope: Scope) => T): T {
  const scope = new Scope(oc, memory);
  try {
    return fn(scope);
  } finally {
    scope.dispose();
  }
}

/**
 * OCCT exceptions arrive as WebAssembly.Exception (the build uses native WASM
 * exceptions). Turn them into a readable Error and release the C++ exception.
 */
export function describeError(oc: Oc, error: unknown): Error {
  if (typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception) {
    try {
      const [type, message] = oc.getExceptionMessage(error);
      return new Error(`OCCT ${type}: ${message}`);
    } finally {
      oc.decrementExceptionRefcount(error);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function makeBox(oc: Oc, s: Scope): TopoDS_Shape {
  const maker = s.own(new oc.BRepPrimAPI_MakeBox(40, 30, 20));
  return s.own(maker.Shape());
}

function translatedAx2(
  oc: Oc,
  s: Scope,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
) {
  const origin = s.own(new oc.gp_Pnt(x, y, z));
  const dir = s.own(new oc.gp_Dir(dx, dy, dz));
  return s.own(new oc.gp_Ax2(origin, dir));
}

/**
 * An L-shaped bracket: base plate plus upright, four holes through the plate and
 * two through the upright. After unifying coplanar faces it has 30 edges that
 * border two different faces (18 on the L prism, 12 hole rims), all filleted.
 */
function makeBracket(oc: Oc, s: Scope): TopoDS_Shape {
  const base = s.own(new oc.BRepPrimAPI_MakeBox(80, 50, 10));
  const upright = s.own(new oc.BRepPrimAPI_MakeBox(12, 50, 45));
  const baseShape = s.own(base.Shape());
  const uprightShape = s.own(upright.Shape());
  const fuse = s.own(new oc.BRepAlgoAPI_Fuse(baseShape, uprightShape));
  let body = s.own(fuse.Shape());

  const unify = s.own(new oc.ShapeUpgrade_UnifySameDomain(body, true, true, false));
  unify.Build();
  body = s.own(unify.Shape());

  const holes: Array<[number, number, number, number, number, number]> = [
    [30, 12, -1, 0, 0, 1],
    [30, 38, -1, 0, 0, 1],
    [62, 12, -1, 0, 0, 1],
    [62, 38, -1, 0, 0, 1],
    [-1, 15, 30, 1, 0, 0],
    [-1, 35, 30, 1, 0, 0],
  ];
  for (const [x, y, z, dx, dy, dz] of holes) {
    const axis = translatedAx2(oc, s, x, y, z, dx, dy, dz);
    const cyl = s.own(new oc.BRepPrimAPI_MakeCylinder(axis, 4, dz === 1 ? 12 : 14));
    const tool = s.own(cyl.Shape());
    const cut = s.own(new oc.BRepAlgoAPI_Cut(body, tool));
    body = s.own(cut.Shape());
  }
  return body;
}

/** Edges bordering two distinct faces. Seam edges of cylinders are skipped. */
function filletableEdges(oc: Oc, s: Scope, shape: TopoDS_Shape): TopoDS_Edge[] {
  const map = s.own(
    new oc.NCollection_IndexedDataMap_TopoDS_Shape_NCollection_List_TopoDS_Shape_TopTools_ShapeMapHasher(),
  );
  oc.TopExp.MapShapesAndAncestors(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    map,
  );
  const edges: TopoDS_Edge[] = [];
  for (let i = 1; i <= map.Extent(); i++) {
    const faces = s.own(map.FindFromIndex(i));
    const first = s.own(faces.First());
    const last = s.own(faces.Last());
    if (faces.Size() < 2 || first.IsSame(last)) continue;
    const key = s.own(map.FindKey(i));
    edges.push(s.own(oc.TopoDS.Edge(key)));
  }
  return edges;
}

function fillet(oc: Oc, s: Scope, shape: TopoDS_Shape, radius: number) {
  const edges = filletableEdges(oc, s, shape);
  const maker = s.own(new oc.BRepFilletAPI_MakeFillet(shape));
  for (const edge of edges) maker.Add(radius, edge);
  maker.Build();
  if (!maker.IsDone()) throw new Error('fillet failed');
  return { shape: s.own(maker.Shape()), edgeCount: edges.length };
}

interface FaceChunk {
  positions: number[];
  normals: number[];
  indices: number[];
}

/** Copy one face's triangulation out of the WASM heap. */
function extractFace(oc: Oc, face: TopoDS_Face, memory: MemoryMode): FaceChunk | null {
  return withScope(oc, memory, (s) => {
    const loc = s.own(new oc.TopLoc_Location());
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (tri === null) return null;
    s.own(tri);
    if (!tri.HasNormals()) oc.BRepLib_ToolTriangulatedShape.ComputeNormals(face, tri);

    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const trsf: gp_Trsf | null = loc.IsIdentity() ? null : s.own(loc.Transformation());
    const free = (x: Deletable) => s.free(x);

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
        const sign = reversed ? -1 : 1;
        positions[o] = p.X();
        positions[o + 1] = p.Y();
        positions[o + 2] = p.Z();
        normals[o] = sign * n.X();
        normals[o + 1] = sign * n.Y();
        normals[o + 2] = sign * n.Z();
      } finally {
        free(p);
        free(n);
      }
    }

    const nbTris = tri.NbTriangles();
    const indices = new Array<number>(nbTris * 3);
    for (let i = 1; i <= nbTris; i++) {
      const t = tri.Triangle(i);
      try {
        const { theN1, theN2, theN3 } = t.Get();
        const o = (i - 1) * 3;
        // OCCT node indices are 1-based; a reversed face flips the winding.
        indices[o] = theN1 - 1;
        indices[o + 1] = (reversed ? theN3 : theN2) - 1;
        indices[o + 2] = (reversed ? theN2 : theN3) - 1;
      } finally {
        free(t);
      }
    }
    return { positions, normals, indices };
  });
}

function extractMesh(oc: Oc, s: Scope, shape: TopoDS_Shape, memory: MemoryMode) {
  const chunks: FaceChunk[] = [];
  // An indexed map rather than TopExp_Explorer: the map's destructor works, the
  // explorer's does not (and the explorer would keep a reference to the shape).
  const faces = s.own(new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher());
  oc.TopExp.MapShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, faces);
  for (let i = 1; i <= faces.Extent(); i++) {
    withScope(oc, memory, (fs) => {
      const key = fs.own(faces.FindKey(i));
      const face = fs.own(oc.TopoDS.Face(key));
      const chunk = extractFace(oc, face, memory);
      if (chunk) chunks.push(chunk);
    });
  }

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

export function runPipeline(oc: Oc, options: PipelineOptions): MeshData {
  const memory = options.memory ?? 'mitigated';
  const t0 = performance.now();
  try {
    return withScope(oc, memory, (s) => {
      oc.BOPAlgo_Options.SetParallelMode(options.parallel);
      const body = options.part === 'box' ? makeBox(oc, s) : makeBracket(oc, s);
      const t1 = performance.now();

      const filleted = fillet(oc, s, body, options.filletRadius);
      const t2 = performance.now();

      const mesher = s.own(
        new oc.BRepMesh_IncrementalMesh(
          filleted.shape,
          options.linearDeflection,
          false,
          options.angularDeflection,
          options.parallel,
        ),
      );
      if (!mesher.IsDone()) throw new Error('meshing failed');
      const t3 = performance.now();

      const mesh = extractMesh(oc, s, filleted.shape, memory);
      // The fillet builder keeps its result (and so the triangulation stored on
      // its faces) alive whatever we do, so strip the mesh from the B-rep.
      if (memory === 'mitigated') oc.BRepTools.Clean(filleted.shape, true);
      const t4 = performance.now();

      const transferBytes =
        mesh.positions.byteLength +
        mesh.normals.byteLength +
        mesh.indices.byteLength +
        mesh.faceRanges.byteLength;
      return {
        ...mesh,
        stats: {
          filletedEdges: filleted.edgeCount,
          faces: mesh.faceRanges.length / 2,
          triangles: mesh.indices.length / 3,
          vertices: mesh.positions.length / 3,
          transferBytes,
        },
        timings: {
          buildMs: t1 - t0,
          filletMs: t2 - t1,
          meshMs: t3 - t2,
          extractMs: t4 - t3,
          totalMs: t4 - t0,
        },
      };
    });
  } catch (error) {
    throw describeError(oc, error);
  }
}

/** Current size of the WASM linear memory. It only ever grows. */
export function heapBytes(oc: Oc): number {
  return oc.wasmMemory.buffer.byteLength;
}
