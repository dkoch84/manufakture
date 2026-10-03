import { findMaterial } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { STOCK, findStock, stockByRegion } from './catalog';

// The full catalog checks (PS 20-25 Table 3, regions, labels) live in `domain-wood`'s
// `catalog.test.ts`, which runs against this catalog through its re-exports and must pass
// unchanged (ADR 0015). These cover what T6.1a added.

const IN = 25.4;

describe('the shared catalog: construction stock (ADR 0015 decision 1)', () => {
  it('keeps every id unique', () => {
    const ids = STOCK.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has the dimensional lumber framing uses', () => {
    for (const [id, t, w] of [
      ['us-2x4', 1.5, 3.5],
      ['us-2x6', 1.5, 5.5],
      ['us-2x8', 1.5, 7.25],
      ['us-2x10', 1.5, 9.25],
      ['us-2x12', 1.5, 11.25],
      ['us-4x4', 3.5, 3.5],
      ['us-4x6', 3.5, 5.5],
    ] as const) {
      const e = findStock(id)!;
      expect(e, id).toBeDefined();
      expect(e.actual).toEqual({ thickness: t * IN, width: w * IN });
      expect(e.verified.actual).toBe(true);
    }
  });

  it('has precut studs of 92-5/8" and 104-5/8", sized as their lumber, sold length unverified', () => {
    const cases = [
      ['us-2x4-precut-92-5-8', 'us-2x4', 92.625],
      ['us-2x4-precut-104-5-8', 'us-2x4', 104.625],
      ['us-2x6-precut-92-5-8', 'us-2x6', 92.625],
      ['us-2x6-precut-104-5-8', 'us-2x6', 104.625],
    ] as const;
    for (const [id, lumber, length] of cases) {
      const e = findStock(id)!;
      const base = findStock(lumber)!;
      expect(e, id).toBeDefined();
      expect(e.category).toBe('stud');
      expect(e.kind).toBe('lumber');
      expect(e.actual).toEqual(base.actual);
      expect(e.nominal).toEqual(base.nominal);
      expect(e.lengths).toEqual([length * IN]);
      expect(e.boardFeetBasis).toBe('nominal');
      expect(e.verified).toEqual({ actual: true, sold: false });
      expect(e.source.sold).toMatch(/unverified/);
    }
    expect(findStock('us-2x4-precut-92-5-8')!.name).toBe('2x4 precut stud 92-5/8"');
    expect(STOCK.filter((e) => e.category === 'stud').map((e) => e.id)).toEqual(
      cases.map((c) => c[0]),
    );
  });

  it('has 7/16" OSB sheathing', () => {
    const osb = findStock('us-osb-7-16')!;
    expect(osb.kind).toBe('sheet');
    expect(osb.actual.thickness).toBe((7 / 16) * IN);
    expect(osb.sheet).toEqual({ length: 96 * IN, width: 48 * IN });
  });

  it('has 1/2" and 5/8" gypsum board in 4 x 8 and 4 x 12 ft, unverified, mapped to a core material', () => {
    const gyp = STOCK.filter((e) => e.category === 'gypsum');
    expect(gyp.map((e) => e.id)).toEqual([
      'us-gyp-1-2-8ft',
      'us-gyp-1-2-12ft',
      'us-gyp-5-8-8ft',
      'us-gyp-5-8-12ft',
    ]);
    for (const e of gyp) {
      expect(e.kind).toBe('sheet');
      expect(e.region).toBe('us');
      expect(e.grain).toBe(false);
      expect(e.boardFeetBasis).toBe('none');
      expect(findMaterial(e.material)).toBeDefined();
      expect(e.verified).toEqual({ actual: false, sold: false });
      expect(e.source.actual).toMatch(/unverified/);
      expect(e.source.sold).toMatch(/unverified/);
    }
    expect(findStock('us-gyp-1-2-8ft')!.actual.thickness).toBe(0.5 * IN);
    expect(findStock('us-gyp-5-8-12ft')!.actual.thickness).toBe(0.625 * IN);
    expect(findStock('us-gyp-1-2-12ft')!.sheet).toEqual({ length: 144 * IN, width: 48 * IN });
    expect(findStock('us-gyp-1-2-12ft')!.name).toBe('1/2" gypsum board 4 x 12 ft');
  });

  it('lists the new entries in the US groups', () => {
    const us = stockByRegion('us');
    expect(us.lumber.map((e) => e.id)).toContain('us-2x4-precut-92-5-8');
    expect(us.sheet.map((e) => e.id)).toContain('us-gyp-5-8-8ft');
  });

  // Ids are stored in documents: an id may never be removed or change meaning. This list pins
  // the ids T6.1a added and a sample of the M4 ones; extend it, never shorten it.
  it('keeps its ids permanent', () => {
    for (const id of [
      'us-2x4',
      'us-2x12',
      'us-4x6',
      'us-ply-23-32',
      'us-osb-7-16',
      'mm-38x89',
      'us-2x4-precut-92-5-8',
      'us-2x4-precut-104-5-8',
      'us-2x6-precut-92-5-8',
      'us-2x6-precut-104-5-8',
      'us-gyp-1-2-8ft',
      'us-gyp-1-2-12ft',
      'us-gyp-5-8-8ft',
      'us-gyp-5-8-12ft',
    ]) {
      expect(findStock(id), id).toBeDefined();
    }
  });
});
