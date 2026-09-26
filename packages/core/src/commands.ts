import { isValidVariableName } from '@manufakture/units';
import { z } from 'zod';
import { featureDependencies, featureExpressions, featureSubIds } from './features';
import { parseAnyId, peekCounter } from './ids';
import { fail, ok, schemaError, type CoreResult } from './result';
import {
  DisplayUnitsSchema,
  FeatureSchema,
  StoredExpressionSchema,
  type Feature,
  type ManufaktureDocument,
  type Part,
} from './schema';
import { checkDocument, expressionVariableNames } from './validate';

/**
 * Commands: every change to a document is one of these plain, serializable objects. Applying a
 * command returns the new document and the command that undoes it, so a history of commands is
 * both the undo stack and an op log (M2 version history, M7 sync). Commands never mutate their
 * input document.
 */

const partId = z.string().min(1);
const featureId = z.string().min(1);
const index = z.int().min(0);

export const SimpleCommandSchema = z.discriminatedUnion('type', [
  /**
   * Insert a new feature. Its ids must be fresh and cannot be split pieces; `index` defaults to
   * the rollback bar.
   */
  z.strictObject({
    type: z.literal('addFeature'),
    partId,
    feature: FeatureSchema,
    index: index.optional(),
  }),
  /**
   * Replace a feature's inputs. Same id and kind; ids it introduces must be fresh, and a split
   * piece must split an id this feature had before and no longer has.
   */
  z.strictObject({ type: z.literal('editFeature'), partId, feature: FeatureSchema }),
  /** Remove a feature. Refused while another feature depends on it. */
  z.strictObject({ type: z.literal('deleteFeature'), partId, featureId }),
  /**
   * Put an earlier state of a feature back (undo of a delete or an edit, and redo of an add).
   * Replaces the feature with the same id, or inserts it at `index`, and sets the rollback bar.
   * Unlike `addFeature` and `editFeature`, its ids must have been allocated before.
   *
   * History only: it is the inverse that undo and redo apply, and it checks only that each id
   * was allocated at some point, not that a split piece is fresh. Clients editing a feature use
   * `editFeature`, which enforces the full id rules.
   */
  z.strictObject({
    type: z.literal('restoreFeature'),
    partId,
    feature: FeatureSchema,
    index,
    rollbackIndex: index.nullable(),
  }),
  /** Move a feature so it ends up at `index`. Refused if it would pass a dependency. */
  z.strictObject({ type: z.literal('reorderFeature'), partId, featureId, index }),
  z.strictObject({
    type: z.literal('suppressFeature'),
    partId,
    featureId,
    suppressed: z.boolean(),
  }),
  z.strictObject({ type: z.literal('renameFeature'), partId, featureId, name: z.string() }),
  /** Move the rollback bar; `null` puts it after the last feature. */
  z.strictObject({ type: z.literal('setRollback'), partId, index: index.nullable() }),
  /** Create or update a variable. `index` places a new one (default: last); ignored on update. */
  z.strictObject({
    type: z.literal('setVariable'),
    name: z.string(),
    expression: StoredExpressionSchema,
    index: index.optional(),
  }),
  /** Remove a variable. Refused while a variable or feature references it. */
  z.strictObject({ type: z.literal('deleteVariable'), name: z.string() }),
  /** Change display units. Stored expressions keep their own units, so no geometry changes. */
  z.strictObject({ type: z.literal('setDisplayUnits'), units: DisplayUnitsSchema }),
]);

export type SimpleCommand = z.infer<typeof SimpleCommandSchema>;
/** Several commands applied as one: all or nothing, one undo step. */
export interface BatchCommand {
  type: 'batch';
  commands: Command[];
}
export type Command = SimpleCommand | BatchCommand;
export type CommandType = Command['type'];

export const CommandSchema: z.ZodType<Command> = z.lazy(() =>
  z.union([
    SimpleCommandSchema,
    z.strictObject({ type: z.literal('batch'), commands: z.array(CommandSchema).min(1) }),
  ]),
);

