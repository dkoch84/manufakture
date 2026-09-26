import { describe, expect, it } from 'vitest';
import {
  isSubId,
  parseAnyId,
  parseFeatureId,
  parseSubId,
  peekCounter,
  previewIds,
  splitIds,
} from './ids';

describe('parseFeatureId', () => {
  it.each([
    ['extrude#1', { counter: 'extrude', n: 1, split: '' }],
    ['fillet#12', { counter: 'fillet', n: 12, split: '' }],
    ['extension#3', { counter: 'extension', n: 3, split: '' }],
    ['extrude#0', undefined],
    ['extrude#01', undefined],
    ['extrude', undefined],
    ['Extrude#1', undefined],
    ['extrude#1:cap:end', undefined],
    ['e1', undefined],
    ['e1#a', undefined],
  ])('%s', (id, expected) => {
    expect(parseFeatureId(id)).toEqual(expected);
  });
});

describe('parseSubId', () => {
  it.each([
    ['e1', { counter: 'e', n: 1, split: '' }],
    ['k27', { counter: 'k', n: 27, split: '' }],
    ['r3', { counter: 'r', n: 3, split: '' }],
    ['e2#a', { counter: 'e', n: 2, split: '#a' }],
    ['e2#b#aa', { counter: 'e', n: 2, split: '#b#aa' }],
    ['e0', undefined],
    ['x1', undefined],
    ['e2#1', undefined],
    ['e2#', undefined],
    ['e', undefined],
    ['extrude#1', undefined],
  ])('%s', (id, expected) => {
    expect(parseSubId(id)).toEqual(expected);
  });

  it('never overlaps with feature ids', () => {
    for (const id of ['e1', 'e1#a', 'extrude#1', 'r#1']) {
      expect(parseFeatureId(id) !== undefined && parseSubId(id) !== undefined).toBe(false);
    }
    expect(parseAnyId('r#1')).toEqual({ counter: 'r', n: 1, split: '' });
  });

  it('checks the prefix', () => {
    expect(isSubId('e1#a', 'e')).toBe(true);
    expect(isSubId('e1', 'k')).toBe(false);
    expect(isSubId('r1', 'r')).toBe(true);
  });
});

describe('counters', () => {
  it('start at 1 and preview without allocating', () => {
    const nextIds = { extrude: 3, e: 7 };
    expect(peekCounter(nextIds, 'fillet')).toBe(1);
    expect(previewIds(nextIds, 'extrude')).toEqual(['extrude#3']);
    expect(previewIds(nextIds, 'e', 3)).toEqual(['e7', 'e8', 'e9']);
    expect(previewIds(nextIds, 'r', 2)).toEqual(['r1', 'r2']);
    expect(nextIds).toEqual({ extrude: 3, e: 7 });
  });

  it('names split pieces a, b, ... z, aa, ab', () => {
    expect(splitIds('e2', 3)).toEqual(['e2#a', 'e2#b', 'e2#c']);
    const many = splitIds('e1', 28);
    expect(many.slice(24)).toEqual(['e1#y', 'e1#z', 'e1#aa', 'e1#ab']);
    expect(new Set(splitIds('e1', 1000)).size).toBe(1000);
    for (const id of many) expect(parseSubId(id)?.n).toBe(1);
  });
});
