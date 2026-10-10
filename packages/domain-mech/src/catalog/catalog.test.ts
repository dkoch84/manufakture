import {
  CatalogEntrySchema,
  applyCommand,
  createDocument,
  type CatalogEntry,
  type DisplayUnits,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ENTRIES,
  builtinRef,
  copyBuiltin,
  latestBuiltin,
  resolveEntry,
} from '../parts/catalog';
import { importCatalogCsv } from '../parts/csv';
import { entryFields, readEntryFields } from '../parts/entry';
import {
  KT_CONVENTIONS,
  KV_CONVENTIONS,
  entryProblems,
  familySchema,
  migrateEntry,
  ratingField,
} from '../parts/families';
import { readRating } from '../parts/input';
import { CONTROLLER_ENTRIES, FAMILY_CATALOG_ENTRIES, MOTOR_ENTRIES } from './index';
import {
  KT_KV_PRODUCT,
  SIX_STEP_TO_FOC,
  motorInductance,
  motorResistance,
  motorTorqueConstant,
  motorVelocityConstant,
  type MotorRatings,
} from './conventions';

const SI: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const rpm = (v: number) => (v * 2 * Math.PI) / 60;
const asUser = (e: (typeof BUILTIN_ENTRIES)[number]): CatalogEntry => {
  const rest: Partial<typeof e> = { ...e };
  delete rest.deprecated;
  return { ...rest, id: 'entry#1' } as CatalogEntry;
};
const motor = (ratings: CatalogEntry['ratings']): MotorRatings => ({ family: 'motor', ratings });
const value = (r: ReturnType<typeof motorTorqueConstant>) => (r.ok ? r.value : NaN);

