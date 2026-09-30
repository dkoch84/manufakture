import { describe, expect, it } from 'vitest';
import {
  MATE_KINDS,
  coordinateCount,
  coordinateTwist,
  extractCoordinates,
  jointTransform,
  retract,
  wrapAngle,
} from './mates';
import { randomPose, rng } from './test-helpers';
import { inv, mul, packPose, POSE, rotationLog } from './transform';

/** out = a b^-1 (only its rotation is used). */
function relativeRotationForTest(out: Float64Array, a: Float64Array, b: Float64Array): void {
  inv(out, 0, b, 0);
  mul(out, 0, a, 0, out, 0);
}

function randomCoordinates(kind: string, r: () => number, n: number): Float64Array {
  const q = new Float64Array(n);
  for (let k = 0; k < n; k++) q[k] = kind === 'ball' ? (r() - 0.5) * 2 : (r() - 0.5) * 6;
  return q;
}

describe('mate kinds', () => {
  for (const kind of MATE_KINDS) {
    const n = coordinateCount(kind);

    it(`${kind}: coordinates to transform and back (randomised)`, () => {
      const r = rng(n + kind.length);
      const J = new Float64Array(POSE);
      const back = new Float64Array(n);
      for (let i = 0; i < 100; i++) {
        const q = randomCoordinates(kind, r, n);
        jointTransform(kind, q, 0, J, 0);
        extractCoordinates(kind, J, 0, back, 0);
        for (let k = 0; k < n; k++) {
          const angular =
            kind === 'revolute' ||
            (kind === 'planar' && k === 2) ||
            (kind === 'cylindrical' && k === 1);
          const d = angular ? wrapAngle(back[k]! - q[k]!) : back[k]! - q[k]!;
          expect(Math.abs(d)).toBeLessThan(1e-12);
        }
      }
    });

    it(`${kind}: each coordinate's twist matches a finite difference`, () => {
      const r = rng(31 + n);
      const h = 1e-6;
      const G = new Float64Array(POSE);
      const J = new Float64Array(POSE);
      const X = new Float64Array(POSE);
      const X2 = new Float64Array(POSE);
      const tw = new Float64Array(6);
      const delta = new Float64Array(3);
      const rel = new Float64Array(POSE);
      const phi = new Float64Array(3);
      for (let i = 0; i < 20; i++) {
        packPose(G, 0, randomPose(r));
        const q = randomCoordinates(kind, r, n);
        jointTransform(kind, q, 0, J, 0);
        mul(X, 0, G, 0, J, 0);
        for (let k = 0; k < n; k++) {
          coordinateTwist(kind, k, G, 0, X, 0, tw, 0);
          const q2 = q.slice();
          delta.fill(0);
          delta[k] = h;
          retract(kind, q2, 0, delta, 0);
          jointTransform(kind, q2, 0, J, 0);
          mul(X2, 0, G, 0, J, 0);
          // Angular velocity: log(R2 R^T) / h; the origin of X moves by w x t + v0.
          relativeRotationForTest(rel, X2, X);
          rotationLog(phi, 0, rel, 0);
          for (let c = 0; c < 3; c++) expect(phi[c]! / h).toBeCloseTo(tw[c]!, 4);
          const t = [X[0]!, X[1]!, X[2]!];
          const v = [
            tw[1]! * t[2]! - tw[2]! * t[1]! + tw[3]!,
            tw[2]! * t[0]! - tw[0]! * t[2]! + tw[4]!,
            tw[0]! * t[1]! - tw[1]! * t[0]! + tw[5]!,
          ];
          for (let c = 0; c < 3; c++) expect((X2[c]! - X[c]!) / h).toBeCloseTo(v[c]!, 4);
        }
      }
    });
  }
});
