// The simulation against closed forms (T9.4b). The energy ledger closes partly by construction
// (the user's force comes from the torque balance, the resistor takes the surplus), so a closed
// ledger alone proves little. These tests check the current, the kinetic energy and the charge
// independently: each expected value is computed here from the machine's constants and the
// motion, never from the simulation's own state.

import { describe, expect, it } from 'vitest';
import type { Segment } from '../requirements/motion';
import { runSimulation, simulate, Simulation, type SimJob } from './engine';
import { packEnergy, packOcv, radiusAt, type SimMachine } from './machine';
import { NO_FORCE, simProfile } from './profile';
import { simulationEnvelopes } from './series';
import {
  DIRECT,
  FORCE_MAX,
  SPIKE_SESSION,
  TEN_REPS,
  hold,
  ideal,
  isothermal,
} from './trainer.test-fixture';

const rel = (a: number, b: number) => Math.abs(a / b - 1);

/**
 * The cable travel the run integrates for a half-cosine move: the trapezoid rule on the analytic
 * speed at whole steps (the midpoint rule's cable speed is the mean of the step's two ends), over
 * the whole steps that fit. Within O(dt²) of the stroke.
 */
function travel(seg: Segment, dt: number): number {
  const T = seg.duration;
  const peak = (Math.PI * (seg.to - seg.from)) / (2 * T);
  const v = (t: number) => peak * Math.sin((Math.PI * Math.min(t, T)) / T);
  let s = 0;
  for (let k = 0; k < Math.round(T / dt); k++) s += ((v(k * dt) + v((k + 1) * dt)) / 2) * dt;
  return s;
}

/** A half-cosine pull over `stroke` peaking at `peak`. */
const pull = (stroke: number, peak: number): Segment => ({
  phase: 'pull',
  duration: (Math.PI * stroke) / (2 * peak),
  from: 0,
  to: stroke,
  shape: 'cosine',
});

describe('current', () => {
  it('a hold draws F·r/(G·Kt) and the pack the current of P = (V − R·I)·I, counted as charge', () => {
    const F = 500;
    const r = 0.02;
    const G = 2;
    const kt = 0.4;
    const R = 0.05;
    const base = ideal();
    const m = ideal({
      motor: { ...base.motor, kt, resistance: R },
      transmission: {
        ...base.transmission,
        radius: { kind: 'constant', radius: r },
        ratio: G,
        efficiency: 0.9,
        cableEfficiency: 0.95,
      },
      pack: { ...base.pack, resistance: 0.2 },
    });
    const T = 10;
    const res = simulate({
      machine: m,
      law: { kind: 'constant', force: F },
      segments: hold(T),
      start: { soc: 0.5 },
    });
    // At standstill no power flows, so neither efficiency acts on the holding torque.
    const i = (F * r) / (G * kt);
    expect(rel(res.envelopes['motor/current']!.peak, i)).toBeLessThan(1e-12);
    expect(rel(res.envelopes['motor/torque']!.min, -(F * r) / G)).toBeLessThan(1e-12);
    const pCu = 1.5 * R * i * i;
    expect(rel(res.ledger.copper, pCu * T)).toBeLessThan(1e-9);
    // Flat OCV: the pack current is constant, and the charge is that current times the time.
    const V = 50;
    const Rp = 0.2;
    const iPack = (V - Math.sqrt(V * V - 4 * Rp * pCu)) / (2 * Rp);
    const charge = iPack * T;
    expect(rel(res.envelopes['pack/current']!.mean, iPack)).toBeLessThan(1e-12);
    expect(rel(res.envelopes['pack/current']!.energy, charge)).toBeLessThan(1e-9);
    expect(rel(0.5 - res.end.soc, charge / m.pack.capacity)).toBeLessThan(1e-9);
    expect(res.envelopes['cable/force']!.max).toBeCloseTo(F, 9);
  });

  it('accelerating a free drivetrain draws J·α/Kt, from the motion alone', () => {
    const m = ideal();
    const G = m.transmission.ratio;
    const r = 0.025;
    const seg = pull(0.6, 1.5);
    const dt = 1e-3;
    const res = simulate({
      machine: m,
      law: NO_FORCE,
      segments: [seg],
      start: { soc: 0.5 },
      options: { dt, record: { every: dt } },
    });
    const T = seg.duration;
    const vPeak = 1.5;
    // Cable acceleration a(t) = vPeak π/T cos(π t/T); the first step's midpoint is dt/2.
    const a = (t: number) => ((vPeak * Math.PI) / T) * Math.cos((Math.PI * t) / T);
    const expected = (m.transmission.inertia * G * a(dt / 2)) / r / m.motor.kt;
    expect(rel(res.series.values['motor/current']![0]!, expected)).toBeLessThan(1e-5);
    // At peak speed nothing accelerates and nothing resists: no current.
    expect(Math.min(...res.series.values['motor/current']!.map(Math.abs))).toBeLessThan(
      expected * 2e-3,
    );
  });

  it('a step of the force law at a still cable steps the current with it (quasi-static)', () => {
    const m = ideal();
    const segs: Segment[] = [
      { phase: 'rest', duration: 0.5, from: 0, to: 0, shape: 'still' },
      { phase: 'hold', duration: 0.5, from: 0, to: 0, shape: 'still' },
    ];
    const res = simulate({
      machine: m,
      law: { kind: 'constant', force: 400 },
      segments: segs,
      start: { soc: 0.5 },
      options: { record: { every: 1e-3 } },
    });
    const cur = res.series.values['motor/current']!;
    expect(cur[100]).toBe(0);
    expect(cur[900]).toBeCloseTo((400 * 0.025) / 0.4, 12);
  });
});

