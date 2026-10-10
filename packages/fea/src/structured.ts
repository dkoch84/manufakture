// Structured TET10 meshes of mapped blocks, without a mesher: a grid of hexahedra over a
// parameter cube, each split into six tetrahedra (Kuhn's split, conforming across cells), mapped
// to space by a function so curved boundaries are exact at every node, edge nodes included. The
// solver's analytical benchmarks run on these in every test run, whether or not gmsh is built.

import type { FaceTriangles, TetMesh } from './mesh';
import type { MeshedModel } from './solve';
import { EDGES } from './tet10';

export interface BlockOptions {
  /** Cells along u, v, w. */
  cells: [number, number, number];
  /** Parameter (u, v, w) in [0, 1]^3 to a point, mm. */
  map: (u: number, v: number, w: number) => [number, number, number];
  /**
   * Which face a boundary triangle belongs to, from its corners' parameters (default: the six
   * planes u=0 (0), u=1 (1), v=0 (2), v=1 (3), w=0 (4), w=1 (5)). -1 leaves it out.
   */
  faceOf?: (corners: [number, number, number][]) => number;
  /** Number of faces `faceOf` returns (default 6). */
  faces?: number;
}

/** The six Kuhn tets of the unit cube, as axis orders from corner (0,0,0) to (1,1,1). */
const PERMS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

const defaultFaceOf = (c: [number, number, number][]): number => {
  for (let axis = 0; axis < 3; axis++) {
    if (c.every((p) => p[axis] === 0)) return 2 * axis;
    if (c.every((p) => p[axis] === 1)) return 2 * axis + 1;
  }
  return -1;
};

/** A one-body mapped block as a meshed model. */
export function structuredBlock(options: BlockOptions): MeshedModel {
  const [nx, ny, nz] = options.cells;
  const faceOf = options.faceOf ?? defaultFaceOf;
  // Points on the doubled grid (half steps), indexed (i, j, k) with 0 <= i <= 2 nx.
  const sx = 2 * nx + 1,
    sy = 2 * ny + 1,
    sz = 2 * nz + 1;
  const gid = (i: number, j: number, k: number) => i + sx * (j + sy * k);
  const slot = new Int32Array(sx * sy * sz).fill(-1);
  const coords: number[] = [];
  const params: [number, number, number][] = [];
  const node = (i: number, j: number, k: number): number => {
    const g = gid(i, j, k);
    if (slot[g] === -1) {
      slot[g] = params.length;
      const p: [number, number, number] = [i / (2 * nx), j / (2 * ny), k / (2 * nz)];
      params.push(p);
      coords.push(...options.map(p[0], p[1], p[2]));
    }
    return slot[g]!;
  };
  const tets: number[] = [];
  const corners: [number, number, number][] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        for (const perm of PERMS) {
          corners.length = 0;
          const at: [number, number, number] = [2 * i, 2 * j, 2 * k];
          corners.push([...at]);
          for (const axis of perm) {
            at[axis]! += 2;
            corners.push([...at]);
          }
          // Orientation: a positive volume of the mapped corners.
          const ids = corners.map(([a, b, c]) => node(a, b, c));
          const x = (n: number, c: number) => coords[3 * ids[n]! + c]!;
          const d = (n: number, c: number) => x(n, c) - x(0, c);
          const vol =
            d(1, 0) * (d(2, 1) * d(3, 2) - d(2, 2) * d(3, 1)) -
            d(1, 1) * (d(2, 0) * d(3, 2) - d(2, 2) * d(3, 0)) +
            d(1, 2) * (d(2, 0) * d(3, 1) - d(2, 1) * d(3, 0));
          if (vol < 0) [corners[1], corners[2]] = [corners[2]!, corners[1]!];
          for (const c of corners) tets.push(node(c[0], c[1], c[2]));
          for (const [a, b] of EDGES) {
            const ca = corners[a]!,
              cb = corners[b]!;
            tets.push(node((ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2, (ca[2] + cb[2]) / 2));
          }
        }
  const ne = tets.length / 10;
  const mesh: TetMesh = {
    nodes: Float64Array.from(coords),
    tets: Uint32Array.from(tets),
    tetBody: new Uint16Array(ne),
  };
  // Boundary triangles: tet faces whose corners all lie on one face of the block.
  const faceCount = options.faces ?? 6;
  const groups: number[][] = Array.from({ length: faceCount }, () => []);
  const local = [
    [0, 1, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 2, 3],
  ];
  for (let e = 0; e < ne; e++) {
    for (const f of local) {
      const ids = f.map((q) => mesh.tets[10 * e + q]!);
      const face = faceOf(ids.map((id) => params[id]!));
      if (face >= 0) groups[face]!.push(...ids);
    }
  }
  const faces: FaceTriangles[] = groups.map((g, face) => ({
    body: 0,
    face,
    corners: Uint32Array.from(g),
  }));
  return { mesh, faces, faceCounts: [faceCount] };
}
