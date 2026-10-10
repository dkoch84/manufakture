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
  BEARING_ENTRIES,
  BELT_ENTRIES,
  FAMILY_CATALOG_ENTRIES,
  GEAR_ENTRIES,
  PULLEY_ENTRIES,
  ROPE_ENTRIES,
} from './index';

const SI: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const rpm = (v: number) => (v * 2 * Math.PI) / 60;
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
const dim = (e: CatalogEntry, name: string): number | undefined => {
  const r = e.dimensions?.[name as keyof NonNullable<CatalogEntry['dimensions']>];
  return r !== undefined && 'value' in r ? r.value : undefined;
};
const given = (e: CatalogEntry, name: string) => e.ratings[name] !== undefined;

const FAMILIES: [CatalogFamily, readonly (typeof BUILTIN_ENTRIES)[number][], number][] = [
  ['bearing', BEARING_ENTRIES, 5],
  ['belt', BELT_ENTRIES, 4],
  ['pulley', PULLEY_ENTRIES, 3],
  ['gear', GEAR_ENTRIES, 3],
  ['rope', ROPE_ENTRIES, 4],
];

describe('the bearing, belt, pulley, gear and rope catalogs', () => {
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
        // Every dimension the BOM line relies on is present (given or unknown).
        for (const d of familySchema(e.family).dimensions.filter((x) => x.bom)) {
          expect(e.dimensions?.[d.name], `${e.id}.${d.name}`).toBeDefined();
        }
      }
    }
  });

  it('give each bearing what bearing life (T9.5c) reads: C, C0, Pu, speed, mass, d, D, B', () => {
    for (const b of BEARING_ENTRIES.map((e) => asUser(e))) {
      for (const name of ['dynamicLoad', 'staticLoad', 'fatigueLimit', 'limitingSpeed']) {
        expect(num(b, name), `${b.id}.${name}`).toBeGreaterThan(0);
      }
      expect(given(b, 'referenceSpeed'), b.id).toBe(true);
      expect(b.mass && 'value' in b.mass && b.mass.value, b.id).toBeGreaterThan(0);
      const [d, D, B] = ['innerDiameter', 'outerDiameter', 'width'].map((n) => dim(b, n)!);
      expect(D, b.id).toBeGreaterThan(d!);
      expect(B, b.id).toBeGreaterThan(0);
    }
    // Spot values, in SI: SKF 6204-2RSH from the catalogue mirror.
    const b6204 = entry('bearing/skf-6204-2rsh');
    expect(num(b6204, 'dynamicLoad')).toBe(13500);
    expect(num(b6204, 'staticLoad')).toBe(6600);
    expect(num(b6204, 'limitingSpeed')).toBeCloseTo(rpm(10000), 9);
    // A needle bearing's C0 may exceed C; its fatigue limit stays below C0.
    const hk = entry('bearing/ina-hk1612');
    expect(num(hk, 'staticLoad')!).toBeGreaterThan(num(hk, 'dynamicLoad')!);
    expect(num(entry('bearing/skf-7202-bep'), 'contactAngle')).toBe(40);
  });

  it('give each belt what the belt check (T9.5e) reads: tension by grooves, pitch, width, efficiency', () => {
    for (const b of BELT_ENTRIES.map((e) => asUser(e))) {
      const low = b.ratings.ratedWorkingTension!;
      const high = b.ratings.ratedWorkingTensionLarge!;
      expect('basis' in low && low.basis, b.id).toMatch(/grooves/);
      expect('basis' in high && high.basis, b.id).toMatch(/grooves/);
      expect(num(b, 'ratedWorkingTension')!, b.id).toBeLessThanOrEqual(
        num(b, 'ratedWorkingTensionLarge')!,
      );
      expect(num(b, 'minimumPulleyGrooves')!, b.id).toBeLessThan(num(b, 'largePulleyGrooves')!);
      expect(num(b, 'breakingStrength')!, b.id).toBeGreaterThan(
        num(b, 'ratedWorkingTensionLarge')!,
      );
      expect(num(b, 'efficiency'), b.id).toBeGreaterThan(0.9);
      expect(b.ratings.efficiency, b.id).toMatchObject({ estimated: true });
      expect(dim(b, 'pitch'), b.id).toBeGreaterThan(0);
      expect(dim(b, 'width'), b.id).toBeGreaterThan(0);
    }
    const htd25 = entry('belt/gates-htd-5m-25');
    expect(num(htd25, 'ratedWorkingTension')).toBe(649);
    expect(num(htd25, 'breakingStrength')).toBe(9740);
  });

  it('give every pulley a belt of its profile and pitch in the catalog', () => {
    const belts = BUILTIN_ENTRIES.filter((e) => e.family === 'belt').map((e) => asUser(e));
    for (const p of PULLEY_ENTRIES.map((e) => asUser(e))) {
      expect(num(p, 'grooves'), p.id).toBeGreaterThan(0);
      const profile = p.ratings.profile;
      const match = belts.filter(
        (b) =>
          JSON.stringify(b.ratings.profile) === JSON.stringify(profile) &&
          dim(b, 'pitch') === dim(p, 'pitch'),
      );
      expect(match.length, p.id).toBeGreaterThan(0);
      // The outside diameter is a little under the pitch diameter, grooves x pitch / pi.
      const pd = (num(p, 'grooves')! * dim(p, 'pitch')!) / Math.PI;
      expect(dim(p, 'outerDiameter')!, p.id).toBeLessThan(pd);
      expect(dim(p, 'outerDiameter')!, p.id).toBeGreaterThan(pd - 1.5);
    }
  });

  it('give each gear its module, teeth, face width and material', () => {
    for (const g of GEAR_ENTRIES.map((e) => asUser(e))) {
      expect(dim(g, 'module'), g.id).toBeGreaterThan(0);
      expect(dim(g, 'width'), g.id).toBeGreaterThan(0);
      expect(num(g, 'teeth'), g.id).toBeGreaterThan(0);
      expect(g.ratings.material, g.id).toMatchObject({ text: expect.any(String) });
      // A standard spur gear's outside diameter is module x (teeth + 2).
      expect(dim(g, 'outerDiameter'), g.id).toBe(dim(g, 'module')! * (num(g, 'teeth')! + 2));
    }
  });

  it("give each rope what the spool (T9.3b) and rope check read, with T9.3b's 3 mm line", () => {
    for (const r of ROPE_ENTRIES.map((e) => asUser(e))) {
      expect(dim(r, 'diameter'), r.id).toBeGreaterThan(0);
      expect(num(r, 'minimumBreakingLoad'), r.id).toBeGreaterThan(0);
      expect(num(r, 'minimumBendRatio'), r.id).toBeGreaterThan(0);
      expect(num(r, 'massPerLength'), r.id).toBeGreaterThan(0);
      for (const name of ['elasticElongation', 'strengthBasis', 'fatigueNote']) {
        expect(given(r, name), `${r.id}.${name}`).toBe(true);
      }
    }
    const hmpe = entry('rope/samson-amsteel-blue-3mm');
    expect(dim(hmpe, 'diameter')).toBe(3);
    expect(num(hmpe, 'minimumBreakingLoad')).toBeCloseTo(1000 * 9.80665, 9);
    expect(num(hmpe, 'massPerLength')).toBeCloseTo(0.0074, 12);
    expect(hmpe.ratings.strengthBasis).toEqual({ text: 'spliced' });
    // At the design factor of 7 the 3 mm line carries 200 lbf (890 N) with room.
    expect(num(hmpe, 'minimumBreakingLoad')! / num(hmpe, 'designFactor')!).toBeGreaterThan(890);
    // Steel 7x19 wants a drum at least 34 times its diameter: over 100 mm for 1/8 in.
    const steel = entry('rope/steel-7x19-galvanised-3-2mm');
    expect(num(steel, 'minimumBreakingLoad')).toBeCloseTo(2000 * 4.4482216152605, 9);
    expect(dim(steel, 'diameter')! * num(steel, 'minimumBendRatio')!).toBeGreaterThan(100);
  });
});