describe('kinetic energy', () => {
  it('the motor puts ½·J·ω² into a free drivetrain by peak speed and takes it back by the stop', () => {
    const m = ideal();
    const seg = pull(0.6, 1.5);
    const dt = 1e-3;
    const res = simulate({
      machine: m,
      law: NO_FORCE,
      segments: [seg],
      start: { soc: 0.5 },
      options: { dt, record: { every: dt } },
    });
    const wPeak = (m.transmission.ratio * 1.5) / 0.025;
    const ke = 0.5 * m.transmission.inertia * wPeak * wPeak;
    // Integrate the shaft power over the first half, independently of the ledger.
    const t = res.series.t;
    const p = res.series.values['motor/shaft-power']!;
    let work = 0;
    for (let k = 0; k < t.length && t[k]! <= seg.duration / 2 + 1e-12; k++) work += p[k]! * dt;
    expect(rel(work, ke)).toBeLessThan(1e-5);
    // Over the whole pull the motor gets it back, but for what turns at the last whole step
    // (the pull is not a whole number of steps long).
    const N = Math.round(seg.duration / dt);
    const wEnd = (m.transmission.ratio * 1.5 * Math.sin((Math.PI * N * dt) / seg.duration)) / 0.025;
    const left = 0.5 * m.transmission.inertia * wEnd * wEnd;
    expect(left).toBeLessThan(ke * 1e-4);
    expect(Math.abs(res.envelopes['motor/shaft-power']!.energy - left)).toBeLessThan(ke * 1e-12);
    expect(Math.abs(res.ledger.kinetic - left)).toBeLessThan(ke * 1e-12);
  });

  it('the ledger’s kinetic term is ½·J·(ω_end² − ω_start²) when the run ends moving', () => {
    const m = ideal();
    const segs: Segment[] = [
      { phase: 'pull', duration: 1, from: 0, to: 0.5, shape: 'linear' },
      { phase: 'pull', duration: 1, from: 0.5, to: 2, shape: 'linear' },
    ];
    const res = simulate({ machine: m, law: NO_FORCE, segments: segs, start: { soc: 0.5 } });
    const w = (v: number) => (m.transmission.ratio * v) / 0.025;
    const expected = 0.5 * m.transmission.inertia * (w(1.5) ** 2 - w(0.5) ** 2);
    expect(rel(res.ledger.kinetic, expected)).toBeLessThan(1e-12);
    // The motor supplied exactly that (no force, no losses).
    expect(rel(res.envelopes['motor/shaft-power']!.energy, expected)).toBeLessThan(1e-9);
    expect(rel(res.envelopes['bus/power']!.energy, expected)).toBeLessThan(1e-9);
  });
});

