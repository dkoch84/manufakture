// `distance("a", "b")` and `angle("a", "b")`: quoted face names, answered by the context's
// measurements (task #1202).

import { describe, expect, it } from 'vitest';
import { ANGLE, DIMENSIONLESS, LENGTH } from './dimension';
import { evaluate, evaluateQuantity, type MeasureLookup, type MeasureRequest } from './evaluate';
import { tokenize } from './lexer';
import { parseExpression } from './parser';
import { findMeasures, findReferences, isValidVariableName } from './references';
import { unwrap, unwrapError } from './test-helpers';

const A = 'extension#1:cap:end{extension#11:groove:xmin}';
const B = 'extension#2:cap:start{extension#12:groove:xmin}';

/** Answers 573.0875 mm for every distance and 0 rad for every angle, recording the requests. */
function lookup(asked: MeasureRequest[] = []): MeasureLookup {
  return (r) => {
    asked.push(r);
    return { ok: true, value: r.fn === 'distance' ? 573.0875 : 0 };
  };
}

describe('quoted face names', () => {
  it('lexes a " that starts an argument as a string, anywhere else as an inch mark', () => {
    const kinds = unwrap(tokenize(`distance("${A}", "x") + 3"`)).map((t) => [t.kind, t.text]);
    expect(kinds).toEqual([
      ['ident', 'distance'],
      ['(', '('],
      ['string', A],
      [',', ','],
      ['string', 'x'],
      [')', ')'],
      ['op', '+'],
      ['number', '3'],
      ['inch-mark', '"'],
      ['eof', ''],
    ]);
    // `(3)"` is still three inches: the quote follows a `)`, not a `(`.
    expect(unwrap(evaluate('(3)"', { expected: 'length' }))).toBeCloseTo(76.2);
  });

  it('refuses an unterminated string', () => {
    expect(unwrapError(tokenize('distance("a, "b")'.slice(0, 11)))).toMatchObject({
      code: 'syntax',
      message: 'Missing closing quote',
      start: 9,
      end: 10,
    });
  });

  it('parses a string as a node with its text', () => {
    const p = unwrap(parseExpression('distance("a", "b")'));
    expect(p).toMatchObject({
      type: 'call',
      name: 'distance',
      args: [
        { type: 'string', value: 'a', start: 9, end: 12 },
        { type: 'string', value: 'b', start: 14, end: 17 },
      ],
    });
  });
});

describe('distance() and angle()', () => {
  it('reads a length from the measurements and composes with arithmetic', () => {
    const asked: MeasureRequest[] = [];
    const v = evaluate(`distance("${A}", "${B}") - 1in`, {
      expected: 'length',
      measure: lookup(asked),
    });
    expect(unwrap(v)).toBeCloseTo(573.0875 - 25.4);
    expect(asked).toEqual([{ fn: 'distance', faces: [A, B] }]);
  });

  it('is a length and an angle without an expected kind', () => {
    const d = unwrap(evaluateQuantity('distance("a", "b")', { measure: lookup() }));
    expect(d.dimension).toEqual(LENGTH);
    const a = unwrap(evaluateQuantity('angle("a", "b") + 5', { measure: lookup() }));
    expect(a.dimension).toEqual(ANGLE);
    expect(a.value).toBeCloseTo((5 * Math.PI) / 180);
  });

  it('works inside other functions and with variables', () => {
    const v = evaluate('max(distance("a", "b") / 2, #min_w)', {
      expected: 'length',
      measure: lookup(),
      variables: (n) => (n === 'min_w' ? { value: 100, dimension: LENGTH } : undefined),
    });
    expect(unwrap(v)).toBeCloseTo(286.54375);
  });

  it('is not-measured without measurements, and a measure error for a failed measurement', () => {
    expect(unwrapError(evaluate('distance("a", "b")', { expected: 'length' }))).toMatchObject({
      code: 'not-measured',
      message: 'distance() measures the model, and the model has not been measured here',
      start: 0,
      end: 18,
    });
    const lost: MeasureLookup = () => ({ ok: false, message: 'Face "a" is not found' });
    expect(
      unwrapError(evaluate('1 + distance("a", "b")', { expected: 'length', measure: lost })),
    ).toMatchObject({ code: 'measure', message: 'Face "a" is not found', start: 4, end: 22 });
  });

  it('refuses arguments that are not two face names', () => {
    const m = { expected: 'length' as const, measure: lookup() };
    expect(unwrapError(evaluate('distance("a")', m))).toMatchObject({ code: 'arity' });
    expect(unwrapError(evaluate('distance("a", "b", "c")', m))).toMatchObject({ code: 'arity' });
    expect(unwrapError(evaluate('distance("a", 3)', m))).toMatchObject({
      code: 'syntax',
      start: 14,
      end: 15,
    });
    expect(unwrapError(evaluate('distance("", "b")', m)).message).toBe('Enter a face name');
    expect(unwrapError(evaluate('max("a", 3)', m)).message).toBe(
      'A quoted face name is only an argument of distance() or angle()',
    );
    // A quote that cannot start an argument stays an inch mark, and here is out of place.
    expect(unwrapError(evaluate('distance(1"a", "b")', m)).code).toBe('syntax');
  });

  it('measured values are not dimensionless: `distance(...) * 2` is still a length', () => {
    expect(
      unwrap(evaluate('2 * distance("a", "b")', { expected: 'length', measure: lookup() })),
    ).toBeCloseTo(1146.175);
    expect(
      unwrapError(evaluate('distance("a", "b")', { expected: 'angle', measure: lookup() })).code,
    ).toBe('dimension');
  });
});

describe('findMeasures', () => {
  it('lists each call with its face names and their ranges', () => {
    const source = `max(distance("${A}", "b"), 1) + angle("c", "d")`;
    const found = unwrap(findMeasures(source));
    expect(found.map((m) => [m.fn, m.faces.map((f) => f.name)])).toEqual([
      ['distance', [A, 'b']],
      ['angle', ['c', 'd']],
    ]);
    for (const f of found.flatMap((m) => m.faces)) {
      expect(source.slice(f.start, f.end)).toBe(f.name);
    }
    expect(unwrap(findMeasures('#a + 2'))).toEqual([]);
  });

  it('variables are found next to them, never inside the quotes', () => {
    expect(unwrap(findReferences('distance("a", "b") - #gap')).map((r) => r.name)).toEqual(['gap']);
  });

  it('keeps `distance` and `angle` valid variable names, read bare', () => {
    expect(isValidVariableName('distance')).toBe(true);
    expect(isValidVariableName('angle')).toBe(true);
    const v = evaluate('distance * 2 + angle', {
      expected: 'number',
      variables: (n) => ({ value: n === 'distance' ? 3 : 1, dimension: DIMENSIONLESS }),
    });
    expect(unwrap(v)).toBe(7);
  });
});
