// The dimension model prototype (decision 7): a dimension stores model references, never drawing
// geometry. Regen resolves the references against the current model with the kernel's naming
// (the same `resolve` / `resolveVertex` feature references use), reads their exact geometry with
// `measure`, and projects it with the view's frame (views.ts), so the dimension follows edits.

import type { Kernel } from '../../../packages/kernel/src/kernel';
import { resolveVertex, type VertexRef } from '../../../packages/kernel/src/features';
import {
  resolve,
  type EdgeRef,
  type FaceRef,
  type Resolution,
} from '../../../packages/kernel/src/naming';
import type { ShapeId } from '../../../packages/kernel/src/types';
import { dot, frameOf, project, sub, unit, cross, type Vec2, type Vec3, type View } from './views';

/** What a dimension end or target refers to. */
export type DimRef =
  | { vertex: VertexRef }
  /** A line edge (its end points), or a circular edge (its centre, radius and axis). */
  | { edge: EdgeRef }
  /** A plane, or a cylinder (its axis and radius; in a view, its silhouettes or circle). */
  | { face: FaceRef };

export type Dimension =
  | { kind: 'horizontal' | 'vertical' | 'aligned'; from: DimRef; to: DimRef }
  | { kind: 'diameter' | 'radius'; of: DimRef };

/** What a reference resolved to, in 3D. */
export type RefGeometry =
  | { kind: 'point'; point: Vec3 }
  | { kind: 'segment'; a: Vec3; b: Vec3 }
  | { kind: 'circle'; center: Vec3; axis: Vec3; radius: number }
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number }
  | { kind: 'plane'; point: Vec3; normal: Vec3 };

export type DimensionStatus = 'exact' | 'fragile' | 'lost' | 'ambiguous';

export interface ResolvedDimension {
  status: DimensionStatus;
  /** Why the value is not true length in this view, or other caveats. */
  warnings: string[];
  /** The value as drawn (model mm), null when a reference is lost or ambiguous. */
  value: number | null;
  /** Projected anchor geometry the drawing package lays the dimension out from. */
  anchors:
    | { kind: 'points'; a: Vec2; b: Vec2 }
    | { kind: 'circle'; center: Vec2; radius: number }
    | { kind: 'silhouettes'; a: [Vec2, Vec2]; b: [Vec2, Vec2] }
    | null;
}

function statusOf(r: Resolution): DimensionStatus {
  if (!r.ok) return r.status;
  return r.fragile ? 'fragile' : 'exact';
}

/** Resolve one reference on a named body and read its geometry. */
export function resolveRef(
  k: Kernel,
  shape: ShapeId,
  ref: DimRef,
): { status: DimensionStatus; geometry: RefGeometry | null } {
  const named = k.named(shape);
  if (!named) return { status: 'lost', geometry: null };
  const { names, topology } = named;
  if ('vertex' in ref) {
    const r = resolveVertex(names, topology, ref.vertex);
    if (!r.ok) return { status: statusOf(r), geometry: null };
    return {
      status: statusOf(r),
      geometry: { kind: 'point', point: topology.vertices[r.index - 1]!.point },
    };
  }
  const r = resolve(names, topology, 'edge' in ref ? ref.edge : ref.face);
  if (!r.ok) return { status: statusOf(r), geometry: null };
  const kind = 'edge' in ref ? ('edge' as const) : ('face' as const);
  const item = k.measure(shape, [{ kind, index: r.index }]).items[0]!;
  if (!item.ok) return { status: 'lost', geometry: null };
  let geometry: RefGeometry | null = null;
  if (item.kind === 'edge') {
    if (item.circle)
      geometry = {
        kind: 'circle',
        center: item.circle.center,
        axis: item.circle.axis,
        radius: item.circle.radius,
      };
    else if (item.start && item.end) geometry = { kind: 'segment', a: item.start, b: item.end };
  } else if (item.kind === 'face') {
    if (item.surface === 'cylinder' && item.axis && item.radius !== null) {
      geometry = {
        kind: 'cylinder',
        origin: item.axis.origin,
        axis: item.axis.direction,
        radius: item.radius,
      };
    } else if (item.surface === 'plane' && item.normal) {
      geometry = { kind: 'plane', point: item.centroid, normal: item.normal };
    }
  }
  return { status: statusOf(r), geometry };
}

