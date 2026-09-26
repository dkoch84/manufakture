// Dimensions: which constraint a pick of one or two items makes, what it
// currently measures, and where its lines and label go.
//
// One line gives its length, a circle its diameter, an arc its radius. Two
// points give their distance; a point and a line the distance to the line;
// two lines the angle between them, or their distance when they are parallel.
// A circle or arc picked together with something else stands for its centre.

import {
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type DimensionalConstraint,
  type PointRef,
  type SketchConstraint,
  type SketchEntity,
  type Vec2,
} from '@manufakture/sketch/model';
import type { DistributiveOmit } from './draft';
import {
  add,
  angleOf,
  arcRadius,
  cross,
  curveAnchor,
  distance,
  dot,
  length,
  midpoint,
  normalize,
  perp,
  pointPosition,
  projectOnLine,
  scale,
  sub,
  TAU,
  wrapAngle,
  type EntityIndex,
} from './geometry';

/** Something the dimension tool can pick: a point, or a whole curve. */
export type DimensionPick = { kind: 'point'; ref: PointRef } | { kind: 'curve'; entity: string };

/** A dimensional constraint before it has an id and a value. */
export type DraftDimension = DistributiveOmit<DimensionalConstraint, 'id' | 'value'>;

export interface DimensionProposal {
  constraint: DraftDimension;
  /** What it measures now, in millimetres or radians. */
  measured: number;
  kind: 'length' | 'angle';
}

/** The ends of a line (built-in axes included) as two points, or null. */
function lineEnds(index: EntityIndex, id: string): [Vec2, Vec2] | null {
  if (id === SKETCH_X_AXIS)
    return [
      [0, 0],
      [1, 0],
    ];
  if (id === SKETCH_Y_AXIS)
    return [
      [0, 0],
      [0, 1],
    ];
  const e = index.get(id);
  return e?.kind === 'line' ? [e.start, e.end] : null;
}

function isLine(index: EntityIndex, id: string): boolean {
  return lineEnds(index, id) !== null;
}

/** A pick as a point reference: a point itself, or a circle's or arc's centre. */
function asPoint(index: EntityIndex, pick: DimensionPick): PointRef | null {
  if (pick.kind === 'point') return pick.ref;
  const e = index.get(pick.entity);
  if (e?.kind === 'circle' || e?.kind === 'arc') return { entity: e.id, at: 'center' };
  return null;
}

/** The counter-clockwise angle from line `a` to line `b`, in [0, 2 pi). */
function lineAngle(index: EntityIndex, a: string, b: string): number | null {
  const la = lineEnds(index, a);
  const lb = lineEnds(index, b);
  if (!la || !lb) return null;
  return wrapAngle(angleOf(sub(lb[1], lb[0])) - angleOf(sub(la[1], la[0])));
}

const PARALLEL = 1e-6;

