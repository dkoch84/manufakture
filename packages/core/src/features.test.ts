import { describe, expect, it } from 'vitest';
import {
  defaultFeatureName,
  featureDependencies,
  featureExpressions,
  featureIdsInName,
  featureSubIds,
} from './features';
import type { Feature } from './schema';
import {
  baseExtrude,
  cornerFillet,
  holeCut,
  holeSketch,
  mm,
  rectangleSketch,
} from './test-helpers';

describe('featureIdsInName', () => {
  it.each([
    ['extrude#1:cap:end', ['extrude#1']],
    ['extrude#1:side:e2#a', ['extrude#1']],
    ['extrude#12:side:e2', ['extrude#12']],
    ['fillet#3:round:r1#1', ['fillet#3']],
    ['(extrude#1:cap:end+extrude#2:side:e5)', ['extrude#1', 'extrude#2']],
    [
      'fillet#3:corner:extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2',
      ['fillet#3', 'extrude#1'],
    ],
    ['cut#4:side:s3', []],
    ['?face3', []],
    ['myextrude#1:cap:end', []],
    ['extrude#1', []],
  ])('%s', (name, ids) => {
    expect(featureIdsInName(name)).toEqual(ids);
  });
});

describe('featureDependencies', () => {
  const cases: [string, Feature, string[]][] = [
    ['sketch on a plane', rectangleSketch(), []],
    ['sketch on a face', holeSketch(), ['extrude#1']],
    ['extrude of a sketch', baseExtrude(), ['sketch#1']],
    [
      'extrude up to a face',
      {
        ...baseExtrude(),
        extent: { type: 'upToFace', face: { id: 'r9', ref: { face: 'extrude#2:cap:start' } } },
      },
      ['extrude#2', 'sketch#1'],
    ],
    ['fillet on edges', cornerFillet(), ['extrude#1']],
    [
      'fillet with end faces from another feature',
      {
        ...cornerFillet(),
        edges: [
          {
            id: 'r2',
            ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'], ends: ['extrude#2:side:e5'] },
          },
        ],
      },
      ['extrude#1', 'extrude#2'],
    ],
    [
      'pattern of features along an edge',
      {
        id: 'pattern#1',
        kind: 'pattern',
        name: 'P',
        suppressed: false,
        features: ['extrude#2', 'fillet#1'],
        layout: {
          type: 'linear',
          direction: { id: 'r3', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } },
          count: mm('3'),
          spacing: mm('5'),
        },
      },
      ['extrude#1', 'extrude#2', 'fillet#1'],
    ],
    [
      'extension',
      {
        id: 'extension#1',
        kind: 'extension',
        name: 'X',
        suppressed: false,
        extension: 'print.brim',
        schemaVersion: 1,
        dependsOn: ['extrude#1'],
        references: [{ id: 'r4', ref: { face: 'fillet#1:round:r2' } }],
        expressions: {},
        params: {},
      },
      ['extrude#1', 'fillet#1'],
    ],
    [
      'never itself',
      {
        ...cornerFillet(),
        edges: [{ id: 'r2', ref: { faces: ['fillet#1:round:r1', 'extrude#1:cap:end'] } }],
      },
      ['extrude#1'],
    ],
  ];
  it.each(cases)('%s', (_label, feature, deps) => {
    expect(featureDependencies(feature)).toEqual(deps);
  });
});

describe('featureExpressions', () => {
  it('lists sketch dimensions with their kinds', () => {
    const sketch = rectangleSketch();
    sketch.constraints.push({ id: 'k9', kind: 'angle', a: 'e1', b: 'e2', value: mm('90') });
    expect(
      featureExpressions(sketch).map((s) => [s.path.join('.'), s.expression.source, s.expected]),
    ).toEqual([
      ['constraints.2.value', 'width', 'length'],
      ['constraints.3.value', 'height', 'length'],
      ['constraints.5.value', '90', 'angle'],
    ]);
  });

  it.each<[string, Feature, [string, string][]]>([
    ['blind extrude', baseExtrude(), [['extent.distance', 'length']]],
    ['through-all extrude', holeCut(), []],
    ['fillet', cornerFillet(), [['radius', 'length']]],
    [
      'countersunk blind hole',
      {
        id: 'hole#1',
        kind: 'hole',
        name: 'H',
        suppressed: false,
        sketch: 'sketch#2',
        points: ['e5'],
        diameter: mm('5'),
        extent: { type: 'blind', depth: mm('8') },
        head: { type: 'countersink', diameter: mm('9'), angle: mm('90deg') },
      },
      [
        ['diameter', 'length'],
        ['extent.depth', 'length'],
        ['head.diameter', 'length'],
        ['head.angle', 'angle'],
      ],
    ],
    [
      'circular pattern',
      {
        id: 'pattern#1',
        kind: 'pattern',
        name: 'P',
        suppressed: false,
        features: ['extrude#2'],
        layout: {
          type: 'circular',
          axis: { id: 'r3', ref: { face: 'x:y' } },
          count: mm('6'),
          angle: mm('360deg'),
        },
      },
      [
        ['layout.count', 'number'],
        ['layout.angle', 'angle'],
      ],
    ],
    [
      'extension, in key order',
      {
        id: 'extension#1',
        kind: 'extension',
        name: 'X',
        suppressed: false,
        extension: 'print.brim',
        schemaVersion: 1,
        dependsOn: [],
        references: [],
        expressions: { zeta: mm('1'), alpha: mm('2') },
        params: {},
      },
      [
        ['expressions.alpha', 'any'],
        ['expressions.zeta', 'any'],
      ],
    ],
  ])('%s', (_label, feature, expected) => {
    expect(featureExpressions(feature).map((s) => [s.path.join('.'), s.expected])).toEqual(
      expected,
    );
  });
});

describe('featureSubIds and defaultFeatureName', () => {
  it('collects entity, constraint and reference ids', () => {
    expect(featureSubIds(rectangleSketch())).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'k1',
      'k2',
      'k3',
      'k4',
      'k5',
    ]);
    expect(featureSubIds(holeSketch())).toEqual(['e5', 'k6', 'r1']);
    expect(featureSubIds(cornerFillet())).toEqual(['r2']);
    expect(featureSubIds(holeCut())).toEqual([]);
  });

  it('names features after their id', () => {
    expect(defaultFeatureName('extrude', 'extrude#3')).toBe('Extrude 3');
    expect(defaultFeatureName('sketch', 'sketch#12')).toBe('Sketch 12');
  });
});
