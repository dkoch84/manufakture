import { describe, expect, it } from 'vitest';
import { expectPoseClose, randomPose, rng } from './test-helpers';
import {
  IDENTITY,
  compose,
  exp,
  invert,
  log,
  quatFromAxisAngle,
  quatFromRotationVector,
  rotateVector,
  rotationVector,
  transformPoint,
  type Twist,
} from './transform';

describe('rigid transforms', () => {
  it('composes as "b, then a"', () => {
    const a = {
      translation: [10, 0, 0] as const,
      rotation: quatFromAxisAngle([0, 0, 1], Math.PI / 2),
    };
    const b = { translation: [0, 5, 0] as const, rotation: IDENTITY.rotation };
    const ab = compose(a, b);
    // b moves (0,0,0) to (0,5,0); a turns that to (-5,0,0) and moves it to (5,0,0).
    expect(transformPoint(ab, [0, 0, 0])[0]).toBeCloseTo(5, 12);
    expect(transformPoint(ab, [0, 0, 0])[1]).toBeCloseTo(0, 12);
    expect(transformPoint(ab, [1, 0, 0])[1]).toBeCloseTo(1, 12);
  });

  it('rotates vectors by hand-computed quaternions', () => {
    const q = quatFromAxisAngle([1, 0, 0], Math.PI / 2);
    const v = rotateVector(q, [0, 1, 0]);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(1, 12);
  });

  it('inverts: p * p^-1 is the identity', () => {
    const r = rng(1);
    for (let i = 0; i < 100; i++) {
      const p = randomPose(r);
      expectPoseClose(compose(p, invert(p)), IDENTITY, 1e-12);
      expectPoseClose(compose(invert(p), p), IDENTITY, 1e-12);
    }
  });

  it('round-trips rotation vectors, including near zero and near pi', () => {
    for (const v of [
      [0, 0, 0],
      [1e-9, 0, 0],
      [0, 1e-5, 2e-5],
      [0.3, -0.2, 0.1],
      [0, 0, Math.PI - 1e-7],
    ] as const) {
      const back = rotationVector(quatFromRotationVector(v));
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(v[k]!, 9);
    }
  });

  it('exp and log are inverse (randomised)', () => {
    const r = rng(2);
    for (let i = 0; i < 200; i++) {
      const p = randomPose(r);
      expectPoseClose(exp(log(p)), p, 1e-9);
      const xi: Twist = [r() * 10 - 5, r() * 10 - 5, r() * 10 - 5, r() - 0.5, r() - 0.5, r() - 0.5];
      const back = log(exp(xi));
      for (let k = 0; k < 6; k++) expect(back[k]).toBeCloseTo(xi[k]!, 9);
    }
  });

  it('exp of a pure rotation twist about z through the origin is that rotation', () => {
    const p = exp([0, 0, 0, 0, 0, Math.PI / 2]);
    expectPoseClose(p, {
      translation: [0, 0, 0],
      rotation: quatFromAxisAngle([0, 0, 1], Math.PI / 2),
    });
    // A twist with translation along the axis is a screw: t = rho for rho parallel to phi.
    const s = exp([0, 0, 3, 0, 0, 1]);
    expect(s.translation[2]).toBeCloseTo(3, 12);
  });
});
