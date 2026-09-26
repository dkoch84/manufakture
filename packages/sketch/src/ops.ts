// Model constraints compiled into primitive operations over the parameter
// layout. The planegcs system pushes each op as one `add_constraint_*` call,
// and the JS analysis turns each into residual equations, so both see exactly
// the same system.
//
// Modelling follows FreeCAD (ADR 0003, decision 6): endpoint tangency is a
// coincidence plus `angle_via_point`, never `tangent_la` at a shared endpoint;
// arcs carry `arc_rules`; a midpoint is a point symmetry.

import { curveOf, pointIndex, type Curve, type Layout, type PointIndex } from './layout';
import type { PointRef, SketchConstraint } from './model';

type LineCurve = Extract<Curve, { kind: 'line' }>;
type RoundCurve = Extract<Curve, { kind: 'circle' | 'arc' }>;
type ArcCurve = Extract<Curve, { kind: 'arc' }>;

export type Op =
  | { op: 'p2p_coincident'; p1: PointIndex; p2: PointIndex }
  | { op: 'horizontal_pp'; p1: PointIndex; p2: PointIndex }
  | { op: 'vertical_pp'; p1: PointIndex; p2: PointIndex }
  | { op: 'parallel'; l1: LineCurve; l2: LineCurve }
  | { op: 'perpendicular_ll'; l1: LineCurve; l2: LineCurve }
  | { op: 'angle_via_point'; c1: Curve; c2: Curve; p: PointIndex; angle: number }
  | { op: 'tangent_lc'; l: LineCurve; c: RoundCurve }
  | { op: 'tangent_circumf'; c1: RoundCurve; c2: RoundCurve; internal: boolean }
  | { op: 'equal_length'; l1: LineCurve; l2: LineCurve }
  | { op: 'equal_radius'; c1: RoundCurve; c2: RoundCurve }
  | { op: 'p2p_distance'; p1: PointIndex; p2: PointIndex; value: number }
  | { op: 'p2l_distance'; p: PointIndex; l: LineCurve; value: number }
  | { op: 'difference'; i1: number; i2: number; value: number }
  | { op: 'l2l_angle_ll'; l1: LineCurve; l2: LineCurve; value: number }
  | { op: 'radius'; c: RoundCurve; value: number }
  | { op: 'diameter'; c: RoundCurve; value: number }
  | { op: 'coordinate_x'; p: PointIndex; value: number }
  | { op: 'coordinate_y'; p: PointIndex; value: number }
  | { op: 'p2p_symmetric_ppp'; p1: PointIndex; p2: PointIndex; p: PointIndex }
  | { op: 'p2p_symmetric_ppl'; p1: PointIndex; p2: PointIndex; l: LineCurve }
  | { op: 'point_on_line'; p: PointIndex; l: LineCurve }
  | { op: 'point_on_round'; p: PointIndex; c: RoundCurve }
  | { op: 'arc_rules'; a: ArcCurve };

export interface CompiledConstraint {
  id: string;
  ops: Op[];
}

const line = (layout: Layout, id: string) => curveOf(layout, id) as LineCurve;
const round = (layout: Layout, id: string) => curveOf(layout, id) as RoundCurve;

/** Unit tangent direction of a curve at a point (arcs and circles run counter-clockwise). */
export function tangentAt(
  curve: Curve,
  p: PointIndex,
  params: ArrayLike<number>,
): [number, number] {
  if (curve.kind === 'line') {
    return [
      params[curve.p2[0]]! - params[curve.p1[0]]!,
      params[curve.p2[1]]! - params[curve.p1[1]]!,
    ];
  }
  const dx = params[p[0]]! - params[curve.c[0]]!;
  const dy = params[p[1]]! - params[curve.c[1]]!;
  return [-dy, dx];
}

function endOf(layout: Layout, id: string, at: 'start' | 'end'): PointIndex {
  return pointIndex(layout, { entity: id, at } as PointRef);
}

function distanceBetween(a: PointIndex, b: PointIndex, params: ArrayLike<number>): number {
  return Math.hypot(params[a[0]]! - params[b[0]]!, params[a[1]]! - params[b[1]]!);
}

/**
 * Compile one validated constraint. `values` holds evaluated dimensions;
 * `params` are the current parameter values, used for what is taken from the
 * geometry: the coordinates a `fix` pins, and the choices FreeCAD also makes
 * from the current geometry (0 or pi for an endpoint tangency, internal or
 * external for two tangent circles). The result is a function of the inputs
 * only; the planegcs system recompiles on every update so that nothing taken
 * from earlier geometry outlives the coordinates it came from.
 */
