// 2D geometry shared by every part of the package: points, the curve type that mirrors the
// kernel's projected edges (T4.4b), the view-to-paper transform, bounds, lengths and sampling.
// Angles are radians, counter-clockwise, with y up (paper and view coordinates alike).

export type Vec2 = readonly [number, number];

export const TAU = 2 * Math.PI;

/**
 * A 2D curve. Arcs run counter-clockwise from `start` to `end`; an ellipse arc's `start` and `end`
 * are eccentric anomalies, and its point at t is `center + major cos(t) u + minor sin(t) v` with
 * `u` at `rotation` and `v` a quarter turn counter-clockwise from it. A full circle or ellipse is
 * an arc with `end - start` equal to 2 pi.
 */
export type Curve2 =
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 }
  | {
      readonly kind: 'arc';
      readonly center: Vec2;
      readonly radius: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'ellipseArc';
      readonly center: Vec2;
      readonly major: number;
      readonly minor: number;
      readonly rotation: number;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'polyline'; readonly points: readonly Vec2[] };

export interface Bounds {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** View coordinates (model millimetres) to paper millimetres: `paper = offset + scale * view`. */
export interface Transform2 {
  readonly scale: number;
  readonly offset: Vec2;
}

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const length = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** A quarter turn counter-clockwise. */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const polar = (angle: number, r = 1): Vec2 => [r * Math.cos(angle), r * Math.sin(angle)];

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}

/** An angle in [0, 2 pi). */
export function normalizeAngle(angle: number): number {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

/**
 * The counter-clockwise sweep from `start` to `end`, in [0, 2 pi]. A difference of 2 pi (or more)
 * is a full turn; `start === end` is an empty arc.
 */
export function sweep(start: number, end: number): number {
  const raw = end - start;
  if (raw >= TAU - 1e-9) return TAU;
  if (raw === 0) return 0;
  const s = normalizeAngle(raw);
  return s < 1e-12 ? TAU : s;
}

export function isFullTurn(start: number, end: number): boolean {
  return sweep(start, end) === TAU;
}

export function applyPoint(t: Transform2, p: Vec2): Vec2 {
  return [t.offset[0] + t.scale * p[0], t.offset[1] + t.scale * p[1]];
}

export function transformCurve(t: Transform2, c: Curve2): Curve2 {
  switch (c.kind) {
    case 'line':
      return { kind: 'line', a: applyPoint(t, c.a), b: applyPoint(t, c.b) };
    case 'arc':
      return { ...c, center: applyPoint(t, c.center), radius: c.radius * t.scale };
    case 'ellipseArc':
      return {
        ...c,
        center: applyPoint(t, c.center),
        major: c.major * t.scale,
        minor: c.minor * t.scale,
      };
    case 'polyline':
      return { kind: 'polyline', points: c.points.map((p) => applyPoint(t, p)) };
  }
}

export function ellipsePoint(c: Extract<Curve2, { kind: 'ellipseArc' }>, t: number): Vec2 {
  const cr = Math.cos(c.rotation);
  const sr = Math.sin(c.rotation);
  const x = c.major * Math.cos(t);
  const y = c.minor * Math.sin(t);
  return [c.center[0] + x * cr - y * sr, c.center[1] + x * sr + y * cr];
}

/** Points along a curve, its chords within `tolerance` of it (same units as the curve). */
export function curvePoints(c: Curve2, tolerance = 0.01): Vec2[] {
  switch (c.kind) {
    case 'line':
      return [c.a, c.b];
    case 'polyline':
      return [...c.points];
    case 'arc':
    case 'ellipseArc': {
      const r = c.kind === 'arc' ? c.radius : c.major;
      const s = sweep(c.start, c.end);
      // Chord sagitta r (1 - cos(h / 2)) <= tolerance, on the larger radius of an ellipse.
      const h = r > tolerance ? 2 * Math.acos(1 - tolerance / r) : Math.PI / 2;
      const n = Math.max(1, Math.ceil(s / Math.min(h, Math.PI / 8)));
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = c.start + (s * i) / n;
        out.push(c.kind === 'arc' ? add(c.center, polar(t, c.radius)) : ellipsePoint(c, t));
      }
      return out;
    }
  }
}

