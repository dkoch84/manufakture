import { describe, expect, it } from 'vitest';
import {
  isValidSketchId,
  sketchIdProblem,
  splitAncestors,
  splitIds,
  splitParent,
  splitSuffix,
} from './ids';
import type { ArcEntity } from './model';
import { splitEntity } from './split';
import { arc, circle, line, point } from './test-helpers';

describe('sketch ids', () => {
  it.each(['e1', 'c12', 'line_3', 'a.b-c', 'e2#a', 'e2#a#b', 'e2#zz', 'E'])('accepts %s', (id) => {
    expect(isValidSketchId(id)).toBe(true);
    expect(sketchIdProblem(id)).toBeNull();
  });

  it.each([
    ['e2#1', /reserved for positional kernel splits/],
    ['e2#a#12', /reserved for positional kernel splits/],
    ['e2#1a', /reserved/],
    ['', /empty/],
    ['e 1', /must be/],
    ['a:b', /must be/],
    ['a|b', /must be/],
    ['e#', /must be/],
    ['#a', /must be/],
    ['e2#A', /must be/],
    ['(e1)', /must be/],
    ['@origin', /must be/],
  ])('rejects %j', (id, why) => {
    expect(isValidSketchId(id)).toBe(false);
    expect(sketchIdProblem(id)).toMatch(why);
  });

  it('never produces an id ending in #<digits>', () => {
    for (const id of ['e1', 'e2#a', 'x']) {
      for (const piece of splitIds(id, 30)) {
        expect(piece).not.toMatch(/#\d+$/);
        expect(isValidSketchId(piece)).toBe(true);
      }
    }
  });
});

describe('split ids', () => {
  it('names pieces a, b, ... then aa, ab (bijective base 26)', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(splitSuffix)).toEqual([
      'a',
      'b',
      'z',
      'aa',
      'ab',
      'az',
      'ba',
      'zz',
      'aaa',
    ]);
    expect(() => splitSuffix(-1)).toThrow(RangeError);
    expect(() => splitSuffix(1.5)).toThrow(RangeError);
  });

  it('appends a suffix per split, so a split of a split descends from both', () => {
    expect(splitIds('e2', 2)).toEqual(['e2#a', 'e2#b']);
    expect(splitIds('e2#a', 3)).toEqual(['e2#a#a', 'e2#a#b', 'e2#a#c']);
    expect(splitParent('e2#a#b')).toBe('e2#a');
    expect(splitParent('e2')).toBeNull();
    expect(splitAncestors('e2#a#b')).toEqual(['e2#a', 'e2']);
    expect(splitAncestors('e2')).toEqual([]);
  });

  it('refuses bad input', () => {
    expect(() => splitIds('e#1', 2)).toThrow(/reserved/);
    expect(() => splitIds('e1', 1)).toThrow(RangeError);
  });
});

describe('splitEntity', () => {
  it('splits a line in order along it, projecting the points', () => {
    const pieces = splitEntity(line('e2', [0, 0], [10, 0], true), [
      [7, 1],
      [3, -1],
    ]);
    expect(pieces).toEqual([
      { id: 'e2#a', kind: 'line', construction: true, start: [0, 0], end: [3, 0] },
      { id: 'e2#b', kind: 'line', construction: true, start: [3, 0], end: [7, 0] },
      { id: 'e2#c', kind: 'line', construction: true, start: [7, 0], end: [10, 0] },
    ]);
  });

  it('splits an arc counter-clockwise from its start', () => {
    const [a, b] = splitEntity(arc('a1', [0, 0], [5, 0], [-5, 0]), [0, 9]);
    expect(a).toMatchObject({ id: 'a1#a', kind: 'arc', center: [0, 0], start: [5, 0] });
    expect(b).toMatchObject({ id: 'a1#b', kind: 'arc', end: [-5, 0] });
    const mid = (a as ArcEntity).end;
    expect(mid[0]).toBeCloseTo(0, 12);
    expect(mid[1]).toBeCloseTo(5, 12);
  });

  it('splits an arc that crosses angle pi', () => {
    // From 90 to 270 degrees through 180.
    const pieces = splitEntity(arc('a', [0, 0], [0, 2], [0, -2]), [[-3, 0]]);
    expect(pieces.map((p) => p.id)).toEqual(['a#a', 'a#b']);
    const end = (pieces[0] as ArcEntity).end;
    expect(end[0]).toBeCloseTo(-2, 12);
  });

  it('splits a circle at two or more points into arcs', () => {
    const pieces = splitEntity(circle('c', [0, 0], 1), [
      [0, -1],
      [0, 1],
    ]);
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => p.kind)).toEqual(['arc', 'arc']);
    // Ordered from angle 0: the piece starting at 90 degrees comes first.
    const first = pieces[0] as ArcEntity;
    expect(first.start[1]).toBeCloseTo(1, 12);
    expect(first.end[1]).toBeCloseTo(-1, 12);
  });

  it('refuses splits that do not cut the entity', () => {
    expect(() => splitEntity(line('l', [0, 0], [10, 0]), [0, 0])).toThrow(/outside/);
    expect(() => splitEntity(line('l', [0, 0], [10, 0]), [12, 0])).toThrow(/outside/);
    expect(() => splitEntity(arc('a', [0, 0], [1, 0], [0, 1]), [-1, -1])).toThrow(/outside/);
    expect(() => splitEntity(circle('c', [0, 0], 1), [1, 0])).toThrow(/two distinct points/);
    expect(() => splitEntity(point('p', [0, 0]), [0, 0])).toThrow(/Cannot split point/);
  });
});
