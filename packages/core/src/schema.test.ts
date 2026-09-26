import { describe, expect, it } from 'vitest';
import {
  DIMENSION_KINDS,
  DisplayUnitsSchema,
  FEATURE_KINDS,
  FeatureSchema,
  MAX_PATTERN_COUNT,
  ReferenceSchema,
  SketchConstraintSchema,
  SketchPlaneSchema,
  StoredExpressionSchema,
  type Feature,
} from './schema';
import {
  baseExtrude,
  cornerFillet,
  holeCut,
  holeSketch,
  mm,
  rectangleSketch,
} from './test-helpers';

const common = { name: 'F', suppressed: false } as const;

const holeFeature = () => ({
  id: 'hole#9',
  kind: 'hole' as const,
  ...common,
  sketch: 'sketch#2',
  points: ['e5'],
  diameter: mm('5'),
  extent: { type: 'throughAll' as const },
  head: { type: 'simple' as const },
});

/** One valid example of every feature kind. */
const validFeatures: Feature[] = [
  rectangleSketch(),
  {
    ...rectangleSketch(),
    entities: [
      { id: 'e1', kind: 'arc', construction: false, center: [0, 0], start: [5, 0], end: [0, 5] },
      { id: 'e2', kind: 'point', construction: true, position: [0, 0] },
    ],
    constraints: [
      { id: 'k1', kind: 'coincident', a: { entity: 'e1', at: 'center' }, b: { entity: 'e2' } },
      { id: 'k2', kind: 'radius', entity: 'e1', value: mm('5') },
    ],
  },
  holeSketch(),
  baseExtrude(),
  holeCut(),
  {
    ...baseExtrude(),
    extent: { type: 'symmetric', distance: mm('10') },
  },
  { ...baseExtrude(), draft: mm('3deg') },
  {
    ...baseExtrude(),
    profile: { sketch: 'sketch#1', entities: ['e1', 'e2#a'] },
    extent: { type: 'upToFace', face: { id: 'r9', ref: { face: 'extrude#1:cap:start' } } },
  },
  {
    id: 'revolve#1',
    kind: 'revolve',
    ...common,
    profile: { sketch: 'sketch#1' },
    axis: { type: 'sketchLine', entity: 'e4' },
    angle: mm('360deg'),
    symmetric: false,
    operation: 'add',
  },
  {
    id: 'revolve#2',
    kind: 'revolve',
    ...common,
    profile: { sketch: 'sketch#1' },
    axis: {
      type: 'edge',
      edge: { id: 'r3', ref: { faces: ['a:b', 'c:d'], ends: ['x:y'], ordinal: 2 } },
      flip: true,
    },
    angle: mm('90'),
    symmetric: true,
    operation: 'intersect',
  },
  {
    id: 'revolve#3',
    kind: 'revolve',
    ...common,
    profile: { sketch: 'sketch#1' },
    axis: { type: 'sketchLine', entity: 'e4', flip: true },
    angle: mm('90deg'),
    symmetric: false,
    operation: 'add',
  },
  cornerFillet(),
  {
    id: 'chamfer#1',
    kind: 'chamfer',
    ...common,
    edges: [{ id: 'r4', ref: { faces: ['extrude#1:cap:end|x'] } }],
    distance: mm('1'),
    secondDistance: mm('2'),
  },
  {
    id: 'chamfer#2',
    kind: 'chamfer',
    ...common,
    edges: [{ id: 'r10', ref: { faces: ['extrude#1:cap:end', 'x'] } }],
    distance: mm('1'),
    angle: mm('30deg'),
  },
  {
    id: 'shell#1',
    kind: 'shell',
    ...common,
    faces: [],
    thickness: mm('2'),
    outward: false,
  },
  {
    id: 'hole#1',
    kind: 'hole',
    ...common,
    sketch: 'sketch#2',
    points: ['e5'],
    diameter: mm('5'),
    extent: { type: 'blind', depth: mm('10') },
    head: { type: 'counterbore', diameter: mm('9'), depth: mm('3') },
  },
  {
    id: 'hole#2',
    kind: 'hole',
    ...common,
    sketch: 'sketch#2',
    points: ['e5'],
    diameter: mm('5'),
    extent: { type: 'throughAll' },
    head: { type: 'countersink', diameter: mm('10'), angle: mm('90deg') },
    standard: { size: 'M5', fit: 'normal' },
  },
  {
    id: 'pattern#1',
    kind: 'pattern',
    ...common,
    features: ['extrude#2'],
    layout: {
      type: 'linear',
      direction: { id: 'r5', ref: { faces: ['a:b', 'c:d'] } },
      flip: true,
      count: mm('4'),
      spacing: mm('10'),
    },
  },
  {
    id: 'pattern#2',
    kind: 'pattern',
    ...common,
    features: ['extrude#2'],
    layout: {
      type: 'circular',
      axis: { id: 'r6', ref: { face: 'x:y' } },
      flip: false,
      count: mm('6'),
      angle: mm('360deg'),
    },
  },
  {
    id: 'pattern#3',
    kind: 'pattern',
    ...common,
    features: [],
    body: true,
    layout: {
      type: 'linear',
      direction: { id: 'r11', ref: { face: 'extrude#1:side:e2' } },
      // The largest count; an expression is checked when regen evaluates it.
      count: mm('1000'),
      spacing: mm('50'),
    },
  },
  {
    id: 'pattern#4',
    kind: 'pattern',
    ...common,
    features: ['extrude#2'],
    layout: {
      type: 'circular',
      axis: { id: 'r13', ref: { faces: ['a:b', 'c:d'] } },
      count: mm('holes * 2'),
      angle: mm('90deg'),
    },
  },
  {
    id: 'mirror#2',
    kind: 'mirror',
    ...common,
    features: [],
    body: true,
    plane: { id: 'r12', ref: { face: 'extrude#1:side:e4' } },
  },
  {
    id: 'mirror#1',
    kind: 'mirror',
    ...common,
    features: ['extrude#2', 'fillet#1'],
    plane: { id: 'r7', ref: { face: 'extrude#1:side:e1' } },
  },
  {
    id: 'extension#1',
    kind: 'extension',
    ...common,
    extension: 'print.brim',
    schemaVersion: 1,
    dependsOn: ['extrude#1'],
    references: [{ id: 'r8', ref: { face: 'extrude#1:cap:start' } }],
    expressions: { width: mm('5') },
    params: { pattern: 'mouse-ears', corners: [1, 2], nested: { ok: true, none: null } },
  },
];