describe('checking bearing, belt, pulley, gear and rope fields', () => {
  const with_ = (id: string, ratings: CatalogEntry['ratings']) => {
    const e = entry(id);
    return entryProblems({ ...e, ratings: { ...e.ratings, ...ratings } });
  };

  it('keeps plain numbers in their ranges', () => {
    const cases: [string, string, number[], number[]][] = [
      ['bearing/skf-6204-2rsh', 'kr', [0.01], [0, -1]],
      ['bearing/skf-6204-2rsh', 'f0', [13], [0]],
      ['bearing/skf-7202-bep', 'contactAngle', [0, 40], [-1, 90]],
      ['belt/gates-3mgt-15', 'minimumTeethInMesh', [1, 6], [0]],
      ['belt/gates-3mgt-15', 'efficiency', [1, 0.5], [0, 1.01]],
      ['gear/khk-ss1-20', 'pressureAngle', [14.5, 20], [0, 90]],
      ['gear/khk-ss1-20', 'helixAngle', [0, 30], [-5, 90]],
      ['rope/samson-amsteel-blue-3mm', 'minimumBendRatio', [1, 8], [0]],
      ['rope/samson-amsteel-blue-3mm', 'suggestedBendRatio', [10], [0]],
      ['rope/samson-amsteel-blue-3mm', 'terminationEfficiency', [0.8, 1], [0, 1.1]],
      ['rope/samson-amsteel-blue-3mm', 'elasticElongation', [0, 0.007], [-0.1, 1]],
      ['rope/samson-amsteel-blue-3mm', 'elongationLoad', [0.2, 1], [0, 1.5]],
      ['rope/samson-amsteel-blue-3mm', 'designFactor', [1, 7], [0.5]],
    ];
    for (const [id, name, good, bad] of cases) {
      for (const v of good) {
        expect(with_(id, { [name]: { value: v } }), `${name} ${v}`).toEqual([]);
      }
      for (const v of bad) {
        // A suggested bend ratio out of range is also below the minimum one: both are named.
        expect(
          with_(id, { [name]: { value: v } }).filter((p) => !p.message.includes(' is below the ')),
          `${name} ${v}`,
        ).toMatchObject([{ field: name }]);
      }
    }
  });

  it('refuses pairs out of order, naming the second', () => {
    expect(with_('bearing/skf-6204-2rsh', { fatigueLimit: { value: 7000 } })).toEqual([
      { field: 'staticLoad', message: 'static load rating C0 is below the fatigue limit Pu' },
    ]);
    expect(with_('belt/gates-3mgt-15', { largePulleyGrooves: { value: 10 } })).toMatchObject([
      { field: 'largePulleyGrooves' },
    ]);
    expect(with_('belt/gates-3mgt-15', { ratedWorkingTensionLarge: { value: 500 } })).toMatchObject(
      [{ field: 'ratedWorkingTensionLarge' }],
    );
    expect(
      with_('belt/gates-3mgt-15', { breakingStrength: { value: 700 } }).map((p) => p.field),
    ).toEqual(['breakingStrength']);
    expect(with_('rope/samson-amsteel-blue-3mm', { averageBreakingLoad: { value: 9000 } })).toEqual(
      [
        {
          field: 'averageBreakingLoad',
          message: 'average breaking load is below the minimum breaking load',
        },
      ],
    );
    expect(
      with_('rope/samson-amsteel-blue-3mm', { suggestedBendRatio: { value: 6 } }),
    ).toMatchObject([{ field: 'suggestedBendRatio' }]);
    // Unknown values are not compared.
    expect(
      with_('rope/samson-amsteel-blue-3mm', { averageBreakingLoad: { unknown: true } }),
    ).toEqual([]);
  });

  it('refuses a choice outside its options and a count that is not whole', () => {
    expect(
      with_('rope/samson-amsteel-blue-3mm', { strengthBasis: { text: 'knotted' } }),
    ).toMatchObject([{ field: 'strengthBasis', message: expect.stringMatching(/one of spliced/) }]);
    expect(with_('pulley/gates-p90-5mgt-15', { flanges: { text: 'three sides' } })).toMatchObject([
      { field: 'flanges' },
    ]);
    expect(with_('belt/gates-3mgt-15', { teeth: { value: 120.5 } })).toMatchObject([
      { field: 'teeth', message: expect.stringMatching(/whole/) },
    ]);
    expect(with_('gear/khk-ss1-20', { material: { value: 45 } })).toMatchObject([
      { field: 'material', message: 'material is a text, not a number' },
    ]);
  });
});