/** The dimension for a pick of one or two items, or null when they make none. */
export function proposeDimension(
  picks: readonly DimensionPick[],
  index: EntityIndex,
): DimensionProposal | null {
  if (picks.length === 1) {
    const p = picks[0]!;
    if (p.kind !== 'curve') return null;
    const e = index.get(p.entity);
    if (e?.kind === 'line') {
      const constraint: DraftDimension = {
        kind: 'distance',
        a: { entity: e.id, at: 'start' },
        b: { entity: e.id, at: 'end' },
      };
      return { constraint, measured: distance(e.start, e.end), kind: 'length' };
    }
    if (e?.kind === 'circle') {
      return {
        constraint: { kind: 'diameter', entity: e.id },
        measured: 2 * e.radius,
        kind: 'length',
      };
    }
    if (e?.kind === 'arc') {
      return {
        constraint: { kind: 'radius', entity: e.id },
        measured: arcRadius(e),
        kind: 'length',
      };
    }
    return null;
  }
  if (picks.length !== 2) return null;
  const [p, q] = picks as [DimensionPick, DimensionPick];

  // Two lines: an angle, or a distance when parallel.
  if (
    p.kind === 'curve' &&
    q.kind === 'curve' &&
    isLine(index, p.entity) &&
    isLine(index, q.entity)
  ) {
    if (p.entity === q.entity) return null;
    const angle = lineAngle(index, p.entity, q.entity)!;
    const offParallel = Math.min(angle % Math.PI, Math.PI - (angle % Math.PI));
    if (offParallel < PARALLEL) {
      // A point of a sketch line (an axis has none) against the other line.
      const [own, other] = index.has(p.entity) ? [p.entity, q.entity] : [q.entity, p.entity];
      const point: PointRef = { entity: own, at: 'start' };
      const line = other;
      const from = lineEnds(index, own)![0];
      const lb = lineEnds(index, line)!;
      const measured = distance(from, projectOnLine(lb[0], lb[1], from));
      if (measured < 1e-9) return null;
      return { constraint: { kind: 'distance', point, line }, measured, kind: 'length' };
    }
    // Measure the smaller way round: from the first to the second pick, or back.
    if (angle <= Math.PI) {
      return {
        constraint: { kind: 'angle', a: p.entity, b: q.entity },
        measured: angle,
        kind: 'angle',
      };
    }
    return {
      constraint: { kind: 'angle', a: q.entity, b: p.entity },
      measured: TAU - angle,
      kind: 'angle',
    };
  }

  // A point and a line.
  for (const [pt, ln] of [
    [p, q],
    [q, p],
  ] as const) {
    if (ln.kind === 'curve' && isLine(index, ln.entity)) {
      const ref = asPoint(index, pt);
      if (!ref) continue;
      const at = pointPosition(index, ref);
      const ends = lineEnds(index, ln.entity)!;
      if (!at) return null;
      const measured = distance(at, projectOnLine(ends[0], ends[1], at));
      if (measured < 1e-9) return null;
      return {
        constraint: { kind: 'distance', point: ref, line: ln.entity },
        measured,
        kind: 'length',
      };
    }
  }

  // Two points (or centres).
  const a = asPoint(index, p);
  const b = asPoint(index, q);
  if (!a || !b) return null;
  const pa = pointPosition(index, a);
  const pb = pointPosition(index, b);
  if (!pa || !pb) return null;
  const measured = distance(pa, pb);
  if (measured < 1e-9) return null;
  return { constraint: { kind: 'distance', a, b }, measured, kind: 'length' };
}

/** What a dimensional constraint measures in the current geometry, or null. */
export function measureDimension(
  c: DimensionalConstraint | DraftDimension,
  index: EntityIndex,
): number | null {
  switch (c.kind) {
    case 'distance': {
      if ('line' in c) {
        const at = pointPosition(index, c.point);
        const ends = lineEnds(index, c.line);
        return at && ends ? distance(at, projectOnLine(ends[0], ends[1], at)) : null;
      }
      const a = pointPosition(index, c.a);
      const b = pointPosition(index, c.b);
      return a && b ? distance(a, b) : null;
    }
    case 'horizontalDistance':
    case 'verticalDistance': {
      const a = pointPosition(index, c.a);
      const b = pointPosition(index, c.b);
      if (!a || !b) return null;
      return c.kind === 'horizontalDistance' ? b[0] - a[0] : b[1] - a[1];
    }
    case 'angle':
      return lineAngle(index, c.a, c.b);
    case 'radius':
    case 'diameter': {
      const e = index.get(c.entity);
      const r = e?.kind === 'circle' ? e.radius : e?.kind === 'arc' ? arcRadius(e) : null;
      return r === null ? null : c.kind === 'diameter' ? 2 * r : r;
    }
  }
}

/** Lines to draw for a dimension, and where its label goes by default. */
export interface DimensionLayout {
  /** Polylines in sketch coordinates. */
  lines: Vec2[][];
  /** Arrow tips: where each dimension line ends, with the direction it points. */
  arrows: { at: Vec2; dir: Vec2 }[];
  label: Vec2;
}

/**
 * The layout of a dimension. `label` is where the user put the label (sketch
 * coordinates); without it the label sits `gap` (sketch units) off the
 * geometry. The dimension line runs through the label.
 */
