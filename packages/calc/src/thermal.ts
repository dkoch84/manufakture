// First-order (single RC) thermal model: one lumped heat capacity behind one thermal resistance to
// ambient, heated by a constant power.

import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { incropera } from './sources';

/**
 * Temperature after time t with constant power P:
 * T(t) = T_amb + P R_th (1 - e^(-t/τ)) + (T₀ - T_amb) e^(-t/τ), τ = R_th C_th.
 */
export function firstOrderTemperature(
  p: {
    P: Param;
    Rth: Param;
    Cth: Param;
    t: Param;
    Tambient: Param;
    T0?: Param;
    Tmax?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'thermal.first-order',
      title: 'Temperature after a time (first-order thermal model)',
      method: 'Lumped capacitance with one thermal resistance to ambient',
      formula: 'T(t) = T_amb + P R_th (1 - e^(-t/τ)) + (T₀ - T_amb) e^(-t/τ), τ = R_th C_th',
      unit: 'K',
      sources: [incropera('Ch. 5, the lumped capacitance method')],
      assumptions: [
        'One uniform temperature in the body (Biot number small)',
        'Constant power, resistance and capacity over the interval',
      ],
      inputs: {
        P: { name: 'Heating power', symbol: 'P', unit: 'W' },
        Rth: { name: 'Thermal resistance to ambient', symbol: 'R_th', unit: 'K/W' },
        Cth: { name: 'Heat capacity', symbol: 'C_th', unit: 'J/K' },
        t: { name: 'Time', symbol: 't', unit: 's' },
        Tambient: { name: 'Ambient temperature', symbol: 'T_amb', unit: 'K' },
      },
      optional: {
        T0: { name: 'Starting temperature', symbol: 'T₀', unit: 'K' },
        Tmax: { name: 'Allowed temperature', symbol: 'T_max', unit: 'K' },
      },
      limit: { input: 'Tmax', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      requireRange(v.Rth > 0 && v.Cth > 0 && v.t >= 0, 'Needs R_th > 0, C_th > 0 and t >= 0');
      const tau = v.Rth * v.Cth;
      const decay = Math.exp(-v.t / tau);
      const T0 = v.T0 ?? v.Tambient;
      return {
        result: v.Tambient + v.P * v.Rth * (1 - decay) + (T0 - v.Tambient) * decay,
        derived: [
          value('Time constant', 'τ', tau, 's'),
          value('Steady-state temperature', 'T_∞', v.Tambient + v.P * v.Rth, 'K'),
        ],
        assumptions: v.T0 === undefined ? ['Starts at ambient temperature'] : [],
      };
    },
  );
}
