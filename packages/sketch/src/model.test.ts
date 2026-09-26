import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyCoordinates,
  coordinateCount,
  isDimensional,
  packCoordinates,
  valueKind,
  type SketchInput,
} from './model';
import { roundedRectangle } from './test-helpers';
import { arc, circle, deg, line, mm, point } from './test-helpers';

describe('the data model', () => {
  it('is plain data: a sketch survives a JSON round trip unchanged', () => {
    const sketch = roundedRectangle();
    expect(JSON.parse(JSON.stringify(sketch)) as SketchInput).toEqual(sketch);
  });

  it('model.ts has no runtime imports, so the document can hold sketches without the solver', () => {
    const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/^\s*(import|export) type\b/);
  });

  it('tells dimensional constraints and their value kinds apart', () => {
    expect(
      isDimensional({
        id: 'd',
        kind: 'distance',
        a: { entity: 'p' },
        b: { entity: 'q' },
        value: mm(1),
      }),
    ).toBe(true);
    expect(isDimensional({ id: 'h', kind: 'horizontal', line: 'l' })).toBe(false);
    expect(valueKind({ id: 'a', kind: 'angle', a: 'l', b: 'm', value: deg(3) })).toBe('angle');
    expect(valueKind({ id: 'r', kind: 'radius', entity: 'c', value: mm(3) })).toBe('length');
  });
});

describe('packed coordinates', () => {
  const entities = [
    point('p', [1, 2]),
    line('l', [3, 4], [5, 6]),
    circle('c', [7, 8], 9),
    arc('a', [10, 11], [12, 13], [14, 15], true),
  ];

  it('pack in entity order: point 2, line 4, circle 3, arc 6', () => {
    expect(entities.map((e) => coordinateCount(e.kind))).toEqual([2, 4, 3, 6]);
    expect(Array.from(packCoordinates(entities))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('unpack onto the entities, keeping ids and flags', () => {
    const coords = packCoordinates(entities).map((v) => v * 2);
    const out = applyCoordinates(entities, coords);
    expect(out[0]).toEqual(point('p', [2, 4]));
    expect(out[2]).toEqual(circle('c', [14, 16], 18));
    expect(out[3]).toEqual(arc('a', [20, 22], [24, 26], [28, 30], true));
    expect(applyCoordinates(entities, packCoordinates(entities))).toEqual(entities);
  });

  it('refuse a wrong length', () => {
    expect(() => applyCoordinates(entities, new Float64Array(3))).toThrow(
      /Expected 15 coordinates/,
    );
  });
});
