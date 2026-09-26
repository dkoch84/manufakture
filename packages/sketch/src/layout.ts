// The solver's unknowns: every entity's coordinates as one flat parameter
// vector, the same layout for the planegcs system and the JS analysis.
//
//   0..5     built-ins, fixed: origin (0, 0), x-axis end (1, 0), y-axis end (0, 1)
//   point    x y
//   line     sx sy ex ey
//   circle   cx cy r
//   arc      cx cy sx sy ex ey startAngle endAngle r
//
// Arc angles and radius are derived from the stored points when a layout is
// built; `arc_rules` keeps them consistent while solving.

import {
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type PointRef,
  type SketchEntity,
  type Vec2,
} from './model';

/** Parameter indices of a point's x and y. */
export type PointIndex = readonly [number, number];

export type Curve =
  | { kind: 'line'; p1: PointIndex; p2: PointIndex }
  | { kind: 'circle'; c: PointIndex; r: number }
  | {
      kind: 'arc';
      c: PointIndex;
      s: PointIndex;
      e: PointIndex;
      a1: number;
      a2: number;
      r: number;
    };

export interface EntitySlot {
  entity: SketchEntity;
  /** First parameter index. */
  base: number;
  /** Number of parameters. */
  size: number;
}

export interface Layout {
  /** Starting values of every parameter. */
  values: Float64Array;
  /** Parameters `0 .. fixedCount - 1` are the fixed built-ins. */
  fixedCount: number;
  slots: EntitySlot[];
  byId: Map<string, EntitySlot>;
}

export const BUILTIN_PARAMS = 6;
const ORIGIN_INDEX: PointIndex = [0, 1];
const X_END_INDEX: PointIndex = [2, 3];
const Y_END_INDEX: PointIndex = [4, 5];

const SIZES = { point: 2, line: 4, circle: 3, arc: 9 } as const;

/** Arc start and end angles from its points: end > start, both from atan2. */
export function arcAngles(center: Vec2, start: Vec2, end: Vec2): [number, number] {
  const a1 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let a2 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  if (a2 <= a1) a2 += 2 * Math.PI;
  return [a1, a2];
}

export function buildLayout(entities: readonly SketchEntity[]): Layout {
  let size = BUILTIN_PARAMS;
  const slots: EntitySlot[] = entities.map((entity) => {
    const slot = { entity, base: size, size: SIZES[entity.kind] };
    size += slot.size;
    return slot;
  });
  const values = new Float64Array(size);
  values.set([0, 0, 1, 0, 0, 1]);
  for (const { entity: e, base } of slots) {
    switch (e.kind) {
      case 'point':
        values.set(e.position, base);
        break;
      case 'line':
        values.set([...e.start, ...e.end], base);
        break;
      case 'circle':
        values.set([...e.center, e.radius], base);
        break;
      case 'arc': {
        const r = Math.hypot(e.start[0] - e.center[0], e.start[1] - e.center[1]);
        values.set(
          [...e.center, ...e.start, ...e.end, ...arcAngles(e.center, e.start, e.end), r],
          base,
        );
        break;
      }
    }
  }
  return {
    values,
    fixedCount: BUILTIN_PARAMS,
    slots,
    byId: new Map(slots.map((s) => [s.entity.id, s])),
  };
}

function slotOf(layout: Layout, id: string): EntitySlot {
  const slot = layout.byId.get(id);
  if (!slot) throw new Error(`Unknown entity '${id}'`);
  return slot;
}

/** Parameter indices of a point reference (validated input assumed). */
export function pointIndex(layout: Layout, ref: PointRef): PointIndex {
  if (ref.entity === SKETCH_ORIGIN) return ORIGIN_INDEX;
  const { entity, base } = slotOf(layout, ref.entity);
  const at = (offset: number): PointIndex => [base + offset, base + offset + 1];
  switch (entity.kind) {
    case 'point':
      return at(0);
    case 'line':
      return ref.at === 'end' ? at(2) : at(0);
    case 'circle':
      return at(0);
    case 'arc':
      return ref.at === 'start' ? at(2) : ref.at === 'end' ? at(4) : at(0);
  }
}

/** The curve an entity id stands for (lines, circles, arcs and the built-in axes). */
export function curveOf(layout: Layout, id: string): Curve {
  if (id === SKETCH_X_AXIS) return { kind: 'line', p1: ORIGIN_INDEX, p2: X_END_INDEX };
  if (id === SKETCH_Y_AXIS) return { kind: 'line', p1: ORIGIN_INDEX, p2: Y_END_INDEX };
  const { entity, base } = slotOf(layout, id);
  const at = (offset: number): PointIndex => [base + offset, base + offset + 1];
  switch (entity.kind) {
    case 'line':
      return { kind: 'line', p1: at(0), p2: at(2) };
    case 'circle':
      return { kind: 'circle', c: at(0), r: base + 2 };
    case 'arc':
      return { kind: 'arc', c: at(0), s: at(2), e: at(4), a1: base + 6, a2: base + 7, r: base + 8 };
    case 'point':
      throw new Error(`'${id}' is a point, not a curve`);
  }
}

/** Every parameter index a curve uses. */
export function curveParams(curve: Curve): number[] {
  switch (curve.kind) {
    case 'line':
      return [...curve.p1, ...curve.p2];
    case 'circle':
      return [...curve.c, curve.r];
    case 'arc':
      return [...curve.c, ...curve.s, ...curve.e, curve.a1, curve.a2, curve.r];
  }
}

/** The entities with coordinates read from `params`. */
export function readEntities(layout: Layout, params: ArrayLike<number>): SketchEntity[] {
  return layout.slots.map(({ entity: e, base }): SketchEntity => {
    const v = (o: number): Vec2 => [params[base + o]!, params[base + o + 1]!];
    switch (e.kind) {
      case 'point':
        return { ...e, position: v(0) };
      case 'line':
        return { ...e, start: v(0), end: v(2) };
      case 'circle':
        return { ...e, center: v(0), radius: params[base + 2]! };
      case 'arc':
        return { ...e, center: v(0), start: v(2), end: v(4) };
    }
  });
}

/** Pack coordinates straight from `params` in `packCoordinates` order. */
export function packFromParams(
  layout: Layout,
  params: ArrayLike<number>,
  out?: Float64Array,
): Float64Array {
  const count = layout.slots.reduce((n, s) => n + (s.entity.kind === 'arc' ? 6 : s.size), 0);
  const result = out && out.length === count ? out : new Float64Array(count);
  let i = 0;
  for (const { entity, base } of layout.slots) {
    const n = entity.kind === 'arc' ? 6 : SIZES[entity.kind];
    for (let k = 0; k < n; k++) result[i++] = params[base + k]!;
  }
  return result;
}