describe('typing each bearing, belt, pulley, gear and rope field in', () => {
  // A datasheet value with its unit for every number field, and the SI value it must read as.
  type Table = Record<string, [string, number]>;
  const TABLES: Partial<Record<CatalogFamily, Table>> = {
    bearing: {
      dynamicLoad: ['13.5 kN', 13500],
      staticLoad: ['6.6 kN', 6600],
      fatigueLimit: ['0.28 kN', 280],
      limitingSpeed: ['10000 rpm', rpm(10000)],
      referenceSpeed: ['24000 rpm', rpm(24000)],
      kr: ['0.025', 0.025],
      f0: ['13', 13],
      contactAngle: ['40', 40],
    },
    belt: {
      ratedWorkingTension: ['627 N', 627],
      breakingStrength: ['2.85 kN', 2850],
      minimumPulleyGrooves: ['16', 16],
      ratedWorkingTensionLarge: ['165 lbf', 165 * 4.4482216152605],
      largePulleyGrooves: ['45', 45],
      minimumTeethInMesh: ['6', 6],
      tensileStiffness: ['500 kN', 500000],
      massPerLength: ['36 g/m', 0.036],
      efficiency: ['0.97', 0.97],
      teeth: ['170', 170],
    },
    pulley: {
      grooves: ['20', 20],
      maxRimSpeed: ['40 m/s', 40],
    },
    gear: {
      teeth: ['60', 60],
      pressureAngle: ['20', 20],
      ratedTorque: ['24.2 N*m', 24.2],
      surfaceTorque: ['3.4 N*m', 3.4],
      helixAngle: ['0', 0],
    },
    rope: {
      minimumBreakingLoad: ['2300 lbf', 2300 * 4.4482216152605],
      averageBreakingLoad: ['10.8 kN', 10800],
      minimumBendRatio: ['8', 8],
      massPerLength: ['0.74 kg/m', 0.74],
      suggestedBendRatio: ['10', 10],
      terminationEfficiency: ['0.9', 0.9],
      elasticElongation: ['0.007', 0.007],
      elongationLoad: ['0.2', 0.2],
      designFactor: ['7', 7],
      cycleRating: ['50000', 50000],
    },
  };

  for (const [family, table] of Object.entries(TABLES) as [CatalogFamily, Table][]) {
    it(`covers every ${family} number field and reads each in its unit`, () => {
      const numbers = familySchema(family)
        .fields.filter((f) => f.kind !== 'text')
        .map((f) => f.name);
      expect(Object.keys(table).sort()).toEqual([...numbers].sort());
      for (const [name, [text, si]] of Object.entries(table)) {
        const field = ratingField(family, name)!;
        const r = readRating(field, text, SI);
        expect(r.ok, `${name}: ${!r.ok && r.message}`).toBe(true);
        const v = r.ok && r.value && 'value' in r.value ? r.value.value : NaN;
        if (si === 0) expect(v, name).toBe(0);
        else expect(v / si, name).toBeCloseTo(1, 9);
        if (field.kind !== 'number' && field.kind !== 'count') {
          expect(readRating(field, '3 kg', SI).ok, name).toBe(false);
        }
      }
    });
  }

  it('reads the text fields and their choices', () => {
    expect(readRating(ratingField('rope', 'strengthBasis')!, 'Spliced', SI)).toEqual({
      ok: true,
      value: { text: 'spliced' },
    });
    expect(readRating(ratingField('rope', 'strengthBasis')!, 'knotted', SI).ok).toBe(false);
    expect(readRating(ratingField('pulley', 'flanges')!, 'both sides', SI).ok).toBe(true);
    expect(readRating(ratingField('gear', 'hardness')!, 'under 194 HB', SI)).toEqual({
      ok: true,
      value: { text: 'under 194 HB' },
    });
  });
});

