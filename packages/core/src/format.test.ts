import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { createDocument } from './document';
import { deserialize, migrateJson, parseDocument, serialize } from './format';
import { FORMAT_MIGRATIONS, migrateV0ToV1, migrateV1ToV2, type Migration } from './migrations';
import type { CoreErrorCode } from './result';
import { FORMAT_VERSION, NAMING_SCHEME, type ManufaktureDocument } from './schema';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';
import v0Bracket from './fixtures/v0-bracket.json';
import v1Bracket from './fixtures/v1-bracket.json';
import v2Bracket from './fixtures/v2-bracket.json';

/** One fixture per older file version; `migrates every older version` checks this is complete. */
const FIXTURES: Record<number, unknown> = { 0: v0Bracket, 1: v1Bracket };

function load(value: unknown): ManufaktureDocument {
  return unwrap(parseDocument(value)).document;
}

describe('serialize and deserialize', () => {
  const documents: [string, () => ManufaktureDocument][] = [
    ['an empty document', () => createDocument({ id: 'd', name: 'Empty' })],
    ['the bracket', bracket],
    ['the current fixture', () => load(v2Bracket)],
    [
      'a document with a material',
      () =>
        unwrap(applyCommand(bracket(), { type: 'setMaterial', partId: PART, material: 'plywood' }))
          .document,
    ],
    [
      'a rolled back, suppressed, imperial document',
      () =>
        unwrap(
          applyCommand(bracket(), {
            type: 'batch',
            commands: [
              {
                type: 'setDisplayUnits',
                units: { length: { unit: 'in-fraction', denominator: 64 }, angle: { unit: 'rad' } },
              },
              {
                type: 'setVariable',
                name: 'gap',
                expression: { source: `4 1/2 + 1/16"`, lengthUnit: 'in', angleUnit: 'rad' },
              },
              { type: 'suppressFeature', partId: PART, featureId: 'fillet#1', suppressed: true },
              { type: 'setRollback', partId: PART, index: 3 },
              {
                type: 'renameFeature',
                partId: PART,
                featureId: 'extrude#2',
                name: 'Hole "M6" äöü',
              },
            ],
          }),
        ).document,
    ],
    [
      'a document with an extension feature',
      () =>
        unwrap(
          applyCommand(bracket(), {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'extension#1',
              kind: 'extension',
              name: 'Brim',
              suppressed: false,
              extension: 'print.brim',
              schemaVersion: 2,
              dependsOn: ['extrude#1'],
              references: [{ id: 'r3', ref: { face: 'extrude#1:cap:start' } }],
              expressions: { width: mm('5'), gap: mm('thickness / 10') },
              params: { z: [3, { b: 1, a: 2 }], a: null, m: { y: true, x: 'text' } },
            },
          }),
        ).document,
    ],
  ];

  it.each(documents)('round trips %s', (_label, make) => {
    const doc = deepFreeze(make());
    const text = serialize(doc);
    const loaded = unwrap(deserialize(text));
    expect(loaded.document).toEqual(doc);
    expect(loaded.migrated).toBe(false);
    expect(loaded.from).toEqual({ version: FORMAT_VERSION, namingScheme: NAMING_SCHEME });
    // Idempotent: saving what was loaded gives the same bytes, however often.
    expect(serialize(loaded.document)).toBe(text);
    expect(serialize(unwrap(deserialize(serialize(loaded.document))).document)).toBe(text);
  });

  it('writes keys in schema order whatever order the object had', () => {
    const doc = documents.at(-1)![1]();
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    const shuffled = reverseKeys(doc) as ManufaktureDocument;
    expect(shuffled).toEqual(doc);
    expect(Object.keys(shuffled)[0]).not.toBe('format');
    expect(serialize(shuffled)).toBe(serialize(doc));
    expect(serialize(unwrap(deserialize(serialize(shuffled))).document)).toBe(serialize(doc));
    expect(
      serialize(doc).startsWith(
        '{\n  "format": "manufakture",\n  "version": 2,\n  "namingScheme": 1,',
      ),
    ).toBe(true);
  });

  it('refuses to serialize an invalid document', () => {
    const doc = clone(bracket()) as unknown as { version: number };
    doc.version = 7;
    expect(() => serialize(doc as unknown as ManufaktureDocument)).toThrow(/Cannot serialize/);
  });
});

