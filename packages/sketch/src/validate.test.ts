import { angleQuantity, lengthQuantity } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import {
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type SketchConstraint,
  type SketchEntity,
  type SketchInput,
} from './model';
import {
  ORIGIN,
  arc,
  center,
  circle,
  deg,
  end,
  line,
  mm,
  point,
  rectangle,
  start,
} from './test-helpers';
import { evaluateValues, referencedEntities, validateSketch } from './validate';

const entities: SketchEntity[] = [
  point('p', [0, 0]),
  line('l', [0, 0], [1, 0]),
  line('m', [0, 1], [1, 2]),
  circle('c', [5, 5], 1),
  arc('a', [9, 9], [10, 9], [9, 10]),
];
const check = (...constraints: SketchConstraint[]) => validateSketch({ entities, constraints });
const codes = (...constraints: SketchConstraint[]) => check(...constraints).map((i) => i.code);

describe('validateSketch: entities', () => {
  it('accepts a well-formed sketch', () => {
    expect(validateSketch(rectangle())).toEqual([]);
  });

  it('rejects bad, duplicate and reserved ids', () => {
    const issues = validateSketch({
      entities: [
        line('e#1', [0, 0], [1, 0]),
        line('ok', [0, 0], [1, 0]),
        line('ok', [0, 0], [2, 0]),
      ],
      constraints: [],
    });
    expect(issues.map((i) => [i.code, i.entityId])).toEqual([
      ['invalid-id', 'e#1'],
      ['duplicate-id', 'ok'],
    ]);
  });

  it('rejects degenerate or non-finite geometry', () => {
    const issues = validateSketch({
      entities: [
        line('zero', [1, 1], [1, 1]),
        circle('flat', [0, 0], 0),
        arc('dot', [0, 0], [0, 0], [1, 0]),
        point('nan', [NaN, 0]),
      ],
      constraints: [],
    });
    expect(issues.map((i) => i.code)).toEqual([
      'invalid-geometry',
      'invalid-geometry',
      'invalid-geometry',
      'invalid-geometry',
    ]);
    expect(issues[0]!.message).toMatch(/zero length/);
  });
});

