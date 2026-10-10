import { CatalogEntrySchema, type CatalogEntry, type DisplayUnits } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { latestBuiltin } from '../parts/catalog';
import { entryProblems, familySchema, migrateEntry, ratingField } from '../parts/families';
import { readRating } from '../parts/input';
import {
  BMS_ENTRIES,
  CELL_ENTRIES,
  FAMILY_CATALOG_ENTRIES,
  GENERIC_OCV,
  OCV_SOC_PERCENT,
  buildPack,
  cellOcvCurve,
  ocvAt,
  ocvField,
  packRatings,
  type CellRatings,
  type Pack,
} from './index';

const SI: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const ah = (v: number) => v * 3600;
const wh = (v: number) => v * 3600;
const degC = (v: number) => v + 273.15;

const p45b = latestBuiltin('cell/molicel-inr-21700-p45b')!;
const asUser = (e: (typeof CELL_ENTRIES)[number]): CatalogEntry => {
  const rest: Partial<typeof e> = { ...e };
  delete rest.deprecated;
  return { ...rest, id: 'entry#1' } as CatalogEntry;
};
const cell = (ratings: CatalogEntry['ratings'], mass?: number): CellRatings => ({
  family: 'cell',
  ratings,
  ...(mass === undefined ? {} : { mass: { value: mass } }),
});
const v = (r: Pack[keyof Pack]) =>
  typeof r === 'object' && 'ok' in r && r.ok && 'value' in r ? r.value : NaN;
const built = (c: CellRatings, spec: Parameters<typeof buildPack>[1]): Pack => {
  const r = buildPack(c, spec);
  if (!r.ok) throw new Error(r.message);
  return r.pack;
};

describe('the cell and BMS catalogs', () => {
  it('hold several cells and BMS boards in the family catalogs, all unverified and sourced', () => {
    expect(CELL_ENTRIES.length).toBeGreaterThanOrEqual(5);
    expect(BMS_ENTRIES.length).toBeGreaterThanOrEqual(2);
    expect(CELL_ENTRIES.every((e) => e.family === 'cell')).toBe(true);
    expect(BMS_ENTRIES.every((e) => e.family === 'bms')).toBe(true);
    for (const e of [...CELL_ENTRIES, ...BMS_ENTRIES]) {
      expect(FAMILY_CATALOG_ENTRIES).toContain(e);
      expect(e.verified, e.id).toBe(false);
      expect(e.sources.length, e.id).toBeGreaterThan(0);
      expect(entryProblems(asUser(e)), e.id).toEqual([]);
      expect(CatalogEntrySchema.safeParse(asUser(e)).success, e.id).toBe(true);
    }
  });

  it('give every cell the fields a pack and the thermal checks read', () => {
    for (const e of CELL_ENTRIES) {
      for (const name of [
        'chemistry',
        'capacity',
        'nominalVoltage',
        'chargeVoltage',
        'cutoffVoltage',
        'continuousDischarge',
        'specificHeatCapacity',
      ]) {
        const r = e.ratings[name];
        expect(r !== undefined && !('unknown' in r), `${e.id}.${name}`).toBe(true);
      }
      expect(e.mass !== undefined && 'value' in e.mass, e.id).toBe(true);
      // No maker publishes an OCV table: every built-in cell falls back to a generic curve.
      expect(cellOcvCurve(e)).toMatchObject({ ok: true, generic: true });
    }
  });

  it('include an LFP cell and a small high-rate cell that reaches 16S under 100 Wh', () => {
    expect(
      CELL_ENTRIES.some(
        (e) => 'text' in e.ratings.chemistry! && e.ratings.chemistry.text === 'LFP',
      ),
    ).toBe(true);
    const small = CELL_ENTRIES.filter((e) => {
      const pack = built(e, { series: 16, parallel: 1 });
      return pack.energy.ok && pack.energy.value < wh(100);
    });
    expect(small.map((e) => e.id)).toContain('cell/murata-us18650vtc3');
  });
});