export function compileConstraint(
  c: SketchConstraint,
  layout: Layout,
  values: ReadonlyMap<string, number>,
  params: ArrayLike<number>,
): CompiledConstraint {
  const pt = (ref: PointRef) => pointIndex(layout, ref);
  const value = () => {
    const v = values.get(c.id);
    if (v === undefined) throw new Error(`No value for constraint '${c.id}'`);
    return v;
  };
  const one = (op: Op): CompiledConstraint => ({ id: c.id, ops: [op] });

  switch (c.kind) {
    case 'coincident':
      return one({ op: 'p2p_coincident', p1: pt(c.a), p2: pt(c.b) });
    case 'horizontal':
    case 'vertical': {
      const op = c.kind === 'horizontal' ? 'horizontal_pp' : 'vertical_pp';
      if ('line' in c) {
        const l = line(layout, c.line);
        return one({ op, p1: l.p1, p2: l.p2 });
      }
      return one({ op, p1: pt(c.a), p2: pt(c.b) });
    }
    case 'parallel':
      return one({ op: 'parallel', l1: line(layout, c.a), l2: line(layout, c.b) });
    case 'perpendicular':
      return one({ op: 'perpendicular_ll', l1: line(layout, c.a), l2: line(layout, c.b) });
    case 'tangent': {
      const ca = curveOf(layout, c.a);
      const cb = curveOf(layout, c.b);
      if (c.at) {
        const pa = endOf(layout, c.a, c.at[0]);
        const pb = endOf(layout, c.b, c.at[1]);
        const [ux, uy] = tangentAt(ca, pa, params);
        const [vx, vy] = tangentAt(cb, pb, params);
        // Keep the curves running the way they already do at the joint.
        const angle =
          Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)) <= Math.PI / 2 ? 0 : Math.PI;
        return {
          id: c.id,
          ops: [
            { op: 'p2p_coincident', p1: pa, p2: pb },
            { op: 'angle_via_point', c1: ca, c2: cb, p: pa, angle },
          ],
        };
      }
      if (ca.kind === 'line' && cb.kind !== 'line') return one({ op: 'tangent_lc', l: ca, c: cb });
      if (cb.kind === 'line' && ca.kind !== 'line') return one({ op: 'tangent_lc', l: cb, c: ca });
      const c1 = ca as RoundCurve;
      const c2 = cb as RoundCurve;
      const d = distanceBetween(c1.c, c2.c, params);
      const internal = d < params[c1.r]! || d < params[c2.r]!;
      return one({ op: 'tangent_circumf', c1, c2, internal });
    }
    case 'equal': {
      const ca = curveOf(layout, c.a);
      const cb = curveOf(layout, c.b);
      if (ca.kind === 'line' && cb.kind === 'line')
        return one({ op: 'equal_length', l1: ca, l2: cb });
      return one({ op: 'equal_radius', c1: ca as RoundCurve, c2: cb as RoundCurve });
    }
    case 'distance':
      if ('line' in c) {
        return one({ op: 'p2l_distance', p: pt(c.point), l: line(layout, c.line), value: value() });
      }
      return one({ op: 'p2p_distance', p1: pt(c.a), p2: pt(c.b), value: value() });
    case 'horizontalDistance':
      return one({ op: 'difference', i1: pt(c.a)[0], i2: pt(c.b)[0], value: value() });
    case 'verticalDistance':
      return one({ op: 'difference', i1: pt(c.a)[1], i2: pt(c.b)[1], value: value() });
    case 'angle':
      return one({
        op: 'l2l_angle_ll',
        l1: line(layout, c.a),
        l2: line(layout, c.b),
        value: value(),
      });
    case 'radius':
      return one({ op: 'radius', c: round(layout, c.entity), value: value() });
    case 'diameter':
      return one({ op: 'diameter', c: round(layout, c.entity), value: value() });
    case 'fix': {
      const p = pt(c.point);
      return {
        id: c.id,
        ops: [
          { op: 'coordinate_x', p, value: params[p[0]]! },
          { op: 'coordinate_y', p, value: params[p[1]]! },
        ],
      };
    }
    case 'midpoint': {
      const l = line(layout, c.line);
      return one({ op: 'p2p_symmetric_ppp', p1: l.p1, p2: l.p2, p: pt(c.point) });
    }
    case 'pointOnObject': {
      const on = curveOf(layout, c.on);
      return on.kind === 'line'
        ? one({ op: 'point_on_line', p: pt(c.point), l: on })
        : one({ op: 'point_on_round', p: pt(c.point), c: on });
    }
    case 'symmetric':
      if ('line' in c) {
        return one({ op: 'p2p_symmetric_ppl', p1: pt(c.a), p2: pt(c.b), l: line(layout, c.line) });
      }
      return one({ op: 'p2p_symmetric_ppp', p1: pt(c.a), p2: pt(c.b), p: pt(c.center) });
  }
}

/** The internal `arc_rules` op of every arc, keyed by arc id. */
export function arcRules(layout: Layout): { id: string; op: Op }[] {
  return layout.slots
    .filter((s) => s.entity.kind === 'arc')
    .map((s) => ({
      id: s.entity.id,
      op: { op: 'arc_rules', a: curveOf(layout, s.entity.id) as ArcCurve },
    }));
}

/** A key for what a constraint is, apart from its value: equal keys push identical ops. */
export function constraintShape(c: SketchConstraint): string {
  return JSON.stringify(c, function (this: unknown, key: string, v: unknown) {
    return this === c && (key === 'id' || key === 'value') ? undefined : v;
  });
}
