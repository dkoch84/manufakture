// The T9.0b spike's numbers, reproduced (docs/spikes/T9.0b-sim.md, "The cable trainer at 200
// lbf", from spikes/T9.0b-sim/results/trainer.json at ec4af7c). The spike ran its rep, hold and
// session with the full current loop at 50 µs; the product runs quasi-static currents at 1 ms by
// default, which the spike measured within 1e-4 of the full model on every ledger entry. So the
// quasi-static numbers are held to 1e-3 of the spike's, and the full mode here to the spike's
// printed digits. Then the T9.4a template's cable trainer session, timed against the 2 s budget.

import type { StoredExpression } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { resolveDynamic } from '../requirements/motion';
import { mechTemplate } from '../requirements/templates';
import { NO_VARIABLES } from '../requirements/values';
import { simulate, type SimJob, type SimResult } from './engine';
import { simProfile } from './profile';
import { sessionsPerCharge } from './sessions';
import {
  AMBIENT,
  CONSTANT_200,
  DIRECT,
  SPIKE_SESSION,
  TEN_REPS,
  hold,
} from './trainer.test-fixture';

const rel = (a: number, b: number) => Math.abs(a / b - 1);
const C = (k: number) => k - 273.15;

function segments(d: typeof TEN_REPS, ramp = 0) {
  const p = simProfile(d, { ramp });
  if (!p.ok) throw new Error(p.message);
  return p.segments;
}

const reps = (electrical: 'quasi-static' | 'full'): SimJob => ({
  machine: DIRECT,
  law: CONSTANT_200,
  segments: segments(TEN_REPS),
  start: { soc: 0.5 },
  options: { electrical },
});

/** The spike's 10 reps at 50 % charge (`direct.set10`), per rep or per pull. */
function tenReps(res: SimResult) {
  const pull = res.phases.pull!;
  return {
    userWorkPull: pull.userWork / 10,
    busReturnedPerPull: pull.busReturned / 10,
    busReturnedPeak: pull.busReturnedPeak,
    packAcceptedPerPull: pull.packCharged / 10,
    resistorPerPull: pull.resistor / 10,
    copperPerRep: res.ledger.copper / 10,
    packChemicalPerRep: res.ledger.packChemical / 10,
    peakCurrent: res.envelopes['motor/current']!.peak,
    peakTorque: res.envelopes['motor/torque']!.peak,
    peakResistor: res.envelopes['resistor/power']!.max,
    peakDischarge: res.envelopes['pack/current']!.max,
    minVoltage: res.envelopes['pack/voltage']!.min,
    winding: C(res.end.windingTemperature!),
    housing: C(res.end.housingTemperature!),
  };
}

const SPIKE_TEN_REPS = {
  userWorkPull: 533.8,
  busReturnedPerPull: 433.8,
  busReturnedPeak: 1156.239,
  packAcceptedPerPull: 114.7,
  resistorPerPull: 319.1,
  copperPerRep: 249.8,
  packChemicalPerRep: 740.6,
  peakCurrent: 46.82,
  peakTorque: 23.399,
  peakResistor: 949.009,
  peakDischarge: 20.11,
  minVoltage: 50.89,
  winding: 35.6632,
  housing: 25.4221,
};

