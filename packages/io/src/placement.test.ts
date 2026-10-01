import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MATRIX,
  composeMatrices,
  isIdentity,
  matrixDeterminant,
  placementMatrix,
  transformMesh,
  type Matrix3x4,
  type Placement,
} from './placement';
import { meshProperties } from './mesh';
import { boxMesh } from './test-helpers';

/** `[x y z 1] M` in 3MF's row-vector order. */
const apply = (m: Matrix3x4, p: [number, number, number]) =>
  [0, 1, 2].map((c) => p[0] * m[c]! + p[1] * m[3 + c]! + p[2] * m[6 + c]! + m[9 + c]!);

const quarterAboutZ: Placement = {
  translation: [10, 20, 30],
  rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
};

describe('placementMatrix', () => {
  it('is the identity for no motion, and a translation alone', () => {
    expect(placementMatrix({ translation: [0, 0, 0], rotation: [0, 0, 0, 1] })).toEqual([
      ...IDENTITY_MATRIX,
    ]);
    expect(
      apply(placementMatrix({ translation: [1, 2, 3], rotation: [0, 0, 0, 1] }), [1, 1, 1]),
    ).toEqual([2, 3, 4]);
  });

  it('turns, then moves, in the row-vector order 3MF writes', () => {
    const m = placementMatrix(quarterAboutZ);
    // A quarter turn about z takes x to y; then the translation.
    apply(m, [1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([10, 21, 30][i]!, 12));
    apply(m, [0, 1, 0]).forEach((v, i) => expect(v).toBeCloseTo([9, 20, 30][i]!, 12));
    // Rows are the images of the axes.
    [0, 1, 0].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 12));
    expect(matrixDeterminant(m)).toBeCloseTo(1, 12);
  });

  it('normalises the quaternion, and refuses a zero one', () => {
    const m = placementMatrix({ translation: [0, 0, 0], rotation: [0, 0, 2, 2] });
    expect(matrixDeterminant(m)).toBeCloseTo(1, 12);
    expect(() => placementMatrix({ translation: [0, 0, 0], rotation: [0, 0, 0, 0] })).toThrow(
      RangeError,
    );
  });
});

describe('composeMatrices and transformMesh', () => {
  it('composes as "a then b"', () => {
    const a = placementMatrix(quarterAboutZ);
    const b = placementMatrix({ translation: [0, 0, -5], rotation: [1, 0, 0, 0] });
    const ab = composeMatrices(a, b);
    const p: [number, number, number] = [3, -2, 7];
    const viaBoth = apply(b, apply(a, p) as [number, number, number]);
    apply(ab, p).forEach((v, i) => expect(v).toBeCloseTo(viaBoth[i]!, 12));
    expect(isIdentity(composeMatrices(IDENTITY_MATRIX, IDENTITY_MATRIX))).toBe(true);
  });

  it('moves the vertices, keeps the triangles and the volume', () => {
    const box = boxMesh([0, 0, 0], [10, 20, 5]);
    const moved = transformMesh(box, placementMatrix(quarterAboutZ));
    expect(moved.indices).toBe(box.indices);
    const p = meshProperties(moved);
    expect(p.volume).toBeCloseTo(1000, 6);
    // x 0..10 turns to y 0..10, y 0..20 to x -20..0; then (10, 20, 30).
    p.boundingBox!.min.forEach((v, i) => expect(v).toBeCloseTo([-10, 20, 30][i]!, 4));
    p.boundingBox!.max.forEach((v, i) => expect(v).toBeCloseTo([10, 30, 35][i]!, 4));
  });
});
