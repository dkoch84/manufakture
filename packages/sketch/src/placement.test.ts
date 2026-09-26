import { describe, expect, it } from 'vitest';
import type { Vec3 } from './model';
import {
  XY_PLANE,
  XZ_PLANE,
  YZ_PLANE,
  cross3,
  distanceFromPlane,
  dot3,
  isValidPlacement,
  placementFrame,
  placementFromNormal,
  placementMatrix,
  sketchDirectionToWorld,
  sketchToWorld,
  worldToSketch,
} from './placement';

const closeVec = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 12));

describe('standard planes', () => {
  it('are valid and right-handed (y = normal x xDir)', () => {
    for (const p of [XY_PLANE, XZ_PLANE, YZ_PLANE]) {
      expect(isValidPlacement(p)).toBe(true);
      const f = placementFrame(p);
      closeVec(cross3(f.x, f.y), f.z);
    }
  });

  it('map sketch axes onto the expected world axes', () => {
    closeVec(sketchToWorld(XY_PLANE, [2, 3]), [2, 3, 0]);
    closeVec(sketchToWorld(XZ_PLANE, [2, 3]), [2, 0, 3]);
    closeVec(sketchToWorld(YZ_PLANE, [2, 3]), [0, 2, 3]);
  });
});

describe('placementFromNormal', () => {
  it('normalises, projects xDir into the plane and moves the origin', () => {
    const p = placementFromNormal([1, 2, 3], [0, 0, 5], [2, 0, 7]);
    expect(p).toEqual({ origin: [1, 2, 3], normal: [0, 0, 1], xDir: [1, 0, 0] });
    closeVec(sketchToWorld(p, [1, 1]), [2, 3, 3]);
  });

  it('picks a default x direction, also when xDir is parallel to the normal', () => {
    expect(placementFromNormal([0, 0, 0], [0, 0, 1]).xDir).toEqual([1, 0, 0]);
    const tilted = placementFromNormal([0, 0, 0], [1, 1, 1], [2, 2, 2]);
    expect(isValidPlacement(tilted)).toBe(true);
  });

  it('refuses a zero or non-finite normal', () => {
    expect(() => placementFromNormal([0, 0, 0], [0, 0, 0])).toThrow(/zero/);
    expect(() => placementFromNormal([0, 0, NaN], [0, 0, 1])).toThrow(/finite/);
  });
});

describe('mapping between sketch and world', () => {
  // A plane on a tilted face: normal (1, 1, 0)/sqrt2, x along world z.
  const p = placementFromNormal([10, -5, 2], [1, 1, 0], [0, 0, 1]);

  it('round trips points in the plane', () => {
    for (const q of [
      [0, 0],
      [3, -4],
      [12.5, 7.25],
    ] as const) {
      const w = sketchToWorld(p, q);
      expect(distanceFromPlane(p, w)).toBeCloseTo(0, 12);
      closeVec(worldToSketch(p, w), q);
    }
  });

  it('projects off-plane points along the normal', () => {
    const w = sketchToWorld(p, [3, 4]);
    const off: Vec3 = [w[0] + 5 * p.normal[0], w[1] + 5 * p.normal[1], w[2] + 5 * p.normal[2]];
    expect(distanceFromPlane(p, off)).toBeCloseTo(5, 12);
    closeVec(worldToSketch(p, off), [3, 4]);
  });

  it('maps directions without the origin, preserving length and angles', () => {
    const d = sketchDirectionToWorld(p, [3, 4]);
    expect(Math.hypot(...d)).toBeCloseTo(5, 12);
    expect(dot3(sketchDirectionToWorld(p, [1, 0]), sketchDirectionToWorld(p, [0, 1]))).toBeCloseTo(
      0,
      12,
    );
  });

  it('gives a column-major 4x4 matrix that agrees with sketchToWorld', () => {
    const m = placementMatrix(p);
    const [x, y] = [3, -2];
    const byMatrix = [0, 1, 2].map((r) => m[r]! * x + m[4 + r]! * y + m[12 + r]!);
    closeVec(byMatrix, sketchToWorld(p, [x, y]));
    expect(m[15]).toBe(1);
  });

  it('isValidPlacement rejects skewed frames', () => {
    expect(isValidPlacement({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0.1] })).toBe(
      false,
    );
    expect(isValidPlacement({ origin: [0, 0, 0], normal: [0, 0, 2], xDir: [1, 0, 0] })).toBe(false);
  });
});
