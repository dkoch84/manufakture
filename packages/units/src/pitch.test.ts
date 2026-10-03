import { describe, expect, it } from 'vitest';
import { lengthQuantity, numberQuantity, type Quantity, type QuantityKind } from './dimension';
import { evaluate, evaluateQuantity, type EvaluateOptions } from './evaluate';
import { formatAngle, slopeDisplayUnit } from './format';
import { findReferences } from './references';
import { unwrap, unwrapError } from './test-helpers';

const DEG = Math.PI / 180;
const IN = 25.4;
const PITCH_6_12 = Math.atan(6 / 12); // 26.565°

const VARIABLES: ReadonlyMap<string, Quantity> = new Map([
  ['rise', lengthQuantity(6 * IN)],
  ['run', lengthQuantity(12 * IN)],
  ['ratio', numberQuantity(0.25)],
  ['grade', numberQuantity(25)],
]);

function options(expected: QuantityKind, extra: Partial<EvaluateOptions> = {}): EvaluateOptions {
  return { expected, variables: (n) => VARIABLES.get(n), ...extra };
}

function angle(source: string, extra: Partial<EvaluateOptions> = {}): number {
  return unwrap(evaluate(source, options('angle', extra)));
}

function slope(source: string, extra: Partial<EvaluateOptions> = {}): number {
  return angle(source, { slope: true, ...extra });
}

function failure(source: string, expected: QuantityKind, extra: Partial<EvaluateOptions> = {}) {
  const error = unwrapError(evaluate(source, options(expected, extra)));
  return { ...error, text: source.slice(error.start, error.end) };
}

