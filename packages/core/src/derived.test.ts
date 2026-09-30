import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from './commands';
import { createDocument } from './document';
import { bodyCreator, featureDependencies, featureExpressions } from './features';
import { deserialize, serialize } from './format';
import type { CoreErrorCode } from './result';
import {
  BodyIdSchema,
  DerivedFeatureSchema,
  DerivedSourceSchema,
  FeatureSchema,
  MAX_BODY_ID_LENGTH,
  MAX_BODY_LIST,
  MAX_DERIVED_BYTES,
  MAX_DERIVED_DEPTH,
  MAX_FACE_NAME_DEPTH,
  MAX_FACE_NAME_LENGTH,
  nameDepth,
  utf8Length,
  type DerivedFeature,
  type DerivedSource,
  type ExtrudeFeature,
  type Feature,
  type FilletFeature,
  type ManufaktureDocument,
  type PatternFeature,
} from './schema';
import { PART, baseExtrude, bracket, clone, mm, rectangleSketch, unwrap } from './test-helpers';
import { bodyCreationProblem, validateDocument } from './validate';

/** The derived feature (format v6): schema, envelope checks, body ids and face-name dependencies. */

const deg = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;
const SHA = 'ab'.repeat(32);

function source(over: Partial<DerivedSource> = {}): DerivedSource {
  const data = serialize(bracket());
  return {
    documentId: 'doc-src',
    documentName: 'Bracket',
    versionId: 'v-1',
    versionName: 'Release 1',
    partId: 'part#1',
    size: utf8Length(data),
    sha256: SHA,
    data,
    ...over,
  };
}

function derived(over: Partial<DerivedFeature> = {}): DerivedFeature {
  return {
    id: 'derived#1',
    kind: 'derived',
    name: 'Derived 1',
    suppressed: false,
    source: source(),
    placement: {
      translation: [mm('0'), mm('10'), mm('0')],
      rotation: [deg('0'), deg('0'), deg('90')],
    },
    operation: 'new',
    ...over,
  };
}

/** A fillet on an edge of the derived body, between two faces named in the source. */
const derivedFillet = (): FilletFeature => ({
  id: 'fillet#1',
  kind: 'fillet',
  name: 'Fillet 1',
  suppressed: false,
  edges: [
    {
      id: 'r1',
      ref: { faces: ['derived#1:from/extrude#1:cap:end', 'derived#1:from/extrude#1:side:e1'] },
    },
  ],
  radius: mm('1'),
});

const add = (feature: Feature): Command => ({ type: 'addFeature', partId: PART, feature });

/** A document with the variables the local sketch and extrude read, then `commands`. */
function build(...commands: Command[]): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-1', name: 'Deriving' });
  const variables: Command[] = [
    { type: 'setVariable', name: 'thickness', expression: mm('6mm') },
    { type: 'setVariable', name: 'width', expression: mm('40') },
    { type: 'setVariable', name: 'height', expression: mm('20') },
  ];
  for (const c of [...variables, ...commands]) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}

function refused(doc: ManufaktureDocument, command: Command): CoreErrorCode {
  const r = applyCommand(doc, command);
  if (r.ok) throw new Error('expected the command to be refused');
  return r.error.code;
}

describe('utf8Length', () => {
  it.each(['', 'abc', 'é', '€', '😀', 'a\u{10FFFF}b', '\uD800', '\uDC00x', 'x\uD83D'])(
    '%j counts what TextEncoder writes',
    (s) => {
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
    },
  );
});

