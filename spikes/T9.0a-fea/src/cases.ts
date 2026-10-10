// The benchmark cases: geometry (built by the kernel, see geometry.ts), mesh densities,
// constraints, loads, and the analytical values each result is compared against.
// Units: mm, N, MPa.

import { type MeshOptions, type TetMesh } from './mesh.ts';
import { type SurfaceLoad } from './solver.ts';
import { type Material } from './tet10.ts';

export const STEEL: Material = { E: 200_000, nu: 0.3 };

export interface Metric {
  name: string;
  fea: number;
  analytical: number;
  /** (fea - analytical) / analytical */
  error: number;
}

export interface Case {
  id: string;
  title: string;
  material: Material;
  densities: { label: string; options: MeshOptions }[];
  constrain(
    mesh: TetMesh,
    fix: (where: (x: number, y: number, z: number) => boolean, comps?: number[]) => void,
  ): void;
  loads: SurfaceLoad[];
  evaluate(mesh: TetMesh, u: Float64Array, stress: Float64Array): Metric[];
}

const metric = (name: string, fea: number, analytical: number): Metric => ({
  name,
  fea,
  analytical,
  error: (fea - analytical) / analytical,
});

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

// Cantilever ----------------------------------------------------------------------------------

export const CANTILEVER = { L: 200, b: 20, h: 20, P: 1000 };

/**
 * A 200 x 20 x 20 steel cantilever clamped at x = 0, 1 kN down at the free end as a uniform shear
 * traction. Compared with Timoshenko beam theory (tip deflection) and M c / I (bending stress at
 * mid-span, top fibre).
 */
