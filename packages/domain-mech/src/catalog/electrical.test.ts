import { createDocument, type CatalogEntry, type DisplayUnits } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ENTRIES, latestBuiltin, resolveEntry } from '../parts/catalog';
import {
  entryProblems,
  familySchema,
  migrateEntry,
  ratingField,
  type CatalogFamily,
} from '../parts/families';
import { readRating } from '../parts/input';
import {
  CONNECTOR_ENTRIES,
  FAMILY_CATALOG_ENTRIES,
  FUSE_ENTRIES,
  RESISTOR_ENTRIES,
  SWITCH_ENTRIES,
  WIRE_ENTRIES,
} from './index';

const SI: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const degC = (v: number) => v + 273.15;
const asUser = (e: (typeof BUILTIN_ENTRIES)[number]): CatalogEntry => {
  const rest: Partial<typeof e> = { ...e };
  delete rest.deprecated;
  return { ...rest, id: 'entry#1' } as CatalogEntry;
};
const entry = (id: string) => asUser(latestBuiltin(id)!);
const num = (e: CatalogEntry, name: string): number | undefined => {
  const r = e.ratings[name];
  return r !== undefined && 'value' in r ? r.value : undefined;
};
const text = (e: CatalogEntry, name: string): string | undefined => {
  const r = e.ratings[name];
  return r !== undefined && 'text' in r ? r.text : undefined;
};
const basis = (e: CatalogEntry, name: string): string | undefined => {
  const r = e.ratings[name];
  return r !== undefined && 'value' in r ? r.basis : undefined;
};
const given = (e: CatalogEntry, name: string) => e.ratings[name] !== undefined;

const FAMILIES: [CatalogFamily, readonly (typeof BUILTIN_ENTRIES)[number][], number][] = [
  ['wire', WIRE_ENTRIES, 6],
  ['connector', CONNECTOR_ENTRIES, 5],
  ['fuse', FUSE_ENTRIES, 3],
  ['switch', SWITCH_ENTRIES, 3],
  ['resistor', RESISTOR_ENTRIES, 3],
];

/** En and em dashes, which the repository's style keeps out of every text. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

/** A 16S lithium-ion pack's full voltage, the cable trainer's bus (docs/plans/m9.md). */
const PACK_FULL = 16 * 4.2;