describe('derived source envelope', () => {
  it('accepts a source with and without a configuration row', () => {
    expect(DerivedSourceSchema.safeParse(source()).success).toBe(true);
    const configured = source({ configuration: 'cfg#2' });
    expect(DerivedSourceSchema.parse(configured)).toEqual(configured);
    expect('configuration' in DerivedSourceSchema.parse(source())).toBe(false);
  });

  it.each<[string, Partial<DerivedSource> | Record<string, unknown>]>([
    ['an upper-case hash', { sha256: SHA.toUpperCase() }],
    ['a short hash', { sha256: 'ab' }],
    ['a size that is not the UTF-8 length', { size: utf8Length(source().data) - 1 }],
    ['a size counted in UTF-16 units', { data: 'é', size: 1 }],
    ['empty data', { data: '', size: 1 }],
    ['a size over the limit', { size: MAX_DERIVED_BYTES + 1 }],
    ['a configuration that is not a row id', { configuration: 'row 1' }],
    ['no document id', { documentId: '' }],
    ['no part id', { partId: '' }],
    ['an unknown key', { url: 'https://example.com' }],
  ])('refuses %s', (_, over) => {
    expect(DerivedSourceSchema.safeParse({ ...source(), ...over }).success).toBe(false);
  });

  it('counts multi-byte text in bytes', () => {
    expect(DerivedSourceSchema.safeParse(source({ data: '{"n":"€"}', size: 11 })).success).toBe(
      true,
    );
  });

  it('refuses data longer than the limit before counting it', () => {
    const data = 'x'.repeat(MAX_DERIVED_BYTES + 1);
    const r = DerivedSourceSchema.safeParse(source({ data, size: MAX_DERIVED_BYTES }));
    expect(r.success).toBe(false);
  });

  it('does not open the pinned document: any text of the right size loads', () => {
    expect(DerivedSourceSchema.safeParse(source({ data: 'not json', size: 8 })).success).toBe(true);
    expect(MAX_DERIVED_DEPTH).toBeGreaterThan(1);
  });
});

describe('derived feature schema', () => {
  it('accepts every operation, a scope when it combines, and a list of source bodies', () => {
    for (const operation of ['new', 'add', 'cut', 'intersect'] as const) {
      expect(FeatureSchema.safeParse(derived({ operation })).success).toBe(true);
    }
    expect(
      FeatureSchema.safeParse(derived({ operation: 'cut', scope: ['extrude#1'] })).success,
    ).toBe(true);
    expect(
      FeatureSchema.safeParse(derived({ bodies: ['extrude#1', 'derived#2:from/extrude#1'] }))
        .success,
    ).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a scope on a new feature', { scope: ['extrude#1'] }],
    ['a reference operation', { operation: 'reference' }],
    ['an empty body list', { bodies: [] }],
    ['a source body that is not a body id', { bodies: ['Body 1'] }],
    ['a placement without a rotation', { placement: { translation: [mm('0'), mm('0'), mm('0')] } }],
    [
      'a two-axis translation',
      { placement: { translation: [mm('0'), mm('0')], rotation: [deg('0'), deg('0'), deg('0')] } },
    ],
  ])('refuses %s', (_, over) => {
    expect(DerivedFeatureSchema.safeParse({ ...derived(), ...over }).success).toBe(false);
  });

  it('has placement expressions: lengths for the translation, angles for the rotation', () => {
    expect(featureExpressions(derived()).map((e) => [e.path.join('.'), e.expected])).toEqual([
      ['placement.translation.0', 'length'],
      ['placement.translation.1', 'length'],
      ['placement.translation.2', 'length'],
      ['placement.rotation.0', 'angle'],
      ['placement.rotation.1', 'angle'],
      ['placement.rotation.2', 'angle'],
    ]);
    expect(featureDependencies(derived())).toEqual([]);
  });

  it('round-trips through the file format', () => {
    const doc = build(
      add(derived({ source: source({ configuration: 'cfg#1' }), bodies: ['extrude#1'] })),
    );
    const text = serialize(doc);
    expect(unwrap(deserialize(text)).document).toEqual(doc);
    expect(serialize(unwrap(deserialize(text)).document)).toBe(text);
  });

  it('checks placement expressions like any other', () => {
    const doc = build({ type: 'setVariable', name: 'offset', expression: mm('5') });
    const ok = derived({
      placement: {
        translation: [mm('offset'), mm('0'), mm('0')],
        rotation: [deg('0'), deg('0'), deg('0')],
      },
    });
    expect(applyCommand(doc, add(ok)).ok).toBe(true);
    const unknown = derived({
      placement: {
        translation: [mm('nowhere'), mm('0'), mm('0')],
        rotation: [deg('0'), deg('0'), deg('0')],
      },
    });
    expect(applyCommand(doc, add(unknown)).ok).toBe(false);
  });

  it('refuses a source body listed twice', () => {
    expect(refused(build(), add(derived({ bodies: ['extrude#1', 'extrude#1'] })))).toBe(
      'duplicate',
    );
  });
});

