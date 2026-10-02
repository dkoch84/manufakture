// Edge-by-edge comparison of an HLR result with a view drawn by hand.
//
// An expected view lists model geometry in 3D (segments and circle arcs) with the visibility
// worked out by hand; it is projected with `views.ts`. The comparison is geometric, so it does not
// depend on how HLR splits or merges edges:
// - every expected visible (hidden) curve must be covered by actual visible (hidden) edges;
// - every actual visible edge must lie on an expected visible curve;
// - every actual hidden edge must lie on an expected hidden curve, or under an expected visible one
//   (a hidden line drawn exactly under a visible line: harmless on paper, reported as a length);
// - `smooth` and `sewn` edges are compared with their own expected lists, when given.

import type { EdgeClass, ProjectedEdge } from './hlr';
import { frameOf, project, type Vec2, type Vec3, type View } from './views';

export type Path3 = Vec3[];

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

type Poly2 = Vec2[];

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

/** A grid of polyline segments, for distance queries up to a bound (much faster than a scan). */
export class SegmentIndex {
  private readonly cells = new Map<string, [Vec2, Vec2][]>();
  private readonly points: Vec2[] = [];
  private readonly cell: number;
  constructor(polys: readonly Poly2[], cell = 5) {
    this.cell = cell;
    for (const poly of polys) {
      if (poly.length === 1) this.points.push(poly[0]!);
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1]!;
        const b = poly[i]!;
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell);
        const x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const y0 = Math.floor(Math.min(a[1], b[1]) / cell);
        const y1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const key = `${x},${y}`;
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push([a, b]);
          }
        }
      }
    }
  }

  /** Distance from p to the nearest segment, exact when it is at most `bound`; else Infinity or more. */
  dist(p: Vec2, bound: number): number {
    let best = Infinity;
    for (const q of this.points) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
    const c = this.cell;
    for (let x = Math.floor((p[0] - bound) / c); x <= Math.floor((p[0] + bound) / c); x++) {
      for (let y = Math.floor((p[1] - bound) / c); y <= Math.floor((p[1] + bound) / c); y++) {
        for (const [a, b] of this.cells.get(`${x},${y}`) ?? [])
          best = Math.min(best, distToSeg(p, a, b));
      }
    }
    return best;
  }
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

const length = (poly: Poly2): number => {
  let l = 0;
  for (let i = 1; i < poly.length; i++)
    l += Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]);
  return l;
};

export interface Mismatch {
  what: string;
  at: Vec2;
  distance: number;
}

export interface Comparison {
  ok: boolean;
  expected: { visible: number; hidden: number; visibleLength: number; hiddenLength: number };
  actual: { visible: number; hidden: number; smooth: number; sewn: number };
  /** Length of hidden edges that lie under expected visible lines (mm). */
  hiddenUnderVisible: number;
  mismatches: Mismatch[];
}

/**
 * Compare `edges` with `expected`. `tol` is the distance in mm a point may be from the other side
 * (it has to cover the chord error of sampled curves on both sides).
 */
export function compareView(
  edges: readonly ProjectedEdge[],
  view: View,
  expected: ExpectedView,
  tol = 0.08,
  step = 0.25,
): Comparison {
  const frame = frameOf(view);
  const proj = (paths: Path3[] | undefined): Poly2[] =>
    (paths ?? []).map((p) => p.map((q) => project(frame, q).at));
  const ev = proj(expected.visible);
  const eh = proj(expected.hidden);
  const pick = (classes: EdgeClass[], visible: boolean | null) =>
    edges
      .filter((e) => classes.includes(e.cls) && (visible === null || e.visible === visible))
      .map((e) => e.points);
  const av = pick(['sharp', 'outline'], true);
  const ah = pick(['sharp', 'outline'], false);
  const mismatches: Mismatch[] = [];
  const check = (what: string, from: Poly2[], to: Poly2[]) => {
    const index = new SegmentIndex(to);
    for (const poly of from) {
      for (const p of along(poly, step)) {
        const d = index.dist(p, tol);
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
  const ehIndex = new SegmentIndex(eh);
  const evIndex = new SegmentIndex(ev);
  for (const poly of ah) {
    const pts = along(poly, step);
    const onHidden = pts.every((p) => ehIndex.dist(p, tol) <= tol);
    if (onHidden) continue;
    const onAny = pts.every((p) => ehIndex.dist(p, tol) <= tol || evIndex.dist(p, tol) <= tol);
    if (onAny) hiddenUnderVisible += length(poly);
    else {
      const bad = pts.find((p) => ehIndex.dist(p, tol) > tol && evIndex.dist(p, tol) > tol)!;
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
  return {
    ok: mismatches.length === 0,
    expected: {
      visible: ev.length,
      hidden: eh.length,
      visibleLength: Number(ev.reduce((n, p) => n + length(p), 0).toFixed(3)),
      hiddenLength: Number(eh.reduce((n, p) => n + length(p), 0).toFixed(3)),
    },
    actual: {
      visible: av.length,
      hidden: ah.length,
      smooth: pick(['smooth'], null).length,
      sewn: pick(['sewn'], null).length,
    },
    hiddenUnderVisible: Number(hiddenUnderVisible.toFixed(3)),
    mismatches,
  };
}

/** Length (mm, sampled every 0.5) of `a`'s edges not covered by `b`'s. */
export function uncovered(
  a: readonly ProjectedEdge[],
  b: readonly ProjectedEdge[],
  tol = 0.08,
): number {
  const target = new SegmentIndex(b.map((e) => e.points));
  let len = 0;
  for (const e of a) {
    const pts = along(e.points, 0.5);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      if (target.dist(p, tol) > tol)
        len += Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]);
    }
  }
  return Number(len.toFixed(1));
}
