import { describe, expect, it } from 'vitest';
import { angleQuantity, lengthQuantity, numberQuantity, type QuantityKind } from './dimension';
import { evaluate, type VariableLookup } from './evaluate';
import type { UnitsErrorCode } from './result';
import { unwrapError } from './test-helpers';

const variables: VariableLookup = (name) =>
  ({
    thickness: lengthQuantity(18),
    count: numberQuantity(3),
    slope: angleQuantity(0.5),
  })[name];

describe('errors', () => {
  // [source, expected kind, code, message, highlighted text]
  it.each<[string, QuantityKind, UnitsErrorCode, string, string]>([
    // syntax
    ['', 'length', 'syntax', 'Enter a value', ''],
    ['   ', 'length', 'syntax', 'Enter a value', ''],
    ['2 +', 'length', 'syntax', "Expected a value after '+'", '+'],
    ['2 * * 3', 'length', 'syntax', "Unexpected '*'", '*'],
    ['(2 + 3', 'length', 'syntax', 'Missing closing parenthesis', '('],
    ['min(2, 3', 'length', 'syntax', 'Missing closing parenthesis', '('],
    ['2 + 3)', 'length', 'syntax', "Unmatched ')'", ')'],
    ['()', 'length', 'syntax', "Expected a value before ')'", ')'],
    ['(2 +)', 'length', 'syntax', "Expected a value before ')'", ')'],
    ['2 thickness', 'length', 'syntax', "Missing operator before 'thickness'", 'thickness'],
    ['2 3', 'length', 'syntax', "Missing operator before '3'", '3'],
    ['thickness (2)', 'length', 'unknown-function', "Unknown function 'thickness'", 'thickness'],
    ['#thickness(2)', 'length', 'syntax', "Missing operator before '('", '('],
    ['2mm 3', 'length', 'syntax', "Missing operator before '3'", '3'],
    ["3' 2mm", 'length', 'syntax', "Missing operator before '2'", '2'],
    ['1 + 2 @ 3', 'length', 'syntax', "Unexpected character '@'", '@'],
    ['#', 'length', 'syntax', "Expected a variable name after '#'", '#'],
    ['# thickness', 'length', 'syntax', "Expected a variable name after '#'", '#'],
    ['"', 'length', 'syntax', `Unexpected '"'`, '"'],
    ['min(1,)', 'length', 'syntax', "Expected a value before ')'", ')'],
    // units
    ['2xyz', 'length', 'unknown-unit', "Unknown unit 'xyz'", 'xyz'],
    ['1 + 2furlongs', 'length', 'unknown-unit', "Unknown unit 'furlongs'", 'furlongs'],
    ['2pi', 'number', 'unknown-unit', "Unknown unit 'pi'; write '2*pi' to multiply", 'pi'],
    ['1.5pi * r', 'number', 'unknown-unit', "Unknown unit 'pi'; write '1.5*pi' to multiply", 'pi'],
    // variables and functions
    ['width', 'length', 'unknown-variable', "Unknown variable 'width'", 'width'],
    ['2 * #width + 1', 'length', 'unknown-variable', "Unknown variable '#width'", '#width'],
    ['foo(2)', 'length', 'unknown-function', "Unknown function 'foo'", 'foo'],
    ['sqrt(1, 2)', 'length', 'arity', 'sqrt() takes 1 argument, got 2', 'sqrt(1, 2)'],
    ['min()', 'length', 'arity', 'min() takes at least 1 argument, got 0', 'min()'],
    [
      'round(1, 2, 3)',
      'length',
      'arity',
      'round() takes 1 to 2 arguments, got 3',
      'round(1, 2, 3)',
    ],
    // dimensions
    [
      'thickness * thickness',
      'length',
      'dimension',
      'Expected a length but got an area (length^2)',
      'thickness * thickness',
    ],
    [
      '  2mm * 3mm  ',
      'length',
      'dimension',
      'Expected a length but got an area (length^2)',
      '2mm * 3mm',
    ],
    [
      '1 + thickness * 2mm',
      'length',
      'dimension',
      'Cannot add a number and an area (length^2)',
      '1 + thickness * 2mm',
    ],
    [
      'thickness + 30deg',
      'length',
      'dimension',
      'Cannot add a length and an angle',
      'thickness + 30deg',
    ],
    [
      '1 + (thickness - slope)',
      'length',
      'dimension',
      'Cannot subtract an angle from a length',
      '(thickness - slope)',
    ],
    ['thickness', 'angle', 'dimension', 'Expected an angle but got a length', 'thickness'],
    ['30deg', 'length', 'dimension', 'Expected a length but got an angle', '30deg'],
    ['3mm', 'number', 'dimension', 'Expected a number but got a length', '3mm'],
    [
      'count / thickness',
      'length',
      'dimension',
      'Expected a length but got a value of dimension length^-1',
      'count / thickness',
    ],
    [
      'sqrt(thickness)',
      'length',
      'dimension',
      'Expected a length but got a value of dimension length^0.5',
      'sqrt(thickness)',
    ],
    [
      '2 ^ thickness',
      'number',
      'dimension',
      'An exponent must be a number, got a length',
      'thickness',
    ],
    ['2^3mm', 'number', 'dimension', 'An exponent must be a number, got a length', '3mm'],
    ['sin(thickness)', 'number', 'dimension', 'sin() expects an angle, got a length', 'thickness'],
    ['asin(slope)', 'angle', 'dimension', 'asin() expects a number, got an angle', 'slope'],
    [
      'min(1mm, 2deg)',
      'length',
      'dimension',
      'min() arguments must have the same dimension: got a length and an angle',
      '2deg',
    ],
    [
      'round(thickness, 1deg)',
      'length',
      'dimension',
      'round() step must have the same dimension as the value: got a length and an angle',
      '1deg',
    ],
    ['(2mm)in', 'length', 'dimension', "Cannot apply unit 'in' to a length", '(2mm)in'],
    [
      '1 / 8"',
      'length',
      'dimension',
      'Expected a length but got a value of dimension length^-1',
      '1 / 8"',
    ],
    [
      'slope * thickness',
      'length',
      'dimension',
      'Expected a length but got a value of dimension length*angle',
      'slope * thickness',
    ],
    // domain
    ['1 / (thickness - 18)', 'number', 'domain', 'Division by zero', '(thickness - 18)'],
    ['1/0"', 'length', 'domain', 'Division by zero', '0"'],
    ['sqrt(-4)', 'number', 'domain', 'sqrt() of a negative value', '-4'],
    ['(-8) ^ 0.5', 'number', 'domain', 'Fractional power of a negative value', '(-8) ^ 0.5'],
    ['asin(2)', 'angle', 'domain', 'asin() is only defined between -1 and 1', '2'],
    ['10 ^ 400', 'number', 'domain', 'Result is not a finite number', '10 ^ 400'],
    // overflow is reported where it happens, even if later operations would hide it
    ['1e400', 'number', 'domain', 'Number is too large', '1e400'],
    ['1/1e400', 'number', 'domain', 'Number is too large', '1e400'],
    ['min(1e400, 5)', 'number', 'domain', 'Number is too large', '1e400'],
    ['1e400mm', 'length', 'domain', 'Number is too large', '1e400mm'],
    ['1e308ft', 'length', 'domain', 'Number is too large', '1e308ft'],
    ['1 / (10 ^ 400)', 'number', 'domain', 'Result is not a finite number', '(10 ^ 400)'],
    ['1e300 * 1e300 / 1e300', 'number', 'domain', 'Result is not a finite number', '1e300 * 1e300'],
    ['min(1e200 * 1e200, 5)', 'number', 'domain', 'Result is not a finite number', '1e200 * 1e200'],
    ['1e308 * 2 - 1e308', 'number', 'domain', 'Result is not a finite number', '1e308 * 2'],
    ['round(3, 0)', 'number', 'domain', 'round() step must not be zero', '0'],
  ])('%j as %s -> %s', (source, expected, code, message, highlighted) => {
    const error = unwrapError(evaluate(source, { expected, variables }));
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(source.slice(error.start, error.end)).toBe(highlighted);
  });

  it.each<[string, string]>([
    ['1e307', '1e307'],
    ['1e307 + 1mm', '1e307 + 1mm'],
  ])('reports overflow from reading %j in the display unit', (source, highlighted) => {
    const error = unwrapError(evaluate(source, { expected: 'length', lengthUnit: 'ft' }));
    expect(error.code).toBe('domain');
    expect(error.message).toBe('Result is not a finite number');
    expect(source.slice(error.start, error.end)).toBe(highlighted);
  });

  it('rejects non-finite variable values where they are used', () => {
    const lookup: VariableLookup = (name) =>
      name === 'broken' ? lengthQuantity(Infinity) : lengthQuantity(1);
    const error = unwrapError(
      evaluate('min(broken, a) * 0', { expected: 'length', variables: lookup }),
    );
    expect(error.code).toBe('domain');
    expect([error.start, error.end]).toEqual([4, 10]);
  });

  describe('nesting limits', () => {
    // [description, source, message, highlighted]
    it.each<[string, string, string, string]>([
      [
        '5000 parentheses',
        '('.repeat(5000) + '1' + ')'.repeat(5000),
        'Expression is nested too deeply (more than 256 levels)',
        '(',
      ],
      [
        '5000 unary minuses',
        '-'.repeat(5000) + '1',
        'Expression is nested too deeply (more than 256 levels)',
        '-',
      ],
      [
        '5000 nested calls',
        'abs('.repeat(5000) + '1' + ')'.repeat(5000),
        'Expression is nested too deeply (more than 256 levels)',
        'abs',
      ],
      [
        '5000 chained powers',
        '1' + '^1'.repeat(5000),
        'Expression is nested too deeply (more than 256 levels)',
        '1',
      ],
    ])('%s -> syntax error', (_, source, message, highlighted) => {
      const error = unwrapError(evaluate(source, { expected: 'number' }));
      expect(error.code).toBe('syntax');
      expect(error.message).toBe(message);
      expect(source.slice(error.start, error.end)).toBe(highlighted);
    });

    it('rejects a very long operator chain instead of overflowing the stack', () => {
      const source = Array.from({ length: 5000 }, () => '1').join(' + ');
      const error = unwrapError(evaluate(source, { expected: 'number' }));
      expect(error.code).toBe('syntax');
      expect(error.message).toBe('Expression is too complex (more than 1024 levels)');
    });

    it('accepts nesting up to the limit', () => {
      const parens = '('.repeat(200) + '1' + ')'.repeat(200);
      expect(evaluate(parens, { expected: 'number' })).toEqual({ ok: true, value: 1 });
      const sum = Array.from({ length: 1000 }, () => '1').join(' + ');
      expect(evaluate(sum, { expected: 'number' })).toEqual({ ok: true, value: 1000 });
    });
  });

  it('reports the first error in source order', () => {
    const error = unwrapError(evaluate('a + b', { expected: 'length' }));
    expect([error.start, error.end]).toEqual([0, 1]);
  });

  it('never throws on arbitrary input', () => {
    const alphabet = [
      '1',
      '2',
      '/',
      '-',
      ' ',
      "'",
      '"',
      '(',
      ')',
      'in',
      'x',
      '#',
      '^',
      '*',
      '.',
      ',',
    ];
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 2000; n++) {
      let source = '';
      const length = Math.floor(random() * 10);
      for (let i = 0; i < length; i++) source += alphabet[Math.floor(random() * alphabet.length)];
      const result = evaluate(source, { expected: 'length', lengthUnit: 'in' });
      if (!result.ok) {
        expect(result.error.start).toBeGreaterThanOrEqual(0);
        expect(result.error.end).toBeLessThanOrEqual(source.length);
        expect(result.error.start).toBeLessThanOrEqual(result.error.end);
      } else {
        expect(Number.isFinite(result.value)).toBe(true);
      }
    }
  });
});