export const cantilever: Case = {
  id: 'cantilever',
  title: 'Cantilever, 200 x 20 x 20 mm, 1 kN tip load',
  material: STEEL,
  densities: [
    { label: 'coarse', options: { sizeMax: 10 } },
    { label: 'medium', options: { sizeMax: 5 } },
    { label: 'fine', options: { sizeMax: 2.5 } },
  ],
  constrain(_mesh, fix) {
    fix((x) => near(x, 0));
  },
  loads: [
    {
      where: (x) => near(x, CANTILEVER.L, 1e-4),
      traction: [0, 0, -CANTILEVER.P / (CANTILEVER.b * CANTILEVER.h)],
    },
  ],
  evaluate(mesh, u, stress) {
    const { L, b, h, P } = CANTILEVER;
    const { E, nu } = STEEL;
    const I = (b * h ** 3) / 12;
    const G = E / (2 * (1 + nu));
    const kappa = (10 * (1 + nu)) / (12 + 11 * nu);
    const tip = (P * L ** 3) / (3 * E * I) + (P * L) / (kappa * G * b * h);
    const X = mesh.nodes;
    let sum = 0,
      cnt = 0;
    // Least-squares line of sigma_xx along the top fibre for 80 <= x <= 120, read at x = 100.
    let sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0,
      m = 0;
    for (let i = 0; i < X.length / 3; i++) {
      const x = X[3 * i]!,
        z = X[3 * i + 2]!;
      if (near(x, L, 1e-4)) {
        sum += u[3 * i + 2]!;
        cnt++;
      }
      if (near(z, h, 1e-4) && x >= 80 && x <= 120) {
        const s = stress[6 * i]!;
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
      metric(
        'bending stress at mid-span, top fibre (MPa)',
        sigmaMid,
        (P * (L - 100) * (h / 2)) / I,
      ),
    ];
  },
};

// Plate with a hole ---------------------------------------------------------------------------

export const PLATE = { halfLength: 100, halfWidth: 25, r: 5, halfThickness: 1, stress: 100 };

/** Peterson's Kt for a finite-width plate with a central hole in tension, on the net section. */
export function petersonKt(dOverW: number): number {
  const k = 1 - dOverW;
  return 2 + 0.284 * k - 0.6 * k * k + 1.32 * k ** 3;
}

function arcPoints(r: number, zs: number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const z of zs)
    for (let k = 0; k <= 18; k++) {
      const a = (k / 18) * (Math.PI / 2);
      out.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
  return out;
}

/**
 * A 200 x 50 x 2 mm plate with a 10 mm central hole, 100 MPa tension along x; an eighth is
 * modelled (x >= 0, y >= 0, z >= 0, symmetry on the three planes). Compared with Peterson's Kt
 * for d/W = 0.2 on the net section. The plate is thin (t/d = 0.2), so the mid-plane peak is close
 * to the plane-stress value Peterson's chart gives.
 */
export const plateWithHole: Case = {
  id: 'plate-hole',
  title: 'Plate with a hole, d/W = 0.2, 100 MPa',
  material: STEEL,
  densities: [
    {
      label: 'coarse',
      options: {
        sizeMax: 8,
        refine: { points: arcPoints(5, [0, 1]), size: 1, radius: 0.5, to: 15 },
      },
    },
    {
      label: 'medium',
      options: {
        sizeMax: 5,
        refine: { points: arcPoints(5, [0, 1]), size: 0.5, radius: 0.5, to: 12 },
      },
    },
    {
      label: 'fine',
      options: {
        sizeMax: 3,
        refine: { points: arcPoints(5, [0, 1]), size: 0.25, radius: 0.5, to: 10 },
      },
    },
  ],
  constrain(_mesh, fix) {
    fix((x) => near(x, 0), [0]);
    fix((_x, y) => near(y, 0), [1]);
    fix((_x, _y, z) => near(z, 0), [2]);
  },
  loads: [{ where: (x) => near(x, PLATE.halfLength, 1e-4), traction: [PLATE.stress, 0, 0] }],
  evaluate(mesh, _u, stress) {
    const { r, halfWidth, stress: s0 } = PLATE;
    const d = 2 * r,
      W = 2 * halfWidth;
    const peak = petersonKt(d / W) * s0 * (W / (W - d));
    const X = mesh.nodes;
    let mid = NaN,
      midZ = Infinity,
      max = -Infinity;
    for (let i = 0; i < X.length / 3; i++) {
      const x = X[3 * i]!,
        y = X[3 * i + 1]!,
        z = X[3 * i + 2]!;
      if (near(x, 0, 1e-6) && near(y, r, 1e-4)) {
        const sxx = stress[6 * i]!;
        max = Math.max(max, sxx);
        if (z < midZ) {
          midZ = z;
          mid = sxx;
        }
      }
    }
    return [
      metric('peak stress at the hole, mid-plane (MPa)', mid, peak),
      metric('peak stress at the hole, through thickness max (MPa)', max, peak),
    ];
  },
};

// Thick-walled cylinder ------------------------------------------------------------------------

export const CYLINDER = { ri: 10, ro: 20, length: 10, p: 100 };

/**
 * A thick-walled cylinder, ri = 10, ro = 20, 100 MPa internal pressure, plane strain (axial
 * displacement held at both ends); a quarter is modelled. Compared with Lame's solution.
 */
export const thickCylinder: Case = {
  id: 'lame',
  title: 'Thick-walled cylinder, ri = 10, ro = 20 mm, 100 MPa internal',
  material: STEEL,
  densities: [
    { label: 'coarse', options: { sizeMax: 6 } },
    { label: 'medium', options: { sizeMax: 1.5 } },
    { label: 'fine', options: { sizeMax: 0.8 } },
  ],
  constrain(_mesh, fix) {
    fix((x) => near(x, 0), [0]);
    fix((_x, y) => near(y, 0), [1]);
    fix((_x, _y, z) => near(z, 0) || near(z, CYLINDER.length, 1e-4), [2]);
  },
  loads: [
    { where: (x, y) => Math.abs(Math.hypot(x, y) - CYLINDER.ri) < 1e-3, pressure: CYLINDER.p },
  ],
  evaluate(mesh, u, stress) {
    const { ri, ro, p } = CYLINDER;
    const { E, nu } = STEEL;
    const A = (p * ri * ri) / (ro * ro - ri * ri);
    const B = (p * ri * ri * ro * ro) / (ro * ro - ri * ri);
    const hoop = (r: number) => A + B / (r * r);
    const ur = (r: number) => ((1 + nu) / E) * ((1 - 2 * nu) * A * r + B / r);
    const X = mesh.nodes;
    const acc = { in: [0, 0, 0], out: [0, 0] };
    for (let i = 0; i < X.length / 3; i++) {
      const x = X[3 * i]!,
        y = X[3 * i + 1]!;
      const r = Math.hypot(x, y);
      const c = x / r,
        s = y / r;
      const sxx = stress[6 * i]!,
        syy = stress[6 * i + 1]!,
        sxy = stress[6 * i + 5]!;
      const sth = sxx * s * s - 2 * sxy * s * c + syy * c * c;
      if (Math.abs(r - ri) < 1e-3) {
        acc.in[0]! += sth;
        acc.in[1]! += u[3 * i]! * c + u[3 * i + 1]! * s;
        acc.in[2]! += 1;
      } else if (Math.abs(r - ro) < 1e-3) {
        acc.out[0]! += sth;
        acc.out[1]! += 1;
      }
    }
    return [
      metric('hoop stress, inner surface (MPa)', acc.in[0]! / acc.in[2]!, hoop(ri)),
      metric('hoop stress, outer surface (MPa)', acc.out[0]! / acc.out[1]!, hoop(ro)),
      metric('radial displacement, inner surface (mm)', acc.in[1]! / acc.in[2]!, ur(ri)),
    ];
  },
};

export const CASES: Case[] = [cantilever, plateWithHole, thickCylinder];

// Scaling solid ---------------------------------------------------------------------------------

/**
 * The scaling problem: a 160 x 40 x 20 steel bar with two 16 mm holes and a slot (geometry.ts),
 * clamped at x = 0, 2 kN down on the end face. No analytical value; it is there to be timed at
 * 50k, 200k and 500k degrees of freedom, and is stockier than the cantilever.
 */
export const bracket: Omit<Case, 'densities' | 'evaluate'> = {
  id: 'bracket',
  title: 'Bar with holes and a slot, 160 x 40 x 20 mm, 2 kN end load',
  material: STEEL,
  constrain(_mesh, fix) {
    fix((x) => near(x, 0));
  },
  loads: [{ where: (x) => near(x, 160, 1e-4), traction: [0, 0, -2000 / (40 * 20)] }],
};
