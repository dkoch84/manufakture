// Test-only meshes; not exported from the package.

import type { TriMesh } from './mesh';

/** An axis-aligned box as 12 triangles over 8 shared vertices, wound outward. */
export function boxMesh(min: [number, number, number] = [0, 0, 0], size = [1, 1, 1]): TriMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = [x0 + size[0]!, y0 + size[1]!, z0 + size[2]!];
  // prettier-ignore
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1,  0, 3, 2, // bottom (-z)
    4, 5, 6,  4, 6, 7, // top (+z)
    0, 1, 5,  0, 5, 4, // front (-y)
    2, 3, 7,  2, 7, 6, // back (+y)
    1, 2, 6,  1, 6, 5, // right (+x)
    3, 0, 4,  3, 4, 7, // left (-x)
  ]);
  return { positions, indices };
}

/** The same box with every triangle's corners copied: what a kernel mesh looks like. */
export function soupOf(mesh: TriMesh): TriMesh {
  const positions = new Float32Array(mesh.indices.length * 3);
  mesh.indices.forEach((v, i) => positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3));
  return { positions, indices: Uint32Array.from(mesh.indices, (_, i) => i) };
}