const worst = (a: DimensionStatus, b: DimensionStatus): DimensionStatus => {
  const order: DimensionStatus[] = ['exact', 'fragile', 'ambiguous', 'lost'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
};

/** The point a linear dimension measures to: a vertex, a circle's centre, a segment's midpoint. */
function anchorPoint(g: RefGeometry): Vec3 | null {
  if (g.kind === 'point') return g.point;
  if (g.kind === 'circle') return g.center;
  if (g.kind === 'segment')
    return [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2, (g.a[2] + g.b[2]) / 2];
  return null;
}

/** Resolve a dimension on a body and place it in a view. */
export function resolveDimension(
  k: Kernel,
  shape: ShapeId,
  dim: Dimension,
  view: View,
): ResolvedDimension {
  const frame = frameOf(view);
  const warnings: string[] = [];
  if ('of' in dim) {
    const r = resolveRef(k, shape, dim.of);
    if (r.geometry === null) return { status: r.status, warnings, value: null, anchors: null };
    const g = r.geometry;
    const factor = dim.kind === 'diameter' ? 2 : 1;
    if (g.kind === 'circle' || g.kind === 'cylinder') {
      const axis = g.axis;
      const along = Math.abs(dot(unit(axis), frame.z));
      const center = project(frame, g.kind === 'circle' ? g.center : g.origin).at;
      if (Math.abs(1 - along) < 1e-9) {
        return {
          status: r.status,
          warnings,
          value: factor * g.radius,
          anchors: { kind: 'circle', center, radius: g.radius },
        };
      }
      if (g.kind === 'circle') warnings.push('circle not seen true size in this view');
      if (g.kind === 'cylinder' && along < 1e-9) {
        // Seen from the side: two silhouette lines, r either side of the projected axis.
        const n = unit(cross(axis, frame.z));
        const off: Vec2 = [dot(n, frame.x) * g.radius, dot(n, frame.y) * g.radius];
        const d: Vec2 = [dot(axis, frame.x), dot(axis, frame.y)];
        const line = (s: number): [Vec2, Vec2] => [
          [center[0] + s * off[0], center[1] + s * off[1]],
          [center[0] + s * off[0] + d[0], center[1] + s * off[1] + d[1]],
        ];
        return {
          status: r.status,
          warnings,
          value: factor * g.radius,
          anchors: { kind: 'silhouettes', a: line(1), b: line(-1) },
        };
      }
      if (g.kind === 'cylinder') warnings.push('cylinder axis oblique to the view');
      return {
        status: r.status,
        warnings,
        value: factor * g.radius,
        anchors: { kind: 'circle', center, radius: g.radius },
      };
    }
    return {
      status: r.status,
      warnings: ['not a circle or a cylinder'],
      value: null,
      anchors: null,
    };
  }
  const a = resolveRef(k, shape, dim.from);
  const b = resolveRef(k, shape, dim.to);
  const status = worst(a.status, b.status);
  if (a.geometry === null || b.geometry === null)
    return { status, warnings, value: null, anchors: null };
  const pa3 = anchorPoint(a.geometry);
  const pb3 = anchorPoint(b.geometry);
  if (!pa3 || !pb3)
    return { status, warnings: ['reference has no anchor point'], value: null, anchors: null };
  const pa = project(frame, pa3).at;
  const pb = project(frame, pb3).at;
  const value =
    dim.kind === 'horizontal'
      ? Math.abs(pb[0] - pa[0])
      : dim.kind === 'vertical'
        ? Math.abs(pb[1] - pa[1])
        : Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  // True length only when the measured direction lies in the paper plane.
  const d = sub(pb3, pa3);
  const depth = Math.abs(dot(d, frame.z));
  if (dim.kind === 'aligned' && depth > 1e-9)
    warnings.push('foreshortened: the points differ in depth');
  return { status, warnings, value, anchors: { kind: 'points', a: pa, b: pb } };
}