describe('FeatureSchema', () => {
  it.each(validFeatures.map((f) => [f.id, f] as const))('accepts %s', (_id, feature) => {
    const r = FeatureSchema.safeParse(feature);
    expect(r.success ? [] : r.error.issues).toEqual([]);
    expect(r.data).toEqual(feature);
  });

  it('has an example of every feature kind', () => {
    expect(new Set(validFeatures.map((f) => f.kind))).toEqual(new Set(FEATURE_KINDS));
  });

  const extrude = baseExtrude();
  type Case = [string, unknown, string];
  const invalid: Case[] = [
    ['unknown kind', { ...extrude, kind: 'loft' }, 'kind'],
    ['missing name', { ...extrude, name: undefined }, 'name'],
    ['blank name', { ...extrude, name: '   ' }, 'name'],
    ['unknown key', { ...extrude, color: 'red' }, ''],
    [
      'number instead of expression',
      { ...extrude, extent: { type: 'blind', distance: 10 } },
      'extent.distance',
    ],
    [
      'expression without units',
      { ...extrude, extent: { type: 'blind', distance: { source: '10' } } },
      'extent.distance.lengthUnit',
    ],
    [
      'fractional format as a bare unit',
      {
        ...extrude,
        extent: { type: 'blind', distance: { source: '1', lengthUnit: 'ft-in', angleUnit: 'deg' } },
      },
      'extent.distance.lengthUnit',
    ],
    ['bad extent type', { ...extrude, extent: { type: 'upTo' } }, 'extent.type'],
    ['feature id without number', { ...extrude, id: 'extrude' }, 'id'],
    ['feature id with zero', { ...extrude, id: 'extrude#0' }, 'id'],
    [
      'profile sketch not a feature id',
      { ...extrude, profile: { sketch: 'e1' } },
      'profile.sketch',
    ],
    [
      'profile entity not an entity id',
      { ...extrude, profile: { sketch: 'sketch#1', entities: ['k1'] } },
      'profile.entities.0',
    ],
    [
      'empty profile entities',
      { ...extrude, profile: { sketch: 'sketch#1', entities: [] } },
      'profile.entities',
    ],
    ['bad operation', { ...extrude, operation: 'union' }, 'operation'],
    ['fillet without edges', { ...cornerFillet(), edges: [] }, 'edges'],
    [
      'chamfer with a second distance and an angle',
      {
        id: 'chamfer#1',
        kind: 'chamfer',
        name: 'C',
        suppressed: false,
        edges: [{ id: 'r4', ref: { faces: ['a', 'b'] } }],
        distance: mm('1'),
        secondDistance: mm('2'),
        angle: mm('30deg'),
      },
      'angle',
    ],
    [
      'pattern without features',
      {
        id: 'pattern#1',
        kind: 'pattern',
        name: 'P',
        suppressed: false,
        features: [],
        layout: {
          type: 'linear',
          direction: { id: 'r5', ref: { face: 'a' } },
          count: mm('2'),
          spacing: mm('1'),
        },
      },
      'features',
    ],
    [
      'body mirror that lists features',
      {
        id: 'mirror#1',
        kind: 'mirror',
        name: 'M',
        suppressed: false,
        features: ['extrude#1'],
        body: true,
        plane: { id: 'r7', ref: { face: 'a' } },
      },
      'features',
    ],
    [
      'hole with an unknown fit',
      { ...holeFeature(), standard: { size: 'M5', fit: 'snug' } },
      'standard.fit',
    ],
    [
      'fillet with a face reference',
      { ...cornerFillet(), edges: [{ id: 'r2', ref: { face: 'a' } }] },
      'edges.0.ref.faces',
    ],
    [
      'reference id with wrong prefix',
      { ...cornerFillet(), edges: [{ id: 'e2', ref: { faces: ['a', 'b'] } }] },
      'edges.0.id',
    ],
    [
      'edge with three faces',
      { ...cornerFillet(), edges: [{ id: 'r2', ref: { faces: ['a', 'b', 'c'] } }] },
      'edges.0.ref.faces',
    ],
    [
      'edge with ordinal 0',
      { ...cornerFillet(), edges: [{ id: 'r2', ref: { faces: ['a', 'b'], ordinal: 0 } }] },
      'edges.0.ref.ordinal',
    ],
    [
      'empty face name',
      { ...cornerFillet(), edges: [{ id: 'r2', ref: { faces: ['', 'b'] } }] },
      'edges.0.ref.faces.0',
    ],
    [
      'entity with unknown kind',
      { ...rectangleSketch(), entities: [{ id: 'e1', kind: 'spline', construction: false }] },
      'entities.0.kind',
    ],
    [
      'circle with zero radius',
      {
        ...holeSketch(),
        entities: [{ id: 'e5', kind: 'circle', construction: false, center: [0, 0], radius: 0 }],
      },
      'entities.0.radius',
    ],
    [
      'point with 3 coordinates',
      {
        ...rectangleSketch(),
        entities: [{ id: 'e1', kind: 'point', construction: false, position: [0, 0, 0] }],
      },
      'entities.0.position',
    ],
    [
      'infinite coordinate',
      {
        ...rectangleSketch(),
        entities: [{ id: 'e1', kind: 'point', construction: false, position: [Infinity, 0] }],
      },
      'entities.0.position.0',
    ],
    [
      'constraint with unknown kind',
      { ...rectangleSketch(), constraints: [{ id: 'k1', kind: 'glue', line: 'e1' }] },
      'constraints.0',
    ],
    [
      'constraint with the fields of another kind',
      { ...rectangleSketch(), constraints: [{ id: 'k1', kind: 'coincident', line: 'e1' }] },
      'constraints.0',
    ],
    [
      'constraint with an entity id of the wrong form',
      { ...rectangleSketch(), constraints: [{ id: 'k1', kind: 'horizontal', line: 'line1' }] },
      'constraints.0.line',
    ],
    [
      'hole without points',
      { ...(validFeatures.find((f) => f.id === 'hole#1') as Feature), points: [] },
      'points',
    ],
    [
      'counterbore without depth',
      {
        ...(validFeatures.find((f) => f.id === 'hole#1') as Feature),
        head: { type: 'counterbore', diameter: mm('9') },
      },
      'head.depth',
    ],
    [
      'extension type not namespaced',
      { ...(validFeatures.find((f) => f.id === 'extension#1') as Feature), extension: 'brim' },
      'extension',
    ],
    [
      'extension expression key not an identifier',
      {
        ...(validFeatures.find((f) => f.id === 'extension#1') as Feature),
        expressions: { 'a b': mm('1') },
      },
      'expressions.a b',
    ],
    [
      'extension params not JSON',
      { ...(validFeatures.find((f) => f.id === 'extension#1') as Feature), params: { f: () => 1 } },
      'params.f',
    ],
  ];

  const countPattern = (count: string) => ({
    id: 'pattern#1',
    kind: 'pattern',
    name: 'P',
    suppressed: false,
    features: ['extrude#2'],
    layout: {
      type: 'linear',
      direction: { id: 'r5', ref: { face: 'a' } },
      count: mm(count),
      spacing: mm('1'),
    },
  });
  invalid.push(
    [
      'revolve sketch line flip not a boolean',
      {
        ...(validFeatures.find((f) => f.id === 'revolve#1') as Feature),
        axis: { type: 'sketchLine', entity: 'e4', flip: 'yes' },
      },
      'axis.flip',
    ],
    [
      'pattern flip not a boolean',
      {
        ...countPattern('2'),
        layout: { ...countPattern('2').layout, flip: 'yes' },
      },
      'layout.flip',
    ],
  );

  it.each(invalid)('rejects %s', (_label, input, path) => {
    const r = FeatureSchema.safeParse(input);
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toContain(path);
  });

  // The count range is the kernel's to check at regen (MAX_PATTERN_COUNT), so a
  // stored count out of range still loads and only that pattern fails.
  it.each(['1001', '0', '2.5', `${MAX_PATTERN_COUNT}`])('loads a pattern count of %s', (count) => {
    expect(FeatureSchema.safeParse(countPattern(count)).success).toBe(true);
  });
});