export interface Applied {
  readonly document: ManufaktureDocument;
  /** Applying this to `document` gives back the original document. */
  readonly inverse: Command;
}

/**
 * Applies a command. The command is validated against its schema first (so commands read back
 * from an op log are safe), and the resulting document must pass `checkDocument`; otherwise the
 * error is returned and nothing changes.
 */
export function applyCommand(doc: ManufaktureDocument, command: Command): CoreResult<Applied> {
  const parsed = CommandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, error: schemaError('Invalid command', parsed.error) };
  const applied = applyUnchecked(doc, parsed.data);
  if (!applied.ok) return applied;
  const checked = checkDocument(applied.value.document);
  if (!checked.ok) return checked;
  return applied;
}

function applyUnchecked(doc: ManufaktureDocument, command: Command): CoreResult<Applied> {
  switch (command.type) {
    case 'batch': {
      let current = doc;
      const inverses: Command[] = [];
      for (const c of command.commands) {
        const r = applyUnchecked(current, c);
        if (!r.ok) return r;
        current = r.value.document;
        inverses.push(r.value.inverse);
      }
      return ok({ document: current, inverse: { type: 'batch', commands: inverses.reverse() } });
    }
    case 'setVariable':
      return setVariable(doc, command);
    case 'deleteVariable':
      return deleteVariable(doc, command.name);
    case 'setDisplayUnits':
      return ok({
        document: { ...doc, units: command.units },
        inverse: { type: 'setDisplayUnits', units: doc.units },
      });
    default:
      return applyToPart(doc, command);
  }
}

type PartCommand = Extract<SimpleCommand, { partId: string }>;

function applyToPart(doc: ManufaktureDocument, command: PartCommand): CoreResult<Applied> {
  const pi = doc.parts.findIndex((p) => p.id === command.partId);
  const part = doc.parts[pi];
  if (!part) return fail('not-found', `No part "${command.partId}"`, ['partId']);
  const r = applyPartCommand(part, command);
  if (!r.ok) return r;
  const parts = doc.parts.slice();
  parts[pi] = r.value.part;
  return ok({ document: { ...doc, parts }, inverse: r.value.inverse });
}

interface PartApplied {
  part: Part;
  inverse: Command;
}

function featureIndex(part: Part, id: string): CoreResult<number> {
  const i = part.features.findIndex((f) => f.id === id);
  return i < 0 ? fail('not-found', `No feature "${id}" in part ${part.id}`, ['featureId']) : ok(i);
}

/** Ids a feature state carries: its own id and every id inside it. */
function allIds(feature: Feature): string[] {
  return [feature.id, ...featureSubIds(feature)];
}

/** The id a split piece was cut from: `e2#a` gives `e2`, `e2#a#b` gives `e2#a`. */
function splitParent(id: string): string {
  return id.slice(0, id.lastIndexOf('#'));
}

/**
 * Checks the ids a command introduces and returns the part's updated counters.
 * - `fresh` (add, edit): each id straight from a counter must not have been handed out before,
 *   and allocating it moves the counter past it. A split id (`e2#a`, or `e2#a#b` from `e2#a`)
 *   must split an id that the feature had before the command and no longer has after it. Split
 *   pieces have no counter, so this is what keeps them from being reused: once `e2` has been
 *   split and is gone, nothing can name `e2#a` again, and an entity of another feature cannot
 *   be split into this one. `addFeature` has no earlier state, so it takes no split ids.
 * - `restore` (undo and redo): each id must have been allocated before; counters do not move.
 *   This is weaker than `fresh` on purpose: undo and redo put back states that really existed.
 */
