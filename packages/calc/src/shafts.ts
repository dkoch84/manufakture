// Shafts: combined bending and torsion, fatigue against the distortion-energy criteria with
// Goodman, Gerber, ASME-elliptic or Soderberg lines, twist, and the first critical speed (Shigley
// chapter 7). Solid or hollow round shafts.

import { REQUIRED_FACTOR } from './factor';
import {
  calc,
  requireRange,
  value,
  type CalcRecord,
  type InputSpec,
  type Param,
  type RecordOptions,
} from './record';
import { shigley10 } from './sources';

/** Standard gravity, m/s². */
export const STANDARD_GRAVITY = 9.80665;

const D = { name: 'Shaft diameter', symbol: 'd', unit: 'm' } as const;
const DI = { name: 'Bore diameter (hollow shaft)', symbol: 'd_i', unit: 'm' } as const;
const KF = {
  name: 'Fatigue stress-concentration factor, bending',
  symbol: 'K_f',
  unit: '1',
  default: { value: 1, note: 'no stress concentration' },
} as const;
const KFS = {
  name: 'Fatigue stress-concentration factor, torsion',
  symbol: 'K_fs',
  unit: '1',
  default: { value: 1, note: 'no stress concentration' },
} as const;

function sections(d: number, di: number | undefined) {
  const bore = di ?? 0;
  requireRange(d > 0 && bore >= 0 && bore < d, 'The bore must be smaller than the diameter');
  const I = (Math.PI * (d ** 4 - bore ** 4)) / 64;
  return { I, J: 2 * I, A: (Math.PI * (d * d - bore * bore)) / 4 };
}

/**
 * Von Mises stress at the surface of a round shaft under a bending moment, a torque and an optional
 * axial force, each with its stress-concentration factor.
 */
export function shaftStress(
  p: { M: Param; T: Param; d: Param; Fa?: Param; di?: Param; Kf?: Param; Kfs?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'shaft.stress',
      title: 'Shaft stress: von Mises from bending and torsion',
      method: 'Distortion energy (von Mises) of surface bending, axial and torsional stresses',
      formula:
        "σ = K_f (32 M d / π(d⁴ - d_i⁴) + 4 F_a / π(d² - d_i²)); τ = K_fs 16 T d / π(d⁴ - d_i⁴); σ' = √(σ² + 3τ²)",
      unit: 'Pa',
      sources: [shigley10('Sec. 7-4, Eqs. (7-5), (7-6) and (7-15)'), shigley10('Eq. (5-15)')],
      assumptions: [
        'Linear elastic; stresses at the outer surface',
        'The bending factor K_f also applies to the axial stress',
      ],
      inputs: {
        M: { name: 'Bending moment', symbol: 'M', unit: 'N·m' },
        T: { name: 'Torque', symbol: 'T', unit: 'N·m' },
        d: D,
        Kf: KF,
        Kfs: KFS,
      },
      optional: { Fa: { name: 'Axial force', symbol: 'F_a', unit: 'N' }, di: DI },
    },
    p,
    options,
    (v) => {
      const { I, J, A } = sections(v.d, v.di);
      const sigma = v.Kf * ((v.M * v.d) / (2 * I) + (v.Fa ?? 0) / A);
      const tau = (v.Kfs * v.T * v.d) / (2 * J);
      return {
        result: Math.sqrt(sigma * sigma + 3 * tau * tau),
        derived: [value('Normal stress', 'σ', sigma, 'Pa'), value('Shear stress', 'τ', tau, 'Pa')],
      };
    },
  );
}

export type FatigueCriterion = 'goodman' | 'gerber' | 'asme-elliptic' | 'soderberg';

interface FatigueParams {
  /** Alternating and mean bending moments. */
  Ma: Param;
  Mm?: Param;
  /** Alternating and mean torques. */
  Ta?: Param;
  Tm: Param;
  d: Param;
  Kf?: Param;
  Kfs?: Param;
  /** Fully corrected endurance limit at the location (see marinEnduranceLimit). */
  Se: Param;
  /** Ultimate tensile strength (Goodman, Gerber). */
  Sut?: Param;
  /** Yield strength (ASME elliptic, Soderberg). */
  Sy?: Param;
  requiredFactor?: Param;
}

