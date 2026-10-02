import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { createDocument } from './document';
import { deserialize, migrateJson, parseDocument, serialize } from './format';
import {
  FORMAT_MIGRATIONS,
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateV8ToV9,
  migrateV9ToV10,
  migrateV10ToV11,
  type Migration,
} from './migrations';
import type { CoreErrorCode } from './result';
import { FORMAT_VERSION, NAMING_SCHEME, type ManufaktureDocument } from './schema';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';
import v0Bracket from './fixtures/v0-bracket.json';
import v1Bracket from './fixtures/v1-bracket.json';
import v2Bracket from './fixtures/v2-bracket.json';
import v3Bracket from './fixtures/v3-bracket.json';
import v3TwoBodies from './fixtures/v3-two-bodies.json';
import v4Bracket from './fixtures/v4-bracket.json';
import v4TwoBodies from './fixtures/v4-two-bodies.json';
import v5Bracket from './fixtures/v5-bracket.json';
import v6Bracket from './fixtures/v6-bracket.json';
import v7Bracket from './fixtures/v7-bracket.json';
import v8Bracket from './fixtures/v8-bracket.json';
import v9Bracket from './fixtures/v9-bracket.json';
import v10Bracket from './fixtures/v10-bracket.json';
import v11Bracket from './fixtures/v11-bracket.json';

/** One fixture per older file version; `migrates every older version` checks this is complete. */
const FIXTURES: Record<number, unknown> = {
  0: v0Bracket,
  1: v1Bracket,
  2: v2Bracket,
  3: v3Bracket,
  4: v4Bracket,
  5: v5Bracket,
  6: v6Bracket,
  7: v7Bracket,
  8: v8Bracket,
  9: v9Bracket,
  10: v10Bracket,
};

function load(value: unknown): ManufaktureDocument {
  return unwrap(parseDocument(value)).document;
}

