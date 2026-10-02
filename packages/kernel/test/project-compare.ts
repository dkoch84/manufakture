// Edge-by-edge comparison of a `project` result with a view drawn by hand (ported from the T4.4a
// spike, spikes/hlr/src/compare.ts).
//
// An expected view lists model geometry in 3D (segments and circle arcs) with the visibility
// worked out by hand; it is projected with `projectPoint`. The comparison is geometric, so it does
// not depend on how HLR splits or merges edges:
// - every expected visible (hidden) curve must be covered by actual visible (hidden) sharp or
//   outline edges;
// - every actual visible edge must lie on an expected visible curve;
// - every actual hidden edge must lie on an expected hidden curve, or under an expected visible one
//   (a hidden line exactly under a visible line: harmless on paper, reported as a length);
// - `smooth` and `sewn` edges are compared with their own expected lists, when given.

import {
  projectPoint,
  viewFrame,
  type Curve2,
  type EdgeClass,
  type ProjectedEdge,
  type ProjectView,
} from '../src/project';
import type { Vec2, Vec3 } from '../src/types';

export type Path3 = Vec3[];
type Poly2 = Vec2[];

export const seg = (a: Vec3, b: Vec3): Path3 => [a, b];

/** A circle arc in a plane normal to X, Y or Z, from angle a0 to a1 (degrees, about +axis). */
export function arc3(
  center: Vec3,
  axis: 'x' | 'y' | 'z',
  r: number,
  a0 = 0,
  a1 = 360,
  steps = 720,
): Path3 {
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    const u = r * Math.cos(t);
    const v = r * Math.sin(t);
    const [x, y, z] = center;
    out.push(
      axis === 'z' ? [x + u, y + v, z] : axis === 'x' ? [x, y + u, z + v] : [x + v, y, z + u],
    );
  }
  return out;
}

export interface ExpectedView {
  visible: Path3[];
  hidden: Path3[];
  /** Expected smooth (tangent) edges, visible and hidden together; unchecked when absent. */
  smooth?: Path3[];
  sewn?: Path3[];
}

/** Points along a 2D curve record: its own vertices, arcs every half degree of their sweep. */
export function curvePoints(c: Curve2): Vec2[] {
  if (c.kind === 'line') return [c.a, c.b];
  if (c.kind === 'polyline') return c.points;
  const n = Math.max(8, Math.ceil(((c.end - c.start) * 180) / Math.PI) * 2);
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = c.start + ((c.end - c.start) * i) / n;
    if (c.kind === 'arc') {
      out.push([c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)]);
    } else {
      const u = c.major * Math.cos(t);
      const v = c.minor * Math.sin(t);
      const cr = Math.cos(c.rotation);
      const sr = Math.sin(c.rotation);
      out.push([c.center[0] + u * cr - v * sr, c.center[1] + u * sr + v * cr]);
    }
  }
  return out;
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function distToPolys(p: Vec2, polys: readonly Poly2[]): number {
  let best = Infinity;
  for (const poly of polys) {
    if (poly.length === 1)
      best = Math.min(best, Math.hypot(p[0] - poly[0]![0], p[1] - poly[0]![1]));
    for (let i = 1; i < poly.length; i++)
      best = Math.min(best, distToSeg(p, poly[i - 1]!, poly[i]!));
  }
  return best;
}

/** Points every `step` along a polyline (and its vertices). */
export function along(poly: Poly2, step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  if (poly.length > 0) out.push(poly.at(-1)!);
  return out;
}

export interface Mismatch {
  what: string;
  at: Vec2;
  distance: number;
}

export interface Comparison {
  mismatches: Mismatch[];
  /** Length of hidden edges that lie under expected visible lines (mm). */
  hiddenUnderVisible: number;
}

const length = (poly: Poly2): number => {
  let l = 0;
  for (let i = 1; i < poly.length; i++) {
    l += Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]);
  }
  return l;
};

/**
 * Compare `edges` with `expected` in `view`. `tol` is the distance in mm a point may be from the
 * other side.
 */
export function compareView(
  edges: readonly ProjectedEdge[],
  view: ProjectView,
  expected: ExpectedView,
  tol = 0.08,
  step = 0.25,
): Comparison {
  const frame = viewFrame(view);
  const proj = (paths: Path3[] | undefined): Poly2[] =>
    (paths ?? []).map((p) => p.map((q) => projectPoint(frame, q)));
  const ev = proj(expected.visible);
  const eh = proj(expected.hidden);
  const pick = (classes: EdgeClass[], visible: boolean | null) =>
    edges
      .filter((e) => classes.includes(e.cls) && (visible === null || e.visible === visible))
      .map((e) => curvePoints(e.curve));
  const av = pick(['sharp', 'outline'], true);
  const ah = pick(['sharp', 'outline'], false);
  const mismatches: Mismatch[] = [];
  const check = (what: string, from: Poly2[], to: Poly2[]) => {
    for (const poly of from) {
      for (const p of along(poly, step)) {
        const d = distToPolys(p, to);
        if (d > tol) {
          mismatches.push({ what, at: p, distance: d });
          break; // one report per curve
        }
      }
    }
  };
  check('expected visible not drawn visible', ev, av);
  check('expected hidden not drawn hidden', eh, ah);
  check('visible edge not in the hand-drawn view', av, ev);
  let hiddenUnderVisible = 0;
  for (const poly of ah) {
    const pts = along(poly, step);
    if (pts.every((p) => distToPolys(p, eh) <= tol)) continue;
    const bad = pts.find((p) => distToPolys(p, eh) > tol && distToPolys(p, ev) > tol);
    if (bad === undefined) hiddenUnderVisible += length(poly);
    else {
      mismatches.push({
        what: 'hidden edge not in the hand-drawn view',
        at: bad,
        distance: Math.min(distToPolys(bad, eh), distToPolys(bad, ev)),
      });
    }
  }
  for (const cls of ['smooth', 'sewn'] as const) {
    const want = expected[cls];
    if (want === undefined) continue;
    const got = pick([cls], null);
    check(`expected ${cls} edge missing`, proj(want), got);
    check(`${cls} edge not expected`, got, proj(want));
  }
  return { mismatches, hiddenUnderVisible };
}
