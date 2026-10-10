// Volume meshing with gmsh (gmsh-wasm): STEP bytes from the kernel in, quadratic tetrahedra out.
// Runs unchanged in Node and in a browser worker; the caller passes the loaded gmsh module.

import { EDGES, FACES } from './tet10.ts';

/** A TET10 mesh in our node order (see tet10.ts). */
export interface TetMesh {
  /** x, y, z per node, mm. */
  nodes: Float64Array;
  /** 10 node indices per element. */
  tets: Uint32Array;
}

export interface MeshOptions {
  /** Largest element edge, mm. */
  sizeMax: number;
  /** Smallest element edge, mm (default sizeMax / 20). */
  sizeMin?: number;
  /** Elements per 2 pi of curvature; 0 leaves curvature out (default 0). */
  fromCurvature?: number;
  /** gmsh threads; 0 = all cores (default 1). */
  threads?: number;
  /** gmsh's 3D algorithm: 1 Delaunay (default), 10 HXT. */
  algorithm3D?: number;
  /** Refine near points: size `size` within `radius` of each point, growing to sizeMax by `to`. */
  refine?: { points: [number, number, number][]; size: number; radius: number; to: number };
}

export interface MeshTiming {
  importMs: number;
  generateMs: number;
  extractMs: number;
}

// The gmsh-wasm API is generated and loosely typed; this is the part we call.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Gmsh = any;

/** Mesh the first solid of a STEP file into TET10 elements. */
export function meshStep(
  gmsh: Gmsh,
  step: Uint8Array,
  options: MeshOptions,
): { mesh: TetMesh; timing: MeshTiming } {
  let t = performance.now();
  gmsh.model.add(`m${Math.random().toString(36).slice(2)}`);
  gmsh.FS.writeFile('/in.step', step);
  gmsh.model.occ.importShapes('/in.step');
  gmsh.model.occ.synchronize();
  const importMs = performance.now() - t;

  gmsh.option.setNumber('General.NumThreads', options.threads ?? 1);
  gmsh.option.setNumber('Mesh.MeshSizeMax', options.sizeMax);
  gmsh.option.setNumber('Mesh.MeshSizeMin', options.sizeMin ?? options.sizeMax / 20);
  gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', options.fromCurvature ?? 0);
  gmsh.option.setNumber('Mesh.Algorithm3D', options.algorithm3D ?? 1);
  gmsh.option.setNumber('Mesh.ElementOrder', 2);
  // Curved boundaries: keep mid-side nodes on the surface but untangle elements it inverts.
  gmsh.option.setNumber('Mesh.HighOrderOptimize', 0);
  gmsh.option.setNumber('Mesh.SecondOrderLinear', 0);

  if (options.refine) {
    const r = options.refine;
    const pts = r.points.map(([x, y, z]) => gmsh.model.geo.addPoint(x, y, z));
    gmsh.model.geo.synchronize();
    const dist = gmsh.model.mesh.field.add('Distance');
    gmsh.model.mesh.field.setNumbers(dist, 'PointsList', pts);
    const thr = gmsh.model.mesh.field.add('Threshold');
    gmsh.model.mesh.field.setNumber(thr, 'InField', dist);
    gmsh.model.mesh.field.setNumber(thr, 'SizeMin', r.size);
    gmsh.model.mesh.field.setNumber(thr, 'SizeMax', options.sizeMax);
    gmsh.model.mesh.field.setNumber(thr, 'DistMin', r.radius);
    gmsh.model.mesh.field.setNumber(thr, 'DistMax', r.to);
    gmsh.model.mesh.field.setAsBackgroundMesh(thr);
  }

  t = performance.now();
  gmsh.model.mesh.generate(3);
  const generateMs = performance.now() - t;

  t = performance.now();
  const { nodeTags, coord } = gmsh.model.mesh.getNodes();
  const { nodeTags: elemNodes } = gmsh.model.mesh.getElementsByType(11);
  gmsh.model.remove();
  const mesh = toTetMesh(nodeTags, coord, elemNodes);
  const extractMs = performance.now() - t;
  return { mesh, timing: { importMs, generateMs, extractMs } };
}

/**
 * Compact gmsh's tagged nodes to the ones the tets use, and map gmsh's TET10 edge-node order to
 * ours. The mapping is found geometrically (each edge node lies nearest the midpoint of its own
 * corner pair) on a sample of elements, rather than trusted from documentation.
 */