describe('the wire, connector, fuse, switch and resistor catalogs', () => {
  it('hold several entries per family, in BUILTIN_ENTRIES, with unique ids', () => {
    for (const [family, list, least] of FAMILIES) {
      expect(list.length, family).toBeGreaterThanOrEqual(least);
      for (const e of list) {
        expect(e.family, e.id).toBe(family);
        expect(e.id.startsWith(`${family}/`), e.id).toBe(true);
        expect(FAMILY_CATALOG_ENTRIES).toContain(e);
        expect(BUILTIN_ENTRIES).toContain(e);
      }
    }
    const keys = BUILTIN_ENTRIES.map((e) => `${e.id} ${e.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are valid, unverified, sourced with a read date, at fields version 2', () => {
    for (const [, list] of FAMILIES) {
      for (const e of list) {
        expect(entryProblems(asUser(e)), e.id).toEqual([]);
        expect(e.verified, e.id).toBe(false);
        expect(e.fieldsVersion, e.id).toBe(2);
        expect(e.sources.length, e.id).toBeGreaterThan(0);
        for (const s of e.sources) {
          expect(s.url, e.id).toMatch(/^https:\/\//);
          expect(s.read, e.id).toBe('2026-10-10');
        }
        // Every rating a BOM line relies on is present, given or unknown.
        for (const f of familySchema(e.family).fields.filter((x) => x.bom)) {
          expect(given(asUser(e), f.name), `${e.id}.${f.name}`).toBe(true);
        }
        // No dash punctuation in any text (the repository's style).
        expect(JSON.stringify(e), e.id).not.toMatch(DASHES);
      }
    }
  });

  it('give each wire what ampacity and voltage drop (T9.5f) read, with the basis named', () => {
    for (const w of WIRE_ENTRIES.map((e) => asUser(e))) {
      expect(num(w, 'resistancePerLength'), w.id).toBeGreaterThan(0);
      expect(w.ratings.resistancePerLength, w.id).toMatchObject({ estimated: true });
      expect(num(w, 'ampacity'), w.id).toBeGreaterThan(0);
      expect(basis(w, 'ampacity'), w.id).toMatch(/NEC|PowerStream/);
      expect(num(w, 'temperatureRating'), w.id).toBe(degC(200));
      expect(text(w, 'insulation'), w.id).toBe('silicone');
      // The area is the stated stranding's, and the resistance copper over that area.
      const area = (num(w, 'strands')! * Math.PI * num(w, 'strandDiameter')! ** 2) / 4;
      expect(num(w, 'conductorArea')! / area, w.id).toBeCloseTo(1, 3);
      expect(num(w, 'resistancePerLength')! / (1.7241e-8 / (area * 1e-6)), w.id).toBeCloseTo(1, 3);
      // A bundled figure, when given, names its conductor count and is below the free-air one.
      if (num(w, 'ampacityBundled') !== undefined) {
        expect(num(w, 'bundledConductors'), w.id).toBe(3);
        expect(num(w, 'ampacityBundled')!, w.id).toBeLessThan(num(w, 'ampacity')!);
        expect(num(w, 'ampacityAmbient'), w.id).toBe(degC(40));
      }
    }
    // Thicker wire: more area, less resistance, more ampacity.
    const byGauge = WIRE_ENTRIES.map((e) => asUser(e));
    for (let i = 1; i < byGauge.length; i++) {
      const [thick, thin] = [byGauge[i - 1]!, byGauge[i]!];
      expect(num(thick, 'conductorArea')!).toBeGreaterThan(num(thin, 'conductorArea')!);
      expect(num(thick, 'resistancePerLength')!).toBeLessThan(num(thin, 'resistancePerLength')!);
      expect(num(thick, 'ampacity')!).toBeGreaterThan(num(thin, 'ampacity')!);
    }
    // Spot values: 12 AWG, 680 x 0.08 mm, about 5.04 mOhm/m; NEC 200 °C, 68 A free air, 45 A in a
    // raceway; within a few percent of solid 12 AWG's 5.211 mOhm/m.
    const w12 = entry('wire/bntechgo-silicone-12awg');
    expect(num(w12, 'conductorArea')).toBeCloseTo(3.418, 3);
    expect(num(w12, 'resistancePerLength')).toBeCloseTo(5.044e-3, 6);
    expect(num(w12, 'ampacity')).toBe(68);
    expect(num(w12, 'ampacityBundled')).toBe(45);
    expect(num(w12, 'massPerLength')!).toBeGreaterThan(0.03);
    expect(num(w12, 'massPerLength')!).toBeLessThan(0.06);
    // The 16 AWG size has no stated outer diameter, so its mass is unknown, not guessed.
    expect(entry('wire/bntechgo-silicone-16awg').ratings.massPerLength).toEqual({ unknown: true });
  });

  it('give each connector its continuous and burst current, voltage and anti-spark flag', () => {
    for (const c of CONNECTOR_ENTRIES.map((e) => asUser(e))) {
      expect(num(c, 'continuousCurrent'), c.id).toBeGreaterThan(0);
      expect(basis(c, 'continuousCurrent'), c.id).toBeTruthy();
      expect(num(c, 'voltageRating')!, c.id).toBeGreaterThan(PACK_FULL);
      expect(['yes', 'no']).toContain(text(c, 'antiSpark'));
      for (const name of ['matingCycles', 'contactResistance', 'wireRange']) {
        expect(given(c, name), `${c.id}.${name}`).toBe(true);
      }
    }
    // The number in an XT name is its burst rating, not its continuous one.
    const xt60 = entry('connector/amass-xt60');
    expect(num(xt60, 'continuousCurrent')).toBe(30);
    expect(num(xt60, 'burstCurrent')).toBe(60);
    expect(basis(xt60, 'continuousCurrent')).toMatch(/4 h/);
    expect(text(entry('connector/amass-xt90-s'), 'antiSpark')).toBe('yes');
    expect(num(entry('connector/anderson-sb50'), 'matingCycles')).toBe(10000);
  });

  it('give each fuse what coordination reads, and only the 70 V one suits a 16S pack', () => {
    for (const f of FUSE_ENTRIES.map((e) => asUser(e))) {
      expect(num(f, 'interruptingRating')!, f.id).toBeGreaterThan(num(f, 'rating')!);
      expect(num(f, 'interruptingVoltage'), f.id).toBe(num(f, 'voltageRating'));
      expect(num(f, 'i2t'), f.id).toBeGreaterThan(0);
    }
    const suits = FUSE_ENTRIES.filter((f) => num(asUser(f), 'voltageRating')! >= PACK_FULL).map(
      (f) => f.id,
    );
    expect(suits).toEqual(['fuse/littelfuse-midi-hp-70v-30a']);
    // Spot values from the Littelfuse catalogue pages.
    const tac = entry('fuse/littelfuse-tac-ato-58v-30a');
    expect(num(tac, 'i2t')).toBe(1070);
    expect(num(tac, 'continuousFraction')).toBe(0.75);
    expect(num(tac, 'maxOpeningTime200')).toBe(5);
    expect(num(entry('fuse/littelfuse-ato-32v-20a'), 'coldResistance')).toBeCloseTo(3.38e-3, 9);
  });

  it('state DC breaking at a voltage, and the contactor alone breaks a 16S bus', () => {
    for (const s of SWITCH_ENTRIES.map((e) => asUser(e))) {
      expect(num(s, 'continuousCurrent'), s.id).toBeGreaterThan(0);
      expect(given(s, 'breakingCurrent'), s.id).toBe(true);
      if (num(s, 'breakingCurrent') !== undefined) {
        expect(num(s, 'breakingVoltage'), s.id).toBeGreaterThan(0);
      }
    }
    const ev200 = entry('switch/te-kilovac-ev200aaana');
    expect(text(ev200, 'kind')).toBe('contactor');
    expect(num(ev200, 'breakingCurrent')).toBe(2000);
    expect(num(ev200, 'breakingVoltage')).toBe(320);
    expect(num(ev200, 'coilHoldPower')).toBe(1.7);
    expect(num(ev200, 'voltageRating')!).toBeGreaterThan(PACK_FULL);
    // The battery switch states no breaking rating: unknown, not zero.
    expect(entry('switch/blue-sea-6006').ratings.breakingCurrent).toEqual({ unknown: true });
    expect(num(entry('switch/carling-v-series-vld1'), 'voltageRating')!).toBeLessThan(PACK_FULL);
  });

  it('give braking resistors pulse energy with its pulse, for the 530 J, 1.1 kW pull', () => {
    for (const r of RESISTOR_ENTRIES.map((e) => asUser(e))) {
      expect(num(r, 'resistance'), r.id).toBeGreaterThan(0);
      expect(num(r, 'continuousPower'), r.id).toBeGreaterThan(0);
      expect(given(r, 'pulseEnergy'), r.id).toBe(true);
      if (num(r, 'pulseEnergy') !== undefined) {
        expect(num(r, 'pulseDuration'), r.id).toBeGreaterThan(0);
        expect(num(r, 'pulsePeriod')!, r.id).toBeGreaterThan(num(r, 'pulseDuration')!);
      }
    }
    // One 530 J pull fits the HCH165's 1 s pulse rating many times over, and the average at a rep
    // every 4 s (about 130 W) is inside its 200 W continuous rating.
    const hch = entry('resistor/te-hch165-6r8');
    expect(num(hch, 'pulseEnergy')!).toBeGreaterThan(530);
    expect(530 / 4).toBeLessThan(num(hch, 'continuousPower')!);
    // But 6.8 ohm at 67.2 V takes at most 664 W, short of 1.1 kW; 3.3 ohm takes enough.
    expect(PACK_FULL ** 2 / num(hch, 'resistance')!).toBeLessThan(1100);
    const hs = entry('resistor/arcol-hs100-3r3');
    expect(PACK_FULL ** 2 / num(hs, 'resistance')!).toBeGreaterThan(1100);
    expect(hs.ratings.pulseEnergy).toEqual({ unknown: true });
    expect(num(hs, 'freeAirPower')!).toBeLessThan(num(hs, 'continuousPower')!);
  });
});

describe('checking wire, connector, fuse, switch and resistor fields', () => {
  const with_ = (id: string, ratings: CatalogEntry['ratings']) => {
    const e = entry(id);
    return entryProblems({ ...e, ratings: { ...e.ratings, ...ratings } });
  };

  it('keeps plain numbers in their ranges', () => {
    const cases: [string, string, number[], number[]][] = [
      ['wire/bntechgo-silicone-12awg', 'resistancePerLength', [0.005], [0, -1]],
      ['wire/bntechgo-silicone-12awg', 'conductorArea', [3.3], [0, -2]],
      ['wire/bntechgo-silicone-12awg', 'strandDiameter', [0.1], [0]],
      ['wire/bntechgo-silicone-12awg', 'strands', [1, 680], [0]],
      ['wire/bntechgo-silicone-12awg', 'bundledConductors', [1, 3], [0]],
      ['connector/amass-xt60', 'poles', [1, 2], [0]],
      ['fuse/littelfuse-tac-ato-58v-30a', 'i2t', [1], [0, -5]],
      ['fuse/littelfuse-tac-ato-58v-30a', 'continuousFraction', [0.5, 1], [0, 1.2]],
      ['resistor/te-hch165-6r8', 'tolerance', [0, 0.1], [-0.05, 1]],
    ];
    for (const [id, name, good, bad] of cases) {
      for (const v of good) {
        expect(with_(id, { [name]: { value: v } }), `${name} ${v}`).toEqual([]);
      }
      for (const v of bad) {
        expect(with_(id, { [name]: { value: v } }), `${name} ${v}`).toMatchObject([
          { field: name },
        ]);
      }
    }
  });

  it('refuses pairs out of order, naming the second', () => {
    expect(with_('wire/bntechgo-silicone-12awg', { ampacityBundled: { value: 80 } })).toEqual([
      {
        field: 'ampacity',
        message: 'ampacity is below the ampacity in a bundle (raceway or cable)',
      },
    ]);
    expect(
      with_('wire/bntechgo-silicone-12awg', { minTemperature: { value: degC(250) } }),
    ).toMatchObject([{ field: 'temperatureRating' }]);
    expect(with_('connector/amass-xt60', { burstCurrent: { value: 20 } })).toMatchObject([
      { field: 'burstCurrent' },
    ]);
    expect(with_('fuse/littelfuse-tac-ato-58v-30a', { interruptingRating: { value: 25 } })).toEqual(
      [{ field: 'interruptingRating', message: 'interrupting rating is below the current rating' }],
    );
    expect(
      with_('fuse/littelfuse-tac-ato-58v-30a', { maxOpeningTime200: { value: 2000 } }),
    ).toMatchObject([{ field: 'maxOpeningTime135' }]);
    expect(
      with_('switch/carling-v-series-vld1', { electricalLife: { value: 200_000 } }),
    ).toMatchObject([{ field: 'mechanicalLife' }]);
    expect(with_('switch/blue-sea-6006', { shortTimeCurrent: { value: 200 } })).toMatchObject([
      { field: 'shortTimeCurrent' },
    ]);
    expect(with_('resistor/arcol-hs100-3r3', { freeAirPower: { value: 150 } })).toMatchObject([
      { field: 'continuousPower' },
    ]);
    expect(with_('resistor/te-hch165-6r8', { pulsePeriod: { value: 0.5 } })).toMatchObject([
      { field: 'pulsePeriod' },
    ]);
    // Unknown values are not compared.
    expect(with_('switch/blue-sea-6006', { shortTimeCurrent: { unknown: true } })).toEqual([]);
  });

  it('refuses a choice outside its options, a count that is not whole and a wrong type', () => {
    expect(with_('wire/bntechgo-silicone-12awg', { conductor: { text: 'silver' } })).toMatchObject([
      { field: 'conductor', message: expect.stringMatching(/one of copper/) },
    ]);
    expect(with_('connector/amass-xt60', { antiSpark: { text: 'maybe' } })).toMatchObject([
      { field: 'antiSpark' },
    ]);
    expect(with_('switch/blue-sea-6006', { kind: { text: 'lever' } })).toMatchObject([
      { field: 'kind' },
    ]);
    expect(with_('connector/amass-xt60', { matingCycles: { value: 99.5 } })).toMatchObject([
      { field: 'matingCycles', message: expect.stringMatching(/whole/) },
    ]);
    expect(with_('connector/amass-xt60', { wireRange: { value: 12 } })).toMatchObject([
      { field: 'wireRange', message: 'wire it takes (AWG or mm²) is a text, not a number' },
    ]);
    expect(with_('resistor/te-hch165-6r8', { pulseEnergy: { value: -1 } })).toMatchObject([
      { field: 'pulseEnergy', message: expect.stringMatching(/not below zero/) },
    ]);
  });
});

describe('typing each wire, connector, fuse, switch and resistor field in', () => {
  // A datasheet value with its unit for every number field, and the SI value it must read as.
  type Table = Record<string, [string, number]>;
  const TABLES: Partial<Record<CatalogFamily, Table>> = {
    wire: {
      resistancePerLength: ['0.005211', 0.005211],
      voltageRating: ['600 V', 600],
      ampacity: ['68 A', 68],
      ampacityBundled: ['45 A', 45],
      bundledConductors: ['3', 3],
      ampacityAmbient: ['40 degC', degC(40)],
      temperatureRating: ['200 degC', degC(200)],
      minTemperature: ['-60 degC', degC(-60)],
      conductorArea: ['3.31', 3.31],
      strands: ['680', 680],
      strandDiameter: ['0.08', 0.08],
      massPerLength: ['45 g/m', 0.045],
    },
    connector: {
      poles: ['2', 2],
      continuousCurrent: ['30 A', 30],
      voltageRating: ['500 V', 500],
      contactResistance: ['0.7 mohm', 0.7e-3],
      matingCycles: ['1000', 1000],
      burstCurrent: ['60 A', 60],
      minOperatingTemperature: ['-20 degC', degC(-20)],
      maxOperatingTemperature: ['120 degC', degC(120)],
    },
    fuse: {
      rating: ['30 A', 30],
      voltageRating: ['58 V', 58],
      interruptingRating: ['1000 A', 1000],
      interruptingVoltage: ['58 V', 58],
      i2t: ['1070', 1070],
      maxOpeningTime135: ['30 min', 1800],
      maxOpeningTime200: ['5 s', 5],
      continuousFraction: ['0.75', 0.75],
      coldResistance: ['1.9 mohm', 1.9e-3],
      voltageDrop: ['80 mV', 0.08],
      minOperatingTemperature: ['-40 degC', degC(-40)],
      maxOperatingTemperature: ['125 degC', degC(125)],
    },
    switch: {
      continuousCurrent: ['500 A', 500],
      breakingCurrent: ['2000 A', 2000],
      voltageRating: ['900 V', 900],
      electricalLife: ['100000', 100000],
      breakingVoltage: ['320 V', 320],
      shortTimeCurrent: ['500 A', 500],
      makingCurrent: ['650 A', 650],
      mechanicalLife: ['1000000', 1000000],
      contactResistance: ['0.2 mohm', 0.2e-3],
      coilVoltage: ['12 V', 12],
      coilHoldPower: ['1.7 W', 1.7],
      coilInrushCurrent: ['3.8 A', 3.8],
      minOperatingTemperature: ['-40 degC', degC(-40)],
      maxOperatingTemperature: ['85 degC', degC(85)],
    },
    resistor: {
      resistance: ['6.8 ohm', 6.8],
      continuousPower: ['200 W', 200],
      pulseEnergy: ['7 kJ', 7000],
      thermalTimeConstant: ['5 min', 300],
      voltageRating: ['1.1 kV', 1100],
      pulseDuration: ['1 s', 1],
      pulsePeriod: ['2 min', 120],
      freeAirPower: ['30 W', 30],
      tolerance: ['0.05', 0.05],
      thermalResistance: ['1 K/W', 1],
      maxSurfaceTemperature: ['200 degC', degC(200)],
    },
  };

  for (const [family, table] of Object.entries(TABLES) as [CatalogFamily, Table][]) {
    it(`covers every ${family} number field and reads each in its unit`, () => {
      const numbers = familySchema(family)
        .fields.filter((f) => f.kind !== 'text')
        .map((f) => f.name);
      expect(Object.keys(table).sort()).toEqual([...numbers].sort());
      for (const [name, [typed, si]] of Object.entries(table)) {
        const field = ratingField(family, name)!;
        const r = readRating(field, typed, SI);
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
    expect(readRating(ratingField('wire', 'conductor')!, 'Tinned Copper', SI)).toEqual({
      ok: true,
      value: { text: 'tinned copper' },
    });
    expect(readRating(ratingField('wire', 'conductor')!, 'silver', SI).ok).toBe(false);
    expect(readRating(ratingField('connector', 'antiSpark')!, 'YES', SI)).toEqual({
      ok: true,
      value: { text: 'yes' },
    });
    expect(readRating(ratingField('switch', 'kind')!, 'rotary', SI).ok).toBe(true);
    expect(readRating(ratingField('connector', 'wireRange')!, '12 to 10 AWG', SI)).toEqual({
      ok: true,
      value: { text: '12 to 10 AWG' },
    });
  });
});

describe('older wire, connector, fuse, switch and resistor entries', () => {
  it('migrate from fields version 1 in memory, ratings unchanged', () => {
    const v1 = (family: CatalogFamily, ratings: CatalogEntry['ratings']): CatalogEntry => ({
      id: 'entry#1',
      version: 1,
      family,
      fieldsVersion: 1,
      maker: 'A',
      partNumber: 'B',
      description: '',
      ratings,
      sources: [],
      verified: false,
    });
    const olds = [
      v1('wire', { gauge: { text: '12 AWG' }, ampacity: { value: 25, basis: 'NEC 75 °C' } }),
      v1('connector', { poles: { value: 2 }, continuousCurrent: { value: 30 } }),
      v1('fuse', { rating: { value: 20 }, format: { text: 'ATO' } }),
      v1('switch', { kind: { text: 'contactor' }, breakingCurrent: { value: 2000 } }),
      v1('resistor', { resistance: { value: 2 }, continuousPower: { value: 50 } }),
    ];
    for (const old of olds) {
      expect(entryProblems(old), old.family).toEqual([]);
      expect(migrateEntry(old), old.family).toEqual({
        ok: true,
        entry: { ...old, fieldsVersion: 2 },
      });
      expect(migrateEntry({ ...old, fieldsVersion: 3 }), old.family).toMatchObject({
        ok: false,
        reason: 'newer-fields',
      });
    }
    // A built-in entry resolves at the current version with its ratings as shipped.
    const doc = createDocument({ id: 'd', name: 'D' });
    const fuse = latestBuiltin('fuse/littelfuse-tac-ato-58v-30a')!;
    const r = resolveEntry(doc, { source: 'builtin', id: fuse.id, version: fuse.version });
    expect(r).toMatchObject({ ok: true, entry: { fieldsVersion: 2, ratings: fuse.ratings } });
  });
});
