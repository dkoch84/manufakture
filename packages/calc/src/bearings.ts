// Rolling bearings: equivalent dynamic load, ISO 281 basic and modified rating life, the life
// modification factors, and the ISO 76 static safety factor.

import { REQUIRED_FACTOR } from './factor';
import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { iso281, iso76, shigley10 } from './sources';

export type BearingKind = 'ball' | 'roller';

/** P = X Fr + Y Fa with factors from the bearing maker's table. */
export function equivalentDynamicLoad(
  p: { Fr: Param; Fa: Param; X: Param; Y: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bearing.equivalent-load',
      title: 'Bearing equivalent dynamic load',
      method: 'Radial and axial load combined with the X and Y factors',
      formula: 'P = X F_r + Y F_a',
      unit: 'N',
      sources: [iso281('equivalent dynamic radial load'), shigley10('Eq. (11-12)')],
      inputs: {
        Fr: { name: 'Radial load', symbol: 'F_r', unit: 'N' },
        Fa: { name: 'Axial load', symbol: 'F_a', unit: 'N' },
        X: { name: 'Radial factor', symbol: 'X', unit: '1' },
        Y: { name: 'Axial factor', symbol: 'Y', unit: '1' },
      },
    },
    p,
    options,
    (v) => ({ result: v.X * v.Fr + v.Y * v.Fa }),
  );
}

/** Shigley 10th ed. Table 11-1: Fa/C0, e and Y2 for single-row deep-groove ball bearings. */
const DEEP_GROOVE: readonly (readonly [number, number, number])[] = [
  [0.014, 0.19, 2.3],
  [0.021, 0.21, 2.15],
  [0.028, 0.22, 1.99],
  [0.042, 0.24, 1.85],
  [0.056, 0.26, 1.71],
  [0.07, 0.27, 1.63],
  [0.084, 0.28, 1.55],
  [0.11, 0.3, 1.45],
  [0.17, 0.34, 1.31],
  [0.28, 0.38, 1.15],
  [0.42, 0.42, 1.04],
  [0.56, 0.44, 1.0],
];

function interpolate(x: number, column: 1 | 2): number {
  const rows = DEEP_GROOVE;
  if (x <= rows[0]![0]) return rows[0]![column];
  for (let i = 1; i < rows.length; i++) {
    const lo = rows[i - 1]!;
    const hi = rows[i]!;
    if (x <= hi[0]) return lo[column] + ((x - lo[0]) / (hi[0] - lo[0])) * (hi[column] - lo[column]);
  }
  return rows[rows.length - 1]![column];
}

/**
 * Equivalent load of a single-row deep-groove ball bearing, interpolating the X and Y table on
 * Fa/C0. V is the rotation factor (1 when the inner ring rotates, 1.2 when the outer ring does).
 */
export function deepGrooveEquivalentLoad(
  p: { Fr: Param; Fa: Param; C0: Param; V?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bearing.equivalent-load-deep-groove',
      title: 'Deep-groove ball bearing equivalent load',
      method: 'X and Y interpolated on Fa/C0 from the deep-groove table',
      formula:
        'P = max(X V F_r + Y F_a, V F_r); X = 1, Y = 0 if F_a/(V F_r) <= e, else X = 0.56, Y = Y₂(F_a/C₀)',
      unit: 'N',
      sources: [shigley10('Table 11-1 and Eq. (11-12)')],
      assumptions: ['Single-row deep-groove ball bearing, normal clearance'],
      inputs: {
        Fr: { name: 'Radial load', symbol: 'F_r', unit: 'N' },
        Fa: { name: 'Axial load', symbol: 'F_a', unit: 'N' },
        C0: { name: 'Static load rating', symbol: 'C₀', unit: 'N' },
        V: {
          name: 'Rotation factor',
          symbol: 'V',
          unit: '1',
          default: { value: 1, note: 'inner ring rotates' },
        },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.C0 > 0 && v.Fr >= 0 && v.Fa >= 0, 'Needs C0 > 0 and non-negative loads');
      const ratio = v.Fa / v.C0;
      const e = interpolate(ratio, 1);
      const heavy = v.Fr > 0 ? v.Fa / (v.V * v.Fr) > e : v.Fa > 0;
      const X = heavy ? 0.56 : 1;
      const Y = heavy ? interpolate(ratio, 2) : 0;
      const assumptions: string[] = [];
      if (ratio < DEEP_GROOVE[0]![0] || ratio > DEEP_GROOVE[DEEP_GROOVE.length - 1]![0]) {
        assumptions.push('F_a/C₀ outside the table: the nearest row is used');
      }
      return {
        result: Math.max(X * v.V * v.Fr + Y * v.Fa, v.V * v.Fr),
        derived: [
          value('Axial over static rating', 'F_a/C₀', ratio, '1'),
          value('Limit ratio', 'e', e, '1'),
          value('Radial factor', 'X', X, '1'),
          value('Axial factor', 'Y', Y, '1'),
        ],
        assumptions,
      };
    },
  );
}

