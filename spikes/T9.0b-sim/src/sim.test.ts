import { describe, expect, it } from 'vitest';

import { cellOcvIntegral, packEnergy, simulate, torqueConstant, type Machine } from './model.ts';
import { BELT, DIRECT, FORCE_MAX, hold, PACK, REP, reps, session } from './trainer.ts';

const FULL = { dt: 50e-6, theta: 0.5, electrical: 'full' as const };
const QS = { dt: 1e-3, theta: 0.5, electrical: 'quasi-static' as const };

/** The machine with temperature effects switched off, so closed forms hold exactly. */
function isothermal(m: Machine): Machine {
  return { ...m, motor: { ...m.motor, copperAlpha: 0, magnetAlpha: 0 } };
}

describe('closed forms', () => {
  for (const m of [DIRECT, BELT]) {
    it(`${m.motor.name}: steady hold current is F·r/(G·Kt) and copper loss 1.5·R·i²`, () => {
      const mi = isothermal(m);
      const res = simulate(mi, hold(2), { ...FULL, soc: 0.5 });
      const expected =
        (FORCE_MAX * m.drivetrain.spoolRadius) / (m.drivetrain.ratio * torqueConstant(m.motor));
      expect(res.peaks.current / expected - 1).toBeLessThan(1e-9);
      expect(res.peaks.copperW / (1.5 * m.motor.rPhase * expected * expected) - 1).toBeLessThan(
        1e-9,
      );
      // The user feels the target force throughout.
      expect(res.forceError.maxAbs).toBeLessThan(1e-6);
    });
  }

  it('the user does F·stroke of work on each pull at constant force', () => {
    const res = simulate(DIRECT, reps(1), { ...FULL, soc: 0.5 });
    expect(res.phases.pull!.userWork / (FORCE_MAX * REP.stroke) - 1).toBeLessThan(1e-3);
    expect(-res.phases.return!.userWork / (FORCE_MAX * REP.stroke) - 1).toBeLessThan(1e-3);
  });

  it('two-node winding temperature matches the analytic step response', () => {
    // Constant copper loss (no temperature coefficients), no motion: winding and housing
    // temperatures follow the sum of two exponentials of the linear two-node network.
    const mi = isothermal(DIRECT);
    const res = simulate(mi, hold(30), { ...FULL, soc: 0.5 });
    const i = (FORCE_MAX * mi.drivetrain.spoolRadius) / torqueConstant(mi.motor);
    const P = 1.5 * mi.motor.rPhase * i * i;
    const { cWinding: c1, cHousing: c2, rWindingHousing: r1, rHousingAmbient: r2 } = mi.thermal;
    // d/dt [Tw, Th] = A·[Tw, Th] + b, rises from zero.
    const a11 = -1 / (c1 * r1);
    const a12 = 1 / (c1 * r1);
    const a21 = 1 / (c2 * r1);
    const a22 = -(1 / r1 + 1 / r2) / c2;
    const tr = a11 + a22;
    const det = a11 * a22 - a12 * a21;
    const l1 = tr / 2 + Math.sqrt((tr * tr) / 4 - det);
    const l2 = tr / 2 - Math.sqrt((tr * tr) / 4 - det);
    // Steady rise: Tw = P·(r1 + r2), Th = P·r2.
    const sw = P * (r1 + r2);
    const sh = P * r2;
    // x(t) = s + k1·v1·e^(l1 t) + k2·v2·e^(l2 t) with x(0) = 0; eigenvectors v = [a12, l − a11].
    const v1 = [a12, l1 - a11] as const;
    const v2 = [a12, l2 - a11] as const;
    const dd = v1[0] * v2[1] - v1[1] * v2[0];
    const k1 = (-sw * v2[1] + sh * v2[0]) / dd;
    const k2 = (-sh * v1[0] + sw * v1[1]) / dd;
    const t = 30;
    const tw = sw + k1 * v1[0] * Math.exp(l1 * t) + k2 * v2[0] * Math.exp(l2 * t);
    expect(Math.abs(res.end.tWinding - mi.thermal.tAmbient - tw) / tw).toBeLessThan(1e-4);
  });

  it('pack chemical energy is capacity × series cells × the integral of the OCV curve', () => {
    expect(packEnergy(PACK, 1)).toBeCloseTo(16 * 1.7 * 3600 * cellOcvIntegral(PACK, 1), 6);
    // Trapezoid over the evenly spaced table, independently.
    const v = PACK.ocvVolts;
    let trap = 0;
    for (let k = 0; k < v.length - 1; k++) trap += ((v[k]! + v[k + 1]!) / 2) * (1 / (v.length - 1));
    expect(cellOcvIntegral(PACK, 1)).toBeCloseTo(trap, 12);
    expect(cellOcvIntegral(PACK, 0.55)).toBeGreaterThan(cellOcvIntegral(PACK, 0.5));
  });
});

describe('energy balance', () => {
  const cases: [string, Machine, ReturnType<typeof reps>, object][] = [
    ['direct, 10 reps, full', DIRECT, reps(10), FULL],
    ['direct, 30 s hold, full', DIRECT, hold(30), FULL],
    ['belt, 10 reps, full', BELT, reps(10), FULL],
    ['direct, session, quasi-static', DIRECT, session(), QS],
    ['belt, session, quasi-static', BELT, session(), QS],
  ];
  for (const [name, m, profile, opts] of cases) {
    it(`${name}: the ledger closes to 1 % (in fact to rounding with the midpoint rule)`, () => {
      const res = simulate(m, profile, { ...(opts as typeof FULL), soc: 0.5 });
      expect(res.ledger.residualRelative).toBeLessThan(0.01);
      expect(res.ledger.residualRelative).toBeLessThan(1e-6);
      const heat = res.thermal;
      expect(Math.abs(heat.residual) / heat.heatIn).toBeLessThan(1e-9);
    });
  }

  it('backward Euler still closes to 1 %, but leaves a residual the midpoint rule does not', () => {
    const be = simulate(DIRECT, reps(10), { ...FULL, theta: 1, soc: 0.5 });
    const mp = simulate(DIRECT, reps(10), { ...FULL, soc: 0.5 });
    expect(be.ledger.residualRelative).toBeLessThan(0.01);
    expect(be.ledger.residualRelative).toBeGreaterThan(100 * mp.ledger.residualRelative);
  });

  it('a full pack takes almost no charge, so the resistor takes the surplus', () => {
    // The pack accepts only what the start of each pull drew from it (acceptance tapers to 0 at
    // a state of charge of 1).
    const res = simulate(DIRECT, reps(2), { ...FULL, soc: 1.0 });
    const pull = res.phases.pull!;
    expect(pull.packCharged / pull.busReturned).toBeLessThan(0.01);
    expect(pull.resistor / pull.busReturned).toBeGreaterThan(0.98);
  });
});

describe('step size', () => {
  it('quasi-static electrics at 1 ms agree with the full model at 10 µs to 0.1 %', () => {
    const ref = simulate(DIRECT, reps(10), { dt: 10e-6, theta: 0.5, electrical: 'full', soc: 0.5 });
    const qs = simulate(DIRECT, reps(10), { ...QS, soc: 0.5 });
    for (const k of ['copper', 'resistor', 'packChemical', 'controller'] as const) {
      expect(Math.abs(qs.ledger[k] / ref.ledger[k] - 1)).toBeLessThan(1e-3);
    }
    expect(Math.abs((qs.end.tWinding - ref.end.tWinding) / (ref.end.tWinding - 25))).toBeLessThan(
      1e-3,
    );
  });
});
