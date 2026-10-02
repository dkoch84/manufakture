// Plain 2D geometry for the sketcher, in sketch coordinates (millimetres).
// No rendering and no solver: hit testing, snapping, the tools and the
// dimension placement are built on these.

import {
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type ArcEntity,
  type PointPosition,
  type PointRef,
  type SketchEntity,
  type Vec2,
} from '@manufakture/sketch/model';

export const TAU = Math.PI * 2;

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const length = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** Rotated a quarter turn counter-clockwise. */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}

/** An angle wrapped into [0, 2 pi). */
export function wrapAngle(a: number): number {
  const w = a % TAU;
  return w < 0 ? w + TAU : w;
}

/** An angle difference wrapped into (-pi, pi]. */
export function wrapDelta(a: number): number {
  const w = wrapAngle(a);
  return w > Math.PI ? w - TAU : w;
}

export const angleOf = (v: Vec2): number => Math.atan2(v[1], v[0]);

/** Entities by id, including nothing for the built-ins. */
export type EntityIndex = ReadonlyMap<string, SketchEntity>;

export function indexEntities(entities: readonly SketchEntity[]): Map<string, SketchEntity> {
  return new Map(entities.map((e) => [e.id, e]));
}

export function isBuiltin(id: string): boolean {
  return id === SKETCH_ORIGIN || id === SKETCH_X_AXIS || id === SKETCH_Y_AXIS;
}

/** Where a point reference currently is, or null when it names nothing. */
export function pointPosition(index: EntityIndex, ref: PointRef): Vec2 | null {
  if (ref.entity === SKETCH_ORIGIN) return [0, 0];
  const e = index.get(ref.entity);
  if (!e) return null;
  switch (e.kind) {
    case 'point':
      return ref.at === undefined ? e.position : null;
    case 'line':
      return ref.at === 'start' ? e.start : ref.at === 'end' ? e.end : null;
    case 'circle':
      return ref.at === 'center' ? e.center : null;
    case 'arc':
      return ref.at === 'start'
        ? e.start
        : ref.at === 'end'
          ? e.end
          : ref.at === 'center'
            ? e.center
            : null;
    case 'outline':
      return ref.at === 'anchor' ? e.anchor : null;
  }
}

export interface Vertex {
  ref: PointRef;
  position: Vec2;
}

/** The points of an entity that constraints can name. */
export function entityVertices(e: SketchEntity): Vertex[] {
  const v = (at: PointPosition | undefined, position: Vec2): Vertex => ({
    ref: at === undefined ? { entity: e.id } : { entity: e.id, at },
    position,
  });
  switch (e.kind) {
    case 'point':
      return [v(undefined, e.position)];
    case 'line':
      return [v('start', e.start), v('end', e.end)];
    case 'circle':
      return [v('center', e.center)];
    case 'arc':
      return [v('start', e.start), v('end', e.end), v('center', e.center)];
    case 'outline':
      return [v('anchor', e.anchor)];
  }
}

export function sameRef(a: PointRef, b: PointRef): boolean {
  return a.entity === b.entity && a.at === b.at;
}

export function arcRadius(arc: Pick<ArcEntity, 'center' | 'start'>): number {
  return distance(arc.center, arc.start);
}

/** Start angle and counter-clockwise sweep in (0, 2 pi] of an arc. */
export function arcAngles(arc: Pick<ArcEntity, 'center' | 'start' | 'end'>): {
  start: number;
  sweep: number;
} {
  const start = angleOf(sub(arc.start, arc.center));
  const end = angleOf(sub(arc.end, arc.center));
  const sweep = wrapAngle(end - start);
  return { start, sweep: sweep === 0 ? TAU : sweep };
}

/** Whether a direction from the arc's centre falls within its sweep. */
export function arcContainsAngle(
  arc: Pick<ArcEntity, 'center' | 'start' | 'end'>,
  angle: number,
): boolean {
  const { start, sweep } = arcAngles(arc);
  return wrapAngle(angle - start) <= sweep + 1e-12;
}

/** The nearest point of a segment to `p`. */
export function closestOnSegment(a: Vec2, b: Vec2, p: Vec2): Vec2 {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 === 0) return a;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / l2));
  return add(a, scale(d, t));
}

/** The nearest point of an (unbounded) line through `a` and `b` to `p`. */
export function projectOnLine(a: Vec2, b: Vec2, p: Vec2): Vec2 {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 === 0) return a;
  return add(a, scale(d, dot(sub(p, a), d) / l2));
}

/** The nearest point of an entity's curve (or the point itself) to `p`. */
export function closestOnEntity(e: SketchEntity, p: Vec2): Vec2 {
  switch (e.kind) {
    case 'point':
      return e.position;
    case 'line':
      return closestOnSegment(e.start, e.end, p);
    case 'circle': {
      const d = sub(p, e.center);
      const l = length(d);
      return l === 0 ? add(e.center, [e.radius, 0]) : add(e.center, scale(d, e.radius / l));
    }
    case 'arc': {
      const r = arcRadius(e);
      const d = sub(p, e.center);
      if (arcContainsAngle(e, angleOf(d)) && length(d) > 0) {
        return add(e.center, scale(d, r / length(d)));
      }
      return distance(p, e.start) <= distance(p, e.end) ? e.start : e.end;
    }
    case 'outline':
      // A text's letters are not curves here: the session picks a text by the box of its
      // letters (text.ts, `shapesBox`), and snaps and constrains it by its anchor.
      return e.anchor;
  }
}

export function distanceToEntity(e: SketchEntity, p: Vec2): number {
  return distance(p, closestOnEntity(e, p));
}

/**
 * Points along an entity, for drawing and for fills: lines are their two
 * ends, circles and arcs are flattened to at most `maxStep` radians a segment.
 */
