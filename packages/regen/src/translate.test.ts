import type {
  DerivedFeature,
  Feature,
  HoleFeature,
  ImportFeature,
  PatternFeature,
  RevolveFeature,
  SketchFeature,
} from '@manufakture/core';
import {
  applyFeature,
  type FeatureInput,
  type Kernel,
  type RevolveInput,
  type ShapeId,
} from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { XZ_PLANE, type SketchEntity } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { profileOf, selectRegions, sketchOutcome, type SketchResult } from './sketches';
import { extrude, mm, rectangle } from './test-helpers';
import { referenceIdOf, translateFeature } from './translate';

/** A sketch "solved" as stored, through the real region detection. */
function solved(entities: SketchEntity[], placement = XZ_PLANE): SketchResult {
  const feature: SketchFeature = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 's',
    suppressed: false,
    plane: { type: 'plane', ...placement },
    entities,
    constraints: [],
  };
  const r = sketchOutcome(feature, placement, {
    status: 'solved',
    entities,
    diagnosis: { dof: 0, conflicting: [], redundant: [], partiallyRedundant: [], entities: {} },
    issues: [],
  });
  if (!r.ok) throw new Error('did not solve');
  return r.sketch;
}

const rect = rectangle('sketch#1', { width: '40', depth: '30' }).entities;
const hole: SketchEntity = {
  id: 'e9',
  kind: 'circle',
  construction: false,
  center: [20, 15],
  radius: 5,
};

function translate(
  feature: Feature,
  sketch: SketchResult,
  values: Record<string, number>,
  inputs = new Map<string, FeatureInput>(),
) {
  return translateFeature(feature, {
    values: new Map(Object.entries(values)),
    sketches: new Map([['sketch#1', sketch]]),
    inputs,
  });
}

