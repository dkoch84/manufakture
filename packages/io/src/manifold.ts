// Watertightness of a triangle mesh, the check every exported mesh passes:
// each edge is shared by exactly two triangles that run it in opposite
// directions (closed, manifold, consistently wound), no triangle is
// degenerate, and the enclosed volume is positive (wound outward).

import { cross, meshProperties, sub, type TriMesh, type Vec3 } from './mesh';

export interface ManifoldReport {
  /** Closed, manifold, consistently wound, no degenerate triangles, positive volume. */
  ok: boolean;
  triangles: number;
  /** Undirected edges. */
  edges: number;
  /** Edges with only one triangle: holes in the surface. */
  boundaryEdges: number;
  /** Edges with more than two triangles. */
  nonManifoldEdges: number;
  /** Edges two triangles run in the same direction: a triangle wound the wrong way. */
  inconsistentEdges: number;
  /** Triangles with a repeated vertex or (next to) zero area. */
  degenerateTriangles: number;
  /** The enclosed volume, mm3: negative for a mesh wound inside out. */
  volume: number;
  /** Readable reasons `ok` is false; empty when it is true. */
  problems: string[];
}

export interface ManifoldOptions {
  /** A triangle with less area than this (mm2) is degenerate. Default 1e-12. */
  minArea?: number;
}

/** Check a welded mesh (see `weld`): an unwelded soup has every edge open. */
export function checkManifold(mesh: TriMesh, options: ManifoldOptions = {}): ManifoldReport {
  const minArea = options.minArea ?? 1e-12;
  const idx = mesh.indices;
  const p = mesh.positions;
  const triangles = Math.floor(idx.length / 3);
  // Directed edge counts, keyed by a * n + b (exact in float64 below 2^53).
  const n = p.length / 3;
  const directed = new Map<number, number>();
  let degenerate = 0;
  const point = (i: number): Vec3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
  for (let t = 0; t < triangles; t++) {
    const a = idx[t * 3]!;
    const b = idx[t * 3 + 1]!;
    const c = idx[t * 3 + 2]!;
    if (a === b || b === c || c === a || a >= n || b >= n || c >= n) {
      degenerate++;
      continue;
    }
    const pa = point(a);
    const cr = cross(sub(point(b), pa), sub(point(c), pa));
    if (Math.hypot(cr[0], cr[1], cr[2]) / 2 < minArea) degenerate++;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = u * n + v;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let edges = 0;
  let boundary = 0;
  let nonManifold = 0;
  let inconsistent = 0;
  const seen = new Set<number>();
  for (const [k, forward] of directed) {
    const u = Math.floor(k / n);
    const v = k - u * n;
    const lo = Math.min(u, v);
    const hi = Math.max(u, v);
    const undirected = lo * n + hi;
    if (seen.has(undirected)) continue;
    seen.add(undirected);
    edges++;
    const backward = directed.get(v * n + u) ?? 0;
    const total = forward + backward;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (forward !== 1 || backward !== 1) inconsistent++;
  }
  const volume = meshProperties(mesh).volume;
  const problems: string[] = [];
  if (triangles === 0) problems.push('the mesh has no triangles');
  if (boundary > 0) problems.push(`${boundary} open edge(s): the surface has holes`);
  if (nonManifold > 0) problems.push(`${nonManifold} edge(s) shared by more than two triangles`);
  if (inconsistent > 0) problems.push(`${inconsistent} edge(s) with inconsistent winding`);
  if (degenerate > 0) problems.push(`${degenerate} degenerate triangle(s)`);
  if (triangles > 0 && !(volume > 0)) problems.push('the triangles face inward (volume <= 0)');
  return {
    ok: problems.length === 0,
    triangles,
    edges,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    degenerateTriangles: degenerate,
    volume,
    problems,
  };
}
