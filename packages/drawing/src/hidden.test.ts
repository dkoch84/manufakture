import { describe, expect, it } from 'vitest';
import { BRACKET_FRONT, BRACKET_RIGHT, BRACKET_TOP } from './fixtures';
import { TAU, curveLength, type Curve2 } from './geometry';
import { removeHiddenUnderVisible, uncoveredParts, type ViewEdge } from './hidden';

const line = (a: [number, number], b: [number, number]): Curve2 => ({ kind: 'line', a, b });
const hiddenLength = (edges: readonly ViewEdge[]) =>
  edges.filter((e) => !e.visible).reduce((s, e) => s + curveLength(e.curve), 0);

describe('uncoveredParts', () => {
  it('keeps the parts of a hidden line outside collinear visible lines', () => {
    const parts = uncoveredParts(
      line([0, 0], [100, 0]),
      [line([20, 0], [40, 0]), line([80, 0], [30, 0])],
      0.01,
    );
    expect(parts).toEqual([line([0, 0], [20, 0]), line([80, 0], [100, 0])]);
    // Touching at an end only, or covered to within the tolerance: no change, or nothing left.
    expect(uncoveredParts(line([0, 0], [10, 0]), [line([10, 0], [20, 0])], 0.01)).toEqual([
      line([0, 0], [10, 0]),
    ]);
    expect(uncoveredParts(line([0, 0], [10, 0]), [line([0.005, 0.004], [9.995, 0])], 0.01)).toEqual(
      [],
    );
  });

  it('works on reversed and diagonal lines', () => {
    const parts = uncoveredParts(line([10, 10], [0, 0]), [line([0, 0], [5, 5])], 0.001);
    expect(parts).toHaveLength(1);
    const p = parts[0]!;
    if (p.kind !== 'line') throw new Error('expected a line');
    expect(p.a).toEqual([10, 10]);
    expect(p.b[0]).toBeCloseTo(5, 12);
    expect(p.b[1]).toBeCloseTo(5, 12);
  });

  it('leaves lines that are parallel but apart, or crossing', () => {
    const h = line([0, 0], [10, 0]);
    expect(uncoveredParts(h, [line([0, 0.5], [10, 0.5]), line([5, -5], [5, 5])], 0.01)).toEqual([
      h,
    ]);
  });

  it('removes a hidden circle under the same visible circle, and trims arcs', () => {
    const circle = { kind: 'arc', center: [0, 0], radius: 5, start: 0, end: TAU } as const;
    expect(uncoveredParts(circle, [circle], 0.01)).toEqual([]);
    const half = {
      kind: 'arc',
      center: [0, 0],
      radius: 5,
      start: Math.PI / 2,
      end: (3 * Math.PI) / 2,
    } as const;
    const parts = uncoveredParts(circle, [half], 0.01);
    // What is left wraps through angle 0: one arc, not two.
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'arc', radius: 5 });
    if (parts[0]!.kind !== 'arc') return;
    expect(parts[0]!.start).toBeCloseTo(-Math.PI / 2, 12);
    expect(parts[0]!.end).toBeCloseTo(Math.PI / 2, 12);
    // A different radius covers nothing.
    expect(uncoveredParts(circle, [{ ...circle, radius: 5.1 }], 0.01)).toEqual([circle]);
  });

  it('matches an ellipse described with its axis turned by a half turn', () => {
    const e = {
      kind: 'ellipseArc',
      center: [0, 0],
      major: 5,
      minor: 2,
      rotation: 0.3,
      start: 0,
      end: Math.PI,
    } as const;
    const same = { ...e, rotation: 0.3 + Math.PI, start: Math.PI, end: TAU };
    expect(uncoveredParts(e, [same], 0.01)).toEqual([]);
    expect(uncoveredParts(e, [{ ...e, rotation: 0.3 + Math.PI }], 0.01)).toEqual([e]);
  });

  it('drops the covered segments of a polyline', () => {
    const poly: Curve2 = {
      kind: 'polyline',
      points: [
        [0, 1],
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 1],
      ],
    };
    const parts = uncoveredParts(poly, [line([0, 0], [10, 0])], 0.01);
    expect(parts).toEqual([
      {
        kind: 'polyline',
        points: [
          [0, 1],
          [0, 0],
        ],
      },
      {
        kind: 'polyline',
        points: [
          [10, 0],
          [10, 1],
        ],
      },
    ]);
  });
});

describe('removeHiddenUnderVisible on the bracket', () => {
  it('keeps every visible edge and the hidden lines nothing covers', () => {
    const front = removeHiddenUnderVisible(BRACKET_FRONT);
    expect(front.filter((e) => e.visible)).toEqual(BRACKET_FRONT.filter((e) => e.visible));
    // Per hole: 2 x 1.6 + 2 x 4.4 + 8 = 20 mm of hidden lines that show; the circles seen edge on
    // (4.5 + 8 mm per hole) lie under the outline.
    expect(hiddenLength(BRACKET_FRONT)).toBeCloseTo(2 * (20 + 12.5), 9);
    expect(hiddenLength(front)).toBeCloseTo(2 * 20, 9);
  });

  it('drops hidden circles under visible ones and outline edges under the outline', () => {
    const top = removeHiddenUnderVisible(BRACKET_TOP);
    expect(top.filter((e) => !e.visible)).toEqual([]);
    // Both holes project onto the same hidden lines in the right view: drawn once.
    const right = removeHiddenUnderVisible(BRACKET_RIGHT);
    expect(hiddenLength(right)).toBeCloseTo(20, 9);
    expect(right.filter((e) => !e.visible)).toHaveLength(5);
  });
});

describe('removeHiddenUnderVisible: coincident hidden edges', () => {
  const hidden = (curve: Curve2, item = 0): ViewEdge => ({
    item,
    cls: 'sharp',
    visible: false,
    curve,
  });

  it('draws a hidden line once, keeping the first edge and the parts that stick out', () => {
    const out = removeHiddenUnderVisible([
      hidden(line([0, 0], [10, 0]), 0),
      hidden(line([10, 0], [0, 0]), 1),
      hidden(line([5, 0], [15, 0]), 2),
      hidden(line([0, 1], [10, 1]), 3),
    ]);
    expect(out).toEqual([
      hidden(line([0, 0], [10, 0]), 0),
      hidden(line([10, 0], [15, 0]), 2),
      hidden(line([0, 1], [10, 1]), 3),
    ]);
  });

  it('draws a hidden circle once, and leaves visible duplicates alone', () => {
    const circle = { kind: 'arc', center: [0, 0], radius: 5, start: 0, end: TAU } as const;
    const visible: ViewEdge = {
      item: 0,
      cls: 'sharp',
      visible: true,
      curve: line([20, 0], [30, 0]),
    };
    const out = removeHiddenUnderVisible([
      hidden(circle),
      hidden({ ...circle, start: 1, end: 1 + TAU }),
      visible,
      visible,
    ]);
    expect(out).toEqual([hidden(circle), visible, visible]);
  });
});
