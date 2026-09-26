import type {
  Feature,
  HoleFeature,
  ImportFeature,
  PatternFeature,
  RevolveFeature,
  SketchFeature,
} from '@manufakture/core';
import type { FeatureInput, RevolveInput } from '@manufakture/kernel';
import { XZ_PLANE, type SketchEntity } from '@manufakture/sketch';
import { describe, expect, it } from 'vitest';
import { profileOf, selectRegions, sketchOutcome, type SketchResult } from './sketches';
import { mm, rectangle } from './test-helpers';
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
    expect(p.ok && p.profile.loops.map((l) => l.entities.map((e) => e.id))).toEqual([
      ['e1', 'e2', 'e3', 'e4'],
      ['e9'],
    ]);
  });

  it('picks regions whose outer loop runs along the listed entities', () => {
    const s = solved([...rect, hole]);
    expect(selectRegions(s, ['e1', 'e2', 'e3', 'e4'])).toMatchObject({
      ok: true,
      regions: [{ holes: [{}] }],
    });
    const both = selectRegions(s, ['e1', 'e2', 'e3', 'e4', 'e9']);
    expect(both.ok && both.regions).toHaveLength(2);
    expect(profileOf('sketch#1', s, ['e1', 'e2', 'e3', 'e4', 'e9'])).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    expect(profileOf('sketch#1', s, ['e9'])).toMatchObject({ ok: true });
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