describe('charge counting', () => {
  const F = 800;
  const stroke = 0.6;

  it('a pack that accepts nothing leaves its charge alone and the resistor takes F·stroke', () => {
    const base = ideal();
    const m = ideal({
      pack: { ...base.pack, chargeLimit: 0, taperStart: 0.85 },
      brake: { resistance: 2.5 },
    });
    const seg = pull(stroke, 1.5);
    const res = simulate({
      machine: m,
      law: { kind: 'constant', force: F },
      segments: [seg],
      start: { soc: 0.5 },
    });
    expect(res.end.soc).toBe(0.5);
    expect(res.envelopes['pack/current']!.peak).toBe(0);
    // F times the travel, less what still turns at the last whole step.
    const s = travel(seg, 1e-3);
    expect(rel(s, stroke)).toBeLessThan(1e-5);
    expect(rel(res.phases.pull!.userWork, F * s)).toBeLessThan(1e-12);
    expect(rel(res.ledger.resistor, F * s - res.ledger.kinetic)).toBeLessThan(1e-9);
    // The resistor takes v·(F − J·(G/r)²·a), from the motion: its peak is just past peak speed,
    // where the decelerating drivetrain adds to the user's force.
    const k = m.transmission.inertia * (m.transmission.ratio / 0.025) ** 2;
    let pPeak = 0;
    for (let i = 0; i <= 100_000; i++) {
      const th = (Math.PI * i) / 100_000;
      const v = 1.5 * Math.sin(th);
      const a = ((1.5 * Math.PI) / seg.duration) * Math.cos(th);
      pPeak = Math.max(pPeak, v * (F - k * a));
    }
    expect(rel(pPeak, F * 1.5)).toBeLessThan(1e-3);
    expect(rel(res.envelopes['resistor/power']!.max, pPeak)).toBeLessThan(1e-5);
    expect(rel(res.envelopes['resistor/duty']!.max, pPeak / ((50 * 50) / 2.5))).toBeLessThan(1e-5);
  });

  it('a pack that accepts everything gains F·stroke / V of charge', () => {
    const m = ideal();
    const seg = pull(stroke, 1.5);
    const res = simulate({
      machine: m,
      law: { kind: 'constant', force: F },
      segments: [seg],
      start: { soc: 0.5 },
    });
    const V = 50;
    const work = F * travel(seg, 1e-3) - res.ledger.kinetic;
    const charge = work / V;
    expect(rel(charge, (F * stroke) / V)).toBeLessThan(1e-5);
    expect(rel(res.end.soc - 0.5, charge / m.pack.capacity)).toBeLessThan(1e-9);
    expect(rel(-res.envelopes['pack/current']!.energy, charge)).toBeLessThan(1e-9);
    expect(rel(-res.ledger.packChemical, work)).toBeLessThan(1e-9);
  });

  it('the pack takes its charge limit and no more; the resistor the rest', () => {
    const base = ideal();
    const limit = 5;
    const m = ideal({
      pack: { ...base.pack, chargeLimit: limit, taperStart: 1 },
      brake: { resistance: 2.5 },
    });
    const seg = pull(stroke, 1.5);
    const res = simulate({
      machine: m,
      law: { kind: 'constant', force: F },
      segments: [seg],
      start: { soc: 0.5 },
      options: { record: { every: 1e-3 } },
    });
    // While F·v exceeds limit·V the pack charges at the limit: from the motion, F·v(t) > 250 W.
    const T = seg.duration;
    let expected = 0;
    const dt = 1e-3;
    for (let k = 0; k < Math.round(T / dt); k++) {
      const t = (k + 0.5) * dt;
      const v = 1.5 * Math.sin((Math.PI * t) / T);
      const w = (m.transmission.ratio * v) / 0.025;
      const a = ((1.5 * Math.PI) / T) * Math.cos((Math.PI * t) / T);
      const back = F * v - m.transmission.inertia * (w / v || 0) ** 2 * a * v;
      expected += Math.min(limit, Math.max(0, back) / 50) * dt;
    }
    expect(rel(-res.envelopes['pack/current']!.energy, expected)).toBeLessThan(1e-3);
    expect(-res.envelopes['pack/current']!.min).toBeCloseTo(limit, 12);
  });
});

