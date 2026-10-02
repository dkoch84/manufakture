import { applyCommand, createPrintSetup, serialize, type Command } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary, type LoggedRevision, type Version } from '../persistence/library';
import { partDocument, partWithImport, unwrapDoc } from '../persistence/test-fixtures';
import { createViewSettingsStore, hiddenBodiesOf } from '../state/viewSettings';
import {
  compareDocuments,
  readTarget,
  referenceImportIds,
  restoreCommand,
  sameTarget,
  targetLabel,
  timeline,
  viewDocuments,
  viewSettingsFor,
} from './history';

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;

const version = (id: string, name: string, revision: number): Version => ({
  id,
  name,
  description: '',
  revision,
  snapshotSha256: 'a'.repeat(64),
  createdAt: '2026-09-30T10:00:00.000Z',
});

const entry = (label: string, at: string, cause: 'execute' | 'undo' | 'redo' = 'execute') => ({
  cause,
  label,
  at,
});

describe('the timeline', () => {
  const logged: LoggedRevision[] = [
    { revision: 1, entries: [entry('Add Sketch 1', '2026-09-30T09:00:00.000Z')] },
    {
      revision: 2,
      entries: [
        entry('Add Extrude 1', '2026-09-30T09:05:00.000Z'),
        entry('Add Extrude 1', '2026-09-30T09:06:00.000Z', 'undo'),
        entry('Add Extrude 1', '2026-09-30T09:07:00.000Z', 'redo'),
      ],
    },
    // Two hours later: a new session.
    { revision: 4, entries: [entry('Edit #thickness', '2026-09-30T11:07:00.000Z')] },
    { revision: 5, entries: [] },
  ];

  it('groups revisions into sessions by the pause between them, newest first', () => {
    const sessions = timeline(logged, [version('v1', '6 mm', 2)], 2);
    expect(sessions.map((s) => s.revisions.map((r) => r.revision))).toEqual([[4], [2, 1]]);
    expect(sessions[1]).toMatchObject({
      start: '2026-09-30T09:00:00.000Z',
      end: '2026-09-30T09:07:00.000Z',
    });
    const two = sessions[1]!.revisions[0]!;
    expect(two.labels).toEqual(['Add Extrude 1', 'Undo Add Extrude 1', 'Redo Add Extrude 1']);
    expect(two.at).toBe('2026-09-30T09:07:00.000Z');
    expect(two.versions.map((v) => v.name)).toEqual(['6 mm']);
    // Revision 1 is older than the oldest retained snapshot: it cannot be read back.
    expect(sessions[1]!.revisions.map((r) => r.readable)).toEqual([true, false]);
    expect(sessions[0]!.revisions[0]!.readable).toBe(true);
  });

  it('keeps everything in one session under a longer gap, and none is readable without a start', () => {
    const sessions = timeline(logged, [], null, 3 * 60 * 60 * 1000);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revisions.every((r) => !r.readable)).toBe(true);
    expect(timeline([], [], 1)).toEqual([]);
  });
});

describe('targets', () => {
  it('labels and compares versions and revisions', () => {
    const v = { kind: 'version', version: version('v1', '6 mm', 3) } as const;
    const r = { kind: 'revision', revision: 3 } as const;
    expect(targetLabel(v)).toBe('Version "6 mm"');
    expect(targetLabel(r)).toBe('Revision 3');
    expect(sameTarget(v, { kind: 'version', version: version('v1', 'renamed', 3) })).toBe(true);
    expect(sameTarget(v, r)).toBe(false);
    expect(sameTarget(r, { kind: 'revision', revision: 3 })).toBe(true);
    expect(sameTarget(r, { kind: 'revision', revision: 4 })).toBe(false);
    expect(sameTarget(null, r)).toBe(false);
  });

  it('reads a version and a revision back from the library', async () => {
    const lib = new DocumentLibrary(new MemoryBackend(), { locks: null });
    const one = partDocument('doc-1', 'One');
    await lib.save(one);
    const two = unwrapDoc(applyCommand(one, { type: 'renameDocument', name: 'Two' }));
    await lib.save(two, [
      {
        cause: 'execute',
        label: 'Rename document',
        command: { type: 'renameDocument', name: 'Two' },
        at: '2026-09-30T10:00:00.000Z',
      },
    ]);
    const made = await lib.createVersion('doc-1', { name: 'Named' });
    if (!made.ok) throw new Error(made.message);
    const byVersion = await readTarget(lib, 'doc-1', { kind: 'version', version: made.value });
    expect(byVersion).toMatchObject({ ok: true, value: { name: 'Two' } });
    const byRevision = await readTarget(lib, 'doc-1', { kind: 'revision', revision: 1 });
    expect(byRevision).toMatchObject({ ok: true, value: { name: 'One' } });
    const missing = await readTarget(lib, 'doc-1', {
      kind: 'version',
      version: version('nope', 'Nope', 1),
    });
    expect(missing.ok).toBe(false);
  });
});

