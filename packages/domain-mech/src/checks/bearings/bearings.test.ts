// The bearing checks (T9.5c): L10 life over the duty cycle, the static factor and the speed against
// the limiting speed. The cable trainer template is the fixture, its numbers worked out by hand
// below; the textbook examples of T9.1d (packages/calc/src/bearings.test.ts) and the duty cycle
// of Shigley's Problem 11-39 go through the checks' own working by overrides.

import { cubicMeanLoad } from '@manufakture/calc';
import {
  applyCommand,
  createDocument,
  type CatalogEntry,
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
import { statusLabel } from '../wording';
import { BEARING_LIFE_CHECK, BEARING_SPEED_CHECK, BEARING_STATIC_CHECK } from './checks';
import { spoolAngle } from './duty';
import { wind } from '../../spool/winding';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const TAU = 2 * Math.PI;
const LBF = 4.4482216152605;
const RPM = TAU / 60;
const WORDS = /\b(safe|safety|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*|ok)\b/i;

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/** A direct-drive spool: motor, a shaft on two bearings, the spool of the T9.3b hand calculation. */
function drivetrain(bearings: string[], stages: Drivetrain['stages'] = []): Drivetrain {
  return {
    id: 'drive#1',
    name: 'Direct',
    stages: [
      { id: 'stage#1', kind: 'motor', use: 'pp#10', inertia: x('1e-4 kg*m^2') },
      ...stages,
      { id: 'stage#2', kind: 'shaft', bearings: bearings.map((use) => ({ use })) },
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
}

/** The cable trainer template's load cases on a direct-drive spool with two SKF 6204-2RSH. */
function trainer(): { doc: ManufaktureDocument; lc: string[] } {
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
    { type: 'setDrivetrain', drivetrain: drivetrain(['pp#12', 'pp#13']) },
  );
  return { doc, lc: t.loadCaseIds };
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
  return { data, warnings: out.warnings ?? [], entry };
}

const withOverride = (doc: ManufaktureDocument, o: Partial<CheckOverride>) =>
  apply(doc, { type: 'setCheckOverride', override: { id: 'chk#1', ...o } as never });

const withFactors = (doc: ManufaktureDocument, factors: object) =>
  apply(doc, {
    type: 'setDomainData',
    namespace: 'mech',
    schemaVersion: 1,
    data: { factors } as never,
  });

const derived = (e: CheckEntry, symbol: string) =>
  e.record.derived.find((d) => d.symbol === symbol)?.value;

const FRONT = 'drive#1/stage#2/pp#12';
const REAR = 'drive#1/stage#2/pp#13';

// The hand calculation for the template on this spool (T9.3b: 3 mm cable, 40 mm core, 20 mm
// between the flanges, 2.85 m wound; layer 4 holds 2.85 - 2.77088 = 0.07912 m at r4 = 30.5 mm,
// layer 3 the next 1.03673 m at r3 = 27.5 mm).
//
//   A rep's 0.6 m stroke   pull and return each turn the spool 0.07912 / 0.0305 + 0.52088 / 0.0275
//                          = 2.59410 + 18.94109 = 21.53519 rad; a rep 43.07038 rad = 6.85485 rev
//   Full force rep (R6)    200 lbf = 889.64 N, constant; 9 reps of pull 0.6π / (2 · 1.5) = 0.62832 s,
//                          pause 0.2 s, return 0.62832 s, pause 0.2 s: 1.65664 s a rep, 14.90973 s
//   Each bearing           k = 1/2: F_r = 444.82 N; F_a = 0, so P = F_r (deep groove, X = 1)
//   L10                    (13 500 / 444.82)^3 × 10⁶ = 27.954 × 10⁹ rev
//   In sessions            27.954e9 / (9 · 6.85485) = 453.1 × 10⁶ sessions of 14.90973 s
//   In hours               about 1.877 × 10⁶ h
//   The session cases (R9) carry half the force and take longer per turn, the rowing case (R7) at
//   most 50 lbf: the full force rep gives the shortest life and governs.
//
//   Static factor          largest tension 889.64 N (the full force rep; the isometric hold ties
//                          it, the first one listed governs); P0 = max(0.6 F_r, F_r) = 444.82 N;
//                          s0 = 6600 / 444.82 = 14.84
//   Speed                  the rowing case (R7) pulls at 3 m/s: its peak, mid-stroke at 0.3 m out,
//                          is on layer 3, 3 / 0.0275 = 109.09 rad/s (1041.7 r/min), against the
//                          6204-2RSH's 10 000 r/min = 1047.2 rad/s
const r3 = 0.0275;
const r4 = 0.0305;
const layer4 = 2.85 - 6 * TAU * (0.0215 + 0.0245 + 0.0275);
const radPerRep = 2 * (layer4 / r4 + (0.6 - layer4) / r3);
const FORCE = 200 * LBF;
const L10 = (13500 / (FORCE / 2)) ** 3 * 1e6;
const REP = 2 * ((Math.PI * 0.6) / 3) + 0.4;

describe('the hand calculation behind the fixture', () => {
  it('turns the spool 21.535 rad over a 0.6 m stroke from full wind', () => {
    expect(layer4).toBeCloseTo(0.07912, 5);
    const w = wind({ core: 0.04, width: 0.02 }, 0.003, 2.85);
    expect(spoolAngle(w, 0, 0.6)).toBeCloseTo(radPerRep / 2, 9);
    expect(spoolAngle(w, 0.6, 0)).toBeCloseTo(radPerRep / 2, 9);
    expect(radPerRep / 2).toBeCloseTo(21.53519, 4);
    // Beyond the length the radius stays at layer 1 (21.5 mm).
    expect(spoolAngle(w, 2.85, 2.95)).toBeCloseTo(0.1 / 0.0215, 9);
  });
});

describe('the cable trainer template (the fixture)', () => {
  it('states the L10 life of each spool bearing in hours, governed by the full force rep', () => {
    const { doc, lc } = trainer();
    const { entry, warnings } = run(doc);
    for (const where of [FRONT, REAR]) {
      const e = entry(`${BEARING_LIFE_CHECK}@${where}`);
      expect(e.record.loadCase).toBe(lc[0]);
      expect(e.record.title).toContain('governed by Full force rep (R6)');
      expect(e.record.status).toBe('ok');
      expect(e.record.unit).toBe('h');
      expect(e.record.limit).toBeUndefined();
      expect(derived(e, 'F_r')).toBeCloseTo(FORCE / 2, 6);
      expect(derived(e, 'P')).toBeCloseTo(FORCE / 2, 6);
      expect(derived(e, 'L10')! / L10).toBeCloseTo(1, 9);
      const revs = e.record.inputs.find((i) => i.symbol === 'N_c')!.value!;
      expect(revs).toBeCloseTo((9 * radPerRep) / TAU, 6);
      const hours = ((L10 / revs) * (9 * REP)) / 3600;
      expect(e.record.result! / hours).toBeCloseTo(1, 6);
      expect(e.record.result).toBeGreaterThan(1.87e6);
      expect(e.record.result).toBeLessThan(1.885e6);
      expect(statusLabel(e.record, false)).toBe('nothing to compare with');
    }
    // No target, no factor: nothing below anything, so no bearing warnings.
    expect(warnings.filter((w) => 'check' in w && String(w.check).startsWith('bearing.'))).toEqual(
      [],
    );
  });

  it('states the static factor against nothing until a factor is set, then against it', () => {
    const { doc, lc } = trainer();
    const e = run(doc).entry(`${BEARING_STATIC_CHECK}@${FRONT}`);
    expect(e.record.loadCase).toBe(lc[0]);
    expect(e.record.result).toBeCloseTo(6600 / (FORCE / 2), 9);
    expect(e.text).toContain('factor 14.84; not compared: no factor set');
    const two = run(withFactors(doc, { strength: 2 })).entry(`${BEARING_STATIC_CHECK}@${FRONT}`);
    expect(two.text).toContain('factor 14.84, above your 2');
    expect(two.record.status).toBe('ok');
    const twenty = run(withFactors(doc, { strength: 20 }));
    expect(twenty.entry(`${BEARING_STATIC_CHECK}@${FRONT}`).record.status).toBe('warning');
    expect(twenty.warnings.map((w) => w.message)).toContainEqual(
      expect.stringContaining('factor 14.84, below your 20'),
    );
  });

  it('takes the simulated peak tension when it is larger, and names the load case it came from', () => {
    const { doc, lc } = trainer();
    const sim = simulationFrom({ [lc[2]!]: { 'cable.tension:peak': 1200 } });
    const e = run(doc, sim).entry(`${BEARING_STATIC_CHECK}@${FRONT}`);
    expect(e.record.loadCase).toBe(lc[2]);
    expect(e.record.title).toContain('governed by Isometric hold');
    expect(e.record.result).toBeCloseTo(6600 / 600, 9);
    expect(e.record.inputRefs.F).toEqual({
      kind: 'simulation',
      loadCase: lc[2],
      series: 'cable.tension',
      statistic: 'peak',
    });
  });

  it('compares the highest speed with the limiting speed, governed by the rowing case', () => {
    const { doc, lc } = trainer();
    const e = run(doc).entry(`${BEARING_SPEED_CHECK}@${FRONT}`);
    expect(e.record.loadCase).toBe(lc[1]);
    expect(e.record.result).toBeCloseTo(3 / r3, 6);
    expect(e.record.limit).toBeCloseTo(10000 * RPM, 9);
    expect(e.record.margin).toBeCloseTo(1 - 3 / r3 / (10000 * RPM), 6);
    expect(e.record.status).toBe('ok');
    expect(e.record.inputs.find((i) => i.symbol === 'ω_lim')!.source).toContain('unverified');
  });

  it('warns below the life target the user gives, with the margin', () => {
    const { doc } = trainer();
    const short = run(
      withOverride(doc, { check: BEARING_LIFE_CHECK, inputs: { t_req: x('1e7 h') } }),
    );
    const e = short.entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(e.record.limit).toBe(1e7);
    expect(e.record.status).toBe('warning');
    expect(e.text).toMatch(/your limit at least 10000000 h/);
    expect(short.warnings.some((w) => 'recordId' in w && w.recordId === e.record.id)).toBe(true);
    const long = run(
      withOverride(doc, { check: BEARING_LIFE_CHECK, inputs: { t_req: x('1200 h') } }),
    );
    const l = long.entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(l.record.status).toBe('ok');
    expect(l.record.margin).toBeGreaterThan(1000);
    expect(l.record.inputRefs.t_req).toEqual({ kind: 'override', id: 'chk#1' });
  });

  it('never calls anything safe, passing, failing, certified, compliant or OK', () => {
    const { doc } = trainer();
    const { data } = run(withFactors(doc, { strength: 20 }));
    const bearing = data.checks.filter((c) => c.record.check.startsWith('bearing.'));
    expect(bearing).toHaveLength(6);
    for (const { record, text } of bearing) {
      for (const s of [
        text,
        record.title,
        record.method,
        record.note ?? '',
        ...record.assumptions,
      ]) {
        expect(s, record.id).not.toMatch(WORDS);
      }
      expect(record.loadCase, record.id).toMatch(/^lc#\d+$/);
      expect(record.sources.length).toBeGreaterThan(0);
    }
  });
});

const bearingEntry = (ratings: CatalogEntry['ratings']): CatalogEntry => ({
  id: 'entry#1',
  version: 1,
  family: 'bearing',
  fieldsVersion: 2,
  maker: 'Textbook',
  partNumber: 'Example',
  description: 'A bearing from a worked example',
  ratings,
  sources: [],
  verified: true,
});

/** The trainer with its two bearings replaced by one user entry. */
function withEntry(ratings: CatalogEntry['ratings']): ManufaktureDocument {
  const { doc } = trainer();
  return apply(
    doc,
    { type: 'setCatalogEntry', entry: bearingEntry(ratings) },
    ...['pp#12', 'pp#13'].map((id): Command => ({
      type: 'setPurchasedUse',
      use: { id, entry: { source: 'document', id: 'entry#1' }, alternates: [] },
    })),
  );
}

describe('the textbook examples of T9.1d, through the checks', () => {
  it('Shigley 10th ed. Problem 11-21 (solutions manual): Fr 5 kN, Fa 2 kN, C0 10 kN gives Fe 5.34 kN', () => {
    const doc = withOverride(
      withEntry({
        type: { text: 'deep groove ball' },
        dynamicLoad: { value: 30000 },
        staticLoad: { value: 10000 },
        limitingSpeed: { value: 10000 * RPM },
      }),
      // Two bearings share the mean cable tension: 10 kN gives each 5 kN radial.
      { check: BEARING_LIFE_CHECK, inputs: { F_m: x('10 kN'), F_a: x('2 kN') } },
    );
    const e = run(doc).entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(derived(e, 'F_r')).toBeCloseTo(5000, 9);
    expect(derived(e, 'X')).toBe(0.56);
    expect(derived(e, 'Y')).toBeCloseTo(1.27, 2);
    expect(Math.abs(derived(e, 'P')! / 5340 - 1)).toBeLessThan(0.002);
  });

  it('Shigley 10th ed. Problem 11-3 (solutions manual): roller, C10 118 kN at 13.92 kN gives 1248 million revolutions', () => {
    const doc = withOverride(
      withEntry({
        type: { text: 'needle' },
        dynamicLoad: { value: 118000 },
        staticLoad: { value: 150000 },
        limitingSpeed: { value: 10000 * RPM },
      }),
      { check: BEARING_LIFE_CHECK, inputs: { F_m: x('27.84 kN') } },
    );
    const e = run(doc).entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(e.record.inputs.find((i) => i.symbol === 'p')!.value).toBeCloseTo(10 / 3, 12);
    expect(e.record.inputs.some((i) => i.symbol === 'F_a')).toBe(false);
    expect(Math.abs(derived(e, 'L10')! / 1248e6 - 1)).toBeLessThan(0.01);
  });

  it('Shigley 10th ed. Problem 11-39 (solutions manual): 18 kN for 8000 rev and 30 kN for 12 000 rev a 10 min cycle gives 3.76 h', () => {
    const Fm = cubicMeanLoad(
      [
        { load: 18000, revolutions: 8000 },
        { load: 30000, revolutions: 12000 },
      ],
      3,
    );
    const doc = withOverride(
      withEntry({
        type: { text: 'deep groove ball' },
        dynamicLoad: { value: 20300 },
        staticLoad: { value: 1e6 },
        limitingSpeed: { value: 10000 * RPM },
      }),
      {
        check: BEARING_LIFE_CHECK,
        inputs: { F_m: x(`${Fm} N`), k: x('1'), N_c: x('20000'), t_c: x('10 min') },
      },
    );
    const e = run(doc).entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(Math.abs(derived(e, 'L10')! / 451585 - 1)).toBeLessThan(0.001);
    expect(e.record.result).toBeCloseTo(3.76, 2);
  });

  it('closed-form check of T9.1d, not a textbook example: static factor with the deep-groove X0, Y0', () => {
    const doc = withOverride(
      withEntry({
        type: { text: 'deep groove ball' },
        dynamicLoad: { value: 20000 },
        staticLoad: { value: 10000 },
      }),
      { check: BEARING_STATIC_CHECK, inputs: { F: x('2 kN'), k: x('1'), F_a: x('3 kN') } },
    );
    const e = run(withFactors(doc, { strength: 2 })).entry(`${BEARING_STATIC_CHECK}@${FRONT}`);
    expect(derived(e, 'P₀')).toBeCloseTo(2700, 9);
    expect(e.record.result).toBeCloseTo(10 / 2.7, 9);
    expect(e.record.status).toBe('ok');
  });
});

describe('what the bearing checks gather', () => {
  it('averages a varying force law over the turns: eccentric, closed form', () => {
    let { doc } = trainer();
    doc = apply(doc, {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#1',
        name: 'Eccentric',
        dynamic: {
          mode: { kind: 'eccentric', factor: x('2') },
          force: x('1000 N'),
          motion: {
            kind: 'half-cosine',
            stroke: x('0.6 m'),
            pullSpeed: x('1.5 m/s'),
            returnSpeed: x('1.5 m/s'),
            pause: x('0.2 s'),
          },
          reps: x('9'),
        },
      },
    });
    const e = run(doc).entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    // The pull and the return turn the spool equally: F_m = ((1000³ + 2000³) / 2)^(1/3).
    expect(e.record.loadCase).toBe('lc#1');
    expect(e.record.inputs.find((i) => i.symbol === 'F_m')!.value).toBeCloseTo(
      ((1000 ** 3 + 2000 ** 3) / 2) ** (1 / 3),
      6,
    );
    expect(run(doc).entry(`${BEARING_STATIC_CHECK}@${FRONT}`).record.inputs[0]!.value).toBe(2000);
  });

  it('leaves a shaft before a reduction unknown, naming the share it needs', () => {
    const { doc } = trainer();
    const d = drivetrain(
      ['pp#13'],
      [
        { id: 'stage#3', kind: 'shaft', bearings: [{ use: 'pp#12' }] },
        { id: 'stage#4', kind: 'belt', ratio: x('5'), efficiency: x('0.95') },
      ],
    );
    const { entry } = run(apply(doc, { type: 'setDrivetrain', drivetrain: d }));
    const up = entry(`${BEARING_STATIC_CHECK}@drive#1/stage#3/pp#12`);
    expect(up.record.status).toBe('unknown');
    expect(up.record.note).toContain('not the spool');
    // Upstream of a 5:1 reduction the shaft turns five times as fast as the spool.
    expect(entry(`${BEARING_SPEED_CHECK}@drive#1/stage#3/pp#12`).record.result).toBeCloseTo(
      (5 * 3) / r3,
      6,
    );
    // The spool's own shaft, with one bearing, carries the whole pull.
    const own = entry(`${BEARING_STATIC_CHECK}@drive#1/stage#2/pp#13`);
    expect(own.record.result).toBeCloseTo(6600 / FORCE, 9);
    // An override of k makes it computable.
    const given = run(
      withOverride(apply(doc, { type: 'setDrivetrain', drivetrain: d }), {
        check: 'bearing.',
        subject: { kind: 'stage', drivetrain: 'drive#1', stage: 'stage#3' },
        inputs: { k: x('0.3') },
      }),
    ).entry(`${BEARING_STATIC_CHECK}@drive#1/stage#3/pp#12`);
    expect(given.record.result).toBeCloseTo(6600 / (0.3 * FORCE), 9);
  });

  it('names what is missing: a spool that does not wind, an entry with no type', () => {
    const { doc } = trainer();
    const noCore = drivetrain(['pp#12']);
    if (noCore.output.kind === 'spool') noCore.output = { ...noCore.output, core: x('0 mm') };
    const a = run(apply(doc, { type: 'setDrivetrain', drivetrain: noCore }));
    const life = a.entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(life.record.status).toBe('unknown');
    expect(life.record.note).toContain('has no winding');
    expect(a.warnings.some((w) => 'recordId' in w && w.recordId === life.record.id)).toBe(true);

    const untyped = withEntry({ dynamicLoad: { value: 13500 }, staticLoad: { value: 6600 } });
    const b = run(untyped);
    expect(b.entry(`${BEARING_LIFE_CHECK}@${FRONT}`).record.missing).toContain('Life exponent');
    expect(b.entry(`${BEARING_SPEED_CHECK}@${FRONT}`).record.missing).toEqual(['Limiting speed']);
  });

  it('makes no records without load cases, and none for a bushing', () => {
    const bare = apply(
      createDocument({ id: 'd', name: 'D' }),
      ...(
        [
          ['pp#10', 'motor/cubemars-ro100-kv55'],
          ['pp#11', 'rope/samson-amsteel-blue-3mm'],
          ['pp#12', 'bearing/skf-6204-2rsh'],
        ] as const
      ).map(([id, entry]): Command => ({
        type: 'setPurchasedUse',
        use: { id, entry: builtinRef(entry)!, alternates: [] },
      })),
      { type: 'setDrivetrain', drivetrain: drivetrain(['pp#12']) },
    );
    expect(run(bare).data.checks.filter((c) => c.record.check.startsWith('bearing.'))).toEqual([]);
    const bushing = withEntry({ type: { text: 'bushing' }, dynamicLoad: { value: 1000 } });
    expect(run(bushing).data.checks.filter((c) => c.record.check.startsWith('bearing.'))).toEqual(
      [],
    );
  });
});

describe('what the review asked for', () => {
  const lcOf = (doc: ManufaktureDocument, id: string) =>
    doc.mech!.loadCases!.find((l) => l.id === id)!;

  it('makes every record unknown, naming it, when one load case does not read beside readable ones', () => {
    const { doc, lc } = trainer();
    const full = lcOf(doc, lc[0]!);
    const broken = apply(doc, {
      type: 'setMechLoadCase',
      loadCase: { ...full, dynamic: { ...full.dynamic!, force: x('300 lbf * 2 m') } },
    });
    const { entry } = run(broken);
    for (const check of [BEARING_LIFE_CHECK, BEARING_STATIC_CHECK, BEARING_SPEED_CHECK]) {
      const e = entry(`${check}@${FRONT}`);
      expect(e.record.status, check).toBe('unknown');
      expect(e.record.result, check).toBeNull();
      expect(e.record.missing, check).toEqual([`Load case Full force rep (R6) (${lc[0]})`]);
      expect(e.record.note, check).toContain('does not read');
      // The readable cases still pick the one that would govern among them.
      expect(e.record.loadCase, check).not.toBe(lc[0]);
    }
  });

  it('makes the three records unknown, naming the entry, when a bearing entry does not resolve', () => {
    const { doc } = trainer();
    const lost = apply(doc, {
      type: 'setPurchasedUse',
      use: {
        id: 'pp#12',
        entry: { source: 'builtin', id: 'bearing/skf-9999', version: 1 },
        alternates: [],
        name: 'Front bearing',
      },
    });
    const { entry, warnings } = run(lost);
    for (const check of [BEARING_LIFE_CHECK, BEARING_STATIC_CHECK, BEARING_SPEED_CHECK]) {
      const e = entry(`${check}@${FRONT}`);
      expect(e.record.status, check).toBe('unknown');
      expect(e.record.missing, check).toEqual(['Catalog entry']);
      expect(e.record.note, check).toContain('bearing/skf-9999');
      expect(warnings.some((w) => 'recordId' in w && w.recordId === e.record.id)).toBe(true);
    }
    // The other bearing is read as before.
    expect(entry(`${BEARING_STATIC_CHECK}@${REAR}`).record.status).toBe('ok');
  });

  // Angular contact at 40 degrees, by hand (ISO 281 e = 1.14, X = 0.35, Y = 0.57; ISO 76
  // X0 = 0.5, Y0 = 0.26), with k = 1 and a mean (and largest) tension of 1000 N:
  //   F_a = 1000 N: F_a/F_r = 1.00, at most e: X = 1, Y = 0, P = 1000 N
  //   F_a = 2000 N: F_a/F_r = 2.00, above e: P = 0.35 · 1000 + 0.57 · 2000 = 1490 N
  //   static at F_a = 2000 N: P0 = max(0.5 · 1000 + 0.26 · 2000, 1000) = 1020 N
  const angular = (angle: number) =>
    withEntry({
      type: { text: 'angular contact' },
      dynamicLoad: { value: 8300 },
      staticLoad: { value: 4400 },
      limitingSpeed: { value: 24000 * RPM },
      contactAngle: { value: angle },
    });
  const loads = (doc: ManufaktureDocument, Fa: string) =>
    withOverride(doc, {
      check: 'bearing.',
      inputs: { F_m: x('1000 N'), F: x('1000 N'), k: x('1'), F_a: x(Fa) },
    });

  it('angular contact at 40 degrees: X = 1, Y = 0 at or below e, the table X and Y above it', () => {
    const below = run(loads(angular(40), '1000 N')).entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(below.record.status).toBe('ok');
    expect(derived(below, 'P')).toBeCloseTo(1000, 9);
    const above = run(loads(angular(40), '2000 N'));
    expect(derived(above.entry(`${BEARING_LIFE_CHECK}@${FRONT}`), 'P')).toBeCloseTo(1490, 9);
    const s = above.entry(`${BEARING_STATIC_CHECK}@${FRONT}`);
    expect(derived(s, 'P₀')).toBeCloseTo(1020, 9);
    expect(s.record.result).toBeCloseTo(4400 / 1020, 9);
  });

  it('angular contact at 25 degrees: unknown, naming X, Y and e (and X0, Y0)', () => {
    const r = run(loads(angular(25), '500 N'));
    const life = r.entry(`${BEARING_LIFE_CHECK}@${FRONT}`);
    expect(life.record.status).toBe('unknown');
    expect(life.record.missing).toEqual(['Radial factor', 'Axial factor', 'Limit ratio']);
    expect(life.record.note).toContain('40 degree');
    expect(r.entry(`${BEARING_STATIC_CHECK}@${FRONT}`).record.missing).toEqual([
      'Static radial factor',
      'Static axial factor',
    ]);
  });

  it('needle static factor: P0 = F_r, no axial input', () => {
    const doc = withOverride(
      withEntry({
        type: { text: 'needle' },
        dynamicLoad: { value: 7600 },
        staticLoad: { value: 9700 },
      }),
      { check: BEARING_STATIC_CHECK, inputs: { F: x('2 kN'), k: x('0.5') } },
    );
    const e = run(doc).entry(`${BEARING_STATIC_CHECK}@${FRONT}`);
    expect(e.record.inputs.some((i) => i.symbol === 'F_a' && i.source.includes('override'))).toBe(
      false,
    );
    expect(derived(e, 'P₀')).toBeCloseTo(1000, 9);
    expect(e.record.result).toBeCloseTo(9.7, 9);
  });

  it('static factor of an entry with no type: unknown, naming X0 and Y0', () => {
    const e = run(withEntry({ dynamicLoad: { value: 13500 }, staticLoad: { value: 6600 } })).entry(
      `${BEARING_STATIC_CHECK}@${FRONT}`,
    );
    expect(e.record.status).toBe('unknown');
    expect(e.record.missing).toEqual(['Static radial factor', 'Static axial factor']);
    expect(e.record.note).toContain('gives no bearing type');
  });
});
