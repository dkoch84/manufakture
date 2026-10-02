import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { applyCommand, CommandSchema, type Command } from './commands';
import { featureDependencies } from './features';
import { deserialize, parseDocument, serialize } from './format';
import type { CoreErrorCode } from './result';
import {
  DocumentSchema,
  ExtensionFeatureSchema,
  FeatureSchema,
  MAX_DOMAIN_DATA_DEPTH,
  MAX_DOMAIN_NAMESPACE_LENGTH,
  MAX_DOMAINS,
  type ExtensionFeature,
  type ManufaktureDocument,
} from './schema';
import { DocumentStore } from './store';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';
import { bodyCreationProblem, validateDocument } from './validate';

/**
 * Format v11 (ADR 0013 decisions 3 and 6): extension features that make and change bodies, and
 * the document-level `domains` field.
 */

const board = (over: Partial<ExtensionFeature> = {}): ExtensionFeature => ({
  id: 'extension#1',
  kind: 'extension',
  name: 'Board 1',
  suppressed: false,
  extension: 'wood.board',
  schemaVersion: 1,
  dependsOn: ['sketch#1'],
  references: [],
  expressions: { thickness: mm('18mm') },
  params: { stock: 'ply-18', grain: 'x' },
  ...over,
});

const add = (feature: ExtensionFeature): Command => ({ type: 'addFeature', partId: PART, feature });

function applied(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  return unwrap(applyCommand(doc, command)).document;
}

/** The bracket with `board` appended (as `extension#1`). */
function withBoard(over: Partial<ExtensionFeature> = {}): ManufaktureDocument {
  return applied(bracket(), add(board(over)));
}

function codeOf(doc: ManufaktureDocument, command: Command): CoreErrorCode | undefined {
  const r = applyCommand(doc, command);
  return r.ok ? undefined : r.error.code;
}