function allocate(
  nextIds: Readonly<Record<string, number>>,
  introduced: readonly string[],
  mode:
    { type: 'fresh'; before: readonly string[]; after: readonly string[] } | { type: 'restore' },
): CoreResult<Record<string, number>> {
  const out = { ...nextIds };
  const before = new Set(mode.type === 'fresh' ? mode.before : []);
  const after = new Set(mode.type === 'fresh' ? mode.after : []);
  for (const id of introduced) {
    const p = parseAnyId(id);
    if (!p) return fail('invalid-id', `"${id}" is not a valid id`, [], { blockers: [id] });
    const next = peekCounter(nextIds, p.counter);
    if (mode.type === 'restore') {
      if (p.n >= next) {
        return fail('invalid-id', `Id "${id}" was never allocated, so it cannot be restored`, [], {
          blockers: [id],
        });
      }
    } else if (p.split !== '') {
      const parent = splitParent(id);
      if (!before.has(parent) || after.has(parent)) {
        const why = !before.has(parent)
          ? `this feature did not have "${parent}" before the change`
          : `"${parent}" is still there`;
        return fail(
          'invalid-id',
          `Id "${id}" must come from splitting "${parent}" in this change, but ${why}; split ids are never reused`,
          [],
          { blockers: [id] },
        );
      }
    } else {
      if (p.n < next) {
        return fail(
          'id-reused',
          `Id "${id}" was already used; ids are never reused (next is ${next})`,
          [],
          {
            blockers: [id],
          },
        );
      }
      out[p.counter] = Math.max(peekCounter(out, p.counter), p.n + 1);
    }
  }
  return ok(out);
}

/** Ids in `next` that are not in `prev`, in order. */
function introducedIds(prev: readonly string[], next: readonly string[]): string[] {
  const have = new Set(prev);
  return next.filter((id) => !have.has(id));
}

function withFeatures(
  part: Part,
  features: Feature[],
  rollbackIndex: number | null,
  nextIds = part.nextIds,
): Part {
  return { ...part, features, rollbackIndex, nextIds };
}

function insertRollback(rb: number | null, at: number): number | null {
  return rb !== null && at <= rb ? rb + 1 : rb;
}

function removeRollback(rb: number | null, at: number): number | null {
  return rb !== null && at < rb ? rb - 1 : rb;
}

function dependentsOf(part: Part, id: string): string[] {
  return part.features.filter((f) => featureDependencies(f).includes(id)).map((f) => f.id);
}

