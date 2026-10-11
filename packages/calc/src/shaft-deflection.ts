// A round shaft on two bearings with one transverse point load: the bending moment along it, its
// deflection, and its slope at each bearing (Shigley Table A-9, beams 6 and 10). The load sits at a
// distance `a` from bearing A: between the bearings when a <= L, overhung beyond bearing B when
// a > L. Linear elastic, uniform section, bending only, short bearings acting as simple supports.

import {
  calc,
  requireRange,
  value,
  type CalcValue,
  type InputSpec,
  type Param,
  type RecordOptions,
} from './record';
import { shigley10 } from './sources';

/**
 * Bending moment magnitude at x (from bearing A) under a load F at a, with bearings at 0 and L.
 * Zero outside the shaft between bearing A and the load or bearing B, whichever is further.
 */
export function pointLoadMoment(F: number, a: number, L: number, x: number): number {
  if (x < 0) return 0;
  if (a <= L) {
    if (x > L) return 0;
    return Math.abs(x <= a ? (F * (L - a) * x) / L : (F * a * (L - x)) / L);
  }
  const c = a - L;
  if (x <= L) return Math.abs((F * c * x) / L);
  return x <= a ? Math.abs(F * (a - x)) : 0;
}

/**
 * Deflection magnitude at x under a load F at a, for a shaft of bending stiffness E I between
 * bearings at 0 and L (Table A-9 beam 6 between the bearings, beam 10 for an overhung load).
 */
export function pointLoadDeflectionAt(
  F: number,
  a: number,
  L: number,
  EI: number,
  x: number,
): number {
  if (a <= L) {
    if (x < 0 || x > L) return Number.NaN;
    const b = L - a;
    const y =
      x <= a
        ? (F * b * x * (L * L - b * b - x * x)) / (6 * EI * L)
        : (F * a * (L - x) * (L * L - a * a - (L - x) ** 2)) / (6 * EI * L);
    return Math.abs(y);
  }
  const c = a - L;
  if (x < 0 || x > a) return Number.NaN;
  if (x <= L) return Math.abs((F * c * x * (L * L - x * x)) / (6 * EI * L));
  const u = x - L;
  return Math.abs(((F * u) / (6 * EI)) * (u * u - c * (3 * x - L)));
}

/** The largest deflection magnitude along the shaft and where it is. */
function maxDeflection(F: number, a: number, L: number, EI: number): { y: number; x: number } {
  if (a <= L) {
    const b = L - a;
    // The maximum lies in the longer part, at √((L² - s²)/3) from the far bearing's side.
    if (a >= b) {
      const x = Math.sqrt((L * L - b * b) / 3);
      return { y: (F * b * (L * L - b * b) ** 1.5) / (9 * Math.sqrt(3) * EI * L), x };
    }
    const fromB = Math.sqrt((L * L - a * a) / 3);
    return { y: (F * a * (L * L - a * a) ** 1.5) / (9 * Math.sqrt(3) * EI * L), x: L - fromB };
  }
  const c = a - L;
  const tip = (F * c * c * (L + c)) / (3 * EI);
  // Between the bearings the shaft bows the other way, most at x = L/√3.
  const between = (F * c * L * L) / (9 * Math.sqrt(3) * EI);
  return tip >= between ? { y: tip, x: a } : { y: between, x: L / Math.sqrt(3) };
}

/** Slopes at bearings A and B, magnitudes. */
function bearingSlopes(F: number, a: number, L: number, EI: number): { A: number; B: number } {
  if (a <= L) {
    const b = L - a;
    return {
      A: Math.abs((F * b * (L * L - b * b)) / (6 * EI * L)),
      B: Math.abs((F * a * (L * L - a * a)) / (6 * EI * L)),
    };
  }
  const c = a - L;
  return { A: Math.abs((F * c * L) / (6 * EI)), B: Math.abs((F * c * L) / (3 * EI)) };
}

const COMMON: Record<'F' | 'a' | 'L' | 'E' | 'd', InputSpec> = {
  F: { name: 'Transverse load', symbol: 'F', unit: 'N' },
  a: { name: 'Load distance from the first bearing', symbol: 'a', unit: 'm' },
  L: { name: 'Span between the bearings', symbol: 'L', unit: 'm' },
  E: { name: "Young's modulus", symbol: 'E', unit: 'Pa' },
  d: { name: 'Shaft diameter', symbol: 'd', unit: 'm' },
};
const BORE: InputSpec = { name: 'Bore diameter (hollow shaft)', symbol: 'd_i', unit: 'm' };
const ASSUMPTIONS = [
  'Linear elastic, uniform round section, bending deflection only (shear deflection neglected)',
  'The bearings are short and act as simple supports (they carry no moment)',
];

