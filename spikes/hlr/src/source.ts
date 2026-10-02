// From HLR output back to model edges, and picking in a view.
//
// HLR does not say which model edge a result edge came from (the bound API has no such link).
// Two ways to get it, both measured in assoc.test.ts:
// - by 3D geometry: `projectExact(..., { source: true })` reads every class a second time in 3D;
//   a piece of a sharp, smooth or sewn edge lies on a model edge, so the nearest model edge in 3D
//   (here: its mesh polyline) is its source. Outline pieces lie on faces, not edges.
// - by 2D picking, the plan's method (decision 7): project the model's edge polylines (the mesh's
//   `edgePositions`) into the view and take the nearest to the click.

import type { Kernel } from '../../../packages/kernel/src/kernel';
import type { ShapeId } from '../../../packages/kernel/src/types';
import { project, type Vec2, type Vec3, type ViewFrame } from './views';

/** A model edge: which body (index into the view's bodies) and which edge (1-based, MapShapes order). */
export interface EdgeKey {
  body: number;
  edge: number;
}

export interface ModelEdge extends EdgeKey {
  points: Vec3[];
}

/** Every edge of the bodies as 3D polylines, from the kernel's mesh at `linear` deflection. */
export function modelEdges(k: Kernel, bodies: readonly ShapeId[], linear: number): ModelEdge[] {
  const out: ModelEdge[] = [];
  bodies.forEach((id, body) => {
    const mesh = k.mesh(id, { linear, angular: 0.5 });
    for (let e = 0; e < mesh.edgeRanges.length / 2; e++) {
      const first = mesh.edgeRanges[2 * e]!;
      const count = mesh.edgeRanges[2 * e + 1]!;
      const points: Vec3[] = [];
      for (let i = first; i < first + count; i++) {
        points.push([
          mesh.edgePositions[3 * i]!,
          mesh.edgePositions[3 * i + 1]!,
          mesh.edgePositions[3 * i + 2]!,
        ]);
      }
      if (points.length > 0) out.push({ body, edge: e + 1, points });
    }
  });
  return out;
}

function closest3(p: Vec3, a: Vec3, b: Vec3): { d: number; t: number } {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t =
    len2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2,
          ),
        );
  return {
    d: Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1], p[2] - a[2] - t * ab[2]),
    t,
  };
}

export function distToPolyline3(p: Vec3, poly: readonly Vec3[]): number {
  if (poly.length === 1)
    return Math.hypot(p[0] - poly[0]![0], p[1] - poly[0]![1], p[2] - poly[0]![2]);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++)
    best = Math.min(best, closest3(p, poly[i - 1]!, poly[i]!).d);
  return best;
}

/**
 * The source of a 3D piece: the model edges every point of it is within `tol` of. Several when
 * edges coincide in 3D (two boards touching along an edge); none for outlines.
 */
export function sourceOf(
  piece: readonly Vec3[],
  edges: readonly ModelEdge[],
  tol: number,
): EdgeKey[] {
  const out: EdgeKey[] = [];
  for (const e of edges) {
    if (piece.every((p) => distToPolyline3(p, e.points) <= tol))
      out.push({ body: e.body, edge: e.edge });
  }
  return out;
}

export interface ProjectedModelEdge extends EdgeKey {
  /** 2D polyline and the depth (toward the viewer) of each point. */
  points: Vec2[];
  depth: number[];
}

export function projectModelEdges(
  edges: readonly ModelEdge[],
  frame: ViewFrame,
): ProjectedModelEdge[] {
  return edges.map((e) => {
    const pr = e.points.map((p) => project(frame, p));
    return {
      body: e.body,
      edge: e.edge,
      points: pr.map((q) => q.at),
      depth: pr.map((q) => q.depth),
    };
  });
}

function closest2(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t };
}

/** Distance from p to a projected edge, and the depth of the closest point on it. */
function hit(p: Vec2, e: ProjectedModelEdge): { d: number; depth: number } {
  let best = { d: Infinity, depth: -Infinity };
  if (e.points.length === 1)
    return { d: Math.hypot(p[0] - e.points[0]![0], p[1] - e.points[0]![1]), depth: e.depth[0]! };
  for (let i = 1; i < e.points.length; i++) {
    const c = closest2(p, e.points[i - 1]!, e.points[i]!);
    if (c.d < best.d)
      best = { d: c.d, depth: e.depth[i - 1]! + c.t * (e.depth[i]! - e.depth[i - 1]!) };
  }
  return best;
}

/** Picking, the plan's way: the projected model edge nearest to `p` in 2D. */
export function pickNearest(p: Vec2, edges: readonly ProjectedModelEdge[]): EdgeKey | null {
  let best: ProjectedModelEdge | null = null;
  let bestD = Infinity;
  for (const e of edges) {
    const h = hit(p, e);
    if (h.d < bestD) {
      bestD = h.d;
      best = e;
    }
  }
  return best && { body: best.body, edge: best.edge };
}

/**
 * Picking with a depth tie-break: among projected edges within `tol` of the nearest one's
 * distance, the one closest to the viewer at the click.
 */
export function pickNearestFront(
  p: Vec2,
  edges: readonly ProjectedModelEdge[],
  tol: number,
): EdgeKey | null {
  const hits = edges.map((e) => ({ e, ...hit(p, e) }));
  const dmin = Math.min(...hits.map((h) => h.d));
  const near = hits.filter((h) => h.d <= dmin + tol);
  near.sort((a, b) => b.depth - a.depth);
  const best = near[0];
  return best ? { body: best.e.body, edge: best.e.edge } : null;
}
