import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { applyCommand, variableUsers, type Command } from './commands';
import { createDocument } from './document';
import { deserialize, parseDocument, serialize } from './format';
import { documentMaterial, materialValue } from './material-defs';
import { mechExpressions, mechItemIds } from './mech';
import { MECH_COMMAND_TYPES } from './mech-commands';
import {
  catalogEntry,
  checkOverride,
  drivetrain,
  electrical,
  hazard,
  loadCase,
  materialDef,
  mechCommands,
  mechDocument,
  purchased,
  requirements,
  schematic,
  specNote,
  study,
  symbol,
  testBand,
  x,
} from './mech-test-helpers';
import { migrateV18ToV19 } from './migrations';
import { commandIds, remapDocument } from './remap';
import {
  DocumentSchema,
  MAX_REQUIREMENTS,
  MAX_SHEET_WIRES,
  MAX_SPEC_NOTE_TEXT,
  MAX_TABLE_POINTS,
  type ManufaktureDocument,
} from './schema';
import { documentCounters } from './scopes';
import { createdIds } from './sync';
import { PART, bracket, clone, unwrap } from './test-helpers';
import { expressionReferences, validateDocument } from './validate';
import { inlineVariable, mechVariableUses, renameVariable } from './variables';
import v18Bracket from './fixtures/v18-bracket.json';
import v19Mech from './fixtures/v19-mech.json';

function apply(doc: ManufaktureDocument, command: Command) {
  return unwrap(applyCommand(doc, command));
}

function refused(doc: ManufaktureDocument, command: Command) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  return r.ok ? undefined : r.error;
}

/** The document without its id counters, and without a mech section that holds only them. */
function withoutCounters(doc: ManufaktureDocument): unknown {
  const out = clone(doc) as Record<string, unknown>;
  delete out.nextIds;
  const mech = out.mech as Record<string, unknown> | undefined;
  if (mech !== undefined) {
    delete mech.nextIds;
    if (Object.keys(mech).length === 0) delete out.mech;
  }
  return out;
}

/** A schema-valid document with `mech` (and anything else) patched in, as a loaded file. */
function load(doc: unknown) {
  return parseDocument(doc);
}

describe('the mech section in a document', () => {
  it('holds every shape, validates and round-trips through the file', () => {
    const doc = mechDocument();
    expect(validateDocument(doc)).toEqual([]);
    expect(Object.keys(doc.mech!).sort()).toEqual(
      [
        'catalog',
        'checks',
        'drivetrains',
        'electrical',
        'hazards',
        'loadCases',
        'nextIds',
        'purchased',
        'requirements',
        'schematics',
        'specNotes',
        'studies',
        'symbols',
        'testBands',
      ].sort(),
    );
    const text = serialize(doc);
    const back = unwrap(deserialize(text));
    expect(back.migrated).toBe(false);
    expect(back.document).toEqual(doc);
    expect(serialize(back.document)).toBe(text);
  });

  it('matches the version 19 mech fixture', () => {
    expect(JSON.parse(serialize(mechDocument()))).toEqual(v19Mech);
    const loaded = unwrap(parseDocument(v19Mech));
    expect(loaded.migrated).toBe(false);
    expect(serialize(loaded.document)).toBe(serialize(mechDocument()));
  });

  it('writes records in a canonical order whatever order they were built in', () => {
    const doc = mechDocument();
    const shuffled = clone(doc);
    const mech = shuffled.mech!;
    mech.nextIds = Object.fromEntries(Object.entries(mech.nextIds).reverse());
    const entry = mech.catalog![0]!;
    entry.ratings = Object.fromEntries(Object.entries(entry.ratings).reverse());
    const c = mech.checks![0]!;
    c.inputs = Object.fromEntries(Object.entries(c.inputs!).reverse());
    shuffled.units = { ...shuffled.units, quantities: { torque: 'N·m', force: 'lbf' } };
    expect(serialize(shuffled)).toBe(serialize(doc));
  });

  it('costs nothing in a document that does not use it', () => {
    const plain = bracket();
    expect('mech' in plain).toBe(false);
    expect('materials' in plain).toBe(false);
    expect('quantities' in plain.units).toBe(false);
    const text = serialize(plain);
    expect(text).not.toMatch(/"mech"|"materials"|"quantities"/);
    const created = createDocument({ id: 'd', name: 'D' });
    expect('mech' in created).toBe(false);
    expect(serialize(created)).not.toMatch(/"mech"|"materials"/);
    // An older document migrates changing only its version.
    const migrated = migrateV18ToV19.migrate(clone(v18Bracket) as Record<string, unknown>);
    expect(migrated).toEqual({ ...clone(v18Bracket), version: 19 });
    expect(serialize(unwrap(parseDocument(v18Bracket)).document)).not.toMatch(/"mech"/);
  });

  it('refuses an empty section, an empty list and an empty electrical system', () => {
    const base = clone(bracket()) as Record<string, unknown>;
    expect(load({ ...base, mech: { nextIds: {} } }).ok).toBe(false);
    expect(load({ ...base, mech: { requirements: [], nextIds: { req: 1 } } }).ok).toBe(false);
    expect(
      load({
        ...base,
        mech: { electrical: { components: [], connections: [], harness: [] }, nextIds: { el: 1 } },
      }).ok,
    ).toBe(false);
    expect(load({ ...base, materials: [] }).ok).toBe(false);
    expect(load({ ...base, units: { ...(base.units as object), quantities: {} } }).ok).toBe(false);
    // A section with only its counters is how a fully emptied section looks: valid.
    expect(load({ ...base, mech: { nextIds: { req: 3 } } }).ok).toBe(true);
  });

  it('refuses a version 18 file that already has mech data', () => {
    const v18 = clone(v18Bracket) as Record<string, unknown>;
    for (const extra of [
      { mech: { nextIds: { req: 1 } } },
      { materials: [] },
      { units: { ...(v18.units as object), quantities: { force: 'N' } } },
    ]) {
      const r = parseDocument({ ...v18, ...extra });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('migration');
    }
  });
});