/**
 * Life modification factor for reliability, a1 = 0.95 (ln(1/R) / ln(1/0.9))^(2/3) + 0.05, which
 * reproduces the ISO 281:2007 a1 table from 90 % to 99.95 %.
 */
export function reliabilityLifeFactor(p: { reliability: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'bearing.a1',
      title: 'Bearing life factor for reliability (a1)',
      method: 'Weibull fit (slope 1.5, minimum life 0.05 L10) behind the ISO 281 a1 table',
      formula: 'a₁ = 0.95 (ln(1/R) / ln(1/0.9))^(2/3) + 0.05',
      unit: '1',
      sources: [iso281('life modification factor for reliability, a1')],
      inputs: { reliability: { name: 'Reliability', symbol: 'R', unit: '1' } },
    },
    p,
    options,
    (v) => {
      requireRange(v.reliability >= 0.9 && v.reliability <= 0.9995, 'a1 covers 90 % to 99.95 %');
      return {
        result: 0.95 * (Math.log(1 / v.reliability) / Math.log(1 / 0.9)) ** (2 / 3) + 0.05,
      };
    },
  );
}

/**
 * ISO 281 life modification factor aISO for radial bearings from the viscosity ratio κ and the
 * contamination term e_C C_u / P. Capped at 50; κ above 4 is taken as 4.
 */