describe('typing each cell, pack and BMS field in', () => {
  const CELL: Record<string, [string, number]> = {
    capacity: ['4.5 Ah', ah(4.5)],
    nominalVoltage: ['3.6 V', 3.6],
    chargeVoltage: ['4.2 V', 4.2],
    cutoffVoltage: ['2500 mV', 2.5],
    maxChargeCurrent: ['13.5 A', 13.5],
    continuousDischarge: ['45 A', 45],
    resistanceDC: ['15 mohm', 0.015],
    minimumCapacity: ['4300 mAh', ah(4.3)],
    energy: ['16.2 Wh', wh(16.2)],
    standardChargeCurrent: ['4.5 A', 4.5],
    peakDischarge: ['120 A', 120],
    impedanceAC: ['7 mohm', 0.007],
    minChargeTemperature: ['0 degC', degC(0)],
    maxChargeTemperature: ['60 degC', degC(60)],
    minDischargeTemperature: ['-40 degC', degC(-40)],
    maxDischargeTemperature: ['60 degC', degC(60)],
    specificHeatCapacity: ['900', 900],
    cycleLife: ['1000', 1000],
    ...Object.fromEntries(
      OCV_SOC_PERCENT.map((p) => [ocvField(p), ['3.7 V', 3.7] as [string, number]]),
    ),
  };
  const PACK: Record<string, [string, number]> = {
    series: ['16', 16],
    parallel: ['1', 1],
    nominalVoltage: ['57.6 V', 57.6],
    capacity: ['1.7 Ah', ah(1.7)],
    energy: ['97.9 Wh', wh(97.9)],
    continuousDischarge: ['30 A', 30],
    fullVoltage: ['67.2 V', 67.2],
    emptyVoltage: ['40 V', 40],
    resistance: ['0.25 ohm', 0.25],
    interconnectResistance: ['7.5 mohm', 0.0075],
    peakDischarge: ['60 A', 60],
    maxChargeCurrent: ['5 A', 5],
  };
  const BMS: Record<string, [string, number]> = {
    minCells: ['16', 16],
    maxCells: ['16', 16],
    continuousDischarge: ['30 A', 30],
    continuousCharge: ['15 A', 15],
    balanceCurrent: ['35 mA', 0.035],
    standbyCurrent: ['0.1 mA', 1e-4],
    peakDischarge: ['120 A', 120],
    overchargeVoltage: ['4.25 V', 4.25],
    overdischargeVoltage: ['2.7 V', 2.7],
    shortCircuitDelay: ['0.3 ms', 3e-4],
    minOperatingTemperature: ['-20 degC', degC(-20)],
    maxOperatingTemperature: ['70 degC', degC(70)],
  };

  for (const [family, table] of [
    ['cell', CELL],
    ['pack', PACK],
    ['bms', BMS],
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
        const got = r.ok && r.value && 'value' in r.value ? r.value.value : NaN;
        expect(got / si, name).toBeCloseTo(1, 9);
        if (field.kind !== 'number' && field.kind !== 'count') {
          expect(readRating(field, '3 kg', SI).ok, name).toBe(false);
        }
      }
    });
  }

  it('reads the choices', () => {
    expect(readRating(ratingField('cell', 'chemistry')!, 'lfp', SI)).toEqual({
      ok: true,
      value: { text: 'LFP' },
    });
    expect(readRating(ratingField('cell', 'chemistry')!, 'lead acid', SI).ok).toBe(false);
    expect(readRating(ratingField('bms', 'chemistry')!, 'Configurable', SI)).toEqual({
      ok: true,
      value: { text: 'configurable' },
    });
    expect(readRating(ratingField('bms', 'balancing')!, 'active', SI).ok).toBe(true);
  });
});

