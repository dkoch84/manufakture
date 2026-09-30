import { featureExpressions } from './features';
import type { ManufaktureDocument, Part, Variable } from './schema';
import { expressionVariableNames } from './validate';

/**
 * What changed between two documents, for subscribers: regen (T1.9) restarts from
 * `firstAffectedIndex`, and the UI refreshes what it shows. Computed by comparing documents, so
 * it is the same whether the change came from a command, an undo, a redo or a load.
 */
export interface DocumentChange {
  /** Nothing changed at all. */
  readonly empty: boolean;
  readonly nameChanged: boolean;
  /** Display units only: stored expressions keep their own units, so no geometry changes. */
  readonly unitsChanged: boolean;
  readonly variables: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly parts: readonly PartChange[];
}

export interface PartChange {
  readonly partId: string;
  /** Parts that exist in only one of the two documents. */
  readonly status: 'added' | 'removed' | 'changed';
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Features whose inputs, name or suppression changed. */
  readonly changed: readonly string[];
  /** The relative order of features present in both documents changed. */
  readonly reordered: boolean;
  readonly rollbackChanged: boolean;
  /** The part's material changed. No geometry changes; masses do. */
  readonly materialChanged: boolean;
  /**
   * A body's name, colour or material changed (`Part.bodies`). No geometry changes; what bodies
   * look like and weigh does.
   */
  readonly bodyPropsChanged: boolean;
  /**
   * The first index in the new feature list whose result may differ, because the feature or an
   * earlier one was added, removed, edited, moved, suppressed, or reads a changed variable (also
   * through other variables), or because the rollback bar moved past it. `null`: no feature
   * result changes (a rename, or nothing at all).
   */
  readonly firstAffectedIndex: number | null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

function diffVariables(prev: readonly Variable[], next: readonly Variable[]) {
  const p = new Map(prev.map((v) => [v.name, v]));
  const n = new Map(next.map((v) => [v.name, v]));
  return {
    added: next.filter((v) => !p.has(v.name)).map((v) => v.name),
    removed: prev.filter((v) => !n.has(v.name)).map((v) => v.name),
    changed: next
      .filter((v) => p.has(v.name) && !deepEqual(p.get(v.name)!.expression, v.expression))
      .map((v) => v.name),
  };
}

/** Changed variables plus every variable that reads one of them, directly or not. */
function affectedVariables(next: readonly Variable[], touched: Iterable<string>): Set<string> {
  const affected = new Set(touched);
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of next) {
      if (affected.has(v.name)) continue;
      if (expressionVariableNames(v.expression).some((d) => affected.has(d))) {
        affected.add(v.name);
        grew = true;
      }
    }
  }
  return affected;
}

function withoutName<T extends { name: string }>(f: T): Omit<T, 'name'> {
  const { name: _name, ...rest } = f;
  void _name;
  return rest;
}

function diffPart(
  prev: Part | undefined,
  next: Part | undefined,
  vars: ReadonlySet<string>,
): PartChange {
  const partId = (next ?? prev)!.id;
  const pf = prev?.features ?? [];
  const nf = next?.features ?? [];
  const pById = new Map(pf.map((f) => [f.id, f]));
  const nIds = new Set(nf.map((f) => f.id));
  const added = nf.filter((f) => !pById.has(f.id)).map((f) => f.id);
  const removed = pf.filter((f) => !nIds.has(f.id)).map((f) => f.id);
  const changed: string[] = [];
  let first: number | null = null;
  const mark = (i: number) => {
    if (first === null || i < first) first = i;
  };

  const pCommon = pf.filter((f) => nIds.has(f.id)).map((f) => f.id);
  const nCommon = nf.filter((f) => pById.has(f.id)).map((f) => f.id);
  const reordered = pCommon.some((id, i) => nCommon[i] !== id);

  let common = 0;
  nf.forEach((f, i) => {
    const old = pById.get(f.id);
    if (!old) {
      mark(i);
      return;
    }
    if (nCommon[common] !== pCommon[common]) mark(i);
    common++;
    if (!deepEqual(old, f)) {
      changed.push(f.id);
      if (!deepEqual(withoutName(old), withoutName(f))) mark(i);
    }
    if (
      vars.size > 0 &&
      featureExpressions(f).some((s) =>
        expressionVariableNames(s.expression).some((n) => vars.has(n)),
      )
    ) {
      mark(i);
    }
  });
  // A removed feature affects whatever now sits where it was.
  pf.forEach((f, i) => {
    if (!nIds.has(f.id)) {
      const before = pf.slice(0, i).filter((x) => nIds.has(x.id)).length;
      mark(before);
    }
  });

  const prb = prev?.rollbackIndex ?? null;
  const nrb = next?.rollbackIndex ?? null;
  const rollbackChanged = prb !== nrb;
  if (rollbackChanged && prev && next) {
    // Features between the two bar positions switch between active and inactive.
    const p = prb ?? pf.length;
    const n = nrb ?? nf.length;
    mark(Math.min(p, n));
  }
  if (first !== null && first > nf.length) first = nf.length;
  const materialChanged = !!prev && !!next && prev.material !== next.material;
  const bodyPropsChanged = !!prev && !!next && !deepEqual(prev.bodies, next.bodies);

  return {
    partId,
    status: !prev ? 'added' : !next ? 'removed' : 'changed',
    added,
    removed,
    changed,
    reordered,
    rollbackChanged,
    materialChanged,
    bodyPropsChanged,
    firstAffectedIndex: first,
  };
}

export function diffDocuments(
  prev: ManufaktureDocument,
  next: ManufaktureDocument,
): DocumentChange {
  const variables = diffVariables(prev.variables, next.variables);
  const vars = affectedVariables(next.variables, [
    ...variables.added,
    ...variables.removed,
    ...variables.changed,
  ]);
  const pParts = new Map(prev.parts.map((p) => [p.id, p]));
  const nParts = new Map(next.parts.map((p) => [p.id, p]));
  const parts: PartChange[] = [];
  for (const p of next.parts) {
    const old = pParts.get(p.id);
    // An untouched part still changes when its features read a changed variable.
    if (old === p && vars.size === 0) continue;
    const c = diffPart(old, p, vars);
    const noop =
      c.status === 'changed' &&
      c.added.length + c.removed.length + c.changed.length === 0 &&
      !c.reordered &&
      !c.rollbackChanged &&
      !c.materialChanged &&
      !c.bodyPropsChanged &&
      c.firstAffectedIndex === null &&
      deepEqual(old, p);
    if (!noop) parts.push(c);
  }
  for (const p of prev.parts) if (!nParts.has(p.id)) parts.push(diffPart(p, undefined, vars));
  const nameChanged = prev.name !== next.name;
  const unitsChanged = !deepEqual(prev.units, next.units);
  const empty =
    !nameChanged &&
    !unitsChanged &&
    variables.added.length + variables.removed.length + variables.changed.length === 0 &&
    parts.length === 0 &&
    deepEqual(prev, next);
  return { empty, nameChanged, unitsChanged, variables, parts };
}
