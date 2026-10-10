// Spur gears: Lewis bending stress with the Barth velocity factor, and Hertz contact stress
// (Shigley chapter 14, SI forms). The AGMA refinements are not included.

import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { shigley10 } from './sources';

/** Shigley 10th ed. Table 14-2: Lewis form factor Y, 20° full-depth teeth, diametral pitch 1. */
const LEWIS: readonly (readonly [number, number])[] = [
  [12, 0.245],
  [13, 0.261],
  [14, 0.277],
  [15, 0.29],
  [16, 0.296],
  [17, 0.303],
  [18, 0.309],
  [19, 0.314],
  [20, 0.322],
  [21, 0.328],
  [22, 0.331],
  [24, 0.337],
  [26, 0.346],
  [28, 0.353],
  [30, 0.359],
  [34, 0.371],
  [38, 0.384],
  [43, 0.397],
  [50, 0.409],
  [60, 0.422],
  [75, 0.435],
  [100, 0.447],
  [150, 0.46],
  [300, 0.472],
  [400, 0.48],
];
const RACK = 0.485;

/** Lewis form factor Y for 20° full-depth teeth, interpolated linearly between table rows. */
export function lewisFormFactor(p: { teeth: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'gear.lewis-y',
      title: 'Lewis form factor',
      method: 'Table of Y for 20° full-depth teeth, linear between rows',
      formula: 'Y(N)',
      unit: '1',
      sources: [shigley10('Table 14-2')],
      assumptions: ['20° pressure angle, full-depth teeth; above 400 teeth the rack value 0.485'],
      inputs: { teeth: { name: 'Number of teeth', symbol: 'N', unit: '1' } },
    },
    p,
    options,
    (v) => {
      const N = v.teeth;
      requireRange(N >= 12, 'The table starts at 12 teeth');
      if (N > 400) return { result: RACK };
      for (let i = 1; i < LEWIS.length; i++) {
        const [n0, y0] = LEWIS[i - 1]!;
        const [n1, y1] = LEWIS[i]!;
        if (N <= n1) return { result: y0 + ((N - n0) / (n1 - n0)) * (y1 - y0) };
      }
      return { result: LEWIS[LEWIS.length - 1]![1] };
    },
  );
}

export type ToothProfile = 'cast' | 'cut' | 'hobbed' | 'ground';

const BARTH: Record<ToothProfile, { formula: string; f: (V: number) => number; eq: string }> = {
  cast: { formula: 'K_v = (3.05 + V) / 3.05', f: (V) => (3.05 + V) / 3.05, eq: '(14-6a)' },
  cut: { formula: 'K_v = (6.1 + V) / 6.1', f: (V) => (6.1 + V) / 6.1, eq: '(14-6b)' },
  hobbed: {
    formula: 'K_v = (3.56 + √V) / 3.56',
    f: (V) => (3.56 + Math.sqrt(V)) / 3.56,
    eq: '(14-6c)',
  },
  ground: {
    formula: 'K_v = (5.56 + √V) / 5.56',
    f: (V) => (5.56 + Math.sqrt(V)) / 5.56,
    eq: '(14-6d)',
  },
};

/** Barth velocity factor from the pitch-line velocity (m/s). */
export function velocityFactor(p: { V: Param }, profile: ToothProfile, options?: RecordOptions) {
  const b = BARTH[profile];
  return calc(
    {
      id: `gear.velocity-factor-${profile}`,
      title: `Gear velocity factor (${profile} profile)`,
      method: 'Barth equation',
      formula: b.formula,
      unit: '1',
      sources: [shigley10(`Eq. ${b.eq}`)],
      inputs: { V: { name: 'Pitch-line velocity', symbol: 'V', unit: 'm/s' } },
    },
    p,
    options,
    (v) => {
      requireRange(v.V >= 0, 'V must not be negative');
      return { result: b.f(v.V) };
    },
  );
}