export function layoutDimension(
  c: DimensionalConstraint | DraftDimension,
  index: EntityIndex,
  gap: number,
  label?: Vec2,
): DimensionLayout | null {
  switch (c.kind) {
    case 'distance':
    case 'horizontalDistance':
    case 'verticalDistance': {
      let a: Vec2 | null;
      let b: Vec2 | null;
      if ('line' in c) {
        a = pointPosition(index, c.point);
        const ends = lineEnds(index, c.line);
        b = a && ends ? projectOnLine(ends[0], ends[1], a) : null;
      } else {
        a = pointPosition(index, c.a);
        b = pointPosition(index, c.b);
      }
      if (!a || !b) return null;
      let dir: Vec2 =
        c.kind === 'horizontalDistance'
          ? [1, 0]
          : c.kind === 'verticalDistance'
            ? [0, 1]
            : normalize(sub(b, a));
      if (length(dir) === 0) dir = [1, 0];
      const n = perp(dir);
      const mid = midpoint(a, b);
      const where = label ?? add(mid, scale(n, gap));
      const offset = dot(sub(where, mid), n);
      // Dimension line: the measured span, moved sideways to the label.
      const a2 = add(a, scale(n, offset - dot(sub(a, mid), n)));
      const b2 = add(b, scale(n, offset - dot(sub(b, mid), n)));
      const lines: Vec2[][] = [
        [a, a2],
        [b, b2],
        [a2, b2],
      ];
      // Extend the dimension line to a label placed beyond the ends.
      const along = dot(sub(where, a2), dir);
      const span = dot(sub(b2, a2), dir);
      if (along < 0) lines.push([a2, add(a2, scale(dir, along))]);
      else if (along > span) lines.push([b2, add(a2, scale(dir, along))]);
      const d = normalize(sub(b2, a2));
      return {
        lines,
        arrows:
          length(d) > 0
            ? [
                { at: a2, dir: scale(d, -1) },
                { at: b2, dir: d },
              ]
            : [],
        label: where,
      };
    }
    case 'radius':
    case 'diameter': {
      const e = index.get(c.entity);
      if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) return null;
      const r = e.kind === 'circle' ? e.radius : arcRadius(e);
      const anchor = curveAnchor(e);
      const where = label ?? add(anchor, scale(normalize(sub(anchor, e.center)), gap));
      let dir = normalize(sub(where, e.center));
      if (length(dir) === 0) dir = [1, 0];
      const onCurve = add(e.center, scale(dir, r));
      const from = c.kind === 'diameter' ? add(e.center, scale(dir, -r)) : e.center;
      return {
        lines: [
          [from, onCurve],
          [onCurve, where],
        ],
        arrows: [{ at: onCurve, dir }],
        label: where,
      };
    }
    case 'angle': {
      const la = lineEnds(index, c.a);
      const lb = lineEnds(index, c.b);
      if (!la || !lb) return null;
      const da = normalize(sub(la[1], la[0]));
      const db = normalize(sub(lb[1], lb[0]));
      // The vertex: where the lines cross, else between their nearest ends.
      const denom = cross(da, db);
      const vertex: Vec2 =
        Math.abs(denom) > 1e-12
          ? add(la[0], scale(da, cross(sub(lb[0], la[0]), db) / denom))
          : midpoint(la[0], lb[0]);
      const a0 = angleOf(da);
      const sweep = wrapAngle(angleOf(db) - a0);
      const radius = label ? Math.max(distance(label, vertex), gap * 0.5) : gap * 1.5;
      const pts: Vec2[] = [];
      const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 36)));
      for (let i = 0; i <= steps; i++) {
        const t = a0 + (sweep * i) / steps;
        pts.push([vertex[0] + radius * Math.cos(t), vertex[1] + radius * Math.sin(t)]);
      }
      const mid = a0 + sweep / 2;
      const where = label ?? [
        vertex[0] + radius * Math.cos(mid),
        vertex[1] + radius * Math.sin(mid),
      ];
      return { lines: [pts], arrows: [], label: where };
    }
  }
}

/** Whether a constraint holds a dimension value. */
export function isDimension(c: SketchConstraint): c is DimensionalConstraint {
  return 'value' in c;
}

/** Items a dimension constrains, for highlighting. */
export function dimensionEntities(
  c: DraftDimension | SketchConstraint,
  entities: readonly SketchEntity[],
): string[] {
  const ids = new Set(entities.map((e) => e.id));
  const out: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (k === 'id' || k === 'kind' || k === 'value' || k === 'at') continue;
    const id =
      typeof v === 'string'
        ? v
        : v && typeof v === 'object' && 'entity' in v
          ? (v as PointRef).entity
          : null;
    if (id && ids.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
