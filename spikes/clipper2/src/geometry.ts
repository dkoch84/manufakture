// Exact line/arc geometry for the T5.0a spike: the source loops (from
// `detectRegions` or built by hand), their flattening into tagged polylines for
// Clipper2, and the exact distances the correctness metrics need.
//
// Units are millimetres. A shape is a region: a counter-clockwise outer loop and
// clockwise holes, so the region always lies on the left of every curve.

import type { Region, RegionCurve, RegionLoop } from '@manufakture/sketch/geometry';

export type P = readonly [number, number];

export type Curve =
  | { kind: 'line'; a: P; b: P; entityId: string }
  /** `sweep` is signed: positive counter-clockwise; a full circle is +-2 pi. */
  | { kind: 'arc'; c: P; r: number; a0: number; sweep: number; entityId: string };

export interface Shape {
  /** Counter-clockwise outer loop, then clockwise holes. */
  loops: Curve[][];
}

const TAU = 2 * Math.PI;

export const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
export const dist = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function curveStart(c: Curve): P {
  return c.kind === 'line' ? c.a : [c.c[0] + c.r * Math.cos(c.a0), c.c[1] + c.r * Math.sin(c.a0)];
}

export function curveEnd(c: Curve): P {
  if (c.kind === 'line') return c.b;
  const a = c.a0 + c.sweep;
  return [c.c[0] + c.r * Math.cos(a), c.c[1] + c.r * Math.sin(a)];
}

export function curveLength(c: Curve): number {
  return c.kind === 'line' ? dist(c.a, c.b) : Math.abs(c.sweep) * c.r;
}

/** Point at parameter t in [0, 1]. */
export function curvePoint(c: Curve, t: number): P {
  if (c.kind === 'line') return [c.a[0] + t * (c.b[0] - c.a[0]), c.a[1] + t * (c.b[1] - c.a[1])];
  const a = c.a0 + t * c.sweep;
  return [c.c[0] + c.r * Math.cos(a), c.c[1] + c.r * Math.sin(a)];
}

/** Unit tangent in the direction of travel at parameter t. */
export function curveTangent(c: Curve, t: number): P {
  if (c.kind === 'line') {
    const l = dist(c.a, c.b);
    return [(c.b[0] - c.a[0]) / l, (c.b[1] - c.a[1]) / l];
  }
  const a = c.a0 + t * c.sweep;
  const s = Math.sign(c.sweep);
  return [-Math.sin(a) * s, Math.cos(a) * s];
}

/** Outward normal (the region lies on the left, so outward is the right of the tangent). */
export function curveNormal(c: Curve, t: number): P {
  const [tx, ty] = curveTangent(c, t);
  return [ty, -tx];
}

const normAngle = (a: number): number => ((a % TAU) + TAU) % TAU;

/** Is angle `a` within the arc's sweep? */
export function angleOnArc(a0: number, sweep: number, a: number): boolean {
  if (Math.abs(sweep) >= TAU - 1e-12) return true;
  const d = sweep > 0 ? normAngle(a - a0) : normAngle(a0 - a);
  return d <= Math.abs(sweep) + 1e-12;
}

export function distToSegment(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function distToArc(p: P, c: P, r: number, a0: number, sweep: number): number {
  const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
  if (angleOnArc(a0, sweep, a)) return Math.abs(dist(p, c) - r);
  const s: P = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
  const e: P = [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)];
  return Math.min(dist(p, s), dist(p, e));
}

export function distToCurve(p: P, c: Curve): number {
  return c.kind === 'line' ? distToSegment(p, c.a, c.b) : distToArc(p, c.c, c.r, c.a0, c.sweep);
}

export function distToShape(p: P, shape: Shape): number {
  let best = Infinity;
  for (const loop of shape.loops) for (const c of loop) best = Math.min(best, distToCurve(p, c));
  return best;
}

/** Exact signed area of a loop of lines and arcs (positive counter-clockwise). */
export function loopArea(loop: readonly Curve[]): number {
  let a = 0;
  for (const c of loop) {
    const s = curveStart(c);
    const e = curveEnd(c);
    a += (s[0] * e[1] - e[0] * s[1]) / 2;
    if (c.kind === 'arc') {
      // Circular segment between the chord and the arc, signed with the sweep.
      a += (c.r * c.r * (c.sweep - Math.sin(c.sweep))) / 2;
    }
  }
  return a;
}

export function shapeArea(shape: Shape): number {
  return shape.loops.reduce((s, l) => s + loopArea(l), 0);
}

// From packages/sketch regions ---------------------------------------------------------