describe('profiles', () => {
  it('uses every filled region by default, with its holes', () => {
    const s = solved([...rect, hole]);
    const p = profileOf('sketch#1', s, undefined);
    expect(
      p.ok && 'loops' in p.profile && p.profile.loops.map((l) => l.entities.map((e) => e.id)),
    ).toEqual([['e1', 'e2', 'e3', 'e4'], ['e9']]);
  });

  it('picks regions whose outer loop runs along the listed entities', () => {
    const s = solved([...rect, hole]);
    expect(selectRegions(s, ['e1', 'e2', 'e3', 'e4'])).toMatchObject({
      ok: true,
      regions: [{ holes: [{}] }],
    });
    const both = selectRegions(s, ['e1', 'e2', 'e3', 'e4', 'e9']);
    expect(both.ok && both.regions).toHaveLength(2);
    // The rectangle with its hole, and the disk in the hole: two regions.
    const two = profileOf('sketch#1', s, ['e1', 'e2', 'e3', 'e4', 'e9']);
    expect(two.ok && 'regions' in two.profile && two.profile.regions).toEqual([
      { loops: [{ entities: expect.any(Array) }, { entities: expect.any(Array) }] },
      { loops: [{ entities: expect.any(Array) }] },
    ]);
    expect(profileOf('sketch#1', s, ['e9'])).toMatchObject({ ok: true, profile: { loops: [{}] } });
  });

  it('reports listed entities the sketch no longer has as a lost reference', () => {
    expect(profileOf('sketch#1', solved(rect), ['e1', 'e7'])).toMatchObject({
      ok: false,
      error: { code: 'reference-lost', referenceId: 'profile', missing: ['e7'] },
    });
    expect(profileOf('sketch#1', solved([rect[0]!]), undefined)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
  });
});

describe('several regions through the kernel', () => {
  let k: Kernel;

  beforeAll(async () => {
    k = await createNodeKernel();
  }, 60_000);

  const triangle: SketchEntity[] = [
    { id: 't1', kind: 'line', construction: false, start: [60, 0], end: [80, 0] },
    { id: 't2', kind: 'line', construction: false, start: [80, 0], end: [60, 20] },
    { id: 't3', kind: 'line', construction: false, start: [60, 20], end: [60, 0] },
  ];
  const disk: SketchEntity = { ...hole, center: [-20, 15], radius: 5 };

  /** Translate and build `feature` on `sketch`; returns the one body, released by the caller. */
  function build(feature: Feature, sketch: SketchResult) {
    const t = translate(feature, sketch, { 'extent.distance': 5 });
    if (!t.ok) throw new Error(t.errors.map((e) => e.message).join('; '));
    const out = applyFeature(k, [], t.input);
    expect(out.errors).toEqual([]);
    expect(out.bodies).toHaveLength(1);
    const body = out.bodies[0]!;
    return {
      body,
      names: body.names!.faces.map((f) => f.name).sort(),
      props: k.properties(body.shape),
    };
  }

  it("builds three separate regions as one body with every region's faces", () => {
    const r = build(extrude('extrude#1', 'sketch#1', '5'), solved([...rect, disk, ...triangle]));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(3);
      expect(r.props.volume).toBeCloseTo((40 * 30 + Math.PI * 25 + 200) * 5, 6);
      // Caps named after each region's outer loop: the rectangle (e1..e4), the disk (e9), the
      // triangle (t1..t3).
      expect(r.names).toEqual(
        [
          ...['e1', 'e2', 'e3', 'e4', 'e9', 't1', 't2', 't3'].map((e) => `extrude#1:side:${e}`),
          ...['e1', 'e9', 't1'].flatMap((e) => [
            `extrude#1:cap:start:${e}`,
            `extrude#1:cap:end:${e}`,
          ]),
        ].sort(),
      );
    } finally {
      k.release(r.body.shape);
    }
  });

  it('builds a region and the disk in its hole as one solid', () => {
    const r = build(
      {
        ...extrude('extrude#1', 'sketch#1', '5'),
        profile: { sketch: 'sketch#1', entities: ['e1', 'e2', 'e3', 'e4', 'e9'] },
      },
      solved([...rect, hole]),
    );
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(1);
      expect(r.props.volume).toBeCloseTo(40 * 30 * 5, 6);
      expect(r.names.filter((n) => n.includes(':cap:'))).toEqual([
        '(extrude#1:cap:end:e1+extrude#1:cap:end:e9)',
        '(extrude#1:cap:start:e1+extrude#1:cap:start:e9)',
      ]);
    } finally {
      k.release(r.body.shape);
    }
  });
});

describe('bodies', () => {
  const s = solved(rect);
  const values = { 'extent.distance': 5 };

  it('names the body a new or add feature makes, and passes the scope', () => {
    const made = translate(extrude('extrude#2', 'sketch#1', '5', 'add'), s, values);
    expect(made.ok && made.input).toMatchObject({ mode: 'add', body: 'extrude#2' });
    expect(made.ok && 'scope' in made.input).toBe(false);
    const cut = translateFeature(
      { ...extrude('extrude#3', 'sketch#1', '5', 'cut'), scope: ['extrude#1'] },
      {
        values: new Map(Object.entries(values)),
        sketches: new Map([['sketch#1', s]]),
        inputs: new Map(),
        bodies: new Set(['extrude#1', 'extrude#2']),
      },
    );
    expect(cut.ok && cut.input).toMatchObject({ mode: 'subtract', scope: ['extrude#1'] });
    expect(cut.ok && 'body' in cut.input).toBe(false);
  });

  it('loses a scope entry that is not a body at that point', () => {
    const r = translateFeature(
      { ...extrude('extrude#3', 'sketch#1', '5', 'cut'), scope: ['extrude#1', 'extrude#2'] },
      {
        values: new Map(Object.entries(values)),
        sketches: new Map([['sketch#1', s]]),
        inputs: new Map(),
        bodies: new Set(['extrude#1']),
      },
    );
    expect(r).toMatchObject({
      ok: false,
      errors: [{ code: 'reference-lost', referenceId: 'scope', missing: ['extrude#2'] }],
    });
  });
});

