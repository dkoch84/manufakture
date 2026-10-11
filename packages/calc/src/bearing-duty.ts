// Rolling bearings over a duty cycle: the equivalent load of a load that varies over the turns of
// a cycle (Palmgren-Miner with the life exponent), the rating life in hours of a cycle repeated,
// and the speed against the maker's limiting speed. The single-load formulas are in ./bearings.

import {
  calc,
  requireRange,
  value,
  type InputSpec,
  type Param,
  type RecordOptions,
} from './record';
import { iso281, shigley10 } from './sources';

/** One step of a duty cycle: a steady load held over a number of revolutions. */
export interface DutyStep {
  /** N. */
  load: number;
  /** Revolutions at that load in one cycle. */
  revolutions: number;
}

/**
 * The load that does the same damage over the same revolutions as the steps:
 * F_m = (Σ F_i^p N_i / Σ N_i)^(1/p). Zero revolutions in total give NaN.
 */
export function cubicMeanLoad(steps: readonly DutyStep[], exponent: number): number {
  let damage = 0;
  let turns = 0;
  for (const s of steps) {
    damage += Math.abs(s.load) ** exponent * s.revolutions;
    turns += s.revolutions;
  }
  return turns > 0 ? (damage / turns) ** (1 / exponent) : Number.NaN;
}

/**
 * Equivalent load of a piecewise steady duty cycle, as a record: each step's load and revolutions
 * are inputs (`F1`, `N1`, ...), the exponent p is 3 for ball and 10/3 for roller bearings.
 */
export function bearingDutyLoad(
  steps: readonly { load: Param; revolutions: Param }[],
  exponent: Param,
  options?: RecordOptions,
) {
  const inputs: Record<string, InputSpec> = {
    p: { name: 'Life exponent', symbol: 'p', unit: '1' },
  };
  const params: Record<string, Param> = { p: exponent };
  steps.forEach((s, i) => {
    const n = i + 1;
    inputs[`F${n}`] = { name: `Load of step ${n}`, symbol: `F_${n}`, unit: 'N' };
    inputs[`N${n}`] = { name: `Revolutions of step ${n}`, symbol: `N_${n}`, unit: 'rev' };
    params[`F${n}`] = s.load;
    params[`N${n}`] = s.revolutions;
  });
  return calc(
    {
      id: 'bearing.duty-load',
      title: 'Bearing equivalent load over a duty cycle',
      method: 'Palmgren-Miner: the steady load that does the same damage over the same turns',
      formula: 'F_m = (Σ F_i^p N_i / Σ N_i)^(1/p)',
      unit: 'N',
      sources: [
        iso281('equivalent load for a variable load'),
        shigley10('Sec. 11-8, variable loading'),
      ],
      assumptions: ['Each step is a steady load at a steady speed; the order of the steps is not'],
      inputs,
    },
    params,
    options,
    (v) => {
      const p = v.p!;
      requireRange(p > 0, 'The life exponent must be positive');
      const list = steps.map((_, i) => ({ load: v[`F${i + 1}`]!, revolutions: v[`N${i + 1}`]! }));
      requireRange(
        list.every((s) => s.revolutions >= 0),
        'Revolutions must not be negative',
      );
      const turns = list.reduce((t, s) => t + s.revolutions, 0);
      requireRange(turns > 0, 'The cycle must turn the bearing');
      return {
        result: cubicMeanLoad(list, p),
        derived: [value('Revolutions in a cycle', 'N', turns, 'rev')],
      };
    },
  );
}

/**
 * Rating life in hours of a duty cycle repeated: L = (C/P)^p × 10⁶ revolutions, divided by the
 * revolutions of one cycle and multiplied by its duration. The result is in hours (unit `h`), as
 * bearing lives are stated; the required life, when given, is in hours too.
 */
export function bearingDutyLife(
  p: {
    C: Param;
    P: Param;
    exponent: Param;
    /** Revolutions of the bearing in one cycle. */
    revolutionsPerCycle: Param;
    /** Duration of one cycle, s (pauses and rests included). */
    cycleDuration: Param;
    /** The life the caller wants, h. */
    requiredLife?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bearing.duty-life',
      title: 'Bearing rating life over a duty cycle',
      method: 'ISO 281 basic rating life, counted in cycles of the duty and then in hours',
      formula: 'L10 = (C/P)^p × 10⁶ rev; L_h = L10 / N_c × t_c',
      unit: 'h',
      sources: [
        iso281('basic rating life'),
        shigley10('Eq. (11-1) and Eq. (11-3); Sec. 11-8, variable loading'),
      ],
      assumptions: ['90 % reliability (L10), no life modification factors'],
      inputs: {
        C: { name: 'Basic dynamic load rating', symbol: 'C', unit: 'N' },
        P: { name: 'Equivalent dynamic load', symbol: 'P', unit: 'N' },
        exponent: { name: 'Life exponent', symbol: 'p', unit: '1' },
        revolutionsPerCycle: { name: 'Revolutions in a cycle', symbol: 'N_c', unit: 'rev' },
        cycleDuration: { name: 'Duration of a cycle', symbol: 't_c', unit: 's' },
      },
      optional: { requiredLife: { name: 'Your life target', symbol: 'L_req', unit: 'h' } },
      limit: { input: 'requiredLife', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.C > 0 && v.P > 0, 'C and P must be positive');
      requireRange(v.exponent > 0, 'The life exponent must be positive');
      requireRange(v.revolutionsPerCycle > 0, 'The cycle must turn the bearing');
      requireRange(v.cycleDuration > 0, 'The cycle must take time');
      const L10 = (v.C / v.P) ** v.exponent * 1e6;
      const cycles = L10 / v.revolutionsPerCycle;
      return {
        result: (cycles * v.cycleDuration) / 3600,
        derived: [
          value('Basic rating life', 'L10', L10, 'rev'),
          value('Cycles in that life', 'n_c', cycles, '1'),
        ],
      };
    },
  );
}

/** A bearing's highest speed against the maker's limiting speed, with the margin left. */
export function bearingSpeed(p: { speed: Param; limitingSpeed: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'bearing.speed',
      title: 'Bearing speed against its limiting speed',
      method: "The highest speed compared with the maker's limiting speed",
      formula: 'ω ≤ ω_lim',
      unit: 'rad/s',
      sources: [
        {
          title: "The bearing maker's catalogue",
          locator: 'limiting speed (set by the cage, the seals and the lubrication)',
        },
      ],
      assumptions: [
        'The limiting speed is for the bearing as listed: grease, seals and fit as the maker states them',
      ],
      inputs: {
        speed: { name: 'Highest speed', symbol: 'ω', unit: 'rad/s' },
        limitingSpeed: { name: 'Limiting speed', symbol: 'ω_lim', unit: 'rad/s' },
      },
      limit: { input: 'limitingSpeed', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      requireRange(v.speed >= 0, 'The speed must not be negative');
      requireRange(v.limitingSpeed > 0, 'The limiting speed must be positive');
      return {
        result: v.speed,
        derived: [
          value('Speed over the limiting speed', 'ω/ω_lim', v.speed / v.limitingSpeed, '1'),
        ],
      };
    },
  );
}
