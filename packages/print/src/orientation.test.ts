import { describe, expect, it } from 'vitest';
import { applyPlacement, rotateDirection, type Vec3 } from './geometry';
import {
  eulerRotation,
  layFlatRotation,
  lowestZ,
  orientationPlacement,
  orientationRotation,
} from './orientation';
import { boxFaces, meshFromFaces } from './test-helpers';

function expectVec(actual: Vec3, expected: Vec3, digits = 12) {
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, digits));
}

const turn = (q: ReturnType<typeof orientationRotation>, v: Vec3) =>
  rotateDirection({ rotation: q, translation: [0, 0, 0] }, v);

describe('layFlatRotation', () => {
  it('turns any normal to -z', () => {
    const normals: Vec3[] = [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
      [1, 2, 3],
      [-0.3, 0.1, -0.9],
      [1e-12, 0, 1], // nearly straight up
      [0, 5, 0], // not unit length
    ];
    for (const n of normals) {
      const l = Math.hypot(...n);
      expectVec(turn(layFlatRotation(n), [n[0] / l, n[1] / l, n[2] / l]), [0, 0, -1]);
    }
  });

  it('leaves a face already facing down alone and turns an upward face about x', () => {
    expect(layFlatRotation([0, 0, -1])).toEqual([0, 0, 0, 1]);
    expectVec(turn(layFlatRotation([0, 0, 1]), [0, 1, 0]), [0, -1, 0]);
    expectVec(turn(layFlatRotation([0, 0, 1]), [1, 0, 0]), [1, 0, 0]);
  });

  it('is the shortest rotation: a horizontal direction along the tilt axis is kept', () => {
    // Normal +x tilts about y; the y axis stays put.
    expectVec(turn(layFlatRotation([1, 0, 0]), [0, 1, 0]), [0, 1, 0]);
  });

  it('gives the identity for a zero normal', () => {
    expect(layFlatRotation([0, 0, 0])).toEqual([0, 0, 0, 1]);
  });
});

describe('eulerRotation', () => {
  it('rotates about the fixed x axis first, then y, then z', () => {
    const q = eulerRotation(Math.PI / 2, 0, Math.PI / 2);
    // x first: y -> z; then z: z stays.
    expectVec(turn(q, [0, 1, 0]), [0, 0, 1]);
    // x first: x stays; then z: x -> y.
    expectVec(turn(q, [1, 0, 0]), [0, 1, 0]);
  });

  it('matches Rz * Ry * Rx on a general vector', () => {
    const [a, b, c] = [0.3, -0.5, 1.2];
    const v: Vec3 = [0.2, -1.4, 0.7];
    const rx = (p: Vec3): Vec3 => [
      p[0],
      Math.cos(a) * p[1] - Math.sin(a) * p[2],
      Math.sin(a) * p[1] + Math.cos(a) * p[2],
    ];
    const ry = (p: Vec3): Vec3 => [
      Math.cos(b) * p[0] + Math.sin(b) * p[2],
      p[1],
      -Math.sin(b) * p[0] + Math.cos(b) * p[2],
    ];
    const rz = (p: Vec3): Vec3 => [
      Math.cos(c) * p[0] - Math.sin(c) * p[1],
      Math.sin(c) * p[0] + Math.cos(c) * p[1],
      p[2],
    ];
    expectVec(turn(eulerRotation(a, b, c), v), rz(ry(rx(v))));
  });
});

describe('orientationRotation', () => {
  it('is the identity as modelled', () => {
    expect(orientationRotation({ kind: 'asModelled' })).toEqual([0, 0, 0, 1]);
  });

  it('lays flat, then turns about z', () => {
    const q = orientationRotation({ kind: 'layFlat', normal: [1, 0, 0], turn: Math.PI / 2 });
    expectVec(turn(q, [1, 0, 0]), [0, 0, -1]);
    // Lay flat keeps y; the quarter turn about z takes y to -x.
    expectVec(turn(q, [0, 1, 0]), [-1, 0, 0]);
  });

  it('rotate is the Euler rotation', () => {
    expect(orientationRotation({ kind: 'rotate', x: 0.1, y: 0.2, z: 0.3 })).toEqual(
      eulerRotation(0.1, 0.2, 0.3),
    );
  });
});

describe('orientationPlacement', () => {
  const cube = meshFromFaces(boxFaces([5, 5, 5], [15, 15, 25]));

  it('drops the body to the bed as modelled, keeping x and y', () => {
    const p = orientationPlacement({ kind: 'asModelled' }, cube.positions);
    expect(p).toEqual({ rotation: [0, 0, 0, 1], translation: [0, 0, -5] });
  });

  it('puts the lowest point at z = 0 after lay-flat', () => {
    const p = orientationPlacement({ kind: 'layFlat', normal: [0, 0, 1] }, cube.positions);
    // Upside down: the top at z 25 goes to z -25, then up to 0.
    expect(p.translation[2]).toBeCloseTo(25, 12);
    expectVec(applyPlacement(p, [10, 10, 25]), [10, -10, 0]);
    expect(lowestZ(cube.positions, p.rotation) + p.translation[2]).toBeCloseTo(0, 12);
  });

  it('takes several meshes printed as one item', () => {
    const other = meshFromFaces(boxFaces([0, 0, -3], [1, 1, 0]));
    const p = orientationPlacement({ kind: 'asModelled' }, [cube.positions, other.positions]);
    expect(p.translation).toEqual([0, 0, 3]);
    expect(lowestZ([cube.positions, other.positions])).toBe(-3);
  });

  it('does not move a body with no points', () => {
    expect(orientationPlacement({ kind: 'asModelled' }, new Float32Array(0)).translation).toEqual([
      0, 0, 0,
    ]);
    expect(lowestZ([])).toBe(Infinity);
  });
});
