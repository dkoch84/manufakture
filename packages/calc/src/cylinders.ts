// Thick-walled cylinders under internal and external pressure (Lamé).

import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { shigley10 } from './sources';

/**
 * Lamé stresses at radius r of a thick cylinder; the result is the tangential (hoop) stress.
 * Derived: radial stress, longitudinal stress for closed ends, and the von Mises stress.
 */
export function lameStresses(
  p: { ri: Param; ro: Param; pi?: Param; po?: Param; r?: Param; closedEnds?: boolean },
  options?: RecordOptions,
) {
  const closed = p.closedEnds ?? false;
  return calc(
    {
      id: 'cylinder.lame',
      title: 'Thick cylinder: hoop stress (Lamé)',
      method: 'Lamé solution for a thick-walled cylinder',
      formula:
        'σ_t = (p_i r_i² - p_o r_o² - r_i² r_o² (p_o - p_i)/r²) / (r_o² - r_i²); σ_r = (p_i r_i² - p_o r_o² + r_i² r_o² (p_o - p_i)/r²) / (r_o² - r_i²)',
      unit: 'Pa',
      sources: [shigley10('Eqs. (3-49) and (3-50), pressurized cylinders')],
      assumptions: [
        'Linear elastic, long cylinder away from its ends',
        closed ? 'Closed ends: σ_l = (p_i r_i² - p_o r_o²) / (r_o² - r_i²)' : 'Open ends: σ_l = 0',
      ],
      inputs: {
        ri: { name: 'Inner radius', symbol: 'r_i', unit: 'm' },
        ro: { name: 'Outer radius', symbol: 'r_o', unit: 'm' },
        pi: {
          name: 'Internal pressure',
          symbol: 'p_i',
          unit: 'Pa',
          default: { value: 0, note: 'none' },
        },
        po: {
          name: 'External pressure',
          symbol: 'p_o',
          unit: 'Pa',
          default: { value: 0, note: 'none' },
        },
      },
      optional: { r: { name: 'Radius of evaluation', symbol: 'r', unit: 'm' } },
    },
    p,
    options,
    (v) => {
      requireRange(v.ro > v.ri && v.ri > 0, 'Needs r_o > r_i > 0');
      const r = v.r ?? v.ri;
      requireRange(r >= v.ri && r <= v.ro, 'r must lie in the wall');
      const den = v.ro ** 2 - v.ri ** 2;
      const a = v.pi * v.ri ** 2 - v.po * v.ro ** 2;
      const b = (v.ri ** 2 * v.ro ** 2 * (v.po - v.pi)) / (r * r);
      const st = (a - b) / den;
      const sr = (a + b) / den;
      const sl = closed ? a / den : 0;
      const vm = Math.sqrt(((st - sr) ** 2 + (sr - sl) ** 2 + (sl - st) ** 2) / 2);
      return {
        result: st,
        derived: [
          value('Radial stress', 'σ_r', sr, 'Pa'),
          value('Longitudinal stress', 'σ_l', sl, 'Pa'),
          value('Von Mises stress', "σ'", vm, 'Pa'),
        ],
        assumptions:
          v.r === undefined ? ['Evaluated at the bore (r = r_i), where the stresses peak'] : [],
      };
    },
  );
}
