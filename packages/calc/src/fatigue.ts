// Endurance limit with Marin factors and fatigue notch factors from notch sensitivity (Shigley
// chapter 6). Steels; the fits are the textbook's, in SI.

import {
  calc,
  requireRange,
  value,
  type InputSpec,
  type Param,
  type RecordOptions,
} from './record';
import { shigley10, shigley11 } from './sources';

export type SurfaceFinish = 'ground' | 'machined' | 'hot-rolled' | 'as-forged';
export type FatigueLoading = 'bending' | 'axial' | 'torsion';

/** Shigley 11th ed. Table 6-2: ka = a Sut^b with Sut in MPa. */
const SURFACE: Record<SurfaceFinish, { a: number; b: number; label: string }> = {
  ground: { a: 1.38, b: -0.067, label: 'ground' },
  machined: { a: 3.04, b: -0.217, label: 'machined or cold-drawn' },
  'hot-rolled': { a: 38.6, b: -0.65, label: 'hot-rolled' },
  'as-forged': { a: 54.9, b: -0.758, label: 'as-forged' },
};

const MPA = 1e6;
const PSI = 6894.757293168;
const INCH = 0.0254;

/** Size factor kb for a round bar in rotating bending or torsion (diameter in m). */
export function sizeFactor(d: number): number {
  const mm = d * 1000;
  requireRange(mm >= 2.79 && mm <= 254, 'The size factor fit covers 2.79 mm to 254 mm');
  return mm <= 51 ? 1.24 * mm ** -0.107 : 1.51 * mm ** -0.157;
}

/** Temperature factor kd, Shigley 10th ed. Eq. (6-27), temperature in kelvin. */
export function temperatureFactor(T: number): number {
  const F = ((T - 273.15) * 9) / 5 + 32;
  requireRange(F >= 70 && F <= 1000, 'The temperature factor fit covers 70 F to 1000 F');
  return 0.975 + 0.432e-3 * F - 0.115e-5 * F ** 2 + 0.104e-8 * F ** 3 - 0.595e-12 * F ** 4;
}

