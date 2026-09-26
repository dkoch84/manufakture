// Splitting an entity into pieces named `<id>#a`, `<id>#b`, ... in order
// along the original (T0.5): the naming layer reads `e2` as the ancestor of
// `e2#a`, so faces extruded from the pieces still resolve references to `e2`.
// Re-attaching the original's constraints to the pieces is the editor's job.

import { splitIds } from './ids';
import { arcAngles } from './layout';
import type { ArcEntity, SketchEntity, Vec2 } from './model';

export type SplitResult = SketchEntity[];

const EPS = 1e-9;
const TAU = 2 * Math.PI;

function dedupe(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1]! > EPS);
}

function onCircle(center: Vec2, r: number, angle: number): Vec2 {
  return [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)];
}

/**
 * Split a line or an arc at one or more points (projected onto it), or a
 * circle at two or more points. Pieces come back in order along the original:
 * from start to end for lines and arcs, counter-clockwise from the first
 * split point at or after angle 0 for circles. Throws when a point is not
 * strictly inside the entity, or the entity cannot be split that way.
 */
export function splitEntity(entity: SketchEntity, at: Vec2 | readonly Vec2[]): SplitResult {
  const points: readonly Vec2[] =
    typeof at[0] === 'number' ? [at as Vec2] : (at as readonly Vec2[]);
  const { id, construction } = entity;
  switch (entity.kind) {
    case 'point':
      throw new Error(`Cannot split point '${id}'`);
    case 'line': {
      const [sx, sy] = entity.start;
      const dx = entity.end[0] - sx;
      const dy = entity.end[1] - sy;
      const len2 = dx * dx + dy * dy;
      const ts = dedupe(points.map((p) => ((p[0] - sx) * dx + (p[1] - sy) * dy) / len2));
      if (ts.some((t) => t <= EPS || t >= 1 - EPS))
        throw new Error(`Split point outside line '${id}'`);
      const cuts: Vec2[] = [
        entity.start,
        ...ts.map((t): Vec2 => [sx + t * dx, sy + t * dy]),
        entity.end,
      ];
      const ids = splitIds(id, cuts.length - 1);
      return ids.map((pid, i) => ({
        id: pid,
        kind: 'line',
        construction,
        start: cuts[i]!,
        end: cuts[i + 1]!,
      }));
    }
    case 'arc': {
      const [a1, a2] = arcAngles(entity.center, entity.start, entity.end);
      const r = Math.hypot(entity.start[0] - entity.center[0], entity.start[1] - entity.center[1]);
      const angles = dedupe(
        points.map((p) => {
          let a = Math.atan2(p[1] - entity.center[1], p[0] - entity.center[0]);
          while (a < a1) a += TAU;
          return a;
        }),
      );
      if (angles.some((a) => a <= a1 + EPS || a >= a2 - EPS))
        throw new Error(`Split point outside arc '${id}'`);
      const cuts: Vec2[] = [
        entity.start,
        ...angles.map((a) => onCircle(entity.center, r, a)),
        entity.end,
      ];
      const ids = splitIds(id, cuts.length - 1);
      return ids.map((pid, i): ArcEntity => ({
        id: pid,
        kind: 'arc',
        construction,
        center: entity.center,
        start: cuts[i]!,
        end: cuts[i + 1]!,
      }));
    }
    case 'circle': {
      const angles = dedupe(
        points.map((p) => {
          const a = Math.atan2(p[1] - entity.center[1], p[0] - entity.center[0]);
          return a < 0 ? a + TAU : a;
        }),
      );
      if (angles.length < 2) throw new Error(`Splitting circle '${id}' needs two distinct points`);
      const cuts = angles.map((a) => onCircle(entity.center, entity.radius, a));
      const ids = splitIds(id, cuts.length);
      return ids.map((pid, i): ArcEntity => ({
        id: pid,
        kind: 'arc',
        construction,
        center: entity.center,
        start: cuts[i]!,
        end: cuts[(i + 1) % cuts.length]!,
      }));
    }
  }
}
