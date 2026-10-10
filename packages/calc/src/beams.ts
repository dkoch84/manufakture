// Beam deflection and bending for the standard cases (Roark Table 8.1; Shigley Table A-9). Linear
// elastic, small deflection, prismatic beam, bending only (shear deflection neglected).

import {
  calc,
  requireRange,
  value,
  type CalcValue,
  type Param,
  type RecordOptions,
} from './record';
import { roark, shigley10 } from './sources';

const E = { name: "Young's modulus", symbol: 'E', unit: 'Pa' } as const;
const I = { name: 'Second moment of area', symbol: 'I', unit: 'm^4' } as const;
const L = { name: 'Span', symbol: 'L', unit: 'm' } as const;
const C = { name: 'Distance to the extreme fibre', symbol: 'c', unit: 'm' } as const;
const Y_MAX = { name: 'Allowed deflection', symbol: 'y_allow', unit: 'm' } as const;
const ASSUMPTIONS = [
  'Linear elastic, small deflections, prismatic beam',
  'Bending deflection only; shear deflection neglected',
];

interface BeamParams {
  L: Param;
  E: Param;
  I: Param;
  /** Distance from the neutral axis to the extreme fibre; gives the bending stress. */
  c?: Param;
  /** An allowed deflection to compare the result with. */
  maxDeflection?: Param;
}

function common(v: { E: number; I: number; L: number }) {
  requireRange(v.E > 0 && v.I > 0 && v.L > 0, 'E, I and L must be positive');
}

function stress(M: number, c: number | undefined, i: number): CalcValue[] {
  return c === undefined ? [] : [value('Maximum bending stress', 'σ_max', (M * c) / i, 'Pa')];
}

/** Cantilever with a point load F at distance a from the fixed end (a = L is an end load). */
export function cantileverPointLoad(
  p: BeamParams & { F: Param; a?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'beam.cantilever-point-load',
      title: 'Cantilever with a point load: tip deflection',
      method: 'Roark cantilever, concentrated load',
      formula: 'y = F a² (3L - a) / (6 E I); M_max = F a; θ = F a² / (2 E I)',
      unit: 'm',
      sources: [roark('Table 8.1, case 1a'), shigley10('Table A-9, beams 1 and 2')],
      assumptions: ASSUMPTIONS,
      inputs: {
        F: { name: 'Load', symbol: 'F', unit: 'N' },
        L,
        E,
        I,
      },
      optional: {
        a: { name: 'Load position from the fixed end', symbol: 'a', unit: 'm' },
        c: C,
        maxDeflection: Y_MAX,
      },
      limit: { input: 'maxDeflection', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      common(v);
      const a = v.a ?? v.L;
      requireRange(a > 0 && a <= v.L, 'The load must lie on the span (0 < a <= L)');
      const M = v.F * a;
      return {
        result: (v.F * a * a * (3 * v.L - a)) / (6 * v.E * v.I),
        derived: [
          value('Maximum bending moment (at the support)', 'M_max', M, 'N·m'),
          value('Slope at the free end', 'θ', (v.F * a * a) / (2 * v.E * v.I), 'rad'),
          ...stress(M, v.c, v.I),
        ],
        assumptions: v.a === undefined ? ['Load at the free end (a = L)'] : [],
      };
    },
  );
}

/** Cantilever with a uniform load w per unit length over the whole span. */
export function cantileverUniformLoad(p: BeamParams & { w: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'beam.cantilever-uniform-load',
      title: 'Cantilever with a uniform load: tip deflection',
      method: 'Roark cantilever, uniformly distributed load',
      formula: 'y = w L⁴ / (8 E I); M_max = w L² / 2; θ = w L³ / (6 E I)',
      unit: 'm',
      sources: [roark('Table 8.1, case 2a'), shigley10('Table A-9, beam 3')],
      assumptions: ASSUMPTIONS,
      inputs: { w: { name: 'Load per unit length', symbol: 'w', unit: 'N/m' }, L, E, I },
      optional: { c: C, maxDeflection: Y_MAX },
      limit: { input: 'maxDeflection', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      common(v);
      const M = (v.w * v.L * v.L) / 2;
      return {
        result: (v.w * v.L ** 4) / (8 * v.E * v.I),
        derived: [
          value('Maximum bending moment (at the support)', 'M_max', M, 'N·m'),
          value('Slope at the free end', 'θ', (v.w * v.L ** 3) / (6 * v.E * v.I), 'rad'),
          ...stress(M, v.c, v.I),
        ],
      };
    },
  );
}

/** Simply supported beam with a point load F at mid-span. */
export function simplySupportedCentreLoad(p: BeamParams & { F: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'beam.simply-supported-centre-load',
      title: 'Simply supported beam, centre load: mid-span deflection',
      method: 'Roark simply supported beam, concentrated load at mid-span',
      formula: 'y = F L³ / (48 E I); M_max = F L / 4; θ_end = F L² / (16 E I)',
      unit: 'm',
      sources: [roark('Table 8.1, case 1e'), shigley10('Table A-9, beam 5')],
      assumptions: ASSUMPTIONS,
      inputs: { F: { name: 'Load', symbol: 'F', unit: 'N' }, L, E, I },
      optional: { c: C, maxDeflection: Y_MAX },
      limit: { input: 'maxDeflection', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      common(v);
      const M = (v.F * v.L) / 4;
      return {
        result: (v.F * v.L ** 3) / (48 * v.E * v.I),
        derived: [
          value('Maximum bending moment (mid-span)', 'M_max', M, 'N·m'),
          value('Slope at the supports', 'θ', (v.F * v.L * v.L) / (16 * v.E * v.I), 'rad'),
          ...stress(M, v.c, v.I),
        ],
      };
    },
  );
}

/** Simply supported beam with a uniform load w per unit length. */
export function simplySupportedUniformLoad(p: BeamParams & { w: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'beam.simply-supported-uniform-load',
      title: 'Simply supported beam, uniform load: mid-span deflection',
      method: 'Roark simply supported beam, uniformly distributed load',
      formula: 'y = 5 w L⁴ / (384 E I); M_max = w L² / 8; θ_end = w L³ / (24 E I)',
      unit: 'm',
      sources: [roark('Table 8.1, case 2e'), shigley10('Table A-9, beam 7')],
      assumptions: ASSUMPTIONS,
      inputs: { w: { name: 'Load per unit length', symbol: 'w', unit: 'N/m' }, L, E, I },
      optional: { c: C, maxDeflection: Y_MAX },
      limit: { input: 'maxDeflection', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      common(v);
      const M = (v.w * v.L * v.L) / 8;
      return {
        result: (5 * v.w * v.L ** 4) / (384 * v.E * v.I),
        derived: [
          value('Maximum bending moment (mid-span)', 'M_max', M, 'N·m'),
          value('Slope at the supports', 'θ', (v.w * v.L ** 3) / (24 * v.E * v.I), 'rad'),
          ...stress(M, v.c, v.I),
        ],
      };
    },
  );
}