describe('the spike’s cable trainer at 200 lbf, direct drive', () => {
  it('10 reps, quasi-static at 1 ms: within 1e-3 of the spike', () => {
    const got = tenReps(simulate(reps('quasi-static')));
    for (const [k, want] of Object.entries(SPIKE_TEN_REPS)) {
      const g = got[k as keyof typeof got];
      // Temperatures by their rise over ambient.
      const t = k === 'winding' || k === 'housing';
      expect(rel(t ? g - 25 : g, t ? want - 25 : want), k).toBeLessThan(1e-3);
    }
  });

  it('10 reps, full current loop at 50 µs: the spike’s printed digits', () => {
    const res = simulate(reps('full'));
    const got = tenReps(res);
    for (const [k, want] of Object.entries(SPIKE_TEN_REPS)) {
      const g = got[k as keyof typeof got];
      const t = k === 'winding' || k === 'housing';
      expect(rel(t ? g - 25 : g, t ? want - 25 : want), k).toBeLessThan(2e-4);
    }
    expect(res.ledger.residualRelative).toBeLessThan(1e-7);
  });

  it('a 30 s hold: 44.52 A, 125.8 W of copper at the end, 39.60 °C', () => {
    const res = simulate({
      machine: DIRECT,
      law: CONSTANT_200,
      segments: hold(30),
      start: { soc: 0.5 },
    });
    expect(rel(res.envelopes['motor/current']!.peak, 44.522)).toBeLessThan(1e-4);
    expect(rel(res.envelopes['motor/copper-power']!.max, 125.757)).toBeLessThan(1e-4);
    expect(rel(res.ledger.copper, 3672.916)).toBeLessThan(1e-4);
    expect(rel(res.ledger.packChemical, 4374.042)).toBeLessThan(1e-4);
    expect(rel(C(res.end.windingTemperature!) - 25, 39.6007 - 25)).toBeLessThan(1e-4);
    // Cold, the closed form: F·r/Kt and 1.5·R·i².
    const i = (CONSTANT_200.force * 0.025) / 0.5;
    expect(rel(res.series.values['motor/current']![0]!, i)).toBeLessThan(1e-5);
  });

  it('the 5 x 10 session: 10.89 Wh, 15.9 kJ in the resistor, 45.0 °C', () => {
    const res = simulate({
      machine: DIRECT,
      law: CONSTANT_200,
      segments: segments(SPIKE_SESSION, 0.5),
      start: { soc: 0.5 },
    });
    expect(rel(res.duration, 466.416)).toBeLessThan(1e-5);
    expect(rel(res.ledger.packChemical, 39188.212)).toBeLessThan(1e-3);
    expect(rel(res.ledger.resistor, 15906.292)).toBeLessThan(1e-3);
    expect(rel(res.ledger.copper, 13061.714)).toBeLessThan(1e-3);
    expect(rel(res.ledger.packResistance, 4673.056)).toBeLessThan(1e-3);
    expect(rel(res.ledger.controller, 2455.324)).toBeLessThan(1e-3);
    expect(rel(res.ledger.cable, 1626.108)).toBeLessThan(1e-3);
    expect(rel(C(res.end.windingTemperature!) - 25, 44.9983 - 25)).toBeLessThan(1e-3);
    expect(rel(C(res.end.housingTemperature!) - 25, 32.4987 - 25)).toBeLessThan(1e-3);
    expect(rel(res.end.soc, 0.3915)).toBeLessThan(1e-3);
    expect(res.ledger.residualRelative).toBeLessThan(1e-6);
    expect(res.warnings.map((w) => w.code)).not.toContain('current-limit');
  });

  it('8 sessions per charge, the ninth falling below the cutoff', () => {
    const job: SimJob = {
      machine: DIRECT,
      law: CONSTANT_200,
      segments: segments(SPIKE_SESSION, 0.5),
      start: { soc: 1 },
    };
    const r = sessionsPerCharge(job);
    expect(r.status).toBe('done');
    expect(r.sessions).toBe(8);
    expect(r.runs).toHaveLength(9);
    expect(r.runs[8]!.belowCutoff).toBeGreaterThan(0);
    expect(rel(r.runs[0]!.packEnergy / 3600, 11.535)).toBeLessThan(2e-3);
    expect(rel(r.runs[0]!.socEnd, 0.8972)).toBeLessThan(1e-3);
  });

  it('a pack that accepted everything would need 6.96 Wh a session', () => {
    const res = simulate({
      machine: { ...DIRECT, pack: { ...DIRECT.pack, chargeLimit: 1e6, taperStart: 1 } },
      law: CONSTANT_200,
      segments: segments(SPIKE_SESSION, 0.5),
      start: { soc: 0.5 },
    });
    expect(rel(res.ledger.packChemical / 3600, 6.955)).toBeLessThan(1e-3);
    expect(res.ledger.resistor).toBe(0);
  });
});

describe('the cable trainer template’s session', () => {
  const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
  const lc = mechTemplate('cable-trainer')!
    .build(x)
    .loadCases.find((l) => l.name === 'Session at 100 lbf (R9)')!;

  it('13 sets of 9 reps at 100 lbf run in under 2 s, and the ledger closes', () => {
    const d = resolveDynamic(lc.dynamic!, NO_VARIABLES);
    if (!d.ok) throw new Error(JSON.stringify(d.problems));
    const job: SimJob = {
      machine: DIRECT,
      law: d.value.law,
      segments: segments(d.value),
      start: { soc: d.value.startCharge ?? 1 },
      options: { budgetMs: 2000 },
    };
    const t0 = performance.now();
    const res = simulate(job);
    const ms = performance.now() - t0;
    expect(res.status).toBe('done');
    expect(ms).toBeLessThan(2000);
    // 13 x 9 reps (a 0.6 m pull peaking at 1.5 m/s, a return peaking at 1 m/s, two 0.2 s
    // pauses) and 12 rests of 60 s.
    const rep = (Math.PI * 0.6) / (2 * 1.5) + (Math.PI * 0.6) / (2 * 1) + 0.4;
    expect(rel(res.duration, 117 * rep + 12 * 60)).toBeLessThan(1e-12);
    expect(res.ledger.residualRelative).toBeLessThan(1e-6);
    expect(res.end.windingTemperature).toBeGreaterThan(AMBIENT);
    console.log(
      `cable trainer session (${res.steps} steps, ${res.duration.toFixed(1)} s simulated): ${ms.toFixed(1)} ms; ledger residual ${res.ledger.residualRelative.toExponential(2)}; pack ${(res.ledger.packChemical / 3600).toFixed(2)} Wh`,
    );
  });
});
