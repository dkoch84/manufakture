// The commands of the mechanical section and of user materials (ADR 0017 decisions 2 and 4,
// since version 19). Their schemas are in `commands.ts` with every other command's (so their doc
// comments reach `get_schema`); applying them is here. Every list has a replace-style `set...`
// (create or replace by id), a `delete...` and a history-only `restore...`; the requirements
// list and the electrical system are replaced as a whole. The section and each of its lists are
// absent when empty, except that the section keeps its counters once it has any, so a deleted
// item's id is never handed out again.

import type { Applied, Command, SimpleCommand } from './commands';
import { parseAnyId, peekCounter } from './ids';
import { materialUsers } from './material-defs';
import {
  MECH_LISTS,
  electricalExpressions,
  electricalIds,
  isPhysicalSite,
  mechItemExpressions,
  mechItemIds,
  mechItems,
  withMech,
  type MechList,
  type MechListItems,
  type OwnedId,
} from './mech';
import { fail, ok, type CoreResult } from './result';
import {
  MATERIAL_COUNTER,
  MAX_CATALOG_ENTRIES,
  MAX_CHECK_OVERRIDES,
  MAX_DRIVETRAINS,
  MAX_HAZARDS,
  MAX_LOAD_CASES,
  MAX_MATERIAL_DEFS,
  MAX_PURCHASED_USES,
  MAX_SCHEMATICS,
  MAX_SPEC_NOTES,
  MAX_STUDIES,
  MAX_TEST_BANDS,
  MAX_USER_SYMBOLS,
  type Electrical,
  type ManufaktureDocument,
  type MaterialDefData as MaterialDef,
  type MechData,
} from './schema';
import { expressionVariableNames } from './validate';

/** How each list's commands are named, and what they carry. */
interface ListCommands {
  readonly set: string;
  readonly delete: string;
  readonly restore: string;
  /** The field holding the item (`loadCase`). */
  readonly field: string;
  /** The field holding the id of a delete (`loadCaseId`). */
  readonly idField: string;
  /** For messages: `load case`. */
  readonly what: string;
  readonly max: number;
}

type ItemList = Exclude<MechList, 'requirements'>;

export const MECH_LIST_COMMANDS: { readonly [K in ItemList]: ListCommands } = {
  loadCases: {
    set: 'setMechLoadCase',
    delete: 'deleteMechLoadCase',
    restore: 'restoreMechLoadCase',
    field: 'loadCase',
    idField: 'loadCaseId',
    what: 'load case',
    max: MAX_LOAD_CASES,
  },
  drivetrains: {
    set: 'setDrivetrain',
    delete: 'deleteDrivetrain',
    restore: 'restoreDrivetrain',
    field: 'drivetrain',
    idField: 'drivetrainId',
    what: 'drivetrain',
    max: MAX_DRIVETRAINS,
  },
  purchased: {
    set: 'setPurchasedUse',
    delete: 'deletePurchasedUse',
    restore: 'restorePurchasedUse',
    field: 'use',
    idField: 'useId',
    what: 'purchased part use',
    max: MAX_PURCHASED_USES,
  },
  catalog: {
    set: 'setCatalogEntry',
    delete: 'deleteCatalogEntry',
    restore: 'restoreCatalogEntry',
    field: 'entry',
    idField: 'entryId',
    what: 'catalog entry',
    max: MAX_CATALOG_ENTRIES,
  },
  schematics: {
    set: 'setSchematic',
    delete: 'deleteSchematic',
    restore: 'restoreSchematic',
    field: 'schematic',
    idField: 'schematicId',
    what: 'schematic',
    max: MAX_SCHEMATICS,
  },
  symbols: {
    set: 'setSymbol',
    delete: 'deleteSymbol',
    restore: 'restoreSymbol',
    field: 'symbol',
    idField: 'symbolId',
    what: 'symbol',
    max: MAX_USER_SYMBOLS,
  },
  studies: {
    set: 'setStudy',
    delete: 'deleteStudy',
    restore: 'restoreStudy',
    field: 'study',
    idField: 'studyId',
    what: 'study',
    max: MAX_STUDIES,
  },
  checks: {
    set: 'setCheckOverride',
    delete: 'deleteCheckOverride',
    restore: 'restoreCheckOverride',
    field: 'override',
    idField: 'overrideId',
    what: 'check override',
    max: MAX_CHECK_OVERRIDES,
  },
  specNotes: {
    set: 'setSpecNote',
    delete: 'deleteSpecNote',
    restore: 'restoreSpecNote',
    field: 'note',
    idField: 'noteId',
    what: 'specification note',
    max: MAX_SPEC_NOTES,
  },
  hazards: {
    set: 'setHazard',
    delete: 'deleteHazard',
    restore: 'restoreHazard',
    field: 'hazard',
    idField: 'hazardId',
    what: 'hazard',
    max: MAX_HAZARDS,
  },
  testBands: {
    set: 'setTestBand',
    delete: 'deleteTestBand',
    restore: 'restoreTestBand',
    field: 'band',
    idField: 'bandId',
    what: 'test band',
    max: MAX_TEST_BANDS,
  },
};