describe('revolve axes', () => {
  const axisLine: SketchEntity = {
    id: 'e5',
    kind: 'line',
    construction: true,
    start: [-5, 0],
    end: [-5, 10],
  };
  const revolve = (flip?: boolean, entity = 'e5'): RevolveFeature => ({
    id: 'revolve#1',
    kind: 'revolve',
    name: 'r',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    axis:
      flip === undefined ? { type: 'sketchLine', entity } : { type: 'sketchLine', entity, flip },
    angle: mm('90deg'),
    symmetric: false,
    operation: 'new',
  });

  it('turns a sketch line into a model-space axis, start to end, and honours flip', () => {
    // On XZ (normal -Y), sketch y is world +Z.
    const s = solved([...rect, axisLine]);
    const plain = translate(revolve(), s, { angle: Math.PI / 2 });
    expect(plain.ok && (plain.input as RevolveInput).axis).toEqual({
      origin: [-5, 0, 0],
      direction: [0, 0, 10],
    });
    const flipped = translate(revolve(true), s, { angle: Math.PI / 2 });
    expect(flipped.ok && (flipped.input as RevolveInput).axis).toEqual({
      origin: [-5, 0, 0],
      direction: [-0, -0, -10],
    });
    expect(flipped.ok && flipped.input).toMatchObject({
      kind: 'revolve',
      angle: Math.PI / 2,
      mode: 'new',
    });
  });

  it('reports a missing or non-line axis', () => {
    const s = solved([...rect, axisLine]);
    expect(translate(revolve(false, 'e6'), s, { angle: 1 })).toMatchObject({
      ok: false,
      errors: [{ code: 'reference-lost', referenceId: 'axis', missing: ['e6'] }],
    });
    const withCircle = solved([
      ...rect,
      { ...hole, id: 'e6', construction: true, center: [100, 100] },
    ]);
    expect(translate(revolve(false, 'e6'), withCircle, { angle: 1 })).toMatchObject({
      ok: false,
      errors: [{ code: 'invalid', referenceId: 'axis' }],
    });
  });
});