describe('checking cell, pack and BMS entries', () => {
  const user = asUser(p45b);
  const withRatings = (ratings: CatalogEntry['ratings'], base = user) =>
    entryProblems({ ...base, ratings: { ...base.ratings, ...ratings } });

  it('refuses voltages, capacities, currents and temperature windows out of order', () => {
    expect(withRatings({ cutoffVoltage: { value: 3.7 } })).toEqual([
      { field: 'nominalVoltage', message: 'nominal voltage is below the cutoff voltage' },
    ]);
    expect(withRatings({ chargeVoltage: { value: 3.5 } })).toMatchObject([
      { field: 'chargeVoltage' },
    ]);
    expect(withRatings({ minimumCapacity: { value: ah(4.6) } })).toMatchObject([
      { field: 'capacity' },
    ]);
    expect(withRatings({ standardChargeCurrent: { value: 20 } })).toMatchObject([
      { field: 'maxChargeCurrent' },
    ]);
    expect(withRatings({ peakDischarge: { value: 40 } })).toMatchObject([
      { field: 'peakDischarge' },
    ]);
    expect(withRatings({ minChargeTemperature: { value: degC(70) } })).toMatchObject([
      { field: 'maxChargeTemperature' },
    ]);
    // Equal is fine, and an unknown side is not compared.
    expect(withRatings({ peakDischarge: { value: 45 }, cutoffVoltage: { unknown: true } })).toEqual(
      [],
    );
  });

  it('refuses a cutoff above the maximum voltage, and OCV ends outside the voltage range', () => {
    expect(
      withRatings({ cutoffVoltage: { value: 4.3 }, nominalVoltage: { unknown: true } }),
    ).toEqual([
      { field: 'chargeVoltage', message: 'maximum (charge) voltage is below the cutoff voltage' },
    ]);
    expect(withRatings({ ocv0: { value: 2.4 }, ocv100: { value: 4.19 } })).toMatchObject([
      { field: 'ocv0' },
    ]);
    expect(withRatings({ ocv0: { value: 3.0 }, ocv100: { value: 4.25 } })).toMatchObject([
      { field: 'chargeVoltage' },
    ]);
    expect(withRatings({ ocv0: { value: 2.5 }, ocv100: { value: 4.2 } })).toEqual([]);
    const pack: CatalogEntry = {
      ...user,
      family: 'pack',
      ratings: { emptyVoltage: { value: 60 }, fullVoltage: { value: 58.8 } },
    };
    delete pack.dimensions;
    expect(entryProblems(pack)).toEqual([
      {
        field: 'fullVoltage',
        message: 'full (charge) voltage is below the empty (cutoff) voltage',
      },
    ]);
  });

  it('refuses an OCV curve that falls as the charge rises, and takes a flat one', () => {
    expect(
      withRatings({ ocv0: { value: 3.0 }, ocv50: { value: 3.7 }, ocv100: { value: 3.6 } }),
    ).toEqual([
      { field: 'ocv100', message: 'open-circuit voltage at 100 % is below the one at 50 %' },
    ]);
    expect(
      withRatings({ ocv40: { value: 3.3 }, ocv50: { value: 3.3 }, ocv60: { value: 3.31 } }),
    ).toEqual([]);
  });

  it('keeps specific heat above zero, pack counts and BMS cell counts from 1', () => {
    expect(withRatings({ specificHeatCapacity: { value: 0 } })).toEqual([
      { field: 'specificHeatCapacity', message: 'specific heat capacity must be above zero' },
    ]);
    const pack: CatalogEntry = {
      ...user,
      family: 'pack',
      ratings: { series: { value: 0 }, parallel: { value: 2 } },
    };
    delete pack.dimensions;
    expect(entryProblems(pack)).toMatchObject([{ field: 'series' }]);
    const bms = asUser(latestBuiltin('bms/daly-smart-16s-liion-30a')!);
    expect(withRatings({ minCells: { value: 17 } }, bms)).toMatchObject([{ field: 'maxCells' }]);
    expect(withRatings({ overdischargeVoltage: { value: 4.3 } }, bms)).toMatchObject([
      { field: 'overchargeVoltage' },
    ]);
  });

  it('migrate fields version 1 entries in memory, ratings unchanged', () => {
    for (const family of ['cell', 'pack', 'bms'] as const) {
      const v1: CatalogEntry = {
        id: 'entry#1',
        version: 1,
        family,
        fieldsVersion: 1,
        maker: 'A',
        partNumber: 'B',
        description: '',
        ratings: { nominalVoltage: { value: 3.6 } },
        sources: [],
        verified: false,
      };
      if (family === 'bms') v1.ratings = { minCells: { value: 4 } };
      expect(migrateEntry(v1), family).toEqual({ ok: true, entry: { ...v1, fieldsVersion: 2 } });
      expect(migrateEntry({ ...v1, fieldsVersion: 3 }), family).toMatchObject({
        ok: false,
        reason: 'newer-fields',
      });
    }
  });
});

