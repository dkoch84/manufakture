import { describe, expect, it } from 'vitest';

import {
  bench,
  compareWinding,
  curveError,
  FAULHABER_4221_BXT_H,
  MAXON_EC90_FLAT,
  motorFromDatasheet,
  steady,
} from './datasheets.ts';

/** Bounds on the model's error, as reported in docs/spikes/T9.0b-sim.md. */
const BOUNDS: Record<string, number> = {
  'No-load speed': 0.015,
  'Stall torque': 0.01,
  'Speed-torque slope': 0.01,
  'Mechanical time constant, no inductance or loss (integrator check)': 0.005,
  'Current at rated torque': 0.15,
  'Continuous current at 125 °C winding': 0.15,
};

describe('model against published datasheets', () => {
  for (const ds of [MAXON_EC90_FLAT, FAULHABER_4221_BXT_H]) {
    for (const w of ds.windings) {
      it(`${ds.maker} ${w.id}`, () => {
        const rows = compareWinding(ds, w);
        for (const row of rows) {
          const bound = BOUNDS[row.quantity];
          if (bound !== undefined) expect(Math.abs(row.error), row.quantity).toBeLessThan(bound);
        }
        // Maximum efficiency within 2.5 percentage points.
        const eta = rows.find((x) => x.quantity === 'Maximum efficiency')!;
        expect(Math.abs(eta.model - eta.published)).toBeLessThan(2.5);
        // Speed-torque line within 1.5 % of no-load speed, efficiency curve within 1.5 points.
        const curve = curveError(ds, w);
        expect(curve.maxSpeedError).toBeLessThan(0.015);
        expect(curve.maxEfficiencyErrorPoints).toBeLessThan(1.5);
      });
    }
  }

  it('the time-stepped bench settles on the closed-form steady state', () => {
    const ds = MAXON_EC90_FLAT;
    const w = ds.windings[0]!;
    const m = motorFromDatasheet(ds, w);
    for (const M of [0, w.ratedTorque, 1.0]) {
      const b = bench(m, w.voltage, M, 1e-5, 0.6);
      const s = steady(m, w.voltage, M);
      expect(Math.abs(b.final.speed / s.speed - 1)).toBeLessThan(1e-5);
      expect(Math.abs(b.final.current / s.current - 1)).toBeLessThan(1e-5);
    }
  });
});