export function isoLifeModificationFactor(
  p: { kappa: Param; eCCuOverP: Param },
  kind: BearingKind,
  options?: RecordOptions,
) {
  const ball = kind === 'ball';
  return calc(
    {
      id: `bearing.aiso-${kind}`,
      title: `Bearing life modification factor aISO (radial ${kind} bearing)`,
      method: 'ISO 281:2007 equations for aISO by viscosity-ratio range',
      formula: ball
        ? 'a_ISO = 0.1 [1 - (2.5671 - k₁/κ^k₂)^0.83 (e_C C_u/P)^(1/3)]^-9.3'
        : 'a_ISO = 0.1 [1 - (1.5859 - k₁/κ^k₂) (e_C C_u/P)^0.4]^-9.185',
      unit: '1',
      sources: [iso281('aISO for radial ball and radial roller bearings')],
      assumptions: ['a_ISO capped at 50; κ above 4 taken as 4'],
      inputs: {
        kappa: { name: 'Viscosity ratio', symbol: 'κ', unit: '1' },
        eCCuOverP: { name: 'Contamination term e_C C_u / P', symbol: 'e_C C_u/P', unit: '1' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.kappa >= 0.1, 'κ below 0.1 is outside ISO 281');
      requireRange(v.eCCuOverP >= 0, 'e_C C_u / P must not be negative');
      const k = Math.min(v.kappa, 4);
      let inner: number;
      if (ball) {
        const [k1, k2] =
          k < 0.4 ? [2.2649, 0.054381] : k < 1 ? [1.9987, 0.19087] : [1.9987, 0.071739];
        inner = 1 - (2.5671 - k1 / k ** k2) ** 0.83 * v.eCCuOverP ** (1 / 3);
        // The bracket reaching zero is where the curve has already passed the cap.
        return { result: inner <= 0 ? 50 : Math.min(50, 0.1 * inner ** -9.3) };
      }
      const [k1, k2] =
        k < 0.4 ? [1.3993, 0.054381] : k < 1 ? [1.2348, 0.19087] : [1.2348, 0.071739];
      inner = 1 - (1.5859 - k1 / k ** k2) * v.eCCuOverP ** 0.4;
      return { result: inner <= 0 ? 50 : Math.min(50, 0.1 * inner ** -9.185) };
    },
  );
}

/**
 * ISO 281 rating life in revolutions: L_nm = a1 aISO (C/P)^p × 10⁶, p = 3 for ball and 10/3 for
 * roller bearings. Without a1 and aISO it is the basic rating life L10.
 */
export function bearingRatingLife(
  p: {
    C: Param;
    P: Param;
    a1?: Param;
    aISO?: Param;
    /** Speed, rad/s; gives the life in seconds as a derived value. */
    speed?: Param;
    /** Required life in revolutions. */
    requiredRevolutions?: Param;
  },
  kind: BearingKind,
  options?: RecordOptions,
) {
  const exponent = kind === 'ball' ? 3 : 10 / 3;
  return calc(
    {
      id: `bearing.life-${kind}`,
      title: `Bearing rating life (${kind})`,
      method: 'ISO 281 basic rating life with the life modification factors',
      formula: `L_nm = a₁ a_ISO (C/P)^${kind === 'ball' ? '3' : '10/3'} × 10⁶ rev`,
      unit: 'rev',
      sources: [
        iso281('basic and modified rating life'),
        shigley10('Sec. 11-3, the load-life relation'),
      ],
      assumptions: ['Constant load and speed; P is the equivalent dynamic load'],
      inputs: {
        C: { name: 'Basic dynamic load rating', symbol: 'C', unit: 'N' },
        P: { name: 'Equivalent dynamic load', symbol: 'P', unit: 'N' },
        a1: {
          name: 'Life factor for reliability',
          symbol: 'a₁',
          unit: '1',
          default: { value: 1, note: '90 % reliability' },
        },
        aISO: {
          name: 'Life modification factor',
          symbol: 'a_ISO',
          unit: '1',
          default: { value: 1, note: 'basic rating life, no lubrication or contamination term' },
        },
      },
      optional: {
        speed: { name: 'Speed', symbol: 'ω', unit: 'rad/s' },
        requiredRevolutions: { name: 'Required life', symbol: 'L_req', unit: 'rev' },
      },
      limit: { input: 'requiredRevolutions', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.C > 0 && v.P > 0, 'C and P must be positive');
      const L10 = (v.C / v.P) ** exponent * 1e6;
      const L = v.a1 * v.aISO * L10;
      const derived = [value('Basic rating life', 'L10', L10, 'rev')];
      if (v.speed !== undefined && v.speed > 0) {
        derived.push(value('Life at the speed', 't', (L * 2 * Math.PI) / v.speed, 's'));
      }
      return { result: L, derived };
    },
  );
}

/** Static safety factor s0 = C0 / P0, P0 = max(X0 Fr + Y0 Fa, Fr). */
export function bearingStaticFactor(
  p: { C0: Param; Fr: Param; Fa?: Param; X0?: Param; Y0?: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bearing.static-factor',
      title: 'Bearing static factor',
      method: 'ISO 76 static equivalent load against the static rating',
      formula: 's₀ = C₀ / P₀; P₀ = max(X₀ F_r + Y₀ F_a, F_r)',
      unit: '1',
      sources: [iso76('static equivalent radial load, radial ball bearings')],
      inputs: {
        C0: { name: 'Static load rating', symbol: 'C₀', unit: 'N' },
        Fr: { name: 'Radial load', symbol: 'F_r', unit: 'N' },
        Fa: { name: 'Axial load', symbol: 'F_a', unit: 'N', default: { value: 0, note: 'none' } },
        X0: {
          name: 'Static radial factor',
          symbol: 'X₀',
          unit: '1',
          default: { value: 0.6, note: 'single-row deep-groove ball bearing' },
        },
        Y0: {
          name: 'Static axial factor',
          symbol: 'Y₀',
          unit: '1',
          default: { value: 0.5, note: 'single-row deep-groove ball bearing' },
        },
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      const P0 = Math.max(v.X0 * v.Fr + v.Y0 * v.Fa, v.Fr);
      requireRange(P0 > 0, 'The static load must be positive');
      return { result: v.C0 / P0, derived: [value('Static equivalent load', 'P₀', P0, 'N')] };
    },
  );
}
