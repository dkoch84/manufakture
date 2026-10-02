import { describe, expect, it } from 'vitest';
import {
  FEED,
  SPINDLE_SPEED,
  TIME,
  feedQuantity,
  lengthQuantity,
  numberQuantity,
  spindleSpeedQuantity,
  timeQuantity,
  type Dimension,
  type Quantity,
  type QuantityKind,
} from './dimension';
import {
  evaluate,
  evaluateQuantity,
  parseFeed,
  parseSpindleSpeed,
  type EvaluateOptions,
  type VariableLookup,
} from './evaluate';
import { formatFeed, formatSpindleSpeed, type FeedFormat } from './format';
import * as api from './index';
import { findReferences } from './references';
import type { UnitsErrorCode } from './result';
import { unwrap, unwrapError } from './test-helpers';
import type { LengthUnit } from './units';

const IN = 25.4;
const FT = 304.8;

const VARIABLES: ReadonlyMap<string, Quantity> = new Map([
  ['chipload', lengthQuantity(0.05)],
  ['flutes', numberQuantity(2)],
  ['rpm', spindleSpeedQuantity(18000)],
  ['feed', feedQuantity(1500)],
  ['thickness', lengthQuantity(18)],
  ['s', numberQuantity(4)],
  ['MIN', numberQuantity(5)],
  ['dwell', timeQuantity(0.5)],
]);
const variables: VariableLookup = (name) => VARIABLES.get(name);

function run(source: string, expected: QuantityKind, extra: Partial<EvaluateOptions> = {}) {
  return unwrap(evaluate(source, { expected, variables, ...extra }));
}

function expectDimension(actual: Dimension, expected: Dimension) {
  expect(actual.length).toBeCloseTo(expected.length, 12);
  expect(actual.angle).toBeCloseTo(expected.angle, 12);
  expect(actual.time ?? 0).toBeCloseTo(expected.time ?? 0, 12);
}

describe('parseFeed', () => {
  it.each<[string, LengthUnit, number]>([
    // units per minute and per second
    ['1000mm/min', 'mm', 1000],
    ['1000mm/min', 'in', 1000],
    ['1000 mm/min', 'mm', 1000],
    ['1000 mm / min', 'mm', 1000],
    ['1000MM/min', 'mm', 1000],
    ['1000 mm/min^1', 'mm', 1000],
    ['40in/min', 'mm', 40 * IN],
    ['40 in/min', 'mm', 40 * IN],
    ['40"/min', 'mm', 40 * IN],
    ['1.5 m/min', 'mm', 1500],
    ['10cm/min', 'mm', 100],
    ['2ft/min', 'mm', 2 * FT],
    ["3'/min", 'mm', 3 * FT],
    [`3' 4"/min`, 'mm', 40 * IN],
    // seconds: attach `s` to a number and divide by it
    ['25mm / 1s', 'mm', 1500],
    ['25mm/1s', 'mm', 1500],
    ['25mm/(1s)', 'mm', 1500],
    ['1in / 1s', 'mm', 60 * IN],
    ['1e3mm/min', 'mm', 1000],
    ['1/8"/min', 'mm', IN / 8],
    ['4-1/2"/min', 'mm', 4.5 * IN],
    ['(500 + 100)mm/min', 'mm', 600],
    ['(10)in/min', 'mm', 10 * IN],
    ['-1000mm/min', 'mm', -1000],
    // division by a time
    ['1000mm / 1min', 'mm', 1000],
    ['1500mm / 60s', 'mm', 1500],
    ['1000mm / (2 min)', 'mm', 500],
    // bare numbers are display length units per minute
    ['600', 'mm', 600],
    ['600', 'in', 600 * IN],
    ['2', 'ft', 2 * FT],
    ['600 + 100mm/min', 'mm', 700],
    ['40in/min + 10', 'in', 50 * IN],
    // arithmetic keeps dimensions
    ['2 * 500mm/min', 'mm', 1000],
    ['2000mm/min / 2', 'mm', 1000],
    ['min(1000mm/min, 40in/min)', 'mm', 1000],
    ['max(1000mm/min, 40in/min)', 'mm', 40 * IN],
    ['max(500, 40in/min)', 'mm', 40 * IN],
  ])('%j (display %s) = %f mm/min', (input, unit, expected) => {
    expect(unwrap(parseFeed(input, unit))).toBeCloseTo(expected, 9);
  });
});