describe('open-circuit voltage curves', () => {
  it("use the cell's own points when both ends are given, gaps allowed", () => {
    const c = cell({
      chemistry: { text: 'NMC' },
      ocv0: { value: 3.0 },
      ocv50: { value: 3.7, estimated: true },
      ocv100: { value: 4.2 },
    });
    const r = cellOcvCurve(c);
    expect(r).toMatchObject({ ok: true, estimated: true });
    expect(r.ok && r.generic).toBeUndefined();
    expect(r.ok && r.points).toEqual([
      { soc: 0, voltage: 3.0 },
      { soc: 0.5, voltage: 3.7 },
      { soc: 1, voltage: 4.2 },
    ]);
    expect(r.ok && ocvAt(r.points, 0.25)).toBeCloseTo(3.35, 12);
    expect(r.ok && ocvAt(r.points, -1)).toBe(3.0);
    expect(r.ok && ocvAt(r.points, 2)).toBe(4.2);
  });

  it('refuse a partial curve without both ends rather than pad it', () => {
    expect(cellOcvCurve(cell({ chemistry: { text: 'NMC' }, ocv50: { value: 3.7 } }))).toMatchObject(
      { ok: false, missing: ['ocv0', 'ocv100'] },
    );
  });

  it('fall back to the generic curve of the chemistry, marked as generic', () => {
    const nmc = cellOcvCurve(cell({ chemistry: { text: 'NCA' } }));
    expect(nmc).toMatchObject({ ok: true, generic: true, estimated: true });
    expect(nmc.ok && nmc.derivation).toMatch(/generic layered oxide OCV curve/);
    expect(nmc.ok && nmc.points.length).toBe(OCV_SOC_PERCENT.length);
    const lfp = cellOcvCurve(latestBuiltin('cell/a123-anr26650m1-b')!);
    expect(lfp.ok && lfp.points.map((p) => p.voltage)).toEqual(GENERIC_OCV.LFP);
    // Each generic curve rises (or stays flat) with the charge, and LFP is flat in the middle.
    for (const curve of Object.values(GENERIC_OCV)) {
      for (let i = 1; i < curve.length; i++)
        expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }
    expect(GENERIC_OCV.LFP[8]! - GENERIC_OCV.LFP[3]!).toBeLessThan(0.1);
    expect(cellOcvCurve(cell({ chemistry: { text: 'other' } }))).toMatchObject({
      ok: false,
      missing: ['ocv0', 'ocv100'],
    });
    expect(cellOcvCurve(cell({}))).toMatchObject({
      ok: false,
      missing: ['ocv0', 'ocv100', 'chemistry'],
    });
  });
});