describe('temperature', () => {
  it('the two-node winding follows the analytic step response', () => {
    const mi = isothermal(DIRECT);
    const res = simulate({
      machine: mi,
      law: { kind: 'constant', force: FORCE_MAX },
      segments: hold(30),
      start: { soc: 0.5 },
    });
    const i = (FORCE_MAX * 0.025) / mi.motor.kt;
    const P = 1.5 * mi.motor.resistance * i * i;
    const { windingCapacity: c1, housingCapacity: c2 } = mi.motorThermal!;
    const r1 = mi.motorThermal!.windingToHousing;
    const r2 = mi.motorThermal!.housingToAmbient;
    const a11 = -1 / (c1 * r1);
    const a12 = 1 / (c1 * r1);
    const a21 = 1 / (c2 * r1);
    const a22 = -(1 / r1 + 1 / r2) / c2;
    const tr = a11 + a22;
    const det = a11 * a22 - a12 * a21;
    const l1 = tr / 2 + Math.sqrt((tr * tr) / 4 - det);
    const l2 = tr / 2 - Math.sqrt((tr * tr) / 4 - det);
    const sw = P * (r1 + r2);
    const sh = P * r2;
    const v1 = [a12, l1 - a11] as const;
    const v2 = [a12, l2 - a11] as const;
    const dd = v1[0] * v2[1] - v1[1] * v2[0];
    const k1 = (-sw * v2[1] + sh * v2[0]) / dd;
    const k2 = (-sh * v1[0] + sw * v1[1]) / dd;
    const rise = sw + k1 * v1[0] * Math.exp(l1 * 30) + k2 * v2[0] * Math.exp(l2 * 30);
    expect(rel(res.end.windingTemperature! - mi.ambient, rise)).toBeLessThan(1e-4);
    expect(Math.abs(res.thermal.motor!.residual) / res.thermal.motor!.heatIn).toBeLessThan(1e-9);
  });

  it('a pack node and a resistor node close their heat ledgers and start from the state given', () => {
    const m: SimMachine = {
      ...DIRECT,
      pack: { ...DIRECT.pack, thermal: { capacity: 800, toAmbient: 2 } },
      brake: { resistance: 2.5, thermal: { capacity: 300, toAmbient: 1.2 } },
    };
    const segments = simProfile(TEN_REPS);
    if (!segments.ok) throw new Error(segments.message);
    const res = simulate({
      machine: m,
      law: TEN_REPS.law,
      segments: segments.segments,
      start: { soc: 0.5, packTemperature: 303.15, resistorTemperature: 310 },
    });
    expect(res.start.packTemperature).toBe(303.15);
    for (const h of [res.thermal.pack!, res.thermal.resistor!]) {
      expect(Math.abs(h.residual) / h.heatIn).toBeLessThan(1e-9);
    }
    expect(rel(res.thermal.pack!.heatIn, res.ledger.packResistance)).toBeLessThan(1e-12);
    expect(rel(res.thermal.resistor!.heatIn, res.ledger.resistor)).toBeLessThan(1e-12);
    expect(res.envelopes['resistor/temperature']!.max).toBeGreaterThan(310);
  });
});

