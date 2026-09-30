// Builders for assembly inputs in tests and the benchmark.

import { expect } from 'vitest';
import type { AssemblyInput, InstanceInput, MateInput, MateKind } from './model';
import {
  compose,
  invert,
  quatFromAxisAngle,
  quatFromRotationVector,
  rotationVector,
  type Pose,
  type Quat,
  type Vec3,
} from './transform';

export const I: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

export const deg = (d: number) => (d * Math.PI) / 180;

export function rz(angle: number): Quat {
  return quatFromAxisAngle([0, 0, 1], angle);
}

export function at(translation: Vec3, rotation: Quat = [0, 0, 0, 1]): Pose {
  return { translation, rotation };
}

export function inst(id: string, p: Pose = I, fixed = false): InstanceInput {
  return fixed ? { id, pose: p, fixed } : { id, pose: p };
}

export function mate(
  id: string,
  kind: MateKind,
  a: [string, Pose],
  b: [string, Pose],
  extra: Partial<MateInput> = {},
): MateInput {
  return {
    id,
    kind,
    a: { instance: a[0], frame: a[1] },
    b: { instance: b[0], frame: b[1] },
    ...extra,
  };
}

/** J(q) built from the public API, independently of the solver's packed code. */
export function joint(kind: MateKind, q: readonly number[]): Pose {
  switch (kind) {
    case 'fastened':
      return I;
    case 'revolute':
      return at([0, 0, 0], rz(q[0]!));
    case 'slider':
      return at([0, 0, q[0]!]);
    case 'planar':
      return at([q[0]!, q[1]!, 0], rz(q[2]!));
    case 'cylindrical':
      return at([0, 0, q[0]!], rz(q[1]!));
    case 'ball':
      return at([0, 0, 0], quatFromRotationVector([q[0]!, q[1]!, q[2]!]));
  }
}

/** The pose of b's instance that satisfies the mate at q, given a's instance pose. */
export function place(wa: Pose, m: MateInput, q: readonly number[]): Pose {
  const ca = m.offset ? compose(m.a.frame, m.offset) : m.a.frame;
  return compose(compose(compose(wa, ca), joint(m.kind, q)), invert(m.b.frame));
}

/** A small deterministic random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomQuat(r: () => number): Quat {
  // A rotation vector with angle below pi.
  const v: Vec3 = [r() - 0.5, r() - 0.5, r() - 0.5];
  const n = Math.hypot(...v) || 1;
  const angle = r() * Math.PI * 0.95;
  return quatFromRotationVector([(v[0] / n) * angle, (v[1] / n) * angle, (v[2] / n) * angle]);
}

export function randomPose(r: () => number, size = 50): Pose {
  return at([(r() - 0.5) * size, (r() - 0.5) * size, (r() - 0.5) * size], randomQuat(r));
}

export function expectPoseClose(actual: Pose | undefined, expected: Pose, tol = 1e-9): void {
  expect(actual).toBeDefined();
  const a = actual!;
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(a.translation[k]! - expected.translation[k]!)).toBeLessThan(tol);
  }
  // Same rotation up to the quaternion's sign.
  const d = rotationVector(
    compose(invert(a), { translation: [0, 0, 0], rotation: expected.rotation }).rotation,
  );
  expect(Math.hypot(...d)).toBeLessThan(tol);
}

export function input(instances: InstanceInput[], mates: MateInput[]): AssemblyInput {
  return { instances, mates };
}

/** Link frames for planar linkages: a link lies along its local x axis. */
export function linkEnd(length: number): Pose {
  return at([length, 0, 0]);
}

/**
 * A planar four-bar: ground (fixed, pivots at 0 and at `ground` on x), crank, coupler and
 * rocker, joined by four revolutes; the last (rocker to ground) closes the loop. Poses are
 * exact for crank angle `theta` (on the open branch).
 */
export function fourBar(
  theta: number,
  lengths = { ground: 5, crank: 2, coupler: 5, rocker: 4 },
  prefix = '',
  base: Pose = I,
): { instances: InstanceInput[]; mates: MateInput[] } {
  const { ground, crank, coupler, rocker } = lengths;
  const B: Vec3 = [crank * Math.cos(theta), crank * Math.sin(theta), 0];
  const D: Vec3 = [ground, 0, 0];
  // C: |C - B| = coupler, |C - D| = rocker, above the line BD.
  const dx = D[0] - B[0],
    dy = D[1] - B[1];
  const dist = Math.hypot(dx, dy);
  const a = (coupler * coupler - rocker * rocker + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, coupler * coupler - a * a));
  const mx = B[0] + (a * dx) / dist,
    my = B[1] + (a * dy) / dist;
  const C: Vec3 = [mx - (h * dy) / dist, my + (h * dx) / dist, 0];
  const couplerAngle = Math.atan2(C[1] - B[1], C[0] - B[0]);
  const rockerAngle = Math.atan2(C[1] - D[1], C[0] - D[0]);
  const p = (id: string) => prefix + id;
  const place2 = (t: Vec3, angle: number) => compose(base, at(t, rz(angle)));
  return {
    instances: [
      inst(p('ground'), base, true),
      inst(p('crank'), place2([0, 0, 0], theta)),
      inst(p('coupler'), place2(B, couplerAngle)),
      inst(p('rocker'), place2(D, rockerAngle)),
    ],
    mates: [
      mate(p('m1'), 'revolute', [p('ground'), I], [p('crank'), I]),
      mate(p('m2'), 'revolute', [p('crank'), linkEnd(crank)], [p('coupler'), I]),
      mate(p('m3'), 'revolute', [p('coupler'), linkEnd(coupler)], [p('rocker'), linkEnd(rocker)]),
      mate(p('m4'), 'revolute', [p('rocker'), I], [p('ground'), linkEnd(ground)]),
    ],
  };
}

/** Rotates every non-fixed instance's pose a little, so the solver has work to do. */
export function perturb(
  instances: InstanceInput[],
  r: () => number,
  amount = 0.02,
): InstanceInput[] {
  return instances.map((i) =>
    i.fixed
      ? i
      : {
          ...i,
          pose: compose(
            i.pose,
            at(
              [(r() - 0.5) * amount, (r() - 0.5) * amount, (r() - 0.5) * amount],
              quatFromRotationVector([
                (r() - 0.5) * amount,
                (r() - 0.5) * amount,
                (r() - 0.5) * amount,
              ]),
            ),
          ),
        },
  );
}