describe('restoring', () => {
  it('replaces the document with the past one, keeping its id and counters', () => {
    const past = partDocument('doc-1', 'Past');
    const current = unwrapDoc(
      applyCommand(past, { type: 'addPart', partId: 'part#2', name: 'Later' }),
    );
    const command = restoreCommand(current, { ...past, id: 'other' });
    expect(command.type).toBe('replaceDocument');
    const restored = unwrapDoc(applyCommand(current, command));
    expect(restored.id).toBe('doc-1');
    expect(restored.parts.map((p) => p.id)).toEqual(['part#1']);
    expect(restored.nextIds).toEqual(current.nextIds);
  });
});

describe('the read-only view store', () => {
  it('ignores every change and keeps the viewed document', () => {
    const doc = unwrapDoc(
      applyCommand(partDocument(), { type: 'addPart', partId: 'part#2', name: 'Second' }),
    );
    const store = viewDocuments(doc, 'part#2');
    expect(store.getState().activePartId).toBe('part#2');
    const command: Command = { type: 'renameDocument', name: 'Changed' };
    expect(store.getState().execute(command).ok).toBe(true);
    store.getState().undo();
    store.getState().load(partDocument('doc-1', 'Other'));
    expect(serialize(store.getState().document)).toBe(serialize(doc));
    expect(store.core.document).toBe(doc);
    expect(store.getState().setActivePart('part#1')).toBe(true);
    expect(viewDocuments(doc, 'part#9').getState().activePartId).toBe('part#1');
  });
});