describe('energy balance', () => {
  const profile = (d: typeof TEN_REPS, ramp = 0) => {
    const p = simProfile(d, { ramp });
    if (!p.ok) throw new Error(p.message);
    return p.segments;
  };
  const NO_BRAKE: SimMachine = { ...DIRECT };
  delete NO_BRAKE.brake;
  const wound: SimMachine = {
    ...DIRECT,
    transmission: {
      ...DIRECT.transmission,
      // Three layers of 3 mm cable: the radius steps down as each empties.
      radius: {
        kind: 'steps',
        steps: [
          { from: 0, to: 0.2, radius: 0.0265 },
          { from: 0.2, to: 0.45, radius: 0.0235 },
          { from: 0.45, to: 3, radius: 0.0205 },
        ],
      },
    },
  };
  const cases: [string, SimJob][] = [
    [
      '10 reps, full current loop',
      {
        machine: DIRECT,
        law: TEN_REPS.law,
        segments: profile(TEN_REPS),
        start: { soc: 0.5 },
        options: { electrical: 'full' },
      },
    ],
    [
      'session, quasi-static',
      {
        machine: DIRECT,
        law: SPIKE_SESSION.law,
        segments: profile(SPIKE_SESSION, 0.5),
        start: { soc: 0.5 },
      },
    ],
    [
      'a wound spool, its radius stepping',
      { machine: wound, law: TEN_REPS.law, segments: profile(TEN_REPS), start: { soc: 0.9 } },
    ],
    [
      'rowing law',
      {
        machine: DIRECT,
        law: { kind: 'rowing', force: 222, coefficient: 25 },
        segments: profile({
          ...TEN_REPS,
          law: { kind: 'rowing', force: 222, coefficient: 25 },
          motion: { kind: 'half-cosine', stroke: 0.6, pullSpeed: 3, returnSpeed: 1.5, pause: 0.2 },
        }),
        start: { soc: 0.7 },
      },
    ],
    [
      'isokinetic law',
      {
        machine: DIRECT,
        law: { kind: 'isokinetic', force: 600, speed: 1 },
        segments: profile({ ...TEN_REPS, law: { kind: 'isokinetic', force: 600, speed: 1 } }),
        start: { soc: 0.7 },
      },
    ],
    [
      'no braking resistor (unabsorbed)',
      {
        machine: NO_BRAKE,
        law: TEN_REPS.law,
        segments: profile(TEN_REPS),
        start: { soc: 0.95 },
      },
    ],
    [
      'backward Euler',
      {
        machine: DIRECT,
        law: TEN_REPS.law,
        segments: profile(TEN_REPS),
        start: { soc: 0.5 },
        options: { theta: 1 },
      },
    ],
  ];
  for (const [name, job] of cases) {
    it(`${name}: the ledger closes within 1 %`, () => {
      const res = simulate(job);
      expect(res.status).toBe('done');
      expect(res.ledger.residualRelative).toBeLessThan(0.01);
      if (job.options?.theta !== 1) expect(res.ledger.residualRelative).toBeLessThan(1e-6);
    });
  }

  it('without a resistor the surplus is unabsorbed and warned about', () => {
    const job = cases.find(([n]) => n.startsWith('no braking'))![1];
    const res = simulate(job);
    expect(res.ledger.unabsorbed).toBeGreaterThan(100);
    expect(res.warnings.map((w) => w.code)).toContain('unabsorbed');
    expect(res.envelopes['unabsorbed/power']).toBeDefined();
    expect(res.envelopes['resistor/power']).toBeUndefined();
  });

  it('the wound spool’s user work is still F times the stroke per pull', () => {
    const res = simulate(cases[2]![1]);
    expect(rel(res.phases.pull!.userWork / 10, FORCE_MAX * 0.6)).toBeLessThan(2e-3);
  });
});