export function tessellate(e: SketchEntity, maxStep = Math.PI / 36): Vec2[] {
  switch (e.kind) {
    case 'point':
      return [e.position];
    case 'line':
      return [e.start, e.end];
    case 'circle':
      return arcPoints(e.center, e.radius, 0, TAU, maxStep);
    case 'arc': {
      const { start, sweep } = arcAngles(e);
      const pts = arcPoints(e.center, arcRadius(e), start, sweep, maxStep);
      // End exactly on the stored points, so the drawing joins its neighbours.
      pts[0] = e.start;
      pts[pts.length - 1] = e.end;
      return pts;
    }
    case 'outline':
      // Text is drawn from its layout (text.ts, `glyphOutlines`), not from the entity.
      return [e.anchor];
  }
}

export function arcPoints(
  center: Vec2,
  radius: number,
  start: number,
  sweep: number,
  maxStep = Math.PI / 36,
): Vec2[] {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / maxStep));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return out;
}

/** The circle through three points, or null when they are (nearly) collinear. */
export function circleThrough(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const scaleRef = Math.max(distance(a, b), distance(b, c), distance(a, c));
  if (scaleRef === 0 || Math.abs(d) < 1e-9 * scaleRef * scaleRef) return null;
  const a2 = dot(a, a);
  const b2 = dot(b, b);
  const c2 = dot(c, c);
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
  return { center, radius: distance(center, a) };
}

/**
 * Arc geometry in the model's counter-clockwise form. `reversed` is true when
 * the arc was drawn clockwise, so the drawn start became the stored `end`.
 */
export interface ArcGeometry {
  center: Vec2;
  start: Vec2;
  end: Vec2;
  reversed: boolean;
}

/** The arc from `start` to `end` passing through `through`, or null when degenerate. */
export function arcThroughPoints(start: Vec2, end: Vec2, through: Vec2): ArcGeometry | null {
  if (distance(start, end) < 1e-9) return null;
  const c = circleThrough(start, through, end);
  if (!c) return null;
  // start -> through -> end is counter-clockwise when `through` is to the right of start->end.
  const ccw = cross(sub(end, start), sub(through, start)) < 0;
  return ccw
    ? { center: c.center, start, end, reversed: false }
    : { center: c.center, start: end, end: start, reversed: true };
}

/**
 * The arc leaving `start` in direction `tangent` and ending at `end`, or null
 * when `end` lies on the tangent line (a straight continuation).
 */
export function tangentArc(start: Vec2, tangent: Vec2, end: Vec2): ArcGeometry | null {
  const t = normalize(tangent);
  const n = perp(t); // left of the direction of travel
  const chord = sub(end, start);
  const h = dot(n, chord);
  const l2 = dot(chord, chord);
  if (l2 < 1e-18 || Math.abs(h) < 1e-9 * Math.sqrt(l2)) return null;
  // Centre on the normal through `start`, equally far from `start` and `end`.
  const s = l2 / (2 * h);
  const center = add(start, scale(n, s));
  // Turning left (s > 0) runs counter-clockwise.
  return s > 0
    ? { center, start, end, reversed: false }
    : { center, start: end, end: start, reversed: true };
}

/**
 * The arc about `center` from `start`, swept by `sweep` radians (negative:
 * clockwise), with the end on the start's radius.
 */
export function centerArc(center: Vec2, start: Vec2, sweep: number): ArcGeometry | null {
  const r = distance(center, start);
  if (r < 1e-9 || Math.abs(sweep) < 1e-9) return null;
  const a0 = angleOf(sub(start, center));
  const s = Math.max(-TAU + 1e-6, Math.min(TAU - 1e-6, sweep));
  const end: Vec2 = [center[0] + r * Math.cos(a0 + s), center[1] + r * Math.sin(a0 + s)];
  return s > 0
    ? { center, start, end, reversed: false }
    : { center, start: end, end: start, reversed: true };
}

/**
 * The direction in which a curve continues past one of its ends: along a
 * line away from its other end, and along an arc's circle out of the arc.
 */
export function outwardTangent(e: SketchEntity, at: 'start' | 'end'): Vec2 | null {
  if (e.kind === 'line') {
    return normalize(at === 'end' ? sub(e.end, e.start) : sub(e.start, e.end));
  }
  if (e.kind === 'arc') {
    // Counter-clockwise travel: the tangent at a point is the radius turned left.
    if (at === 'end') return normalize(perp(sub(e.end, e.center)));
    return normalize(scale(perp(sub(e.start, e.center)), -1));
  }
  return null;
}

/** Length of a line, radius of a circle or arc; null for points. */
export function entitySize(e: SketchEntity): number | null {
  if (e.kind === 'line') return distance(e.start, e.end);
  if (e.kind === 'circle') return e.radius;
  if (e.kind === 'arc') return arcRadius(e);
  return null;
}

/** A point on the curve suitable for a label: a line's middle, an arc's middle, a circle's top right. */
export function curveAnchor(e: SketchEntity): Vec2 {
  switch (e.kind) {
    case 'point':
      return e.position;
    case 'line':
      return midpoint(e.start, e.end);
    case 'circle':
      return add(e.center, scale([Math.SQRT1_2, Math.SQRT1_2], e.radius));
    case 'arc': {
      const { start, sweep } = arcAngles(e);
      const a = start + sweep / 2;
      const r = arcRadius(e);
      return [e.center[0] + r * Math.cos(a), e.center[1] + r * Math.sin(a)];
    }
    case 'outline':
      return e.anchor;
  }
}

/** Bounding box of a set of points, or null for none. */
export function bounds(points: readonly Vec2[]): { min: Vec2; max: Vec2 } | null {
  if (points.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { min: [x0, y0], max: [x1, y1] };
}