describe('loading errors', () => {
  const current = () => clone(v2Bracket) as Record<string, unknown>;
  const cases: [string, string | (() => unknown), CoreErrorCode, RegExp?][] = [
    ['not JSON', '{ "format": ', 'json'],
    ['an array', '[]', 'format'],
    ['null', 'null', 'format'],
    ['another format', () => ({ ...current(), format: 'step' }), 'format'],
    ['no version', () => ({ ...current(), version: undefined }), 'version'],
    ['a fractional version', () => ({ ...current(), version: 0.5 }), 'version'],
    ['a negative version', () => ({ ...current(), version: -1 }), 'version'],
    ['a string version', () => ({ ...current(), version: '1' }), 'version'],
    [
      'a newer version',
      () => ({ ...current(), version: FORMAT_VERSION + 1 }),
      'version',
      /newer version of manufakture/,
    ],
    [
      'a newer naming scheme',
      () => ({ ...current(), namingScheme: NAMING_SCHEME + 1 }),
      'version',
      /newer topological naming scheme/,
    ],
    ['naming scheme 0', () => ({ ...current(), namingScheme: 0 }), 'version'],
    ['an unknown key', () => ({ ...current(), extra: true }), 'schema'],
    [
      'a feature of an unknown kind',
      () => {
        const d = current() as { parts: { features: { kind: string }[] }[] };
        d.parts[0]!.features[1]!.kind = 'loft';
        return d;
      },
      'schema',
    ],
    [
      'a semantic error',
      () => {
        const d = current() as { parts: { nextIds: Record<string, number> }[] };
        d.parts[0]!.nextIds.fillet = 1;
        return d;
      },
      'invalid-id',
    ],
  ];

  it.each(cases)('refuses %s', (_label, input, code, message) => {
    const text = typeof input === 'string' ? input : JSON.stringify(input());
    const r = deserialize(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(code);
    if (message) expect(r.error.message).toMatch(message);
  });

  it('never modifies the value it is given, even a newer one', () => {
    for (const value of [
      clone(v0Bracket),
      { ...clone(v2Bracket), version: 99 },
      clone(v1Bracket),
      clone(v2Bracket),
    ]) {
      const frozen = deepFreeze(value);
      const snapshot = JSON.stringify(frozen);
      parseDocument(frozen);
      expect(JSON.stringify(frozen)).toBe(snapshot);
    }
  });

  it('reports schema problems with paths', () => {
    const d = clone(v2Bracket) as { variables: { expression: unknown }[] };
    d.variables[0]!.expression = 6;
    const r = parseDocument(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.path).toEqual(['variables', 0, 'expression']);
      expect(r.error.issues?.length).toBeGreaterThan(0);
    }
  });
});