describe('parseSpindleSpeed', () => {
  it.each<[string, number]>([
    ['18000rpm', 18000],
    ['18000 rpm', 18000],
    ['18000RPM', 18000],
    ['12000/min', 12000],
    ['12000 / min', 12000],
    ['1/2/min', 0.5],
    ['300 / 1s', 18000],
    ['(9000 * 2)rpm', 18000],
    ['18000', 18000],
    ['18000 - 1000rpm', 17000],
    ['max(10000, 12000rpm)', 12000],
    ['1e4rpm', 10000],
  ])('%j = %f rpm', (input, expected) => {
    expect(unwrap(parseSpindleSpeed(input))).toBeCloseTo(expected, 9);
  });
});

describe('evaluate with feed and spindleSpeed', () => {
  it.each<[string, QuantityKind, number, Partial<EvaluateOptions>?]>([
    // the chip load formula: length * number * (1/time) is a feed
    ['#chipload * #flutes * #rpm', 'feed', 0.05 * 2 * 18000],
    ['chipload * flutes * rpm', 'feed', 1800],
    ['#chipload * #flutes * 18000rpm', 'feed', 1800],
    ['0.002in * 2 * 18000rpm', 'feed', 0.002 * IN * 2 * 18000],
    // and back again
    ['#feed / (#flutes * #rpm)', 'length', 1500 / 36000],
    ['#feed / #chipload / #flutes', 'spindleSpeed', 15000],
    ['#feed * #dwell', 'length', 750],
    ['#feed + 100', 'feed', 1600],
    ['#feed + 100', 'feed', 1500 + 100 * IN, { lengthUnit: 'in' }],
    ['#rpm - 1000', 'spindleSpeed', 17000],
    ['2 * #rpm', 'spindleSpeed', 36000],
    // round, floor and ceil work in display units per minute and whole rpm
    ['round(1016.3mm/min)', 'feed', 1016],
    ['round(1016.3mm/min)', 'feed', 40 * IN, { lengthUnit: 'in' }],
    ['floor(17999.6rpm)', 'spindleSpeed', 17999],
    ['round(#feed, 100mm/min)', 'feed', 1500],
    ['ceil(1234mm/min, 100)', 'feed', 1300],
    // times are intermediate values
    ['30s / 1min', 'number', 0.5],
    ['#dwell * #rpm', 'number', 9000],
  ])('%j as %s = %f', (source, kind, expected, extra = {}) => {
    expect(run(source, kind, extra)).toBeCloseTo(expected, 9);
  });

  it('results are never -0', () => {
    expect(Object.is(run('0 * -1000mm/min', 'feed'), 0)).toBe(true);
    expect(Object.is(run('-0', 'spindleSpeed'), 0)).toBe(true);
  });

  it.each<[string, Dimension, number]>([
    ['5 min', TIME, 5],
    ['5min', TIME, 5],
    ['90s', TIME, 1.5],
    ['min', TIME, 1],
    ['1000mm/min', FEED, 1000],
    ['18000rpm', SPINDLE_SPEED, 18000],
    ['12000/min', SPINDLE_SPEED, 12000],
    ['1000mm/min * 2min', { length: 1, angle: 0 }, 2000],
    // the time unit binds to the number before it, like a fraction literal or `x/2in`
    ['#thickness / 2mm/min', TIME, 9],
    ['#thickness/2mm/min', TIME, 9],
    // `/s` after a bare number is still division by a variable called `s`
    ['8/2/s', { length: 0, angle: 0 }, 1],
    ['8 / s', { length: 0, angle: 0 }, 2],
    // and after a unit too: `/s` is never a per-time suffix, so old expressions keep their meaning
    ['100mm/s', { length: 1, angle: 0 }, 25],
    ['100mm / s', { length: 1, angle: 0 }, 25],
    // only lowercase `min` is the minute standalone or after `/`; `MIN` is a variable
    ['100mm/MIN', { length: 1, angle: 0 }, 20],
    ['12000/MIN', { length: 0, angle: 0 }, 2400],
    ['MIN', { length: 0, angle: 0 }, 5],
    // after a number, word units are case-insensitive
    ['5MIN', TIME, 5],
    ['5 Min', TIME, 5],
    ['30S', TIME, 0.5],
    // `/min` binds to the number before it, and a power applies to the whole literal
    ['#s/2/min', TIME, 2],
    ['#s / 2/min', TIME, 2],
    // with integers on both sides of the first slash it is a fraction literal, as for `1/8"`
    ['10/2/min', SPINDLE_SPEED, 5],
    ['1000mm/min^2', { length: 2, angle: 0, time: -2 }, 1e6],
  ])('quantity %j', (source, dimension, value) => {
    const q = unwrap(evaluateQuantity(source, { variables }));
    expect(q.value).toBeCloseTo(value, 12);
    expectDimension(q.dimension, dimension);
  });

  it('min is a call when followed by "(" and the minute otherwise', () => {
    const shortest = unwrap(evaluateQuantity('min(5min, 3min)'));
    expect(shortest.value).toBe(3);
    expectDimension(shortest.dimension, TIME);
    expect(unwrap(evaluateQuantity('min (2, 1)')).value).toBe(1);
    expect(unwrap(evaluate('min(1000, 12000/min)', { expected: 'spindleSpeed' }))).toBe(1000);
  });

  it('keeps dimensions without time exactly as before', () => {
    expect(unwrap(evaluateQuantity('2mm * 3mm')).dimension).toEqual({ length: 2, angle: 0 });
    expect(unwrap(evaluateQuantity('1000mm/min * 1min')).dimension).toEqual({
      length: 1,
      angle: 0,
    });
  });

  it('per-time literals are not variable references', () => {
    expect(unwrap(findReferences('1000mm/min + 12000/min + x / min')).map((r) => r.name)).toEqual([
      'x',
    ]);
    expect(unwrap(findReferences('8/2/s')).map((r) => r.name)).toEqual(['s']);
    expect(unwrap(findReferences('2 * rpm')).map((r) => r.name)).toEqual(['rpm']);
  });
});

