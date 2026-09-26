// Residual equations for the ops, in plain JS. They are not used to solve
// (planegcs does that); they give the Jacobian for the per-entity analysis.
// Each residual is zero exactly when planegcs's matching constraint is
// satisfied, and is normalised so rows have comparable scale.
//
// Every residual is smooth where it is analysed. A constraint on an unsigned
// quantity (a point-to-line distance, a line tangent to a circle, the radius
// difference of an internal tangency) takes the sign branch the geometry is on
// at `at`, the parameters the analysis runs at, instead of an `abs()`: `abs()`
// has no derivative at 0, so central differences there give a zero row and
// the analysis would under-report the rank.

import type { Curve, PointIndex } from './layout';
import type { Op } from './ops';

export interface Equation {
  /** Parameter indices the residual depends on. */
  params: number[];
  f: (p: Float64Array) => number;
}

type LineCurve = Extract<Curve, { kind: 'line' }>;
type RoundCurve = Extract<Curve, { kind: 'circle' | 'arc' }>;

/** Wrap an angle to (-pi, pi]. */
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const dir = (l: LineCurve, p: Float64Array): [number, number] => [
  p[l.p2[0]]! - p[l.p1[0]]!,
  p[l.p2[1]]! - p[l.p1[1]]!,
];

/** Signed distance from point `q` to line `l`. */
function lineDistance(q: PointIndex, l: LineCurve, p: Float64Array): number {
  const [dx, dy] = dir(l, p);
  const len = Math.hypot(dx, dy);
  return (dx * (p[q[1]]! - p[l.p1[1]]!) - dy * (p[q[0]]! - p[l.p1[0]]!)) / len;
}

function dist(a: PointIndex, b: PointIndex, p: Float64Array): number {
  return Math.hypot(p[a[0]]! - p[b[0]]!, p[a[1]]! - p[b[1]]!);
}

function tangent(c: Curve, at: PointIndex, p: Float64Array): [number, number] {
  if (c.kind === 'line') return dir(c, p);
  return [-(p[at[1]]! - p[c.c[1]]!), p[at[0]]! - p[c.c[0]]!];
}

function lineParams(l: LineCurve): number[] {
  return [...l.p1, ...l.p2];
}

function roundParams(c: RoundCurve): number[] {
  return c.kind === 'circle' ? [...c.c, c.r] : [...c.c, c.r];
}

function curveParams(c: Curve, at: PointIndex): number[] {
  return c.kind === 'line' ? lineParams(c) : [...c.c, ...at];
}

/** -1 for a negative number, else 1: the branch of an unsigned quantity. */
function branch(v: number): number {
  return v < 0 ? -1 : 1;
}

/**
 * The residual equations of one op. `at` holds the parameters the analysis
 * runs at; it picks the sign branch of unsigned quantities (see above).
 * Without it, the positive branch is taken.
 */