describe('migrations', () => {
  it('migrates each fixture to exactly the next one, and the oldest to the current fixture', () => {
    expect(migrateV0ToV1.migrate(clone(v0Bracket) as Record<string, unknown>)).toEqual(v1Bracket);
    expect(migrateV1ToV2.migrate(clone(v1Bracket) as Record<string, unknown>)).toEqual(v2Bracket);
    const loaded = unwrap(parseDocument(v0Bracket));
    expect(loaded.from).toEqual({ version: 0, namingScheme: 1 });
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v2Bracket));
    expect(JSON.parse(serialize(loaded.document))).toEqual(v2Bracket);
  });

  it('v1 to v2 changes only the version: a version 1 part has no material', () => {
    const loaded = unwrap(parseDocument(v1Bracket));
    expect(loaded.from.version).toBe(1);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document.parts.every((p) => !('material' in p))).toBe(true);
  });

  it('refuses a material that is not in the built-in table', () => {
    const bad = clone(v2Bracket) as { parts: Record<string, unknown>[] };
    bad.parts[0]!.material = 'unobtainium';
    const r = parseDocument(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema');
  });

  it('v0 to v1 adds the new fields and keeps existing values', () => {
    const v0 = {
      format: 'manufakture',
      version: 0,
      id: 'x',
      parts: [
        {
          id: 'p',
          features: [{ id: 'sketch#1', suppressed: true }, { id: 'sketch#2' }],
          rollbackIndex: 1,
        },
      ],
    };
    expect(migrateV0ToV1.migrate(clone(v0))).toEqual({
      format: 'manufakture',
      version: 1,
      namingScheme: 1,
      id: 'x',
      parts: [
        {
          id: 'p',
          features: [
            { id: 'sketch#1', suppressed: true },
            { id: 'sketch#2', suppressed: false },
          ],
          rollbackIndex: 1,
        },
      ],
    });
  });

  it('migrates every older version, from a fixture of each', () => {
    expect(FORMAT_MIGRATIONS).toHaveLength(FORMAT_VERSION);
    FORMAT_MIGRATIONS.forEach((m, i) => expect([m.from, m.to]).toEqual([i, i + 1]));
    for (let v = 0; v < FORMAT_VERSION; v++) {
      expect(FIXTURES[v], `fixture for version ${v}`).toBeDefined();
      const loaded = unwrap(parseDocument(FIXTURES[v]));
      expect(loaded.from.version).toBe(v);
      expect(loaded.document.version).toBe(FORMAT_VERSION);
    }
  });

  // A made-up chain, to exercise the mechanism beyond the one real migration.
  const step = (
    from: number,
    change: (d: Record<string, unknown>) => void = () => {},
  ): Migration => ({
    from,
    to: from + 1,
    description: `step ${from}`,
    migrate: (d) => {
      change(d);
      return { ...d, version: from + 1, trail: [...((d.trail as number[]) ?? []), from] };
    },
  });
  const doc = (version: number) => ({ format: 'manufakture', version, namingScheme: 1 });

  it.each([
    [0, [0, 1, 2]],
    [1, [1, 2]],
    [2, [2]],
    [3, undefined],
  ])('applies the chain in order from version %s', (from, trail) => {
    const r = unwrap(
      migrateJson(doc(from), { formatMigrations: [step(0), step(1), step(2)], formatVersion: 3 }),
    );
    expect(r.json.version).toBe(3);
    expect(r.json.trail).toEqual(trail);
    expect(r.from.version).toBe(from);
  });

  it.each<[string, Migration[], RegExp]>([
    ['a gap in the chain', [step(0), step(2)], /No version migration from 1 to 2/],
    ['a missing migration', [step(0)], /No version migration from 1 to 2/],
    [
      'a throwing migration',
      [
        step(0),
        step(1, () => {
          throw new Error('boom');
        }),
      ],
      /from version 1 to 2 failed: boom/,
    ],
    [
      'a migration that forgets the version',
      [step(0), { ...step(1), migrate: (d) => d }],
      /did not produce version 2/,
    ],
  ])('fails with %s', (_label, chain, message) => {
    const r = migrateJson(doc(0), { formatMigrations: chain, formatVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('migration');
      expect(r.error.message).toMatch(message);
    }
  });

  it('runs naming scheme migrations separately from the file format', () => {
    const rename: Migration = {
      from: 1,
      to: 2,
      description: 'rename',
      migrate: (d) => ({ ...d, namingScheme: 2, renamed: true }),
    };
    const r = unwrap(
      migrateJson(doc(1), { formatVersion: 1, namingMigrations: [rename], namingScheme: 2 }),
    );
    expect(r.json).toMatchObject({ version: 1, namingScheme: 2, renamed: true });
    expect(r.from).toEqual({ version: 1, namingScheme: 1 });
    const missing = migrateJson(doc(1), {
      formatVersion: 1,
      namingMigrations: [],
      namingScheme: 2,
    });
    expect(missing.ok).toBe(false);
  });

  it('keeps the stored units of every expression through a load', () => {
    const loaded = load(v1Bracket);
    expect(loaded.units.length).toEqual({ unit: 'ft-in', denominator: 32 });
    expect(loaded.variables.find((v) => v.name === 'thickness')?.expression).toEqual(mm('6mm'));
    expect(loaded.variables.find((v) => v.name === 'lip')?.expression.lengthUnit).toBe('in');
  });
});
