// The feature tree's logic, free of React: the rows with their statuses, which moves the document
// allows, what a delete takes with it, the rollback bar, and the commands for every action. Every
// action is a core command (one undo step each), so undo and redo cover the tree.

import {
  applyCommand,
  bodyCreator,
  featureDependencies,
  featureScope,
  type Command,
  type Feature,
  type FeatureKind,
  type ManufaktureDocument,
  type Part,
} from '@manufakture/core';
import type { FeatureResult, RegenError } from '@manufakture/regen';
import { constructionLabel } from '../construction/kinds';
import { boardStockName, extensionLabel, jointDetail } from '../wood/kinds';

/**
 * What a row shows. `warning` is an `ok` feature with warnings; `pending` means regen has not
 * reported on the feature yet (a new feature, or before the first regen); `unknown` is a scene
 * without a regen engine.
 */
export type RowStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'upstream-error'
  | 'suppressed'
  | 'rolled-back'
  | 'pending'
  | 'unknown';

export interface TreeRow {
  feature: Feature;
  index: number;
  status: RowStatus;
  /** Regen's report on the feature, when there is one for this feature. */
  result: FeatureResult | undefined;
  /** The shown result was built from an older version of the document than the one open. */
  stale: boolean;
}

export const STATUS_LABELS: Record<RowStatus, string> = {
  ok: 'Built',
  warning: 'Built with warnings',
  error: 'Failed',
  'upstream-error': 'Not built: a feature it depends on failed or is suppressed',
  suppressed: 'Suppressed',
  'rolled-back': 'After the rollback bar: not built',
  pending: 'Rebuilding',
  unknown: 'Not built here (no geometry kernel)',
};

export const KIND_LABELS: Record<FeatureKind, string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  shell: 'Shell',
  hole: 'Hole',
  pattern: 'Pattern',
  mirror: 'Mirror',
  extension: 'Extension',
  import: 'Import',
  derived: 'Derived',
  thread: 'Thread',
  scripted: 'Scripted',
};

/** What a feature is, for its row's icon title: the domain's name for a known extension type. */
export function featureKindLabel(feature: Feature): string {
  return extensionLabel(feature) ?? constructionLabel(feature) ?? KIND_LABELS[feature.kind];
}

/**
 * A short note the row shows after the name, or null: a thread's size, with its hand when left
 * and its representation when cosmetic (`M6`, `1/4-20 LH, cosmetic`); a board's stock (`2x4`);
 * a joint's boards and hardware (`Shelf into Side, 4 dowels`), named from `context.features` and
 * counted from the joint's regen result.
 */
export function featureDetail(
  feature: Feature,
  context: { features?: readonly Feature[]; result?: FeatureResult | undefined } = {},
): string | null {
  const stock = boardStockName(feature);
  if (stock !== null) return stock;
  const joint = jointDetail(feature, {
    ...(context.features ? { features: context.features } : {}),
    metadata: context.result?.metadata,
  });
  if (joint !== null) return joint;
  if (feature.kind !== 'thread') return null;
  const parts = [feature.standard.size + (feature.hand === 'left' ? ' LH' : '')];
  if (feature.representation === 'cosmetic') parts.push('cosmetic');
  return parts.join(', ');
}

/** The part's rollback bar position: features `[0, position)` are built. */
export function rollbackPosition(part: Part): number {
  return part.rollbackIndex ?? part.features.length;
}

/**
 * The rows of a part. `results` are regen's per-feature reports (by feature id) from the model
 * built from `built`; `available` says whether a regen engine exists at all.
 */
export function treeRows(
  part: Part,
  results: ReadonlyMap<string, FeatureResult>,
  options: { available: boolean; built: ManufaktureDocument | null; current: ManufaktureDocument },
): TreeRow[] {
  const bar = rollbackPosition(part);
  const firstStale = firstChanged(part, options.built, options.current);
  return part.features.map((feature, index) => {
    const result = results.get(feature.id);
    const stale = index >= firstStale;
    let status: RowStatus;
    if (feature.suppressed) status = 'suppressed';
    else if (index >= bar) status = 'rolled-back';
    else if (!options.available) status = 'unknown';
    else if (result === undefined) status = 'pending';
    else if (result.status === 'ok') status = result.warnings.length > 0 ? 'warning' : 'ok';
    else if (result.status === 'suppressed' || result.status === 'rolled-back') status = 'pending';
    else status = result.status;
    return { feature, index, status, result, stale };
  });
}