describe('validateSketch: constraints', () => {
  it('accepts every kind with the right references', () => {
    expect(
      check(
        { id: 'k1', kind: 'coincident', a: { entity: 'p' }, b: start('l') },
        { id: 'k2', kind: 'horizontal', line: 'l' },
        { id: 'k3', kind: 'vertical', a: { entity: 'p' }, b: ORIGIN },
        { id: 'k4', kind: 'parallel', a: 'l', b: SKETCH_X_AXIS },
        { id: 'k5', kind: 'perpendicular', a: 'l', b: 'm' },
        { id: 'k6', kind: 'tangent', a: 'l', b: 'c' },
        { id: 'k7', kind: 'tangent', a: 'm', b: 'a', at: ['end', 'start'] },
        { id: 'k8', kind: 'tangent', a: 'c', b: 'a' },
        { id: 'k9', kind: 'equal', a: 'c', b: 'a' },
        { id: 'k10', kind: 'equal', a: 'l', b: 'm' },
        { id: 'k11', kind: 'distance', a: { entity: 'p' }, b: center('c'), value: mm(3) },
        { id: 'k12', kind: 'distance', point: { entity: 'p' }, line: 'm', value: mm(3) },
        { id: 'k13', kind: 'horizontalDistance', a: ORIGIN, b: { entity: 'p' }, value: mm(-3) },
        { id: 'k14', kind: 'verticalDistance', a: start('l'), b: end('a'), value: mm(3) },
        { id: 'k15', kind: 'angle', a: SKETCH_Y_AXIS, b: 'm', value: deg(3) },
        { id: 'k16', kind: 'radius', entity: 'a', value: mm(3) },
        { id: 'k17', kind: 'diameter', entity: 'c', value: mm(3) },
        { id: 'k18', kind: 'fix', point: center('a') },
        { id: 'k19', kind: 'midpoint', point: { entity: 'p' }, line: 'm' },
        { id: 'k20', kind: 'pointOnObject', point: { entity: 'p' }, on: 'a' },
        { id: 'k21', kind: 'symmetric', a: start('l'), b: end('l'), line: SKETCH_Y_AXIS },
        { id: 'k22', kind: 'symmetric', a: start('l'), b: end('l'), center: { entity: 'p' } },
      ),
    ).toEqual([]);
  });

  it.each<[string, SketchConstraint, string, RegExp]>([
    [
      'unknown entity',
      { id: 'x', kind: 'horizontal', line: 'zz' },
      'unknown-entity',
      /unknown entity 'zz'/,
    ],
    [
      'wrong kind',
      { id: 'x', kind: 'parallel', a: 'l', b: 'c' },
      'invalid-reference',
      /'c' is a circle, expected a line/,
    ],
    [
      'bad position',
      { id: 'x', kind: 'coincident', a: center('l'), b: start('m') },
      'invalid-reference',
      /a line has points start, end/,
    ],
    [
      'position on a point',
      { id: 'x', kind: 'coincident', a: { entity: 'p', at: 'start' }, b: start('m') },
      'invalid-reference',
      /a point has points \(none\)/,
    ],
    [
      'same point twice',
      { id: 'x', kind: 'coincident', a: start('l'), b: start('l') },
      'invalid-reference',
      /both points/,
    ],
    [
      'same line twice',
      { id: 'x', kind: 'perpendicular', a: 'l', b: 'l' },
      'invalid-reference',
      /both sides/,
    ],
    [
      'two lines edge-tangent',
      { id: 'x', kind: 'tangent', a: 'l', b: 'm' },
      'invalid-reference',
      /cannot be edge-tangent/,
    ],
    [
      'endpoint tangency on a circle',
      { id: 'x', kind: 'tangent', a: 'l', b: 'c', at: ['end', 'start'] },
      'invalid-reference',
      /expected a line or an arc/,
    ],
    [
      'bad tangent ends',
      { id: 'x', kind: 'tangent', a: 'l', b: 'a', at: ['end', 'center'] as never },
      'invalid-reference',
      /'at' must be/,
    ],
    [
      'equal line and circle',
      { id: 'x', kind: 'equal', a: 'l', b: 'c' },
      'invalid-reference',
      /two lines, or two circles/,
    ],
    [
      'radius of a line',
      { id: 'x', kind: 'radius', entity: 'l', value: mm(1) },
      'invalid-reference',
      /expected a circle or an arc/,
    ],
    [
      'fix the origin',
      { id: 'x', kind: 'fix', point: ORIGIN },
      'invalid-reference',
      /cannot be used as a point/,
    ],
    [
      'axis as a point',
      { id: 'x', kind: 'coincident', a: { entity: SKETCH_X_AXIS }, b: start('l') },
      'invalid-reference',
      /cannot be used as a point/,
    ],
    [
      'only built-ins',
      { id: 'x', kind: 'perpendicular', a: SKETCH_X_AXIS, b: SKETCH_Y_AXIS },
      'invalid-reference',
      /only the fixed origin and axes/,
    ],
    [
      'horizontal axis',
      { id: 'x', kind: 'horizontal', line: SKETCH_X_AXIS },
      'invalid-reference',
      /cannot be used here/,
    ],
    [
      'centre on a symmetric point',
      { id: 'x', kind: 'symmetric', a: start('l'), b: end('l'), center: start('l') },
      'invalid-reference',
      /centre must differ/,
    ],
    [
      'unknown kind',
      { id: 'x', kind: 'weld' } as never,
      'invalid-reference',
      /unknown constraint kind 'weld'/,
    ],
  ])('%s', (_, c, code, message) => {
    const issues = check(c);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ code, constraintId: 'x' });
    expect(issues[0]!.message).toMatch(message);
  });

  it('rejects bad and duplicate constraint ids', () => {
    expect(
      codes(
        { id: 'h#2', kind: 'horizontal', line: 'l' },
        { id: 'h', kind: 'horizontal', line: 'l' },
        { id: 'h', kind: 'vertical', line: 'm' },
      ),
    ).toEqual(['invalid-id', 'duplicate-id']);
  });

  it('reports every problem, not only the first', () => {
    expect(codes({ id: 'x', kind: 'parallel', a: 'nope', b: 'c' })).toEqual([
      'unknown-entity',
      'invalid-reference',
    ]);
  });
});

