// The moment of inertia of a turning element from measured bodies (ADR 0017 decision 9, T9.3a):
// each body's volume inertia (the kernel's, T9.1c, at unit density about its centre of mass) times
// its material's density, moved to the common centre of mass, summed, and read about the axis the
// element turns on. Pure arithmetic in SI; the kernel's own helpers (`@manufakture/kernel/inertia`)
// work in g·mm² and this package does not depend on the kernel at run time.
//
// The spin axis is not in the model (a stage names an instance, not an axis), so it is taken as
// the element's axis of symmetry: the principal axis whose moment differs most from the other two
// (the largest for a disc or a spool, the smallest for a long shaft). Every record that uses a
// measured inertia states that assumption with the three principal moments.

type Vec3 = readonly [number, number, number];
export type Matrix3 = readonly [Vec3, Vec3, Vec3];

/** One body's mass properties in SI: kg, m, kg·m² about its centre of mass. */
export interface BodyMass {
  mass: number;
  centerOfMass: Vec3;
  inertia: Matrix3;
}

/** The bodies together: total mass, common centre of mass, tensor about it. Null when empty. */
export function combineBodies(bodies: readonly BodyMass[]): BodyMass | null {
  const mass = bodies.reduce((s, b) => s + b.mass, 0);
  if (bodies.length === 0 || !(mass > 0)) return null;
  const c = [0, 1, 2].map(
    (k) => bodies.reduce((s, b) => s + b.mass * b.centerOfMass[k]!, 0) / mass,
  ) as unknown as Vec3;
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const b of bodies) {
    const d = [0, 1, 2].map((k) => b.centerOfMass[k]! - c[k]!);
    const d2 = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 3; k++) {
        // Parallel axis: I + m (|d|² E - d dᵀ).
        out[r]![k]! += b.inertia[r]![k]! + b.mass * ((r === k ? d2 : 0) - d[r]! * d[k]!);
      }
    }
  }
  return { mass, centerOfMass: c, inertia: out as unknown as Matrix3 };
}

/**
 * The eigenvalues of a symmetric 3 x 3 matrix, ascending (the principal moments of an inertia
 * tensor). Closed form (the trigonometric solution of the characteristic cubic).
 */
export function principalMoments(m: Matrix3): Vec3 {
  const a = (r: number, c: number) => (m[r]![c]! + m[c]![r]!) / 2;
  const p1 = a(0, 1) ** 2 + a(0, 2) ** 2 + a(1, 2) ** 2;
  const diag = [a(0, 0), a(1, 1), a(2, 2)];
  if (p1 === 0) return [...diag].sort((x, y) => x - y) as unknown as Vec3;
  const q = (diag[0]! + diag[1]! + diag[2]!) / 3;
  const p2 = diag.reduce((s, v) => s + (v - q) ** 2, 0) + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  // B = (A - q E) / p; r = det(B) / 2.
  const b = (r: number, c: number) => (a(r, c) - (r === c ? q : 0)) / p;
  const det =
    b(0, 0) * (b(1, 1) * b(2, 2) - b(1, 2) * b(2, 1)) -
    b(0, 1) * (b(1, 0) * b(2, 2) - b(1, 2) * b(2, 0)) +
    b(0, 2) * (b(1, 0) * b(2, 1) - b(1, 1) * b(2, 0));
  const r = Math.min(1, Math.max(-1, det / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e1, e2, e3].sort((x, y) => x - y) as unknown as Vec3;
}

/**
 * The moment about the axis of symmetry: of the ascending principal moments, the one farther from
 * the middle one (the largest when the two smaller agree, as for a disc; the smallest when the two
 * larger agree, as for a shaft).
 */
export function spinMoment(moments: Vec3): number {
  const [l1, l2, l3] = moments;
  return l3 - l2 >= l2 - l1 ? l3 : l1;
}