describe('holes and patterns', () => {
  const holeFeature = (points: string[]): HoleFeature => ({
    id: 'hole#1',
    kind: 'hole',
    name: 'h',
    suppressed: false,
    sketch: 'sketch#1',
    points,
    diameter: mm('5'),
    extent: { type: 'throughAll' },
    head: { type: 'counterbore', diameter: mm('9'), depth: mm('3') },
  });
  const pt: SketchEntity = { id: 'e7', kind: 'point', construction: false, position: [3, 4] };

  it('places holes at the sketch points on the sketch frame', () => {
    const s = solved([...rect, pt]);
    const r = translate(holeFeature(['e7']), s, {
      diameter: 5,
      'head.diameter': 9,
      'head.depth': 3,
    });
    expect(r.ok && r.input).toEqual({
      kind: 'hole',
      id: 'hole#1',
      frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
      points: [{ id: 'e7', at: [3, 4] }],
      diameter: 5,
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: 9, depth: 3 },
    });
    expect(
      translate(holeFeature(['e8']), s, { diameter: 5, 'head.diameter': 9, 'head.depth': 3 }),
    ).toMatchObject({
      ok: false,
      errors: [{ code: 'reference-lost', referenceId: 'points', missing: ['e8'] }],
    });
    expect(
      translate(holeFeature(['e1']), s, { diameter: 5, 'head.diameter': 9, 'head.depth': 3 }),
    ).toMatchObject({
      ok: false,
      errors: [{ code: 'invalid', field: ['points'] }],
    });
  });

  const pattern = (features: string[]): PatternFeature => ({
    id: 'pattern#1',
    kind: 'pattern',
    name: 'p',
    suppressed: false,
    features,
    layout: {
      type: 'circular',
      axis: { id: 'r4', ref: { face: 'extrude#1:side:e9' } },
      flip: true,
      count: mm('6'),
      angle: mm('360deg'),
    },
  });

  it('passes the sources as their own kernel inputs and range-checks the count', () => {
    const s = solved(rect);
    const tool: FeatureInput = {
      kind: 'hole',
      id: 'hole#1',
      frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
      points: [{ id: 'e7', at: [1, 1] }],
      diameter: 2,
      extent: { type: 'throughAll' },
      head: { type: 'simple' },
    };
    const inputs = new Map<string, FeatureInput>([
      ['hole#1', tool],
      ['fillet#1', { kind: 'fillet', id: 'fillet#1', radius: 1, edges: [] }],
    ]);
    const ok = translate(
      pattern(['hole#1']),
      s,
      { 'layout.count': 6, 'layout.angle': 2 * Math.PI },
      inputs,
    );
    expect(ok.ok && ok.input).toEqual({
      kind: 'pattern',
      id: 'pattern#1',
      source: { type: 'features', features: [tool] },
      layout: {
        type: 'circular',
        axis: { ref: { face: 'extrude#1:side:e9' }, flip: true },
        count: 6,
        angle: 2 * Math.PI,
      },
    });
    for (const count of [0, 1001, 2.5]) {
      expect(
        translate(pattern(['hole#1']), s, { 'layout.count': count, 'layout.angle': 1 }, inputs),
      ).toMatchObject({
        ok: false,
        errors: [{ code: 'invalid', field: ['layout', 'count'] }],
      });
    }
    expect(
      translate(pattern(['hole#1']), s, { 'layout.count': 1000, 'layout.angle': 1 }, inputs).ok,
    ).toBe(true);
    expect(
      translate(pattern(['fillet#1']), s, { 'layout.count': 2, 'layout.angle': 1 }, inputs),
    ).toMatchObject({
      ok: false,
      errors: [{ code: 'unsupported' }],
    });
  });

  it('maps kernel field names back to core reference ids', () => {
    expect(referenceIdOf(pattern(['hole#1']), 'axis')).toBe('r4');
    expect(referenceIdOf(pattern(['hole#1']), 'r9')).toBe('r9');
  });
});

describe('imports', () => {
  const source = {
    format: 'step' as const,
    fileName: 'part.step',
    size: 13,
    sha256: '0'.repeat(64),
    data: 'SVNPLTEwMzAzLTIxOw==',
  };
  const stepImport = (operation: ImportFeature['operation']): ImportFeature => ({
    id: 'import#1',
    kind: 'import',
    name: 'part.step',
    suppressed: false,
    source,
    operation,
  });

  it('passes a STEP file that joins the body to the kernel as it is stored, with its mode', () => {
    const s = solved(rect);
    expect(translate(stepImport('cut'), s, {})).toEqual({
      ok: true,
      input: { kind: 'import', id: 'import#1', step: source.data, mode: 'subtract' },
    });
    expect(translate(stepImport('new'), s, {})).toMatchObject({ input: { mode: 'new' } });
  });

  it('refuses to translate a reference import: it is not a kernel feature', () => {
    expect(() => translate(stepImport('reference'), solved(rect), {})).toThrow(
      /not a kernel feature/,
    );
  });

  it('does not repeat a reference body in a pattern', () => {
    const pattern: PatternFeature = {
      id: 'pattern#1',
      kind: 'pattern',
      name: 'p',
      suppressed: false,
      features: ['import#1'],
      layout: {
        type: 'linear',
        direction: { id: 'r1', ref: { faces: ['a', 'b'] } },
        count: mm('2'),
        spacing: mm('10'),
      },
    };
    const r = translateFeature(pattern, {
      values: new Map([
        ['layout.count', 2],
        ['layout.spacing', 10],
      ]),
      sketches: new Map(),
      inputs: new Map(),
      references: new Set(['import#1']),
    });
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'unsupported', field: ['features'] }] });
  });
});