describe('rise:run in angle expressions', () => {
  it('6:12 is 26.565° in an angle field', () => {
    expect(angle('6:12')).toBeCloseTo(PITCH_6_12, 12);
    expect(angle('6:12') / DEG).toBeCloseTo(26.565, 3);
  });

  it.each<[string, number]>([
    ['4:12', Math.atan(4 / 12)],
    ['12:12', Math.PI / 4],
    ['7.5:12', Math.atan(7.5 / 12)],
    ['6 : 12', PITCH_6_12],
    ['0:12', 0],
    ['-6:12', -PITCH_6_12],
    ['(6:12)', PITCH_6_12],
    ['1/2:1', Math.atan(0.5)],
    // both sides lengths, or a bare number next to a length (display length unit)
    ['#rise:#run', PITCH_6_12],
    ['rise:run', PITCH_6_12],
    ['6in:1ft', PITCH_6_12],
    ['150mm:300mm', PITCH_6_12],
  ])('%j', (source, expected) => {
    expect(angle(source)).toBeCloseTo(expected, 12);
  });

  it('reads a bare side next to a length in the display length unit', () => {
    expect(angle('#rise:12', { lengthUnit: 'in' })).toBeCloseTo(PITCH_6_12, 12);
    expect(angle('#rise:304.8')).toBeCloseTo(PITCH_6_12, 12);
  });

  it('binds looser than * / ^ and tighter than + -', () => {
    expect(angle('6:24/2')).toBeCloseTo(angle('6:12'), 12);
    expect(angle('#rise*2:12', { lengthUnit: 'in' })).toBeCloseTo(Math.PI / 4, 12);
    expect(angle('3*2:12')).toBeCloseTo(PITCH_6_12, 12);
    expect(angle('2^2:16')).toBeCloseTo(Math.atan(4 / 16), 12);
    expect(angle('6:12 + 2°')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
    expect(angle('2° + 6:12')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
    expect(angle('6:12 - 4:12')).toBeCloseTo(PITCH_6_12 - Math.atan(4 / 12), 12);
    // a bare operand of + next to a pitch is a display-unit angle, as next to any angle
    expect(angle('6:12 + 2')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
  });

  it('is an angle inside larger expressions and functions', () => {
    expect(unwrap(evaluate('tan(6:12)', options('number')))).toBeCloseTo(0.5, 12);
    expect(angle('(6:12)*2')).toBeCloseTo(2 * PITCH_6_12, 12);
    expect(angle('max(4:12, 6:12)')).toBeCloseTo(PITCH_6_12, 12);
    const q = unwrap(evaluateQuantity('6:12'));
    expect(q.value).toBeCloseTo(PITCH_6_12, 12);
    expect(q.dimension).toEqual({ length: 0, angle: 1 });
  });

  it('leaves ordinary division alone: 6/12 is still 0.5° in an angle field', () => {
    expect(angle('6/12')).toBeCloseTo(0.5 * DEG, 12);
    expect(angle('6/12', { slope: false })).toBeCloseTo(0.5 * DEG, 12);
    expect(unwrap(evaluate('6/12', options('length')))).toBeCloseTo(0.5, 12);
    expect(unwrap(evaluate('6/12', options('number')))).toBeCloseTo(0.5, 12);
  });

  it('reports the variables on both sides', () => {
    expect(unwrap(findReferences('#rise:run')).map((r) => r.name)).toEqual(['rise', 'run']);
  });

  it.each<[string, QuantityKind, string, string, string]>([
    ['6:12', 'length', 'dimension', 'A pitch is an angle, but a length is expected', '6:12'],
    ['6:12', 'number', 'dimension', 'A pitch is an angle, but a number is expected', '6:12'],
    [
      '6:12 + 2°',
      'length',
      'dimension',
      'A pitch is an angle, but a length is expected',
      '6:12 + 2°',
    ],
    ['1:2:3', 'angle', 'syntax', 'A pitch has one colon: write rise:run', ':'],
    ['6:', 'angle', 'syntax', "Expected a value after ':'", ':'],
    [':12', 'angle', 'syntax', "Unexpected ':'", ':'],
    ['6:0', 'angle', 'domain', "A pitch's run must be greater than zero", '0'],
    ['6:-12', 'angle', 'domain', "A pitch's run must be greater than zero", '-12'],
    [
      '6°:12°',
      'angle',
      'dimension',
      "A pitch's rise and run must be lengths or numbers, got an angle",
      '6°:12°',
    ],
    [
      '6mm:12°',
      'angle',
      'dimension',
      "A pitch's rise and run must have the same dimension: got a length and an angle",
      '6mm:12°',
    ],
    ['6:12%', 'angle', 'syntax', 'Write a slope as rise:run or as a percent, not both', '%'],
  ])('%j as %s is a %s error', (source, kind, code, message, text) => {
    expect(failure(source, kind)).toMatchObject({ code, message, text });
  });
});

describe('slope fields', () => {
  it('reads a top-level division of bare numbers as a pitch', () => {
    expect(slope('6/12')).toBeCloseTo(PITCH_6_12, 12);
    expect(slope('6/12') / DEG).toBeCloseTo(26.565, 3);
    expect(slope('7.5/12')).toBeCloseTo(Math.atan(7.5 / 12), 12);
    expect(slope('12/12')).toBeCloseTo(Math.PI / 4, 12);
    expect(slope('-6/12')).toBeCloseTo(-PITCH_6_12, 12);
    expect(slope('(6/12)')).toBeCloseTo(PITCH_6_12, 12);
    expect(slope('3*2/12')).toBeCloseTo(PITCH_6_12, 12);
    expect(slope('#ratio*24/12')).toBeCloseTo(PITCH_6_12, 12);
  });

  it('still takes angles and rise:run', () => {
    expect(slope('26.57°')).toBeCloseTo(26.57 * DEG, 12);
    expect(slope('atan2(6, 12)')).toBeCloseTo(PITCH_6_12, 12);
    expect(slope('6:12')).toBeCloseTo(PITCH_6_12, 12);
    expect(slope('#rise:#run')).toBeCloseTo(PITCH_6_12, 12);
    expect(slope('6:12 + 2°')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
    expect(slope('0.5rad')).toBeCloseTo(0.5, 12);
  });

  it('reads 6/12 as a pitch where it is an operand of + or - or has a sign', () => {
    expect(slope('6/12 + 2°') / DEG).toBeCloseTo(28.565, 3);
    expect(slope('6/12 + 2°')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
    expect(slope('2° + 6/12')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
    expect(slope('6/12 - 4/12')).toBeCloseTo(PITCH_6_12 - Math.atan(4 / 12), 12);
    expect(slope('6/12 + 25%')).toBeCloseTo(PITCH_6_12 + Math.atan(0.25), 12);
    expect(slope('-(6/12)')).toBeCloseTo(-PITCH_6_12, 12);
    expect(slope('-(6/12 + 2°)')).toBeCloseTo(-PITCH_6_12 - 2 * DEG, 12);
    expect(slope('(6/12 + 2°)')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
  });

  it('keeps reading bare numbers in the display unit inside products and function arguments', () => {
    expect(slope('(6:12)*2')).toBeCloseTo(2 * PITCH_6_12, 12);
    expect(slope('2*(6:12)')).toBeCloseTo(2 * PITCH_6_12, 12);
    expect(slope('atan2(6, 12) + 2°')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
  });

  it('divides as usual when an operand has a dimension', () => {
    expect(slope('53.13°/2')).toBeCloseTo(26.565 * DEG, 3);
    expect(slope('53.13°/2 + 2°')).toBeCloseTo(28.565 * DEG, 3);
  });

  it('leaves plain angle fields unchanged: bare operands of + and - take the display unit', () => {
    expect(angle('30 + 2°')).toBeCloseTo(32 * DEG, 12);
    expect(angle('6/12 + 2°')).toBeCloseTo(2.5 * DEG, 12);
    expect(angle('6:12 + 2')).toBeCloseTo(PITCH_6_12 + 2 * DEG, 12);
    expect(angle('30')).toBeCloseTo(30 * DEG, 12);
  });

  it.each<[string, Partial<EvaluateOptions>, string, string, string]>([
    ['30', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '30'],
    ['  30 ', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '30'],
    ['2*15', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '2*15'],
    ['0.5', { angleUnit: 'rad' }, 'dimension', 'Ambiguous: write 0.5 rad or 0.5/12', '0.5'],
    ['6/12 + 1', {}, 'dimension', 'Ambiguous: write 1° or 1/12', '1'],
    ['30 + 2°', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '30'],
    ['2° + 30', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '30'],
    ['6:12 - 2', {}, 'dimension', 'Ambiguous: write 2° or 2/12', '2'],
    ['2*15 + 2°', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '2*15'],
    ['2*(6/12)', {}, 'dimension', 'Ambiguous: write 1° or 1/12', '2*(6/12)'],
    ['30 + 40', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '30'],
    ['-30', {}, 'dimension', 'Ambiguous: write 30° or 30/12', '30'],
    [
      '0.1 + 0.5rad',
      { angleUnit: 'rad' },
      'dimension',
      'Ambiguous: write 0.1 rad or 0.1/12',
      '0.1',
    ],
    ['6/0 + 2°', {}, 'domain', "A pitch's run must be greater than zero", '0'],
    [
      '#rise/#run + 2°',
      {},
      'dimension',
      'A ratio of lengths is not a slope: write it as rise:run',
      '#rise/#run',
    ],
    ['6/0', {}, 'domain', "A pitch's run must be greater than zero", '0'],
    [
      '#rise/#run',
      {},
      'dimension',
      'A ratio of lengths is not a slope: write it as rise:run',
      '#rise/#run',
    ],
    ['#rise', {}, 'dimension', 'Expected an angle but got a length', '#rise'],
  ])('%j (%j) is a %s error', (source, extra, code, message, text) => {
    expect(failure(source, 'angle', { slope: true, ...extra })).toMatchObject({
      code,
      message,
      text,
    });
  });

  it('applies only to angle fields', () => {
    expect(unwrap(evaluate('6/12', options('number', { slope: true })))).toBeCloseTo(0.5, 12);
    expect(unwrap(evaluate('30', options('length', { slope: true })))).toBeCloseTo(30, 12);
  });
});

describe('percent slopes', () => {
  it('25% in a slope field is atan(0.25)', () => {
    expect(slope('25%')).toBeCloseTo(Math.atan(0.25), 12);
    expect(slope('25 %')).toBeCloseTo(Math.atan(0.25), 12);
    expect(slope('12.5%')).toBeCloseTo(Math.atan(0.125), 12);
    expect(slope('100%')).toBeCloseTo(Math.PI / 4, 12);
    expect(slope('-8%')).toBeCloseTo(Math.atan(-0.08), 12);
    expect(slope('0%')).toBe(0);
  });

  it('formats back as a pitch: 25% shows as 3/12', () => {
    expect(formatAngle(slope('25%'), { unit: 'pitch', slope: true })).toBe('3/12');
    expect(formatAngle(slope('50%'), { unit: 'pitch', slope: true })).toBe('6/12');
  });

  it('applies to the whole term before it, like the colon', () => {
    expect(slope('2*12.5%')).toBeCloseTo(Math.atan(0.25), 12);
    expect(slope('#grade%')).toBeCloseTo(Math.atan(0.25), 12);
    expect(slope('(#ratio*100)%')).toBeCloseTo(Math.atan(0.25), 12);
  });

  it('combines with + and - like any angle, and works in parentheses', () => {
    expect(slope('25% + 2°')).toBeCloseTo(Math.atan(0.25) + 2 * DEG, 12);
    expect(slope('6:12 - 25%')).toBeCloseTo(PITCH_6_12 - Math.atan(0.25), 12);
    expect(slope('(25%)*2')).toBeCloseTo(2 * Math.atan(0.25), 12);
    expect(slope('max(25%, 4:12)')).toBeCloseTo(Math.atan(4 / 12), 12);
  });

  it.each<[string, QuantityKind, boolean, string, string, string]>([
    [
      '25%',
      'angle',
      false,
      'syntax',
      'A percent is a slope, and is allowed only in a slope field',
      '25%',
    ],
    [
      '25%',
      'length',
      false,
      'syntax',
      'A percent is a slope, and is allowed only in a slope field',
      '25%',
    ],
    [
      '25%',
      'length',
      true,
      'syntax',
      'A percent is a slope, and is allowed only in a slope field',
      '25%',
    ],
    [
      '25%',
      'number',
      false,
      'syntax',
      'A percent is a slope, and is allowed only in a slope field',
      '25%',
    ],
    [
      '6:12 + 25%',
      'angle',
      false,
      'syntax',
      'A percent is a slope, and is allowed only in a slope field',
      '25%',
    ],
    ['25mm%', 'angle', true, 'dimension', 'A percent slope needs a number, got a length', '25mm%'],
    ['25%%', 'angle', true, 'syntax', "Unexpected '%'", '%'],
    ['%', 'angle', true, 'syntax', "Unexpected '%'", '%'],
    ['25%:4', 'angle', true, 'syntax', 'Write a slope as a percent or as rise:run, not both', ':'],
    ['6:12%', 'angle', true, 'syntax', 'Write a slope as rise:run or as a percent, not both', '%'],
    [
      '6/12%',
      'angle',
      true,
      'syntax',
      'In a slope field rise/run is already a pitch: write it without % (6/12), or as a percent (50%)',
      '6/12%',
    ],
    [
      '2° + 50/2%',
      'angle',
      true,
      'syntax',
      'In a slope field rise/run is already a pitch: write it without % (6/12), or as a percent (50%)',
      '50/2%',
    ],
    ['6/0%', 'angle', true, 'domain', "A pitch's run must be greater than zero", '0'],
    [
      '25%*2',
      'angle',
      true,
      'syntax',
      "A percent applies to everything before it up to '+' or '-': write (25%)*…",
      '*',
    ],
    [
      '25%/2',
      'angle',
      true,
      'syntax',
      "A percent applies to everything before it up to '+' or '-': write (25%)/…",
      '/',
    ],
  ])('%j as %s (slope %s) is a %s error', (source, kind, isSlope, code, message, text) => {
    expect(failure(source, kind, { slope: isSlope })).toMatchObject({ code, message, text });
  });

  it('is an error without an expected kind', () => {
    expect(unwrapError(evaluateQuantity('25%')).code).toBe('syntax');
  });
});

describe('formatAngle as a pitch', () => {
  it.each<[number, number | undefined, string, string]>([
    [6, undefined, '6/12', '6:12'],
    [7.5, undefined, '7.5/12', '7.5:12'],
    [12, undefined, '12/12', '12:12'],
    [4, undefined, '4/12', '4:12'],
    [0, undefined, '0/12', '0:12'],
    [-6, undefined, '-6/12', '-6:12'],
    [6.126, undefined, '6.13/12', '6.13:12'],
    [6.125, 3, '6.125/12', '6.125:12'],
    [6.4, 0, '6/12', '6:12'],
  ])('rise %f (decimals %s) gives %j and %j', (rise, decimals, withSlope, without) => {
    const rad = Math.atan(rise / 12);
    const format = decimals === undefined ? {} : { decimals };
    expect(formatAngle(rad, { unit: 'pitch', slope: true, ...format })).toBe(withSlope);
    expect(formatAngle(rad, { unit: 'pitch', slope: false, ...format })).toBe(without);
    expect(formatAngle(rad, { unit: 'pitch', ...format })).toBe(without);
  });

  it('takes another run', () => {
    expect(formatAngle(Math.atan(0.5), { unit: 'pitch', run: 100, slope: true })).toBe('50/100');
    expect(formatAngle(Math.atan(0.5), { unit: 'pitch', run: 1 })).toBe('0.5:1');
    expect(formatAngle(Math.atan(0.5), { unit: 'pitch', run: 0 })).toBe('6:12');
    expect(formatAngle(Math.atan(0.5), { unit: 'pitch', run: Number.NaN })).toBe('6:12');
  });

  it('falls back to degrees where a pitch cannot show the angle', () => {
    expect(formatAngle(Math.PI / 2, { unit: 'pitch', slope: true })).toBe('90.00°');
    expect(formatAngle(Math.PI / 2 - 1e-16, { unit: 'pitch', slope: true })).toBe('90.00°');
    expect(formatAngle(89.999999 * DEG, { unit: 'pitch', slope: true })).toBe('90.00°');
    expect(formatAngle(89.95 * DEG, { unit: 'pitch' })).toBe('89.95°');
    expect(formatAngle(-89.95 * DEG, { unit: 'pitch' })).toBe('-89.95°');
    expect(formatAngle(-120 * DEG, { unit: 'pitch' })).toBe('-120.00°');
    expect(formatAngle(Number.NaN, { unit: 'pitch' })).toBe('NaN');
  });

  it('shows a pitch up to 89.9°', () => {
    expect(formatAngle(89.9 * DEG, { unit: 'pitch', slope: true })).toBe('6875.49/12');
    expect(formatAngle(-89.9 * DEG, { unit: 'pitch' })).toBe('-6875.49:12');
    expect(formatAngle(89 * DEG, { unit: 'pitch', slope: true })).toBe('687.48/12');
  });

  it('never shows -0', () => {
    expect(formatAngle(-1e-9, { unit: 'pitch', slope: true })).toBe('0/12');
  });

  it('round-trips from 1° to 60° under the same slope option', () => {
    for (let deg = 1; deg <= 60; deg += 0.5) {
      for (const isSlope of [true, false]) {
        const text = formatAngle(deg * DEG, { unit: 'pitch', slope: isSlope });
        const parsed = unwrap(evaluate(text, { expected: 'angle', slope: isSlope }));
        // parses to the displayed value: the rise as shown, over 12
        const shownRise = Number(text.split(isSlope ? '/' : ':')[0]);
        expect(parsed).toBeCloseTo(Math.atan(shownRise / 12), 12);
        // which formats to the same text, and is within the display rounding of the input
        expect(formatAngle(parsed, { unit: 'pitch', slope: isSlope })).toBe(text);
        expect(Math.abs(Math.tan(parsed) * 12 - Math.tan(deg * DEG) * 12)).toBeLessThanOrEqual(
          0.005 + 1e-9,
        );
      }
    }
  });

  it('slope-field output is not a pitch in an ordinary angle field, so the option must match', () => {
    const text = formatAngle(PITCH_6_12, { unit: 'pitch', slope: true });
    expect(angle(text)).toBeCloseTo(0.5 * DEG, 12);
    expect(slope(formatAngle(PITCH_6_12, { unit: 'pitch' }))).toBeCloseTo(PITCH_6_12, 12);
  });
});

describe('slopeDisplayUnit', () => {
  it('shows pitch under ft-in and in-fraction, and the angle unit otherwise', () => {
    expect(slopeDisplayUnit('ft-in')).toBe('pitch');
    expect(slopeDisplayUnit('in-fraction')).toBe('pitch');
    expect(slopeDisplayUnit('mm')).toBe('deg');
    expect(slopeDisplayUnit('in')).toBe('deg');
    expect(slopeDisplayUnit('m', 'rad')).toBe('rad');
  });
});
