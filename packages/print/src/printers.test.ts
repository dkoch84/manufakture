import { describe, expect, it } from 'vitest';
import { intersectConvex, isConvexCcw, outsideDistance, polygonBounds } from './geometry';
import {
  LINE_WIDTHS,
  PRINTERS,
  PRINTER_IDS,
  defaultLineWidth,
  findPrinter,
  hasNozzle,
  minFeatureSize,
  type Printer,
} from './printers';

const all = PRINTERS as readonly Printer[];
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe('printer table', () => {
  it('has the permanent ids, in display order', () => {
    // Ids are stored in documents: this list may grow, but never lose or rename an entry.
    expect(PRINTER_IDS).toEqual([
      'bambu-a1-mini',
      'bambu-a1',
      'bambu-p1p',
      'bambu-p1s',
      'bambu-p2s',
      'bambu-x1',
      'bambu-x1c',
      'bambu-x1e',
      'bambu-h2s',
      'bambu-h2d',
      'bambu-h2d-pro',
      'bambu-x2d',
    ]);
    expect(new Set(PRINTER_IDS).size).toBe(PRINTER_IDS.length);
  });

  it.each(all.map((p) => [p.id, p] as const))('%s is well formed and cites its sources', (_, p) => {
    expect(p.name.length).toBeGreaterThan(0);
    expect(isConvexCcw(p.area)).toBe(true);
    expect(p.height).toBeGreaterThan(0);
    expect(p.source).toMatch(/^OrcaSlicer 2\.4\.2, resources\/profiles\/BBL\/machine\//);
    expect(p.nozzleSource.length).toBeGreaterThan(0);
    expect(hasNozzle(p, p.defaultNozzle)).toBe(true);
    expect([...p.nozzles].sort((a, b) => a - b)).toEqual(p.nozzles);
    for (const e of p.excluded) {
      expect(isConvexCcw(e.polygon)).toBe(true);
      for (const c of e.polygon) expect(outsideDistance(p.area, c)).toBeLessThanOrEqual(0);
    }
    for (const n of p.nozzleAreas ?? []) {
      expect(isConvexCcw(n.area)).toBe(true);
      expect(intersectConvex(n.area, p.area).length).toBeGreaterThan(0);
      for (const c of n.area) expect(outsideDistance(p.area, c)).toBeLessThanOrEqual(0);
      expect(n.height).toBeLessThanOrEqual(p.height);
    }
    // House style: no long dashes in shipped text.
    expect(`${p.name}${p.source}${p.nozzleSource}`).not.toMatch(LONG_DASHES);
  });

  it('the X1 Carbon matches OrcaSlicer 2.4.2: 256 x 256, 250 high, 18 x 28 corner excluded', () => {
    const x1c = findPrinter('bambu-x1c')!;
    expect(x1c.name).toBe('Bambu Lab X1 Carbon');
    expect(polygonBounds(x1c.area)).toEqual({ min: [0, 0], max: [256, 256] });
    expect(x1c.height).toBe(250);
    expect(x1c.excluded).toHaveLength(1);
    expect(x1c.excluded[0]!.id).toBe('origin-corner');
    expect(polygonBounds(x1c.excluded[0]!.polygon)).toEqual({ min: [0, 0], max: [18, 28] });
    expect(x1c.nozzleAreas).toBeUndefined();
    expect(x1c.nozzles).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(x1c.defaultNozzle).toBe(0.4);
  });

  it.each([
    ['bambu-a1-mini', 180, 180, 180, 0],
    ['bambu-a1', 256, 256, 256, 0],
    ['bambu-p1p', 256, 256, 250, 1],
    ['bambu-p1s', 256, 256, 250, 1],
    ['bambu-p2s', 256, 256, 256, 0],
    ['bambu-x1', 256, 256, 250, 1],
    ['bambu-x1c', 256, 256, 250, 1],
    ['bambu-x1e', 256, 256, 250, 1],
    ['bambu-h2s', 340, 320, 340, 0],
    ['bambu-h2d', 350, 320, 325, 0],
    ['bambu-h2d-pro', 350, 320, 325, 0],
    ['bambu-x2d', 256, 256, 261, 0],
  ])('%s: %d x %d x %d, %d exclusions (research note, section 4)', (id, x, y, z, excluded) => {
    const p = findPrinter(id)!;
    expect(polygonBounds(p.area)).toEqual({ min: [0, 0], max: [x, y] });
    expect(p.height).toBe(z);
    expect(p.excluded).toHaveLength(excluded);
  });

  it.each([
    ['bambu-h2d', [0, 325, 320], [25, 350, 325]],
    ['bambu-h2d-pro', [0, 325, 320], [25, 350, 325]],
    ['bambu-x2d', [0, 256, 261], [20.5, 256, 256]],
  ] as const)('%s nozzle areas: left x %j, right x %j', (id, left, right) => {
    const areas = findPrinter(id)!.nozzleAreas!;
    expect(areas.map((a) => a.name)).toEqual(['left', 'right']);
    for (const [a, [x0, x1, h]] of [
      [areas[0]!, left],
      [areas[1]!, right],
    ] as const) {
      const ymax = id === 'bambu-x2d' ? 256 : 320;
      expect(polygonBounds(a.area)).toEqual({ min: [x0, 0], max: [x1, ymax] });
      expect(a.height).toBe(h);
    }
  });

  it('finds printers by id and returns undefined for an unknown one', () => {
    expect(findPrinter('bambu-a1')?.name).toBe('Bambu Lab A1');
    expect(findPrinter('prusa-mk4')).toBeUndefined();
    expect(findPrinter('')).toBeUndefined();
  });
});

describe('nozzle defaults', () => {
  it('line width is 0.42 mm for a 0.4 mm nozzle, as OrcaSlicer profiles set', () => {
    expect(defaultLineWidth(0.4)).toBe(0.42);
    expect(defaultLineWidth(0.2)).toBe(0.22);
    expect(defaultLineWidth(0.6)).toBe(0.62);
    expect(defaultLineWidth(0.8)).toBe(0.82);
    expect(defaultLineWidth(1.0)).toBeCloseTo(1.02, 12);
    expect(LINE_WIDTHS).toHaveLength(4);
  });

  it('the minimum feature size is 25% of the nozzle', () => {
    expect(minFeatureSize(0.4)).toBeCloseTo(0.1, 15);
    expect(minFeatureSize(0.6)).toBeCloseTo(0.15, 15);
  });

  it('knows which nozzles a printer has', () => {
    const a1mini = findPrinter('bambu-a1-mini')!;
    expect(hasNozzle(a1mini, 0.4)).toBe(true);
    expect(hasNozzle(a1mini, 0.1 + 0.3)).toBe(true); // 0.4000000000000001
    expect(hasNozzle(a1mini, 0.5)).toBe(false);
  });
});