describe('body patterns and derived features', () => {
  const ctx = {
    values: new Map([
      ['layout.count', 3],
      ['layout.spacing', 30],
    ]),
    sketches: new Map(),
    inputs: new Map(),
  };
  const bodyPattern = (mode?: 'new' | 'add'): PatternFeature => ({
    id: 'pattern#1',
    kind: 'pattern',
    name: 'p',
    suppressed: false,
    features: [],
    body: true,
    ...(mode === undefined ? {} : { mode }),
    layout: {
      type: 'linear',
      direction: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
      count: mm('3'),
      spacing: mm('30'),
    },
  });

  it('passes the mode of a body pattern, and none when the document has none', () => {
    expect(translateFeature(bodyPattern(), ctx)).toMatchObject({
      ok: true,
      input: { source: { type: 'body' } },
    });
    const plain = translateFeature(bodyPattern(), ctx);
    expect(plain.ok && plain.input.kind === 'pattern' && 'mode' in plain.input.source).toBe(false);
    for (const mode of ['new', 'add'] as const) {
      expect(translateFeature(bodyPattern(mode), ctx)).toMatchObject({
        ok: true,
        input: { source: { type: 'body', mode } },
      });
    }
    const mirror: Feature = {
      id: 'mirror#1',
      kind: 'mirror',
      name: 'm',
      suppressed: false,
      features: [],
      body: true,
      mode: 'new',
      plane: { id: 'r1', ref: { face: 'extrude#1:side:e1' } },
    };
    expect(translateFeature(mirror, ctx)).toMatchObject({
      ok: true,
      input: { kind: 'mirror', source: { type: 'body', mode: 'new' } },
    });
  });

  it('translates a derived feature into a derive of its source bodies, and fails one without them', () => {
    const derived: DerivedFeature = {
      id: 'derived#1',
      kind: 'derived',
      name: 'd',
      suppressed: false,
      source: {
        documentId: 'doc-src',
        documentName: 'Source',
        versionId: 'v-1',
        versionName: 'One',
        partId: 'part#1',
        size: 2,
        sha256: '0'.repeat(64),
        data: '{}',
      },
      placement: {
        translation: [mm('10'), mm('0'), mm('-5')],
        rotation: [mm('0'), mm('0'), mm('90deg')],
      },
      operation: 'cut',
      scope: ['extrude#1'],
    };
    const values = new Map([
      ['placement.translation.0', 10],
      ['placement.translation.1', 0],
      ['placement.translation.2', -5],
      ['placement.rotation.0', 0],
      ['placement.rotation.1', 0],
      ['placement.rotation.2', Math.PI / 2],
    ]);
    const base = { values, sketches: new Map(), inputs: new Map() };
    expect(translateFeature(derived, base)).toMatchObject({
      ok: false,
      errors: [{ code: 'source', field: ['source'] }],
    });
    const sources = new Map([
      ['derived#1', [{ id: 'extrude#1', shape: 7 as ShapeId, extra: 'dropped' }]],
    ]);
    expect(translateFeature(derived, { ...base, sources })).toEqual({
      ok: true,
      input: {
        kind: 'derive',
        id: 'derived#1',
        sources: [{ id: 'extrude#1', shape: 7 }],
        rotation: [0, 0, Math.PI / 2],
        translation: [10, 0, -5],
        mode: 'subtract',
        scope: ['extrude#1'],
      },
    });
    // A scope naming no body here is lost before anything is sent.
    expect(
      translateFeature(derived, { ...base, sources, bodies: new Set(['extrude#2']) }),
    ).toMatchObject({ ok: false, errors: [{ code: 'reference-lost', referenceId: 'scope' }] });
  });
});
