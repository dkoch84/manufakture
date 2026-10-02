// Dropping hidden edges that lie under visible ones. Exact HLR returns them (T4.4a: 0 to 331 mm
// per view on the spike's fixtures: a hole's circles seen edge on under the outline, the bottom
// circle of a through hole under the top one). They are harmless on screen but draw a dashed
// line over a solid one in DXF and on paper, so the drawing removes them, piece by piece.
//
// Hidden edges that coincide with an earlier hidden edge are trimmed the same way, so each hidden
// line is drawn once.
//
// Every edge passed in counts as drawn: callers filter out the edges a view leaves out (omitted
// smooth edges, undrawn seams) first, or a hidden line under one of them would vanish.
//
// Covers are taken as they are and pieces of what is left shorter than the tolerance are
// dropped, so a hidden edge that only touches a visible one keeps its full length.
//
// Handled exactly: a hidden line under collinear visible lines, a hidden arc under visible arcs
// of the same circle, a hidden ellipse arc under visible arcs of the same ellipse. A hidden
// polyline loses the segments whose ends and middle all lie within the tolerance of a visible
// curve of any kind. Any other combination is left alone (a hidden line under a visible polyline
// does not occur in HLR output: straight B-splines come back as lines).

import {
  TAU,
  add,
  cross,
  curveBounds,
  distanceToCurve,
  dot,
  length,
  mul,
  normalizeAngle,
  sub,
  subtractIntervals,
  sweep,
  type Bounds,
  type Curve2,
  type Vec2,
} from './geometry';

export type EdgeClass = 'sharp' | 'smooth' | 'sewn' | 'outline';

/** A projected edge, the shape of the kernel's `ProjectedEdge` (T4.4b), in view coordinates. */
export interface ViewEdge {
  /** Index of the projected item (body) the edge belongs to. */
  readonly item: number;
  readonly cls: EdgeClass;
  readonly visible: boolean;
  readonly curve: Curve2;
}

type Line = Extract<Curve2, { kind: 'line' }>;
type Arc = Extract<Curve2, { kind: 'arc' }>;
type Ellipse = Extract<Curve2, { kind: 'ellipseArc' }>;

function lineCover(h: Line, visible: readonly Curve2[], tol: number): [number, number][] {
  const d = sub(h.b, h.a);
  const len = length(d);
  const u = mul(d, 1 / len);
  const out: [number, number][] = [];
  for (const v of visible) {
    if (v.kind !== 'line') continue;
    // Both ends of the visible line within `tol` of the hidden line's infinite line.
    if (Math.abs(cross(u, sub(v.a, h.a))) > tol || Math.abs(cross(u, sub(v.b, h.a))) > tol)
      continue;
    const ta = dot(sub(v.a, h.a), u);
    const tb = dot(sub(v.b, h.a), u);
    out.push([Math.min(ta, tb), Math.max(ta, tb)]);
  }
  return out;
}

/** Angular intervals, relative to `start`, that the visible ranges cover on [0, total]. */
function angularCover(
  start: number,
  total: number,
  ranges: readonly (readonly [number, number])[],
): [number, number][] {
  const out: [number, number][] = [];
  for (const [vs, ve] of ranges) {
    const s = sweep(vs, ve);
    if (s === TAU) {
      out.push([0, total]);
      continue;
    }
    const rel = normalizeAngle(vs - start);
    for (const shift of [-TAU, 0, TAU]) out.push([rel + shift, rel + shift + s]);
  }
  return out;
}

function arcCover(h: Arc, visible: readonly Curve2[], tol: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (const v of visible)
    if (
      v.kind === 'arc' &&
      Math.hypot(v.center[0] - h.center[0], v.center[1] - h.center[1]) <= tol &&
      Math.abs(v.radius - h.radius) <= tol
    )
      ranges.push([v.start, v.end]);
  return angularCover(h.start, sweep(h.start, h.end), ranges);
}

function ellipseCover(h: Ellipse, visible: readonly Curve2[], tol: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (const v of visible) {
    if (
      v.kind !== 'ellipseArc' ||
      Math.hypot(v.center[0] - h.center[0], v.center[1] - h.center[1]) > tol ||
      Math.abs(v.major - h.major) > tol ||
      Math.abs(v.minor - h.minor) > tol
    )
      continue;
    // The same ellipse may be described with its major axis turned by a half turn, which shifts
    // the parameter by pi.
    const turn = normalizeAngle(v.rotation - h.rotation);
    const angTol = tol / Math.max(h.major, tol);
    if (Math.min(turn, TAU - turn) <= angTol) ranges.push([v.start, v.end]);
    else if (Math.abs(turn - Math.PI) <= angTol) ranges.push([v.start + Math.PI, v.end + Math.PI]);
  }
  return angularCover(h.start, sweep(h.start, h.end), ranges);
}

