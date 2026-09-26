// Indexed triangle meshes for export and mesh import: welding, merging and
// mass properties. Plain typed arrays, no kernel dependency: a kernel
// `MeshData` fits `TriangleSoup` as it is.

/** Triangles over shared vertices: xyz per vertex, three vertex indices per triangle. */
export interface TriMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Any indexed triangles, vertices shared or not. A kernel mesh keeps a
 * separate copy of every vertex per B-rep face, so it must be welded before
 * its edges can be matched up.
 */
export interface TriangleSoup {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/** A mesh with the name it is exported or was imported under. */
export interface NamedMesh {
  name: string;
  mesh: TriMesh;
}

/**
 * Vertices closer than this (mm) are one vertex when welding. Far below any
 * export tolerance, far above float32 noise at part sizes (about 4e-6 mm at
 * 60 mm).
 */
export const DEFAULT_WELD_TOLERANCE = 1e-4;

export interface WeldOptions {
  /** mm; default `DEFAULT_WELD_TOLERANCE`. */
  tolerance?: number;
}

/**
 * Merge vertices that lie within `tolerance` of each other, then drop the
 * triangles welding collapsed (two corners on one vertex). The first vertex
 * of a cluster keeps its position. Triangle order and winding are kept.
 */
export function weld(soup: TriangleSoup, options: WeldOptions = {}): TriMesh {
  const tol = options.tolerance ?? DEFAULT_WELD_TOLERANCE;
  if (!(tol > 0)) throw new RangeError('the weld tolerance must be positive');
  const src = soup.positions;
  const count = Math.floor(src.length / 3);
  const cells = new Map<string, number[]>();
  const remap = new Uint32Array(count);
  const out: number[] = [];
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let v = 0; v < count; v++) {
    const x = src[v * 3]!;
    const y = src[v * 3 + 1]!;
    const z = src[v * 3 + 2]!;
    const cx = Math.floor(x / tol);
    const cy = Math.floor(y / tol);
    const cz = Math.floor(z / tol);
    let found = -1;
    // A point within tol lies in this cell or a neighbouring one.
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const w of bucket) {
            const ex = out[w * 3]! - x;
            const ey = out[w * 3 + 1]! - y;
            const ez = out[w * 3 + 2]! - z;
            if (ex * ex + ey * ey + ez * ez <= tol * tol) {
              found = w;
              break search;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const k = key(cx, cy, cz);
      const bucket = cells.get(k);
      if (bucket) bucket.push(found);
      else cells.set(k, [found]);
    }
    remap[v] = found;
  }
  const idx = soup.indices;
  const tris: number[] = [];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = remap[idx[t]!]!;
    const b = remap[idx[t + 1]!]!;
    const c = remap[idx[t + 2]!]!;
    if (a === b || b === c || c === a) continue;
    tris.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(tris) };
}

/** One mesh of several: vertices appended, indices shifted. */
export function mergeMeshes(meshes: readonly TriMesh[]): TriMesh {
  let vertices = 0;
  let indices = 0;
  for (const m of meshes) {
    vertices += m.positions.length;
    indices += m.indices.length;
  }
  const positions = new Float32Array(vertices);
  const out = new Uint32Array(indices);
  let vBase = 0;
  let iBase = 0;
  for (const m of meshes) {
    positions.set(m.positions, vBase);
    const shift = vBase / 3;
    for (let i = 0; i < m.indices.length; i++) out[iBase + i] = m.indices[i]! + shift;
    vBase += m.positions.length;
    iBase += m.indices.length;
  }
  return { positions, indices: out };
}

export type Vec3 = [number, number, number];

export interface MeshProperties {
  /** mm3; negative when the triangles face inward. Only meaningful for a closed mesh. */
  volume: number;
  /** mm2. */
  area: number;
  /** Centre of the enclosed volume, or null when it is zero. */
  centerOfMass: Vec3 | null;
  boundingBox: { min: Vec3; max: Vec3 } | null;
  triangles: number;
  vertices: number;
}

/**
 * Volume (divergence theorem over the triangles), surface area, centre of
 * mass and bounding box. Sums in float64 relative to the first vertex, so a
 * part far from the origin loses no precision.
 */
export function meshProperties(mesh: TriMesh): MeshProperties {
  const p = mesh.positions;
  const idx = mesh.indices;
  const vertices = p.length / 3;
  if (vertices === 0) {
    return {
      volume: 0,
      area: 0,
      centerOfMass: null,
      boundingBox: null,
      triangles: 0,
      vertices: 0,
    };
  }
  const o: Vec3 = [p[0]!, p[1]!, p[2]!];
  let volume = 0;
  let area = 0;
  const moment: Vec3 = [0, 0, 0];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = at(p, idx[t]!, o);
    const b = at(p, idx[t + 1]!, o);
    const c = at(p, idx[t + 2]!, o);
    const n = cross(sub(b, a), sub(c, a));
    area += Math.hypot(n[0], n[1], n[2]) / 2;
    // Signed volume of the tetrahedron (origin o, a, b, c).
    const v = dot(a, cross(b, c)) / 6;
    volume += v;
    for (let k = 0; k < 3; k++) moment[k]! += (v * (a[k]! + b[k]! + c[k]!)) / 4;
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = p[i + k]!;
      if (x < min[k]!) min[k] = x;
      if (x > max[k]!) max[k] = x;
    }
  }
  const centerOfMass: Vec3 | null =
    Math.abs(volume) > 0
      ? [o[0] + moment[0] / volume, o[1] + moment[1] / volume, o[2] + moment[2] / volume]
      : null;
  return {
    volume,
    area,
    centerOfMass,
    boundingBox: { min, max },
    triangles: idx.length / 3,
    vertices,
  };
}

function at(p: Float32Array, i: number, o: Vec3): Vec3 {
  return [p[i * 3]! - o[0], p[i * 3 + 1]! - o[1], p[i * 3 + 2]! - o[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
