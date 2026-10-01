// Hand-built meshes for the print tests, laid out like the kernel's `MeshData`: vertices are not
// shared between faces, normals are per vertex and stored in a Float32Array (so tests see the
// precision real meshes have), faces are numbered from 1.

import type { MeshData } from '@manufakture/kernel';
import { applyPlacement, rotateDirection, type Placement, type Vec3 } from './geometry';

export const deg = (d: number) => (d * Math.PI) / 180;

/** One planar face: a simple polygon, counter-clockwise seen from outside, and its outward normal. */
export interface TestFace {
  points: Vec3[];
  normal: Vec3;
}

export type TestMesh = Pick<
  MeshData,
  'positions' | 'normals' | 'indices' | 'faceRanges' | 'triangleFaces'
>;

/** A mesh from planar faces, each triangulated by ear clipping. */
export function meshFromFaces(faces: readonly TestFace[]): TestMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: number[] = [];
  const triangleFaces: number[] = [];
  faces.forEach((face, f) => {
    const base = positions.length / 3;
    for (const p of face.points) {
      positions.push(...p);
      normals.push(...face.normal);
    }
    const first = indices.length;
    for (const [a, b, c] of earClip(face.points, face.normal)) {
      indices.push(base + a, base + b, base + c);
      triangleFaces.push(f + 1);
    }
    faceRanges.push(first, indices.length - first);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges: new Uint32Array(faceRanges),
    triangleFaces: new Uint32Array(triangleFaces),
  };
}

/** The faces moved by a placement (positions and normals in float64, before float32 storage). */
export function placeFaces(faces: readonly TestFace[], placement: Placement): TestFace[] {
  return faces.map((f) => ({
    points: f.points.map((p) => applyPlacement(placement, p)),
    normal: rotateDirection(placement, f.normal),
  }));
}

/** An axis-aligned box from `min` to `max`. */
export function boxFaces(min: Vec3, max: Vec3): TestFace[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    {
      normal: [0, 0, -1],
      points: [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
    },
    {
      normal: [0, 0, 1],
      points: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    },
    {
      normal: [0, -1, 0],
      points: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
    },
    {
      normal: [0, 1, 0],
      points: [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
    },
    {
      normal: [-1, 0, 0],
      points: [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
    },
    {
      normal: [1, 0, 0],
      points: [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
    },
  ];
}

/**
 * A prism: `profile`, a simple polygon in the x-z plane listed counter-clockwise (x right, z up),
 * extruded along y from 0 to `depth`. Faces: the side of each profile edge in order (edge i runs
 * from point i to point i + 1, so it is face i + 1), then the cap at y = 0, then the cap at
 * y = depth. Side normals are exact: the edge (dx, dz) has outward normal (dz, 0, -dx).
 */
export function prismFaces(profile: readonly [number, number][], depth: number): TestFace[] {
  const faces: TestFace[] = [];
  for (let i = 0; i < profile.length; i++) {
    const [ax, az] = profile[i]!;
    const [bx, bz] = profile[(i + 1) % profile.length]!;
    const l = Math.hypot(bx - ax, bz - az);
    faces.push({
      normal: [(bz - az) / l, 0, -(bx - ax) / l],
      points: [
        [ax, 0, az],
        [ax, depth, az],
        [bx, depth, bz],
        [bx, 0, bz],
      ],
    });
  }
  faces.push({ normal: [0, -1, 0], points: profile.map(([x, z]) => [x, 0, z] as Vec3) });
  faces.push({
    normal: [0, 1, 0],
    points: [...profile].reverse().map(([x, z]) => [x, depth, z] as Vec3),
  });
  return faces;
}

/** Triangles of a simple polygon (ear clipping), wound counter-clockwise about `normal`. */
function earClip(points: readonly Vec3[], normal: Vec3): [number, number, number][] {
  // Project onto the plane's two dominant axes, keeping the orientation about the normal.
  const ax = Math.abs(normal[0]),
    ay = Math.abs(normal[1]),
    az = Math.abs(normal[2]);
  const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const sign = Math.sign(normal[az >= ax && az >= ay ? 2 : ax >= ay ? 0 : 1]);
  const p = points.map((q) => [q[u]!, q[v]! * sign] as const);
  const area = (a: number, b: number, c: number) =>
    (p[b]![0] - p[a]![0]) * (p[c]![1] - p[a]![1]) - (p[b]![1] - p[a]![1]) * (p[c]![0] - p[a]![0]);
  const left = points.map((_, i) => i);
  const out: [number, number, number][] = [];
  let guard = 0;
  while (left.length > 3 && guard++ < 1000) {
    for (let i = 0; i < left.length; i++) {
      const a = left[(i + left.length - 1) % left.length]!;
      const b = left[i]!;
      const c = left[(i + 1) % left.length]!;
      if (area(a, b, c) <= 0) continue;
      const blocked = left.some(
        (k) =>
          k !== a &&
          k !== b &&
          k !== c &&
          area(a, b, k) >= 0 &&
          area(b, c, k) >= 0 &&
          area(c, a, k) >= 0,
      );
      if (blocked) continue;
      out.push([a, b, c]);
      left.splice(i, 1);
      break;
    }
  }
  if (left.length === 3) out.push([left[0]!, left[1]!, left[2]!]);
  return out;
}