describe('older bearing, belt, pulley, gear and rope entries', () => {
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
      v1('bearing', { dynamicLoad: { value: 5400 }, closure: { text: 'shield' } }),
      v1('belt', { ratedWorkingTension: { value: 169, basis: '12 grooves' } }),
      v1('pulley', { grooves: { value: 20 } }),
      v1('gear', { teeth: { value: 20 }, pressureAngle: { value: 20 } }),
      v1('rope', { minimumBreakingLoad: { value: 4500 }, minimumBendRatio: { value: 8 } }),
    ];
    for (const old of olds) {
      expect(migrateEntry(old), old.family).toEqual({
        ok: true,
        entry: { ...old, fieldsVersion: 2 },
      });
      expect(migrateEntry({ ...old, fieldsVersion: 3 }), old.family).toMatchObject({
        ok: false,
        reason: 'newer-fields',
      });
    }
    // T9.2a's samples are still at version 1 and resolve at version 2, ratings as shipped.
    const doc = createDocument({ id: 'd', name: 'D' });
    const sample = latestBuiltin('belt/gates-5mgt-15')!;
    expect(sample.fieldsVersion).toBe(1);
    const r = resolveEntry(doc, { source: 'builtin', id: sample.id, version: sample.version });
    expect(r).toMatchObject({ ok: true, entry: { fieldsVersion: 2, ratings: sample.ratings } });
  });
});