describe('the motor and controller catalogs', () => {
  it('hold several motors and several controllers, in BUILTIN_ENTRIES, sorted', () => {
    expect(MOTOR_ENTRIES.length).toBeGreaterThanOrEqual(5);
    expect(CONTROLLER_ENTRIES.length).toBeGreaterThanOrEqual(3);
    for (const e of FAMILY_CATALOG_ENTRIES) expect(BUILTIN_ENTRIES).toContain(e);
    const keys = BUILTIN_ENTRIES.map((e) => `${e.id} ${e.version}`);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MOTOR_ENTRIES.every((e) => e.family === 'motor')).toBe(true);
    expect(CONTROLLER_ENTRIES.every((e) => e.family === 'controller')).toBe(true);
  });

  it('are valid, unverified, sourced over http or https, at the current fields version', () => {
    for (const e of FAMILY_CATALOG_ENTRIES) {
      const user = asUser(e);
      const parsed = CatalogEntrySchema.safeParse(user);
      expect(parsed.success, `${e.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(entryProblems(user), e.id).toEqual([]);
      expect(e.verified, e.id).toBe(false);
      expect(e.sources.length, e.id).toBeGreaterThan(0);
      for (const s of e.sources) {
        expect(s.url, e.id).toMatch(/^https?:\/\//);
        expect(s.read, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(e.fieldsVersion, e.id).toBe(familySchema(e.family).fieldsVersion);
    }
  });

  it('name the convention of every Kv, Kt, R and L they give', () => {
    for (const e of MOTOR_ENTRIES) {
      for (const name of ['kv', 'kt', 'resistance', 'inductance']) {
        const r = e.ratings[name];
        if (r !== undefined && 'value' in r) expect(r.convention, `${e.id}.${name}`).toBeDefined();
      }
    }
  });

  it('never call a part safe, certified or compliant', () => {
    const text = JSON.stringify(FAMILY_CATALOG_ENTRIES).toLowerCase();
    for (const word of ['safe', 'certif', 'complian']) expect(text).not.toContain(word);
  });

  it('give every motor a Kt in the internal convention, and every R and L given', () => {
    for (const e of MOTOR_ENTRIES) {
      const kt = motorTorqueConstant(e);
      expect(kt.ok, `${e.id}: ${!kt.ok && kt.message}`).toBe(true);
      if (e.ratings.resistance && 'value' in e.ratings.resistance) {
        expect(motorResistance(e).ok, e.id).toBe(true);
      }
      if (e.ratings.inductance && 'value' in e.ratings.inductance) {
        expect(motorInductance(e).ok, e.id).toBe(true);
      }
    }
  });

  it('resolve by reference at a pinned version, ratings in SI', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    const ref = builtinRef('motor/odrive-d6374-150kv')!;
    expect(ref).toEqual({ source: 'builtin', id: 'motor/odrive-d6374-150kv', version: 1 });
    const r = resolveEntry(doc, ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.ratings.kv).toEqual({
      value: rpm(150),
      convention: 'line-to-line amplitude',
    });
    const s1 = resolveEntry(doc, builtinRef('controller/odrive-s1')!);
    expect(s1.ok && s1.entry.ratings.maxBusVoltage).toEqual({ value: 50.5 });
  });

  it('copy into a user entry that round-trips through the datasheet form', () => {
    for (const e of FAMILY_CATALOG_ENTRIES) {
      const copy = copyBuiltin(latestBuiltin(e.id)!, 'entry#4');
      const again = readEntryFields(entryFields(copy), 'entry#4', SI, {
        derivedFrom: copy.derivedFrom!,
      });
      expect(again.ok, `${e.id}: ${JSON.stringify(!again.ok && again.problems)}`).toBe(true);
      if (!again.ok) continue;
      expect(Object.keys(again.entry.ratings).sort(), e.id).toEqual(
        Object.keys(copy.ratings).sort(),
      );
      for (const [name, r] of Object.entries(copy.ratings)) {
        const back = again.entry.ratings[name]!;
        if ('value' in r && 'value' in back) {
          expect(back.value, `${e.id}.${name}`).toBeCloseTo(r.value, 9);
          expect(back.convention, `${e.id}.${name}`).toBe(r.convention);
          expect(back.basis, `${e.id}.${name}`).toBe(r.basis);
        } else expect(back, `${e.id}.${name}`).toEqual(r);
      }
    }
  });
});

describe('conventions are required for Kv, Kt, R and L (decision 8)', () => {
  const d6374 = asUser(latestBuiltin('motor/odrive-d6374-150kv')!);

  it('refuses a value with no convention, naming the field', () => {
    for (const name of ['kv', 'kt', 'resistance', 'inductance']) {
      const r = d6374.ratings[name]!;
      const bare = 'value' in r ? { value: r.value } : r;
      const problems = entryProblems({ ...d6374, ratings: { ...d6374.ratings, [name]: bare } });
      expect(problems, name).toEqual([
        { field: `${name}.convention`, message: expect.stringMatching(/needs its convention/) },
      ]);
    }
  });

  it('accepts an unknown value without one, and refuses one outside the list', () => {
    expect(
      entryProblems({ ...d6374, ratings: { ...d6374.ratings, kt: { unknown: true } } }),
    ).toEqual([]);
    expect(
      entryProblems({
        ...d6374,
        ratings: { ...d6374.ratings, resistance: { value: 0.039, convention: 'line to centre' } },
      }),
    ).toMatchObject([{ field: 'resistance' }]);
  });

  it('refuses an output-side constant with no gear ratio, and takes one with it', () => {
    const geared = (ratings: CatalogEntry['ratings']) =>
      entryProblems({ ...d6374, ratings: { ...d6374.ratings, ...ratings } });
    const outKt = { kt: { value: 0.855, convention: 'phase amplitude, output side' } };
    expect(geared(outKt)).toEqual([
      { field: 'ratio', message: expect.stringMatching(/output side, so the gear ratio/) },
    ]);
    expect(geared({ ...outKt, ratio: { unknown: true } })).toMatchObject([{ field: 'ratio' }]);
    expect(geared({ ...outKt, ratio: { value: 9 } })).toEqual([]);
  });

  it('keeps a gear ratio above zero, efficiency in (0, 1] and backlash not below zero', () => {
    const with_ = (ratings: CatalogEntry['ratings']) =>
      entryProblems({ ...d6374, ratings: { ...d6374.ratings, ...ratings } });
    expect(
      with_({ ratio: { value: 9 }, gearEfficiency: { value: 1 }, backlash: { value: 0 } }),
    ).toEqual([]);
    expect(with_({ ratio: { value: 0 } })).toEqual([
      { field: 'ratio', message: expect.stringMatching(/must be above zero/) },
    ]);
    expect(with_({ ratio: { value: -9 } })).toMatchObject([{ field: 'ratio' }]);
    for (const e of [0, -0.1, 1.01]) {
      expect(with_({ gearEfficiency: { value: e } }), String(e)).toMatchObject([
        { field: 'gearEfficiency' },
      ]);
    }
    expect(with_({ backlash: { value: -1 } })).toMatchObject([{ field: 'backlash' }]);
  });

  it('asks for no convention on fields that have none', () => {
    expect(
      entryProblems({ ...d6374, ratings: { ...d6374.ratings, polePairs: { value: 7 } } }),
    ).toEqual([]);
  });

  it('refuses a datasheet form or CSV row without one, and takes it with one', () => {
    const fields = {
      family: 'motor',
      maker: 'Acme',
      partNumber: 'M1',
      kv: '150 rpm/V',
      resistance: '39 mohm',
      'resistance.convention': 'Phase-Neutral',
    };
    const without = readEntryFields(fields, 'entry#1', SI);
    expect(without).toMatchObject({ ok: false, problems: [{ column: 'kv.convention' }] });
    const withIt = readEntryFields(
      { ...fields, 'kv.convention': 'line-to-line amplitude' },
      'entry#1',
      SI,
    );
    expect(withIt.ok, JSON.stringify(!withIt.ok && withIt.problems)).toBe(true);
    expect(withIt.ok && withIt.entry.ratings.resistance).toEqual({
      value: 0.039,
      convention: 'phase-neutral',
    });

    const header = 'family,maker,partNumber,kt,kt.convention,sourceTitle,sourceRead';
    const doc = createDocument({ id: 'd', name: 'D' });
    const bad = importCatalogCsv(doc, `${header}\nmotor,Acme,M2,0.05 N*m/A,,Sheet,2026-10-10\n`, {
      units: SI,
    });
    expect(bad.ok).toBe(false);
    const good = importCatalogCsv(
      doc,
      `${header}\nmotor,Acme,M2,0.05 N*m/A,phase rms,Sheet,2026-10-10\n`,
      { units: SI },
    );
    expect(good.ok).toBe(true);
  });
});

describe('typing each motor and controller field in', () => {
  // A datasheet value with its unit for every number field, and the SI value it must read as.
  const MOTOR: Record<string, [string, number]> = {
    kv: ['150 rpm/V', rpm(150)],
    kt: ['0.055 N*m/A', 0.055],
    resistance: ['39 mohm', 0.039],
    inductance: ['24 uH', 24e-6],
    polePairs: ['7', 7],
    ratedCurrent: ['50 A', 50],
    peakCurrent: ['90 A', 90],
    ratedTorque: ['0.387 N*m', 0.387],
    peakTorque: ['22 N*m', 22],
    noLoadSpeed: ['3190 rpm', rpm(3190)],
    ratedSpeed: ['2650 rpm', rpm(2650)],
    maxVoltage: ['48 V', 48],
    rotorInertia: ['3060 g*cm^2', 3060e-7],
    thermalResistance: ['4.88 K/W', 4.88],
    thermalTimeConstant: ['52.6 s', 52.6],
    maxWindingTemperature: ['125 degC', 398.15],
    windingHousingResistance: ['2.99 K/W', 2.99],
    housingTimeConstant: ['281 s', 281],
    noLoadCurrent: ['539 mA', 0.539],
    dragTorque: ['30 N*mm', 0.03],
    viscousDrag: ['0.0001', 1e-4],
    cogging: ['55 N*mm', 0.055],
    ratio: ['9', 9],
    gearEfficiency: ['0.88', 0.88],
    backlash: ['15', 15],
  };
  const CONTROLLER: Record<string, [string, number]> = {
    minBusVoltage: ['12 V', 12],
    maxBusVoltage: ['50.5 V', 50.5],
    continuousPhaseCurrent: ['40 A', 40],
    peakPhaseCurrent: ['100 A', 100],
    busCurrentLimit: ['30 A', 30],
    loopRate: ['8 kHz', 8000],
    pwmFrequency: ['24 kHz', 24000],
    maxElectricalFrequency: ['2 kHz', 2000],
    continuousPower: ['2 kW', 2000],
    peakPower: ['5000 W', 5000],
    chopperCurrent: ['20 A', 20],
    minBrakeResistance: ['2 ohm', 2],
    minOperatingTemperature: ['-40 degC', 233.15],
    maxOperatingTemperature: ['85 degC', 358.15],
    fixedLoss: ['1.5 W', 1.5],
    legResistance: ['4 mohm', 0.004],
    switchingTime: ['1e-7 s', 1e-7],
  };

  for (const [family, table] of [
    ['motor', MOTOR],
    ['controller', CONTROLLER],
  ] as const) {
    it(`covers every ${family} number field`, () => {
      const numbers = familySchema(family)
        .fields.filter((f) => f.kind !== 'text')
        .map((f) => f.name);
      expect(Object.keys(table).sort()).toEqual([...numbers].sort());
    });

    it(`reads each ${family} field in its unit, and refuses the wrong kind`, () => {
      for (const [name, [text, si]] of Object.entries(table)) {
        const field = ratingField(family, name)!;
        const r = readRating(field, text, SI);
        expect(r.ok, `${name}: ${!r.ok && r.message}`).toBe(true);
        const v = r.ok && r.value && 'value' in r.value ? r.value.value : NaN;
        expect(v / si, name).toBeCloseTo(1, 9);
        if (field.kind !== 'number' && field.kind !== 'count') {
          expect(readRating(field, '3 kg', SI).ok, name).toBe(false);
        }
      }
    });
  }

  it('reads the text fields and their choices', () => {
    const regen = ratingField('controller', 'regeneration')!;
    expect(readRating(regen, 'Chopper Output', SI)).toEqual({
      ok: true,
      value: { text: 'chopper output' },
    });
    expect(readRating(regen, 'into the void', SI).ok).toBe(false);
    const feedback = ratingField('controller', 'feedback')!;
    expect(readRating(feedback, 'Hall, SPI', SI)).toEqual({
      ok: true,
      value: { text: 'Hall, SPI' },
    });
    const sensors = ratingField('motor', 'sensors')!;
    expect(readRating(sensors, 'NTC 10k', SI).ok).toBe(true);
  });

  it('offers every base convention at the output side too', () => {
    expect(KV_CONVENTIONS).toContain('dc (six-step), output side');
    expect(KT_CONVENTIONS).toContain('phase rms, output side');
    expect(KT_CONVENTIONS.length).toBe(6);
    expect(KV_CONVENTIONS.length).toBe(8);
  });
});

describe('older motor and controller entries', () => {
  it('migrate from fields version 1 in memory, ratings unchanged', () => {
    const v1: CatalogEntry = {
      id: 'entry#1',
      version: 1,
      family: 'motor',
      fieldsVersion: 1,
      maker: 'A',
      partNumber: 'B',
      description: '',
      ratings: { kt: { value: 0.05, convention: 'phase amplitude' }, polePairs: { value: 7 } },
      sources: [],
      verified: false,
    };
    const m = migrateEntry(v1);
    expect(m).toEqual({ ok: true, entry: { ...v1, fieldsVersion: 2 } });
    expect(migrateEntry({ ...v1, family: 'controller', ratings: {} })).toMatchObject({
      ok: true,
      entry: { fieldsVersion: 2 },
    });
    // A version 1 user motor could hold a Kt with no convention: it still resolves, but the
    // normaliser refuses to read it rather than guess.
    const bare: CatalogEntry = { ...v1, ratings: { kt: { value: 0.05 } } };
    const set = applyCommand(createDocument({ id: 'd', name: 'D' }), {
      type: 'setCatalogEntry',
      entry: bare,
    });
    if (!set.ok) throw new Error(set.error.message);
    const r = resolveEntry(set.value.document, { source: 'document', id: 'entry#1' });
    expect(r).toMatchObject({ ok: true, entry: { fieldsVersion: 2, ratings: bare.ratings } });
    expect(motorTorqueConstant(bare)).toMatchObject({ ok: false, missing: ['kt.convention'] });
    expect(migrateEntry({ ...v1, fieldsVersion: 3 })).toMatchObject({
      ok: false,
      reason: 'newer-fields',
    });
  });
});

describe('normalising motor constants (decision 8)', () => {
  it('has the factors the ADR states', () => {
    expect(KT_KV_PRODUCT).toBeCloseTo(8.27, 2);
    expect(SIX_STEP_TO_FOC).toBeCloseTo(0.907, 3);
  });

  it("derives Kt from Kv line-to-line amplitude as ODrive's whole table does", () => {
    // Published pairs (ODrive docs): Kv rpm/V and Kt N*m/A of phase amplitude.
    for (const [kv, kt] of [
      [150, 0.055],
      [270, 0.031],
      [100, 0.083],
      [8.7, 0.951],
      [330, 0.025],
    ] as const) {
      const r = motorTorqueConstant(
        motor({ kv: { value: rpm(kv), convention: 'line-to-line amplitude' } }),
      );
      expect(r.ok && r.derived).toBe(true);
      expect(Math.abs(value(r) / kt - 1), `Kv ${kv}`).toBeLessThan(0.02);
    }
    const r = motorTorqueConstant(MOTOR_ENTRIES.find((e) => e.id === 'motor/mjbots-mj5208')!);
    expect(r).toMatchObject({ ok: true, derived: true, estimated: true });
    expect(r.ok && r.derivation).toMatch(/derived from Kv 330 rpm\/V/);
  });

  it("converts maxon's six-step DC constants, which agree with each other", () => {
    // Published pairs (maxon EC 90 flat, April 2006): 135 rpm/V with 70.5 mN*m/A (323772) and
    // 44.0 rpm/V with 217 mN*m/A (244879), both DC. A DC machine has k = 1 / Kv in SI.
    for (const [kv, kt] of [
      [135, 0.0705],
      [44.0, 0.217],
    ] as const) {
      expect(Math.abs(1 / rpm(kv) / kt - 1)).toBeLessThan(0.004);
      const fromKt = motorTorqueConstant(motor({ kt: { value: kt, convention: 'dc (six-step)' } }));
      const fromKv = motorTorqueConstant(
        motor({ kv: { value: rpm(kv), convention: 'dc (six-step)' } }),
      );
      expect(value(fromKt)).toBeCloseTo(kt * SIX_STEP_TO_FOC, 12);
      expect(Math.abs(value(fromKv) / value(fromKt) - 1), `Kv ${kv}`).toBeLessThan(0.004);
      const kvAmp = motorVelocityConstant(
        motor({ kv: { value: rpm(kv), convention: 'dc (six-step)' } }),
      );
      expect(kvAmp.ok && kvAmp.value).toBeCloseTo((rpm(kv) * 3) / Math.PI, 12);
    }
    const maxon = MOTOR_ENTRIES.find((e) => e.id === 'motor/maxon-ec90-flat-323772')!;
    const kt = motorTorqueConstant(maxon);
    expect(kt).toMatchObject({ ok: true });
    expect(kt.ok && kt.derived).toBeUndefined();
    expect(kt.ok && kt.derivation).toBe(
      'Kt 0.06394 N*m/A (phase amplitude, motor side) from Kt 0.0705 N*m/A dc (six-step), six-step DC x pi / (2 sqrt(3)) = x 0.9069',
    );
  });

  it('converts RMS and peak-to-peak definitions to the same amplitude constants', () => {
    // The sinusoidal-servo rule Kt [N*m/A rms] = 0.01654 x Ke [V rms line to line / krpm]
    // follows from the same factor: Kt_rms = sqrt(2) x 8.27 / Kv_amp and Kv_rms = sqrt(2) x Kv_amp.
    const ke = 23; // V rms per krpm, line to line
    const kvRms = 1000 / ke;
    const ktRms = 0.01654 * ke;
    const viaKv = motorTorqueConstant(
      motor({ kv: { value: rpm(kvRms), convention: 'line-to-line rms' } }),
    );
    const viaKt = motorTorqueConstant(motor({ kt: { value: ktRms, convention: 'phase rms' } }));
    expect(Math.abs(value(viaKv) / value(viaKt) - 1)).toBeLessThan(0.001);
    expect(value(viaKt)).toBeCloseTo(ktRms / Math.SQRT2, 12);
    // mjbots' peak-to-peak Kv is half the amplitude one: 75 pp is ODrive's 150.
    const pp = motorVelocityConstant(
      motor({ kv: { value: rpm(75), convention: 'line-to-line peak-to-peak' } }),
    );
    expect(pp.ok && pp.value).toBeCloseTo(rpm(150), 12);
  });

  it('moves output-side constants of a geared actuator to the motor', () => {
    const out = motorTorqueConstant(
      motor({
        kt: { value: 0.855, convention: 'phase amplitude, output side' },
        ratio: { value: 9 },
      }),
    );
    expect(value(out)).toBeCloseTo(0.095, 12);
    expect(out.ok && out.derivation).toMatch(/output side \/ ratio 9/);
    const kv = motorVelocityConstant(
      motor({
        kv: { value: rpm(100 / 9), convention: 'line-to-line amplitude, output side' },
        ratio: { value: 9 },
      }),
    );
    expect(kv.ok && kv.value).toBeCloseTo(rpm(100), 12);
    const noRatio = motorTorqueConstant(
      motor({ kt: { value: 0.855, convention: 'phase rms, output side' } }),
    );
    expect(noRatio).toMatchObject({ ok: false, missing: ['ratio'] });
  });

  it('converts resistance and inductance to the equivalent wye phase value', () => {
    // CubeMars AK80-9: delta winding, 160 mOhm phase to phase. One delta winding is 1.5 x the
    // line-to-line value, and both routes give the same equivalent phase resistance.
    const ll = motorResistance(motor({ resistance: { value: 0.16, convention: 'line-to-line' } }));
    const winding = motorResistance(
      motor({ resistance: { value: 0.24, convention: 'delta winding' } }),
    );
    expect(value(ll)).toBeCloseTo(0.08, 12);
    expect(value(winding)).toBeCloseTo(0.08, 12);
    expect(ll.ok && ll.derivation).toBe(
      'R 0.08 ohm (equivalent wye, phase to neutral) from R 0.16 ohm line-to-line, line to line / 2',
    );
    const pn = motorInductance(
      motor({ inductance: { value: 24e-6, convention: 'phase-neutral' } }),
    );
    expect(value(pn)).toBeCloseTo(24e-6, 15);
    // The spike's factor of two: 0.08 ohm line to line is 119 W at 44.5 A, not 237 W.
    expect(
      1.5 *
        value(motorResistance(motor({ resistance: { value: 0.08, convention: 'line-to-line' } }))) *
        44.5 ** 2,
    ).toBeCloseTo(118.8, 0);
  });

  it('refuses rather than guesses: no convention, nothing given, another family', () => {
    expect(motorTorqueConstant(motor({ kt: { value: 0.05 } }))).toMatchObject({
      ok: false,
      missing: ['kt.convention'],
    });
    expect(motorTorqueConstant(motor({}))).toMatchObject({ ok: false, missing: ['kt', 'kv'] });
    expect(
      motorTorqueConstant(motor({ kt: { unknown: true }, kv: { unknown: true } })),
    ).toMatchObject({ ok: false, missing: ['kt', 'kv'] });
    const strange = motorTorqueConstant(motor({ kt: { value: 0.05, convention: 'per volt' } }));
    expect(strange).toMatchObject({ ok: false, missing: ['kt.convention'] });
    expect(!strange.ok && strange.message).toMatch(/"per volt", which is not a known convention/);
    expect(
      motorTorqueConstant(
        motor({ kt: { value: 1, convention: 'phase rms, output side' }, ratio: { value: 0 } }),
      ),
    ).toMatchObject({
      ok: false,
      missing: ['ratio'],
      message: 'the gear ratio must be above zero',
    });
    expect(motorResistance(motor({ resistance: { value: 1 } }))).toMatchObject({
      ok: false,
      missing: ['resistance.convention'],
    });
    expect(motorInductance(motor({}))).toMatchObject({ ok: false, missing: ['inductance'] });
    expect(
      motorTorqueConstant({ family: 'controller', ratings: { kt: { value: 1 } } }),
    ).toMatchObject({ ok: false, missing: [] });
  });

  it('carries an estimate through', () => {
    const r = motorResistance(
      motor({ resistance: { value: 0.047, convention: 'phase-neutral', estimated: true } }),
    );
    expect(r).toMatchObject({ ok: true, value: 0.047, estimated: true });
  });
});