describe('SketchPlaneSchema', () => {
  const plane = (normal: number[], xDir: number[]) => ({
    type: 'plane',
    origin: [0, 0, 0],
    normal,
    xDir,
  });
  it.each([
    ['XY', plane([0, 0, 1], [1, 0, 0]), true],
    ['tilted, unnormalised', plane([0, 2, 2], [5, 0, 0]), true],
    ['xDir along normal', plane([0, 0, 1], [0, 0, 1]), false],
    ['xDir not perpendicular', plane([0, 0, 1], [1, 0, 0.01]), false],
    ['zero normal', plane([0, 0, 0], [1, 0, 0]), false],
    ['zero xDir', plane([0, 0, 1], [0, 0, 0]), false],
    [
      'face placement',
      { type: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
      true,
    ],
    [
      'face placement on an edge',
      { type: 'face', face: { id: 'r1', ref: { faces: ['a', 'b'] } } },
      false,
    ],
  ])('%s', (_label, input, valid) => {
    expect(SketchPlaneSchema.safeParse(input).success).toBe(valid);
  });
});

describe('SketchConstraintSchema', () => {
  const p = (entity: string, at?: string) => (at ? { entity, at } : { entity });
  const v = mm('10');
  const valid: [string, object][] = [
    ['coincident', { kind: 'coincident', a: p('e1', 'end'), b: p('e2', 'start') }],
    ['horizontal line', { kind: 'horizontal', line: 'e1' }],
    ['horizontal points', { kind: 'horizontal', a: p('e1', 'start'), b: p('e3') }],
    ['vertical line', { kind: 'vertical', line: 'e2#a' }],
    ['vertical points', { kind: 'vertical', a: p('@origin'), b: p('e3') }],
    ['parallel', { kind: 'parallel', a: 'e1', b: '@x-axis' }],
    ['perpendicular', { kind: 'perpendicular', a: 'e1', b: 'e2' }],
    ['edge tangent', { kind: 'tangent', a: 'e1', b: 'e4' }],
    ['endpoint tangent', { kind: 'tangent', a: 'e1', b: 'e4', at: ['end', 'start'] }],
    ['equal', { kind: 'equal', a: 'e1', b: 'e2' }],
    ['point distance', { kind: 'distance', a: p('e1', 'start'), b: p('e1', 'end'), value: v }],
    ['point to line distance', { kind: 'distance', point: p('e3'), line: 'e1', value: v }],
    ['horizontal distance', { kind: 'horizontalDistance', a: p('@origin'), b: p('e3'), value: v }],
    ['vertical distance', { kind: 'verticalDistance', a: p('@origin'), b: p('e3'), value: v }],
    ['angle', { kind: 'angle', a: 'e1', b: 'e2', value: mm('30deg') }],
    ['radius', { kind: 'radius', entity: 'e4', value: v }],
    ['diameter', { kind: 'diameter', entity: 'e4', value: v }],
    ['fix', { kind: 'fix', point: p('e3') }],
    ['midpoint', { kind: 'midpoint', point: p('e3'), line: 'e1' }],
    ['point on object', { kind: 'pointOnObject', point: p('e3'), on: 'e4' }],
    ['symmetric about a line', { kind: 'symmetric', a: p('e3'), b: p('e5'), line: 'e1' }],
    [
      'symmetric about a point',
      { kind: 'symmetric', a: p('e3'), b: p('e5'), center: p('@origin') },
    ],
  ];
  it.each(valid)('accepts %s', (_label, c) => {
    const r = SketchConstraintSchema.safeParse({ id: 'k1', ...c });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 'k1', ...c });
  });

  it('covers every constraint kind of the sketch model', () => {
    expect(new Set(valid.map(([, c]) => (c as { kind: string }).kind)).size).toBe(17);
    expect(Object.keys(DIMENSION_KINDS).sort()).toEqual(
      ['angle', 'diameter', 'distance', 'horizontalDistance', 'radius', 'verticalDistance'].sort(),
    );
  });

  const invalid: [string, object][] = [
    ['a dimension without a value', { kind: 'radius', entity: 'e4' }],
    ['a geometric constraint with a value', { kind: 'parallel', a: 'e1', b: 'e2', value: v }],
    ['a number as the value', { kind: 'radius', entity: 'e4', value: 10 }],
    ['a point reference where a curve is needed', { kind: 'parallel', a: p('e1'), b: 'e2' }],
    ['a curve where a point is needed', { kind: 'coincident', a: 'e1', b: p('e2', 'start') }],
    ['an unknown vertex', { kind: 'fix', point: p('e1', 'mid') }],
    ['an unknown built-in', { kind: 'parallel', a: 'e1', b: '@z-axis' }],
    ['an entity id of another form', { kind: 'horizontal', line: 'k1' }],
    ['a tangent with one end', { kind: 'tangent', a: 'e1', b: 'e2', at: ['end'] }],
    ['mixed horizontal forms', { kind: 'horizontal', line: 'e1', a: p('e1', 'start') }],
    [
      'symmetric with both a line and a center',
      { kind: 'symmetric', a: p('e3'), b: p('e5'), line: 'e1', center: p('@origin') },
    ],
    ['the old targets form', { kind: 'fix', targets: [{ entity: 'e1' }] }],
  ];
  it.each(invalid)('rejects %s', (_label, c) => {
    expect(SketchConstraintSchema.safeParse({ id: 'k1', ...c }).success).toBe(false);
  });

  it('requires a constraint id', () => {
    expect(
      SketchConstraintSchema.safeParse({ id: 'c1', kind: 'fix', point: p('e3') }).success,
    ).toBe(false);
  });
});