describe('limits the ledger does not hide', () => {
  /** The spike's pack with no cutoff watched, and `over` on top. */
  const noCutoff = (over: Partial<SimMachine['pack']> = {}): SimMachine['pack'] => {
    const p: SimMachine['pack'] = { ...DIRECT.pack, ...over };
    delete p.cutoff;
    return p;
  };
  const segs = simProfile(TEN_REPS);
  if (!segs.ok) throw new Error(segs.message);

  it('a pack asked for more than OCV²/4R gives that much, books the rest and warns', () => {
    const R = 30;
    const res = simulate({
      machine: { ...DIRECT, pack: noCutoff({ resistance: R }) },
      law: TEN_REPS.law,
      segments: segs.segments,
      start: { soc: 0.5 },
    });
    expect(res.warnings.map((w) => w.code)).toEqual(['pack-power-limit']);
    expect(res.ledger.unsupplied).toBeGreaterThan(0);
    expect(res.ledger.residualRelative).toBeLessThan(1e-6);
    // Never past the maximum-power current OCV / 2R, at the highest charge the run reached.
    const ocvMax = packOcv(DIRECT.pack, res.envelopes['pack/state-of-charge']!.max);
    expect(res.envelopes['pack/current']!.max).toBeLessThanOrEqual(ocvMax / (2 * R) + 1e-12);
    expect(res.envelopes['pack/unsupplied-power']!.energy).toBeCloseTo(res.ledger.unsupplied, 9);
  });

  it('a pack drawn past empty says so, and its ledger still closes', () => {
    const session = simProfile(SPIKE_SESSION);
    if (!session.ok) throw new Error(session.message);
    const res = simulate({
      machine: { ...DIRECT, pack: noCutoff() },
      law: SPIKE_SESSION.law,
      segments: session.segments,
      start: { soc: 0.05 },
    });
    expect(res.end.soc).toBeLessThan(0);
    expect(res.warnings.map((w) => w.code)).toContain('pack-empty');
    expect(res.ledger.residualRelative).toBeLessThan(1e-6);
    // Below 0 the OCV is held at its 0 % value, so the energy below 0 is that voltage times the
    // charge.
    expect(packEnergy(DIRECT.pack, -0.1)).toBeCloseTo(-0.1 * DIRECT.pack.capacity * 48, 9);
  });

  it('a ledger that does not close within 1 % is a warning', () => {
    const job = (theta: number): SimJob => ({
      machine: ideal(),
      law: NO_FORCE,
      segments: [pull(0.6, 1.5)],
      start: { soc: 0.5 },
      options: { dt: 0.01, theta },
    });
    // Backward Euler loses ½·J·Δω² a step: at 10 ms on a 0.63 s spin-up that is several percent.
    const be = simulate(job(1));
    expect(be.ledger.residualRelative).toBeGreaterThan(0.01);
    expect(be.warnings.map((w) => w.code)).toEqual(['ledger']);
    const mp = simulate(job(0.5));
    expect(mp.warnings).toEqual([]);
  });
});

describe('radius', () => {
  it('blends between layers over one turn, continuous across each boundary', () => {
    const r = {
      kind: 'steps' as const,
      steps: [
        { from: 0, to: 1, radius: 0.03 },
        { from: 1, to: 2, radius: 0.027 },
      ],
    };
    expect(radiusAt(r, 0.5)).toBe(0.03);
    expect(radiusAt(r, 1.5)).toBe(0.027);
    expect(radiusAt(r, 1)).toBeCloseTo(0.0285, 12);
    const half = Math.PI * 0.03;
    expect(radiusAt(r, 1 - half)).toBeCloseTo(0.03, 12);
    expect(radiusAt(r, 1 + half)).toBeCloseTo(0.027, 12);
    for (let x = 0.8; x < 1.2; x += 0.001) {
      expect(Math.abs(radiusAt(r, x + 0.001) - radiusAt(r, x))).toBeLessThan(1e-4);
    }
  });

  it('the pack energy is the exact integral of its piecewise-linear OCV', () => {
    const pack = DIRECT.pack;
    let trap = 0;
    for (let i = 1; i < pack.ocv.length; i++) {
      const a = pack.ocv[i - 1]!;
      const b = pack.ocv[i]!;
      trap += ((a.voltage + b.voltage) / 2) * (b.soc - a.soc);
    }
    expect(rel(packEnergy(pack, 1), trap * pack.capacity)).toBeLessThan(1e-12);
    expect(packOcv(pack, 0.55)).toBeCloseTo((16 * (3.72 + 3.8)) / 2, 12);
  });
});