/** The list a command type acts on, and which of its three commands it is. */
const BY_TYPE = new Map<string, { list: ItemList; op: 'set' | 'delete' | 'restore' }>();
for (const list of Object.keys(MECH_LIST_COMMANDS) as ItemList[]) {
  const c = MECH_LIST_COMMANDS[list];
  BY_TYPE.set(c.set, { list, op: 'set' });
  BY_TYPE.set(c.delete, { list, op: 'delete' });
  BY_TYPE.set(c.restore, { list, op: 'restore' });
}

/** Every command type of the mechanical section. */
export const MECH_COMMAND_TYPES: readonly string[] = [
  'setMechRequirements',
  'restoreMechRequirements',
  'setElectrical',
  'restoreElectrical',
  ...BY_TYPE.keys(),
];

/**
 * The counters after the ids `after` holds and `before` did not: in `fresh` mode each must be at
 * or past its counter, which then moves past it (an id is never reused); in `restore` mode each
 * must have been allocated already.
 */
function allocateMech(
  nextIds: Readonly<Record<string, number>>,
  before: readonly OwnedId[],
  after: readonly OwnedId[],
  mode: 'fresh' | 'restore',
): CoreResult<Record<string, number>> {
  const had = new Set(before.map((o) => o.id));
  const out = { ...nextIds };
  for (const owned of after) {
    if (had.has(owned.id)) continue;
    const p = parseAnyId(owned.id);
    if (p === undefined || p.counter !== owned.counter || p.split !== '') {
      return fail('invalid-id', `"${owned.id}" is not a ${owned.counter} id`, [], {
        blockers: [owned.id],
      });
    }
    const next = peekCounter(nextIds, owned.counter);
    if (mode === 'restore') {
      if (p.n >= next) {
        return fail(
          'invalid-id',
          `Id "${owned.id}" was never allocated, so it cannot be restored`,
          [],
          {
            blockers: [owned.id],
          },
        );
      }
    } else {
      if (p.n < next) {
        return fail(
          'id-reused',
          `Id "${owned.id}" was already used; ids are never reused (next is ${owned.id.replace(/[0-9]+$/, String(next))})`,
          [],
          { blockers: [owned.id] },
        );
      }
      out[owned.counter] = Math.max(peekCounter(out, owned.counter), p.n + 1);
    }
  }
  return ok(out);
}

const EMPTY_MECH: MechData = { nextIds: {} };

type MechCommand = Extract<
  SimpleCommand,
  {
    type:
      | 'setMechRequirements'
      | 'restoreMechRequirements'
      | 'setElectrical'
      | 'restoreElectrical'
      | 'setMechLoadCase'
      | 'deleteMechLoadCase'
      | 'restoreMechLoadCase'
      | 'setDrivetrain'
      | 'deleteDrivetrain'
      | 'restoreDrivetrain'
      | 'setPurchasedUse'
      | 'deletePurchasedUse'
      | 'restorePurchasedUse'
      | 'setCatalogEntry'
      | 'deleteCatalogEntry'
      | 'restoreCatalogEntry'
      | 'setSchematic'
      | 'deleteSchematic'
      | 'restoreSchematic'
      | 'setSymbol'
      | 'deleteSymbol'
      | 'restoreSymbol'
      | 'setStudy'
      | 'deleteStudy'
      | 'restoreStudy'
      | 'setCheckOverride'
      | 'deleteCheckOverride'
      | 'restoreCheckOverride'
      | 'setSpecNote'
      | 'deleteSpecNote'
      | 'restoreSpecNote'
      | 'setHazard'
      | 'deleteHazard'
      | 'restoreHazard'
      | 'setTestBand'
      | 'deleteTestBand'
      | 'restoreTestBand';
  }