describe('comparing with the current state', () => {
  const current = partDocument();
  const featureName = (id: string) =>
    current.parts[0]!.features.find((f) => f.id === id)?.name ?? id;

  it('says nothing differs for the same document', () => {
    expect(compareDocuments(current, current)).toEqual([]);
  });

  it('lists features, variables, part studios, names and units that differ', () => {
    const [first, ...rest] = current.parts[0]!.features;
    void rest;
    const commands: Command[] = [
      { type: 'setVariable', name: 'extra', expression: mm('3') },
      { type: 'renameFeature', partId: 'part#1', featureId: first!.id, name: 'Renamed' },
      { type: 'renameDocument', name: 'Viewed' },
      { type: 'addPart', partId: 'part#2', name: 'Lid' },
      { type: 'setDisplayUnits', units: { ...current.units, length: { unit: 'in' } } },
    ];
    const viewed = unwrapDoc(applyCommand(current, { type: 'batch', commands }));
    const lines = compareDocuments(current, viewed);
    expect(lines).toContain('Named "Viewed" here, "Bracket" now.');
    expect(lines).toContain('Part studios only here: Lid.');
    expect(lines).toContain(`Features that differ: Renamed (${current.parts[0]!.name}).`);
    expect(lines).toContain('Variables only here: #extra.');
    expect(lines).toContain('Display units differ.');
    // The other way round, the part studio and the variable are the current state's.
    const back = compareDocuments(viewed, current);
    expect(back).toContain('Part studios only in the current state: Lid.');
    expect(back).toContain('Variables only in the current state: #extra.');
    expect(featureName(first!.id)).toBe(first!.name);
  });

  it('lists features added and removed', () => {
    const last = current.parts[0]!.features.at(-1)!;
    const viewed = unwrapDoc(
      applyCommand(current, { type: 'deleteFeature', partId: 'part#1', featureId: last.id }),
    );
    expect(compareDocuments(current, viewed)).toEqual([
      `Features only in the current state: ${last.name}.`,
    ]);
    expect(compareDocuments(viewed, current)).toEqual([`Features only here: ${last.name}.`]);
  });

  it('lists fonts and domain data that differ, which change no geometry by themselves', () => {
    const withFont = unwrapDoc(
      applyCommand(current, {
        type: 'addFont',
        font: {
          id: 'font#1',
          family: 'Inter',
          style: 'Bold',
          source: { kind: 'bundled', id: 'inter-bold', sha256: 'f'.repeat(64) },
        },
      }),
    );
    expect(compareDocuments(current, withFont)).toEqual(['Fonts only here: Inter Bold.']);
    expect(compareDocuments(withFont, current)).toEqual([
      'Fonts only in the current state: Inter Bold.',
    ]);
    const stock = unwrapDoc(
      applyCommand(current, {
        type: 'setDomainData',
        namespace: 'stock',
        schemaVersion: 1,
        data: { overrides: { 'us-ply-23-32': { thickness: mm('18.2') } } },
      }),
    );
    // Not "Same as the current state": a version differing only in its stock overrides.
    expect(compareDocuments(current, stock)).toEqual(['Settings that differ: stock overrides.']);
    const both = unwrapDoc(
      applyCommand(stock, {
        type: 'batch',
        commands: [
          { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: {} },
          { type: 'setDomainData', namespace: 'cam-x', schemaVersion: 1, data: {} },
        ],
      }),
    );
    expect(compareDocuments(current, both)).toEqual([
      'Settings that differ: "cam-x" data, stock overrides, woodworking settings.',
    ]);
  });

  it('lists print setups added, removed and changed, which change no geometry', () => {
    const add = (doc: typeof current, id: string, name: string) =>
      unwrapDoc(
        applyCommand(doc, {
          type: 'addPrintSetup',
          setup: createPrintSetup(id, name, 'bambu-x1c', 0.4),
        }),
      );
    const withPlate = add(current, 'print#1', 'Plate 1');
    expect(compareDocuments(current, withPlate)).toEqual(['Print setups only here: Plate 1.']);
    expect(compareDocuments(withPlate, current)).toEqual([
      'Print setups only in the current state: Plate 1.',
    ]);
    const onMini = unwrapDoc(
      applyCommand(withPlate, {
        type: 'editPrintSetup',
        setupId: 'print#1',
        printer: 'bambu-a1-mini',
      }),
    );
    expect(compareDocuments(withPlate, onMini)).toEqual(['Print setups that differ: Plate 1.']);
  });
});

describe('what a view keeps of its own', () => {
  it('hides bodies in its own settings, starting from the open document', () => {
    const memory = new Map<string, string>();
    const open = createViewSettingsStore(() => ({
      length: 0,
      clear: () => memory.clear(),
      getItem: (k) => memory.get(k) ?? null,
      key: () => null,
      removeItem: (k) => void memory.delete(k),
      setItem: (k, v) => void memory.set(k, v),
    }));
    open.getState().setBodyHidden('doc-1', 'part#1/extrude#1', true);
    const view = viewSettingsFor(open, 'doc-1');
    expect(hiddenBodiesOf(view.getState(), 'doc-1')).toEqual(['part#1/extrude#1']);
    view.getState().setBodyHidden('doc-1', 'part#1/extrude#2', true);
    view.getState().setBodyHidden('doc-1', 'part#1/extrude#1', false);
    expect(hiddenBodiesOf(open.getState(), 'doc-1')).toEqual(['part#1/extrude#1']);
    expect(hiddenBodiesOf(view.getState(), 'doc-1')).toEqual(['part#1/extrude#2']);
  });

  it('lists the reference imports of a document by body id', async () => {
    expect(referenceImportIds(partDocument())).toEqual([]);
    expect(referenceImportIds(await partWithImport())).toEqual(['part#1/import#1']);
  });
});
