// A draft is what a tool emits: new entities and constraints with temporary
// ids (`$0`, `$1`, ...) that refer to each other and to existing geometry.
// The session gives them permanent ids from the part's counters when it adds
// them, so the tools stay pure and never touch id allocation.

import type { PointRef, SketchConstraint, SketchEntity } from '@manufakture/sketch/model';
import type { PickPoint, SnapTarget } from './snap';

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A constraint before it has an id. */
export type DraftConstraint = DistributiveOmit<SketchConstraint, 'id'>;

export interface Draft {
  entities: SketchEntity[];
  constraints: DraftConstraint[];
}

export const TEMP_PREFIX = '$';

export const tempId = (n: number): string => `${TEMP_PREFIX}${n}`;

export function isTempId(id: string): boolean {
  return id.startsWith(TEMP_PREFIX);
}

/** The constraint a snapped point implies for the new point `ref`. */
export function snapConstraints(target: SnapTarget | null, ref: PointRef): DraftConstraint[] {
  if (!target) return [];
  if (target.kind === 'point') {
    if (target.ref.entity === ref.entity && target.ref.at === ref.at) return [];
    return [{ kind: 'coincident', a: target.ref, b: ref }];
  }
  if (target.entity === ref.entity) return [];
  return [{ kind: 'pointOnObject', point: ref, on: target.entity }];
}

/** Horizontal or vertical for a new line from what its end point inferred. */
export function directionConstraints(pick: PickPoint, line: string): DraftConstraint[] {
  if (pick.horizontal) return [{ kind: 'horizontal', line }];
  if (pick.vertical) return [{ kind: 'vertical', line }];
  return [];
}

export interface Materialized {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  /** Temporary id to permanent id. */
  ids: ReadonlyMap<string, string>;
}

/**
 * Give a draft permanent ids. `entityId` and `constraintId` hand out the next
 * id of their counter on each call.
 */
export function materialize(
  draft: Draft,
  entityId: () => string,
  constraintId: () => string,
): Materialized {
  const ids = new Map<string, string>();
  for (const e of draft.entities) ids.set(e.id, entityId());
  const rename = (id: string) => ids.get(id) ?? id;
  const entities = draft.entities.map((e) => ({ ...e, id: rename(e.id) }));
  const constraints = draft.constraints.map(
    (c) => ({ ...renameRefs(c, rename), id: constraintId() }) as SketchConstraint,
  );
  return { entities, constraints, ids };
}

/** A constraint (or draft) with every entity id it names passed through `rename`. */
export function renameRefs<C extends DraftConstraint | SketchConstraint>(
  c: C,
  rename: (id: string) => string,
): C {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(c)) {
    if (key === 'id' || key === 'kind' || key === 'value' || key === 'at') out[key] = v;
    else if (typeof v === 'string') out[key] = rename(v);
    else if (v && typeof v === 'object' && 'entity' in v) {
      const p = v as PointRef;
      out[key] = { ...p, entity: rename(p.entity) };
    } else out[key] = v;
  }
  return out as C;
}

/** A pick point whose snap target names temporary ids, renamed. */
export function renamePick(pick: PickPoint, rename: (id: string) => string): PickPoint {
  const t = pick.target;
  let target: SnapTarget | null = t;
  if (t?.kind === 'point')
    target = { kind: 'point', ref: { ...t.ref, entity: rename(t.ref.entity) } };
  else if (t?.kind === 'curve') target = { kind: 'curve', entity: rename(t.entity) };
  return { ...pick, target };
}