export function equationsOf(op: Op, at?: Float64Array): Equation[] {
  switch (op.op) {
    case 'p2p_coincident':
      return [
        { params: [op.p1[0], op.p2[0]], f: (p) => p[op.p1[0]]! - p[op.p2[0]]! },
        { params: [op.p1[1], op.p2[1]], f: (p) => p[op.p1[1]]! - p[op.p2[1]]! },
      ];
    case 'horizontal_pp':
      return [{ params: [op.p1[1], op.p2[1]], f: (p) => p[op.p2[1]]! - p[op.p1[1]]! }];
    case 'vertical_pp':
      return [{ params: [op.p1[0], op.p2[0]], f: (p) => p[op.p2[0]]! - p[op.p1[0]]! }];
    case 'parallel':
    case 'perpendicular_ll':
      return [
        {
          params: [...lineParams(op.l1), ...lineParams(op.l2)],
          f: (p) => {
            const [ax, ay] = dir(op.l1, p);
            const [bx, by] = dir(op.l2, p);
            const n = Math.hypot(ax, ay) * Math.hypot(bx, by);
            return (op.op === 'parallel' ? ax * by - ay * bx : ax * bx + ay * by) / n;
          },
        },
      ];
    case 'angle_via_point':
      return [
        {
          params: [...curveParams(op.c1, op.p), ...curveParams(op.c2, op.p)],
          f: (p) => {
            const [ax, ay] = tangent(op.c1, op.p, p);
            const [bx, by] = tangent(op.c2, op.p, p);
            return wrap(Math.atan2(ax * by - ay * bx, ax * bx + ay * by) - op.angle);
          },
        },
      ];
    case 'tangent_lc': {
      const s = at ? branch(lineDistance(op.c.c, op.l, at)) : 1;
      return [
        {
          params: [...lineParams(op.l), ...roundParams(op.c)],
          f: (p) => s * lineDistance(op.c.c, op.l, p) - p[op.c.r]!,
        },
      ];
    }
    case 'tangent_circumf': {
      const s = at ? branch(at[op.c1.r]! - at[op.c2.r]!) : 1;
      return [
        {
          params: [...roundParams(op.c1), ...roundParams(op.c2)],
          f: (p) => {
            const d = dist(op.c1.c, op.c2.c, p);
            const r1 = p[op.c1.r]!;
            const r2 = p[op.c2.r]!;
            return op.internal ? d - s * (r1 - r2) : d - (r1 + r2);
          },
        },
      ];
    }
    case 'equal_length':
      return [
        {
          params: [...lineParams(op.l1), ...lineParams(op.l2)],
          f: (p) => Math.hypot(...dir(op.l1, p)) - Math.hypot(...dir(op.l2, p)),
        },
      ];
    case 'equal_radius':
      return [{ params: [op.c1.r, op.c2.r], f: (p) => p[op.c1.r]! - p[op.c2.r]! }];
    case 'p2p_distance':
      return [{ params: [...op.p1, ...op.p2], f: (p) => dist(op.p1, op.p2, p) - op.value }];
    case 'p2l_distance': {
      const s = at ? branch(lineDistance(op.p, op.l, at)) : 1;
      return [
        {
          params: [...op.p, ...lineParams(op.l)],
          f: (p) => s * lineDistance(op.p, op.l, p) - op.value,
        },
      ];
    }
    case 'difference':
      return [{ params: [op.i1, op.i2], f: (p) => p[op.i2]! - p[op.i1]! - op.value }];
    case 'l2l_angle_ll':
      return [
        {
          params: [...lineParams(op.l1), ...lineParams(op.l2)],
          f: (p) => {
            const [ax, ay] = dir(op.l1, p);
            const [bx, by] = dir(op.l2, p);
            return wrap(Math.atan2(by, bx) - Math.atan2(ay, ax) - op.value);
          },
        },
      ];
    case 'radius':
      return [{ params: [op.c.r], f: (p) => p[op.c.r]! - op.value }];
    case 'diameter':
      return [{ params: [op.c.r], f: (p) => 2 * p[op.c.r]! - op.value }];
    case 'coordinate_x':
      return [{ params: [op.p[0]], f: (p) => p[op.p[0]]! - op.value }];
    case 'coordinate_y':
      return [{ params: [op.p[1]], f: (p) => p[op.p[1]]! - op.value }];
    case 'p2p_symmetric_ppp':
      return [0, 1].map((k) => ({
        params: [op.p1[k]!, op.p2[k]!, op.p[k]!],
        f: (p: Float64Array) => (p[op.p1[k]!]! + p[op.p2[k]!]!) / 2 - p[op.p[k]!]!,
      }));
    case 'p2p_symmetric_ppl': {
      const params = [...op.p1, ...op.p2, ...lineParams(op.l)];
      return [
        {
          // The midpoint of p1 p2 lies on the line.
          params,
          f: (p) => {
            const [dx, dy] = dir(op.l, p);
            const mx = (p[op.p1[0]]! + p[op.p2[0]]!) / 2 - p[op.l.p1[0]]!;
            const my = (p[op.p1[1]]! + p[op.p2[1]]!) / 2 - p[op.l.p1[1]]!;
            return (dx * my - dy * mx) / Math.hypot(dx, dy);
          },
        },
        {
          // p1 p2 is perpendicular to the line.
          params,
          f: (p) => {
            const [dx, dy] = dir(op.l, p);
            const ex = p[op.p2[0]]! - p[op.p1[0]]!;
            const ey = p[op.p2[1]]! - p[op.p1[1]]!;
            return (dx * ex + dy * ey) / Math.hypot(dx, dy);
          },
        },
      ];
    }
    case 'point_on_line':
      return [{ params: [...op.p, ...lineParams(op.l)], f: (p) => lineDistance(op.p, op.l, p) }];
    case 'point_on_round':
      return [
        { params: [...op.p, ...roundParams(op.c)], f: (p) => dist(op.p, op.c.c, p) - p[op.c.r]! },
      ];
    case 'arc_rules': {
      const a = op.a;
      const all = [...a.c, ...a.s, ...a.e, a.a1, a.a2, a.r];
      const trig = [Math.cos, Math.sin];
      return [
        [a.s, a.a1],
        [a.e, a.a2],
      ].flatMap(([pt, angle]) =>
        [0, 1].map((k) => ({
          params: all,
          f: (p: Float64Array) => {
            const point = pt as PointIndex;
            return p[point[k]!]! - p[a.c[k]!]! - p[a.r]! * trig[k]!(p[angle as number]!);
          },
        })),
      );
    }
  }
}