/** Standard normal variate for a reliability, by inverting the normal CDF (Acklam's rational fit). */
function normalVariate(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q0 = Math.min(p, 1 - p);
  let x: number;
  if (q0 < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(q0));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else {
    const q = q0 - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  // x is the quantile of the lower tail q0 (zero or negative); a reliability's variate is -x.
  return p >= 0.5 ? -x : x;
}

/** Reliability factor ke = 1 - 0.08 za. */
export function reliabilityFactor(reliability: number): number {
  requireRange(reliability >= 0.5 && reliability < 1, 'Reliability must be in [0.5, 1)');
  return 1 - 0.08 * normalVariate(reliability);
}

/**
 * Fully corrected endurance limit of a steel part: Se = ka kb kc kd ke kf Se'. For torsion the
 * result is the shear endurance limit (kc = 0.59).
 */
export function marinEnduranceLimit(
  p: {
    Sut: Param;
    /** Diameter (rotating bending or torsion); axial loading needs none. */
    d?: Param;
    /** Operating temperature, K. */
    temperature?: Param;
    reliability?: Param;
    /** Miscellaneous-effects factor. */
    kf?: Param;
  },
  choice: { surface: SurfaceFinish; loading: FatigueLoading; rotating?: boolean },
  options?: RecordOptions,
) {
  const s = SURFACE[choice.surface];
  const rotating = choice.rotating ?? true;
  const inputs: Record<string, InputSpec> = {
    Sut: { name: 'Ultimate tensile strength', symbol: 'S_ut', unit: 'Pa' },
    reliability: {
      name: 'Reliability',
      symbol: 'R',
      unit: '1',
      default: { value: 0.5, note: 'mean values (k_e = 1)' },
    },
    kf: {
      name: 'Miscellaneous-effects factor',
      symbol: 'k_f',
      unit: '1',
      default: { value: 1, note: 'no miscellaneous effects' },
    },
  };
  if (choice.loading !== 'axial') inputs.d = { name: 'Diameter', symbol: 'd', unit: 'm' };
  return calc<string, 'temperature'>(
    {
      id: 'fatigue.endurance-limit',
      title: `Endurance limit, ${s.label} surface, ${choice.loading}`,
      method: 'Marin equation with the textbook factors for steel',
      formula:
        "S_e = k_a k_b k_c k_d k_e k_f S_e'; S_e' = 0.5 S_ut (S_ut <= 1400 MPa), else 700 MPa",
      unit: 'Pa',
      sources: [
        shigley11('Eqs. (6-10), (6-17) to (6-20), (6-25) and Table 6-2'),
        shigley10('Eq. (6-27), temperature factor; Sec. 6-9, reliability factor'),
      ],
      assumptions: [
        'Steel; rotating-beam estimate of the endurance limit',
        `Surface ${s.label}: k_a = ${s.a} S_ut^${s.b} (MPa)`,
        choice.loading === 'axial'
          ? 'Axial loading: k_b = 1, k_c = 0.85'
          : choice.loading === 'torsion'
            ? 'Torsion: k_c = 0.59, result is the shear endurance limit'
            : 'Bending: k_c = 1',
        ...(choice.loading !== 'axial' && !rotating
          ? ['Non-rotating round bar: equivalent diameter 0.370 d']
          : []),
      ],
      inputs,
      optional: { temperature: { name: 'Operating temperature', symbol: 'T', unit: 'K' } },
    },
    p as Record<string, Param>,
    options,
    (v) => {
      const sut = (v.Sut as number) / MPA;
      requireRange(sut > 0, 'S_ut must be positive');
      const sePrime = sut <= 1400 ? 0.5 * sut : 700;
      const ka = s.a * sut ** s.b;
      const d = v.d as number | undefined;
      const kb =
        choice.loading === 'axial' || d === undefined ? 1 : sizeFactor(rotating ? d : 0.37 * d);
      const kc = choice.loading === 'bending' ? 1 : choice.loading === 'axial' ? 0.85 : 0.59;
      const kd = v.temperature === undefined ? 1 : temperatureFactor(v.temperature);
      const ke = reliabilityFactor(v.reliability as number);
      const se = ka * kb * kc * kd * ke * (v.kf as number) * sePrime;
      return {
        result: se * MPA,
        derived: [
          value('Rotating-beam endurance limit', "S_e'", sePrime * MPA, 'Pa'),
          value('Surface factor', 'k_a', ka, '1'),
          value('Size factor', 'k_b', kb, '1'),
          value('Load factor', 'k_c', kc, '1'),
          value('Temperature factor', 'k_d', kd, '1'),
          value('Reliability factor', 'k_e', ke, '1'),
        ],
        assumptions: v.temperature === undefined ? ['Room temperature (k_d = 1)'] : [],
      };
    },
  );
}

/**
 * Fatigue stress-concentration factor from the theoretical one through Neuber's notch sensitivity:
 * Kf = 1 + (Kt - 1) / (1 + √a / √r). Steels, S_ut from 50 to 250 kpsi.
 */
export function fatigueNotchFactor(
  p: { Kt: Param; r: Param; Sut: Param },
  loading: 'bending' | 'axial' | 'torsion',
  options?: RecordOptions,
) {
  const shear = loading === 'torsion';
  return calc(
    {
      id: 'fatigue.notch-factor',
      title: `Fatigue notch factor (${loading})`,
      method: "Neuber's equation with the textbook fit of the Neuber constant for steel",
      formula: shear
        ? 'K_fs = 1 + q_s (K_ts - 1), q_s = 1 / (1 + √a / √r), √a = 0.190 - 2.51e-3 S + 1.35e-5 S² - 2.67e-8 S³ (S in kpsi, √a in √in)'
        : 'K_f = 1 + q (K_t - 1), q = 1 / (1 + √a / √r), √a = 0.246 - 3.08e-3 S + 1.51e-5 S² - 2.67e-8 S³ (S in kpsi, √a in √in)',
      unit: '1',
      sources: [shigley11('Eqs. (6-32), (6-33), (6-35) and (6-36)')],
      assumptions: ['Steel', 'Fit valid for S_ut from 50 to 250 kpsi'],
      inputs: {
        Kt: { name: 'Theoretical stress-concentration factor', symbol: 'K_t', unit: '1' },
        r: { name: 'Notch radius', symbol: 'r', unit: 'm' },
        Sut: { name: 'Ultimate tensile strength', symbol: 'S_ut', unit: 'Pa' },
      },
    },
    p,
    options,
    (v) => {
      const S = v.Sut / (1000 * PSI);
      requireRange(S >= 50 && S <= 250, 'The Neuber-constant fit covers 50 to 250 kpsi');
      requireRange(v.r > 0 && v.Kt >= 1, 'r must be positive and K_t at least 1');
      const sqrtA = shear
        ? 0.19 - 2.51e-3 * S + 1.35e-5 * S * S - 2.67e-8 * S ** 3
        : 0.246 - 3.08e-3 * S + 1.51e-5 * S * S - 2.67e-8 * S ** 3;
      const q = 1 / (1 + sqrtA / Math.sqrt(v.r / INCH));
      return {
        result: 1 + q * (v.Kt - 1),
        derived: [
          value('Neuber constant', '√a', sqrtA * Math.sqrt(INCH), '√m'),
          value('Notch sensitivity', shear ? 'q_s' : 'q', q, '1'),
        ],
      };
    },
  );
}