function section(v: { L: number; a: number; E: number; d: number; di?: number }) {
  requireRange(v.L > 0 && v.E > 0 && v.d > 0, 'L, E and d must be positive');
  requireRange(v.a >= 0, 'The load must lie at or beyond bearing A (a >= 0)');
  const bore = v.di ?? 0;
  requireRange(bore >= 0 && bore < v.d, 'The bore must be smaller than the diameter');
  const I = (Math.PI * (v.d ** 4 - bore ** 4)) / 64;
  return { I, EI: v.E * I };
}

function placement(a: number, L: number): string {
  return a <= L
    ? 'Load between the bearings (Table A-9, beam 6)'
    : 'Load overhung beyond bearing B (Table A-9, beam 10)';
}

/** The largest deflection of the shaft under the load, with the deflection under the load itself. */
export function shaftPointLoadDeflection(
  p: { F: Param; a: Param; L: Param; E: Param; d: Param; di?: Param; maxDeflection?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'shaft.point-load-deflection',
      title: 'Shaft deflection under a point load',
      method: 'Elastic deflection of a shaft on two simple supports with one point load',
      formula:
        'a <= L: y_max = F s (L² - s²)^(3/2) / (9√3 E I L), s = min(a, L - a); a > L, c = a - L: y_max = max(F c² (L + c) / (3 E I), F c L² / (9√3 E I)); I = π (d⁴ - d_i⁴) / 64',
      unit: 'm',
      sources: [shigley10('Table A-9, beams 6 and 10')],
      assumptions: ASSUMPTIONS,
      inputs: COMMON,
      optional: {
        di: BORE,
        maxDeflection: { name: 'Allowed deflection', symbol: 'y_allow', unit: 'm' },
      },
      limit: { input: 'maxDeflection', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      const { I, EI } = section(v);
      const m = maxDeflection(v.F, v.a, v.L, EI);
      const derived: CalcValue[] = [
        value('Second moment of area', 'I', I, 'm^4'),
        value('Position of the largest deflection from bearing A', 'x_max', m.x, 'm'),
        value(
          'Deflection under the load',
          'y_F',
          pointLoadDeflectionAt(v.F, v.a, v.L, EI, v.a),
          'm',
        ),
      ];
      return { result: m.y, derived, assumptions: [placement(v.a, v.L)] };
    },
  );
}

/** The slope of the shaft at one bearing, with the other bearing's slope in the working. */
export function shaftBearingSlope(
  p: { F: Param; a: Param; L: Param; E: Param; d: Param; di?: Param; maxSlope?: Param },
  bearing: 'A' | 'B',
  options?: RecordOptions,
) {
  const other = bearing === 'A' ? 'B' : 'A';
  return calc(
    {
      id: `shaft.bearing-slope-${bearing.toLowerCase()}`,
      title: `Shaft slope at bearing ${bearing}`,
      method: 'Elastic slope of a shaft on two simple supports with one point load',
      formula:
        'a <= L, b = L - a: θ_A = F b (L² - b²) / (6 E I L), θ_B = F a (L² - a²) / (6 E I L); a > L, c = a - L: θ_A = F c L / (6 E I), θ_B = F c L / (3 E I)',
      unit: 'rad',
      sources: [shigley10('Table A-9, beams 6 and 10')],
      assumptions: ASSUMPTIONS,
      inputs: COMMON,
      optional: { di: BORE, maxSlope: { name: 'Allowed slope', symbol: 'θ_allow', unit: 'rad' } },
      limit: { input: 'maxSlope', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      const { I, EI } = section(v);
      const s = bearingSlopes(v.F, v.a, v.L, EI);
      return {
        result: s[bearing],
        derived: [
          value('Second moment of area', 'I', I, 'm^4'),
          value(`Slope at bearing ${other}`, `θ_${other}`, s[other], 'rad'),
        ],
        assumptions: [placement(v.a, v.L)],
      };
    },
  );
}