describe('the pack builder', () => {
  it('builds a 14s2p pack of P45B cells as the hand calculation does', () => {
    // Hand calculation, P45B: 3.6 V nominal, 4.2 V charge, 2.5 V cutoff, 4.5 Ah, 15 mohm DC,
    // 70 g, 45 A continuous, 13.5 A charge, 900 J/(kg*K) (estimated).
    // Nominal 14 x 3.6 = 50.4 V; full 14 x 4.2 = 58.8 V; empty 14 x 2.5 = 35 V.
    // Capacity 2 x 4.5 = 9 Ah; energy 50.4 x 9 = 453.6 Wh.
    // Resistance 14 x 0.015 / 2 = 0.105 ohm, plus 13 series joints x 0.5 mohm = 6.5 mohm: 0.1115.
    // Mass 28 x 0.070 = 1.96 kg + 0.35 kg enclosure = 2.31 kg.
    // Continuous 2 x 45 = 90 A; charge 2 x 13.5 = 27 A; heat capacity 28 x 0.07 x 900 = 1764 J/K.
    const pack = built(p45b, {
      series: 14,
      parallel: 2,
      interconnect: { resistance: 0.0005, per: 'series joint' },
      enclosureMass: 0.35,
    });
    expect(pack.cells).toBe(28);
    expect(v(pack.nominalVoltage)).toBeCloseTo(50.4, 9);
    expect(v(pack.fullVoltage)).toBeCloseTo(58.8, 9);
    expect(v(pack.emptyVoltage)).toBeCloseTo(35, 9);
    expect(v(pack.capacity)).toBeCloseTo(ah(9), 6);
    expect(v(pack.energy) / 3600).toBeCloseTo(453.6, 9);
    expect(v(pack.resistance)).toBeCloseTo(0.1115, 12);
    expect(pack.interconnectResistance).toBeCloseTo(0.0065, 12);
    expect(v(pack.mass)).toBeCloseTo(2.31, 12);
    expect(v(pack.continuousDischarge)).toBe(90);
    expect(v(pack.maxChargeCurrent)).toBe(27);
    expect(v(pack.heatCapacity)).toBeCloseTo(1764, 9);
    expect(pack.heatCapacity).toMatchObject({ estimated: true });
    expect(v(pack.shortCircuitCurrent)).toBeCloseTo(58.8 / 0.1115, 9);
    expect(pack.shortCircuitCurrent).toMatchObject({ estimated: true });
    expect(pack.peakDischarge).toMatchObject({ ok: false, missing: ['peakDischarge'] });
    expect(pack.nominalVoltage.ok && pack.nominalVoltage.derivation).toBe(
      'nominal voltage 50.4 V = 14 in series x 3.6 V',
    );
    expect(pack.energy.ok && pack.energy.derivation).toMatch(
      /^energy 453\.6 Wh = 50\.4 V x 9 Ah \(nominal voltage x rated capacity/,
    );
    expect(pack.resistance.ok && pack.resistance.derivation).toBe(
      'resistance 0.1115 ohm = 14 in series x 0.015 ohm / 2 in parallel + 0.0065 ohm interconnects (13 series joints x 0.0005 ohm)',
    );
    expect(pack.mass.ok && pack.mass.derivation).toBe(
      'mass 2.31 kg = 28 cells x 0.07 kg + 0.35 kg enclosure, interconnects and wiring',
    );
    // The OCV curve scales by the series count only.
    expect(pack.ocv.ok && pack.ocv.generic).toBe(true);
    expect(pack.ocv.ok && ocvAt(pack.ocv.points, 0.5)).toBeCloseTo(14 * 3.73, 9);
    expect(pack.ocv.ok && ocvAt(pack.ocv.points, 1)).toBeCloseTo(14 * 4.19, 9);
  });

  it("reaches the Voltra's 57.6 V, 97.9 Wh as 16 cells of 1.7 Ah in series, under 100 Wh", () => {
    const voltraCell = cell(
      {
        chemistry: { text: 'NMC' },
        nominalVoltage: { value: 3.6 },
        chargeVoltage: { value: 4.2 },
        cutoffVoltage: { value: 3.0 },
        capacity: { value: ah(1.7) },
      },
      0.046,
    );
    const pack = built(voltraCell, { series: 16, parallel: 1 });
    expect(v(pack.nominalVoltage)).toBeCloseTo(57.6, 9);
    expect(v(pack.fullVoltage)).toBeCloseTo(67.2, 9);
    expect(v(pack.emptyVoltage)).toBeCloseTo(48, 9);
    expect(v(pack.energy) / 3600).toBeCloseTo(97.92, 9);
    expect(v(pack.energy)).toBeLessThan(wh(100));
    expect(v(pack.mass)).toBeCloseTo(0.736, 12);
    expect(pack.mass.ok && pack.mass.derivation).toMatch(/cells only: no enclosure mass given/);
    // Missing cell fields are named, not guessed.
    expect(pack.resistance).toMatchObject({ ok: false, missing: ['resistanceDC'] });
    expect(pack.continuousDischarge).toMatchObject({ ok: false, missing: ['continuousDischarge'] });
    expect(pack.heatCapacity).toMatchObject({ ok: false, missing: ['specificHeatCapacity'] });
    expect(pack.shortCircuitCurrent).toMatchObject({ ok: false, missing: ['resistanceDC'] });
    // A 16S1P of the VTC3 is the built-in cell in that class: 92.16 Wh.
    const vtc3 = built(latestBuiltin('cell/murata-us18650vtc3')!, { series: 16, parallel: 1 });
    expect(v(vtc3.energy) / 3600).toBeCloseTo(92.16, 9);
  });

  it('takes the interconnects for the whole pack, carries estimates, and names missing inputs', () => {
    const pack = built(p45b, {
      series: 6,
      parallel: 1,
      interconnect: { resistance: 0.004, per: 'pack' },
    });
    expect(v(pack.resistance)).toBeCloseTo(6 * 0.015 + 0.004, 12);
    expect(v(pack.energy) / 3600).toBeCloseTo(6 * 3.6 * 4.5, 9);
    const noInter = built(p45b, { series: 6, parallel: 1 });
    expect(noInter.resistance.ok && noInter.resistance.derivation).toMatch(
      /\(no interconnect resistance given\)$/,
    );
    const estimated = built(
      cell({ nominalVoltage: { value: 3.6, estimated: true }, capacity: { value: ah(2) } }),
      {
        series: 2,
        parallel: 1,
      },
    );
    expect(estimated.energy).toMatchObject({ ok: true, estimated: true });
    const bare = built(cell({}), { series: 2, parallel: 3 });
    expect(bare.energy).toMatchObject({ ok: false, missing: ['nominalVoltage', 'capacity'] });
    expect(bare.mass).toMatchObject({ ok: false, missing: ['mass'] });
    expect(bare.heatCapacity).toMatchObject({
      ok: false,
      missing: ['mass', 'specificHeatCapacity'],
    });
  });

  it('refuses a spec that is not a pack and an entry that is not a cell', () => {
    for (const spec of [
      { series: 0, parallel: 1 },
      { series: 2.5, parallel: 1 },
      { series: 14, parallel: 1001 },
      { series: 14, parallel: 2, interconnect: { resistance: -1, per: 'pack' as const } },
      { series: 14, parallel: 2, enclosureMass: Number.NaN },
    ]) {
      expect(buildPack(p45b, spec).ok, JSON.stringify(spec)).toBe(false);
    }
    expect(buildPack({ family: 'bms', ratings: {} }, { series: 1, parallel: 1 })).toEqual({
      ok: false,
      message: 'a bms is not a cell',
    });
  });

  it('writes a built pack as a valid pack entry', () => {
    const pack = built(p45b, { series: 14, parallel: 2, enclosureMass: 0.35 });
    const { ratings, mass } = packRatings(pack, 'cell/molicel-inr-21700-p45b v1');
    const entry: CatalogEntry = {
      id: 'entry#2',
      version: 1,
      family: 'pack',
      fieldsVersion: familySchema('pack').fieldsVersion,
      maker: 'Self-built',
      partNumber: '14s2p P45B',
      description: '',
      ratings,
      mass,
      sources: [{ title: 'Built from the cell entry', read: '2026-10-10' }],
      verified: false,
    };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entryProblems(entry)).toEqual([]);
    expect(ratings.energy).toEqual({ value: expect.closeTo(50.4 * ah(9), 6) });
    expect(ratings.peakDischarge).toEqual({ unknown: true });
    expect(mass).toEqual({ value: 28 * 0.07 + 0.35 });
  });

  it('writes interconnects not given as unknown, and says the resistance is the cells only', () => {
    const pack = built(p45b, { series: 14, parallel: 2 });
    expect(pack.interconnectResistance).toBeUndefined();
    const { ratings } = packRatings(pack, 'cell/molicel-inr-21700-p45b v1');
    expect(ratings.interconnectResistance).toEqual({ unknown: true });
    expect(ratings.resistance).toEqual({
      value: expect.closeTo(0.105, 12),
      basis: 'cells only, interconnects not included',
    });
    const withJoints = built(p45b, {
      series: 14,
      parallel: 2,
      interconnect: { resistance: 0.0005, per: 'series joint' },
    });
    const stored = packRatings(withJoints, 'x').ratings;
    expect(stored.interconnectResistance).toEqual({ value: expect.closeTo(0.0065, 12) });
    expect(stored.resistance).toEqual({ value: expect.closeTo(0.1115, 12) });
    // A zero given is a stated zero, not unknown.
    const zero = built(p45b, {
      series: 14,
      parallel: 2,
      interconnect: { resistance: 0, per: 'pack' },
    });
    expect(packRatings(zero, 'x').ratings.interconnectResistance).toEqual({ value: 0 });
  });
});