const CRITERIA: Record<
  FatigueCriterion,
  { label: string; equation: string; formula: string; strength: 'Sut' | 'Sy' }
> = {
  goodman: {
    label: 'DE-Goodman',
    equation: 'Eq. (7-8)',
    formula: '1/n = 16/(π d³) [A/S_e + B/S_ut]',
    strength: 'Sut',
  },
  gerber: {
    label: 'DE-Gerber',
    equation: 'Eq. (7-10)',
    formula: '1/n = 8A/(π d³ S_e) [1 + √(1 + (2 B S_e / (A S_ut))²)]',
    strength: 'Sut',
  },
  'asme-elliptic': {
    label: 'DE-ASME elliptic',
    equation: 'Eq. (7-12)',
    formula:
      '1/n = 16/(π d³) √(4(K_f M_a/S_e)² + 3(K_fs T_a/S_e)² + 4(K_f M_m/S_y)² + 3(K_fs T_m/S_y)²)',
    strength: 'Sy',
  },
  soderberg: {
    label: 'DE-Soderberg',
    equation: 'Eq. (7-14)',
    formula: '1/n = 16/(π d³) [A/S_e + B/S_y]',
    strength: 'Sy',
  },
};

/**
 * Fatigue factor of a solid round shaft under fluctuating bending and torsion, by the
 * distortion-energy criterion with the chosen failure line (Shigley Sec. 7-4).
 * A = √(4(K_f M_a)² + 3(K_fs T_a)²), B = √(4(K_f M_m)² + 3(K_fs T_m)²).
 */
