import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { MATERIALS, MATERIAL_IDS, findMaterial, massGrams } from './materials';
import { DocumentStore, type ChangeEvent } from './store';
import { PART, bracket, deepFreeze, unwrap } from './test-helpers';

/** The nine materials before M9, with their densities: neither may ever change (mass results). */
const ORIGINAL_DENSITIES = {
  pla: 1240,
  petg: 1270,
  abs: 1040,
  pine: 400,
  oak: 700,
  plywood: 680,
  mdf: 750,
  'aluminium-6061': 2700,
  steel: 7850,
};

describe('the materials table', () => {
  it('has the built-in materials, with unique ids, in display order', () => {
    expect(MATERIAL_IDS).toEqual([
      'pla',
      'petg',
      'abs',
      'pc',
      'pa12',
      'pa-cf',
      'pom',
      'pine',
      'oak',
      'plywood',
      'mdf',
      'aluminium-6061',
      'aluminium-7075',
      'steel',
      'steel-1018',
      'steel-4140',
      'steel-304',
      'brass',
    ]);
    expect(new Set(MATERIAL_IDS).size).toBe(MATERIALS.length);
  });

  it('gives every material a typical density in a plausible range, a source and a sane range', () => {
    for (const m of MATERIALS) {
      expect(m.name.length, m.id).toBeGreaterThan(0);
      expect(m.source.length, m.id).toBeGreaterThan(10);
      expect(m.density, m.id).toBeGreaterThan(100);
      expect(m.density, m.id).toBeLessThan(20_000);
      if ('range' in m) {
        expect(m.range[0], m.id).toBeLessThanOrEqual(m.density);
        expect(m.range[1], m.id).toBeGreaterThanOrEqual(m.density);
      }
    }
  });

  it('keeps the ids and densities of the nine materials before M9 (kg/m3)', () => {
    const density = Object.fromEntries(MATERIALS.map((m) => [m.id, m.density]));
    for (const [id, d] of Object.entries(ORIGINAL_DENSITIES)) expect(density[id], id).toBe(d);
  });

  it('has the typical densities it cites (kg/m3)', () => {
    const density = Object.fromEntries(MATERIALS.map((m) => [m.id, m.density]));
    expect(density).toEqual({
      ...ORIGINAL_DENSITIES,
      pc: 1200,
      pa12: 930,
      'pa-cf': 1090,
      pom: 1410,
      'aluminium-7075': 2810,
      'steel-1018': 7870,
      'steel-4140': 7850,
      'steel-304': 8000,
      brass: 8500,
    });
    // Woods float, plastics and metals sink; laser-sintered PA12 is porous enough to float too.
    for (const m of MATERIALS) {
      expect(m.density < 1000, m.id).toBe(m.category === 'wood' || m.id === 'pa12');
    }
  });

  it('finds a material by id', () => {
    expect(findMaterial('oak')?.name).toBe('Oak (red)');
    expect(findMaterial('unobtainium')).toBeUndefined();
  });

  it('computes mass in grams from mm3 and kg/m3', () => {
    // A litre (1e6 mm3) of water at 1000 kg/m3 is 1 kg.
    expect(massGrams(1e6, 1000)).toBeCloseTo(1000, 9);
    // A 60 x 40 x 20 mm steel block: 48 cm3 at 7.85 g/cm3.
    expect(massGrams(60 * 40 * 20, 7850)).toBeCloseTo(376.8, 9);
    expect(massGrams(0, 7850)).toBe(0);
  });
});

describe('setMaterial', () => {
  it('sets the part material, and its inverse clears it again', () => {
    const doc = deepFreeze(bracket());
    const set = unwrap(applyCommand(doc, { type: 'setMaterial', partId: PART, material: 'oak' }));
    expect(set.document.parts[0]!.material).toBe('oak');
    expect(set.inverse).toEqual({ type: 'setMaterial', partId: PART, material: null });
    const back = unwrap(applyCommand(set.document, set.inverse)).document;
    expect(back).toEqual(doc);
    expect('material' in back.parts[0]!).toBe(false);
  });

  it('replaces a material, with the old one as the inverse', () => {
    const oak = unwrap(
      applyCommand(bracket(), { type: 'setMaterial', partId: PART, material: 'oak' }),
    ).document;
    const pla = unwrap(applyCommand(oak, { type: 'setMaterial', partId: PART, material: 'pla' }));
    expect(pla.document.parts[0]!.material).toBe('pla');
    expect(pla.inverse).toEqual({ type: 'setMaterial', partId: PART, material: 'oak' });
  });

  it('refuses an unknown material and an unknown part', () => {
    const bad = applyCommand(bracket(), {
      type: 'setMaterial',
      partId: PART,
      material: 'unobtainium' as never,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('schema');
    const nopart = applyCommand(bracket(), {
      type: 'setMaterial',
      partId: 'part#9',
      material: 'pla',
    });
    expect(nopart.ok).toBe(false);
    if (!nopart.ok) expect(nopart.error.code).toBe('not-found');
  });

  it('is one undo step in the store, reported as a material change with no geometry affected', () => {
    const store = unwrap(DocumentStore.create(bracket()));
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));
    unwrap(store.execute({ type: 'setMaterial', partId: PART, material: 'steel' }, 'Set material'));
    expect(store.document.parts[0]!.material).toBe('steel');
    expect(events[0]!.change.parts).toEqual([
      expect.objectContaining({ partId: PART, materialChanged: true, firstAffectedIndex: null }),
    ]);
    // Setting the same material again changes nothing and adds no history.
    store.execute({ type: 'setMaterial', partId: PART, material: 'steel' });
    expect(store.undoStack).toHaveLength(1);
    unwrap(store.undo());
    expect(store.document.parts[0]!.material).toBeUndefined();
    unwrap(store.redo());
    expect(store.document.parts[0]!.material).toBe('steel');
  });
});