export function curveLength(c: Curve2): number {
  switch (c.kind) {
    case 'line':
      return distance(c.a, c.b);
    case 'arc':
      return c.radius * sweep(c.start, c.end);
    case 'ellipseArc': {
      // Simpson's rule on |d/dt| = sqrt(a^2 sin^2 t + b^2 cos^2 t), smooth and periodic.
      const s = sweep(c.start, c.end);
      const n = 2 * Math.max(8, Math.ceil((s / TAU) * 512));
      const f = (t: number) => Math.hypot(c.major * Math.sin(t), c.minor * Math.cos(t));
      let sum = f(c.start) + f(c.start + s);
      for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(c.start + (s * i) / n);
      return (sum * s) / (3 * n);
    }
    case 'polyline': {
      let sum = 0;
      for (let i = 1; i < c.points.length; i++) sum += distance(c.points[i - 1]!, c.points[i]!);
      return sum;
    }
  }
}

/** Whether angle `a` lies on the counter-clockwise sweep from `start` to `end`. */
function onSweep(a: number, start: number, end: number): boolean {
  const s = sweep(start, end);
  return s === TAU || normalizeAngle(a - start) <= s + 1e-12;
}

export function curveBounds(c: Curve2): Bounds {
  let pts: Vec2[];
  if (c.kind === 'arc') {
    pts = [add(c.center, polar(c.start, c.radius)), add(c.center, polar(c.end, c.radius))];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      if (onSweep(a, c.start, c.end)) pts.push(add(c.center, polar(a, c.radius)));
    }
  } else if (c.kind === 'ellipseArc') {
    pts = [ellipsePoint(c, c.start), ellipsePoint(c, c.end)];
    // Extremes in x and y: d/dt of each coordinate is zero at these parameters.
    const cr = Math.cos(c.rotation);
    const sr = Math.sin(c.rotation);
    const tx = Math.atan2(-c.minor * sr, c.major * cr);
    const ty = Math.atan2(c.minor * cr, c.major * sr);
    for (const t of [tx, tx + Math.PI, ty, ty + Math.PI])
      if (onSweep(t, c.start, c.end)) pts.push(ellipsePoint(c, t));
  } else {
    pts = curvePoints(c);
  }
  return boundsOf(pts);
}

export function boundsOf(points: readonly Vec2[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

export function unionBounds(boxes: readonly Bounds[]): Bounds {
  return boundsOf(boxes.flatMap((b) => [b.min, b.max]));
}

export function isEmptyBounds(b: Bounds): boolean {
  return !(b.min[0] <= b.max[0] && b.min[1] <= b.max[1]);
}

/** Distance from `p` to the segment `a`-`b`. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  return distance(p, add(a, mul(ab, t)));
}

/** Distance from `p` to a curve (ellipse arcs through their chords at a fine tolerance). */
export function distanceToCurve(p: Vec2, c: Curve2): number {
  if (c.kind === 'line') return distanceToSegment(p, c.a, c.b);
  if (c.kind === 'arc') {
    const v = sub(p, c.center);
    const a = Math.atan2(v[1], v[0]);
    if (length(v) > 0 && onSweep(a, c.start, c.end)) return Math.abs(length(v) - c.radius);
    return Math.min(
      distance(p, add(c.center, polar(c.start, c.radius))),
      distance(p, add(c.center, polar(c.end, c.radius))),
    );
  }
  const pts = curvePoints(c, 1e-4);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++)
    best = Math.min(best, distanceToSegment(p, pts[i - 1]!, pts[i]!));
  return pts.length === 1 ? distance(p, pts[0]!) : best;
}

/** Subtracts closed intervals from [0, total]; returns what is left, pieces longer than `minimum`. */
export function subtractIntervals(
  total: number,
  remove: readonly (readonly [number, number])[],
  minimum: number,
): [number, number][] {
  const cuts = remove
    .map(([a, b]): [number, number] => [
      Math.max(0, Math.min(a, b)),
      Math.min(total, Math.max(a, b)),
    ])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of cuts) {
    if (a - at > minimum) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (total - at > minimum) out.push([at, total]);
  return out;
}
