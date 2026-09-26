// Snapping and constraint inference while drawing. Given the cursor in sketch
// coordinates, find what it should lock onto (an existing point, a curve, an
// axis) and which constraints the new geometry should get: coincident or
// point-on-object for the snap, horizontal or vertical for a nearly axis
// aligned line, tangent for a line leaving the end of an arc along it.
//
// Tolerances come in sketch units: the caller converts from pixels, so
// snapping feels the same at every zoom level. Holding the suppress modifier
// (Shift) turns all of it off.

import {
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type PointRef,
  type SketchEntity,
  type Vec2,
} from '@manufakture/sketch/model';
import {
  angleOf,
  closestOnEntity,
  distance,
  entityVertices,
  length,
  normalize,
  outwardTangent,
  sub,
  wrapDelta,
  type EntityIndex,
} from './geometry';

/** What a picked point locked onto. */
export type SnapTarget =
  | { kind: 'point'; ref: PointRef }
  /** On a curve of the sketch, or on an axis (`@x-axis`, `@y-axis`). */
  | { kind: 'curve'; entity: string };

/** A tangency to infer at the start of a new line: the curve end it continues. */
export interface TangentInference {
  entity: string;
  at: 'start' | 'end';
}

/** A snapped cursor position with what it implies. */
export interface PickPoint {
  position: Vec2;
  target: SnapTarget | null;
  /** From the tool's anchor to here is horizontal or vertical. */
  horizontal?: boolean;
  vertical?: boolean;
  /** The segment from the anchor continues this curve end smoothly. */
  tangent?: TangentInference;
}

export interface SnapOptions {
  /** Snap radius for points, in sketch units. */
  tolerance: number;
  /** Entities that must not be snapped to (the geometry being drawn). */
  exclude?: ReadonlySet<string>;
  /** Turn snapping and inference off (the user holds Shift). */
  suppress?: boolean;
  /** Snap to curves and axes too, not only points. Default true. */
  curves?: boolean;
}

/** Degrees within which a line counts as horizontal, vertical or tangent. */
export const INFERENCE_DEGREES = 4;

/** The vertex nearest to `p` within `tolerance`: entity points and the sketch origin. */
export function nearestVertex(
  entities: readonly SketchEntity[],
  p: Vec2,
  tolerance: number,
  exclude?: ReadonlySet<string>,
): { ref: PointRef; position: Vec2 } | null {
  const candidates: { ref: PointRef; position: Vec2 }[] = [];
  for (const e of entities) {
    if (!exclude?.has(e.id)) candidates.push(...entityVertices(e));
  }
  candidates.push({ ref: { entity: SKETCH_ORIGIN }, position: [0, 0] });
  let best: { ref: PointRef; position: Vec2 } | null = null;
  let bestD = tolerance;
  for (const c of candidates) {
    const d = distance(p, c.position);
    // Ties go to the earlier candidate: an entity's end before the origin.
    if (d < bestD || (best === null && d <= bestD)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** The curve (or axis) nearest to `p` within `tolerance`, with the nearest point on it. */
export function nearestCurve(
  entities: readonly SketchEntity[],
  p: Vec2,
  tolerance: number,
  exclude?: ReadonlySet<string>,
): { entity: string; position: Vec2 } | null {
  let best: { entity: string; position: Vec2 } | null = null;
  let bestD = tolerance;
  for (const e of entities) {
    if (e.kind === 'point' || exclude?.has(e.id)) continue;
    const q = closestOnEntity(e, p);
    const d = distance(p, q);
    if (d <= bestD) {
      best = { entity: e.id, position: q };
      bestD = d;
    }
  }
  // The axes rank below sketch curves: a curve lying on an axis wins.
  if (best === null) {
    if (Math.abs(p[1]) <= tolerance) best = { entity: SKETCH_X_AXIS, position: [p[0], 0] };
    else if (Math.abs(p[0]) <= tolerance) best = { entity: SKETCH_Y_AXIS, position: [0, p[1]] };
  }
  return best;
}

/** Snap the cursor to a point, else to a curve, else leave it where it is. */
export function snapCursor(
  entities: readonly SketchEntity[],
  cursor: Vec2,
  options: SnapOptions,
): PickPoint {
  if (options.suppress) return { position: cursor, target: null };
  const vertex = nearestVertex(entities, cursor, options.tolerance, options.exclude);
  if (vertex) return { position: vertex.position, target: { kind: 'point', ref: vertex.ref } };
  if (options.curves !== false) {
    // Curves snap within a slightly smaller radius, so points win near an end.
    const curve = nearestCurve(entities, cursor, options.tolerance * 0.75, options.exclude);
    if (curve) return { position: curve.position, target: { kind: 'curve', entity: curve.entity } };
  }
  return { position: cursor, target: null };
}

/**
 * Infer horizontal, vertical and tangent for a segment from `anchor` to the
 * picked point, and straighten the point to match when it is free. A point
 * snapped to another point stays put; it still infers horizontal or vertical
 * when it is aligned within `tolerance`.
 */
export function inferFromAnchor(
  pick: PickPoint,
  anchor: PickPoint,
  index: EntityIndex,
  options: SnapOptions,
): PickPoint {
  if (options.suppress) return pick;
  const d = sub(pick.position, anchor.position);
  const len = length(d);
  if (len < options.tolerance) return pick;
  const limit = (INFERENCE_DEGREES * Math.PI) / 180;
  const pinned = pick.target?.kind === 'point';

  // Tangent to the curve the anchor sits on the end of.
  const t = anchor.target;
  if (t?.kind === 'point' && (t.ref.at === 'start' || t.ref.at === 'end')) {
    const e = index.get(t.ref.entity);
    if (e?.kind === 'arc') {
      const dir = outwardTangent(e, t.ref.at);
      if (dir && Math.abs(wrapDelta(angleOf(d) - angleOf(dir))) < limit) {
        if (pinned) return { ...pick, tangent: { entity: e.id, at: t.ref.at } };
        const along = Math.max(len, 0);
        return {
          position: [anchor.position[0] + dir[0] * along, anchor.position[1] + dir[1] * along],
          target: null,
          tangent: { entity: e.id, at: t.ref.at },
        };
      }
    }
  }

  const angle = angleOf(normalize(d));
  const offH = Math.abs(wrapDelta(angle * 2)) / 2; // distance from 0 or pi
  const offV = Math.abs(wrapDelta(angle * 2 - Math.PI)) / 2; // from +-pi/2
  if (pinned) {
    const aligned = options.tolerance * 0.05;
    if (Math.abs(d[1]) <= aligned) return { ...pick, horizontal: true };
    if (Math.abs(d[0]) <= aligned) return { ...pick, vertical: true };
    return pick;
  }
  if (offH < limit) {
    return keepCurve({
      ...pick,
      position: [pick.position[0], anchor.position[1]],
      horizontal: true,
    });
  }
  if (offV < limit) {
    return keepCurve({ ...pick, position: [anchor.position[0], pick.position[1]], vertical: true });
  }
  return pick;
}

/** Straightening moves a point off the curve it snapped to: drop that snap. */
function keepCurve(pick: PickPoint): PickPoint {
  if (pick.target?.kind !== 'curve') return pick;
  return { ...pick, target: null };
}
