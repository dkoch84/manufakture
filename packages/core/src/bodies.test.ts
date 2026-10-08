import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { applyCommand, type Command } from './commands';
import { bodyCreator, featureDependencies } from './features';
import { parseDocument } from './format';
import type { CoreErrorCode } from './result';
import {
  BodyPropsSchema,
  FeatureSchema,
  PartSchema,
  type BodyProps,
  type ExtrudeFeature,
  type Feature,
  type ManufaktureDocument,
  type MirrorFeature,
  type PatternFeature,
} from './schema';
import {
  PART,
  baseExtrude,
  bracket,
  clone,
  cornerFillet,
  deepFreeze,
  mm,
  unwrap,
} from './test-helpers';
import { bodyCreationProblem, validateDocument } from './validate';
import v4TwoBodies from './fixtures/v4-two-bodies.json';

/**
 * Bodies in the part (format v4): body props, feature scopes, body ids and the document's part
 * counter.
 */

/** part#1: sketch#1 (two rectangles), extrude#1 and extrude#2, both `new`. */
function twoBodies(): ManufaktureDocument {
  return unwrap(parseDocument(v4TwoBodies)).document;
}

function apply(doc: ManufaktureDocument, command: Command) {
  return applyCommand(doc, command);
}

function applied(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  return unwrap(apply(doc, command)).document;
}

const extrude = (n: number, over: Partial<ExtrudeFeature> = {}): ExtrudeFeature => ({
  ...baseExtrude(),
  id: `extrude#${n}`,
  name: `Extrude ${n}`,
  profile: { sketch: 'sketch#1', entities: ['e1'] },
  extent: { type: 'blind', distance: mm('5') },
  ...over,
});

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

const add = (feature: Feature): Command => ({ type: 'addFeature', partId: PART, feature });
const props = (bodyId: string, p: Omit<BodyProps, 'id'>): Command => ({
  type: 'setBodyProps',
  partId: PART,
  bodyId,
  props: p,
});

