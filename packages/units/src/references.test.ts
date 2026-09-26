import { describe, expect, it } from 'vitest';
import { findReferences, isValidVariableName } from './references';
import { unwrap, unwrapError } from './test-helpers';

describe('findReferences', () => {
  it.each<[string, string[]]>([
    ['12mm', []],
    ['thickness', ['thickness']],
    ['2*#thickness + 1/8"', ['thickness']],
    ['a + b * a', ['a', 'b', 'a']],
    ['max(#w, min(h, 3in)) - d', ['w', 'h', 'd']],
    ['pi * r ^ 2', ['r']],
    ['#pi * 2', ['pi']],
    ['sqrt(x)', ['x']],
    ['(depth)mm', ['depth']],
    ['2 * in', ['in']],
  ])('%j -> %j', (source, names) => {
    expect(unwrap(findReferences(source)).map((r) => r.name)).toEqual(names);
  });

  it('reports positions and whether # was used', () => {
    expect(unwrap(findReferences('#width - 2*t'))).toEqual([
      { name: 'width', hashed: true, start: 0, end: 6 },
      { name: 't', hashed: false, start: 11, end: 12 },
    ]);
  });

  it('includes references to unknown functions arguments and fails only on syntax errors', () => {
    expect(unwrap(findReferences('foo(a)')).map((r) => r.name)).toEqual(['a']);
    expect(unwrapError(findReferences('a +')).code).toBe('syntax');
  });
});

describe('isValidVariableName', () => {
  it.each<[string, boolean]>([
    ['thickness', true],
    ['_x2', true],
    ['in', true],
    ['2x', false],
    ['', false],
    ['a-b', false],
    ['#a', false],
    ['pi', false],
    ['sqrt', false],
    ['min', false],
  ])('%j -> %s', (name, valid) => {
    expect(isValidVariableName(name)).toBe(valid);
  });
});