describe('derived body ids', () => {
  it('gives the derived feature as the creator of its bodies', () => {
    expect(bodyCreator('derived#1:from/extrude#1')).toBe('derived#1');
    expect(bodyCreator('derived#1:from/pattern#2:i3/extrude#1')).toBe('derived#1');
    expect(bodyCreator('derived#1:from/derived#4:from/import#1')).toBe('derived#1');
  });

  it('names bodies of a new or add derived feature after their source bodies', () => {
    for (const operation of ['new', 'add'] as const) {
      const f = derived({ operation });
      expect(bodyCreationProblem(f, 'derived#1:from/extrude#1')).toBeUndefined();
      expect(bodyCreationProblem(f, 'derived#1')).toMatch(/named after its source body/);
      expect(bodyCreationProblem(f, 'derived#1:from/')).toMatch(/named after its source body/);
      expect(bodyCreationProblem(f, 'derived#1:i2')).toMatch(/named after its source body/);
    }
    expect(bodyCreationProblem(derived({ operation: 'cut' }), 'derived#1:from/extrude#1')).toMatch(
      /"cut" derived feature, which makes no body/,
    );
    const some = derived({ bodies: ['extrude#2'] });
    expect(bodyCreationProblem(some, 'derived#1:from/extrude#2')).toBeUndefined();
    expect(bodyCreationProblem(some, 'derived#1:from/extrude#1')).toMatch(/does not derive/);
  });

  it('accepts derived body ids in body props and scopes', () => {
    const cut: ExtrudeFeature = {
      ...baseExtrude(),
      id: 'extrude#1',
      operation: 'cut',
      extent: { type: 'throughAll' },
      scope: ['derived#1:from/extrude#1'],
    };
    const doc = build(add(derived()), add(rectangleSketch()), add(cut), {
      type: 'setBodyProps',
      partId: PART,
      bodyId: 'derived#1:from/extrude#1',
      props: { name: 'Bracket', material: 'pla' },
    });
    expect(validateDocument(doc)).toEqual([]);
    expect(featureDependencies(cut)).toEqual(['derived#1', 'sketch#1']);
    // The scope makes the derived feature a dependency: it cannot move after the cut.
    expect(
      refused(doc, { type: 'reorderFeature', partId: PART, featureId: 'derived#1', index: 2 }),
    ).toBe('dependency');
  });

  it('refuses a bare derived body id, and one a cut derived feature would make', () => {
    const doc = build(add(derived()));
    const props = (bodyId: string): Command => ({
      type: 'setBodyProps',
      partId: PART,
      bodyId,
      props: { name: 'X' },
    });
    expect(refused(doc, props('derived#1'))).toBe('kind-mismatch');
    const cutDoc = build(add(derived({ operation: 'cut' })));
    expect(refused(cutDoc, props('derived#1:from/extrude#1'))).toBe('kind-mismatch');
  });
});

