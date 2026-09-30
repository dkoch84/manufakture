import {
  applyCommand,
  createDocument,
  type Feature,
  type HoleFeature,
  type ManufaktureDocument,
  type SketchFeature,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../model/demo';
import { twoBodyDocument } from '../model/twoBodies.test-fixture';
import {
  addRef,
  applyStandard,
  buildFeature,
  checkExpression,
  formOf,
  lostReferences,
  newForm,
  refFields,
  refLabel,
  removeRef,
  scopeBodies,
  takesScope,
  withScope,
  type ExtrudeForm,
  type FeatureForm,
  type FilletForm,
  type HoleForm,
  type PatternForm,
  type RefItem,
} from './forms';

const PART = 'part#1';
const MM = { length: { unit: 'mm' }, angle: { unit: 'deg' } } as const;

function apply(doc: ManufaktureDocument, feature: Feature): ManufaktureDocument {
  const r = applyCommand(doc, { type: 'addFeature', partId: PART, feature });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

const edge = (a: string, b: string): RefItem => ({
  id: null,
  ref: { faces: [a, b].sort() },
  label: refLabel({ faces: [a, b].sort() }),
});
const face = (name: string): RefItem => ({ id: null, ref: { face: name }, label: name });

function build(
  doc: ManufaktureDocument,
  form: Parameters<typeof buildFeature>[0],
  existing?: Feature,
) {
  return buildFeature(form, existing ? { doc, partId: PART, existing } : { doc, partId: PART });
}

/** A document whose only feature is a rectangle sketch with a point in it. */
function sketchOnly(): ManufaktureDocument {
  const sketch: SketchFeature = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [
      { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [10, 0] },
      { id: 'e2', kind: 'line', construction: false, start: [10, 0], end: [10, 5] },
      { id: 'e3', kind: 'line', construction: false, start: [10, 5], end: [0, 5] },
      { id: 'e4', kind: 'line', construction: false, start: [0, 5], end: [0, 0] },
      { id: 'e5', kind: 'point', construction: false, position: [5, 2] },
    ],
    constraints: [],
  };
  return apply(createDocument({ id: 'd', name: 'D' }), sketch);
}

describe('numeric fields', () => {
  it('evaluate expressions with units and variables, in the kind the field holds', () => {
    const vars = { t: { value: 5, dimension: { length: 1, angle: 0 } } };
    expect(checkExpression('2*#t + 1', 'length', MM, vars)).toEqual({
      ok: true,
      value: 11,
      expression: { source: '2*#t + 1', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    expect(checkExpression('1/4"', 'length', MM, {})).toMatchObject({ ok: true, value: 6.35 });
    expect(checkExpression('30deg', 'length', MM, {})).toMatchObject({ ok: false });
    expect(checkExpression('90', 'angle', MM, {})).toMatchObject({ value: Math.PI / 2 });
    expect(checkExpression('#nope', 'length', MM, {})).toMatchObject({ ok: false });
    expect(checkExpression(' ', 'length', MM, {})).toEqual({
      ok: false,
      message: 'Enter a value.',
    });
    expect(checkExpression('0', 'length', MM, {}, { positive: true })).toMatchObject({ ok: false });
    expect(checkExpression('2.5', 'number', MM, {}, { integer: true })).toMatchObject({
      ok: false,
    });
    // Under inch display units a bare number is inches, and is stored so.
    const inch = { length: { unit: 'in' }, angle: { unit: 'deg' } } as const;
    expect(checkExpression('2', 'length', inch, {})).toMatchObject({
      value: 50.8,
      expression: { lengthUnit: 'in' },
    });
  });
});

describe('extrude', () => {
  it('starts on the selected sketch, as a new body when there is none yet', () => {
    const doc = sketchOnly();
    const form = newForm('extrude', { doc, partId: PART, selectedFeatures: ['sketch#1'] });
    expect(form).toMatchObject({ kind: 'extrude', sketch: 'sketch#1', operation: 'new' });
    const r = build(doc, { ...(form as ExtrudeForm), distance: '12' });
    expect(r).toMatchObject({
      ok: true,
      label: 'Add Extrude 1',
      command: { type: 'addFeature', partId: PART },
      feature: {
        id: 'extrude#1',
        name: 'Extrude 1',
        profile: { sketch: 'sketch#1' },
        operation: 'new',
        extent: { type: 'blind', distance: { source: '12' } },
        reverse: false,
      },
    });
    if (!r.ok) throw new Error();
    expect(applyCommand(doc, r.command).ok).toBe(true);
    // With a body before it, a new extrusion adds to it.
    expect(newForm('extrude', { doc: demoDocument(), partId: PART })).toMatchObject({
      operation: 'add',
      sketch: 'sketch#2',
    });
  });

  it('reports each bad field, and needs a face for up-to-face', () => {
    const doc = sketchOnly();
    const form = newForm('extrude', { doc, partId: PART }) as ExtrudeForm;
    expect(build(doc, { ...form, distance: '5deg', draft: 'x' })).toEqual({
      ok: false,
      errors: {
        distance: expect.stringContaining('length'),
        draft: expect.any(String),
      },
    });
    expect(build(doc, { ...form, sketch: '' })).toMatchObject({
      errors: { sketch: 'Choose a sketch.' },
    });
    expect(
      build(demoDocument(), { ...form, sketch: 'sketch#2', extent: 'upToFace' }),
    ).toMatchObject({
      ok: false,
      errors: { upToFace: expect.any(String) },
    });
    const up = build(demoDocument(), {
      ...form,
      sketch: 'sketch#2',
      extent: 'upToFace',
      upToFace: [face('extrude#1:cap:end')],
      draft: '2',
    });
    // The demo's fillet holds r1 to r12: the next reference id is r13.
    expect(up).toMatchObject({
      ok: true,
      feature: {
        extent: { type: 'upToFace', face: { id: 'r13', ref: { face: 'extrude#1:cap:end' } } },
        draft: { source: '2' },
      },
    });
  });

  it('round-trips an existing extrusion, keeping its profile entities', () => {
    const doc = demoDocument();
    const existing = doc.parts[0]!.features[1]!;
    const form = formOf(existing) as ExtrudeForm;
    expect(form).toMatchObject({ sketch: 'sketch#1', extent: 'blind', distance: '20' });
    const r = build(doc, { ...form, distance: '25', entities: ['e1', 'e2', 'e3', 'e4'] }, existing);
    expect(r).toMatchObject({
      ok: true,
      label: 'Edit Extrude 1',
      command: { type: 'editFeature' },
      feature: {
        id: 'extrude#1',
        extent: { distance: { source: '25' } },
        profile: { entities: ['e1', 'e2', 'e3', 'e4'] },
      },
    });
  });
});

describe('fillet and chamfer', () => {
  it('keep the ids of edges stored before and give new ones fresh ids', () => {
    const doc = demoDocument();
    const existing = doc.parts[0]!.features[2]!;
    const form = formOf(existing) as FilletForm;
    expect(form.edges).toHaveLength(12);
    const fewer = { ...form, edges: form.edges.slice(1, 3), radius: '4' };
    const r = build(doc, fewer, existing);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect((r.feature as { edges: { id: string }[] }).edges.map((e) => e.id)).toEqual(['r2', 'r3']);
    expect(applyCommand(doc, r.command).ok).toBe(true);

    const fresh = newForm('fillet', { doc, partId: PART }) as FilletForm;
    expect(build(doc, fresh)).toMatchObject({ ok: false, errors: { edges: expect.any(String) } });
    const added = build(doc, {
      ...fresh,
      edges: [edge('extrude#2:side:e5', 'extrude#1:cap:end')],
    });
    expect(added).toMatchObject({
      ok: true,
      feature: { id: 'fillet#2', edges: [{ id: 'r13' }], radius: { source: '2' } },
    });
  });

  it('builds equal, two-distance and distance-angle chamfers', () => {
    const doc = demoDocument();
    const form = newForm('chamfer', { doc, partId: PART });
    const e = [edge('extrude#1:cap:end', 'extrude#1:side:e1')];
    if (form.kind !== 'chamfer') throw new Error();
    expect(build(doc, { ...form, edges: e })).toMatchObject({
      ok: true,
      feature: { kind: 'chamfer', distance: { source: '1' } },
    });
    const two = build(doc, { ...form, edges: e, mode: 'two' });
    expect(two.ok && two.feature).toMatchObject({ secondDistance: { source: '2' } });
    expect(two.ok && 'angle' in two.feature).toBe(false);
    const angled = build(doc, { ...form, edges: e, mode: 'angle' });
    expect(angled.ok && angled.feature).toMatchObject({ angle: { source: '45' } });
  });
});

describe('reference fields', () => {
  it('add picks, replace a lost one in place, and hold one where one is the most', () => {
    const doc = demoDocument();
    const existing = doc.parts[0]!.features[2]!;
    const form = formOf(existing, lostReferences([{ code: 'reference-lost', referenceId: 'r2' }]))!;
    const [field] = refFields(form);
    expect(field).toMatchObject({ key: 'edges', accepts: ['edge'] });
    const edges = (form as FilletForm).edges;
    expect(edges[1]).toMatchObject({ id: 'r2', lost: true });
    const replaced = addRef(form, field!, edge('a', 'b')) as FilletForm;
    expect(replaced.edges[1]).toEqual({ ...edge('a', 'b'), id: 'r2' });
    expect(replaced.edges).toHaveLength(12);
    // The same edge twice is one pick.
    expect(addRef(replaced, field!, edge('b', 'a'))).toBe(replaced);
    expect((removeRef(replaced, 'edges', 0) as FilletForm).edges).toHaveLength(11);

    const mirror = newForm('mirror', { doc, partId: PART });
    const [plane] = refFields(mirror);
    const one = addRef(mirror, plane!, face('extrude#1:side:e1'));
    const other = addRef(one, plane!, face('extrude#1:side:e2'));
    expect(refFields(other).length).toBe(1);
    expect(other.kind === 'mirror' && other.plane.map((p) => p.label)).toEqual([
      'extrude#1:side:e2',
    ]);
  });

  it('refuses faces of features that come after the one being edited', () => {
    const doc = demoDocument();
    const fillet = doc.parts[0]!.features[2]!;
    const form = formOf(fillet) as FilletForm;
    const r = build(
      doc,
      { ...form, edges: [edge('extrude#2:side:e5', 'extrude#1:cap:end')] },
      fillet,
    );
    expect(r).toMatchObject({ ok: false, errors: { form: expect.stringContaining('Hole') } });
  });
});

describe('shell, revolve, hole, pattern, mirror', () => {
  it('shells with faces to remove, or none for a closed hollow', () => {
    const doc = demoDocument();
    const form = newForm('shell', { doc, partId: PART });
    if (form.kind !== 'shell') throw new Error();
    expect(build(doc, form)).toMatchObject({
      ok: true,
      feature: { faces: [], thickness: { source: '2' } },
    });
    expect(
      build(doc, { ...form, faces: [face('extrude#1:cap:end')], outward: true }),
    ).toMatchObject({
      ok: true,
      feature: { faces: [{ id: 'r13', ref: { face: 'extrude#1:cap:end' } }], outward: true },
    });
  });

  it('revolves about a line of the sketch or a picked edge', () => {
    const doc = sketchOnly();
    const form = newForm('revolve', { doc, partId: PART });
    expect(form).toMatchObject({ axisType: 'sketchLine', axisLine: 'e1', angle: '360' });
    if (form.kind !== 'revolve') throw new Error();
    expect(build(doc, { ...form, flip: true, angle: '90' })).toMatchObject({
      ok: true,
      feature: { axis: { type: 'sketchLine', entity: 'e1', flip: true }, angle: { source: '90' } },
    });
    expect(build(doc, { ...form, axisLine: 'e5' })).toMatchObject({
      errors: { axisLine: 'Choose a line of the sketch.' },
    });
    expect(build(doc, { ...form, axisType: 'edge' })).toMatchObject({
      errors: { axisEdge: expect.any(String) },
    });
  });

  it('sizes a hole from the standard table, and needs sketch points', () => {
    const doc = apply(sketchOnly(), {
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'blind', distance: { source: '5', lengthUnit: 'mm', angleUnit: 'deg' } },
      reverse: false,
    });
    const form = newForm('hole', { doc, partId: PART, selectedFeatures: ['sketch#1'] }) as HoleForm;
    // ISO 273 medium: M5 is 5.5 mm.
    expect(form).toMatchObject({ standard: 'M5', fit: 'normal', diameter: '5.5', points: ['e5'] });
    const close = applyStandard({ ...form, fit: 'close', head: 'countersink' }, MM);
    expect(close.diameter).toBe('5.3');
    expect(close.headAngle).toBe('90');
    const r = build(doc, { ...close, extent: 'blind', depth: '4' });
    expect(r).toMatchObject({
      ok: true,
      feature: {
        kind: 'hole',
        sketch: 'sketch#1',
        points: ['e5'],
        diameter: { source: '5.3' },
        extent: { type: 'blind', depth: { source: '4' } },
        head: { type: 'countersink', angle: { source: '90' } },
        standard: { size: 'M5', fit: 'close' },
      },
    });
    if (!r.ok) throw new Error();
    expect(applyCommand(doc, r.command).ok).toBe(true);
    const custom = build(doc, { ...form, standard: '', diameter: '7' });
    expect(custom.ok && (custom.feature as HoleFeature).standard).toBeUndefined();
    expect(build(doc, { ...form, points: [] })).toMatchObject({
      errors: { points: 'Choose at least one point.' },
    });
    const noPoints = demoDocument();
    const onDemo = newForm('hole', { doc: noPoints, partId: PART, selectedFeatures: ['sketch#2'] });
    expect(build(noPoints, onDemo)).toMatchObject({
      errors: { points: expect.stringContaining('has no points') },
    });
  });

  it('patterns the selected features along a picked direction, or the whole body', () => {
    const doc = demoDocument();
    const form = newForm('pattern', { doc, partId: PART, selectedFeatures: ['extrude#2'] });
    expect(form).toMatchObject({ source: 'features', features: ['extrude#2'], layout: 'linear' });
    const p = form as PatternForm;
    expect(build(doc, p)).toMatchObject({ errors: { direction: expect.any(String) } });
    const linear = build(doc, {
      ...p,
      direction: [edge('extrude#1:cap:end', 'extrude#1:side:e1')],
      count: '2+1',
    });
    expect(linear).toMatchObject({
      ok: true,
      feature: {
        features: ['extrude#2'],
        layout: { type: 'linear', count: { source: '2+1' }, spacing: { source: '20' } },
      },
    });
    expect(
      build(doc, { ...p, direction: [face('extrude#1:side:e1')], count: '2.5' }),
    ).toMatchObject({
      errors: { count: 'Must be a whole number.' },
    });
    const body = build(doc, {
      ...p,
      source: 'body',
      layout: 'circular',
      direction: [face('extrude#2:side:e5')],
      count: '4',
    });
    expect(body).toMatchObject({
      ok: true,
      feature: { body: true, features: [], layout: { type: 'circular', angle: { source: '360' } } },
    });
    expect(build(doc, { ...p, features: [], direction: [face('x')] })).toMatchObject({
      errors: { features: expect.any(String) },
    });
  });

  it('mirrors about a picked face', () => {
    const doc = demoDocument();
    const form = newForm('mirror', { doc, partId: PART });
    if (form.kind !== 'mirror') throw new Error();
    expect(build(doc, { ...form, plane: [face('extrude#1:side:e2')] })).toMatchObject({
      ok: true,
      feature: { kind: 'mirror', plane: { id: 'r13', ref: { face: 'extrude#1:side:e2' } } },
    });
  });
});

describe('scope', () => {
  const bodies = [
    { bodyId: 'extrude#1', name: 'Base' },
    { bodyId: 'extrude#3', name: 'Lid' },
  ];

  it('is taken by operations on existing bodies only', () => {
    const doc = twoBodyDocument();
    const extrude = newForm('extrude', { doc, partId: PART }) as ExtrudeForm;
    expect(extrude.operation).toBe('add');
    expect(takesScope(extrude)).toBe(true);
    expect(takesScope({ ...extrude, operation: 'new' })).toBe(false);
    expect(takesScope(newForm('hole', { doc, partId: PART }))).toBe(true);
    expect(takesScope(newForm('fillet', { doc, partId: PART }))).toBe(false);
    const pattern = newForm('pattern', { doc, partId: PART }) as PatternForm;
    expect(takesScope(pattern)).toBe(false);
    expect(takesScope({ ...pattern, source: 'body' })).toBe(true);
  });

  it('stores the chosen bodies, none for all of them, and round-trips', () => {
    const doc = twoBodyDocument();
    const all = newForm('extrude', { doc, partId: PART, selectedFeatures: ['sketch#2'] });
    const everyBody = build(doc, all);
    if (!everyBody.ok) throw new Error(JSON.stringify(everyBody.errors));
    expect('scope' in everyBody.feature).toBe(false);

    const one = withScope(all, ['extrude#3']);
    const r = build(doc, one);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect((r.feature as { scope?: string[] }).scope).toEqual(['extrude#3']);
    expect(formOf(r.feature)).toMatchObject({ scope: ['extrude#3'] });
    expect(withScope(one, undefined)).not.toHaveProperty('scope');

    // A new body acts on nothing that exists, so a scope left in the form is not stored.
    const fresh = build(doc, { ...(one as ExtrudeForm), operation: 'new' });
    if (!fresh.ok) throw new Error(JSON.stringify(fresh.errors));
    expect('scope' in fresh.feature).toBe(false);

    const none = build(doc, withScope(all, []));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.scope).toBe('Choose at least one body.');
  });

  it('offers the bodies made before the feature, and keeps ids its scope still names', () => {
    const part = twoBodyDocument().parts[0]!;
    const at = (id: string) => part.features.findIndex((f) => f.id === id);
    expect(scopeBodies(part, part.features.length, bodies).map((b) => b.bodyId)).toEqual([
      'extrude#1',
      'extrude#3',
    ]);
    // Before extrude#3: only the first body exists there.
    expect(scopeBodies(part, at('extrude#3'), bodies).map((b) => b.bodyId)).toEqual(['extrude#1']);
    expect(scopeBodies(part, at('extrude#3'), bodies, ['revolve#9'])).toEqual([
      { bodyId: 'extrude#1', name: 'Base' },
      { bodyId: 'revolve#9', name: 'revolve#9' },
    ]);
  });

  it('keeps the copy mode of a body pattern or mirror through an edit', () => {
    const doc = twoBodyDocument();
    const r = build(doc, {
      ...(newForm('mirror', { doc, partId: PART }) as Extract<FeatureForm, { kind: 'mirror' }>),
      source: 'body',
      features: [],
      plane: [face('extrude#1:side:e1')],
      mode: 'new',
      scope: ['extrude#3'],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.feature).toMatchObject({ body: true, mode: 'new', scope: ['extrude#3'] });
    expect(formOf(r.feature)).toMatchObject({ mode: 'new', scope: ['extrude#3'] });
  });
});