describe('feed and speed errors', () => {
  // [source, expected kind, code, message, highlighted text]
  it.each<[string, QuantityKind, UnitsErrorCode, string, string]>([
    [
      '1000mm',
      'feed',
      'dimension',
      'Expected a feed rate (length/time) but got a length',
      '1000mm',
    ],
    [
      ' 18000rpm ',
      'feed',
      'dimension',
      'Expected a feed rate (length/time) but got a spindle speed (1/time)',
      '18000rpm',
    ],
    [
      '1000mm/min',
      'spindleSpeed',
      'dimension',
      'Expected a spindle speed (1/time) but got a feed rate (length/time)',
      '1000mm/min',
    ],
    ['5min', 'number', 'dimension', 'Expected a number but got a time', '5min'],
    ['min', 'length', 'dimension', 'Expected a length but got a time', 'min'],
    ['30deg', 'feed', 'dimension', 'Expected a feed rate (length/time) but got an angle', '30deg'],
    [
      '2 + 1000mm/min + 5mm',
      'feed',
      'dimension',
      'Cannot add a feed rate (length/time) and a length',
      '2 + 1000mm/min + 5mm',
    ],
    [
      '18000rpm - 1min',
      'spindleSpeed',
      'dimension',
      'Cannot subtract a time from a spindle speed (1/time)',
      '18000rpm - 1min',
    ],
    [
      '#chipload * #flutes',
      'feed',
      'dimension',
      'Expected a feed rate (length/time) but got a length',
      '#chipload * #flutes',
    ],
    [
      '#thickness * 2min',
      'feed',
      'dimension',
      'Expected a feed rate (length/time) but got a value of dimension length*time',
      '#thickness * 2min',
    ],
    [
      '#rpm * #rpm',
      'spindleSpeed',
      'dimension',
      'Expected a spindle speed (1/time) but got a value of dimension time^-2',
      '#rpm * #rpm',
    ],
    [
      '2^1mm/min',
      'number',
      'dimension',
      'An exponent must be a number, got a feed rate (length/time)',
      '1mm/min',
    ],
    ['(2mm)mm/min', 'feed', 'dimension', "Cannot apply unit 'mm/min' to a length", '(2mm)mm/min'],
    [
      'max(#feed, 18000rpm)',
      'feed',
      'dimension',
      'max() arguments must have the same dimension: got a feed rate (length/time) and a spindle speed (1/time)',
      '18000rpm',
    ],
    // `min` after a number followed by '(' is a call, never "5 minutes"
    [
      '5min(3)',
      'number',
      'syntax',
      "Missing operator: write '5*min(…)' to call min(), or '5min' alone for the unit",
      'min',
    ],
    ['5 min (3)', 'number', 'syntax', "Missing operator before 'min'", 'min'],
    // `mm/min(3)` is `mm / min(3)`, a length
    [
      '1000mm/min(3)',
      'feed',
      'dimension',
      'Expected a feed rate (length/time) but got a length',
      '1000mm/min(3)',
    ],
    // `/s` needs a unit before it, so a bare `12000/s` reads `s` as a variable
    ['12000/s', 'spindleSpeed', 'unknown-variable', "Unknown variable 's'", 's'],
    ['100mm/s', 'feed', 'unknown-variable', "Unknown variable 's'", 's'],
    // the call hint is only for `min`, the unit that is also a function
    ['5s(3)', 'number', 'unknown-unit', "Unknown unit 's'", 's'],
    ['1000mm/sec', 'feed', 'unknown-variable', "Unknown variable 'sec'", 'sec'],
    ['4-1/2/s', 'feed', 'syntax', "Ambiguous: write '4 1/2', '4-1/2\"' or '4 - 1/2'", '4-1/2'],
  ])('%j as %s -> %s', (source, expected, code, message, highlighted) => {
    const lookup: VariableLookup = (name) => (name === 's' ? undefined : variables(name));
    const error = unwrapError(evaluate(source, { expected, variables: lookup }));
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(source.slice(error.start, error.end)).toBe(highlighted);
  });
});