describe('mech commands', () => {
  const setup = (): ManufaktureDocument => {
    let doc = bracket();
    for (const c of mechCommands().slice(0, 5)) doc = apply(doc, c).document;
    return doc;
  };

  it('has a command and an inverse for every collection', () => {
    expect(MECH_COMMAND_TYPES.length).toBe(4 + 11 * 3);
  });

  it.each(
    mechCommands()
      .slice(5)
      .map((c) => [c.type, c] as const),
  )('%s creates an item, and its inverse takes it out again', (_type, command) => {
    const before = setup();
    const { document, inverse } = apply(before, command);
    expect(validateDocument(document)).toEqual([]);
    expect(document).not.toEqual(before);
    const undone = apply(document, inverse);
    // Counters never go back, so the section may stay with its counters alone.
    expect(withoutCounters(undone.document)).toEqual(withoutCounters(before));
    // Redo is the command again.
    const redone = apply(undone.document, undone.inverse);
    expect(withoutCounters(redone.document)).toEqual(withoutCounters(document));
  });

  const edits: [
    string,
    (doc: ManufaktureDocument) => Command,
    (doc: ManufaktureDocument) => Command,
  ][] = [
    [
      'setMechRequirements',
      () => ({ type: 'setMechRequirements', requirements: requirements().slice(1) }),
      () => ({ type: 'setMechRequirements', requirements: [] }),
    ],
    [
      'setElectrical',
      () => ({ type: 'setElectrical', electrical: { ...electrical(), harness: [] } }),
      () => ({
        type: 'setElectrical',
        electrical: { components: [], connections: [], harness: [] },
      }),
    ],
    [
      'setMechLoadCase',
      () => ({ type: 'setMechLoadCase', loadCase: { ...loadCase(), name: 'Renamed' } }),
      () => ({ type: 'deleteMechLoadCase', loadCaseId: 'lc#1' }),
    ],
    [
      'setDrivetrain',
      () => ({
        type: 'setDrivetrain',
        drivetrain: { ...drivetrain(), stages: drivetrain().stages.slice(0, 1) },
      }),
      () => ({ type: 'deleteDrivetrain', drivetrainId: 'drive#1' }),
    ],
    [
      'setPurchasedUse',
      () => ({ type: 'setPurchasedUse', use: { ...purchased(), alternates: [] } }),
      () => ({ type: 'deletePurchasedUse', useId: 'pp#1' }),
    ],
    [
      'setCatalogEntry',
      () => ({ type: 'setCatalogEntry', entry: { ...catalogEntry(), verified: true, version: 2 } }),
      () => ({ type: 'deleteCatalogEntry', entryId: 'entry#1' }),
    ],
    [
      'setSchematic',
      () => ({ type: 'setSchematic', schematic: { ...schematic(), name: 'Board' } }),
      () => ({ type: 'deleteSchematic', schematicId: 'sch#1' }),
    ],
    [
      'setSymbol',
      () => ({ type: 'setSymbol', symbol: { ...symbol(), power: { net: 'GND' } } }),
      () => ({ type: 'deleteSymbol', symbolId: 'sym#1' }),
    ],
    [
      'setStudy',
      () => ({ type: 'setStudy', study: { ...study(), loads: [] } }),
      () => ({ type: 'deleteStudy', studyId: 'study#1' }),
    ],
    [
      'setCheckOverride',
      () => ({ type: 'setCheckOverride', override: { ...checkOverride(), factor: x('2.5') } }),
      () => ({ type: 'deleteCheckOverride', overrideId: 'chk#1' }),
    ],
    [
      'setSpecNote',
      () => ({ type: 'setSpecNote', note: { ...specNote(), text: 'Bead blast' } }),
      () => ({ type: 'deleteSpecNote', noteId: 'note#1' }),
    ],
    [
      'setHazard',
      () => ({ type: 'setHazard', hazard: { ...hazard(), remaining: 'Inspect the cable' } }),
      () => ({ type: 'deleteHazard', hazardId: 'hz#1' }),
    ],
    [
      'setTestBand',
      () => ({ type: 'setTestBand', band: { ...testBand(), high: x('#pull * 2') } }),
      () => ({ type: 'deleteTestBand', bandId: 'vt#1' }),
    ],
    [
      'setMaterialDef',
      () => ({ type: 'setMaterialDef', material: { ...materialDef(), name: 'PETG blue' } }),
      () => ({ type: 'setMaterial', partId: PART, material: null }),
    ],
  ];

  it.each(edits)('%s replaces an item and deletes it, each undone exactly', (_t, edit, remove) => {
    const doc = mechDocument();
    for (const make of [edit, remove]) {
      const { document, inverse } = apply(doc, make(doc));
      expect(validateDocument(document)).toEqual([]);
      expect(document).not.toEqual(doc);
      expect(apply(document, inverse).document).toEqual(doc);
    }
  });

  it('drops a list when its last item goes, and the section keeps its counters', () => {
    const start = apply(bracket(), { type: 'setVariable', name: 'pull', expression: x('200 lbf') });
    let doc = apply(start.document, { type: 'setMechLoadCase', loadCase: loadCase() }).document;
    expect(doc.mech).toEqual({ loadCases: [loadCase()], nextIds: { lc: 2 } });
    doc = apply(doc, { type: 'deleteMechLoadCase', loadCaseId: 'lc#1' }).document;
    expect(doc.mech).toEqual({ nextIds: { lc: 2 } });
    expect(serialize(doc)).toMatch(/"mech": \{\n {4}"nextIds": \{\n {6}"lc": 2/);
    // The id is never handed out again.
    const again = refused(doc, { type: 'setMechLoadCase', loadCase: loadCase() });
    expect(again?.code).toBe('id-reused');
    const next = apply(doc, {
      type: 'setMechLoadCase',
      loadCase: { ...loadCase(), id: 'lc#2' },
    }).document;
    expect(next.mech?.loadCases?.map((l) => l.id)).toEqual(['lc#2']);
  });

  it('requires fresh ids for new items and new nested ids, and allocated ones on restore', () => {
    const doc = mechDocument();
    // A new stage on an existing drivetrain must be fresh.
    const stale = drivetrain();
    stale.stages.push({ id: 'stage#1', kind: 'coupling' });
    expect(refused(doc, { type: 'setDrivetrain', drivetrain: stale })?.code).toBe('duplicate');
    const reused = drivetrain();
    reused.stages = [reused.stages[0]!, { id: 'stage#2', kind: 'coupling' }];
    // stage#2 is still held (as a belt), so swapping its kind keeps the id: allowed.
    expect(applyCommand(doc, { type: 'setDrivetrain', drivetrain: reused }).ok).toBe(true);
    const fresh = drivetrain();
    fresh.stages.push({ id: 'stage#4', kind: 'coupling' });
    const added = apply(doc, { type: 'setDrivetrain', drivetrain: fresh }).document;
    expect(added.mech!.nextIds.stage).toBe(5);
    // A dropped stage cannot come back by a set, only by the history's restore.
    const dropped = apply(added, {
      type: 'setDrivetrain',
      drivetrain: { ...fresh, stages: fresh.stages.slice(0, 3) },
    });
    expect(refused(dropped.document, { type: 'setDrivetrain', drivetrain: fresh })?.code).toBe(
      'id-reused',
    );
    expect(apply(dropped.document, dropped.inverse).document).toEqual(added);
    // Restoring an id never allocated is refused.
    expect(
      refused(doc, {
        type: 'restoreMechLoadCase',
        loadCase: { ...loadCase(), id: 'lc#9' },
        index: 1,
      })?.code,
    ).toBe('invalid-id');
    // A requirement list may not bring back a deleted requirement's id either.
    const fewer = apply(doc, {
      type: 'setMechRequirements',
      requirements: requirements().slice(1),
    });
    expect(
      refused(fewer.document, { type: 'setMechRequirements', requirements: requirements() })?.code,
    ).toBe('id-reused');
  });

  it('refuses an id used twice anywhere in the section', () => {
    const doc = mechDocument();
    const twice = schematic();
    twice.sheets[0]!.wires.push({
      id: 'wire#1',
      points: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(refused(doc, { type: 'setSchematic', schematic: twice })?.code).toBe('duplicate');
  });

  it('refuses a delete of something that is not there, and a restore over a moved item', () => {
    const doc = mechDocument();
    expect(refused(doc, { type: 'deleteStudy', studyId: 'study#7' })?.code).toBe('not-found');
    expect(
      refused(doc, { type: 'restoreMechLoadCase', loadCase: loadCase(), index: 3 })?.code,
    ).toBe('invalid-index');
  });
});

describe('user materials', () => {
  it('evaluate to SI like the built-in ones, and parts can use them', () => {
    const doc = mechDocument();
    expect(doc.parts[0]!.material).toBe('material#1');
    const m = documentMaterial(doc, 'material#1')!;
    expect(m.density).toBeCloseTo(1270, 9);
    expect(m.yieldStrength?.value).toBeCloseTo(45e6, 3);
    expect(m.poissonRatio?.value).toBe(0.38);
    expect(m.thermalConductivity?.value).toBeCloseTo(0.2, 12);
    expect(m.maxServiceTemperature?.value).toBeCloseTo(343.15, 9);
    expect(m.fatigue?.points.map((p) => p.cycles)).toEqual([1e4, 1e6]);
    expect(documentMaterial(doc, 'pla')?.name).toBeDefined();
    expect(documentMaterial(doc, 'material#9')).toBeUndefined();
  });

  it('refuse variables, wrong units and a density that is not positive', () => {
    expect(materialValue('#x * 2 MPa', { kind: 'pressure' }).ok).toBe(false);
    expect(materialValue('45 N', { kind: 'pressure' }).ok).toBe(false);
    const doc = mechDocument();
    const bad = (patch: object) => {
      const r = applyCommand(doc, {
        type: 'setMaterialDef',
        material: { ...materialDef(), ...patch },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('expression');
    };
    bad({ density: { value: x('#pull'), source: 's', typical: true } });
    bad({ density: { value: x('1270 kg'), source: 's', typical: true } });
    bad({ density: { value: x('-1 kg/m^3'), source: 's', typical: true } });
    bad({ properties: { thermalExpansion: { value: x('5 MPa'), source: 's', typical: true } } });
  });

  it('cannot be deleted while a part or a body uses it, nor named when missing', () => {
    const doc = mechDocument();
    const r = refused(doc, { type: 'deleteMaterialDef', materialId: 'material#1' });
    expect(r?.code).toBe('dependency');
    expect(r?.blockers).toEqual([PART]);
    expect(refused(doc, { type: 'setMaterial', partId: PART, material: 'material#2' })?.code).toBe(
      'dependency',
    );
    const freed = apply(doc, { type: 'setMaterial', partId: PART, material: 'pla' }).document;
    const { document, inverse } = apply(freed, {
      type: 'deleteMaterialDef',
      materialId: 'material#1',
    });
    expect('materials' in document).toBe(false);
    expect(apply(document, inverse).document).toEqual(freed);
  });
});

describe('mech expressions', () => {
  it('are read in the physical mode where the field is physical', () => {
    // The old reading of `2 m/s` divides by a variable `s`; the physical one does not.
    const names = (r: ReturnType<typeof expressionReferences>) =>
      r.ok ? r.value.map((v) => v.name) : null;
    expect(names(expressionReferences('2 m/s'))).toEqual(['s']);
    expect(names(expressionReferences('2 m/s', { physical: true }))).toEqual([]);
    const sites = mechExpressions(mechDocument().mech);
    const speed = sites.find((s) => s.itemId === 'req#2' && s.path[0] === 'value')!;
    expect(speed.expected).toBe('speed');
    expect(sites.find((s) => s.itemId === 'stage#2')).toBeUndefined();
    expect(sites.filter((s) => s.collection === 'electrical').map((s) => s.itemId)).toEqual([
      'el#2',
      'el#2',
      'seg#1',
    ]);
  });

  it('read a drivetrain’s typed inertias as inertias, on stages and the output', () => {
    const doc = mechDocument();
    const d = drivetrain();
    const typed = {
      ...d,
      stages: d.stages.map((s) => (s.id === 'stage#2' ? { ...s, inertia: x('2e-5 kg*m^2') } : s)),
      output: { ...d.output, inertia: x('20 g*cm^2') },
    } as typeof d;
    const done = apply(doc, { type: 'setDrivetrain', drivetrain: typed }).document;
    const sites = mechExpressions(done.mech).filter(
      (s) => s.itemId === 'drive#1' && s.path.includes('inertia'),
    );
    expect(sites.map((s) => [s.path, s.expected])).toEqual([
      [['stages', 1, 'inertia'], 'inertia'],
      [['output', 'inertia'], 'inertia'],
    ]);
    expect(serialize(done)).toContain('2e-5 kg*m^2');
    // A linear output has no inertia field.
    const linear = {
      ...d,
      output: { kind: 'linear', lead: x('5'), efficiency: x('0.9'), inertia: x('1 kg*m^2') },
    } as unknown as typeof d;
    expect(
      DocumentSchema.safeParse({ ...doc, mech: { ...doc.mech, drivetrains: [linear] } }).success,
    ).toBe(false);
  });

  it('must name existing variables and must not measure the model', () => {
    const doc = mechDocument();
    const lc = { ...loadCase(), dynamic: { ...loadCase().dynamic!, force: x('#missing') } };
    expect(refused(doc, { type: 'setMechLoadCase', loadCase: lc })?.code).toBe('unknown-variable');
    const measuring = {
      ...testBand(),
      low: x('distance("extrude#1:top", "extrude#1:bottom") * 1 N/mm'),
    };
    expect(refused(doc, { type: 'setTestBand', band: measuring })?.code).toBe('expression');
  });

  it('are uses of variables: listed, renamed, inlined and blocking a delete', () => {
    const doc = mechDocument();
    expect(variableUsers(doc, 'pull')).toEqual(
      expect.arrayContaining(['req#1', 'lc#1', 'study#1', 'vt#1']),
    );
    expect(mechVariableUses(doc, 'spoolCore').map((u) => u.itemId)).toEqual(['drive#1']);
    expect(refused(doc, { type: 'deleteVariable', name: 'pull' })?.code).toBe('variable-in-use');
    const renamed = apply(doc, unwrap(renameVariable(doc, 'pull', 'peak'))).document;
    expect(validateDocument(renamed)).toEqual([]);
    expect(renamed.mech!.loadCases![0]!.dynamic!.force.source).toBe('#peak');
    expect(renamed.mech!.testBands![0]!.low!.source).toBe('#peak * 1.5');
    expect(mechVariableUses(renamed, 'pull')).toEqual([]);
    const inlined = apply(doc, unwrap(inlineVariable(doc, 'pull', '200 lbf'))).document;
    expect(inlined.mech!.studies![0]!.loads[0]!.kind === 'force').toBe(true);
    expect(inlined.mech!.requirements![0]!.value).toEqual(x('200 lbf'));
    expect(inlined.mech!.testBands![0]!.low!.source).toBe('(200 lbf) * 1.5');
  });
});

describe('mech limits', () => {
  const withMech = (mech: unknown) => ({ ...(clone(bracket()) as object), mech });

  it('refuse more items than the ADR allows', () => {
    const many = Array.from({ length: MAX_REQUIREMENTS + 1 }, (_, i) => ({
      ...requirements()[1]!,
      id: `req#${i + 1}`,
    }));
    const r = DocumentSchema.safeParse(withMech({ requirements: many, nextIds: { req: 600 } }));
    expect(r.success).toBe(false);
    const ok = DocumentSchema.safeParse(
      withMech({ requirements: many.slice(0, MAX_REQUIREMENTS), nextIds: { req: 600 } }),
    );
    expect(ok.success).toBe(true);
  });

  it('refuse long tables, crowded sheets and long notes', () => {
    const points = Array.from({ length: MAX_TABLE_POINTS + 1 }, (_, i) => [i, i]);
    const lc = {
      ...loadCase(),
      dynamic: { ...loadCase().dynamic!, motion: { kind: 'table', points } },
    };
    expect(
      DocumentSchema.safeParse(withMech({ loadCases: [lc], nextIds: { lc: 2 } })).success,
    ).toBe(false);
    const wires = Array.from({ length: MAX_SHEET_WIRES + 1 }, (_, i) => ({
      id: `wire#${i + 1}`,
      points: [
        [0, i],
        [1, i],
      ],
    }));
    const sch = schematic();
    const crowded = { ...sch, sheets: [{ ...sch.sheets[0]!, wires }] };
    expect(
      DocumentSchema.safeParse(withMech({ schematics: [crowded], nextIds: { wire: 9999 } }))
        .success,
    ).toBe(false);
    const note = { ...specNote(), text: 'a'.repeat(MAX_SPEC_NOTE_TEXT + 1) };
    expect(
      DocumentSchema.safeParse(withMech({ specNotes: [note], nextIds: { note: 2 } })).success,
    ).toBe(false);
  });

  it('refuse a grid point off the grid, a link that is not http, and a bad display unit', () => {
    const sch = schematic();
    const off = { ...sch, sheets: [{ ...sch.sheets[0]!, junctions: [[1.5, 2]] }] };
    expect(DocumentSchema.safeParse(withMech({ schematics: [off], nextIds: {} })).success).toBe(
      false,
    );
    const entry = {
      ...catalogEntry(),
      sources: [{ title: 't', url: 'javascript:alert(1)', read: '2026-10-10' }],
    };
    expect(
      DocumentSchema.safeParse(withMech({ catalog: [entry], nextIds: { entry: 2 } })).success,
    ).toBe(false);
    const doc = clone(bracket());
    doc.units = { ...doc.units, quantities: { force: 'furlong' } };
    expect(DocumentSchema.safeParse(doc).success).toBe(false);
    doc.units = { ...doc.units, quantities: { force: 'lbf', temperature: '°F' } };
    expect(DocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('report an id that was never allocated in a loaded file', () => {
    const doc = clone(mechDocument());
    doc.mech!.nextIds.stage = 2;
    const issues = validateDocument(doc);
    expect(issues.map((i) => i.code)).toContain('invalid-id');
    expect(issues.find((i) => i.code === 'invalid-id')?.path).toEqual([
      'mech',
      'drivetrains',
      0,
      'stages',
      1,
      'id',
    ]);
  });
});

describe('mech changes', () => {
  it('reports items by collection and id, and items reading a changed variable', () => {
    const doc = mechDocument();
    const edited = apply(doc, { type: 'setSpecNote', note: { ...specNote(), text: 'x' } }).document;
    const change = diffDocuments(doc, edited);
    expect(change.mechChanged).toEqual(['specNotes/note#1']);
    expect(change.parts).toEqual([]);
    const bumped = apply(doc, { type: 'setVariable', name: 'pull', expression: x('250 lbf') });
    expect(diffDocuments(doc, bumped.document).mechChanged).toEqual([
      'loadCases/lc#1',
      'requirements/req#1',
      'studies/study#1',
      'testBands/vt#1',
    ]);
    const wired = apply(doc, {
      type: 'setElectrical',
      electrical: { ...electrical(), connections: [], harness: [] },
    }).document;
    expect(diffDocuments(doc, wired).mechChanged).toEqual([
      'electrical/conn#1',
      'electrical/seg#1',
    ]);
    const plain = bracket();
    const none = diffDocuments(plain, plain);
    expect(none.mechChanged).toEqual([]);
    expect(none.materialsChanged).toEqual([]);
    const mat = apply(doc, { type: 'setMaterialDef', material: { ...materialDef(), name: 'n' } });
    expect(diffDocuments(doc, mat.document).materialsChanged).toEqual(['material#1']);
  });
});

describe('mech ids in sync', () => {
  it('lists every id of a mech command in the mech scope', () => {
    const ids = commandIds([{ type: 'setDrivetrain', drivetrain: drivetrain() }], mechDocument());
    expect(ids.filter((i) => i.scope === 'mech').map((i) => i.id)).toEqual([
      'drive#1',
      'stage#1',
      'pp#1',
      'stage#2',
      'stage#3',
      'pp#2',
      'pp#3',
    ]);
    expect(ids).toContainEqual({ scope: 'assembly:assembly#1', id: 'inst#1' });
    expect(ids).toContainEqual({ scope: 'document', id: 'assembly#1' });
  });

  it('reports the first mechanical ids as created, with the scope present while empty', () => {
    const doc = apply(bracket(), {
      type: 'setVariable',
      name: 'pull',
      expression: x('200 lbf'),
    }).document;
    expect(documentCounters(doc).mech).toEqual({});
    const created = unwrap(createdIds(doc, { type: 'setMechLoadCase', loadCase: loadCase() }));
    expect(created.mech).toEqual(['lc#1']);
  });

  it('renames mech ids and the references to them, and what they name elsewhere', () => {
    const doc = mechDocument();
    const out = remapDocument(doc, {
      mech: { 'lc#1': 'lc#5', 'stage#3': 'stage#9', 'pp#1': 'pp#4', r2: 'r7' },
      document: { 'material#1': 'material#3' },
    });
    const m = out.mech!;
    expect(m.loadCases![0]!.id).toBe('lc#5');
    expect(m.requirements![0]!.loadCase).toBe('lc#5');
    expect(m.studies![0]!.loadCase).toBe('lc#5');
    expect(m.drivetrains![0]!.stages.map((s) => s.id)).toEqual(['stage#1', 'stage#2', 'stage#9']);
    expect(m.checks![0]!.subject).toEqual({
      kind: 'stage',
      drivetrain: 'drive#1',
      stage: 'stage#9',
      at: 'seat-A',
    });
    expect(m.purchased![0]!.id).toBe('pp#4');
    expect(m.electrical!.components[0]!.use).toBe('pp#4');
    expect(m.studies![0]!.loads[0]!.faces[0]!.id).toBe('r7');
    expect(m.nextIds.lc).toBe(6);
    expect(m.nextIds.stage).toBe(10);
    expect(out.materials![0]!.id).toBe('material#3');
    expect(out.parts[0]!.material).toBe('material#3');
    expect(out.nextIds.material).toBe(4);
    expect(validateDocument(out)).toEqual([]);
  });

  it('owns nested ids for allocation', () => {
    expect(mechItemIds('schematics', schematic()).map((o) => o.id)).toEqual([
      'sch#1',
      'sheet#1',
      'us#1',
      'us#2',
      'wire#1',
      'label#1',
      'port#1',
      'text#1',
    ]);
    expect(mechItemIds('studies', study()).map((o) => o.id)).toEqual(['study#1', 'r1', 'r2', 'r3']);
  });
});