export function toTetMesh(
  nodeTags: ArrayLike<number>,
  coord: ArrayLike<number>,
  elemNodes: ArrayLike<number>,
): TetMesh {
  let maxTag = 0;
  for (let i = 0; i < nodeTags.length; i++) maxTag = Math.max(maxTag, nodeTags[i]!);
  const slot = new Int32Array(maxTag + 1).fill(-1);
  for (let i = 0; i < nodeTags.length; i++) slot[nodeTags[i]!] = i;

  const ne = elemNodes.length / 10;
  const index = new Int32Array(maxTag + 1).fill(-1);
  let count = 0;
  for (let i = 0; i < elemNodes.length; i++) {
    const tag = elemNodes[i]!;
    if (index[tag] === -1) index[tag] = count++;
  }
  const nodes = new Float64Array(3 * count);
  for (let tag = 0; tag <= maxTag; tag++) {
    const k = index[tag]!;
    if (k < 0) continue;
    const s = slot[tag]!;
    nodes[3 * k] = coord[3 * s]!;
    nodes[3 * k + 1] = coord[3 * s + 1]!;
    nodes[3 * k + 2] = coord[3 * s + 2]!;
  }

  // Which gmsh edge-node position (4..9) holds the node of each of our edges.
  const votes = Array.from({ length: 6 }, () => new Int32Array(6));
  const sample = Math.min(ne, 200);
  for (let e = 0; e < sample; e++) {
    const at = (p: number, c: number) => nodes[3 * index[elemNodes[10 * e + p]!]! + c]!;
    for (let p = 4; p < 10; p++) {
      let best = 0,
        bestD = Infinity;
      for (let q = 0; q < 6; q++) {
        const [i, j] = EDGES[q]!;
        let d = 0;
        for (let c = 0; c < 3; c++) d += (at(p, c) - 0.5 * (at(i, c) + at(j, c))) ** 2;
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      votes[best]![p - 4]! += 1;
    }
  }
  const perm = votes.map((v) => 4 + v.indexOf(Math.max(...v)));
  if (new Set(perm).size !== 6) throw new Error(`ambiguous TET10 edge order: ${perm.join(',')}`);

  const tets = new Uint32Array(10 * ne);
  for (let e = 0; e < ne; e++) {
    for (let a = 0; a < 4; a++) tets[10 * e + a] = index[elemNodes[10 * e + a]!]!;
    for (let q = 0; q < 6; q++) tets[10 * e + 4 + q] = index[elemNodes[10 * e + perm[q]!]!]!;
  }
  return { nodes, tets };
}

/** A boundary face of the mesh: its 6 nodes (corners then mids) and the opposite corner of its tet. */
export interface BoundaryFaces {
  /** 6 node indices per face: corners 0..2, then the mids of (0,1), (1,2), (0,2). */
  nodes: Uint32Array;
  /** The tet corner not on the face, to orient the outward normal. */
  opposite: Uint32Array;
}

/** Faces that belong to exactly one tet. */
export function boundaryFaces(mesh: TetMesh): BoundaryFaces {
  const { tets } = mesh;
  const ne = tets.length / 10;
  const seen = new Map<string, number>();
  const keep: number[] = [];
  for (let e = 0; e < ne; e++) {
    for (let f = 0; f < 4; f++) {
      const c = FACES[f]!.corners.map((k) => tets[10 * e + k]!).sort((a, b) => a - b);
      const key = `${c[0]},${c[1]},${c[2]}`;
      const code = 4 * e + f;
      if (seen.has(key)) seen.delete(key);
      else seen.set(key, code);
    }
  }
  for (const code of seen.values()) keep.push(code);
  const nodes = new Uint32Array(6 * keep.length);
  const opposite = new Uint32Array(keep.length);
  keep.forEach((code, i) => {
    const e = code >> 2,
      face = FACES[code & 3]!;
    // mids of face are (c0,c1), (c1,c2), (c0,c2) up to which corner pair each covers; FACES lists
    // them in that order.
    const ids = [...face.corners, ...face.mids];
    for (let k = 0; k < 6; k++) nodes[6 * i + k] = tets[10 * e + ids[k]!]!;
    opposite[i] = tets[10 * e + face.opposite]!;
  });
  return { nodes, opposite };
}