>;

/** Apply a command of the mechanical section. */
export function applyToMech(doc: ManufaktureDocument, command: MechCommand): CoreResult<Applied> {
  const mech = doc.mech ?? EMPTY_MECH;
  const done = (next: MechData, inverse: Command) =>
    ok<Applied>({ document: withMech(doc, next), inverse });

  switch (command.type) {
    case 'setMechRequirements':
    case 'restoreMechRequirements': {
      const before = mechItems(mech, 'requirements');
      const after = command.requirements;
      const ids = allocateMech(
        mech.nextIds,
        before.flatMap((r) => mechItemIds('requirements', r)),
        after.flatMap((r) => mechItemIds('requirements', r)),
        command.type === 'setMechRequirements' ? 'fresh' : 'restore',
      );
      if (!ids.ok) return ids;
      // An empty list is dropped by `withMech`.
      return done(
        {
          ...mech,
          requirements: after as NonNullable<MechData['requirements']>,
          nextIds: ids.value,
        },
        { type: 'restoreMechRequirements', requirements: [...before] },
      );
    }

    case 'setElectrical':
    case 'restoreElectrical': {
      const before = mech.electrical;
      const ids = allocateMech(
        mech.nextIds,
        electricalIds(before),
        electricalIds(command.electrical),
        command.type === 'setElectrical' ? 'fresh' : 'restore',
      );
      if (!ids.ok) return ids;
      const empty: Electrical = { components: [], connections: [], harness: [] };
      return done(
        { ...mech, electrical: command.electrical, nextIds: ids.value },
        { type: 'restoreElectrical', electrical: before ?? empty },
      );
    }

    default:
      return applyToList(doc, mech, command, done);
  }
}

function applyToList(
  doc: ManufaktureDocument,
  mech: MechData,
  command: MechCommand,
  done: (next: MechData, inverse: Command) => CoreResult<Applied>,
): CoreResult<Applied> {
  void doc;
  const spec = BY_TYPE.get(command.type)!;
  const { list, op } = spec;
  const names = MECH_LIST_COMMANDS[list];
  const items = mechItems(mech, list) as readonly MechListItems[ItemList][];
  const fields = command as unknown as Record<string, unknown>;
  // An empty list is dropped by `withMech`.
  const withList = (next: readonly MechListItems[ItemList][], nextIds = mech.nextIds): MechData =>
    ({ ...mech, [list]: next, nextIds }) as MechData;
  const restoreCommand = (item: MechListItems[ItemList], index: number) =>
    ({ type: names.restore, [names.field]: item, index }) as unknown as Command;
  const deleteCommand = (id: string) =>
    ({ type: names.delete, [names.idField]: id }) as unknown as Command;

  if (op === 'delete') {
    const id = fields[names.idField] as string;
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return fail('not-found', `No ${names.what} "${id}"`, [names.idField]);
    const next = items.slice();
    const [old] = next.splice(i, 1);
    return done(withList(next), restoreCommand(old!, i));
  }

  const item = fields[names.field] as MechListItems[ItemList];
  const i = items.findIndex((x) => x.id === item.id);
  const mode = op === 'set' ? 'fresh' : 'restore';
  if (i >= 0) {
    if (op === 'restore' && fields.index !== i) {
      return fail('invalid-index', `${item.id} is at ${i}, not ${String(fields.index)}`, ['index']);
    }
    const old = items[i]!;
    const ids = allocateMech(mech.nextIds, mechItemIds(list, old), mechItemIds(list, item), mode);
    if (!ids.ok) return ids;
    const next = items.slice();
    next[i] = item;
    return done(withList(next, ids.value), restoreCommand(old, i));
  }
  if (items.length >= names.max) {
    return fail('schema', `There are already ${names.max} ${names.what}s, the most allowed`, [
      names.field,
    ]);
  }
  const at = (fields.index as number | undefined) ?? items.length;
  if (at > items.length) {
    return fail('invalid-index', `Index ${at} is past the end of ${items.length} ${names.what}s`, [
      'index',
    ]);
  }
  const ids = allocateMech(mech.nextIds, [], mechItemIds(list, item), mode);
  if (!ids.ok) return ids;
  const next = items.slice();
  next.splice(at, 0, item);
  return done(withList(next, ids.value), deleteCommand(item.id));
}