describe('extension operation and scope (schema)', () => {
  it.each(['new', 'add', 'cut', 'intersect'] as const)('accepts operation "%s"', (operation) => {
    expect(ExtensionFeatureSchema.safeParse(board({ operation })).success).toBe(true);
  });

  it('accepts an extension with neither, as at version 10', () => {
    expect(FeatureSchema.safeParse(board()).success).toBe(true);
  });

  it('refuses an operation that is not a boolean operation', () => {
    const bad = { ...board(), operation: 'reference' };
    expect(FeatureSchema.safeParse(bad).success).toBe(false);
  });

  it('allows a scope without an operation (a joint changes the bodies it names)', () => {
    expect(FeatureSchema.safeParse(board({ scope: ['extrude#1'] })).success).toBe(true);
  });

  it.each(['add', 'cut', 'intersect'] as const)('allows a scope with "%s"', (operation) => {
    expect(FeatureSchema.safeParse(board({ operation, scope: ['extrude#1'] })).success).toBe(true);
  });

  it('refuses a scope with "new", which acts on no existing body', () => {
    const r = FeatureSchema.safeParse(board({ operation: 'new', scope: ['extrude#1'] }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual(['scope']);
      expect(r.error.issues[0]!.message).toMatch(/"new" operation acts on no existing body/);
    }
  });

  it('refuses an empty scope and a scope entry that is not a body id', () => {
    expect(FeatureSchema.safeParse(board({ scope: [] })).success).toBe(false);
    expect(FeatureSchema.safeParse(board({ scope: ['extrude'] })).success).toBe(false);
  });

  it('counts the creators of the bodies in its scope as dependencies', () => {
    expect(featureDependencies(board({ dependsOn: [], scope: ['extrude#1'] }))).toEqual([
      'extrude#1',
    ]);
  });
});

describe('extension body creators', () => {
  it.each(['new', 'add'] as const)(
    'an extension with "%s" makes bodies under its id, alone or with a key',
    (operation) => {
      const f = board({ operation });
      expect(bodyCreationProblem(f, 'extension#1')).toBeUndefined();
      expect(bodyCreationProblem(f, 'extension#1:layer/sheathing')).toBeUndefined();
      expect(bodyCreationProblem(f, 'extension#1:')).toMatch(/is named "extension#1" or/);
    },
  );

  it.each([
    ['cut', /"cut" extension, which makes no body/],
    ['intersect', /"intersect" extension, which makes no body/],
    [undefined, /extension with no operation, which makes no body/],
  ] as const)('an extension with operation %s makes no body', (operation, message) => {
    const f = board(operation === undefined ? {} : { operation });
    expect(bodyCreationProblem(f, 'extension#1')).toMatch(message);
    expect(bodyCreationProblem(f, 'extension#1:a')).toMatch(message);
  });

  it('its bodies take props, and a later feature may scope them', () => {
    const doc = applied(withBoard({ operation: 'new' }), {
      type: 'batch',
      commands: [
        { type: 'setBodyProps', partId: PART, bodyId: 'extension#1', props: { name: 'Shelf' } },
        {
          type: 'setBodyProps',
          partId: PART,
          bodyId: 'extension#1:edge-band',
          props: { color: '#aa7744' },
        },
        add(
          board({
            id: 'extension#2',
            name: 'Dado 1',
            extension: 'wood.dado',
            dependsOn: [],
            scope: ['extension#1', 'extension#1:edge-band', 'extrude#1'],
          }),
        ),
      ],
    });
    expect(validateDocument(doc)).toEqual([]);
    expect(doc.parts[0]!.bodies.map((b) => b.id)).toEqual(['extension#1', 'extension#1:edge-band']);
    expect(unwrap(deserialize(serialize(doc))).document).toEqual(doc);
  });

  it.each(['cut', 'intersect'] as const)(
    'with "%s" its id is not a body: refused in props and in a scope',
    (operation) => {
      const doc = withBoard({ operation });
      expect(
        codeOf(doc, {
          type: 'setBodyProps',
          partId: PART,
          bodyId: 'extension#1',
          props: { name: 'Shelf' },
        }),
      ).toBe('kind-mismatch');
      expect(
        codeOf(
          doc,
          add(board({ id: 'extension#2', dependsOn: ['extension#1'], scope: ['extension#1'] })),
        ),
      ).toBe('kind-mismatch');
    },
  );

  it('without an operation its id is not a body either', () => {
    const doc = withBoard();
    expect(
      codeOf(doc, { type: 'setBodyProps', partId: PART, bodyId: 'extension#1', props: {} }),
    ).toBeUndefined(); // empty props remove an entry, so nothing is stored or checked
    expect(
      codeOf(doc, {
        type: 'setBodyProps',
        partId: PART,
        bodyId: 'extension#1:a',
        props: { name: 'A' },
      }),
    ).toBe('kind-mismatch');
  });

  it('cannot scope the body it makes itself', () => {
    const doc = bracket();
    expect(codeOf(doc, add(board({ operation: 'add', scope: ['extension#1'] })))).toBe(
      'dependency',
    );
  });

  it('a scope naming a later extension is a dependency error', () => {
    const doc = withBoard({ operation: 'new' });
    const dado = board({ id: 'extension#2', dependsOn: [], scope: ['extension#1'] });
    expect(codeOf(doc, { ...add(dado), index: 5 } as Command)).toBe('dependency');
    expect(codeOf(doc, add(dado))).toBeUndefined();
  });
});

describe('domains (schema)', () => {
  const withDomains = (domains: unknown) => ({ ...clone(bracket()), domains });

  it('is optional: a document without domain data has no key', () => {
    expect('domains' in bracket()).toBe(false);
    expect(DocumentSchema.safeParse(bracket()).success).toBe(true);
  });

  it('accepts any namespace, known or not, with any JSON data', () => {
    const doc = withDomains({
      wood: {
        schemaVersion: 1,
        data: { kerf: { source: '3mm', lengthUnit: 'mm', angleUnit: 'deg' } },
      },
      stock: { schemaVersion: 3, data: [1, 'two', null, { x: false }] },
      'some-future-domain': { schemaVersion: 99, data: null },
      x: { schemaVersion: 1, data: 'text' },
    });
    const loaded = unwrap(parseDocument(doc));
    expect(loaded.document.domains).toEqual(doc.domains);
  });

  it.each([
    ['an upper-case namespace', { Wood: { schemaVersion: 1, data: {} } }],
    ['a dotted namespace', { 'wood.board': { schemaVersion: 1, data: {} } }],
    ['a namespace starting with a digit', { '1wood': { schemaVersion: 1, data: {} } }],
    ['an empty namespace', { '': { schemaVersion: 1, data: {} } }],
    [
      'an over-long namespace',
      { ['a'.repeat(MAX_DOMAIN_NAMESPACE_LENGTH + 1)]: { schemaVersion: 1, data: {} } },
    ],
    ['schemaVersion 0', { wood: { schemaVersion: 0, data: {} } }],
    ['a fractional schemaVersion', { wood: { schemaVersion: 1.5, data: {} } }],
    ['no data', { wood: { schemaVersion: 1 } }],
    ['no schemaVersion', { wood: { data: {} } }],
    [
      'an extra key (no expressions in M4)',
      { wood: { schemaVersion: 1, data: {}, expressions: {} } },
    ],
    ['an array', []],
    ['an empty record (no domain data has no key)', {}],
    ['null', null],
  ])('refuses %s', (_label, domains) => {
    const r = parseDocument(withDomains(domains));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema');
  });

  it('never keeps a __proto__ key: zod drops it, as in every record', () => {
    const domains = JSON.parse(
      '{"__proto__": {"schemaVersion": 1, "data": {}}, "wood": {"schemaVersion": 1, "data": {}}}',
    ) as unknown;
    const doc = unwrap(parseDocument(withDomains(domains))).document;
    expect(Object.keys(doc.domains!)).toEqual(['wood']);
  });

  it('refuses a value JSON cannot hold', () => {
    const doc = withDomains({ wood: { schemaVersion: 1, data: { f: Number.NaN } } });
    expect(DocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('accepts a namespace of the longest length', () => {
    const ns = 'a'.repeat(MAX_DOMAIN_NAMESPACE_LENGTH);
    expect(parseDocument(withDomains({ [ns]: { schemaVersion: 1, data: {} } })).ok).toBe(true);
  });

  const many = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`d${i}`, { schemaVersion: 1, data: null }]),
    );

  it(`refuses more than ${MAX_DOMAINS} entries`, () => {
    expect(parseDocument(withDomains(many(MAX_DOMAINS))).ok).toBe(true);
    expect(parseDocument(withDomains(many(MAX_DOMAINS + 1))).ok).toBe(false);
  });

  it(`refuses a 1001st namespace by setDomainData, and still replaces and removes at the cap`, () => {
    const full = unwrap(parseDocument(withDomains(many(MAX_DOMAINS)))).document;
    const extra: Command = {
      type: 'setDomainData',
      namespace: 'one-more',
      schemaVersion: 1,
      data: 1,
    };
    expect(codeOf(full, extra)).toBe('schema');
    const replaced = unwrap(
      applyCommand(full, { type: 'setDomainData', namespace: 'd7', schemaVersion: 2, data: 'x' }),
    ).document;
    expect(Object.keys(replaced.domains!)).toHaveLength(MAX_DOMAINS);
    expect(replaced.domains!.d7).toEqual({ schemaVersion: 2, data: 'x' });
    expect(() => serialize(replaced)).not.toThrow();
    const removed = unwrap(applyCommand(full, { type: 'setDomainData', namespace: 'd7' })).document;
    expect(unwrap(applyCommand(removed, extra)).document.domains!['one-more']).toEqual({
      schemaVersion: 1,
      data: 1,
    });
  });

  /** `data` nested `levels` deep: `levels` arrays around a number. */
  const nested = (levels: number): unknown => {
    let v: unknown = 0;
    for (let i = 0; i < levels; i++) v = [v];
    return v;
  };

  it(`accepts data nested ${MAX_DOMAIN_DATA_DEPTH} levels and refuses one more`, () => {
    const at = (levels: number) =>
      parseDocument(withDomains({ wood: { schemaVersion: 1, data: nested(levels) } }));
    expect(at(MAX_DOMAIN_DATA_DEPTH).ok).toBe(true);
    const r = at(MAX_DOMAIN_DATA_DEPTH + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema');
    // Objects count like arrays.
    let o: unknown = {};
    for (let i = 1; i <= MAX_DOMAIN_DATA_DEPTH; i++) o = { k: o };
    const deepObject = parseDocument(withDomains({ wood: { schemaVersion: 1, data: o } }));
    expect(deepObject.ok).toBe(false);
    // A command carrying such data is refused too.
    const command = { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: o };
    expect(codeOf(bracket(), command as Command)).toBe('schema');
  });

  it('refuses data deep enough to overflow the stack with a schema error, not a RangeError', () => {
    const depth = 200_000;
    const text = serialize(bracket()).replace(
      /}\s*$/,
      `, "domains": {"wood": {"schemaVersion": 1, "data": ${'['.repeat(depth)}${']'.repeat(depth)}}}}`,
    );
    const fromText = deserialize(text);
    expect(fromText.ok).toBe(false);
    if (!fromText.ok) expect(fromText.error.code).toBe('schema');
    const fromValue = parseDocument(
      withDomains({ wood: { schemaVersion: 1, data: nested(depth) } }),
    );
    expect(fromValue.ok).toBe(false);
    if (!fromValue.ok) expect(fromValue.error.code).toBe('schema');
  });

  it('turns a stack overflow while loading into a schema error', () => {
    // An extension's `params` has no depth limit, so deep enough params overflow zod's
    // recursive JSON check: the RangeError is caught, not thrown.
    const depth = 100_000;
    const text = serialize(withBoard({ params: { deep: 'DEEP' } })).replace(
      '"DEEP"',
      `${'['.repeat(depth)}${']'.repeat(depth)}`,
    );
    const fromText = deserialize(text);
    expect(fromText.ok).toBe(false);
    if (!fromText.ok) expect(fromText.error).toMatchObject({ code: 'schema', path: [] });
    const fromValue = parseDocument(JSON.parse(text));
    expect(fromValue.ok).toBe(false);
    if (!fromValue.ok) expect(fromValue.error.code).toBe('schema');
  });
});

describe('setDomainData', () => {
  const set = (namespace: string, schemaVersion: number, data: unknown): Command =>
    ({ type: 'setDomainData', namespace, schemaVersion, data }) as Command;
  const remove = (namespace: string): Command => ({ type: 'setDomainData', namespace });

  it('adds an entry, and its inverse removes it, leaving no domains key', () => {
    const doc = deepFreeze(bracket());
    const r = unwrap(applyCommand(doc, set('wood', 1, { kerf: 3.2 })));
    expect(r.document.domains).toEqual({ wood: { schemaVersion: 1, data: { kerf: 3.2 } } });
    expect(r.inverse).toEqual(remove('wood'));
    const undone = unwrap(applyCommand(r.document, r.inverse)).document;
    expect(undone).toEqual(doc);
    expect('domains' in undone).toBe(false);
    expect(serialize(undone)).toBe(serialize(doc));
  });

  it('replaces an entry whole, and its inverse puts the old one back', () => {
    const doc = deepFreeze(
      applied(bracket(), {
        type: 'batch',
        commands: [set('wood', 1, { kerf: 3.2, trim: 5 }), set('stock', 2, { overrides: [] })],
      }),
    );
    const r = unwrap(applyCommand(doc, set('wood', 2, { kerf: 3 })));
    expect(r.document.domains).toEqual({
      wood: { schemaVersion: 2, data: { kerf: 3 } },
      stock: { schemaVersion: 2, data: { overrides: [] } },
    });
    expect(r.inverse).toEqual(set('wood', 1, { kerf: 3.2, trim: 5 }));
    expect(unwrap(applyCommand(r.document, r.inverse)).document).toEqual(doc);
  });

  it('removes one entry and keeps the others; its inverse adds it back', () => {
    const doc = deepFreeze(
      applied(bracket(), {
        type: 'batch',
        commands: [set('wood', 1, null), set('stock', 1, ['a'])],
      }),
    );
    const r = unwrap(applyCommand(doc, remove('wood')));
    expect(r.document.domains).toEqual({ stock: { schemaVersion: 1, data: ['a'] } });
    // `null` is data like any other, not an absence.
    expect(r.inverse).toEqual(set('wood', 1, null));
    expect(unwrap(applyCommand(r.document, r.inverse)).document).toEqual(doc);
  });

  it('removing a namespace that has no entry changes nothing', () => {
    const doc = bracket();
    const r = unwrap(applyCommand(doc, remove('wood')));
    expect(r.document).toBe(doc);
    expect(r.inverse).toEqual(remove('wood'));
  });

  it.each<[string, unknown]>([
    ['a bad namespace', { type: 'setDomainData', namespace: 'Wood', schemaVersion: 1, data: {} }],
    [
      'a schemaVersion without data',
      { type: 'setDomainData', namespace: 'wood', schemaVersion: 1 },
    ],
    ['data without a schemaVersion', { type: 'setDomainData', namespace: 'wood', data: {} }],
    ['schemaVersion 0', { type: 'setDomainData', namespace: 'wood', schemaVersion: 0, data: {} }],
    [
      'an extra key',
      { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: {}, expressions: {} },
    ],
  ])('refuses %s', (_label, command) => {
    expect(CommandSchema.safeParse(command).success).toBe(false);
    const r = applyCommand(bracket(), command as Command);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema');
  });

  it('is one undo step in the store, with a domain change event', () => {
    const s = unwrap(DocumentStore.create(bracket()));
    const before = s.document;
    const change = unwrap(s.execute(set('wood', 1, { kerf: 3.2 })));
    expect(change.domainChanged).toEqual(['wood']);
    expect(s.document.domains?.wood).toEqual({ schemaVersion: 1, data: { kerf: 3.2 } });
    const undone = unwrap(s.undo());
    expect(undone.domainChanged).toEqual(['wood']);
    expect(s.document).toEqual(before);
    unwrap(s.redo());
    expect(s.document.domains?.wood?.data).toEqual({ kerf: 3.2 });
  });
});

describe('diffDocuments: domainChanged', () => {
  const base = () =>
    applied(bracket(), {
      type: 'batch',
      commands: [
        { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { kerf: 3, a: [1] } },
        { type: 'setDomainData', namespace: 'stock', schemaVersion: 1, data: {} },
      ],
    });

  it.each<[string, Command, string[]]>([
    [
      'a data change',
      { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { kerf: 4, a: [1] } },
      ['wood'],
    ],
    [
      'a schemaVersion change',
      { type: 'setDomainData', namespace: 'stock', schemaVersion: 2, data: {} },
      ['stock'],
    ],
    [
      'a new namespace',
      { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: 1 },
      ['construction'],
    ],
    ['a removed namespace', { type: 'setDomainData', namespace: 'wood' }, ['wood']],
    [
      'the same data with keys in another order',
      { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { a: [1], kerf: 3 } },
      [],
    ],
  ])('reports %s by namespace, with no part to regenerate', (_label, command, expected) => {
    const prev = base();
    const next = applied(prev, command);
    const change = diffDocuments(prev, next);
    expect(change.domainChanged).toEqual(expected);
    expect(change.parts).toEqual([]);
    expect(change.empty).toBe(expected.length === 0);
  });

  it('lists several namespaces sorted, and none for an unrelated change', () => {
    const prev = bracket();
    const next = base();
    expect(diffDocuments(prev, next).domainChanged).toEqual(['stock', 'wood']);
    expect(diffDocuments(next, prev).domainChanged).toEqual(['stock', 'wood']);
    const renamed = applied(next, { type: 'renameDocument', name: 'Shelf' });
    expect(diffDocuments(next, renamed).domainChanged).toEqual([]);
  });
});

describe('domains in the file', () => {
  it('round trips through serialize and deserialize, with namespaces and data keys sorted', () => {
    const doc = deepFreeze(
      applied(withBoard({ operation: 'new', params: { z: 1, a: { d: 2, c: 3 } } }), {
        type: 'batch',
        commands: [
          {
            type: 'setDomainData',
            namespace: 'wood',
            schemaVersion: 1,
            data: {
              trims: { z: 1, a: 2 },
              kerf: { source: '1/8"', lengthUnit: 'in', angleUnit: 'deg' },
            },
          },
          {
            type: 'setDomainData',
            namespace: 'stock',
            schemaVersion: 2,
            data: [{ id: 'ply-18', thickness: 18.2 }, null],
          },
        ],
      }),
    );
    const text = serialize(doc);
    const loaded = unwrap(deserialize(text));
    expect(loaded.document).toEqual(doc);
    expect(loaded.migrated).toBe(false);
    expect(serialize(loaded.document)).toBe(text);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(json.domains as object)).toEqual(['stock', 'wood']);
    expect(Object.keys((json.domains as { wood: { data: object } }).wood.data)).toEqual([
      'kerf',
      'trims',
    ]);
    expect(
      Object.keys((json.domains as { wood: { data: { trims: object } } }).wood.data.trims),
    ).toEqual(['a', 'z']);
    // After the configuration table and before the counters, as in the schema.
    const keys = Object.keys(json);
    expect(keys.indexOf('domains')).toBe(keys.indexOf('nextIds') - 1);
    const feature = (json.parts as { features: Record<string, unknown>[] }[])[0]!.features.at(-1)!;
    expect(feature.operation).toBe('new');
    expect(Object.keys(feature).slice(-2)).toEqual(['params', 'operation']);
  });

  it('saves the same text whatever order the namespaces were set in', () => {
    const a = applied(bracket(), {
      type: 'batch',
      commands: [
        { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { b: 1, a: 2 } },
        { type: 'setDomainData', namespace: 'stock', schemaVersion: 1, data: {} },
      ],
    });
    const b = applied(bracket(), {
      type: 'batch',
      commands: [
        { type: 'setDomainData', namespace: 'stock', schemaVersion: 1, data: {} },
        { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { a: 2, b: 1 } },
      ],
    });
    expect(serialize(a)).toBe(serialize(b));
  });

  it('keeps an unknown namespace and a newer domain schemaVersion as they are', () => {
    const doc = applied(bracket(), {
      type: 'setDomainData',
      namespace: 'not-shipped',
      schemaVersion: 1000,
      data: { anything: ['goes'] },
    });
    const again = unwrap(deserialize(serialize(doc))).document;
    expect(again.domains).toEqual({
      'not-shipped': { schemaVersion: 1000, data: { anything: ['goes'] } },
    });
  });

  it('carries domains through replaceDocument', () => {
    const doc = bracket();
    const target = applied(doc, {
      type: 'setDomainData',
      namespace: 'wood',
      schemaVersion: 1,
      data: { kerf: 3 },
    });
    const r = unwrap(applyCommand(doc, { type: 'replaceDocument', document: target }));
    expect(r.document.domains).toEqual(target.domains);
    expect(unwrap(applyCommand(r.document, r.inverse)).document).toEqual(doc);
  });
});
