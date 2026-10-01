// Display-side preparation of a kernel mesh: the lookup tables the viewport
// needs for highlighting and picking, built once per mesh. Several bodies may
// show the same mesh (the instances of a part in an assembly, each with its
// own transform): the tables are shared, only pick ids and bounds are theirs.

import type { MeshData, Topology, Vec3 } from '@manufakture/kernel';

/**
 * A rigid placement of a body: `p_world = R p_local + translation`, `rotation`
 * a unit quaternion `[x, y, z, w]` (core's and the solver's `Pose`).
 */
export interface BodyTransform {
  translation: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
}

/** What the viewport is given for one body. */
export interface BodyInput {
  /** Stable id of the body (the feature or part it belongs to). */
  id: string;
  mesh: MeshData;
  /** Name table of the reply the mesh came in. */
  names: readonly string[];
  /** For edge and vertex picking: adjacency and vertex points. Optional. */
  topology?: Topology | null;
  /** Face colour, `#rrggbb`; the viewport's default face colour when absent. */
  color?: string;
  /**
   * Where the body is drawn: its mesh, topology and picks stay in the body's own
   * coordinates, and this places them (an assembly instance). Absent: as is.
   */
  transform?: BodyTransform;
}

export interface BodyVertex {
  /** 1-based vertex index. */
  index: number;
  point: Vec3;
  faces: readonly number[];
}

export interface ViewBody extends BodyInput {
  faceCount: number;
  edgeCount: number;
  /**
   * Display arrays. The same as the mesh's when no vertex is shared between
   * faces; otherwise shared vertices are duplicated, one copy per face, so
   * every display vertex belongs to exactly one face.
   */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per display vertex: its 1-based face, 0 for a vertex no triangle uses. */
  vertexFaces: Uint32Array;
  /** Per face (slot = face - 1): its display vertices are `faceVertexList[offsets[f] .. offsets[f + 1]]`. */
  faceVertexOffsets: Uint32Array;
  faceVertexList: Uint32Array;
  /** Per face: the lowest display vertex and one past the highest, for partial GPU updates. */
  faceVertexStart: Uint32Array;
  faceVertexEnd: Uint32Array;
  /**
   * First pick id of the body; 0 is the background. The body owns the next
   * `pickCount` ids: faces, then edges, then vertices (see picking.ts).
   */
  pickBase: number;
  pickCount: number;
  /** Edge polylines as line segments: xyz xyz per segment. */
  segments: Float32Array;
  /** Per segment: its 1-based edge index. */
  segmentEdges: Uint32Array;
  /** Per edge (slot = edge - 1): adjacent faces, or null when no topology was given. */
  edgeFaces: readonly (readonly number[])[] | null;
  vertices: readonly BodyVertex[];
  bounds: { min: Vec3; max: Vec3 } | null;
}

interface DisplayMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexFaces: Uint32Array;
}

/**
 * Give every vertex exactly one face, taken from `triangleFaces`. The kernel
 * emits separate vertices per face today, but nothing in MeshData promises
 * it, and a shared vertex would take its pick id and highlight colour from
 * whichever face wrote it last. A shared vertex is duplicated instead.
 */
export function splitSharedVertices(mesh: MeshData): DisplayMesh {
  const vertexCount = mesh.positions.length / 3;
  const vertexFaces = new Uint32Array(vertexCount);
  const triangles = mesh.indices.length / 3;
  // Copies of shared vertices, keyed by vertex and face.
  const copies = new Map<string, number>();
  const extra: number[] = [];
  let indices = mesh.indices;
  for (let t = 0; t < triangles; t++) {
    const face = mesh.triangleFaces[t]!;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k]!;
      const owner = vertexFaces[v]!;
      if (owner === 0) vertexFaces[v] = face;
      if (owner === 0 || owner === face) continue;
      const key = `${v}:${face}`;
      let copy = copies.get(key);
      if (copy === undefined) {
        copy = vertexCount + extra.length;
        copies.set(key, copy);
        extra.push(v);
      }
      if (indices === mesh.indices) indices = mesh.indices.slice();
      indices[t * 3 + k] = copy;
    }
  }
  if (extra.length === 0) {
    return { positions: mesh.positions, normals: mesh.normals, indices, vertexFaces };
  }
  const total = vertexCount + extra.length;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  positions.set(mesh.positions);
  normals.set(mesh.normals);
  extra.forEach((v, i) => {
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), (vertexCount + i) * 3);
    normals.set(mesh.normals.subarray(v * 3, v * 3 + 3), (vertexCount + i) * 3);
  });
  const faces = new Uint32Array(total);
  faces.set(vertexFaces);
  // A copy belongs to the face of the triangles that use it.
  for (const [key, copy] of copies) faces[copy] = Number(key.slice(key.indexOf(':') + 1));
  return { positions, normals, indices, vertexFaces: faces };
}

