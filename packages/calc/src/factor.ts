// A strength or capacity stated as a factor against the factor the user chose (M9 plan, decision
// 1): "von Mises 182 MPa, yield 415 MPa, factor 2.28 against your 2.0". Below the user's factor is
// a warning; nothing here says a design is safe.

import { calc, requireRange, type Param, type RecordOptions } from './record';
import { shigley10 } from './sources';

export const REQUIRED_FACTOR = {
  name: 'Your required factor',
  symbol: 'n_req',
  unit: '1',
} as const;

/** n = S / sigma: a strength (yield, ultimate, endurance, rating) over the stress or load on it. */
export function strengthFactor(
  p: { stress: Param; strength: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'factor.strength',
      title: 'Factor against strength',
      method: 'Strength divided by the stress it carries',
      formula: 'n = S / σ',
      unit: '1',
      sources: [shigley10('Sec. 1-10, design factor')],
      inputs: {
        stress: { name: 'Stress', symbol: 'σ', unit: 'Pa' },
        strength: { name: 'Strength', symbol: 'S', unit: 'Pa' },
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.stress > 0, 'The stress must be positive');
      return { result: v.strength / v.stress };
    },
  );
}

/**
 * n = F_rated / F: a rated load (a rope's minimum breaking load, a static load rating) over the
 * load it carries. The same comparison as `strengthFactor`, in newtons.
 */
export function loadFactor(
  p: { load: Param; rating: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'factor.load',
      title: 'Factor against a rated load',
      method: 'Rated load divided by the load it carries',
      formula: 'n = F_rated / F',
      unit: '1',
      sources: [shigley10('Sec. 1-10, design factor')],
      inputs: {
        load: { name: 'Load', symbol: 'F', unit: 'N' },
        rating: { name: 'Rated load', symbol: 'F_rated', unit: 'N' },
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.load > 0, 'The load must be positive');
      return { result: v.rating / v.load };
    },
  );
}
