import { describe, expect, it } from 'vitest';
import { applyCommand, restoredDocument, type Command } from './commands';
import { remapIds, type RenameTable } from './remap';
import type { ManufaktureDocument, SketchFeature } from './schema';
import {
  counterRegressions,
  documentCounters,
  maxCounters,
  partScope,
  type CounterTable,
} from './scopes';
import {
  CreatedIdsSchema,
  PROTOCOL_VERSION,
  RenameTableSchema,
  SyncEntrySchema,
  createdIds,
  freshRenames,
  remapCreatedIds,
  remapScopeKey,
  takenIds,
  tombstoneTable,
  type CreatedIds,
} from './sync';
import { PART, bracket, deepFreeze, mm, unwrap } from './test-helpers';

const P1 = partScope(PART);

function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  return unwrap(applyCommand(doc, command)).document;
}

function sketch1(doc: ManufaktureDocument): SketchFeature {
  const s = doc.parts[0]!.features.find((f) => f.id === 'sketch#1');
  if (s?.kind !== 'sketch') throw new Error('no sketch#1');
  return s;
}

/** Adds a construction line `id` to sketch#1. */
function addLine(doc: ManufaktureDocument, id: string, x: number): Command {
  const s = sketch1(doc);
  return {
    type: 'editFeature',
    partId: PART,
    feature: {
      ...s,
      entities: [
        ...s.entities,
        { id, kind: 'line', construction: true, start: [x, 0], end: [x, 9] },
      ],
    },
  };
}