/**
 * The first feature whose shown result may not match the open document: the first that differs
 * from the one the model was built from (a rename does not count), or where the rollback bar
 * moved; every feature when a variable changed. The part's length when nothing differs.
 */
export function firstChanged(
  part: Part,
  built: ManufaktureDocument | null,
  current: ManufaktureDocument,
): number {
  if (built === current) return part.features.length;
  const before = built?.parts.find((p) => p.id === part.id);
  if (!built || !before || built.variables !== current.variables) return 0;
  let i = 0;
  // Domain data (stock overrides) is read by the domain's extensions: from the first of them.
  const domainsChanged =
    JSON.stringify(built.domains ?? {}) !== JSON.stringify(current.domains ?? {});
  while (
    i < part.features.length &&
    i < before.features.length &&
    sameIgnoringName(before.features[i]!, part.features[i]!)
  ) {
    i++;
  }
  const bars = [rollbackPosition(before), rollbackPosition(part)];
  if (bars[0] !== bars[1]) i = Math.min(i, ...bars);
  if (domainsChanged) {
    const first = part.features.findIndex((f) => f.kind === 'extension');
    if (first >= 0) i = Math.min(i, first);
  }
  return i;
}

function sameIgnoringName(a: Feature, b: Feature): boolean {
  if (a === b) return true;
  const { name: _a, ...ra } = a;
  const { name: _b, ...rb } = b;
  void _a;
  void _b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

/** The ids of the features that depend on `featureId`, directly or through others, in order. */
export function dependentsOf(part: Part, featureId: string): string[] {
  const out = new Set<string>([featureId]);
  for (const f of part.features) {
    if (out.has(f.id)) continue;
    if (featureDependencies(f).some((d) => out.has(d))) out.add(f.id);
  }
  out.delete(featureId);
  return [...out];
}

/** A feature without its `scope`, for the dependencies it has for other reasons. */
function withoutScope(feature: Feature): Feature {
  if (!('scope' in feature)) return feature;
  const { scope: _scope, ...rest } = feature;
  void _scope;
  return rest as Feature;
}

/**
 * What deleting `featureId` takes with it: the features built from it (deleted too), and the
 * features that only name one of its bodies in their `scope`, which keep working on their other
 * bodies (their scope loses those entries). A feature whose scope names nothing else is deleted.
 */
export function deletePlan(
  part: Part,
  featureId: string,
): { deleted: string[]; rescoped: Map<string, string[]> } {
  const gone = new Set<string>([featureId]);
  const rescoped = new Map<string, string[]>();
  for (const f of part.features) {
    if (gone.has(f.id)) continue;
    const scope = featureScope(f);
    const kept = scope.filter((b) => !gone.has(bodyCreator(b) ?? ''));
    const other = featureDependencies(withoutScope(f)).some((d) => gone.has(d));
    if (other || (scope.length > 0 && kept.length === 0)) {
      gone.add(f.id);
      rescoped.delete(f.id);
    } else if (kept.length < scope.length) {
      rescoped.set(f.id, kept);
    }
  }
  gone.delete(featureId);
  return { deleted: [...gone], rescoped };
}

export type Check = { ok: true; command: Command } | { ok: false; message: string };

function nameOf(part: Part, id: string): string {
  return part.features.find((f) => f.id === id)?.name ?? id;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Moving feature `featureId` so that it ends up at `index`: the command, or why the document
 * refuses it (core's reorder check names the blockers).
 */
export function moveFeature(
  doc: ManufaktureDocument,
  partId: string,
  featureId: string,
  index: number,
): Check {
  const part = doc.parts.find((p) => p.id === partId);
  const from = part?.features.findIndex((f) => f.id === featureId) ?? -1;
  if (!part || from < 0) return { ok: false, message: `There is no feature ${featureId}.` };
  const to = Math.max(0, Math.min(index, part.features.length - 1));
  const command: Command = { type: 'reorderFeature', partId, featureId, index: to };
  const r = applyCommand(doc, command);
  if (r.ok) return { ok: true, command };
  const name = nameOf(part, featureId);
  const blockers = (r.error.blockers ?? []).map((b) => nameOf(part, b));
  if (r.error.code === 'dependency' && blockers.length > 0) {
    const before = to < from;
    return {
      ok: false,
      message: before
        ? `${name} cannot move above ${list(blockers)}: it is built from ${blockers.length === 1 ? 'it' : 'them'}.`
        : `${name} cannot move below ${list(blockers)}: ${blockers.length === 1 ? 'it is' : 'they are'} built from ${name}.`,
    };
  }
  return { ok: false, message: r.error.message };
}

/**
 * The drop position for a feature dragged over the list: `slot` is the gap it was dropped in (0
 * above the first row, n below the last). Returns the feature's final index.
 */
export function dropIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/**
 * Deleting a feature: every feature built from it goes too (core refuses to leave a dependent
 * behind), and so do the names, colours and materials of the bodies they made and the `scope`
 * entries naming those bodies, as one undoable step. `dependents` lists what else is deleted,
 * for the warning.
 */
export function deleteFeature(
  doc: ManufaktureDocument,
  partId: string,
  featureId: string,
): { command: Command; dependents: string[]; label: string } | null {
  const part = doc.parts.find((p) => p.id === partId);
  const feature = part?.features.find((f) => f.id === featureId);
  if (!part || !feature) return null;
  const { deleted: dependents, rescoped } = deletePlan(part, featureId);
  const gone = new Set([featureId, ...dependents]);
  const commands: Command[] = [];
  for (const [id, scope] of rescoped) {
    const f = part.features.find((x) => x.id === id)!;
    const edited = withoutScope(f) as Feature & { scope?: string[] };
    if (scope.length > 0) edited.scope = scope;
    commands.push({ type: 'editFeature', partId, feature: edited });
  }
  for (const b of part.bodies) {
    const creator = bodyCreator(b.id);
    if (creator !== undefined && gone.has(creator)) {
      commands.push({ type: 'setBodyProps', partId, bodyId: b.id, props: {} });
    }
  }
  // The last first, so no deletion leaves a dependent without its dependency.
  const ids = [featureId, ...dependents].reverse();
  commands.push(...ids.map((id): Command => ({ type: 'deleteFeature', partId, featureId: id })));
  return {
    command: commands.length === 1 ? commands[0]! : { type: 'batch', commands },
    dependents: dependents.map((d) => nameOf(part, d)),
    label: `Delete ${feature.name}`,
  };
}

export function suppressFeature(
  partId: string,
  feature: Feature,
): { command: Command; label: string } {
  const suppressed = !feature.suppressed;
  return {
    command: { type: 'suppressFeature', partId, featureId: feature.id, suppressed },
    label: `${suppressed ? 'Suppress' : 'Unsuppress'} ${feature.name}`,
  };
}

/** Renaming: the command, or a message for a name the document would refuse. */
export function renameFeature(
  partId: string,
  feature: Feature,
  name: string,
): { ok: true; command: Command | null; label: string } | { ok: false; message: string } {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, message: 'A name cannot be empty.' };
  if (trimmed.length > 200) return { ok: false, message: 'A name has at most 200 characters.' };
  if (trimmed === feature.name) return { ok: true, command: null, label: '' };
  return {
    ok: true,
    command: { type: 'renameFeature', partId, featureId: feature.id, name: trimmed },
    label: `Rename ${feature.name}`,
  };
}

/** Moving the rollback bar so that features `[0, position)` are built. */
export function setRollback(
  part: Part,
  position: number,
): { command: Command; label: string } | null {
  const clamped = Math.max(0, Math.min(position, part.features.length));
  if (clamped === rollbackPosition(part)) return null;
  const index = clamped === part.features.length ? null : clamped;
  return {
    command: { type: 'setRollback', partId: part.id, index },
    label: index === null ? 'Roll to the end' : 'Move the rollback bar',
  };
}

/** A reference a failed feature lost or finds ambiguous: the user can pick it again. */
export interface Repick {
  referenceId: string;
  message: string;
}

export function repicks(result: FeatureResult | undefined): Repick[] {
  if (!result) return [];
  return result.errors.flatMap((e: RegenError) =>
    e.code === 'reference-lost' || e.code === 'reference-ambiguous'
      ? [{ referenceId: e.referenceId, message: e.message }]
      : [],
  );
}

/** Every message of a row, errors first, for its tooltip. */
export function rowMessages(row: TreeRow): { severity: 'error' | 'warning'; text: string }[] {
  const r = row.result;
  if (!r || row.status === 'suppressed' || row.status === 'rolled-back') return [];
  return [
    ...r.errors.map((e) => ({
      severity: 'error' as const,
      text: e.code === 'kernel' && e.occtMessage ? `${e.message} (${e.occtMessage})` : e.message,
    })),
    ...r.warnings.map((w) => ({ severity: 'warning' as const, text: w.message })),
  ];
}