describe('schema', () => {
  it.each<[string, unknown]>([
    ['a name', { id: 'extrude#1', name: 'Left' }],
    ['a colour', { id: 'extrude#1', color: '#1f77b4' }],
    ['a material', { id: 'extrude#1', material: 'oak' }],
    ['all three', { id: 'import#2', name: 'Lid', color: '#000000', material: 'pla' }],
    ['an instance body', { id: 'pattern#2:i3', color: '#ffffff' }],
    ['a derived-looking body', { id: 'derived#1:from/pattern#2:i3', name: 'Copy' }],
  ])('accepts body props with %s', (_label, value) => {
    expect(BodyPropsSchema.safeParse(value).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['no setting at all', { id: 'extrude#1' }],
    ['an upper-case colour', { id: 'extrude#1', color: '#1F77B4' }],
    ['a short colour', { id: 'extrude#1', color: '#fff' }],
    ['a named colour', { id: 'extrude#1', color: 'red' }],
    ['an unknown material', { id: 'extrude#1', material: 'unobtainium' }],
    ['an empty name', { id: 'extrude#1', name: '  ' }],
    ['an undefined name', { id: 'extrude#1', name: undefined, color: '#000000' }],
    ['an id that is not a body id', { id: 'Left', name: 'x' }],
    ['an id with an empty suffix', { id: 'pattern#2:', name: 'x' }],
    ['an unknown key', { id: 'extrude#1', name: 'x', visible: false }],
  ])('refuses body props with %s', (_label, value) => {
    expect(BodyPropsSchema.safeParse(value).success).toBe(false);
  });

  it('requires bodies on a part', () => {
    const part = clone(bracket().parts[0]!) as Partial<ManufaktureDocument['parts'][number]>;
    expect(PartSchema.safeParse(part).success).toBe(true);
    delete part.bodies;
    expect(PartSchema.safeParse(part).success).toBe(false);
  });

  const holeFeature = {
    id: 'hole#1',
    kind: 'hole',
    name: 'Hole 1',
    suppressed: false,
    sketch: 'sketch#1',
    points: ['e1'],
    diameter: mm('5'),
    extent: { type: 'throughAll' },
    head: { type: 'simple' },
  };
  const stepImport = (operation: string) => ({
    id: 'import#1',
    kind: 'import',
    name: 'a.step',
    suppressed: false,
    source: { format: 'step', fileName: 'a.step', size: 1, sha256: '0'.repeat(64), data: 'AA==' },
    operation,
  });

  it.each<[string, unknown]>([
    ['a cut extrude', extrude(3, { operation: 'cut', scope: ['extrude#1'] })],
    ['an add extrude', extrude(3, { operation: 'add', scope: ['extrude#1', 'extrude#2'] })],
    ['an intersect extrude', extrude(3, { operation: 'intersect', scope: ['extrude#1'] })],
    [
      'a cut revolve',
      {
        id: 'revolve#1',
        kind: 'revolve',
        name: 'R',
        suppressed: false,
        profile: { sketch: 'sketch#1' },
        axis: { type: 'sketchLine', entity: 'e1' },
        angle: mm('360deg'),
        symmetric: false,
        operation: 'cut',
        scope: ['extrude#1'],
      },
    ],
    ['a hole', { ...holeFeature, scope: ['extrude#2'] }],
    ['an import cut', { ...stepImport('cut'), scope: ['extrude#1'] }],
    ['a body pattern', bodyPattern({ scope: ['extrude#1'] })],
    ['an instance in a scope', extrude(3, { operation: 'cut', scope: ['pattern#1:i2'] })],
  ])('accepts a scope on %s', (_label, value) => {
    expect(FeatureSchema.safeParse(value).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a new extrude', extrude(3, { scope: ['extrude#1'] })],
    ['a reference import', { ...stepImport('reference'), scope: ['extrude#1'] }],
    ['a new import', { ...stepImport('new'), scope: ['extrude#1'] }],
    [
      'a feature pattern',
      bodyPattern({ body: false, features: ['extrude#2'], scope: ['extrude#1'] }),
    ],
    ['an empty scope', extrude(3, { operation: 'cut', scope: [] })],
    ['a scope entry that is not a body id', extrude(3, { operation: 'cut', scope: ['e1'] })],
    ['a fillet', { ...cornerFillet(), scope: ['extrude#1'] }],
  ])('refuses a scope on %s', (_label, value) => {
    const v = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    expect(FeatureSchema.safeParse(v).success).toBe(false);
  });
});

describe('bodyCreator', () => {
  it.each<[string, string | undefined]>([
    ['extrude#3', 'extrude#3'],
    ['import#1', 'import#1'],
    ['pattern#2:i3', 'pattern#2'],
    ['mirror#1:image', 'mirror#1'],
    ['derived#1:from/pattern#2:i3', 'derived#1'],
    ['derived#1:from/extrude#1', 'derived#1'],
    ['Left', undefined],
    ['extrude#0', undefined],
    [':i3', undefined],
  ])('%s -> %s', (id, creator) => {
    expect(bodyCreator(id)).toBe(creator);
  });

  it('makes a feature depend on the creators of its scope, and never on a source name', () => {
    const f = extrude(9, {
      operation: 'cut',
      scope: ['extrude#2', 'pattern#1:i2', 'derived#1:from/extrude#7'],
    });
    expect(featureDependencies(f)).toEqual(['derived#1', 'extrude#2', 'pattern#1', 'sketch#1']);
  });
});

describe('validateDocument: body ids', () => {
  /** twoBodies plus extrude#3 (add), extrude#4 (cut), pattern#1 and mirror#1 of bodies. */
  function many(): ManufaktureDocument {
    const mirror: MirrorFeature = {
      id: 'mirror#1',
      kind: 'mirror',
      name: 'Mirror 1',
      suppressed: false,
      features: [],
      body: true,
      plane: { id: 'r2', ref: { face: 'extrude#1:cap:start' } },
    };
    return unwrap(
      apply(twoBodies(), {
        type: 'batch',
        commands: [
          add(extrude(3, { operation: 'add' })),
          add(extrude(4, { operation: 'cut', scope: ['extrude#1'] })),
          add(bodyPattern()),
          add(mirror),
          add({
            ...cornerFillet(),
            edges: [{ id: 'r3', ref: { faces: ['extrude#1:side:e1', 'extrude#1:side:e2'] } }],
          }),
        ],
      }),
    ).document;
  }

  it('accepts props and scopes on bodies features can make', () => {
    const doc = applied(many(), {
      type: 'batch',
      commands: [
        props('extrude#1', { name: 'Left' }),
        props('extrude#3', { color: '#ff0000' }),
        props('pattern#1:i2', { material: 'oak' }),
        props('mirror#1:image', { name: 'Mirrored' }),
      ],
    });
    expect(validateDocument(doc)).toEqual([]);
  });

  type Mutation = (doc: ManufaktureDocument) => void;
  const part = (d: ManufaktureDocument) => d.parts[0]!;
  const feature = (d: ManufaktureDocument, id: string) =>
    part(d).features.find((f) => f.id === id) as { scope?: string[] };
  const setProps = (d: ManufaktureDocument, id: string) =>
    void (part(d).bodies = [{ id, name: 'x' }]);

  it.each<[string, Mutation, CoreErrorCode, string]>([
    ['props on a fillet', (d) => setProps(d, 'fillet#1'), 'kind-mismatch', 'parts.0.bodies.0.id'],
    ['props on a sketch', (d) => setProps(d, 'sketch#1'), 'kind-mismatch', 'parts.0.bodies.0.id'],
    ['props on a cut', (d) => setProps(d, 'extrude#4'), 'kind-mismatch', 'parts.0.bodies.0.id'],
    [
      'props on a missing feature',
      (d) => setProps(d, 'extrude#9'),
      'dependency',
      'parts.0.bodies.0.id',
    ],
    [
      'props on an extrude with a suffix',
      (d) => setProps(d, 'extrude#1:i2'),
      'kind-mismatch',
      'parts.0.bodies.0.id',
    ],
    [
      'props on a body pattern without an instance',
      (d) => setProps(d, 'pattern#1'),
      'kind-mismatch',
      'parts.0.bodies.0.id',
    ],
    [
      'props on a pattern of a cut',
      (d) => {
        const p = feature(d, 'pattern#1') as PatternFeature;
        p.body = false;
        p.features = ['extrude#4'];
        setProps(d, 'pattern#1:i2');
      },
      'kind-mismatch',
      'parts.0.bodies.0.id',
    ],
    [
      'props on a feature pattern without an instance',
      (d) => {
        const p = feature(d, 'pattern#1') as PatternFeature;
        p.body = false;
        p.features = ['extrude#3'];
        setProps(d, 'pattern#1');
      },
      'kind-mismatch',
      'parts.0.bodies.0.id',
    ],
    [
      'duplicate props',
      (d) =>
        void (part(d).bodies = [
          { id: 'extrude#1', name: 'a' },
          { id: 'extrude#1', color: '#000000' },
        ]),
      'duplicate',
      'parts.0.bodies.1',
    ],
    [
      'a scope naming a missing body',
      (d) => void (feature(d, 'extrude#4').scope = ['extrude#9']),
      'dependency',
      'parts.0.features.4',
    ],
    [
      'a scope naming a cut',
      (d) => void (feature(d, 'extrude#4').scope = ['extrude#4']),
      'kind-mismatch',
      'parts.0.features.4.scope.0',
    ],
    [
      'a scope naming a later body',
      (d) => void (feature(d, 'extrude#4').scope = ['pattern#1:i2']),
      'dependency',
      'parts.0.features.4',
    ],
    [
      'a scope naming the feature itself',
      (d) => {
        const e = feature(d, 'extrude#3') as ExtrudeFeature;
        e.scope = ['extrude#3'];
      },
      'dependency',
      'parts.0.features.3.scope.0',
    ],
    [
      'a scope listing a body twice',
      (d) => void (feature(d, 'extrude#4').scope = ['extrude#1', 'extrude#2', 'extrude#1']),
      'duplicate',
      'parts.0.features.4.scope.2',
    ],
    [
      'a part id that was never allocated',
      (d) => void (d.nextIds.part = 1),
      'invalid-id',
      'parts.0.id',
    ],
  ])('refuses %s', (_label, mutate, code, path) => {
    const doc = clone(many());
    mutate(doc);
    const errors = validateDocument(doc);
    expect(errors.map((e) => [e.code, e.path.join('.')])).toContainEqual([code, path]);
  });

  it('accepts bodies made by patterns and mirrors of features that make bodies', () => {
    // The kernel makes a body of each copy of a `new` feature, and of an `add` copy touching
    // nothing: `pattern#1:i2`, `mirror#1:image`, suffixed by the source when there are several.
    const doc = clone(many());
    const p = feature(doc, 'pattern#1') as PatternFeature;
    p.body = false;
    p.features = ['extrude#3'];
    const m = feature(doc, 'mirror#1') as MirrorFeature;
    m.body = false;
    m.features = ['extrude#4', 'extrude#3'];
    part(doc).bodies = [
      { id: 'pattern#1:i2', name: 'Copy' },
      { id: 'mirror#1:image/extrude#3', color: '#00ff00' },
    ];
    expect(validateDocument(doc)).toEqual([]);
  });

  it('says why a pattern of features makes no body', () => {
    const doc = many();
    const byId = (id: string) => part(doc).features.find((f) => f.id === id);
    const cutPattern: PatternFeature = { ...bodyPattern(), body: false, features: ['extrude#4'] };
    expect(bodyCreationProblem(cutPattern, 'pattern#1:i2', byId)).toMatch(/make no body/);
    const addPattern: PatternFeature = { ...cutPattern, features: ['extrude#4', 'extrude#3'] };
    expect(bodyCreationProblem(addPattern, 'pattern#1:i2/extrude#3', byId)).toBeUndefined();
    // Without a way to look the features up, nothing says they make a body.
    expect(bodyCreationProblem(addPattern, 'pattern#1:i2')).toMatch(/make no body/);
  });

  it('checks allocation only for numbered part ids', () => {
    const doc = clone(bracket());
    doc.parts[0]!.id = 'main';
    doc.nextIds = {};
    expect(validateDocument(doc)).toEqual([]);
  });
});

describe('setBodyProps', () => {
  it('adds, replaces and removes an entry, and undo restores each state', () => {
    const d0 = deepFreeze(twoBodies());
    const a = unwrap(apply(d0, props('extrude#2', { name: 'Right', color: '#00ff00' })));
    expect(a.document.parts[0]!.bodies).toEqual([
      { id: 'extrude#2', name: 'Right', color: '#00ff00' },
    ]);
    expect(applied(a.document, a.inverse)).toEqual(d0);

    const b = unwrap(apply(a.document, props('extrude#1', { material: 'oak' })));
    const c = unwrap(apply(b.document, props('extrude#2', { material: 'petg' })));
    // Replaced in place: props replace the whole entry, they are not merged.
    expect(c.document.parts[0]!.bodies).toEqual([
      { id: 'extrude#2', material: 'petg' },
      { id: 'extrude#1', material: 'oak' },
    ]);
    expect(applied(c.document, c.inverse)).toEqual(b.document);

    const removed = unwrap(apply(c.document, props('extrude#2', {})));
    expect(removed.document.parts[0]!.bodies).toEqual([{ id: 'extrude#1', material: 'oak' }]);
    // Undo puts it back where it was, not at the end.
    expect(applied(removed.document, removed.inverse)).toEqual(c.document);
  });

  it('places a new entry at index', () => {
    const doc = applied(twoBodies(), {
      type: 'batch',
      commands: [
        props('extrude#2', { name: 'b' }),
        { ...props('extrude#1', { name: 'a' }), index: 0 } as Command,
      ],
    });
    expect(doc.parts[0]!.bodies.map((b) => b.id)).toEqual(['extrude#1', 'extrude#2']);
    const bad = apply(twoBodies(), { ...props('extrude#1', { name: 'a' }), index: 3 } as Command);
    expect(!bad.ok && bad.error.code).toBe('invalid-index');
  });

  it('removing an entry that does not exist changes nothing', () => {
    const doc = twoBodies();
    const r = unwrap(apply(doc, props('extrude#1', {})));
    expect(r.document).toEqual(doc);
    expect(diffDocuments(doc, r.document).empty).toBe(true);
  });

  it.each<[string, Command, CoreErrorCode]>([
    ['a body no feature makes', props('sketch#1', { name: 'x' }), 'kind-mismatch'],
    ['a missing feature', props('extrude#9', { name: 'x' }), 'dependency'],
    ['a bad colour', props('extrude#1', { color: 'blue' }), 'schema'],
    [
      'a missing part',
      { ...props('extrude#1', { name: 'x' }), partId: 'part#9' } as Command,
      'not-found',
    ],
  ])('refuses %s', (_label, command, code) => {
    const r = apply(twoBodies(), command);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});

describe('deleteFeature and bodies', () => {
  it('is blocked by props on a body the feature makes, and a batch deletes both', () => {
    const doc = applied(twoBodies(), props('extrude#2', { name: 'Right' }));
    const r = apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('dependency');
      expect(r.error.blockers).toEqual(['extrude#2']);
    }
    const both = unwrap(
      apply(doc, {
        type: 'batch',
        commands: [
          props('extrude#2', {}),
          { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' },
        ],
      }),
    );
    expect(both.document.parts[0]!.bodies).toEqual([]);
    expect(both.document.parts[0]!.features.map((f) => f.id)).toEqual(['sketch#1', 'extrude#1']);
    expect(applied(both.document, both.inverse)).toEqual(doc);
  });

  it('is blocked by a scope naming a body the feature makes', () => {
    const doc = applied(twoBodies(), add(extrude(3, { operation: 'cut', scope: ['extrude#2'] })));
    const r = apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('dependency');
      expect(r.error.blockers).toEqual(['extrude#3']);
    }
    // Reorder respects the scope too.
    const moved = apply(doc, {
      type: 'reorderFeature',
      partId: PART,
      featureId: 'extrude#3',
      index: 1,
    });
    expect(!moved.ok && moved.error.blockers).toEqual(['extrude#2']);
  });

  it('is not blocked by props of another body', () => {
    const doc = applied(twoBodies(), props('extrude#1', { name: 'Left' }));
    expect(apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' }).ok).toBe(
      true,
    );
  });
});

describe('diffDocuments and bodies', () => {
  it('reports a props change without affecting any feature result', () => {
    const doc = twoBodies();
    const next = applied(doc, props('extrude#1', { color: '#123456' }));
    const change = diffDocuments(doc, next);
    expect(change.empty).toBe(false);
    expect(change.parts).toEqual([
      expect.objectContaining({
        partId: PART,
        bodyPropsChanged: true,
        materialChanged: false,
        changed: [],
        firstAffectedIndex: null,
      }),
    ]);
    expect(diffDocuments(next, next).parts).toEqual([]);
  });

  it('reports a scope change as a feature change', () => {
    const doc = applied(twoBodies(), add(extrude(3, { operation: 'cut' })));
    const next = applied(doc, {
      type: 'editFeature',
      partId: PART,
      feature: extrude(3, { operation: 'cut', scope: ['extrude#1'] }),
    });
    const [part] = diffDocuments(doc, next).parts;
    expect(part).toMatchObject({
      changed: ['extrude#3'],
      firstAffectedIndex: 3,
      bodyPropsChanged: false,
    });
  });
});

describe('the document part counter', () => {
  it('never decreases through commands, undo and redo', () => {
    let doc = twoBodies();
    const start = doc.nextIds.part!;
    const inverses: Command[] = [];
    for (const c of [
      props('extrude#1', { name: 'a' }),
      add(extrude(3, { operation: 'cut', scope: ['extrude#1'] })),
      { type: 'renameDocument', name: 'x' } as Command,
    ]) {
      const r = unwrap(apply(doc, c));
      inverses.push(r.inverse);
      doc = r.document;
      expect(doc.nextIds.part).toBe(start);
    }
    for (const inv of inverses.reverse()) {
      doc = applied(doc, inv);
      expect(doc.nextIds.part).toBe(start);
    }
  });

  it('refuses a document whose counter would hand out an existing part id', () => {
    const doc = clone(twoBodies());
    doc.nextIds.part = 3;
    const errors = validateDocument(doc);
    expect(errors).toEqual([
      expect.objectContaining({ code: 'invalid-id', path: ['parts', 1, 'id'] }),
    ]);
  });
});

describe('body groups (format v17)', () => {
  const group = (id: string, name: string, bodies: string[], index?: number): Command => ({
    type: 'setBodyGroup',
    partId: PART,
    group: { id, name, bodies },
    ...(index !== undefined && { index }),
  });
  const del = (groupId: string): Command => ({ type: 'deleteBodyGroup', partId: PART, groupId });

  it('creates, renames, edits members and deletes a group, and undo restores each state', () => {
    const d0 = deepFreeze(twoBodies());
    expect('bodyGroups' in d0.parts[0]!).toBe(false);
    const a = unwrap(apply(d0, group('group#1', 'Frame', ['extrude#1', 'extrude#2'])));
    expect(a.document.parts[0]!.bodyGroups).toEqual([
      { id: 'group#1', name: 'Frame', bodies: ['extrude#1', 'extrude#2'] },
    ]);
    expect(a.document.parts[0]!.nextIds.group).toBe(2);
    expect(a.inverse).toEqual(del('group#1'));
    // Undo of the first group gives back a part with no key at all (counters stay).
    const undone = applied(a.document, a.inverse);
    expect('bodyGroups' in undone.parts[0]!).toBe(false);
    expect(undone.parts[0]!.nextIds.group).toBe(2);

    const renamed = unwrap(apply(a.document, group('group#1', 'Base frame', ['extrude#1'])));
    expect(renamed.document.parts[0]!.bodyGroups).toEqual([
      { id: 'group#1', name: 'Base frame', bodies: ['extrude#1'] },
    ]);
    expect(applied(renamed.document, renamed.inverse)).toEqual(a.document);

    const removed = unwrap(apply(renamed.document, del('group#1')));
    expect('bodyGroups' in removed.document.parts[0]!).toBe(false);
    expect(removed.inverse).toMatchObject({ type: 'restoreBodyGroup', index: 0 });
    expect(applied(removed.document, removed.inverse)).toEqual(renamed.document);
    // Deleting a group leaves the bodies and their props alone.
    expect(removed.document.parts[0]!.features).toEqual(d0.parts[0]!.features);
    expect(removed.document.parts[0]!.bodies).toEqual(d0.parts[0]!.bodies);
  });

  it('places a new group at index, and an undone delete back where it was', () => {
    const doc = applied(twoBodies(), {
      type: 'batch',
      commands: [
        group('group#1', 'B', []),
        group('group#2', 'A', [], 0),
        group('group#3', 'C', []),
      ],
    });
    expect(doc.parts[0]!.bodyGroups!.map((g) => g.id)).toEqual(['group#2', 'group#1', 'group#3']);
    const r = unwrap(apply(doc, del('group#1')));
    expect(applied(r.document, r.inverse)).toEqual(doc);
    const bad = apply(twoBodies(), group('group#1', 'A', [], 1));
    expect(!bad.ok && bad.error.code).toBe('invalid-index');
  });

  it('never reuses a group id, and restores only ids that were allocated', () => {
    const doc = applied(twoBodies(), group('group#1', 'A', []));
    const gone = applied(doc, del('group#1'));
    const reused = apply(gone, group('group#1', 'Again', []));
    expect(!reused.ok && reused.error.code).toBe('id-reused');
    expect(apply(gone, group('group#2', 'Again', [])).ok).toBe(true);
    const never = apply(gone, {
      type: 'restoreBodyGroup',
      partId: PART,
      group: { id: 'group#5', name: 'X', bodies: [] },
      index: 0,
    });
    expect(!never.ok && never.error.code).toBe('invalid-id');
    const twice = apply(doc, {
      type: 'restoreBodyGroup',
      partId: PART,
      group: { id: 'group#1', name: 'X', bodies: [] },
      index: 0,
    });
    expect(!twice.ok && twice.error.code).toBe('duplicate');
  });

  it('keeps a body in one group: a move between groups is a batch of two', () => {
    const doc = applied(twoBodies(), {
      type: 'batch',
      commands: [group('group#1', 'A', ['extrude#1', 'extrude#2']), group('group#2', 'B', [])],
    });
    const twice = apply(doc, group('group#2', 'B', ['extrude#2']));
    expect(twice.ok).toBe(false);
    if (!twice.ok) {
      expect(twice.error.code).toBe('duplicate');
      expect(twice.error.blockers).toEqual(['extrude#2']);
    }
    const moved = unwrap(
      apply(doc, {
        type: 'batch',
        commands: [group('group#1', 'A', ['extrude#1']), group('group#2', 'B', ['extrude#2'])],
      }),
    );
    expect(moved.document.parts[0]!.bodyGroups!.map((g) => g.bodies)).toEqual([
      ['extrude#1'],
      ['extrude#2'],
    ]);
    expect(applied(moved.document, moved.inverse)).toEqual(doc);
  });

  it('does not block deleting a feature whose body is grouped; the member stays listed', () => {
    const doc = applied(twoBodies(), group('group#1', 'A', ['extrude#1', 'extrude#2']));
    const r = unwrap(apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' }));
    expect(r.document.parts[0]!.bodyGroups![0]!.bodies).toEqual(['extrude#1', 'extrude#2']);
    // Undo brings the body back into its group.
    expect(applied(r.document, r.inverse)).toEqual(doc);
  });

  it.each<[string, Command, CoreErrorCode]>([
    ['a bad id', group('grp#1', 'A', []), 'schema'],
    ['an empty name', group('group#1', '  ', []), 'schema'],
    ['a bad body id', group('group#1', 'A', ['not a body']), 'schema'],
    ['a body listed twice', group('group#1', 'A', ['extrude#1', 'extrude#1']), 'duplicate'],
    ['a missing group', del('group#1'), 'not-found'],
    ['a missing part', { ...group('group#1', 'A', []), partId: 'part#9' } as Command, 'not-found'],
  ])('refuses %s', (_label, command, code) => {
    const r = apply(twoBodies(), command);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('changes no feature result', () => {
    const doc = twoBodies();
    const next = applied(doc, group('group#1', 'A', ['extrude#1']));
    const change = diffDocuments(doc, next);
    expect(change.empty).toBe(false);
    expect(change.parts).toEqual([
      expect.objectContaining({ partId: PART, changed: [], firstAffectedIndex: null }),
    ]);
  });

  it('is copied with a duplicated part, ids and all', () => {
    const doc = applied(twoBodies(), group('group#1', 'A', ['extrude#1']));
    const copy = applied(doc, {
      type: 'duplicatePart',
      sourcePartId: PART,
      partId: `part#${doc.nextIds.part}`,
      name: 'Copy',
    });
    expect(copy.parts[1]!.bodyGroups).toEqual(doc.parts[0]!.bodyGroups);
    expect(copy.parts[1]!.nextIds.group).toBe(2);
  });
});
