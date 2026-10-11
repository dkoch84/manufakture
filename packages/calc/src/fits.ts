// Press and shrink fits of a hub on a round shaft (Shigley 10th ed. Secs. 3-16 and 7-8): the
// interface pressure from the diametral interference, and the torque the fit carries by friction.
// The hub's stresses at its bore are Lamé's (`lameStresses` with the pressure inside the hub).

import { REQUIRED_FACTOR } from './factor';
import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { shigley10 } from './sources';

/**
 * Interface pressure of a fit with diametral interference δ, for a hub of outside diameter d_o on
 * a shaft of diameter d (bore d_i), each of its own material.
 */
export function pressFitPressure(
  p: {
    delta: Param;
    d: Param;
    do: Param;
    di?: Param;
    /** Young's modulus and Poisson's ratio of the hub (outer member) and the shaft (inner). */
    Eo: Param;
    nuo: Param;
    Ei: Param;
    nui: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'fit.pressure',
      title: 'Press fit: interface pressure',
      method: 'Lamé thick cylinders, hub and shaft each elastic, interference shared by both',
      formula:
        'p = δ / (d [ (1/E_o)((d_o² + d²)/(d_o² - d²) + ν_o) + (1/E_i)((d² + d_i²)/(d² - d_i²) - ν_i) ])',
      unit: 'Pa',
      sources: [
        shigley10('Eq. (3-56), with the radial interference δ/2 and R = d/2'),
        shigley10('Eq. (7-40), the same materials'),
      ],
      assumptions: [
        'Linear elastic, plane stress, the hub as long as the fit',
        'δ is the diametral interference (shaft diameter less hub bore)',
      ],
      inputs: {
        delta: { name: 'Diametral interference', symbol: 'δ', unit: 'm' },
        d: { name: 'Fit diameter', symbol: 'd', unit: 'm' },
        do: { name: 'Hub outside diameter', symbol: 'd_o', unit: 'm' },
        Eo: { name: "Young's modulus of the hub", symbol: 'E_o', unit: 'Pa' },
        nuo: { name: "Poisson's ratio of the hub", symbol: 'ν_o', unit: '1' },
        Ei: { name: "Young's modulus of the shaft", symbol: 'E_i', unit: 'Pa' },
        nui: { name: "Poisson's ratio of the shaft", symbol: 'ν_i', unit: '1' },
      },
      optional: { di: { name: 'Shaft bore (hollow shaft)', symbol: 'd_i', unit: 'm' } },
    },
    p,
    options,
    (v) => {
      const di = v.di ?? 0;
      requireRange(v.delta > 0, 'The interference must be positive');
      requireRange(v.do > v.d && v.d > di && di >= 0, 'Needs d_o > d > d_i >= 0');
      requireRange(v.Eo > 0 && v.Ei > 0, 'The moduli must be positive');
      const hub = ((v.do ** 2 + v.d ** 2) / (v.do ** 2 - v.d ** 2) + v.nuo) / v.Eo;
      const shaft = ((v.d ** 2 + di ** 2) / (v.d ** 2 - di ** 2) - v.nui) / v.Ei;
      return {
        result: v.delta / (v.d * (hub + shaft)),
        derived: [
          value('Hub compliance term', 'C_o', hub, '1/Pa'),
          value('Shaft compliance term', 'C_i', shaft, '1/Pa'),
        ],
        assumptions: v.di === undefined ? ['Solid shaft (d_i = 0)'] : [],
      };
    },
  );
}

/** The torque a fit carries by friction, over the torque it must carry. */
export function pressFitSlipFactor(
  p: { T: Param; p: Param; f: Param; l: Param; d: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'fit.slip',
      title: 'Press fit: torque capacity against the torque',
      method: 'Friction at the interface pressure over the fit area, at the fit radius',
      formula: 'T_cap = (π/2) f p l d²; n = T_cap / T',
      unit: '1',
      sources: [shigley10('Eq. (7-49)')],
      assumptions: [
        'Uniform pressure over the whole fit length',
        'The friction coefficient is static and the same everywhere on the fit',
      ],
      inputs: {
        T: { name: 'Torque through the fit', symbol: 'T', unit: 'N·m' },
        p: { name: 'Interface pressure', symbol: 'p', unit: 'Pa' },
        f: { name: 'Friction coefficient', symbol: 'f', unit: '1' },
        l: { name: 'Fit length', symbol: 'l', unit: 'm' },
        d: { name: 'Fit diameter', symbol: 'd', unit: 'm' },
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.T > 0, 'The torque must be positive');
      requireRange(v.p > 0 && v.f > 0 && v.l > 0 && v.d > 0, 'p, f, l and d must be positive');
      const capacity = (Math.PI / 2) * v.f * v.p * v.l * v.d ** 2;
      return {
        result: capacity / v.T,
        derived: [value('Torque capacity', 'T_cap', capacity, 'N·m')],
      };
    },
  );
}