/** What `prepareBody` computes from a mesh and topology alone, shared by every body showing them. */
type Prepared = Omit<ViewBody, keyof BodyInput | 'pickBase' | 'pickCount' | 'bounds'> & {
  localBounds: { min: Vec3; max: Vec3 } | null;
};

const preparedMeshes = new WeakMap<MeshData, WeakMap<object, Prepared>>();
const NO_TOPOLOGY = {};

function preparedFor(input: BodyInput): Prepared {
  let byTopology = preparedMeshes.get(input.mesh);
  if (!byTopology) preparedMeshes.set(input.mesh, (byTopology = new WeakMap()));
  const key = input.topology ?? NO_TOPOLOGY;
  let out = byTopology.get(key);
  if (!out) byTopology.set(key, (out = prepareMesh(input.mesh, input.topology ?? null)));
  return out;
}

export function prepareBody(input: BodyInput, pickBase: number): ViewBody {
  const prepared = preparedFor(input);
  const { localBounds, ...shared } = prepared;
  return {
    ...input,
    ...shared,
    pickBase,
    pickCount: shared.faceCount + shared.edgeCount + shared.vertices.length,
    bounds: localBounds && transformBounds(localBounds, input.transform),
  };
}

function prepareMesh(mesh: MeshData, topology: Topology | null): Prepared {
  const faceCount = mesh.faceRanges.length / 2;
  const edgeCount = mesh.edgeRanges.length / 2;
  const display = splitSharedVertices(mesh);
  const { vertexFaces } = display;

  // Vertices grouped by face (counting sort), plus each face's vertex span.
  const faceVertexOffsets = new Uint32Array(faceCount + 1);
  for (const f of vertexFaces) if (f > 0 && f <= faceCount) faceVertexOffsets[f]!++;
  for (let f = 0; f < faceCount; f++) faceVertexOffsets[f + 1]! += faceVertexOffsets[f]!;
  const faceVertexList = new Uint32Array(faceVertexOffsets[faceCount]!);
  const fill = faceVertexOffsets.slice(0, faceCount);
  const faceVertexStart = new Uint32Array(faceCount);
  const faceVertexEnd = new Uint32Array(faceCount);
  for (let v = 0; v < vertexFaces.length; v++) {
    const f = vertexFaces[v]!;
    if (f === 0 || f > faceCount) continue;
    const slot = f - 1;
    if (fill[slot] === faceVertexOffsets[slot]) faceVertexStart[slot] = v;
    faceVertexEnd[slot] = v + 1;
    faceVertexList[fill[slot]!++] = v;
  }

  let segmentCount = 0;
  for (let e = 0; e < edgeCount; e++) segmentCount += Math.max(0, mesh.edgeRanges[e * 2 + 1]! - 1);
  const segments = new Float32Array(segmentCount * 6);
  const segmentEdges = new Uint32Array(segmentCount);
  let s = 0;
  for (let e = 0; e < edgeCount; e++) {
    const first = mesh.edgeRanges[e * 2]!;
    const count = mesh.edgeRanges[e * 2 + 1]!;
    for (let p = first; p + 1 < first + count; p++) {
      segments.set(mesh.edgePositions.subarray(p * 3, p * 3 + 6), s * 6);
      segmentEdges[s] = e + 1;
      s++;
    }
  }

  const vertices = topology
    ? topology.vertices.map((v) => ({ index: v.index, point: v.point, faces: v.faces }))
    : [];
  return {
    faceCount,
    edgeCount,
    positions: display.positions,
    normals: display.normals,
    indices: display.indices,
    vertexFaces,
    faceVertexOffsets,
    faceVertexList,
    faceVertexStart,
    faceVertexEnd,
    segments,
    segmentEdges,
    edgeFaces: topology ? topology.edges.map((e) => e.faces) : null,
    vertices,
    localBounds: boundsOf(mesh.positions),
  };
}