describe('formatFeed', () => {
  it.each<[number, FeedFormat | undefined, string]>([
    [1000, undefined, '1000 mm/min'],
    [1000, { unit: 'mm' }, '1000 mm/min'],
    [1000.4, { unit: 'mm', decimals: 1 }, '1000.4 mm/min'],
    [1000, { unit: 'cm' }, '100.0 cm/min'],
    [1500, { unit: 'm' }, '1.500 m/min'],
    [40 * IN, { unit: 'in' }, '40.0 in/min'],
    [1000, { unit: 'in' }, '39.4 in/min'],
    [1000, { unit: 'ft' }, '3.28 ft/min'],
    [40 * IN, { unit: 'ft-in' }, '40.0 in/min'],
    [40 * IN, { unit: 'in-fraction', decimals: 0 }, '40 in/min'],
    [-0.1, {}, '0 mm/min'],
    [-500, {}, '-500 mm/min'],
    [NaN, {}, 'NaN'],
    [Infinity, { unit: 'in' }, 'Infinity'],
  ])('%f mm/min as %j = %j', (value, format, expected) => {
    expect(formatFeed(value, format)).toBe(expected);
  });
});

describe('formatSpindleSpeed', () => {
  it.each<[number, number | undefined, string]>([
    [18000, undefined, '18000 rpm'],
    [12000.4, undefined, '12000 rpm'],
    [12000.25, 1, '12000.3 rpm'],
    [-0.2, undefined, '0 rpm'],
    [-Infinity, undefined, '-Infinity'],
  ])('%f rpm with %s decimals = %j', (value, decimals, expected) => {
    expect(formatSpindleSpeed(value, decimals)).toBe(expected);
  });
});

describe('format -> parse round trip', () => {
  const feeds = [0, 1, 100, 762, 1000, 1016, 1234.5678, 2540, 5000, -250, 0.4];
  const formats: FeedFormat[] = [
    { unit: 'mm' },
    { unit: 'mm', decimals: 3 },
    { unit: 'cm' },
    { unit: 'm' },
    { unit: 'in' },
    { unit: 'in', decimals: 3 },
    { unit: 'ft' },
    { unit: 'ft-in' },
    { unit: 'in-fraction' },
  ];
  const displayUnits: LengthUnit[] = ['mm', 'in', 'ft'];

  // Reparsing the text must give exactly the rounded value, whatever the bare-number unit.
  it.each(formats.flatMap((format) => feeds.map((v) => [v, format] as const)))(
    '%f mm/min as %j',
    (value, format) => {
      const text = formatFeed(value, format);
      for (const unit of displayUnits) {
        const reparsed = unwrap(parseFeed(text, unit));
        expect(formatFeed(reparsed, format)).toBe(text);
      }
    },
  );

  it('ft-in and in-fraction documents show and read inches per minute', () => {
    for (const unit of ['ft-in', 'in-fraction'] as const) {
      const text = formatFeed(40 * IN, { unit });
      expect(text).toBe('40.0 in/min');
      expect(unwrap(parseFeed(text, 'in'))).toBeCloseTo(40 * IN, 9);
      // the bare-number unit under both is 'in'
      expect(unwrap(parseFeed('40', 'in'))).toBeCloseTo(40 * IN, 9);
    }
  });

  it.each([0, 1, 9000, 12000, 18000, 24000.6, -5])('%f rpm', (rpm) => {
    for (const decimals of [0, 2]) {
      const text = formatSpindleSpeed(rpm, decimals);
      expect(formatSpindleSpeed(unwrap(parseSpindleSpeed(text)), decimals)).toBe(text);
    }
  });
});

describe('exports', () => {
  it('exposes the feed and speed API from the package root', () => {
    expect(api.parseFeed).toBe(parseFeed);
    expect(api.parseSpindleSpeed).toBe(parseSpindleSpeed);
    expect(api.formatFeed).toBe(formatFeed);
    expect(api.formatSpindleSpeed).toBe(formatSpindleSpeed);
    expect(api.SECONDS_PER_MINUTE).toBe(60);
    expect(api.feedQuantity(5)).toEqual({ value: 5, dimension: FEED });
    expect(api.spindleSpeedQuantity(5)).toEqual({ value: 5, dimension: SPINDLE_SPEED });
    expect(api.timeQuantity(5)).toEqual({ value: 5, dimension: TIME });
  });
});