describe('referencedEntities', () => {
  it('lists every entity a constraint touches', () => {
    expect(
      referencedEntities({
        id: 's',
        kind: 'symmetric',
        a: start('l'),
        b: { entity: 'p' },
        line: 'm',
      }),
    ).toEqual(['l', 'p', 'm']);
    expect(referencedEntities({ id: 'r', kind: 'radius', entity: 'c', value: mm(1) })).toEqual([
      'c',
    ]);
    expect(referencedEntities({ id: 'o', kind: 'pointOnObject', point: ORIGIN, on: 'c' })).toEqual([
      SKETCH_ORIGIN,
      'c',
    ]);
  });
});

describe('evaluateValues', () => {
  const dim = (id: string, value: SketchConstraint & { value: unknown }) => ({ ...value, id });

  it('evaluates lengths in millimetres and angles in radians, with stored units and variables', () => {
    const vars = new Map([
      ['t', lengthQuantity(3)],
      ['tilt', angleQuantity(Math.PI / 4)],
    ]);
    const { values, issues } = evaluateValues(
      [
        dim('a', { id: '', kind: 'distance', a: start('l'), b: end('l'), value: mm('2 * #t') }),
        dim('b', {
          id: '',
          kind: 'radius',
          entity: 'c',
          value: { source: '1/2', lengthUnit: 'in', angleUnit: 'deg' },
        }),
        dim('c', { id: '', kind: 'angle', a: 'l', b: 'm', value: deg('90') }),
        dim('d', {
          id: '',
          kind: 'angle',
          a: 'l',
          b: 'm',
          value: { source: 'tilt * 2', lengthUnit: 'mm', angleUnit: 'rad' },
        }),
        dim('e', {
          id: '',
          kind: 'horizontalDistance',
          a: start('l'),
          b: end('l'),
          value: mm('-4cm'),
        }),
        { id: 'h', kind: 'horizontal', line: 'l' },
      ],
      (n) => vars.get(n),
    );
    expect(issues).toEqual([]);
    expect(Object.fromEntries(values)).toEqual({
      a: 6,
      b: 12.7,
      c: Math.PI / 2,
      d: Math.PI / 2,
      e: -40,
    });
  });

  it('reports expression errors with the units error, and values out of range', () => {
    const { values, issues } = evaluateValues([
      { id: 'a', kind: 'distance', a: start('l'), b: end('l'), value: mm('3 +') },
      { id: 'b', kind: 'distance', a: start('l'), b: end('l'), value: mm('30deg') },
      { id: 'c', kind: 'radius', entity: 'c', value: mm('0') },
      { id: 'd', kind: 'diameter', entity: 'c', value: mm('-2') },
      { id: 'e', kind: 'angle', a: 'l', b: 'm', value: deg('5mm') },
      { id: 'f', kind: 'radius', entity: 'c', value: undefined as never },
    ]);
    expect(values.size).toBe(0);
    expect(issues.map((i) => [i.constraintId, i.code, i.error?.code])).toEqual([
      ['a', 'expression', 'syntax'],
      ['b', 'expression', 'dimension'],
      ['c', 'invalid-value', undefined],
      ['d', 'invalid-value', undefined],
      ['e', 'expression', 'dimension'],
      ['f', 'invalid-value', undefined],
    ]);
  });

  it('is what the solver checks before solving', () => {
    const sketch: SketchInput = rectangle();
    expect(evaluateValues(sketch.constraints).issues).toEqual([]);
  });
});