function polylineRemainder(h: readonly Vec2[], visible: readonly Curve2[], tol: number): Vec2[][] {
  const covered = (p: Vec2) => visible.some((v) => distanceToCurve(p, v) <= tol);
  const out: Vec2[][] = [];
  let run: Vec2[] = [];
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1]!;
    const b = h[i]!;
    const under = covered(a) && covered(b) && covered(mul(add(a, b), 0.5));
    if (under) {
      if (run.length > 1) out.push(run);
      run = [];
    } else {
      if (run.length === 0) run.push(a);
      run.push(b);
    }
  }
  if (run.length > 1) out.push(run);
  return out;
}

/** What is left of one hidden curve once the parts under visible curves are removed. */
export function uncoveredParts(
  hidden: Curve2,
  visible: readonly Curve2[],
  tolerance: number,
): Curve2[] {
  switch (hidden.kind) {
    case 'line': {
      const len = Math.hypot(hidden.b[0] - hidden.a[0], hidden.b[1] - hidden.a[1]);
      if (len <= tolerance) return [];
      const keep = subtractIntervals(len, lineCover(hidden, visible, tolerance), tolerance);
      if (keep.length === 1 && keep[0]![0] === 0 && keep[0]![1] === len) return [hidden];
      const u = mul(sub(hidden.b, hidden.a), 1 / len);
      return keep.map(([s, e]) => ({
        kind: 'line',
        a: s === 0 ? hidden.a : add(hidden.a, mul(u, s)),
        b: e === len ? hidden.b : add(hidden.a, mul(u, e)),
      }));
    }
    case 'arc':
    case 'ellipseArc': {
      const total = sweep(hidden.start, hidden.end);
      const r = hidden.kind === 'arc' ? hidden.radius : hidden.major;
      const cover =
        hidden.kind === 'arc'
          ? arcCover(hidden, visible, tolerance)
          : ellipseCover(hidden, visible, tolerance);
      const keep = subtractIntervals(total, cover, tolerance / Math.max(r, tolerance));
      if (keep.length === 1 && keep[0]![0] === 0 && keep[0]![1] === total) return [hidden];
      // A full turn is closed: pieces at both ends of the parameter range are one piece.
      if (total === TAU && keep.length > 1 && keep[0]![0] === 0 && keep.at(-1)![1] === TAU) {
        const last = keep.pop()!;
        keep[0] = [last[0] - TAU, keep[0]![1]];
      }
      return keep.map(([s, e]) => ({ ...hidden, start: hidden.start + s, end: hidden.start + e }));
    }
    case 'polyline': {
      const parts = polylineRemainder(hidden.points, visible, tolerance);
      if (parts.length === 1 && parts[0]!.length === hidden.points.length) return [hidden];
      return parts.map((points) => ({ kind: 'polyline', points }));
    }
  }
}

interface Boxed {
  readonly curve: Curve2;
  readonly box: Bounds;
}

const boxed = (curve: Curve2): Boxed => ({ curve, box: curveBounds(curve) });

/** Whether two boxes come within `tol` of each other. */
const near = (a: Bounds, b: Bounds, tol: number): boolean =>
  a.min[0] <= b.max[0] + tol &&
  b.min[0] <= a.max[0] + tol &&
  a.min[1] <= b.max[1] + tol &&
  b.min[1] <= a.max[1] + tol;

/**
 * The edges with every hidden edge trimmed to the parts that no visible edge covers (any item,
 * any class), and to the parts no earlier hidden edge already draws: two bodies, or two holes
 * seen end on, can project onto the same hidden line, and two dashed lines on top of each other
 * draw out of phase. The first edge keeps the shared part (and its `item`). `tolerance` is in
 * view units (model millimetres); default 0.01 mm. Visible edges and the order of the edges are
 * kept; a hidden edge may become several or none.
 */
export function removeHiddenUnderVisible(edges: readonly ViewEdge[], tolerance = 0.01): ViewEdge[] {
  const visible = edges.filter((e) => e.visible).map((e) => boxed(e.curve));
  const drawnHidden: Boxed[] = [];
  const out: ViewEdge[] = [];
  for (const e of edges) {
    if (e.visible) {
      out.push(e);
      continue;
    }
    // Only curves whose boxes come near the hidden one's can cover any of it.
    const box = curveBounds(e.curve);
    const covers = [...visible, ...drawnHidden]
      .filter((c) => near(c.box, box, tolerance))
      .map((c) => c.curve);
    for (const curve of uncoveredParts(e.curve, covers, tolerance)) {
      out.push({ ...e, curve });
      drawnHidden.push(boxed(curve));
    }
  }
  return out;
}
