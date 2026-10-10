import { describe, expect, it } from 'vitest';
import {
  COUPON_CLEARANCES,
  FIT_DESCRIPTIONS,
  FIT_KINDS,
  FIT_TABLE,
  FIT_VARIABLES,
  HEAT_SET_INSERTS,
  SCREW_SIZES,
  SELF_TAPPING_HOLES,
  fitDefaults,
  heatSetInsert,
  holeInsert,
  printerFamily,
  selfTappingHole,
} from './fits';
import { PRINTERS, findPrinter } from './printers';

const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe('fit table', () => {
  it('names the three fits and their variables', () => {
    expect(FIT_KINDS).toEqual(['press', 'slip', 'sliding']);
    expect(Object.values(FIT_VARIABLES)).toEqual(['fit_press', 'fit_slip', 'fit_sliding']);
    for (const k of FIT_KINDS) expect(FIT_DESCRIPTIONS[k].length).toBeGreaterThan(0);
  });

  it('gives press 0.1, slip 0.2 and sliding 0.4 mm at a 0.4 mm nozzle, marked as placeholders', () => {
    for (const row of FIT_TABLE) {
      expect(row.nozzle).toBe(0.4);
      expect(row.clearances).toEqual({ press: 0.1, slip: 0.2, sliding: 0.4 });
      expect(row.provenance).toBe('placeholder');
      expect(row.source).toMatch(/placeholder/i);
      expect(row.source).not.toMatch(LONG_DASHES);
    }
    expect(new Set(FIT_TABLE.map((r) => `${r.family}@${r.nozzle}`)).size).toBe(FIT_TABLE.length);
  });

  it('orders the fits from tight to loose in every row', () => {
    for (const row of FIT_TABLE) {
      const { press, slip, sliding } = row.clearances;
      expect(press).toBeLessThan(slip);
      expect(slip).toBeLessThan(sliding);
    }
  });

  it('puts every Bambu Lab printer in the bambu-lab family, and anything else in generic', () => {
    for (const p of PRINTERS) expect(printerFamily(p.id)).toBe('bambu-lab');
    expect(printerFamily('not-a-printer')).toBe('generic');
    expect(printerFamily(undefined)).toBe('generic');
  });
});

describe('fitDefaults', () => {
  it('reads the X1 Carbon at 0.4 mm from the table', () => {
    const d = fitDefaults({ printer: 'bambu-x1c', nozzle: 0.4 });
    expect(d).toMatchObject({
      family: 'bambu-lab',
      nozzle: 0.4,
      clearances: { press: 0.1, slip: 0.2, sliding: 0.4 },
      provenance: 'placeholder',
      basis: 'table',
    });
  });

  it("takes the printer's default nozzle, or 0.4 with no printer", () => {
    expect(fitDefaults({ printer: findPrinter('bambu-x1c') }).nozzle).toBe(0.4);
    const none = fitDefaults();
    expect(none).toMatchObject({ family: 'generic', nozzle: 0.4, basis: 'table' });
    expect(fitDefaults({ nozzle: Number.NaN }).nozzle).toBe(0.4);
    expect(fitDefaults({ nozzle: -1 }).nozzle).toBe(0.4);
  });

  it('scales the 0.4 mm row for other nozzles, rounded to 0.01 mm', () => {
    const d6 = fitDefaults({ printer: 'bambu-x1c', nozzle: 0.6 });
    expect(d6.basis).toBe('scaled');
    expect(d6.clearances).toEqual({ press: 0.15, slip: 0.3, sliding: 0.6 });
    expect(d6.source).toMatch(/scaled by 0\.6 \/ 0\.4/);
    expect(fitDefaults({ printer: 'bambu-a1-mini', nozzle: 0.2 }).clearances).toEqual({
      press: 0.05,
      slip: 0.1,
      sliding: 0.2,
    });
    expect(fitDefaults({ nozzle: 0.8 }).clearances).toEqual({
      press: 0.2,
      slip: 0.4,
      sliding: 0.8,
    });
  });

  it('treats an unknown printer as generic rather than failing', () => {
    expect(fitDefaults({ printer: 'some-future-printer', nozzle: 0.4 })).toMatchObject({
      family: 'generic',
      basis: 'table',
      clearances: { press: 0.1, slip: 0.2, sliding: 0.4 },
    });
  });
});

describe('inserts and screws', () => {
  it('covers M2 to M5', () => {
    expect(HEAT_SET_INSERTS.map((i) => i.size)).toEqual([...SCREW_SIZES]);
    expect(SELF_TAPPING_HOLES.map((h) => h.size)).toEqual([...SCREW_SIZES]);
  });

  it("copies CNC Kitchen's standard insert table", () => {
    expect(
      HEAT_SET_INSERTS.map((i) => [i.size, i.length, i.insertDiameter, i.hole, i.minWall]),
    ).toEqual([
      ['M2', 3.0, 3.6, 3.2, 1.3],
      ['M2.5', 4.0, 4.6, 4.0, 1.6],
      ['M3', 5.7, 4.6, 4.0, 1.6],
      ['M4', 8.1, 6.3, 5.6, 2.1],
      ['M5', 9.5, 7.1, 6.4, 2.6],
    ]);
    for (const i of HEAT_SET_INSERTS) {
      expect(i.verified).toBe(true);
      expect(i.source).toMatch(/CNC Kitchen/);
      // The hole is smaller than the insert, so the brass melts into the wall.
      expect(i.hole).toBeLessThan(i.insertDiameter);
    }
    expect(heatSetInsert('M3')?.hole).toBe(4.0);
    expect(heatSetInsert('M6')).toBeUndefined();
  });

  it("finds the insert a hole's standard names, and only for an insert standard", () => {
    expect(holeInsert({ size: 'M3', purpose: 'heat-set-insert' })).toMatchObject({
      hole: 4.0,
      length: 5.7,
      minWall: 1.6,
    });
    expect(holeInsert({ size: 'M3', fit: 'normal' } as { size: string })).toBeUndefined();
    expect(holeInsert({ size: 'M8', purpose: 'heat-set-insert' })).toBeUndefined();
    expect(holeInsert(undefined)).toBeUndefined();
  });

  it('marks every self-tapping hole unverified, at nominal minus pitch', () => {
    expect(SELF_TAPPING_HOLES.map((h) => h.hole)).toEqual([1.6, 2.05, 2.5, 3.3, 4.2]);
    for (const h of SELF_TAPPING_HOLES) {
      expect(h.verified).toBe(false);
      expect(h.source).toMatch(/^Unverified/);
      expect(h.hole).toBeLessThan(h.nominal);
    }
    expect(selfTappingHole('M4')?.hole).toBe(3.3);
    expect(selfTappingHole('#10')).toBeUndefined();
  });
});

describe('coupon clearances', () => {
  it('steps from 0 to 0.5 mm by 0.05 mm', () => {
    expect(COUPON_CLEARANCES).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]);
  });

  it('includes every default clearance, so the coupon can confirm or replace it', () => {
    for (const k of FIT_KINDS) {
      expect(COUPON_CLEARANCES).toContain(fitDefaults().clearances[k]);
    }
  });
});