// User materials ---------------------------------------------------------------------------------

type MaterialsCommand = Extract<
  SimpleCommand,
  { type: 'setMaterialDef' | 'deleteMaterialDef' | 'restoreMaterialDef' }
>;

/** Apply a user material command. The list is absent when empty. */
export function applyToMaterials(
  doc: ManufaktureDocument,
  command: MaterialsCommand,
): CoreResult<Applied> {
  const defs = doc.materials ?? [];
  const done = (next: MaterialDef[], inverse: Command, nextIds = doc.nextIds) => {
    const { materials: _old, ...rest } = doc;
    void _old;
    const document: ManufaktureDocument =
      next.length === 0
        ? { ...rest, nextIds }
        : { ...rest, materials: next as NonNullable<ManufaktureDocument['materials']>, nextIds };
    return ok<Applied>({ document, inverse });
  };
  const add = (def: MaterialDef, at: number, mode: 'fresh' | 'restore'): CoreResult<Applied> => {
    if (defs.length >= MAX_MATERIAL_DEFS) {
      return fail(
        'schema',
        `The document already holds ${MAX_MATERIAL_DEFS} materials, the most allowed`,
        ['material'],
      );
    }
    if (at > defs.length) {
      return fail('invalid-index', `Index ${at} is past the end of ${defs.length} materials`, [
        'index',
      ]);
    }
    const ids = allocateMech(
      doc.nextIds,
      [],
      [{ id: def.id, counter: MATERIAL_COUNTER, path: [] }],
      mode,
    );
    if (!ids.ok) return ids;
    const next = defs.slice() as MaterialDef[];
    next.splice(at, 0, def);
    return done(next, { type: 'deleteMaterialDef', materialId: def.id } as Command, ids.value);
  };

  switch (command.type) {
    case 'setMaterialDef': {
      const def = command.material;
      const i = defs.findIndex((d) => d.id === def.id);
      if (i < 0) return add(def, command.index ?? defs.length, 'fresh');
      const next = defs.slice() as MaterialDef[];
      const old = next[i]!;
      next[i] = def;
      return done(next, { type: 'setMaterialDef', material: old } as Command);
    }
    case 'deleteMaterialDef': {
      const i = defs.findIndex((d) => d.id === command.materialId);
      if (i < 0) return fail('not-found', `No material "${command.materialId}"`, ['materialId']);
      const users = materialUsers(doc, command.materialId);
      if (users.length > 0) {
        return fail(
          'dependency',
          `Material ${command.materialId} is used by ${users.join(', ')}: change their material first`,
          ['materialId'],
          { blockers: users },
        );
      }
      const next = defs.slice() as MaterialDef[];
      const [old] = next.splice(i, 1);
      return done(next, { type: 'restoreMaterialDef', material: old!, index: i } as Command);
    }
    case 'restoreMaterialDef': {
      if (defs.some((d) => d.id === command.material.id)) {
        return fail('duplicate', `Material "${command.material.id}" already exists`, [
          'material',
          'id',
        ]);
      }
      return add(command.material, command.index, 'restore');
    }
  }
}

// Variables --------------------------------------------------------------------------------------

/**
 * The mechanical items whose expressions mention variable `name`, by id (`lc#1`; for the electrical
 * system, the component's or segment's id), in section order.
 */
export function mechVariableUsers(doc: ManufaktureDocument, name: string): string[] {
  const mech = doc.mech;
  if (mech === undefined) return [];
  const out: string[] = [];
  for (const list of MECH_LISTS) {
    for (const item of mechItems(mech, list)) {
      const reads = mechItemExpressions(list, item).some((s) =>
        expressionVariableNames(s.expression, { physical: isPhysicalSite(s.expected) }).includes(
          name,
        ),
      );
      if (reads) out.push(item.id);
    }
  }
  const e = mech.electrical;
  for (const site of electricalExpressions(e)) {
    if (
      !expressionVariableNames(site.expression, {
        physical: isPhysicalSite(site.expected),
      }).includes(name)
    ) {
      continue;
    }
    const [key, i] = site.path as [string, number];
    const id = key === 'components' ? e!.components[i]!.id : e!.harness[i]!.id;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