/** Lewis bending stress of a spur gear tooth: σ = K_v W_t / (F m Y). */
export function lewisBendingStress(
  p: { Wt: Param; F: Param; m: Param; Y: Param; Kv: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'gear.lewis-stress',
      title: 'Gear tooth bending stress (Lewis)',
      method: 'Lewis equation with the velocity factor',
      formula: 'σ = K_v W_t / (F m Y)',
      unit: 'Pa',
      sources: [shigley10('Eq. (14-8)')],
      assumptions: ['Load at the tooth tip, one tooth carries it; no stress concentration'],
      inputs: {
        Wt: { name: 'Transmitted (tangential) load', symbol: 'W_t', unit: 'N' },
        F: { name: 'Face width', symbol: 'F', unit: 'm' },
        m: { name: 'Module', symbol: 'm', unit: 'm' },
        Y: { name: 'Lewis form factor', symbol: 'Y', unit: '1' },
        Kv: { name: 'Velocity factor', symbol: 'K_v', unit: '1' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.F > 0 && v.m > 0 && v.Y > 0, 'F, m and Y must be positive');
      return { result: (v.Kv * v.Wt) / (v.F * v.m * v.Y) };
    },
  );
}

/** Elastic coefficient C_p = √(1 / (π ((1 - ν₁²)/E₁ + (1 - ν₂²)/E₂))). */
export function elasticCoefficient(
  p: { E1: Param; nu1: Param; E2: Param; nu2: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'gear.elastic-coefficient',
      title: 'Elastic coefficient of a gear pair',
      method: 'Hertz elastic coefficient from both materials',
      formula: 'C_p = √(1 / (π ((1 - ν₁²)/E₁ + (1 - ν₂²)/E₂)))',
      unit: '√Pa',
      sources: [shigley10('Eq. (14-13)')],
      inputs: {
        E1: { name: "Pinion Young's modulus", symbol: 'E₁', unit: 'Pa' },
        nu1: { name: "Pinion Poisson's ratio", symbol: 'ν₁', unit: '1' },
        E2: { name: "Gear Young's modulus", symbol: 'E₂', unit: 'Pa' },
        nu2: { name: "Gear Poisson's ratio", symbol: 'ν₂', unit: '1' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.E1 > 0 && v.E2 > 0, 'Moduli must be positive');
      return {
        result: Math.sqrt(1 / (Math.PI * ((1 - v.nu1 ** 2) / v.E1 + (1 - v.nu2 ** 2) / v.E2))),
      };
    },
  );
}

/**
 * Hertz contact stress of external spur gears at the pitch point (magnitude; the stress is
 * compressive): σ_C = C_p √(K_v W_t / (F cos φ) (1/r₁ + 1/r₂)), rᵢ = dᵢ sin φ / 2.
 */
export function hertzContactStress(
  p: { Cp: Param; Kv: Param; Wt: Param; F: Param; d1: Param; d2: Param; phi?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'gear.contact-stress',
      title: 'Gear contact stress (Hertz)',
      method: 'Hertz contact of two cylinders with the radii of curvature at the pitch point',
      formula: 'σ_C = C_p √(K_v W_t / (F cos φ) (1/r₁ + 1/r₂)), rᵢ = dᵢ sin φ / 2',
      unit: 'Pa',
      sources: [shigley10('Eqs. (14-12) and (14-14)')],
      assumptions: ['External spur gears; contact at the pitch point; result is the magnitude'],
      inputs: {
        Cp: { name: 'Elastic coefficient', symbol: 'C_p', unit: '√Pa' },
        Kv: { name: 'Velocity factor', symbol: 'K_v', unit: '1' },
        Wt: { name: 'Transmitted (tangential) load', symbol: 'W_t', unit: 'N' },
        F: { name: 'Face width', symbol: 'F', unit: 'm' },
        d1: { name: 'Pinion pitch diameter', symbol: 'd₁', unit: 'm' },
        d2: { name: 'Gear pitch diameter', symbol: 'd₂', unit: 'm' },
        phi: {
          name: 'Pressure angle',
          symbol: 'φ',
          unit: 'rad',
          default: { value: (20 * Math.PI) / 180, note: '20°' },
        },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.F > 0 && v.d1 > 0 && v.d2 > 0, 'F and the diameters must be positive');
      const r1 = (v.d1 * Math.sin(v.phi)) / 2;
      const r2 = (v.d2 * Math.sin(v.phi)) / 2;
      return {
        result: v.Cp * Math.sqrt(((v.Kv * v.Wt) / (v.F * Math.cos(v.phi))) * (1 / r1 + 1 / r2)),
        derived: [
          value('Pinion radius of curvature', 'r₁', r1, 'm'),
          value('Gear radius of curvature', 'r₂', r2, 'm'),
        ],
      };
    },
  );
}
