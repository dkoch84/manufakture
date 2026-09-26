import { describe, expect, it } from 'vitest';
import {
  ANGLE,
  DIMENSIONLESS,
  LENGTH,
  angleQuantity,
  lengthQuantity,
  numberQuantity,
  type Quantity,
  type QuantityKind,
} from './dimension';
import {
  evaluate,
  evaluateParsed,
  evaluateQuantity,
  type EvaluateOptions,
  type VariableLookup,
} from './evaluate';
import { parseExpression } from './parser';
import { unwrap } from './test-helpers';

const IN = 25.4;
const DEG = Math.PI / 180;

const VARIABLES: ReadonlyMap<string, Quantity> = new Map([
  ['thickness', lengthQuantity(18)],
  ['width', lengthQuantity(600)],
  ['area', { value: 400, dimension: { length: 2, angle: 0 } }],
  ['count', numberQuantity(4)],
  ['slope', angleQuantity(30 * DEG)],
  ['pi', numberQuantity(3)], // only reachable as #pi
]);
const variables: VariableLookup = (name) => VARIABLES.get(name);

function run(source: string, expected: QuantityKind, extra: Partial<EvaluateOptions> = {}) {
  return unwrap(evaluate(source, { expected, variables, ...extra }));
}

describe('arithmetic and precedence', () => {
  it.each<[string, number]>([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['24 / 4 / 3', 2],
    ['2 * 3 ^ 2', 18],
    ['2 ^ 3 ^ 2', 512], // right-associative
    ['(2 ^ 3) ^ 2', 64],
    ['-2 ^ 2', -4], // unary minus binds looser than ^
    ['(-2) ^ 2', 4],
    ['2 ^ -1', 0.5],
    ['--3', 3],
    ['+3', 3],
    ['-3 * -2', 6],
    ['1/2', 0.5],
    ['1/2/2', 0.25],
    ['2^1/2', 1], // `1/2` without a unit is plain division: (2^1)/2
    ['2^(1/2)', Math.SQRT2],
    ['4 1/2 + 1', 5.5], // whitespace mixed number
    ['1e2 * 2', 200],
    ['pi', Math.PI],
    ['#pi', 3],
    ['2 × 3 − 1', 5],
  ])('%j = %f', (source, expected) => {
    expect(run(source, 'number')).toBeCloseTo(expected, 12);
  });
});

describe('units inside expressions', () => {
  it.each<[string, string, number]>([
    ['2*thickness + 1/8"', 'mm', 36 + IN / 8],
    ['#thickness * 2', 'mm', 36],
    ['thickness + 3', 'mm', 21], // bare number read in display unit
    ['thickness + 3', 'in', 18 + 3 * IN],
    ['3 + thickness', 'in', 18 + 3 * IN],
    ['(thickness + 2) * 3', 'mm', 60],
    ['width / count', 'mm', 150],
    ['width - 2*thickness', 'mm', 564],
    ['1in + 1mm', 'mm', 26.4],
    [`3' 4-1/2" + 1/2"`, 'mm', 41 * IN],
    [`3' 4" - 2"`, 'mm', 38 * IN],
    [`3' - 2"`, 'mm', 34 * IN],
    [`2 * 3'`, 'mm', 6 * 304.8],
    ['(1 + 2)in', 'mm', 3 * IN],
    ['(1 + 2) mm * 2', 'mm', 6],
    ['12', 'in', 12 * IN],
    ['2 * 3', 'cm', 60],
    ['sqrt(area)', 'mm', 20],
    ['sqrt(4mm * 9mm)', 'mm', 6],
    ['thickness^2 / thickness', 'mm', 18],
    ['min(thickness, 1in)', 'mm', 18],
    ['max(thickness, 1in, 2)', 'mm', IN],
    ['max(thickness, 20)', 'mm', 20],
    ['min(5)', 'mm', 5],
    ['abs(-thickness)', 'mm', 18],
    ['round(2.4in)', 'in', 2 * IN],
    ['round(2.5in)', 'in', 3 * IN],
    ['round(-2.5in)', 'in', -3 * IN],
    ['floor(2.9in)', 'in', 2 * IN],
    ['ceil(2.1in)', 'in', 3 * IN],
    ['round(12.3456)', 'mm', 12],
    ['round(1.30in, 1/4")', 'mm', 1.25 * IN],
    ['floor(thickness, 5)', 'mm', 15],
    ['ceil(thickness, 5mm)', 'mm', 20],
  ])('%j (display %s) = %f mm', (source, lengthUnit, expected) => {
    expect(run(source, 'length', { lengthUnit: lengthUnit as 'mm' })).toBeCloseTo(expected, 9);
  });
});