export function shaftFatigueFactor(
  p: FatigueParams,
  criterion: FatigueCriterion,
  options?: RecordOptions,
): CalcRecord {
  const c = CRITERIA[criterion];
  const strength: InputSpec =
    c.strength === 'Sut'
      ? { name: 'Ultimate tensile strength', symbol: 'S_ut', unit: 'Pa' }
      : { name: 'Yield strength', symbol: 'S_y', unit: 'Pa' };
  const zero = { value: 0, note: 'none' };
  const inputs: Record<string, InputSpec> = {
    Ma: { name: 'Alternating bending moment', symbol: 'M_a', unit: 'N·m' },
    Mm: { name: 'Mean bending moment', symbol: 'M_m', unit: 'N·m', default: zero },
    Ta: { name: 'Alternating torque', symbol: 'T_a', unit: 'N·m', default: zero },
    Tm: { name: 'Mean torque', symbol: 'T_m', unit: 'N·m' },
    d: D,
    Kf: KF,
    Kfs: KFS,
    Se: { name: 'Endurance limit at the location', symbol: 'S_e', unit: 'Pa' },
    [c.strength]: strength,
  };
  return calc<string, 'requiredFactor'>(
    {
      id: `shaft.fatigue-${criterion}`,
      title: `Shaft fatigue factor (${c.label})`,
      method: `${c.label}: distortion-energy stresses against the ${c.label.slice(3)} line`,
      formula: c.formula,
      unit: '1',
      sources: [shigley10(`Sec. 7-4, ${c.equation}`)],
      assumptions: [
        'Solid round shaft, infinite-life fatigue, stresses at the surface',
        'Axial load neglected; stress-concentration factors apply to amplitude and mean alike',
      ],
      inputs,
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p as unknown as Record<string, Param>,
    options,
    (v) => {
      const d = v.d as number;
      const Kf = v.Kf as number;
      const Kfs = v.Kfs as number;
      const Ma = v.Ma as number;
      const Mm = v.Mm as number;
      const Ta = v.Ta as number;
      const Tm = v.Tm as number;
      const Se = v.Se as number;
      requireRange(d > 0 && Se > 0, 'd and S_e must be positive');
      const A = Math.sqrt(4 * (Kf * Ma) ** 2 + 3 * (Kfs * Ta) ** 2);
      const B = Math.sqrt(4 * (Kf * Mm) ** 2 + 3 * (Kfs * Tm) ** 2);
      const k = 16 / (Math.PI * d ** 3);
      let inverse: number;
      if (criterion === 'goodman') inverse = k * (A / Se + B / (v.Sut as number));
      else if (criterion === 'soderberg') inverse = k * (A / Se + B / (v.Sy as number));
      else if (criterion === 'gerber') {
        const Sut = v.Sut as number;
        requireRange(A > 0, 'Gerber needs an alternating stress');
        inverse =
          ((8 * A) / (Math.PI * d ** 3 * Se)) *
          (1 + Math.sqrt(1 + ((2 * B * Se) / (A * Sut)) ** 2));
      } else {
        const Sy = v.Sy as number;
        inverse =
          k *
          Math.sqrt(
            4 * ((Kf * Ma) / Se) ** 2 +
              3 * ((Kfs * Ta) / Se) ** 2 +
              4 * ((Kf * Mm) / Sy) ** 2 +
              3 * ((Kfs * Tm) / Sy) ** 2,
          );
      }
      return {
        result: 1 / inverse,
        derived: [
          value('Alternating von Mises stress', "σ'_a", k * A, 'Pa'),
          value('Mean von Mises stress', "σ'_m", k * B, 'Pa'),
        ],
      };
    },
  );
}

/** Angle of twist of a round shaft length L under torque T. */
export function shaftTwist(
  p: { T: Param; L: Param; d: Param; G: Param; di?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'shaft.twist',
      title: 'Shaft angle of twist',
      method: 'Elastic torsion of a round bar',
      formula: 'θ = T L / (G J), J = π (d⁴ - d_i⁴) / 32',
      unit: 'rad',
      sources: [shigley10('Eq. (4-5)')],
      assumptions: ['Linear elastic, uniform section over the length'],
      inputs: {
        T: { name: 'Torque', symbol: 'T', unit: 'N·m' },
        L: { name: 'Length', symbol: 'L', unit: 'm' },
        d: D,
        G: { name: 'Shear modulus', symbol: 'G', unit: 'Pa' },
      },
      optional: { di: DI },
    },
    p,
    options,
    (v) => {
      const { J } = sections(v.d, v.di);
      return {
        result: (v.T * v.L) / (v.G * J),
        derived: [value('Polar second moment', 'J', J, 'm^4')],
      };
    },
  );
}

/** First critical speed of a uniform simply supported shaft carrying only its own mass. */
export function uniformShaftCriticalSpeed(
  p: { L: Param; d: Param; E: Param; density: Param; di?: Param; operatingSpeed?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'shaft.critical-speed-uniform',
      title: 'First critical speed of a uniform shaft',
      method: 'Simply supported uniform shaft, first bending mode',
      formula: 'ω₁ = (π / L)² √(E I / (ρ A))',
      unit: 'rad/s',
      sources: [shigley10('Sec. 7-6, Eq. (7-22)')],
      assumptions: ['Simply supported ends, uniform section, no attached masses'],
      inputs: {
        L: { name: 'Span between bearings', symbol: 'L', unit: 'm' },
        d: D,
        E: { name: "Young's modulus", symbol: 'E', unit: 'Pa' },
        density: { name: 'Density', symbol: 'ρ', unit: 'kg/m^3' },
      },
      optional: {
        di: DI,
        operatingSpeed: { name: 'Operating speed', symbol: 'ω', unit: 'rad/s' },
      },
    },
    p,
    options,
    (v) => {
      const { I, A } = sections(v.d, v.di);
      const w1 = (Math.PI / v.L) ** 2 * Math.sqrt((v.E * I) / (v.density * A));
      return {
        result: w1,
        derived:
          v.operatingSpeed === undefined
            ? []
            : [value('Critical speed over operating speed', 'ω₁/ω', w1 / v.operatingSpeed, '1')],
      };
    },
  );
}