function fromRegionCurve(c: RegionCurve): Curve {
  if (c.kind === 'line') return { kind: 'line', a: c.start, b: c.end, entityId: c.entityId };
  if (c.kind === 'bezier') throw new Error('Bezier curves are out of scope for this spike');
  const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
  if (c.kind === 'circle') {
    return {
      kind: 'arc',
      c: c.center,
      r: c.radius,
      a0,
      sweep: c.reversed ? -TAU : TAU,
      entityId: c.entityId,
    };
  }
  const a1 = Math.atan2(c.end[1] - c.center[1], c.end[0] - c.center[0]);
  const ccw = normAngle(a1 - a0) || TAU;
  const sweep = c.reversed ? -(normAngle(a0 - a1) || TAU) : ccw;
  return { kind: 'arc', c: c.center, r: c.radius, a0, sweep, entityId: c.entityId };
}

const fromRegionLoop = (l: RegionLoop): Curve[] => l.curves.map(fromRegionCurve);

export function shapeFromRegion(region: Region): Shape {
  return { loops: [fromRegionLoop(region.outer), ...region.holes.map(fromRegionLoop)] };
}

// Flattening into tagged polylines ------------------------------------------------------

/** What a Clipper Z tag stands for: one source vertex of the flattened loops. */
export interface VertexInfo {
  point: P;
  loop: number;
  /** The curves the vertex lies on: one, or two where one curve ends and the next starts. */
  curves: number[];
  /** Where two curves meet at an angle (not tangent), so the offset has a round join here. */
  corner: boolean;
}

/** A closed polyline in millimetres with one Z tag per vertex (0: unknown). */
export interface TaggedPath {
  xy: Float64Array;
  z: Float64Array;
}

export interface Flattened {
  paths: TaggedPath[];
  /** `vertices[tag - 1]`: Z tags count from 1, because Clipper treats 0 as "no tag". */
  vertices: VertexInfo[];
  /** Global curve index per loop and curve: `curveIds[loop][curve]`. */
  curves: Curve[];
  curveIds: number[][];
}

/** Segments for an arc so the chord error is at most `tol`. */
export function arcSegments(r: number, sweep: number, tol: number): number {
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / r));
  return Math.max(Math.abs(sweep) >= TAU - 1e-9 ? 8 : 1, Math.ceil(Math.abs(sweep) / step));
}

/**
 * Flatten every loop, arcs within chord error `tol` (vertices on the arc). Each
 * vertex gets its own Z tag; `vertices` says which curve it came from.
 */
export function flatten(shape: Shape, tol: number): Flattened {
  const vertices: VertexInfo[] = [];
  const curves: Curve[] = [];
  const curveIds: number[][] = [];
  const paths: TaggedPath[] = [];
  shape.loops.forEach((loop, li) => {
    const ids = loop.map((c) => {
      curves.push(c);
      return curves.length - 1;
    });
    curveIds.push(ids);
    const xy: number[] = [];
    const z: number[] = [];
    loop.forEach((c, ci) => {
      const n = c.kind === 'line' ? 1 : arcSegments(c.r, c.sweep, tol);
      for (let k = 0; k < n; k++) {
        const p = curvePoint(c, k / n);
        xy.push(p[0], p[1]);
        const prev = loop[(ci + loop.length - 1) % loop.length]!;
        const t0 = curveTangent(prev, 1);
        const t1 = curveTangent(c, 0);
        const sharp =
          Math.abs(t0[0] * t1[1] - t0[1] * t1[0]) > 1e-9 || t0[0] * t1[0] + t0[1] * t1[1] < 0;
        vertices.push({
          point: p,
          loop: li,
          curves: k === 0 ? [ids[ci]!, ids[(ci + loop.length - 1) % loop.length]!] : [ids[ci]!],
          corner: k === 0 && sharp,
        });
        z.push(vertices.length);
      }
    });
    paths.push({ xy: Float64Array.from(xy), z: Float64Array.from(z) });
  });
  return { paths, vertices, curves, curveIds };
}

/** A closed polyline from plain points (e.g. a 10,000-vertex outline), tagged per vertex. */
export function polygonShape(points: readonly P[]): Shape {
  const loop: Curve[] = points.map((a, i) => ({
    kind: 'line',
    a,
    b: points[(i + 1) % points.length]!,
    entityId: `l${i}`,
  }));
  return { loops: [loop] };
}

export function pathArea(xy: Float64Array): number {
  let a = 0;
  const n = xy.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += xy[2 * j]! * xy[2 * i + 1]! - xy[2 * i]! * xy[2 * j + 1]!;
  }
  return a / 2;
}

export const pathsArea = (paths: readonly TaggedPath[]): number =>
  paths.reduce((s, p) => s + pathArea(p.xy), 0);

export const vertexCount = (paths: readonly TaggedPath[]): number =>
  paths.reduce((s, p) => s + p.xy.length / 2, 0);