describe('runs', () => {
  const segs = simProfile(TEN_REPS);
  if (!segs.ok) throw new Error(segs.message);
  const job: SimJob = {
    machine: DIRECT,
    law: TEN_REPS.law,
    segments: segs.segments,
    start: { soc: 0.5 },
  };

  it('is deterministic: the same job gives the same numbers', () => {
    const a = simulate(job);
    const b = simulate(job);
    expect(b.envelopes).toEqual(a.envelopes);
    expect(b.ledger).toEqual(a.ledger);
  });

  it('runs in slices to the same result as in one go', async () => {
    const a = simulate(job);
    const progress: number[] = [];
    const b = await runSimulation(job, { sliceMs: 1, onProgress: (f) => progress.push(f) });
    expect(b.envelopes).toEqual(a.envelopes);
    expect(progress.at(-1)).toBe(1);
  });

  it('stops at its budget and says so; a stopped run serves no envelopes to the checks', () => {
    const res = simulate({ ...job, options: { budgetMs: 0 } });
    expect(res.status).toBe('budget');
    expect(res.time).toBeLessThan(res.duration);
    const env = simulationEnvelopes({
      'lc#1': { state: res.status === 'budget' ? 'budget' : 'done', envelopes: res.envelopes },
    });
    expect(env.state('lc#1')).toBe('budget');
    expect(env.envelope('lc#1', 'motor/current', 'peak')).toBeUndefined();
  });

  it('cancels between slices', async () => {
    const c = new AbortController();
    const session = simProfile(SPIKE_SESSION);
    if (!session.ok) throw new Error(session.message);
    const long: SimJob = { ...job, segments: session.segments };
    const p = runSimulation(long, { signal: c.signal, sliceMs: 1, onProgress: () => c.abort() });
    const res = await p;
    expect(res.status).toBe('cancelled');
  });

  it('can be advanced by hand and read part way', () => {
    const sim = new Simulation(job);
    sim.advance(1000);
    expect(sim.progress).toBeCloseTo(1000 / sim.totalSteps, 12);
    expect(sim.result().status).toBe('budget');
    sim.advance(Infinity);
    expect(sim.result().status).toBe('done');
  });

  it('serves envelopes to the checks by load case, series and statistic', () => {
    const res = simulate({ ...job, components: { controller: 'el#6', resistor: 'el#7' } });
    const env = simulationEnvelopes({ 'lc#1': { state: 'done', envelopes: res.envelopes } });
    expect(env.state('lc#1')).toBe('done');
    expect(env.state('lc#2')).toBe('not-run');
    expect(env.envelope('lc#1', 'electrical/el#6/phase-current', 'peak')).toBe(
      res.envelopes['motor/current']!.peak,
    );
    const iR = env.envelope('lc#1', 'electrical/el#7/resistor-current', 'rms')!;
    // RMS of √(P/R) is √(mean P / R).
    expect(rel(iR, Math.sqrt(res.envelopes['resistor/power']!.mean / 2.5))).toBeLessThan(1e-12);
    // The pack's current is the controller's (its brake output included, no separate chopper)
    // plus the always-on loads' 2.5 W.
    const bus = res.envelopes['electrical/el#6/bus-current']!;
    const pack = res.envelopes['pack/current']!;
    const auxCharge = (2.5 * res.duration) / res.envelopes['pack/voltage']!.mean;
    expect(rel(pack.energy - bus.energy, auxCharge)).toBeLessThan(0.02);
    expect(env.envelope('lc#1', 'nothing', 'peak')).toBeUndefined();
  });
});