describe('angles and trigonometry', () => {
  it.each<[string, QuantityKind, number]>([
    ['45deg', 'angle', 45 * DEG],
    ['45', 'angle', 45 * DEG],
    ['slope + 15', 'angle', 45 * DEG],
    ['slope * 2', 'angle', 60 * DEG],
    ['90deg - slope', 'angle', 60 * DEG],
    ['1rad', 'angle', 1],
    ['sin(30deg)', 'number', 0.5],
    ['sin(30)', 'number', 0.5], // bare number read in display angle unit
    ['cos(slope * 2)', 'number', 0.5],
    ['tan(45°)', 'number', 1],
    ['sin((pi/6)rad)', 'number', 0.5],
    ['asin(0.5)', 'angle', 30 * DEG],
    ['acos(0.5)', 'angle', 60 * DEG],
    ['atan(1)', 'angle', 45 * DEG],
    ['atan2(1in, 1in)', 'angle', 45 * DEG],
    ['atan2(6, 12)', 'angle', Math.atan2(6, 12)],
    ['round(29.6deg)', 'angle', 30 * DEG],
    ['thickness * cos(60deg)', 'length', 9],
    ['width * tan(slope)', 'length', 600 * Math.tan(30 * DEG)],
  ])('%j as %s = %f', (source, kind, expected) => {
    expect(run(source, kind)).toBeCloseTo(expected, 12);
  });

  it('reads bare angles in radians when the display angle unit is rad', () => {
    expect(run('sin(pi/6)', 'number', { angleUnit: 'rad' })).toBeCloseTo(0.5, 12);
    expect(run('1', 'angle', { angleUnit: 'rad' })).toBe(1);
  });
});

describe('variables', () => {
  it('looks up names with and without #', () => {
    const seen: string[] = [];
    const lookup: VariableLookup = (name) => {
      seen.push(name);
      return lengthQuantity(10);
    };
    expect(unwrap(evaluate('#a + b', { expected: 'length', variables: lookup }))).toBe(20);
    expect(seen).toEqual(['a', 'b']);
  });

  it('allows unit names as variables where a unit cannot appear', () => {
    const lookup: VariableLookup = (name) => (name === 'in' ? lengthQuantity(7) : undefined);
    expect(unwrap(evaluate('2 * in', { expected: 'length', variables: lookup }))).toBe(14);
    expect(unwrap(evaluate('2 in', { expected: 'length', variables: lookup }))).toBe(2 * IN);
  });

  it('is case sensitive for variable names', () => {
    expect(evaluate('Thickness', { expected: 'length', variables }).ok).toBe(false);
  });
});

describe('evaluateQuantity', () => {
  it.each<[string, Quantity]>([
    ['5', { value: 5, dimension: DIMENSIONLESS }],
    ['5mm', { value: 5, dimension: LENGTH }],
    ['5deg', { value: 5 * DEG, dimension: ANGLE }],
    ['thickness * width', { value: 18 * 600, dimension: { length: 2, angle: 0 } }],
    ['1 / thickness', { value: 1 / 18, dimension: { length: -1, angle: 0 } }],
    ['count + 1', { value: 5, dimension: DIMENSIONLESS }],
  ])('%j', (source, expected) => {
    const q = unwrap(evaluateQuantity(source, { variables }));
    expect(q.value).toBeCloseTo(expected.value, 12);
    expect(q.dimension.length).toBeCloseTo(expected.dimension.length, 12);
    expect(q.dimension.angle).toBeCloseTo(expected.dimension.angle, 12);
  });
});

describe('negative zero', () => {
  it.each<[string, QuantityKind]>([
    ['-0', 'number'],
    ['-0', 'length'],
    ['0 * -1', 'number'],
    ['-thickness * 0', 'length'],
    ['round(-0.4)', 'number'],
    ['-0deg', 'angle'],
  ])('%j as %s is +0', (source, kind) => {
    expect(Object.is(run(source, kind), 0)).toBe(true);
  });

  it('is normalised by evaluateQuantity too', () => {
    expect(Object.is(unwrap(evaluateQuantity('-0mm')).value, 0)).toBe(true);
  });
});

describe('evaluateParsed', () => {
  it('evaluates a parsed expression repeatedly with different contexts', () => {
    const ast = unwrap(parseExpression('2 * thickness + 1'));
    const mm = evaluateParsed(ast, { expected: 'length', variables });
    const inch = evaluateParsed(ast, { expected: 'length', lengthUnit: 'in', variables });
    expect(unwrap(mm)).toBe(37);
    expect(unwrap(inch)).toBeCloseTo(36 + IN, 12);
  });
});
