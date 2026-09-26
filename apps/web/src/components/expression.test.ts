import type { DisplayUnits } from '@manufakture/core';
import { angleQuantity, lengthQuantity, numberQuantity } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import {
  analyzeExpression,
  applyCompletion,
  completionToken,
  formatQuantity,
  highlightParts,
  matchingNames,
  moveActive,
  worthOffering,
} from './expression';

const MM: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const FT_IN: DisplayUnits = { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } };
const vars = {
  w: lengthQuantity(40),
  width: lengthQuantity(50),
  slope: angleQuantity(Math.PI / 6),
  n: numberQuantity(3),
};

describe('analyzeExpression', () => {
  it('evaluates with units and variables, formatted in the display units', () => {
    expect(analyzeExpression('2*#w + 1/2"', 'length', MM, vars)).toMatchObject({
      state: 'ok',
      value: 92.7,
      formatted: '92.70 mm',
      expression: { source: '2*#w + 1/2"', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    // Bare numbers mean inches under ft-in.
    expect(analyzeExpression(' 4 1/2 ', 'length', FT_IN, vars)).toMatchObject({
      state: 'ok',
      value: 114.3,
      formatted: '4-1/2"',
      expression: { source: '4 1/2', lengthUnit: 'in' },
    });
    expect(analyzeExpression('#slope', 'angle', MM, vars)).toMatchObject({ formatted: '30.00°' });
    expect(analyzeExpression('#n * 2.5', 'number', MM, vars)).toMatchObject({ formatted: '7.5' });
    expect(analyzeExpression('#w * #width', 'any', MM, vars)).toMatchObject({
      state: 'ok',
      formatted: '2000 mm^2',
    });
    expect(analyzeExpression('   ', 'length', MM, vars)).toEqual({ state: 'empty' });
  });

  it('points at an unknown variable, in the untrimmed text', () => {
    const a = analyzeExpression('  2 * #nope', 'length', MM, vars);
    expect(a).toMatchObject({ state: 'error', code: 'unknown-variable', start: 6, end: 11 });
    expect(highlightParts('  2 * #nope', a)).toEqual({
      before: '  2 * ',
      error: '#nope',
      after: '',
    });
  });

  it('refuses the wrong kind of value, and says which', () => {
    const a = analyzeExpression('#w + 5deg', 'length', MM, vars);
    expect(a).toMatchObject({ state: 'error', code: 'dimension' });
    expect(a.state === 'error' && a.message).toMatch(/length/);
    expect(analyzeExpression('#slope', 'length', MM, vars)).toMatchObject({
      state: 'error',
      code: 'dimension',
      message: 'Expected a length but got an angle',
    });
  });

  it('gives a parse error its range', () => {
    const a = analyzeExpression('(2 + 3', 'length', MM, vars);
    expect(a).toMatchObject({ state: 'error', code: 'syntax', start: 0, end: 1 });
    const b = analyzeExpression('2 +', 'length', MM, vars);
    expect(highlightParts('2 +', b)).toEqual({ before: '2 ', error: '+', after: '' });
  });

  it('runs the extra check on the value', () => {
    const positive = (v: number) => (v > 0 ? null : 'Must be more than zero.');
    expect(analyzeExpression('-#w', 'length', MM, vars, positive)).toMatchObject({
      state: 'error',
      code: 'value',
      message: 'Must be more than zero.',
    });
    expect(highlightParts('-#w', analyzeExpression('-#w', 'length', MM, vars, positive))).toBe(
      null,
    );
  });
});

describe('formatQuantity', () => {
  it('shows lengths, angles and numbers as such, and anything else in mm and rad', () => {
    expect(formatQuantity(lengthQuantity(25.4), MM)).toBe('25.40 mm');
    expect(formatQuantity(numberQuantity(3), MM)).toBe('3');
    expect(formatQuantity({ value: 0.5, dimension: { length: -1, angle: 1 } }, MM)).toBe(
      '0.5 mm^-1 rad',
    );
  });
});

describe('completion', () => {
  it('finds the #name at the caret, and only hashed names', () => {
    expect(completionToken('2*#wi', 5)).toEqual({ start: 2, end: 5, prefix: 'wi' });
    expect(completionToken('2*#', 3)).toEqual({ start: 2, end: 3, prefix: '' });
    // The caret inside a name: the whole name is replaced.
    expect(completionToken('#width + 1', 3)).toEqual({ start: 0, end: 6, prefix: 'wi' });
    expect(completionToken('12 mm', 5)).toBeNull();
    expect(completionToken('#w + 1', 6)).toBeNull();
    expect(completionToken('#1', 2)).toBeNull();
  });

  it('matches prefixes first, then substrings, case-insensitively', () => {
    const names = ['thickness', 'width', 'w', 'Wall', 'sweep'];
    expect(matchingNames(names, 'w')).toEqual(['w', 'width', 'Wall', 'sweep']);
    expect(matchingNames(names, '')).toEqual(names);
    expect(matchingNames(names, 'ck')).toEqual(['thickness']);
    expect(matchingNames(names, 'zz')).toEqual([]);
    // The name typed in full comes first.
    expect(matchingNames(['width', 'w'], 'w')).toEqual(['w', 'width']);
  });

  it('offers nothing when the only match is typed in full', () => {
    const token = completionToken('#w', 2)!;
    expect(worthOffering(['w'], token)).toBe(false);
    expect(worthOffering(['w', 'width'], token)).toBe(true);
    expect(worthOffering(['width'], token)).toBe(true);
    expect(worthOffering([], token)).toBe(false);
  });

  it('inserts the chosen name with its #, and puts the caret after it', () => {
    const text = '2*#wi + 1';
    const token = completionToken(text, 5)!;
    expect(applyCompletion(text, token, 'width')).toEqual({ text: '2*#width + 1', caret: 8 });
  });

  it('moves through the options, wrapping round', () => {
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(1, 3, 'ArrowUp')).toBe(0);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1);
  });
});
