// The shaft, key and hub checks (T9.5b). The cable trainer template is the fixture: its load cases
// on a belt-driven spool, with the spool's shaft described by overrides and its numbers worked out
// below. The textbook examples of T9.1d (packages/calc/src/shafts.test.ts, fatigue.test.ts,
// concentration.test.ts, shaft-deflection.test.ts, keys.test.ts, fits.test.ts) then go through the
// checks' own working, their inputs given by overrides.

import {
  fatigueNotchFactor,
  marinEnduranceLimit,
  shaftFatigueFactor,
  shaftStress,
  shoulderFilletKt,
  fromRecord,
  type CalcRecord,
} from '@manufakture/calc';
import {
  applyCommand,
  createDocument,
  type CheckOverride,
  type Command,
  type Drivetrain,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { EvaluationContext } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { builtinRef } from '../../parts/catalog';
import { templateCommand } from '../../requirements/templates';
import { mechSettings } from '../../settings';
import { createMechEvaluation, type MechEvaluation } from '../evaluation';
import type { CheckEntry } from '../registry';
import { simulationFrom, type SimulationEnvelopes } from '../simulation';
import type { MechRecord } from '../types';
import { statusLabel } from '../wording';
import {
  SHAFT_CRITICAL_SPEED,
  SHAFT_DEFLECTION,
  SHAFT_FATIGUE,
  SHAFT_KEY,
  SHAFT_PRESS_FIT,
  SHAFT_PRESS_FIT_HUB,
  SHAFT_SLOPE,
  SHAFT_STRESS,
} from './checks';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const LBF = 4.4482216152605;
const MM = 1e-3;
const MPA = 1e6;
const WORDS = /\b(safe|safety|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*|ok)\b/i;

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/**
 * Motor, its own shaft, a 5:1 belt at 0.95, the spool's shaft on two SKF 6204-2RSH, and the spool
 * of the T9.3b hand calculation (2.85 m of 3 mm cable on a 40 mm core, 20 mm wide: 30.5 mm wound).
 */
const DRIVE: Drivetrain = {
  id: 'drive#1',
  name: 'Belt drive',
  stages: [
    { id: 'stage#1', kind: 'motor', use: 'pp#10', inertia: x('1e-4 kg*m^2') },
    { id: 'stage#2', kind: 'shaft', bearings: [], inertia: x('1e-6 kg*m^2') },
    { id: 'stage#3', kind: 'belt', ratio: x('5'), efficiency: x('0.95') },
    {
      id: 'stage#4',
      kind: 'shaft',
      bearings: [{ use: 'pp#12' }, { use: 'pp#13' }],
      inertia: x('1e-5 kg*m^2'),
    },
  ],
  output: {
    kind: 'spool',
    cable: 'pp#11',
    length: x('2.85 m'),
    core: x('40 mm'),
    width: x('20 mm'),
    flange: x('80 mm'),
    inertia: x('1e-4 kg*m^2'),
  },
};

const SPOOL_SHAFT = { kind: 'stage', drivetrain: 'drive#1', stage: 'stage#4' } as const;

let nextOverride = 1;
const override = (o: Omit<CheckOverride, 'id'>): Command => ({
  type: 'setCheckOverride',
  override: { id: `chk#${nextOverride++}`, ...o } as never,
});

/** The template's load cases and requirements on the belt drive, with no shaft described. */
function bare(): { doc: ManufaktureDocument; lc: string[] } {
  const base = createDocument({ id: 'd', name: 'Trainer' });
  const t = templateCommand(base, 'cable-trainer');
  if (!t.ok) throw new Error(t.message);
  const doc = apply(
    base,
    t.command,
    ...(
      [
        ['pp#10', 'motor/cubemars-ro100-kv55', 'Motor'],
        ['pp#11', 'rope/samson-amsteel-blue-3mm', 'Cable'],
        ['pp#12', 'bearing/skf-6204-2rsh', 'Front bearing'],
        ['pp#13', 'bearing/skf-6204-2rsh', 'Rear bearing'],
      ] as const
    ).map(([id, entry, name]): Command => ({
      type: 'setPurchasedUse',
      use: { id, entry: builtinRef(entry)!, alternates: [], name },
    })),
    { type: 'setDrivetrain', drivetrain: DRIVE },
  );
  return { doc, lc: t.loadCaseIds };
}

/**
 * The spool's shaft described: 60 mm between its bearings, the spool in the middle, steel 4140; a
 * bearing seat at 10 mm (20 mm against a 25 mm shoulder, 1 mm fillet) and the spool's keyseat at
 * 30 mm (25 mm, 0.5 mm fillet, an 8 x 7 x 20 mm key of 1018 in a 6061-T6 hub).
 */
function trainer(): { doc: ManufaktureDocument; lc: string[] } {
  nextOverride = 1;
  const { doc, lc } = bare();
  return {
    lc,
    doc: apply(
      doc,
      override({
        check: 'shaft.',
        subject: SPOOL_SHAFT,
        inputs: { L: x('60 mm'), a: x('30 mm'), material: 'steel-4140' },
      }),
      override({
        check: 'shaft.',
        subject: { ...SPOOL_SHAFT, at: 'seat-A' },
        inputs: { x: x('10 mm'), d: x('20 mm'), D: x('25 mm'), r: x('1 mm') },
      }),
      override({
        check: 'shaft.',
        subject: { ...SPOOL_SHAFT, at: 'spool' },
        inputs: {
          x: x('30 mm'),
          d: x('25 mm'),
          r: x('0.5 mm'),
          feature: 'keyseat',
          w: x('8 mm'),
          h: x('7 mm'),
          l_key: x('20 mm'),
          keyMaterial: 'steel-1018',
          hubMaterial: 'aluminium-6061',
        },
      }),
    ),
  };
}

function context(doc: ManufaktureDocument): EvaluationContext {
  const settings = mechSettings(doc.domains);
  if (!settings.ok) throw new Error(settings.message);
  return {
    document: doc,
    data: doc.domains?.mech === undefined ? {} : { mech: settings.value },
    variables: new Map(),
    parts: [],
    assemblies: [],
  };
}

function run(doc: ManufaktureDocument, simulation?: SimulationEnvelopes) {
  const stage = createMechEvaluation({
    implementation: 1,
    ...(simulation !== undefined ? { simulation: () => simulation } : {}),
  });
  const out = stage.evaluate(context(doc), []);
  const data = out.data as unknown as MechEvaluation;
  const entry = (id: string): CheckEntry => {
    const e = data.checks.find((c) => c.record.id === id);
    if (e === undefined) {
      throw new Error(`no record ${id}; have ${data.checks.map((c) => c.record.id).join(', ')}`);
    }
    return e;
  };
  const shafts = data.checks.filter((c) => c.record.check.startsWith('shaft.'));
  return { data, shafts, warnings: out.warnings ?? [], entry };
}

const withFactors = (doc: ManufaktureDocument, factors: object) =>
  apply(doc, {
    type: 'setDomainData',
    namespace: 'mech',
    schemaVersion: 1,
    data: { factors } as never,
  });

const derived = (r: CalcRecord, symbol: string) =>
  r.derived.find((d) => d.symbol === symbol)?.value;
const input = (r: CalcRecord, symbol: string) => r.inputs.find((i) => i.symbol === symbol);

/** Every word a record or its line shows. */
function words(e: CheckEntry, factor: boolean): string[] {
  const r = e.record;
  return [
    e.text,
    statusLabel(r, factor),
    r.title,
    r.method,
    r.note ?? '',
    ...r.assumptions,
    ...r.inputs.map((i) => `${i.name} ${i.source}`),
    ...r.derived.map((d) => d.name),
  ];
}

// The fixture's hand numbers: the full-force rep (R6) and the hold (R8) both pull 200 lbf, and the
// first of them governs; the spool's shaft turns with the spool, so it carries the cable tension
// and the torque at the largest effective radius, 30.5 mm.
const F = 200 * LBF;
const T = F * 0.0305;

describe('the shaft checks on the cable trainer template', () => {
  it('gives every shaft with bearings its records, naming what is missing until it is described', () => {
    // The motor's shaft (stage#2) lists no bearings; the spool's shaft (stage#4) has two.
    const undescribed = run(bare().doc).shafts;
    expect(undescribed.map((s) => s.record.id).sort()).toEqual(
      [
        `${SHAFT_CRITICAL_SPEED}@drive#1/stage#4`,
        `${SHAFT_DEFLECTION}@drive#1/stage#4`,
        `${SHAFT_SLOPE}@drive#1/stage#4/bearing-A`,
        `${SHAFT_SLOPE}@drive#1/stage#4/bearing-B`,
      ].sort(),
    );
    for (const s of undescribed) {
      expect(s.record.status).toBe('unknown');
      expect(s.record.result).toBeNull();
    }
    const defl = undescribed.find((s) => s.record.check === SHAFT_DEFLECTION)!.record;
    expect(defl.missing).toEqual([
      'Span between the bearings',
      'Load distance from the first bearing',
      'Shaft diameter',
      "Young's modulus",
    ]);
    expect(defl.note).toMatch(
      /no material: name the shaft's instance on stage#4, or type material/,
    );
  });

  it('names the governing load case in every record', () => {
    const { doc, lc } = trainer();
    const { shafts } = run(doc);
    expect(shafts.map((s) => s.record.id).sort()).toEqual(
      [
        `${SHAFT_CRITICAL_SPEED}@drive#1/stage#4`,
        `${SHAFT_DEFLECTION}@drive#1/stage#4`,
        `${SHAFT_FATIGUE}@drive#1/stage#4/seat-A`,
        `${SHAFT_FATIGUE}@drive#1/stage#4/spool`,
        `${SHAFT_KEY}@drive#1/stage#4/spool`,
        `${SHAFT_SLOPE}@drive#1/stage#4/bearing-A`,
        `${SHAFT_SLOPE}@drive#1/stage#4/bearing-B`,
        `${SHAFT_STRESS}@drive#1/stage#4/seat-A`,
        `${SHAFT_STRESS}@drive#1/stage#4/spool`,
      ].sort(),
    );
    for (const s of shafts) {
      // The critical speed is governed by the fastest load case, every other by the full-force rep.
      if (s.record.check === SHAFT_CRITICAL_SPEED) expect(s.record.loadCase).toBe(lc[1]);
      else expect(s.record.loadCase, s.record.id).toBe(lc[0]);
      expect(s.record.status, `${s.record.id}: ${s.record.note}`).toBe('ok');
    }
  });

  it('never takes a bearing location for a section', () => {
    const { doc } = trainer();
    const d = apply(
      doc,
      override({
        check: 'shaft.slope',
        subject: { ...SPOOL_SHAFT, at: 'bearing A' },
        inputs: { theta_max: x('0.01 deg') },
      }),
    );
    const { shafts, entry } = run(d);
    expect(shafts.some((s) => s.record.id.endsWith('/bearing A'))).toBe(false);
    expect(shafts).toHaveLength(9);
    expect(entry(`${SHAFT_SLOPE}@drive#1/stage#4/bearing-A`).record.limit).toBeCloseTo(
      (0.01 * Math.PI) / 180,
      12,
    );
  });

  it('states the stress at the bearing seat from statics, the shoulder and the material', () => {
    const { doc } = trainer();
    const r = run(withFactors(doc, { strength: 2 })).entry(
      `${SHAFT_STRESS}@drive#1/stage#4/seat-A`,
    );
    // M = F (L - a) x / L = F 0.03 0.01 / 0.06.
    const M = (F * 0.03 * 0.01) / 0.06;
    expect(derived(r.record, 'M')).toBeCloseTo(M, 9);
    expect(input(r.record, 'F')!.value).toBeCloseTo(F, 6);
    expect(input(r.record, 'T')!.value).toBeCloseTo(T, 6);
    expect(input(r.record, 'S_y')).toMatchObject({ value: 415 * MPA });
    expect(r.record.inputRefs.Sy).toEqual({
      kind: 'material',
      id: 'steel-4140',
      property: 'yieldStrength',
    });
    // The same chain by hand through calc.
    const Sut = 655 * MPA;
    const g = { D: 0.025, d: 0.02, r: 0.001 };
    const kf = fatigueNotchFactor(
      { Kt: fromRecord(shoulderFilletKt(g, 'bending')), r: 0.001, Sut },
      'bending',
    );
    const kfs = fatigueNotchFactor(
      { Kt: fromRecord(shoulderFilletKt(g, 'torsion')), r: 0.001, Sut },
      'torsion',
    );
    const vm = shaftStress({ M, T, d: 0.02, Kf: kf.result!, Kfs: kfs.result! }).result!;
    expect(input(r.record, "σ'")!.value).toBeCloseTo(vm, 0);
    expect(r.record.result).toBeCloseTo((415 * MPA) / vm, 9);
    expect(r.record.limit).toBe(2);
    expect(r.text).toMatch(
      /^Shaft stress, Shaft \(stage#4\) of Belt drive at seat-A: von mises stress /,
    );
    expect(r.text).toMatch(/yield strength 415 MPa/);
    expect(r.text).toMatch(/factor \d+\.\d\d, above your 2$/);
  });

  it('states the fatigue factor at the seat by DE-Goodman with the Marin factors', () => {
    const { doc } = trainer();
    const r = run(doc).entry(`${SHAFT_FATIGUE}@drive#1/stage#4/seat-A`);
    const Sut = 655 * MPA;
    const g = { D: 0.025, d: 0.02, r: 0.001 };
    const Kf = fatigueNotchFactor(
      { Kt: fromRecord(shoulderFilletKt(g, 'bending')), r: 0.001, Sut },
      'bending',
    ).result!;
    const Kfs = fatigueNotchFactor(
      { Kt: fromRecord(shoulderFilletKt(g, 'torsion')), r: 0.001, Sut },
      'torsion',
    ).result!;
    const Se = marinEnduranceLimit(
      { Sut, d: 0.02 },
      { surface: 'machined', loading: 'bending' },
    ).result!;
    const n = shaftFatigueFactor(
      {
        Ma: (F * 0.03 * 0.01) / 0.06,
        Mm: 0,
        Ta: T / 2,
        Tm: T / 2,
        d: 0.02,
        Kf,
        Kfs,
        Se,
        Sut,
        Sy: 415 * MPA,
      },
      'goodman',
    ).result!;
    expect(r.record.result).toBeCloseTo(n, 9);
    expect(input(r.record, 'S_e')!.value).toBeCloseTo(Se, 0);
    // No factor set: the factor stands with nothing to compare, and no warning.
    expect(r.record.limit).toBeUndefined();
    expect(statusLabel(r.record, true)).toBe('not compared: no factor set');
    expect(r.record.assumptions).toContain(
      'The torque rises from zero to its peak and back each rep: T_a = T_m = T/2',
    );
  });

  it('states the key, the deflection, the slopes and the critical speed', () => {
    const { doc } = trainer();
    const { entry } = run(doc);
    // Key: F = 2T/d on a 25 mm shaft; 8 x 7 mm, 20 mm long, 1018 (370 MPa) in 4140 (415 MPa) and
    // a 6061-T6 hub (276 MPa): crushing at the softest, 276 MPa, over h/2; shear at the key's 370.
    const key = entry(`${SHAFT_KEY}@drive#1/stage#4/spool`).record;
    const Fk = (2 * T) / 0.025;
    expect(derived(key, 'S_c')).toBe(276 * MPA);
    expect(derived(key, 'n_s')).toBeCloseTo((0.577 * 370 * MPA * 0.008 * 0.02) / Fk, 6);
    expect(key.result).toBeCloseTo((276 * MPA * 0.0035 * 0.02) / Fk, 6);
    // The shaft as uniform at its smallest section (20 mm), the load at a = L/2: F L³ / 48 E I
    // and F L² / 16 E I, E = 200 GPa.
    const EI = (200e9 * Math.PI * 0.02 ** 4) / 64;
    const defl = entry(`${SHAFT_DEFLECTION}@drive#1/stage#4`).record;
    expect(defl.result).toBeCloseTo((F * 0.06 ** 3) / (48 * EI), 12);
    expect(input(defl, 'd')!.source).toMatch(/smallest section diameter, at seat-A/);
    const slope = entry(`${SHAFT_SLOPE}@drive#1/stage#4/bearing-A`);
    expect(slope.record.result).toBeCloseTo((F * 0.06 ** 2) / (16 * EI), 12);
    expect(slope.record.title).toBe(
      'Shaft slope, Shaft (stage#4) of Belt drive at Front bearing (pp#12), bearing A',
    );
    expect(input(slope.record, 'θ_typ')).toMatchObject({ value: 0.003 });
    expect(statusLabel(slope.record, false)).toBe('nothing to compare with');
    const crit = entry(`${SHAFT_CRITICAL_SPEED}@drive#1/stage#4`).record;
    // No mass given: the bare shaft, said so, and not set against the operating speed.
    expect(crit.result).toBeGreaterThan(0);
    expect(crit.method).toMatch(/^The bare shaft's first bending mode only/);
    expect(derived(crit, 'ω₁/ω')).toBeUndefined();
    expect(crit.assumptions.join(' ')).toMatch(/No mass on the shaft is given/);
    // With the spool's mass where the cable pulls: Dunkerley, and the ratio to the fastest speed.
    const withMass = run(
      apply(doc, override({ check: 'shaft.', subject: SPOOL_SHAFT, inputs: { m: x('0.5 kg') } })),
    ).entry(`${SHAFT_CRITICAL_SPEED}@drive#1/stage#4`).record;
    expect(withMass.result!).toBeLessThan(crit.result!);
    expect(derived(withMass, 'ω₁/ω')).toBeGreaterThan(1);
  });

  it('compares the slope and deflection only with the limits you type, read in their units', () => {
    const { doc } = trainer();
    const limited = apply(
      doc,
      override({
        check: 'shaft.',
        subject: SPOOL_SHAFT,
        inputs: { theta_max: x('0.005 deg'), y_max: x('0.01 mm') },
      }),
    );
    const { entry, warnings } = run(limited);
    const slope = entry(`${SHAFT_SLOPE}@drive#1/stage#4/bearing-B`);
    expect(slope.record.limit).toBeCloseTo((0.005 * Math.PI) / 180, 12);
    expect(slope.record.status).toBe('warning');
    expect(statusLabel(slope.record, false)).toBe('outside your limit');
    expect(warnings.some((w) => w.code === 'mech-check' && w.recordId === slope.record.id)).toBe(
      true,
    );
    const defl = entry(`${SHAFT_DEFLECTION}@drive#1/stage#4`).record;
    expect(defl.limit).toBeCloseTo(1e-5, 12);
    expect(defl.status).toBe('ok');
  });

  it('does not run the Marin estimate for steel when no material is known', () => {
    nextOverride = 1;
    const doc = apply(
      bare().doc,
      override({ check: 'shaft.', subject: SPOOL_SHAFT, inputs: { L: x('60 mm'), a: x('30 mm') } }),
      override({
        check: 'shaft.',
        subject: { ...SPOOL_SHAFT, at: 'mid' },
        inputs: { x: x('30 mm'), d: x('20 mm'), Sut: x('655 MPa'), Sy: x('415 MPa') },
      }),
    );
    const r = run(doc).entry(`${SHAFT_FATIGUE}@drive#1/stage#4/mid`).record;
    expect(r.status).toBe('unknown');
    expect(r.result).toBeNull();
    expect(r.missing).toEqual(['Endurance limit at the section']);
    expect(r.note).toMatch(
      /no material is known, so the Marin estimate \(for steel\) does not apply/,
    );
  });

  it('takes K_f = K_t for a material that is not a steel, and says so', () => {
    const { doc } = trainer();
    const d = apply(
      doc,
      override({ check: 'shaft.', subject: SPOOL_SHAFT, inputs: { material: 'aluminium-6061' } }),
    );
    const r = run(d).entry(`${SHAFT_STRESS}@drive#1/stage#4/seat-A`).record;
    expect(r.derived.some((v) => v.symbol === 'fatigue.notch-factor')).toBe(false);
    expect(r.assumptions.join(' ')).toMatch(
      /K_f = K_t \(notch sensitivity 1\): Neuber's notch-sensitivity fit is for steel/,
    );
    const kt = shoulderFilletKt({ D: 0.025, d: 0.02, r: 0.001 }, 'bending').result!;
    const kts = shoulderFilletKt({ D: 0.025, d: 0.02, r: 0.001 }, 'torsion').result!;
    const vm = shaftStress({ M: (F * 0.03 * 0.01) / 0.06, T, d: 0.02, Kf: kt, Kfs: kts }).result!;
    expect(input(r, "σ'")!.value).toBeCloseTo(vm, 0);
  });

  it('lets the simulation govern where its peak is larger', () => {
    const { doc, lc } = trainer();
    const sim = simulationFrom({ [lc[2]!]: { 'cable.tension:peak': 950 } });
    const r = run(doc, sim).entry(`${SHAFT_STRESS}@drive#1/stage#4/spool`).record;
    expect(r.loadCase).toBe(lc[2]);
    expect(input(r, 'F')!.value).toBe(950);
    expect(r.inputRefs.F).toEqual({
      kind: 'simulation',
      loadCase: lc[2],
      series: 'cable.tension',
      statistic: 'peak',
    });
  });

  it('carries the torque up the chain and asks for the transverse load of a shaft before the belt', () => {
    const { doc } = trainer();
    const d = apply(
      doc,
      override({
        check: 'shaft.',
        subject: { ...SPOOL_SHAFT, stage: 'stage#2' },
        inputs: { L: x('40 mm') },
      }),
      override({
        check: 'shaft.',
        subject: { ...SPOOL_SHAFT, stage: 'stage#2', at: 'motor-seat' },
        inputs: { x: x('20 mm'), d: x('12 mm') },
      }),
    );
    const r = run(d).entry(`${SHAFT_STRESS}@drive#1/stage#2/motor-seat`).record;
    expect(r.status).toBe('unknown');
    expect(r.note).toMatch(
      /Transverse load on the shaft \(Shaft \(stage#2\) of Belt drive is not the spool's shaft/,
    );
    expect(input(r, 'T')!.value).toBeCloseTo(T / (5 * 0.95), 9);
  });

  it('names what is missing and never calls anything safe or passing', () => {
    nextOverride = 1;
    const doc = apply(
      bare().doc,
      override({ check: 'shaft.stress', subject: { ...SPOOL_SHAFT, at: 'mid' } }),
    );
    const { shafts, warnings } = run(withFactors(doc, { strength: 2, fatigue: 2 }));
    const stress = shafts.find((s) => s.record.check === SHAFT_STRESS)!;
    expect(stress.record.status).toBe('unknown');
    expect(stress.record.missing).toEqual([
      'Span between the bearings',
      'Load distance from the first bearing',
      'Section distance from the first bearing',
      'Shaft diameter',
      'Yield strength',
    ]);
    expect(stress.record.note).toMatch(/type L in a `shaft\.` override for stage#4/);
    expect(warnings.some((w) => w.code === 'mech-check' && w.recordId === stress.record.id)).toBe(
      true,
    );

    const all = run(withFactors(trainer().doc, { strength: 2, fatigue: 2 })).shafts;
    for (const e of [...shafts, ...all]) {
      for (const w of words(e, e.factor !== undefined)) expect(w, e.record.id).not.toMatch(WORDS);
    }
  });
});

describe('the textbook examples of T9.1d through the shaft checks', () => {
  /** The trainer with one more override on the spool's shaft, at a section or for all of it. */
  function withInputs(
    at: string | undefined,
    inputs: CheckOverride['inputs'],
  ): ManufaktureDocument {
    const { doc } = trainer();
    return apply(
      doc,
      override({
        check: 'shaft.',
        subject: at === undefined ? SPOOL_SHAFT : { ...SPOOL_SHAFT, at },
        inputs: inputs!,
      }),
    );
  }

  const record = (doc: ManufaktureDocument, id: string): MechRecord => run(doc).entry(id).record;

  it('Shigley 10th ed. Problem 7-1 (solutions manual): DE-Goodman at d = 27.27 mm and DE-Gerber at 25.85 mm give n = 2', () => {
    const loads = {
      Ma: x('70 N*m'),
      Mm: x('55 N*m'),
      Ta: x('45 N*m'),
      Tm: x('35 N*m'),
      Kf: x('2.2'),
      Kfs: x('1.8'),
      Se: x('210 MPa'),
      Sut: x('700 MPa'),
      Sy: x('560 MPa'),
    };
    const goodman = record(
      withInputs('seat-A', { ...loads, d: x('27.27 mm') }),
      `${SHAFT_FATIGUE}@drive#1/stage#4/seat-A`,
    );
    expect(goodman.result! / 2).toBeCloseTo(1, 2);
    const gerber = record(
      withInputs('seat-A', { ...loads, d: x('25.85 mm'), criterion: 'gerber' }),
      `${SHAFT_FATIGUE}@drive#1/stage#4/seat-A`,
    );
    expect(gerber.result! / 2).toBeCloseTo(1, 2);
    expect(gerber.method).toMatch(/Marin/);
  });

  it('Shigley 11th ed. Problem 6-10 (solutions manual): machined, Sut 570 MPa, d 25 mm, Se 192 MPa', () => {
    const r = record(
      withInputs('spool', { Sut: x('570 MPa') }),
      `${SHAFT_FATIGUE}@drive#1/stage#4/spool`,
    );
    expect(input(r, 'S_e')!.value! / (192 * MPA)).toBeCloseTo(1, 2);
    expect(derived(r, 'k_a')).toBeCloseTo(0.767, 3);
    expect(derived(r, 'k_b')).toBeCloseTo(0.879, 3);
  });

  it('Pilkey 2nd ed. Example 6.1 (U-groove, D 70 mm, h 10.5 mm, r 7 mm): Kt 1.78 in bending, 1.41 in torsion', () => {
    const r = record(
      withInputs('seat-A', { feature: 'groove', D: x('70 mm'), d: x('49 mm'), r: x('7 mm') }),
      `${SHAFT_STRESS}@drive#1/stage#4/seat-A`,
    );
    expect(derived(r, 'kt.groove-bending')).toBeCloseTo(1.78, 2);
    expect(derived(r, 'kt.groove-torsion')).toBeCloseTo(1.41, 2);
  });

  it('Shigley 10th ed. Problem 7-28 (solutions manual): a uniform 25 mm steel shaft on a 0.6 m span, 883 rad/s', () => {
    const r = record(
      withInputs(undefined, {
        L: x('0.6 m'),
        d: x('25 mm'),
        E: x('207 GPa'),
        rho: x('76.5e3 / 9.81'),
      }),
      `${SHAFT_CRITICAL_SPEED}@drive#1/stage#4`,
    );
    expect(r.result! / 883).toBeCloseTo(1, 2);
  });

  it('Shigley 10th ed. Problem 4-46 (solutions manual): 3 kN at 100 mm on 300 mm, d 38.1 mm: slope 0.001/1.28 rad, deflection 0.0678 mm', () => {
    const doc = withInputs(undefined, {
      F: x('3 kN'),
      a: x('100 mm'),
      L: x('300 mm'),
      d: x('38.1 mm'),
      E: x('207 GPa'),
    });
    const slope = record(doc, `${SHAFT_SLOPE}@drive#1/stage#4/bearing-A`);
    expect(slope.result! / (0.001 / 1.28)).toBeCloseTo(1, 2);
    const defl = record(doc, `${SHAFT_DEFLECTION}@drive#1/stage#4`);
    expect(defl.result! / (0.0678 * MM)).toBeCloseTo(1, 2);
  });

  it('Shigley 10th ed. Problem 7-35 (solutions manual): a 14 mm square key, 50 mm long, 3101 N·m on 50 mm, n = 1.1', () => {
    const r = record(
      withInputs('spool', {
        T: x('3101 N*m'),
        d: x('50 mm'),
        r: x('1 mm'),
        w: x('14 mm'),
        h: x('14 mm'),
        l_key: x('50 mm'),
        Sy_key: x('390 MPa'),
        Sy_hub: x('600 MPa'),
      }),
      `${SHAFT_KEY}@drive#1/stage#4/spool`,
    );
    expect(r.result! / 1.1).toBeCloseTo(1, 2);
  });

  it('Shigley 10th ed. Problem 7-42 (solutions manual): 35 mm H7/s6 in a 60 mm hub, 2700 N·m at the least interference, hub factor 1.9 at the most', () => {
    const fit = (delta: string) =>
      withInputs('spool', {
        feature: 'press-fit',
        d: x('35 mm'),
        delta: x(delta),
        D_hub: x('60 mm'),
        l_hub: x('50 mm'),
        f: x('0.8'),
        T: x('1000 N*m'),
        E: x('207 GPa'),
        nu: x('0.3'),
        E_hub: x('207 GPa'),
        nu_hub: x('0.3'),
        Sy_hub: x('600 MPa'),
        Kf: x('1'),
        Kfs: x('1'),
      });
    const slip = record(fit('0.018 mm'), `${SHAFT_PRESS_FIT}@drive#1/stage#4/spool`);
    expect(input(slip, 'p')!.value! / (35.1 * MPA)).toBeCloseTo(1, 2);
    expect(slip.result! / 2.7).toBeCloseTo(1, 2);
    const hub = record(fit('0.059 mm'), `${SHAFT_PRESS_FIT_HUB}@drive#1/stage#4/spool`);
    expect(input(hub, "σ'")!.value! / (308 * MPA)).toBeCloseTo(1, 2);
    expect(hub.result! / (600 / 308)).toBeCloseTo(1, 2);
    expect(hub.loadCase).toBeUndefined();
  });
});