describe('references into derived bodies', () => {
  it('a fillet on a derived face depends on the derived feature only', () => {
    const fillet = derivedFillet();
    expect(featureDependencies(fillet)).toEqual(['derived#1']);
    // No local extrude#1 exists, and the document is valid.
    const doc = build(add(derived()), add(fillet));
    expect(validateDocument(doc)).toEqual([]);
    expect(doc.parts[0]!.features.map((f) => f.id)).toEqual(['derived#1', 'fillet#1']);
    // Deleting the derived feature is blocked by the fillet.
    expect(refused(doc, { type: 'deleteFeature', partId: PART, featureId: 'derived#1' })).toBe(
      'dependency',
    );
  });

  it('a local extrude#1 after that fillet is no dependency of it', () => {
    const doc = build(
      add(derived()),
      add(derivedFillet()),
      add(rectangleSketch()),
      add(baseExtrude()),
    );
    expect(doc.parts[0]!.features.map((f) => f.id)).toEqual([
      'derived#1',
      'fillet#1',
      'sketch#1',
      'extrude#1',
    ]);
    expect(validateDocument(doc)).toEqual([]);
    // Deleting the local extrude#1 is not blocked by the fillet.
    const deleted = unwrap(
      applyCommand(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#1' }),
    ).document;
    expect(deleted.parts[0]!.features.map((f) => f.id)).toEqual([
      'derived#1',
      'fillet#1',
      'sketch#1',
    ]);
    // Neither is moving the fillet after it, nor the local sketch and extrude before the fillet.
    const after = unwrap(
      applyCommand(doc, { type: 'reorderFeature', partId: PART, featureId: 'fillet#1', index: 3 }),
    ).document;
    expect(after.parts[0]!.features.map((f) => f.id)).toEqual([
      'derived#1',
      'sketch#1',
      'extrude#1',
      'fillet#1',
    ]);
    let before = unwrap(
      applyCommand(doc, { type: 'reorderFeature', partId: PART, featureId: 'sketch#1', index: 0 }),
    ).document;
    before = unwrap(
      applyCommand(before, {
        type: 'reorderFeature',
        partId: PART,
        featureId: 'extrude#1',
        index: 1,
      }),
    ).document;
    expect(before.parts[0]!.features.map((f) => f.id)).toEqual([
      'sketch#1',
      'extrude#1',
      'derived#1',
      'fillet#1',
    ]);
  });
});

describe('body pattern mode', () => {
  const bodyPattern = (over: Partial<PatternFeature> = {}): PatternFeature => ({
    id: 'pattern#1',
    kind: 'pattern',
    name: 'Pattern 1',
    suppressed: false,
    features: [],
    body: true,
    layout: {
      type: 'linear',
      direction: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
      count: mm('3'),
      spacing: mm('30'),
    },
    ...over,
  });

  it('accepts new and add on a pattern or mirror of bodies, and nothing on one of features', () => {
    for (const mode of ['new', 'add'] as const) {
      expect(FeatureSchema.parse(bodyPattern({ mode }))).toEqual(bodyPattern({ mode }));
      const mirror = {
        id: 'mirror#1',
        kind: 'mirror',
        name: 'Mirror 1',
        suppressed: false,
        features: [],
        body: true,
        mode,
        plane: { id: 'r1', ref: { face: 'extrude#1:side:e1' } },
      };
      expect(FeatureSchema.safeParse(mirror).success).toBe(true);
    }
    expect(FeatureSchema.safeParse(bodyPattern({ mode: 'cut' as 'new' })).success).toBe(false);
    const ofFeatures = bodyPattern({ features: ['extrude#1'], mode: 'new' });
    delete ofFeatures.body;
    const r = FeatureSchema.safeParse(ofFeatures);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(
      'only a pattern or mirror of bodies has a mode',
    );
  });

  it('keeps an absent mode absent, so older documents are unchanged', () => {
    expect('mode' in FeatureSchema.parse(bodyPattern())).toBe(false);
    const doc = build(
      add(rectangleSketch()),
      add(baseExtrude()),
      add(bodyPattern({ mode: 'new' })),
    );
    const text = serialize(doc);
    expect(unwrap(deserialize(text)).document).toEqual(doc);
    expect(clone(doc.parts[0]!.features[2])).toMatchObject({ mode: 'new' });
  });
});

describe('face name limits', () => {
  const withEdgeName = (name: string) => {
    const doc = clone(unwrap(deserialize(serialize(bracket()))).document) as unknown as {
      parts: { features: { kind: string; edges?: { ref: { faces: string[] } }[] }[] }[];
    };
    const fillet = doc.parts[0]!.features.find((f) => f.kind === 'fillet')!;
    fillet.edges![0]!.ref.faces = [name, 'extrude#1:side:e2'];
    return JSON.stringify(doc);
  };

  it('keeps the bracket loading, with a long realistic name', () => {
    const long = `(${Array.from({ length: 20 }, (_, i) => `extrude#1:side:e${i}#${i}`).join('+')})`;
    expect(long.length).toBeLessThan(MAX_FACE_NAME_LENGTH);
    expect(deserialize(withEdgeName(long)).ok).toBe(true);
    expect(deserialize(withEdgeName(`${'('.repeat(MAX_FACE_NAME_DEPTH)}extrude#1:a`)).ok).toBe(
      true,
    );
  });

  it.each<[string, string]>([
    ['an over-long name', `extrude#1:${'x'.repeat(MAX_FACE_NAME_LENGTH)}`],
    ['a million characters', 'extrude#1:'.padEnd(1_000_000, '(')],
    ['brackets nested too deep', `${'('.repeat(MAX_FACE_NAME_DEPTH + 1)}extrude#1:a`],
    ['8,000 unclosed brackets', '('.repeat(8000)],
  ])('refuses %s as a schema problem, without throwing', (_, name) => {
    const r = deserialize(withEdgeName(name));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema');
  });

  it('counts bracket depth with unclosed and stray brackets', () => {
    expect(nameDepth('(a+(b))')).toBe(2);
    expect(nameDepth('))(((')).toBe(3);
    expect(nameDepth('extrude#1:cap:end')).toBe(0);
  });
});

describe('body id limits', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `extrude#${i + 1}`);

  it('refuses an over-long body id and over-long body lists as schema problems', () => {
    const long = `derived#1:from/${'x'.repeat(MAX_BODY_ID_LENGTH)}`;
    expect(BodyIdSchema.safeParse(long).success).toBe(false);
    expect(BodyIdSchema.safeParse(long.slice(0, MAX_BODY_ID_LENGTH)).success).toBe(true);
    expect(DerivedFeatureSchema.safeParse(derived({ bodies: ids(MAX_BODY_LIST) })).success).toBe(
      true,
    );
    expect(
      DerivedFeatureSchema.safeParse(derived({ bodies: ids(MAX_BODY_LIST + 1) })).success,
    ).toBe(false);
    expect(
      DerivedFeatureSchema.safeParse(derived({ operation: 'cut', scope: ids(MAX_BODY_LIST + 1) }))
        .success,
    ).toBe(false);
    const doc = JSON.parse(serialize(build())) as { parts: { bodies: unknown[] }[] };
    doc.parts[0]!.bodies = Array.from({ length: MAX_BODY_LIST + 1 }, (_, i) => ({
      id: `extrude#${i + 1}`,
      name: 'B',
    }));
    const r = deserialize(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema');
  });

  it('checks many derived body ids against a long body list in linear time', () => {
    const n = MAX_BODY_LIST;
    const doc = JSON.parse(serialize(build(add(derived({ bodies: ids(n) }))))) as {
      parts: { bodies: unknown[] }[];
    };
    doc.parts[0]!.bodies = ids(n).map((id) => ({ id: `derived#1:from/${id}`, name: 'B' }));
    const start = performance.now();
    const r = deserialize(JSON.stringify(doc));
    expect(r.ok ? [] : r.error.message).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
    // One more id that the list does not hold is still refused.
    doc.parts[0]!.bodies[0] = { id: 'derived#1:from/import#1', name: 'B' };
    const bad = deserialize(JSON.stringify(doc));
    expect(bad.ok ? null : bad.error.message).toMatch(/does not derive the source body "import#1"/);
  });
});
