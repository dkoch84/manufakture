// Tessellation: per-face triangles and per-edge polylines, copied out of the
// wasm heap into fresh typed arrays (T0.2's layout plus ADR 0007's per-face
// and per-edge name slots). Through embind this costs a few calls per node
// and triangle; ADR 0002 moves it into a C++ helper later.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, gp_Trsf } from 'libcascade/single/init';
import { mapShapes, withScope, type Oc, type Scope } from './occt';
import { UNNAMED, type Deflection, type MeshData } from './types';

interface FaceChunk {
  positions: number[];
  normals: number[];
  indices: number[];
}

const EMPTY_CHUNK: FaceChunk = { positions: [], normals: [], indices: [] };

/** Polyline points per curved edge when an edge has no polygon on the triangulation. */
const MAX_FALLBACK_POINTS = 256;

/**
 * Mesh `body`, extract it, then strip the triangulation from the B-rep again
 * (`BRepTools.Clean`): the builder that made the shape keeps its own copy
 * alive, so a triangulation left on the faces would leak with it (T0.2).
 */
export function tessellate(oc: Oc, s: Scope, body: TopoDS_Shape, deflection: Deflection): MeshData {
  const mesher = s.own(
    new oc.BRepMesh_IncrementalMesh(body, deflection.linear, false, deflection.angular, false),
  );
  try {
    if (!mesher.IsDone()) throw new Error('meshing failed');
    const faces = mapShapes(oc, s, body, 'face');
    const chunks: FaceChunk[] = [];
    for (let i = 1; i <= faces.Extent(); i++) {
      chunks.push(
        withScope(oc, (fs) =>
          extractFace(oc, fs, fs.own(oc.TopoDS.Face(fs.own(faces.FindKey(i))))),
        ),
      );
    }
    const edges = mapShapes(oc, s, body, 'edge');
    const polylines: number[][] = [];
    for (let i = 1; i <= edges.Extent(); i++) {
      polylines.push(
        withScope(oc, (es) =>
          extractEdge(oc, es, es.own(oc.TopoDS.Edge(es.own(edges.FindKey(i)))), deflection),
        ),
      );
    }
    return pack(chunks, polylines);
  } finally {
    oc.BRepTools.Clean(body, true);
  }
}

function extractFace(oc: Oc, s: Scope, face: TopoDS_Face): FaceChunk {
  const loc = s.own(new oc.TopLoc_Location());
  const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
  if (tri === null) return EMPTY_CHUNK;
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
      // OCCT node indices are 1-based; a reversed face flips the winding.
      indices[o] = theN1 - 1;
      indices[o + 1] = (reversed ? theN3 : theN2) - 1;
      indices[o + 2] = (reversed ? theN2 : theN3) - 1;
    } finally {
      s.free(t);
    }
  }
  return { positions, normals, indices };
}

/**
 * The edge's polyline as flat xyz. Taken from the polygon BRepMesh stored on
 * an adjacent face's triangulation, so the points are exactly mesh nodes and
 * the lines sit on the triangles without gaps. Falls back to sampling the
 * curve for an edge with no such polygon (a free edge).
 */
function extractEdge(oc: Oc, s: Scope, edge: TopoDS_Edge, deflection: Deflection): number[] {
  if (oc.BRep_Tool.Degenerated(edge)) return [];
  const loc = s.own(new oc.TopLoc_Location());
  const found = oc.BRep_Tool.PolygonOnTriangulation(edge, loc);
  if (found.P !== null) s.own(found.P);
  if (found.T !== null) s.own(found.T);
  const out: number[] = [];
  if (found.P !== null && found.T !== null) {
    const polygon = found.P;
    const tri = found.T;
    const trsf: gp_Trsf | null = loc.IsIdentity() ? null : s.own(loc.Transformation());
    for (let k = 1; k <= polygon.NbNodes(); k++) {
      const p = tri.Node(polygon.Node(k));
      try {
        if (trsf) p.Transform(trsf);
        out.push(p.X(), p.Y(), p.Z());
      } finally {
        s.free(p);
      }
    }
    return out;
  }
  const curve = s.own(new oc.BRepAdaptor_Curve(edge));
  const first = curve.FirstParameter();
  const last = curve.LastParameter();
  let count = 2;
  if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) {
    const props = s.own(new oc.GProp_GProps());
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    count = Math.min(MAX_FALLBACK_POINTS, Math.max(8, Math.ceil(props.Mass() / deflection.linear)));
  }
  for (let k = 0; k < count; k++) {
    const p = curve.Value(first + ((last - first) * k) / (count - 1));
    try {
      out.push(p.X(), p.Y(), p.Z());
    } finally {
      s.free(p);
    }
  }
  return out;
}

function pack(chunks: FaceChunk[], polylines: number[][]): MeshData {
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
  const triangleFaces = new Uint32Array(indexCount / 3);
  let vBase = 0;
  let iBase = 0;
  chunks.forEach((c, f) => {
    positions.set(c.positions, vBase * 3);
    normals.set(c.normals, vBase * 3);
    for (let i = 0; i < c.indices.length; i++) indices[iBase + i] = c.indices[i]! + vBase;
    faceRanges[f * 2] = iBase;
    faceRanges[f * 2 + 1] = c.indices.length;
    triangleFaces.fill(f + 1, iBase / 3, (iBase + c.indices.length) / 3);
    vBase += c.positions.length / 3;
    iBase += c.indices.length;
  });

  let pointCount = 0;
  for (const p of polylines) pointCount += p.length / 3;
  const edgePositions = new Float32Array(pointCount * 3);
  const edgeRanges = new Uint32Array(polylines.length * 2);
  let pBase = 0;
  polylines.forEach((p, e) => {
    edgePositions.set(p, pBase * 3);
    edgeRanges[e * 2] = pBase;
    edgeRanges[e * 2 + 1] = p.length / 3;
    pBase += p.length / 3;
  });

  return {
    positions,
    normals,
    indices,
    faceRanges,
    triangleFaces,
    edgePositions,
    edgeRanges,
    faceNames: new Uint32Array(chunks.length).fill(UNNAMED),
    faceFragile: new Uint8Array(chunks.length),
    edgeNames: new Uint32Array(polylines.length).fill(UNNAMED),
    edgeFragile: new Uint8Array(polylines.length),
  };
}

/** Every buffer of a mesh, for `Comlink.transfer`. */
export function meshBuffers(mesh: MeshData): ArrayBuffer[] {
  return [
    mesh.positions,
    mesh.normals,
    mesh.indices,
    mesh.faceRanges,
    mesh.triangleFaces,
    mesh.edgePositions,
    mesh.edgeRanges,
    mesh.faceNames,
    mesh.faceFragile,
    mesh.edgeNames,
    mesh.edgeFragile,
  ].map((a) => a.buffer as ArrayBuffer);
}
