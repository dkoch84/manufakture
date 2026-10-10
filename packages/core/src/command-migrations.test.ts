import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from './commands';
import { createDocument } from './document';
import { deserialize, serialize } from './format';
import {
  COMMAND_MIGRATIONS,
  FORMAT_MIGRATIONS,
  migrateCommand,
  type CommandMigration,
} from './migrations';
import { FORMAT_VERSION } from './schema';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';
import v0Bracket from './fixtures/v0-bracket.json';
import v3Bracket from './fixtures/v3-bracket.json';
import v13Bracket from './fixtures/v13-bracket.json';
import v16Bracket from './fixtures/v16-bracket.json';
import v17Bracket from './fixtures/v17-bracket.json';
import v18Bracket from './fixtures/v18-bracket.json';

describe('command migrations', () => {
  it('has one command step per document format step, in step', () => {
    expect(COMMAND_MIGRATIONS).toHaveLength(FORMAT_MIGRATIONS.length);
    expect(COMMAND_MIGRATIONS).toHaveLength(FORMAT_VERSION);
    COMMAND_MIGRATIONS.forEach((m, i) => {
      expect([m.from, m.to]).toEqual([i, i + 1]);
      expect(m.description).toBe(FORMAT_MIGRATIONS[i]!.description);
    });
  });

  it('passes a current command through unchanged, without touching the input', () => {
    const command = deepFreeze<Command>({
      type: 'deleteFeature',
      partId: PART,
      featureId: 'fillet#1',
    });
    expect(unwrap(migrateCommand(command, FORMAT_VERSION))).toEqual(command);
  });

  it('gives a version 0 feature its suppressed flag, inside batches too', () => {
    const feature = clone(v0Bracket.parts[0]!.features[4]) as Record<string, unknown>;
    expect('suppressed' in feature).toBe(false);
    const doc = deepFreeze(bracket());
    const old = {
      type: 'batch',
      commands: [
        { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            ...feature,
            id: 'fillet#2',
            edges: (feature.edges as { ref: unknown }[]).map((e) => ({
              ...e,
              id: `r${doc.parts[0]!.nextIds.r}`,
            })),
          },
        },
      ],
    };
    const migrated = unwrap(migrateCommand(old, 0));
    expect(migrated).toMatchObject({
      commands: [{}, { feature: { id: 'fillet#2', suppressed: false } }],
    });
    expect(applyCommand(doc, migrated).ok).toBe(true);
  });

  it('gives a version 3 restored part its body props', () => {
    const v3 = clone(v3Bracket) as { parts: Record<string, unknown>[] };
    const part = { ...v3.parts[0]!, id: 'part#2' };
    const migrated = unwrap(migrateCommand({ type: 'restorePart', part, index: 1 }, 3));
    expect(migrated).toMatchObject({ part: { id: 'part#2', bodies: [] } });
  });

  it("migrates a replaceDocument's whole document through the document migrations", () => {
    const current = unwrap(deserialize(JSON.stringify(v13Bracket))).document;
    const migrated = unwrap(
      migrateCommand({ type: 'replaceDocument', document: clone(v13Bracket) }, 13),
    );
    expect(migrated.type === 'replaceDocument' && migrated.document.version).toBe(FORMAT_VERSION);
    const replaced = unwrap(applyCommand(current, migrated)).document;
    expect(serialize(replaced)).toBe(serialize(current));
  });

  it('brings version 16 commands to version 17 unchanged', () => {
    // Version 17 added body groups and nothing a version 16 command carries changes.
    const v16 = clone(v16Bracket) as { parts: Record<string, unknown>[] };
    const restore = { type: 'restorePart', part: { ...v16.parts[0]!, id: 'part#2' }, index: 1 };
    expect(unwrap(migrateCommand(restore, 16))).toEqual(restore);
    const replaced = unwrap(migrateCommand({ type: 'replaceDocument', document: v16 }, 16));
    expect(replaced.type === 'replaceDocument' && replaced.document.version).toBe(FORMAT_VERSION);
    // A version 16 restored part cannot have groups: the document step refuses the key.
    const document = { ...v16, parts: [{ ...v16.parts[0]!, bodyGroups: [] }] };
    const refused = migrateCommand({ type: 'replaceDocument', document }, 16);
    expect(!refused.ok && refused.error.code).toBe('migration');
    // A group command, new in 17, passes through as it is.
    const group = {
      type: 'setBodyGroup',
      partId: PART,
      group: { id: 'group#1', name: 'Frame', bodies: ['extrude#1'] },
    };
    expect(unwrap(migrateCommand(group, 17))).toEqual(group);
  });

  it('brings version 17 commands to version 18 unchanged', () => {
    // Version 18 added a hole's tip angle and insert standard; a version 17 hole keeps its shape.
    const hole = {
      id: 'hole#1',
      kind: 'hole',
      name: 'Holes',
      suppressed: false,
      sketch: 'sketch#2',
      points: ['e5'],
      diameter: mm('5.5'),
      extent: { type: 'blind', depth: mm('8') },
      head: { type: 'simple' },
      standard: { size: 'M5', fit: 'normal' },
    };
    const add = { type: 'addFeature', partId: PART, feature: hole };
    expect(unwrap(migrateCommand(add, 17))).toEqual(add);
    const v17 = clone(v17Bracket) as { parts: { features: unknown[] }[] };
    const replaced = unwrap(migrateCommand({ type: 'replaceDocument', document: v17 }, 17));
    expect(replaced.type === 'replaceDocument' && replaced.document.version).toBe(FORMAT_VERSION);
    // A version 17 document cannot hold a flat-bottomed hole: the document step refuses it.
    const flat = { ...hole, extent: { ...hole.extent, tipAngle: mm('180deg') } };
    const document = { ...v17, parts: [{ ...v17.parts[0]!, features: [flat] }] };
    const refused = migrateCommand({ type: 'replaceDocument', document }, 17);
    expect(!refused.ok && refused.error.code).toBe('migration');
    // An insert hole, new in 18, passes through as it is.
    const insert = {
      ...add,
      feature: {
        ...flat,
        diameter: mm('4'),
        standard: { size: 'M3', purpose: 'heat-set-insert' },
      },
    };
    expect(unwrap(migrateCommand(insert, 18))).toEqual(insert);
  });

  it('brings version 18 commands to version 19 unchanged', () => {
    // Version 19 added the mech section, user materials and display units per kind; no version 18
    // command carries any of them.
    const material = { type: 'setMaterial', partId: PART, material: 'pla' };
    expect(unwrap(migrateCommand(material, 18))).toEqual(material);
    const v18 = clone(v18Bracket) as Record<string, unknown>;
    const replaced = unwrap(migrateCommand({ type: 'replaceDocument', document: v18 }, 18));
    expect(replaced.type === 'replaceDocument' && replaced.document.version).toBe(FORMAT_VERSION);
    // A version 18 document cannot hold a mech section: the document step refuses it.
    const document = { ...v18, mech: { nextIds: { req: 2 } } };
    const refused = migrateCommand({ type: 'replaceDocument', document }, 18);
    expect(!refused.ok && refused.error.code).toBe('migration');
    // A mech command, new in 19, passes through as it is.
    const lc = {
      type: 'deleteMechLoadCase',
      loadCaseId: 'lc#1',
    };
    expect(unwrap(migrateCommand(lc, 19))).toEqual(lc);
  });

  it('refuses a newer format, a bad format and a command that is not one', () => {
    const c = { type: 'renameDocument', name: 'x' };
    const newer = migrateCommand(c, FORMAT_VERSION + 1);
    expect(!newer.ok && newer.error.code).toBe('version');
    const bad = migrateCommand(c, -1);
    expect(!bad.ok && bad.error.code).toBe('version');
    const notOne = migrateCommand(['renameDocument'], 3);
    expect(!notOne.ok && notOne.error.code).toBe('schema');
    const invalid = migrateCommand({ type: 'renameDocument', name: 7 }, FORMAT_VERSION);
    expect(!invalid.ok && invalid.error.code).toBe('schema');
  });

  it('reports a broken chain and a throwing step as migration errors', () => {
    const throwing: CommandMigration[] = [
      {
        from: 0,
        to: 1,
        description: 'x',
        migrate: () => {
          throw new Error('boom');
        },
      },
    ];
    const r = migrateCommand({ type: 'renameDocument', name: 'x' }, 0, {
      formatVersion: 1,
      commandMigrations: throwing,
    });
    expect(!r.ok && r.error.code).toBe('migration');
    const gap = migrateCommand({ type: 'renameDocument', name: 'x' }, 0, {
      formatVersion: 2,
      commandMigrations: COMMAND_MIGRATIONS.slice(0, 1),
    });
    expect(!gap.ok && gap.error.code).toBe('migration');
  });

  it('returns a command applyCommand takes', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    const r = unwrap(migrateCommand({ type: 'setVariable', name: 'w', expression: mm('2') }, 9));
    expect(applyCommand(doc, r).ok).toBe(true);
  });
});