describe('ReferenceSchema', () => {
  it.each([
    [{ id: 'r1', ref: { face: 'extrude#1:cap:end' } }, true],
    [{ id: 'r1', ref: { faces: ['a|b'] } }, true],
    [{ id: 'r1#a', ref: { faces: ['a', 'b'], ends: ['c', 'd'], ordinal: 1 } }, true],
    [
      { id: 'r1', ref: { face: 'a' }, lastResolved: { point: [0, 0, 0], direction: [0, 0, 1] } },
      true,
    ],
    [{ id: 'r1', ref: { face: 'a' }, lastResolved: { point: [0, 0] } }, false],
    [{ id: 'r1', ref: { face: 'a', faces: ['b'] } }, false],
    [{ id: 'r1', ref: { index: 3 } }, false],
    [{ id: 'r1', ref: { faces: ['a', 'b'], ends: [] } }, false],
    [{ id: 'x1', ref: { face: 'a' } }, false],
  ])('%j -> %s', (input, valid) => {
    expect(ReferenceSchema.safeParse(input).success).toBe(valid);
  });
});

describe('StoredExpressionSchema and DisplayUnitsSchema', () => {
  it.each([
    [{ source: '2*#t + 1/8"', lengthUnit: 'in', angleUnit: 'deg' }, true],
    [{ source: '', lengthUnit: 'mm', angleUnit: 'rad' }, true],
    [{ source: '1', lengthUnit: 'yd', angleUnit: 'deg' }, false],
    [{ source: 1, lengthUnit: 'mm', angleUnit: 'deg' }, false],
  ])('expression %j -> %s', (input, valid) => {
    expect(StoredExpressionSchema.safeParse(input).success).toBe(valid);
  });

  it.each([
    [{ length: { unit: 'mm' }, angle: { unit: 'deg' } }, true],
    [{ length: { unit: 'in', decimals: 3 }, angle: { unit: 'rad', decimals: 4 } }, true],
    [{ length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } }, true],
    [{ length: { unit: 'in-fraction', denominator: 128 }, angle: { unit: 'deg' } }, true],
    [{ length: { unit: 'ft-in', denominator: 3 }, angle: { unit: 'deg' } }, false],
    [{ length: { unit: 'ft-in', decimals: 2 }, angle: { unit: 'deg' } }, false],
    [{ length: { unit: 'mm', denominator: 16 }, angle: { unit: 'deg' } }, false],
    [{ length: { unit: 'mm', decimals: -1 }, angle: { unit: 'deg' } }, false],
    [{ length: { unit: 'mm' }, angle: { unit: 'grad' } }, false],
  ])('display units %j -> %s', (input, valid) => {
    expect(DisplayUnitsSchema.safeParse(input).success).toBe(valid);
  });
});
