// What can be hovered and selected in a sketch, and hit testing to find it
// under the cursor. Points win over curves within the tolerance, sketch
// geometry wins over the built-in origin and axes.

import {
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type PointRef,
  type SketchEntity,
  type Vec2,
} from '@manufakture/sketch/model';
import { closestOnEntity, distance, entityVertices, isBuiltin } from './geometry';

export type SketchItem =
  | { kind: 'point'; ref: PointRef }
  /** A whole entity: a curve, or a point entity. */
  | { kind: 'entity'; id: string }
  | { kind: 'constraint'; id: string };

export function itemKey(item: SketchItem): string {
  switch (item.kind) {
    case 'point':
      return `point:${item.ref.entity}${item.ref.at ? `.${item.ref.at}` : ''}`;
    case 'entity':
      return `entity:${item.id}`;
    case 'constraint':
      return `constraint:${item.id}`;
  }
}

export function sameItem(a: SketchItem | null, b: SketchItem | null): boolean {
  if (a === null || b === null) return a === b;
  return itemKey(a) === itemKey(b);
}

/** The entity an item belongs to, or null for a constraint. */
export function itemEntity(item: SketchItem): string | null {
  if (item.kind === 'point') return item.ref.entity;
  if (item.kind === 'entity') return item.id;
  return null;
}

/**
 * The item under `p` within `tolerance` (sketch units): a vertex, else a
 * curve, else the origin or an axis. A point entity counts as a point.
 */
export function hitTest(
  entities: readonly SketchEntity[],
  p: Vec2,
  tolerance: number,
): SketchItem | null {
  let best: SketchItem | null = null;
  let bestD = tolerance;
  for (const e of entities) {
    for (const v of entityVertices(e)) {
      const d = distance(p, v.position);
      if (d < bestD) {
        best = { kind: 'point', ref: v.ref };
        bestD = d;
      }
    }
  }
  if (best) return best;
  for (const e of entities) {
    if (e.kind === 'point') continue;
    const d = distance(p, closestOnEntity(e, p));
    if (d < bestD) {
      best = { kind: 'entity', id: e.id };
      bestD = d;
    }
  }
  if (best) return best;
  if (distance(p, [0, 0]) < tolerance) return { kind: 'point', ref: { entity: SKETCH_ORIGIN } };
  if (Math.abs(p[1]) < tolerance * 0.75) return { kind: 'entity', id: SKETCH_X_AXIS };
  if (Math.abs(p[0]) < tolerance * 0.75) return { kind: 'entity', id: SKETCH_Y_AXIS };
  return null;
}

/** Whether the item names a built-in (origin or axis), which cannot be edited. */
export function isBuiltinItem(item: SketchItem): boolean {
  const id = itemEntity(item);
  return id !== null && isBuiltin(id);
}

/** Shift adds, Ctrl (Cmd on macOS) toggles, a plain click replaces. */
export function selectModeOf(e: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): 'replace' | 'add' | 'toggle' {
  if (e.ctrlKey || e.metaKey) return 'toggle';
  if (e.shiftKey) return 'add';
  return 'replace';
}