export interface ShaftStation {
  /** Mass carried at the station. */
  mass: Param;
  /** Rayleigh: static deflection at the station under all the weights. */
  deflection?: Param;
  /** Dunkerley: influence coefficient a_ii (deflection at i per unit force at i), m/N. */
  influence?: Param;
}

function stationInputs(stations: ShaftStation[], second: 'deflection' | 'influence') {
  const inputs: Record<string, InputSpec> = {};
  const params: Record<string, Param> = {};
  stations.forEach((s, i) => {
    const n = i + 1;
    inputs[`m${n}`] = { name: `Mass at station ${n}`, symbol: `m${n}`, unit: 'kg' };
    params[`m${n}`] = s.mass;
    inputs[`${second}${n}`] =
      second === 'deflection'
        ? { name: `Static deflection at station ${n}`, symbol: `y${n}`, unit: 'm' }
        : { name: `Influence coefficient at station ${n}`, symbol: `a${n}${n}`, unit: 'm/N' };
    params[`${second}${n}`] = s[second];
  });
  return { inputs, params };
}

/** Rayleigh's estimate of the first critical speed from the static deflections under the masses. */
export function rayleighCriticalSpeed(stations: ShaftStation[], options?: RecordOptions) {
  const { inputs, params } = stationInputs(stations, 'deflection');
  return calc<string>(
    {
      id: 'shaft.critical-speed-rayleigh',
      title: 'First critical speed (Rayleigh)',
      method: "Rayleigh's method with the static deflection curve",
      formula: 'ω₁ = √(g Σ mᵢ yᵢ / Σ mᵢ yᵢ²)',
      unit: 'rad/s',
      sources: [shigley10('Sec. 7-6, Eq. (7-23)')],
      assumptions: [
        'Lumped masses; deflections are the static deflections under all the weights',
        'Rayleigh overestimates the first critical speed slightly',
      ],
      inputs,
    },
    params,
    options,
    (v) => {
      requireRange(stations.length > 0, 'At least one station is needed');
      let num = 0;
      let den = 0;
      stations.forEach((_, i) => {
        const m = v[`m${i + 1}`] as number;
        const y = Math.abs(v[`deflection${i + 1}`] as number);
        num += m * y;
        den += m * y * y;
      });
      requireRange(den > 0, 'The deflections must not all be zero');
      return { result: Math.sqrt((STANDARD_GRAVITY * num) / den) };
    },
  );
}

/** Dunkerley's lower-bound estimate of the first critical speed. */
export function dunkerleyCriticalSpeed(
  stations: ShaftStation[],
  shaftAlone?: Param,
  options?: RecordOptions,
) {
  const { inputs, params } = stationInputs(stations, 'influence');
  return calc<string, 'shaft'>(
    {
      id: 'shaft.critical-speed-dunkerley',
      title: 'First critical speed (Dunkerley)',
      method: "Dunkerley's equation over the stations (and the shaft alone, if given)",
      formula: '1/ω₁² = Σ mᵢ aᵢᵢ + 1/ω_s²',
      unit: 'rad/s',
      sources: [shigley10('Sec. 7-6, Eq. (7-32)')],
      assumptions: ['Lumped masses; Dunkerley underestimates the first critical speed'],
      inputs,
      optional: {
        shaft: { name: 'Critical speed of the shaft alone', symbol: 'ω_s', unit: 'rad/s' },
      },
    },
    { ...params, shaft: shaftAlone },
    options,
    (v) => {
      requireRange(stations.length > 0, 'At least one station is needed');
      let sum = v.shaft === undefined ? 0 : 1 / v.shaft ** 2;
      stations.forEach((_, i) => {
        sum += (v[`m${i + 1}`] as number) * (v[`influence${i + 1}`] as number);
      });
      requireRange(sum > 0, 'The influence coefficients must be positive');
      return { result: 1 / Math.sqrt(sum) };
    },
  );
}