describe('createdIds', () => {
  it('lists the fresh ids of an add, by scope, sorted by counter and number', () => {
    const doc = deepFreeze(bracket());
    const counters = doc.parts[0]!.nextIds;
    const created = unwrap(
      createdIds(doc, {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: `sketch#${counters.sketch}`,
          kind: 'sketch',
          name: 'S',
          suppressed: false,
          plane: {
            type: 'face',
            face: { id: `r${counters.r}`, ref: { face: 'extrude#1:side:e1' } },
          },
          entities: [
            { id: 'e11', kind: 'point', construction: false, position: [1, 1] },
            { id: `e${counters.e}`, kind: 'point', construction: false, position: [0, 0] },
          ],
          constraints: [],
        },
      }),
    );
    expect(created).toEqual({
      [P1]: [`e${counters.e}`, 'e11', `r${counters.r}`, `sketch#${counters.sketch}`],
    });
  });

  it('lists only the ids an edit introduces, not the ones the feature already had', () => {
    const doc = bracket();
    const next = doc.parts[0]!.nextIds.e!;
    expect(unwrap(createdIds(doc, addLine(doc, `e${next}`, 50)))).toEqual({ [P1]: [`e${next}`] });
    expect(
      unwrap(createdIds(doc, { type: 'setVariable', name: 'w', expression: mm('2') })),
    ).toEqual({});
  });

  it('never lists split pieces, which have no counter', () => {
    const doc = bracket();
    const s = sketch1(doc);
    const [e1, ...rest] = s.entities;
    if (e1?.kind !== 'line') throw new Error('e1 is a line');
    const split: Command = {
      type: 'editFeature',
      partId: PART,
      feature: {
        ...s,
        entities: [
          { ...e1, id: 'e1#a', end: [20, 0] },
          { ...e1, id: 'e1#b', start: [20, 0] },
          ...rest,
        ],
        constraints: s.constraints.filter((c) => !JSON.stringify(c).includes('"e1"')),
      },
    };
    expect(unwrap(createdIds(doc, split))).toEqual({});
  });

  it('lists a new scope by its id in the parent scope, not its contents', () => {
    const doc = bracket();
    const created = unwrap(
      createdIds(doc, {
        type: 'batch',
        commands: [
          { type: 'addPart', partId: 'part#2', name: 'P' },
          {
            type: 'addFeature',
            partId: 'part#2',
            feature: {
              id: 'sketch#1',
              kind: 'sketch',
              name: 'S',
              suppressed: false,
              plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
              entities: [{ id: 'e1', kind: 'point', construction: false, position: [0, 0] }],
              constraints: [],
            },
          },
          { type: 'duplicatePart', sourcePartId: PART, partId: 'part#3', name: 'Copy' },
        ],
      }),
    );
    expect(created).toEqual({ document: ['part#2', 'part#3'] });
  });

  it('covers every scope: assembly, CAM and print ids', () => {
    const doc = apply(bracket(), { type: 'addAssembly', assemblyId: 'assembly#1', name: 'A' });
    const created = unwrap(
      createdIds(doc, {
        type: 'batch',
        commands: [
          {
            type: 'addInstance',
            assemblyId: 'assembly#1',
            instance: {
              id: 'inst#1',
              name: 'I',
              source: { part: PART },
              fixed: true,
              suppressed: false,
              pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
            },
          },
          {
            type: 'addCamTool',
            tool: {
              id: 'tool#1',
              name: 'T',
              kind: 'flat',
              diameter: mm('6'),
              fluteLength: mm('19'),
              flutes: 2,
              presets: [],
            },
          },
          {
            type: 'addPrintSetup',
            setup: {
              id: 'print#1',
              name: 'P',
              printer: 'bambu-a1-mini',
              nozzle: 0.4,
              items: [
                {
                  id: 'item#1',
                  part: PART,
                  orientation: {
                    kind: 'layFlat',
                    face: { id: 'r1', ref: { face: 'extrude#1:cap:start' } },
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(created).toEqual({
      'assembly:assembly#1': ['inst#1'],
      cam: ['tool#1'],
      print: ['item#1', 'print#1', 'r1'],
    });
  });

  it('refuses what applyCommand refuses', () => {
    const r = createdIds(bracket(), { type: 'deleteFeature', partId: PART, featureId: 'hole#9' });
    expect(r.ok).toBe(false);
  });
});

describe('the takeover guard (ADR 0009 amendment, items 1 and 2)', () => {
  it('catches two concurrent edits that each add e10 to one sketch, which core accepts', () => {
    const base = deepFreeze(bracket());
    const e = `e${base.parts[0]!.nextIds.e}`;
    // Clients A and B both add the next entity id to sketch#1, on the same base document.
    const a = addLine(base, e, 60);
    const b = addLine(base, e, 70);
    const createdA = unwrap(createdIds(base, a));
    const createdB = unwrap(createdIds(base, b));
    expect(createdB).toEqual({ [P1]: [e] });
    // The server accepts A. Core alone would accept B too, taking over A's entity.
    const head = apply(base, a);
    expect(applyCommand(head, b).ok).toBe(true);
    // The guard refuses B as id-reused: its created id is below the head's counter.
    expect(takenIds(documentCounters(head), createdB)).toEqual({ [P1]: [e] });
    expect(takenIds(documentCounters(base), createdA)).toEqual({});
  });

  it('skips scopes the counters do not have', () => {
    expect(takenIds({}, { 'part:part#9': ['extrude#1'] })).toEqual({});
  });
});

describe('freshRenames', () => {
  const counters: CounterTable = { [P1]: { extrude: 5, e: 12 }, document: { part: 3 } };

  it('renames taken ids to the next free numbers, in order, and moves the counters', () => {
    const { table, counters: after } = freshRenames(counters, {
      [P1]: ['extrude#3', 'e10', 'e4', 'extrude#4'],
      document: ['part#2'],
    });
    expect(table).toEqual({
      [P1]: { e4: 'e12', e10: 'e13', 'extrude#3': 'extrude#5', 'extrude#4': 'extrude#6' },
      document: { 'part#2': 'part#3' },
    });
    expect(after).toEqual({ [P1]: { extrude: 7, e: 14 }, document: { part: 4 } });
    expect(counters).toEqual({ [P1]: { extrude: 5, e: 12 }, document: { part: 3 } });
  });

  it('skips reserved ids (tombstones, held ids)', () => {
    const { table } = freshRenames(
      counters,
      { [P1]: ['extrude#2'] },
      { reserved: { [P1]: ['extrude#5', 'extrude#6'] } },
    );
    expect(table).toEqual({ [P1]: { 'extrude#2': 'extrude#7' } });
  });

  it('renames an in-flight entry whose ids were taken, in the client naming (item 4)', () => {
    // The client made A (adds extrude#3) on a base where extrude#3 was free; a remote
    // extrude#3 arrived first, so A can never be accepted. The client renames it at once.
    const base = bracket();
    const sketch = sketch1(base);
    const next = base.parts[0]!.nextIds.extrude!;
    const make = (id: string): Command => ({
      type: 'addFeature',
      partId: PART,
      feature: {
        id,
        kind: 'extrude',
        name: 'E',
        suppressed: false,
        profile: { sketch: sketch.id },
        operation: 'add',
        extent: { type: 'blind', distance: mm('2') },
        reverse: false,
      },
    });
    const mine = make(`extrude#${next}`);
    const created = unwrap(createdIds(base, mine));
    const confirmed = apply(base, make(`extrude#${next}`)); // the remote one
    const taken = takenIds(documentCounters(confirmed), created);
    expect(taken).toEqual(created);
    const { table } = freshRenames(documentCounters(confirmed), taken);
    const [renamed] = remapIds([mine], table);
    expect(applyCommand(confirmed, renamed!).ok).toBe(true);
    expect(remapCreatedIds(created, table)).toEqual({ [P1]: [`extrude#${next + 1}`] });
  });
});

describe('tombstones and created ids under a remap', () => {
  it('builds a tombstone table from created ids', () => {
    expect(tombstoneTable({ [P1]: ['extrude#4', 'e9'] })).toEqual({
      [P1]: { 'extrude#4': null, e9: null },
    });
  });

  it('rewrites created ids with the command, scope keys included', () => {
    const table: RenameTable = {
      document: { 'part#3': 'part#5' },
      'part:part#3': { 'extrude#1': 'extrude#2' },
    };
    const created: CreatedIds = { 'part:part#3': ['e4', 'extrude#1'], document: ['part#3'] };
    expect(remapCreatedIds(created, table)).toEqual({
      document: ['part#5'],
      'part:part#5': ['e4', 'extrude#2'],
    });
    expect(remapScopeKey('cam', table)).toBe('cam');
  });
});

describe('counter regressions (ADR 0009 amendment, item 3)', () => {
  it('finds a counter below its high-water mark, a deleted part that comes back included', () => {
    const base = apply(bracket(), {
      type: 'duplicatePart',
      sourcePartId: PART,
      partId: 'part#2',
      name: 'Copy',
    });
    const grown = apply(base, {
      type: 'addFeature',
      partId: 'part#2',
      feature: {
        id: `sketch#${base.parts[1]!.nextIds.sketch}`,
        kind: 'sketch',
        name: 'S',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: [],
        constraints: [],
      },
    });
    const deleted = apply(grown, { type: 'deletePart', partId: 'part#2' });
    let high = maxCounters(documentCounters(base), documentCounters(grown));
    high = maxCounters(high, documentCounters(deleted));
    expect(counterRegressions(high, documentCounters(deleted))).toEqual([]);
    // A stale restore of `base` brings part#2 back with its old counters.
    const stale = restoredDocument(deleted, base);
    expect(counterRegressions(documentCounters(deleted), documentCounters(stale))).toEqual([]);
    expect(counterRegressions(high, documentCounters(stale))).toEqual([
      {
        scope: 'part:part#2',
        counter: 'sketch',
        before: grown.parts[1]!.nextIds.sketch,
        after: base.parts[1]!.nextIds.sketch,
      },
    ]);
  });

  it('restoredDocument with a high-water floor never moves a counter back (item 11)', () => {
    const base = apply(bracket(), {
      type: 'duplicatePart',
      sourcePartId: PART,
      partId: 'part#2',
      name: 'Copy',
    });
    const grown = apply(base, {
      type: 'addFeature',
      partId: 'part#2',
      feature: {
        id: `sketch#${base.parts[1]!.nextIds.sketch}`,
        kind: 'sketch',
        name: 'S',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: [],
        constraints: [],
      },
    });
    const deleted = apply(grown, { type: 'deletePart', partId: 'part#2' });
    const high = [base, grown, deleted].reduce<CounterTable>(
      (acc, d) => maxCounters(acc, documentCounters(d)),
      {},
    );
    const restored = restoredDocument(deleted, base, high);
    expect(counterRegressions(high, documentCounters(restored))).toEqual([]);
    expect(restored.parts[1]!.nextIds.sketch).toBe(grown.parts[1]!.nextIds.sketch);
    // It is still the past version otherwise, and a valid replacement.
    expect(restored.parts[1]!.features).toEqual(base.parts[1]!.features);
    expect(applyCommand(deleted, { type: 'replaceDocument', document: restored }).ok).toBe(true);
    // Without a floor the old behaviour stays: the deleted part's counters come from `base`.
    expect(restoredDocument(deleted, base).parts[1]!.nextIds.sketch).toBe(
      base.parts[1]!.nextIds.sketch,
    );
  });

  it('treats an absent counter as 1 and ignores scopes only the high-water mark has', () => {
    expect(counterRegressions({ cam: { tool: 3 }, 'part:part#9': { e: 5 } }, { cam: {} })).toEqual([
      { scope: 'cam', counter: 'tool', before: 3, after: 1 },
    ]);
  });
});

describe('SyncEntrySchema', () => {
  const entry = {
    clientId: 'c-1',
    clientSeq: 4,
    prevSeq: 3,
    baseRev: 17,
    format: 15,
    cause: 'execute',
    label: 'Extrude',
    command: { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
    created: {},
    at: '2026-10-04T10:00:00.000Z',
  };

  it('accepts an entry in storage form, prevSeq optional', () => {
    expect(SyncEntrySchema.safeParse(entry).success).toBe(true);
    const { prevSeq: _p, ...first } = entry;
    void _p;
    expect(SyncEntrySchema.safeParse(first).success).toBe(true);
    // The command is stored as written, so an old command shape still parses here.
    expect(
      SyncEntrySchema.safeParse({ ...entry, format: 3, command: { type: 'retired', x: 1 } })
        .success,
    ).toBe(true);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('refuses a missing created list, bad sequence numbers and unknown fields', () => {
    const { created: _c, ...noCreated } = entry;
    void _c;
    expect(SyncEntrySchema.safeParse(noCreated).success).toBe(false);
    expect(SyncEntrySchema.safeParse({ ...entry, clientSeq: 0 }).success).toBe(false);
    expect(SyncEntrySchema.safeParse({ ...entry, prevSeq: 1.5 }).success).toBe(false);
    expect(SyncEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
    expect(SyncEntrySchema.safeParse({ ...entry, cause: 'load' }).success).toBe(false);
    expect(SyncEntrySchema.safeParse({ ...entry, command: { featureId: 'x' } }).success).toBe(
      false,
    );
  });

  it('checks created ids and rename tables', () => {
    expect(CreatedIdsSchema.safeParse({ [P1]: ['extrude#4', 'e10'] }).success).toBe(true);
    expect(CreatedIdsSchema.safeParse({ [P1]: ['e10#a'] }).success).toBe(false);
    expect(CreatedIdsSchema.safeParse({ [P1]: [] }).success).toBe(false);
    expect(RenameTableSchema.safeParse({ [P1]: { e4: 'e9', 'extrude#1': null } }).success).toBe(
      true,
    );
    expect(RenameTableSchema.safeParse({ [P1]: { e4: 'k9' } }).success).toBe(false);
    expect(RenameTableSchema.safeParse({ [P1]: { 'e4#a': 'e9' } }).success).toBe(false);
  });
});
