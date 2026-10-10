// The T9.0a spike's analytical benchmarks (spikes/T9.0a-fea/src/cases.ts): geometry, loads and
// the closed-form values each result is compared against, evaluated on a `FeaResult` (mm, Pa).
// Used by the tests on structured meshes and on gmsh's meshes of kernel solids.

import type { FeaResult } from './types';

export const STEEL = { elasticModulus: 200e9, poissonRatio: 0.3 };
const E = 200_000; // MPa
const NU = 0.3;

export interface Metric {
  name: string;
  fea: number;
  analytical: number;
  /** (fea - analytical) / analytical */
  error: number;
}

const metric = (name: string, fea: number, analytical: number): Metric => ({
  name,
  fea,
  analytical,
  error: (fea - analytical) / analytical,
});

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

/** A 200 x 20 x 20 mm steel cantilever, clamped at x = 0, 1 kN down at x = 200. */
export const CANTILEVER = { L: 200, b: 20, h: 20, P: 1000 };

/** Timoshenko tip deflection (mm) and M c / I at mid-span (MPa). */
export function cantileverMetrics(r: FeaResult): Metric[] {
  const { L, b, h, P } = CANTILEVER;
  const I = (b * h ** 3) / 12;
  const G = E / (2 * (1 + NU));
  const kappa = (10 * (1 + NU)) / (12 + 11 * NU);
  const tip = (P * L ** 3) / (3 * E * I) + (P * L) / (kappa * G * b * h);
  const X = r.nodes;
  let sum = 0,
    cnt = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    m = 0;
  for (let i = 0; i < X.length / 3; i++) {
    const x = X[3 * i]!,
      z = X[3 * i + 2]!;
    if (near(x, L, 1e-4)) {
      sum += r.displacement[3 * i + 2]!;
      cnt++;
    }
    // Least-squares line of sigma_xx along the top fibre for 80 <= x <= 120, read at x = 100.
    if (near(z, h, 1e-4) && x >= 80 && x <= 120) {
      const s = r.stress[6 * i]! / 1e6;
      sx += x;
      sy += s;
      sxx += x * x;
      sxy += x * s;
      m++;
    }
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  const sigmaMid = (sy - slope * sx) / m + slope * 100;
  return [
    metric('tip deflection (mm)', -sum / cnt, tip),
    metric('bending stress at mid-span, top fibre (MPa)', sigmaMid, (P * (L - 100) * (h / 2)) / I),
  ];
}

/** An eighth of a 200 x 50 x 2 mm plate with a 10 mm hole, 100 MPa along x. */
export const PLATE = { halfLength: 100, halfWidth: 25, r: 5, halfThickness: 1, stress: 100 };

/** Peterson's Kt for a finite-width plate with a central hole in tension, on the net section. */
export function petersonKt(dOverW: number): number {
  const k = 1 - dOverW;
  return 2 + 0.284 * k - 0.6 * k * k + 1.32 * k ** 3;
}

export function plateMetrics(r: FeaResult): Metric[] {
  const { r: radius, halfWidth, stress: s0 } = PLATE;
  const d = 2 * radius,
    W = 2 * halfWidth;
  const peak = petersonKt(d / W) * s0 * (W / (W - d));
  const X = r.nodes;
  let mid = NaN,
    midZ = Infinity,
    max = -Infinity;
  for (let i = 0; i < X.length / 3; i++) {
    const x = X[3 * i]!,
      y = X[3 * i + 1]!,
      z = X[3 * i + 2]!;
    if (near(x, 0, 1e-6) && near(y, radius, 1e-4)) {
      const sxx = r.stress[6 * i]! / 1e6;
      max = Math.max(max, sxx);
      if (z < midZ) {
        midZ = z;
        mid = sxx;
      }
    }
  }
  return [
    metric('peak stress at the hole, mid-plane (MPa)', mid, peak),
    metric('peak stress at the hole, through-thickness max (MPa)', max, peak),
  ];
}

/** A quarter of a thick-walled cylinder, ri 10, ro 20, 10 long, 100 MPa inside, plane strain. */
export const CYLINDER = { ri: 10, ro: 20, length: 10, p: 100 };

export function cylinderMetrics(r: FeaResult): Metric[] {
  const { ri, ro, p } = CYLINDER;
  const A = (p * ri * ri) / (ro * ro - ri * ri);
  const B = (p * ri * ri * ro * ro) / (ro * ro - ri * ri);
  const hoop = (x: number) => A + B / (x * x);
  const ur = (x: number) => ((1 + NU) / E) * ((1 - 2 * NU) * A * x + B / x);
  const X = r.nodes;
  const acc = { in: [0, 0, 0], out: [0, 0] };
  for (let i = 0; i < X.length / 3; i++) {
    const x = X[3 * i]!,
      y = X[3 * i + 1]!;
    const rad = Math.hypot(x, y);
    const c = x / rad,
      s = y / rad;
    const sxx = r.stress[6 * i]! / 1e6,
      syy = r.stress[6 * i + 1]! / 1e6,
      sxy = r.stress[6 * i + 5]! / 1e6;
    const sth = sxx * s * s - 2 * sxy * s * c + syy * c * c;
    if (Math.abs(rad - ri) < 1e-3) {
      acc.in[0]! += sth;
      acc.in[1]! += r.displacement[3 * i]! * c + r.displacement[3 * i + 1]! * s;
      acc.in[2]! += 1;
    } else if (Math.abs(rad - ro) < 1e-3) {
      acc.out[0]! += sth;
      acc.out[1]! += 1;
    }
  }
  return [
    metric('hoop stress, inner surface (MPa)', acc.in[0]! / acc.in[2]!, hoop(ri)),
    metric('hoop stress, outer surface (MPa)', acc.out[0]! / acc.out[1]!, hoop(ro)),
    metric('radial displacement, inner surface (mm)', acc.in[1]! / acc.in[2]!, ur(ri)),
  ];
}