/** A point of a body in world coordinates. */
export function transformPoint(t: BodyTransform | undefined, p: ArrayLike<number>): Vec3 {
  if (!t) return [p[0]!, p[1]!, p[2]!];
  const [x, y, z, w] = t.rotation;
  const [px, py, pz] = [p[0]!, p[1]!, p[2]!];
  // v + 2w (q x v) + 2 q x (q x v), q the vector part.
  const cx = y * pz - z * py;
  const cy = z * px - x * pz;
  const cz = x * py - y * px;
  const dx = y * cz - z * cy;
  const dy = z * cx - x * cz;
  const dz = x * cy - y * cx;
  return [
    px + 2 * (w * cx + dx) + t.translation[0],
    py + 2 * (w * cy + dy) + t.translation[1],
    pz + 2 * (w * cz + dz) + t.translation[2],
  ];
}

/** A world point in a body's own coordinates (the inverse of `transformPoint`). */
export function untransformPoint(t: BodyTransform | undefined, p: ArrayLike<number>): Vec3 {
  if (!t) return [p[0]!, p[1]!, p[2]!];
  const [x, y, z, w] = t.rotation;
  const local = [p[0]! - t.translation[0], p[1]! - t.translation[1], p[2]! - t.translation[2]];
  return transformPoint({ translation: [0, 0, 0], rotation: [-x, -y, -z, w] }, local);
}

/** The world box around a body's own box placed by `t`. */
export function transformBounds(
  b: { min: Vec3; max: Vec3 },
  t: BodyTransform | undefined,
): { min: Vec3; max: Vec3 } {
  if (!t) return b;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const corner = [
      k & 1 ? b.max[0] : b.min[0],
      k & 2 ? b.max[1] : b.min[1],
      k & 4 ? b.max[2] : b.min[2],
    ];
    const q = transformPoint(t, corner);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, q[a]!);
      max[a] = Math.max(max[a]!, q[a]!);
    }
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
}

/** Prepare several bodies with consecutive pick id ranges. */
export function prepareBodies(inputs: readonly BodyInput[]): ViewBody[] {
  let base = 1;
  return inputs.map((input) => {
    const body = prepareBody(input, base);
    base += body.pickCount;
    return body;
  });
}

// Pick ids of a body: faces from pickBase, then edges, then vertices. As
// floats in vertex attributes they are exact up to 2^24, the RGB range.

export function facePickId(body: ViewBody, face: number): number {
  return body.pickBase + face - 1;
}

export function edgePickId(body: ViewBody, edge: number): number {
  return body.pickBase + body.faceCount + edge - 1;
}

export function vertexPickId(body: ViewBody, vertex: number): number {
  return body.pickBase + body.faceCount + body.edgeCount + vertex - 1;
}

/** Per display vertex, the pick id of its face (0 for an unused vertex). */
export function pickIdAttribute(body: ViewBody): Float32Array {
  const out = new Float32Array(body.vertexFaces.length);
  for (let v = 0; v < out.length; v++) {
    const f = body.vertexFaces[v]!;
    if (f > 0) out[v] = facePickId(body, f);
  }
  return out;
}

/** Per edge segment end point (two per segment), the pick id of its edge. */
export function edgePickIds(body: ViewBody): Float32Array {
  const out = new Float32Array(body.segmentEdges.length * 2);
  body.segmentEdges.forEach((edge, s) => out.fill(edgePickId(body, edge), s * 2, s * 2 + 2));
  return out;
}

/** Vertex points (xyz) and their pick ids, for drawing vertices into the pick pass. */
export function vertexPickPoints(body: ViewBody): { positions: Float32Array; ids: Float32Array } {
  const positions = new Float32Array(body.vertices.length * 3);
  const ids = new Float32Array(body.vertices.length);
  body.vertices.forEach((v, i) => {
    positions.set(v.point, i * 3);
    ids[i] = vertexPickId(body, v.index);
  });
  return { positions, ids };
}

export function boundsOf(positions: Float32Array): { min: Vec3; max: Vec3 } | null {
  if (positions.length < 3) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

export function unionBounds(bodies: readonly ViewBody[]): { min: Vec3; max: Vec3 } | null {
  let out: { min: number[]; max: number[] } | null = null;
  for (const b of bodies) {
    if (!b.bounds) continue;
    if (!out) {
      out = { min: [...b.bounds.min], max: [...b.bounds.max] };
      continue;
    }
    for (let a = 0; a < 3; a++) {
      out.min[a] = Math.min(out.min[a]!, b.bounds.min[a]!);
      out.max[a] = Math.max(out.max[a]!, b.bounds.max[a]!);
    }
  }
  return out as { min: Vec3; max: Vec3 } | null;
}
