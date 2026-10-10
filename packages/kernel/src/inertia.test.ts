// The inertia arithmetic on its own (no kernel): principal axes of a general tensor, rotation,
// the parallel axis theorem and combining bodies. measure.test.ts checks it against the B-rep.

import { describe, expect, it } from 'vitest';
import {
  combineMassProperties,
  inertiaAt,
  inertiaReport,
  momentAboutAxis,
  placeMassProperties,
  principalInertia,
  rotateTensor,
  rotationMatrix,
  type MassProperties,
  type Matrix3,
} from './inertia';
import type { Vec3 } from './types';

function nearM(a: Matrix3, b: Matrix3, tol = 1e-9): void {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(a[r]![c]! - b[r]![c]!), `[${r}][${c}]`).toBeLessThanOrEqual(tol);
    }
  }
}

const GENERAL: Matrix3 = [
  [10, -2, 1],
  [-2, 8, -0.5],
  [1, -0.5, 5],
];

describe('principalInertia', () => {
  it('diagonalises a general tensor: Q diag(moments) Qᵀ gives it back', () => {
    const p = principalInertia(GENERAL);
    expect(p.moments[0]).toBeLessThanOrEqual(p.moments[1]);
    expect(p.moments[1]).toBeLessThanOrEqual(p.moments[2]);
    // The trace is kept.
    expect(p.moments[0] + p.moments[1] + p.moments[2]).toBeCloseTo(23, 12);
    // Rows of `axes` are the axes, so its transpose is Q.
    const Q: Matrix3 = [0, 1, 2].map((r) => [0, 1, 2].map((c) => p.axes[c]![r]!)) as never;
    const D: Matrix3 = [
      [p.moments[0], 0, 0],
      [0, p.moments[1], 0],
      [0, 0, p.moments[2]],
    ];
    nearM(rotateTensor(D, Q), GENERAL);
    // A right-handed frame: e1 x e2 = e3, each of unit length.
    for (const e of p.axes) expect(Math.hypot(...e)).toBeCloseTo(1, 12);
  });

  it('keeps the coordinate axes for a diagonal tensor, and for equal moments', () => {
    const p = principalInertia([
      [3, 0, 0],
      [0, 1, 0],
      [0, 0, 3],
    ]);
    expect(p.moments).toEqual([1, 3, 3]);
    expect(p.axes[0]).toEqual([0, 1, 0]);
  });
});

describe('placing and combining', () => {
  const block: MassProperties = {
    mass: 2,
    centerOfMass: [1, 2, 3],
    inertia: [
      [5, 0, 0],
      [0, 7, 0],
      [0, 0, 9],
    ],
  };

  it('normalises a quaternion; a quarter turn about Z maps X to Y', () => {
    const R = rotationMatrix([0, 0, 2, 2]);
    nearM(R, [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]);
    const placed = placeMassProperties(block, {
      translation: [10, 0, 0],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    });
    const c: Vec3 = [10 - 2, 1, 3];
    placed.centerOfMass.forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 12));
    expect(placed.inertia[0][0]).toBeCloseTo(7, 12);
    expect(placed.inertia[1][1]).toBeCloseTo(5, 12);
  });

  it('the parallel axis theorem: about the origin, and about a line', () => {
    const o = inertiaAt(block, [0, 0, 0]);
    // m (y² + z²) on Ixx, -m x y on the xy entry.
    expect(o[0][0]).toBeCloseTo(5 + 2 * (4 + 9), 12);
    expect(o[0][1]).toBeCloseTo(-2 * 1 * 2, 12);
    expect(momentAboutAxis(block, { origin: [0, 0, 0], direction: [0, 0, -4] })).toBeCloseTo(
      9 + 2 * (1 + 4),
      12,
    );
    expect(() => momentAboutAxis(block, { origin: [0, 0, 0], direction: [0, 0, 0] })).toThrow();
  });

  it('combines bodies about their common centre of mass; nothing weighs nothing', () => {
    const point = (x: number): MassProperties => ({
      mass: 1,
      centerOfMass: [x, 0, 0],
      inertia: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    const both = combineMassProperties([point(-1), point(3)])!;
    expect(both.mass).toBe(2);
    expect(both.centerOfMass).toEqual([1, 0, 0]);
    // Two unit masses 2 mm either side of the centre: 8 g·mm² about Y and Z, none about X.
    nearM(both.inertia, [
      [0, 0, 0],
      [0, 8, 0],
      [0, 0, 8],
    ]);
    expect(combineMassProperties([])).toBeNull();
    const report = inertiaReport(both, { origin: [1, 5, 0], direction: [1, 0, 0] });
    expect(report.aboutAxis).toBeCloseTo(2 * 25, 12);
    expect(report.principal.moments).toEqual([0, 8, 8]);
    expect('aboutAxis' in inertiaReport(both)).toBe(false);
  });
});
