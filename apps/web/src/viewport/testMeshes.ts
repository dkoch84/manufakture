// Synthetic meshes in the kernel's MeshData layout, for tests, the e2e scene
// and the performance scene. They need no kernel, so they load instantly and
// their face names are known in advance.

import {
  NameTable,
  UNNAMED,
  applyNames,
  type EdgeInfo,
  type FaceInfo,
  type MeshData,
  type Topology,
  type Vec3,
  type VertexInfo,
} from '@manufakture/kernel';
import type { BodyInput } from './bodies';

/** Face names of `boxBody`, in face order (1-based index = position + 1). */
export const BOX_FACE_NAMES = ['left', 'right', 'front', 'back', 'bottom', 'top'] as const;
export type BoxFaceName = (typeof BOX_FACE_NAMES)[number];

interface BoxOptions {
  id?: string;
  min?: Vec3;
  size?: Vec3;
  /** Fill name slots as the naming layer would (default true). */
  named?: boolean;
}

/**
 * An axis-aligned box. Faces in order -X, +X, -Y, +Y, -Z, +Z, named
 * `<id>/left` ... `<id>/top`; edges named after their two faces.
 */
export function boxBody(options: BoxOptions = {}): BodyInput {
  const id = options.id ?? 'box';
  const min = options.min ?? [0, 0, 0];
  const size = options.size ?? [10, 10, 10];
  const max: Vec3 = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
  const corner = (bits: number): Vec3 => [
    bits & 1 ? max[0] : min[0],
    bits & 2 ? max[1] : min[1],
    bits & 4 ? max[2] : min[2],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: number[] = [];
  const triangleFaces: number[] = [];
  const faces: FaceInfo[] = [];
  for (let a = 0; a < 3; a++) {
    for (const s of [-1, 1]) {
      const face = faces.length + 1;
      let u = (a + 1) % 3;
      let v = (a + 2) % 3;
      if (s < 0) [u, v] = [v, u]; // keep u x v = outward normal
      const n = [0, 0, 0];
      n[a] = s;
      const base = positions.length / 3;
      for (const [du, dv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as const) {
        const p = [0, 0, 0];
        p[a] = s > 0 ? max[a]! : min[a]!;
        p[u] = du ? max[u]! : min[u]!;
        p[v] = dv ? max[v]! : min[v]!;
        positions.push(...p);
        normals.push(...n);
      }
      faceRanges.push(indices.length, 6);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      triangleFaces.push(face, face);
      const centroid = [0, 0, 0];
      for (let k = 0; k < 3; k++) centroid[k] = (min[k]! + max[k]!) / 2;
      centroid[a] = s > 0 ? max[a]! : min[a]!;
      faces.push({
        index: face,
        surface: 'plane',
        centroid: centroid as unknown as Vec3,
        area: size[u]! * size[v]!,
        normal: n as unknown as Vec3,
        axis: null,
        radius: null,
      });
    }
  }
  const faceOf = (axis: number, high: boolean) => axis * 2 + (high ? 2 : 1);

  // Edges run along axis `a`, at one of four sign combinations of the other two axes.
  const edgePositions: number[] = [];
  const edgeRanges: number[] = [];
  const edges: EdgeInfo[] = [];
  const vertexIndex = (bits: number) => bits + 1;
  for (let a = 0; a < 3; a++) {
    const o1 = (a + 1) % 3;
    const o2 = (a + 2) % 3;
    for (const h1 of [false, true]) {
      for (const h2 of [false, true]) {
        const bits0 = (h1 ? 1 << o1 : 0) | (h2 ? 1 << o2 : 0);
        const bits1 = bits0 | (1 << a);
        edgeRanges.push(edgePositions.length / 3, 2);
        edgePositions.push(...corner(bits0), ...corner(bits1));
        const p0 = corner(bits0);
        const p1 = corner(bits1);
        edges.push({
          index: edges.length + 1,
          faces: [faceOf(o1, h1), faceOf(o2, h2)].sort((x, y) => x - y),
          seam: false,
          curve: 'line',
          midpoint: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2],
          length: size[a]!,
          vertices: [vertexIndex(bits0), vertexIndex(bits1)],
        });
      }
    }
  }
  const vertices: VertexInfo[] = [];
  for (let bits = 0; bits < 8; bits++) {
    vertices.push({
      index: vertexIndex(bits),
      point: corner(bits),
      faces: [faceOf(0, !!(bits & 1)), faceOf(1, !!(bits & 2)), faceOf(2, !!(bits & 4))].sort(
        (x, y) => x - y,
      ),
    });
  }

  const mesh = packMesh({
    positions,
    normals,
    indices,
    faceRanges,
    triangleFaces,
    edgePositions,
    edgeRanges,
  });
  const topology: Topology = { faces, edges, vertices };
  const table = new NameTable();
  if (options.named ?? true) {
    const faceName = (f: number) => `${id}/${BOX_FACE_NAMES[f - 1]}`;
    applyNames(
      mesh,
      table,
      (f) => ({ name: faceName(f) }),
      (e) => {
        const [f1, f2] = edges[e - 1]!.faces;
        return { name: `${faceName(f1!)}|${BOX_FACE_NAMES[f2! - 1]}` };
      },
    );
  }
  return { id, mesh, names: table.names, topology };
}

/**
 * A sphere of about `targetTriangles` triangles, split into
 * `patchesU` x `patchesV` faces with edges along the patch borders, for
 * performance measurements. No topology and no names (placeholders).
 */
export function denseSphereBody(
  targetTriangles: number,
  options: { id?: string; radius?: number; patchesU?: number; patchesV?: number } = {},
): BodyInput {
  const id = options.id ?? 'dense';
  const r = options.radius ?? 50;
  const pu = options.patchesU ?? 24;
  const pv = options.patchesV ?? 12;
  // Cells per patch so that 2 * cells >= target, keeping patches square-ish.
  const cellsPerPatch = Math.max(1, Math.ceil(Math.sqrt(targetTriangles / (2 * pu * pv))));
  const nu = pu * cellsPerPatch;
  const nv = pv * cellsPerPatch;
  const point = (i: number, j: number): Vec3 => {
    const theta = (2 * Math.PI * i) / nu;
    const phi = (Math.PI * j) / nv;
    return [
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi),
    ];
  };

  const vertsPerPatch = (cellsPerPatch + 1) ** 2;
  const trisPerPatch = cellsPerPatch * cellsPerPatch * 2;
  const faceCount = pu * pv;
  const positions = new Float32Array(faceCount * vertsPerPatch * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(faceCount * trisPerPatch * 3);
  const faceRanges = new Uint32Array(faceCount * 2);
  const triangleFaces = new Uint32Array(faceCount * trisPerPatch);
  let v = 0;
  let t = 0;
  for (let a = 0; a < pu; a++) {
    for (let b = 0; b < pv; b++) {
      const face = a * pv + b + 1;
      const base = v;
      for (let j = 0; j <= cellsPerPatch; j++) {
        for (let i = 0; i <= cellsPerPatch; i++) {
          const p = point(a * cellsPerPatch + i, b * cellsPerPatch + j);
          positions.set(p, v * 3);
          normals.set([p[0] / r, p[1] / r, p[2] / r], v * 3);
          v++;
        }
      }
      faceRanges[(face - 1) * 2] = t * 3;
      faceRanges[(face - 1) * 2 + 1] = trisPerPatch * 3;
      const row = cellsPerPatch + 1;
      for (let j = 0; j < cellsPerPatch; j++) {
        for (let i = 0; i < cellsPerPatch; i++) {
          const q = base + j * row + i;
          // phi grows downwards from +Z, theta around +Z: this winding faces outwards.
          indices.set([q, q + row, q + 1, q + 1, q + row, q + row + 1], t * 3);
          triangleFaces[t] = face;
          triangleFaces[t + 1] = face;
          t += 2;
        }
      }
    }
  }

  const polylines: Vec3[][] = [];
  for (let a = 0; a < pu; a++) {
    // Meridian segment per patch row.
    for (let b = 0; b < pv; b++) {
      const line: Vec3[] = [];
      for (let j = 0; j <= cellsPerPatch; j++)
        line.push(point(a * cellsPerPatch, b * cellsPerPatch + j));
      polylines.push(line);
    }
  }
  for (let b = 1; b < pv; b++) {
    // Parallels between patch rows (none at the poles, where they would be points).
    for (let a = 0; a < pu; a++) {
      const line: Vec3[] = [];
      for (let i = 0; i <= cellsPerPatch; i++)
        line.push(point(a * cellsPerPatch + i, b * cellsPerPatch));
      polylines.push(line);
    }
  }
  const edgeRanges = new Uint32Array(polylines.length * 2);
  const edgePositions = new Float32Array(polylines.reduce((n, l) => n + l.length, 0) * 3);
  let p = 0;
  polylines.forEach((line, e) => {
    edgeRanges[e * 2] = p;
    edgeRanges[e * 2 + 1] = line.length;
    for (const q of line) edgePositions.set(q, 3 * p++);
  });

  const mesh: MeshData = {
    positions,
    normals,
    indices,
    faceRanges,
    triangleFaces,
    edgePositions,
    edgeRanges,
    faceNames: new Uint32Array(faceCount).fill(UNNAMED),
    faceFragile: new Uint8Array(faceCount),
    edgeNames: new Uint32Array(polylines.length).fill(UNNAMED),
    edgeFragile: new Uint8Array(polylines.length),
  };
  return { id, mesh, names: [] };
}

function packMesh(m: {
  positions: number[];
  normals: number[];
  indices: number[];
  faceRanges: number[];
  triangleFaces: number[];
  edgePositions: number[];
  edgeRanges: number[];
}): MeshData {
  const faces = m.faceRanges.length / 2;
  const edges = m.edgeRanges.length / 2;
  return {
    positions: new Float32Array(m.positions),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.indices),
    faceRanges: new Uint32Array(m.faceRanges),
    triangleFaces: new Uint32Array(m.triangleFaces),
    edgePositions: new Float32Array(m.edgePositions),
    edgeRanges: new Uint32Array(m.edgeRanges),
    faceNames: new Uint32Array(faces).fill(UNNAMED),
    faceFragile: new Uint8Array(faces),
    edgeNames: new Uint32Array(edges).fill(UNNAMED),
    edgeFragile: new Uint8Array(edges),
  };
}