describe('serialize and deserialize', () => {
  const documents: [string, () => ManufaktureDocument][] = [
    ['an empty document', () => createDocument({ id: 'd', name: 'Empty' })],
    ['the bracket', bracket],
    ['the current fixture', () => load(v11Bracket)],
    ['the two-body fixture', () => load(v4TwoBodies)],
    [
      'a document with body props and a scope',
      () =>
        unwrap(
          applyCommand(load(v4TwoBodies), {
            type: 'batch',
            commands: [
              {
                type: 'setBodyProps',
                partId: PART,
                bodyId: 'extrude#2',
                props: { name: 'Right', color: '#1f77b4', material: 'oak' },
              },
              { type: 'setBodyProps', partId: PART, bodyId: 'extrude#1', props: { name: 'Left' } },
            ],
          }),
        ).document,
    ],
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
    [
      'a document with an imported STEP file',
      () =>
        unwrap(
          applyCommand(bracket(), {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'import#1',
              kind: 'import',
              name: 'Bracket.step',
              suppressed: false,
              source: {
                format: 'step',
                fileName: 'Bracket.step',
                size: 13,
                sha256: '0'.repeat(64),
                data: 'SVNPLTEwMzAzLTIxOw==',
              },
              operation: 'reference',
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
        '{\n  "format": "manufakture",\n  "version": 11,\n  "namingScheme": 1,',
      ),
    ).toBe(true);
  });

  it('refuses to serialize an invalid document', () => {
    const doc = clone(bracket()) as unknown as { version: number };
    doc.version = 12;
    expect(() => serialize(doc as unknown as ManufaktureDocument)).toThrow(/Cannot serialize/);
  });
});

describe('loading errors', () => {
  const current = () => clone(v11Bracket) as Record<string, unknown>;
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
      { ...clone(v11Bracket), version: 99 },
      clone(v1Bracket),
      clone(v3Bracket),
      clone(v4Bracket),
      clone(v5Bracket),
      clone(v6Bracket),
      clone(v7Bracket),
      clone(v8Bracket),
      clone(v9Bracket),
      clone(v10Bracket),
      clone(v11Bracket),
    ]) {
      const frozen = deepFreeze(value);
      const snapshot = JSON.stringify(frozen);
      parseDocument(frozen);
      expect(JSON.stringify(frozen)).toBe(snapshot);
    }
  });

  it('reports schema problems with paths', () => {
    const d = clone(v11Bracket) as { variables: { expression: unknown }[] };
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
    expect(migrateV2ToV3.migrate(clone(v2Bracket) as Record<string, unknown>)).toEqual(v3Bracket);
    expect(migrateV3ToV4.migrate(clone(v3Bracket) as Record<string, unknown>)).toEqual(v4Bracket);
    expect(migrateV4ToV5.migrate(clone(v4Bracket) as Record<string, unknown>)).toEqual(v5Bracket);
    expect(migrateV5ToV6.migrate(clone(v5Bracket) as Record<string, unknown>)).toEqual(v6Bracket);
    expect(migrateV6ToV7.migrate(clone(v6Bracket) as Record<string, unknown>)).toEqual(v7Bracket);
    expect(migrateV7ToV8.migrate(clone(v7Bracket) as Record<string, unknown>)).toEqual(v8Bracket);
    expect(migrateV8ToV9.migrate(clone(v8Bracket) as Record<string, unknown>)).toEqual(v9Bracket);
    expect(migrateV9ToV10.migrate(clone(v9Bracket) as Record<string, unknown>)).toEqual(v10Bracket);
    expect(migrateV10ToV11.migrate(clone(v10Bracket) as Record<string, unknown>)).toEqual(
      v11Bracket,
    );
    const loaded = unwrap(parseDocument(v0Bracket));
    expect(loaded.from).toEqual({ version: 0, namingScheme: 1 });
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v11Bracket));
    expect(JSON.parse(serialize(loaded.document))).toEqual(v11Bracket);
  });

  it('v1 to v2 changes only the version: a version 1 part has no material', () => {
    const loaded = unwrap(parseDocument(v1Bracket));
    expect(loaded.from.version).toBe(1);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document.parts.every((p) => !('material' in p))).toBe(true);
  });

  it('v2 to v3 changes only the version: a version 2 part has no imports', () => {
    const loaded = unwrap(parseDocument(v2Bracket));
    expect(loaded.from.version).toBe(2);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document.version).toBe(FORMAT_VERSION);
    expect(loaded.document.parts.flatMap((p) => p.features).some((f) => f.kind === 'import')).toBe(
      false,
    );
    expect(migrateV2ToV3.migrate(clone(v2Bracket) as Record<string, unknown>)).toEqual({
      ...clone(v2Bracket),
      version: 3,
    });
  });

  it('v3 to v4 adds empty body props and the part counter, and changes no feature', () => {
    const migrated = migrateV3ToV4.migrate(clone(v3Bracket) as Record<string, unknown>);
    expect(migrated.parts).toEqual(
      (v3Bracket.parts as Record<string, unknown>[]).map((p) => ({ ...p, bodies: [] })),
    );
    expect(migrated.nextIds).toEqual({ part: 2 });
    const loaded = unwrap(parseDocument(v3Bracket));
    expect(loaded.from.version).toBe(3);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v4Bracket));
  });

  it('v3 to v4 keeps a compound of two new solids as it was, with no scope', () => {
    expect(migrateV3ToV4.migrate(clone(v3TwoBodies) as Record<string, unknown>)).toEqual(
      v4TwoBodies,
    );
    const doc = unwrap(parseDocument(v3TwoBodies)).document;
    expect(doc).toEqual(load(v4TwoBodies));
    expect(doc.version).toBe(FORMAT_VERSION);
    // The counter starts past the highest part number, not past the part count.
    expect(doc.nextIds).toEqual({ part: 4 });
    expect(doc.parts.map((p) => p.bodies)).toEqual([[], []]);
    expect(doc.parts[0]!.features.some((f) => 'scope' in f)).toBe(false);
    expect(doc.parts[0]!.material).toBe('pla');
    expect(JSON.parse(serialize(doc))).toEqual({
      ...v4TwoBodies,
      version: FORMAT_VERSION,
      assemblies: [],
      print: { setups: [], nextIds: {} },
      fonts: [],
    });
  });

  it('v3 to v4 starts the part counter at 1 when no part id is numbered', () => {
    const v3 = { ...clone(v3Bracket), parts: [{ ...clone(v3Bracket).parts[0], id: 'main' }] };
    const migrated = migrateV3ToV4.migrate(v3 as Record<string, unknown>);
    expect(migrated.nextIds).toEqual({ part: 1 });
    expect(unwrap(parseDocument(v3)).document.parts[0]!.id).toBe('main');
  });

  it('v4 to v5 changes only the version: a version 4 document has no configuration table', () => {
    expect(migrateV4ToV5.migrate(clone(v4Bracket) as Record<string, unknown>)).toEqual({
      ...clone(v4Bracket),
      version: 5,
    });
    const loaded = unwrap(parseDocument(v4Bracket));
    expect(loaded.from.version).toBe(4);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v5Bracket));
    expect('configurations' in loaded.document).toBe(false);
    const twoBodies = unwrap(parseDocument(v4TwoBodies)).document;
    expect(twoBodies.version).toBe(FORMAT_VERSION);
    expect(twoBodies.nextIds).toEqual({ part: 4 });
  });

  it('v5 to v6 changes only the version: a version 5 document has no derived feature', () => {
    expect(migrateV5ToV6.migrate(clone(v5Bracket) as Record<string, unknown>)).toEqual({
      ...clone(v5Bracket),
      version: 6,
    });
    const loaded = unwrap(parseDocument(v5Bracket));
    expect(loaded.from.version).toBe(5);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v6Bracket));
    const features = loaded.document.parts.flatMap((p) => p.features);
    expect(features.some((f) => f.kind === 'derived' || 'mode' in f)).toBe(false);
  });

  it('v6 to v7 adds an empty assembly list after the parts, and changes nothing else', () => {
    const migrated = migrateV6ToV7.migrate(clone(v6Bracket) as Record<string, unknown>);
    expect(migrated).toEqual({ ...clone(v6Bracket), version: 7, assemblies: [] });
    const keys = Object.keys(migrated);
    expect(keys.indexOf('assemblies')).toBe(keys.indexOf('parts') + 1);
    const loaded = unwrap(parseDocument(v6Bracket));
    expect(loaded.from.version).toBe(6);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v7Bracket));
    expect(loaded.document.assemblies).toEqual([]);
    expect(loaded.document.nextIds).toEqual({ part: 2 });
    expect(serialize(loaded.document)).toBe(serialize(load(v7Bracket)));
  });

  it('v6 to v7 replaces an assemblies key a version 6 file cannot have had', () => {
    const odd = { ...clone(v6Bracket), assemblies: 'junk' } as Record<string, unknown>;
    expect(migrateV6ToV7.migrate(odd).assemblies).toEqual([]);
    const noParts = { format: 'manufakture', version: 6 } as Record<string, unknown>;
    expect(migrateV6ToV7.migrate(noParts)).toEqual({
      format: 'manufakture',
      version: 7,
      assemblies: [],
    });
  });

  it('v7 to v8 adds an empty print section after the assemblies, and changes nothing else', () => {
    const migrated = migrateV7ToV8.migrate(clone(v7Bracket) as Record<string, unknown>);
    expect(migrated).toEqual({
      ...clone(v7Bracket),
      version: 8,
      print: { setups: [], nextIds: {} },
    });
    const keys = Object.keys(migrated);
    expect(keys.indexOf('print')).toBe(keys.indexOf('assemblies') + 1);
    const loaded = unwrap(parseDocument(v7Bracket));
    expect(loaded.from.version).toBe(7);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v8Bracket));
    expect(loaded.document.print).toEqual({ setups: [], nextIds: {} });
    expect(serialize(loaded.document)).toBe(serialize(load(v8Bracket)));
  });

  it('v7 to v8 replaces a print key a version 7 file cannot have had', () => {
    const odd = { ...clone(v7Bracket), print: 'junk' } as Record<string, unknown>;
    expect(migrateV7ToV8.migrate(odd).print).toEqual({ setups: [], nextIds: {} });
    const noAssemblies = { format: 'manufakture', version: 7 } as Record<string, unknown>;
    expect(migrateV7ToV8.migrate(noAssemblies)).toEqual({
      format: 'manufakture',
      version: 8,
      print: { setups: [], nextIds: {} },
    });
  });

  it('v8 to v9 adds an empty font list after the print section, and changes nothing else', () => {
    const migrated = migrateV8ToV9.migrate(clone(v8Bracket) as Record<string, unknown>);
    expect(migrated).toEqual({ ...clone(v8Bracket), version: 9, fonts: [] });
    const keys = Object.keys(migrated);
    expect(keys.indexOf('fonts')).toBe(keys.indexOf('print') + 1);
    const loaded = unwrap(parseDocument(v8Bracket));
    expect(loaded.from.version).toBe(8);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v9Bracket));
    expect(loaded.document.fonts).toEqual([]);
    expect(serialize(loaded.document)).toBe(serialize(load(v9Bracket)));
  });

  it('v8 to v9 replaces a fonts key a version 8 file cannot have had', () => {
    const odd = { ...clone(v8Bracket), fonts: 'junk' } as Record<string, unknown>;
    expect(migrateV8ToV9.migrate(odd).fonts).toEqual([]);
    const noPrint = { format: 'manufakture', version: 8 } as Record<string, unknown>;
    expect(migrateV8ToV9.migrate(noPrint)).toEqual({
      format: 'manufakture',
      version: 9,
      fonts: [],
    });
  });

  it('v9 to v10 changes only the version: a version 9 file has no threads', () => {
    expect(migrateV9ToV10.migrate(clone(v9Bracket) as Record<string, unknown>)).toEqual({
      ...clone(v9Bracket),
      version: 10,
    });
    const loaded = unwrap(parseDocument(v9Bracket));
    expect(loaded.from.version).toBe(9);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v11Bracket));
    expect(serialize(loaded.document)).toBe(serialize(load(v11Bracket)));
  });

  it('v10 to v11 changes only the version: a version 10 file has no domain data', () => {
    expect(migrateV10ToV11.migrate(clone(v10Bracket) as Record<string, unknown>)).toEqual({
      ...clone(v10Bracket),
      version: 11,
    });
    const loaded = unwrap(parseDocument(v10Bracket));
    expect(loaded.from.version).toBe(10);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual(load(v11Bracket));
    expect('domains' in loaded.document).toBe(false);
    expect(serialize(loaded.document)).toBe(serialize(load(v11Bracket)));
    expect(JSON.parse(serialize(loaded.document))).toEqual(v11Bracket);
  });

  it('v10 to v11 keeps an extension feature as it was, with no operation or scope', () => {
    const v10 = clone(v10Bracket) as { parts: { features: unknown[]; nextIds: object }[] };
    const extension = {
      id: 'extension#1',
      kind: 'extension',
      name: 'Board 1',
      suppressed: false,
      extension: 'wood.board',
      schemaVersion: 1,
      dependsOn: ['sketch#1'],
      references: [],
      expressions: {},
      params: { stock: 'ply-18' },
    };
    v10.parts[0]!.features.push(extension);
    v10.parts[0]!.nextIds = { ...v10.parts[0]!.nextIds, extension: 2 };
    const doc = unwrap(parseDocument(v10)).document;
    expect(doc.version).toBe(FORMAT_VERSION);
    expect(doc.parts[0]!.features.at(-1)).toEqual(extension);
  });

  it('refuses a material that is not in the built-in table', () => {
    const bad = clone(v7Bracket) as { parts: Record<string, unknown>[] };
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