function applyPartCommand(part: Part, command: PartCommand): CoreResult<PartApplied> {
  const { partId } = command;
  switch (command.type) {
    case 'addFeature': {
      const f = command.feature;
      if (part.features.some((x) => x.id === f.id)) {
        return fail('duplicate', `Feature "${f.id}" already exists`, ['feature', 'id']);
      }
      const at = command.index ?? part.rollbackIndex ?? part.features.length;
      if (at > part.features.length) {
        return fail(
          'invalid-index',
          `Index ${at} is past the end of ${part.features.length} features`,
          ['index'],
        );
      }
      const ids = allocate(part.nextIds, allIds(f), { type: 'fresh', before: [], after: [] });
      if (!ids.ok) return ids;
      const features = part.features.slice();
      features.splice(at, 0, f);
      return ok({
        part: withFeatures(part, features, insertRollback(part.rollbackIndex, at), ids.value),
        inverse: { type: 'deleteFeature', partId, featureId: f.id },
      });
    }

    case 'editFeature': {
      const f = command.feature;
      const i = featureIndex(part, f.id);
      if (!i.ok) return i;
      const old = part.features[i.value]!;
      if (old.kind !== f.kind) {
        return fail(
          'kind-mismatch',
          `${f.id} is a ${old.kind}; an edit cannot make it a ${f.kind}`,
          ['feature', 'kind'],
        );
      }
      const before = allIds(old);
      const after = allIds(f);
      const ids = allocate(part.nextIds, introducedIds(before, after), {
        type: 'fresh',
        before,
        after,
      });
      if (!ids.ok) return ids;
      const features = part.features.slice();
      features[i.value] = f;
      return ok({
        part: withFeatures(part, features, part.rollbackIndex, ids.value),
        inverse: {
          type: 'restoreFeature',
          partId,
          feature: old,
          index: i.value,
          rollbackIndex: part.rollbackIndex,
        },
      });
    }

    case 'deleteFeature': {
      const i = featureIndex(part, command.featureId);
      if (!i.ok) return i;
      const dependents = dependentsOf(part, command.featureId);
      if (dependents.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.featureId}: ${dependents.join(', ')} ${dependents.length === 1 ? 'depends' : 'depend'} on it`,
          ['featureId'],
          { blockers: dependents },
        );
      }
      const old = part.features[i.value]!;
      const features = part.features.slice();
      features.splice(i.value, 1);
      return ok({
        part: withFeatures(part, features, removeRollback(part.rollbackIndex, i.value)),
        inverse: {
          type: 'restoreFeature',
          partId,
          feature: old,
          index: i.value,
          rollbackIndex: part.rollbackIndex,
        },
      });
    }

    case 'restoreFeature': {
      const f = command.feature;
      const existing = part.features.findIndex((x) => x.id === f.id);
      if (
        command.rollbackIndex !== null &&
        command.rollbackIndex > part.features.length + (existing < 0 ? 1 : 0)
      ) {
        return fail('invalid-index', `Rollback index ${command.rollbackIndex} is out of range`, [
          'rollbackIndex',
        ]);
      }
      if (existing >= 0) {
        if (existing !== command.index) {
          return fail('invalid-index', `${f.id} is at ${existing}, not ${command.index}`, [
            'index',
          ]);
        }
        const old = part.features[existing]!;
        if (old.kind !== f.kind) {
          return fail('kind-mismatch', `${f.id} is a ${old.kind}, not a ${f.kind}`, [
            'feature',
            'kind',
          ]);
        }
        const ids = allocate(part.nextIds, introducedIds(allIds(old), allIds(f)), {
          type: 'restore',
        });
        if (!ids.ok) return ids;
        const features = part.features.slice();
        features[existing] = f;
        return ok({
          part: withFeatures(part, features, command.rollbackIndex),
          inverse: {
            type: 'restoreFeature',
            partId,
            feature: old,
            index: existing,
            rollbackIndex: part.rollbackIndex,
          },
        });
      }
      if (command.index > part.features.length) {
        return fail(
          'invalid-index',
          `Index ${command.index} is past the end of ${part.features.length} features`,
          ['index'],
        );
      }
      const ids = allocate(part.nextIds, allIds(f), { type: 'restore' });
      if (!ids.ok) return ids;
      const features = part.features.slice();
      features.splice(command.index, 0, f);
      const del: Command = { type: 'deleteFeature', partId, featureId: f.id };
      const inverse: Command =
        removeRollback(command.rollbackIndex, command.index) === part.rollbackIndex
          ? del
          : {
              type: 'batch',
              commands: [del, { type: 'setRollback', partId, index: part.rollbackIndex }],
            };
      return ok({ part: withFeatures(part, features, command.rollbackIndex), inverse });
    }

    case 'reorderFeature': {
      const i = featureIndex(part, command.featureId);
      if (!i.ok) return i;
      const to = command.index;
      if (to >= part.features.length) {
        return fail(
          'invalid-index',
          `Index ${to} is past the last of ${part.features.length} features`,
          ['index'],
        );
      }
      const moved = part.features[i.value]!;
      const features = part.features.slice();
      features.splice(i.value, 1);
      features.splice(to, 0, moved);
      const pos = new Map(features.map((f, k) => [f.id, k]));
      const passedDeps = featureDependencies(moved).filter((d) => (pos.get(d) ?? -1) > to);
      if (passedDeps.length > 0) {
        return fail(
          'dependency',
          `${moved.id} cannot move before ${passedDeps.join(', ')}, which it references`,
          ['index'],
          { blockers: passedDeps },
        );
      }
      const passedUsers = dependentsOf(part, moved.id).filter((d) => (pos.get(d) ?? Infinity) < to);
      if (passedUsers.length > 0) {
        return fail(
          'dependency',
          `${moved.id} cannot move after ${passedUsers.join(', ')}, which ${passedUsers.length === 1 ? 'references' : 'reference'} it`,
          ['index'],
          { blockers: passedUsers },
        );
      }
      return ok({
        part: withFeatures(part, features, part.rollbackIndex),
        inverse: { type: 'reorderFeature', partId, featureId: moved.id, index: i.value },
      });
    }

    case 'suppressFeature':
    case 'renameFeature': {
      const i = featureIndex(part, command.featureId);
      if (!i.ok) return i;
      const old = part.features[i.value]!;
      const features = part.features.slice();
      if (command.type === 'suppressFeature') {
        features[i.value] = { ...old, suppressed: command.suppressed };
        return ok({
          part: withFeatures(part, features, part.rollbackIndex),
          inverse: {
            type: 'suppressFeature',
            partId,
            featureId: old.id,
            suppressed: old.suppressed,
          },
        });
      }
      const name = command.name.trim();
      if (name.length === 0 || name.length > 200) {
        return fail('invalid-name', 'A feature name must be 1 to 200 characters', ['name']);
      }
      features[i.value] = { ...old, name };
      return ok({
        part: withFeatures(part, features, part.rollbackIndex),
        inverse: { type: 'renameFeature', partId, featureId: old.id, name: old.name },
      });
    }

    case 'setRollback': {
      if (command.index !== null && command.index > part.features.length) {
        return fail(
          'invalid-index',
          `Rollback index ${command.index} is past the end of ${part.features.length} features`,
          ['index'],
        );
      }
      return ok({
        part: withFeatures(part, part.features, command.index),
        inverse: { type: 'setRollback', partId, index: part.rollbackIndex },
      });
    }
  }
}

function setVariable(
  doc: ManufaktureDocument,
  command: Extract<SimpleCommand, { type: 'setVariable' }>,
): CoreResult<Applied> {
  if (!isValidVariableName(command.name)) {
    return fail('invalid-name', `"${command.name}" is not a valid variable name`, ['name']);
  }
  const i = doc.variables.findIndex((v) => v.name === command.name);
  const variables = doc.variables.slice();
  if (i >= 0) {
    const old = variables[i]!;
    variables[i] = { name: command.name, expression: command.expression };
    return ok({
      document: { ...doc, variables },
      inverse: { type: 'setVariable', name: command.name, expression: old.expression },
    });
  }
  const at = command.index ?? variables.length;
  if (at > variables.length) {
    return fail('invalid-index', `Index ${at} is past the end of ${variables.length} variables`, [
      'index',
    ]);
  }
  variables.splice(at, 0, { name: command.name, expression: command.expression });
  return ok({
    document: { ...doc, variables },
    inverse: { type: 'deleteVariable', name: command.name },
  });
}

/** Variables and features whose expressions mention `name`. */
export function variableUsers(doc: ManufaktureDocument, name: string): string[] {
  const users: string[] = [];
  for (const v of doc.variables) {
    if (v.name !== name && expressionVariableNames(v.expression).includes(name)) users.push(v.name);
  }
  for (const part of doc.parts) {
    for (const f of part.features) {
      if (featureExpressions(f).some((s) => expressionVariableNames(s.expression).includes(name)))
        users.push(f.id);
    }
  }
  return users;
}

function deleteVariable(doc: ManufaktureDocument, name: string): CoreResult<Applied> {
  const i = doc.variables.findIndex((v) => v.name === name);
  const old = doc.variables[i];
  if (!old) return fail('not-found', `No variable "${name}"`, ['name']);
  const users = variableUsers(doc, name);
  if (users.length > 0) {
    return fail(
      'variable-in-use',
      `Cannot delete "${name}": used by ${users.join(', ')}`,
      ['name'],
      { blockers: users },
    );
  }
  const variables = doc.variables.slice();
  variables.splice(i, 1);
  return ok({
    document: { ...doc, variables },
    inverse: { type: 'setVariable', name, expression: old.expression, index: i },
  });
}
