import { parseAngle, parseFeed, parseLength, parseSpindleSpeed } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LIBRARY_ID,
  BUILTIN_TOOLS,
  FEED_CATEGORIES,
  MATERIAL_FEED_CATEGORY,
  chipLoadFromFeed,
  feedCategoryOf,
  feedFromChipLoad,
  findBuiltinTool,
  findPresetFor,
  libraryToolToCamTool,
  libraryToolToTool,
  resolvePreset,
  toMm,
  unverifiedToolFields,
  validateLibraryTool,
  type LibraryTool,
} from './index';

const IN = 25.4;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function tool(id: string): LibraryTool {
  const t = findBuiltinTool(id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
}

describe('built-in tools', () => {
  it('every tool validates, and validation returns an equal copy', () => {
    for (const t of BUILTIN_TOOLS) {
      const r = validateLibraryTool(t);
      expect(r.ok, r.ok ? t.id : `${t.id}: ${r.error.message}`).toBe(true);
      if (r.ok) expect(r.value).toEqual(t);
    }
  });

  it('has the starter set: flats 1/8", 1/4", 3 mm, 6 mm; ball 1/8"; V-bits 60 and 90; a 1/8" drill', () => {
    const has = (kind: string, diameterMm: number, angle?: number) =>
      BUILTIN_TOOLS.some(
        (t) =>
          t.kind === kind &&
          Math.abs(toMm(t.diameter, t.unit) - diameterMm) < 1e-9 &&
          (angle === undefined || t.angleDeg === angle),
      );
    expect(has('flat', 0.125 * IN)).toBe(true);
    expect(has('flat', 0.25 * IN)).toBe(true);
    expect(has('flat', 3)).toBe(true);
    expect(has('flat', 6)).toBe(true);
    expect(has('ball', 0.125 * IN)).toBe(true);
    expect(has('vbit', 0.5 * IN, 60)).toBe(true);
    expect(has('vbit', 0.5 * IN, 90)).toBe(true);
    expect(has('drill', 0.125 * IN)).toBe(true);
  });

  it('ids are unique and Carbide 3D tools carry their catalogue numbers', () => {
    expect(new Set(BUILTIN_TOOLS.map((t) => t.id)).size).toBe(BUILTIN_TOOLS.length);
    const numbers = BUILTIN_TOOLS.flatMap((t) => (t.vendor ? [t.vendor.number] : []));
    expect(numbers.sort()).toEqual([101, 102, 201, 251, 301, 302]);
    for (const t of BUILTIN_TOOLS) {
      if (t.vendor) expect(t.vendor.url).toMatch(/^https:\/\/shop\.carbide3d\.com\/products\//);
      expect(t.source.length).toBeGreaterThan(10);
    }
  });

  it('V-bit flute lengths are their cone heights', () => {
    for (const t of BUILTIN_TOOLS.filter((x) => x.kind === 'vbit')) {
      const half = ((t.angleDeg! / 2) * Math.PI) / 180;
      expect(t.fluteLength).toBeCloseTo(t.diameter / 2 / Math.tan(half), 3);
    }
  });

  it('the #201 presets are the Carbide 3D chart rows as printed, verified', () => {
    const t201 = tool('c3d-201');
    const ply = t201.presets.find((p) => p.category === 'plywood')!;
    expect(ply).toMatchObject({ unit: 'in', rpm: 18950, feed: 100, plunge: 50, stepdown: 0.25 });
    expect(ply.verified).toEqual({ feeds: true, stepdown: true, stepover: false });
    const mdf = t201.presets.find((p) => p.category === 'mdf')!;
    expect(mdf).toMatchObject({ rpm: 17000, feed: 80, plunge: 30, stepdown: 0.3 });
    const al = t201.presets.find((p) => p.category === 'aluminium')!;
    expect(al).toMatchObject({ rpm: 17500, feed: 30, plunge: 10, stepdown: 0.03 });
    for (const p of t201.presets) expect(p.source).toContain('S3_feeds_250.pdf');
  });

  it('derived presets keep the #201 chip load scaled by diameter, and are unverified', () => {
    const base = tool('c3d-201');
    for (const t of BUILTIN_TOOLS.filter((x) => x.id !== 'c3d-201' && x.kind !== 'drill')) {
      const effective = t.kind === 'vbit' ? 0.125 * IN : toMm(t.diameter, t.unit);
      const ratio = effective / (0.25 * IN);
      for (const p of t.presets) {
        const b = base.presets.find((x) => x.category === p.category)!;
        const got = unwrap(resolvePreset(t, p.category));
        const want = unwrap(resolvePreset(base, p.category)).chipLoad * ratio;
        // Feeds round to 1 in/min or 10 mm/min, so compare within that rounding.
        const step = t.unit === 'in' ? IN : 10;
        expect(Math.abs(got.chipLoad - want) * got.rpm * t.flutes).toBeLessThanOrEqual(
          step / 2 + 1e-9,
        );
        expect(p.rpm).toBe(b.rpm);
        expect(got.stepdown).toBeLessThanOrEqual(toMm(t.fluteLength, t.unit) + 1e-9);
        expect(p.verified).toEqual({ feeds: false, stepdown: false, stepover: false });
        expect(p.note).toMatch(/^Derived/);
      }
    }
  });

  it('a drill feeds at its plunge rate and pecks one diameter', () => {
    const d = tool('drill-1-8in');
    for (const p of d.presets) {
      expect(p.feed).toBe(p.plunge);
      expect(p.stepdown).toBe(0.125);
    }
  });

  it('every tool has a preset for every feed category, and they resolve in internal units', () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.presets.map((p) => p.category).sort()).toEqual(
        FEED_CATEGORIES.map((c) => c.id).sort(),
      );
      for (const c of FEED_CATEGORIES) {
        const r = unwrap(resolvePreset(t, c.id));
        const p = t.presets.find((x) => x.category === c.id)!;
        expect(r.feed).toBeCloseTo(toMm(p.feed, p.unit), 9);
        expect(r.plunge).toBeCloseTo(toMm(p.plunge, p.unit), 9);
        expect(r.stepdown).toBeCloseTo(toMm(p.stepdown, p.unit), 9);
        expect(r.chipLoad).toBeCloseTo(r.feed / (r.rpm * t.flutes), 12);
        expect(r.feed).toBeGreaterThan(0);
        expect(r.plunge).toBeGreaterThan(0);
      }
    }
  });

  it('flags unverified numbers for the UI', () => {
    expect(unverifiedToolFields(tool('c3d-201'))).toEqual(
      FEED_CATEGORIES.map((c) => `presets.${c.id}.stepover`),
    );
    const metric = unverifiedToolFields(tool('flat-3mm-2f'));
    expect(metric[0]).toBe('geometry');
    expect(metric).toContain('presets.plywood.feeds');
    const r = unwrap(resolvePreset(tool('c3d-201'), 'plywood'));
    expect(r.allVerified).toBe(false);
  });
});

describe('feed categories and materials', () => {
  it('every material maps to a category, and categories resolve to themselves', () => {
    const ids = new Set(FEED_CATEGORIES.map((c) => c.id));
    for (const [material, category] of Object.entries(MATERIAL_FEED_CATEGORY)) {
      expect(ids.has(category), material).toBe(true);
      expect(feedCategoryOf(material)).toBe(category);
    }
    for (const c of FEED_CATEGORIES) expect(feedCategoryOf(c.id)).toBe(c.id);
    expect(feedCategoryOf('unobtainium')).toBeUndefined();
    expect(feedCategoryOf('toString')).toBeUndefined();
  });

  it("steel resolves, with the maker's warning", () => {
    const r = unwrap(resolvePreset(tool('c3d-201'), 'steel'));
    expect(r.warning).toMatch(/not recommended/);
    expect(r.feed).toBeCloseTo(12 * IN, 9);
  });

  it('refuses an unknown material and a missing preset', () => {
    expect(resolvePreset(tool('c3d-201'), 'unobtainium').ok).toBe(false);
    const bare: LibraryTool = { ...tool('c3d-201'), presets: [] };
    const r = resolvePreset(bare, 'oak');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('hardwood');
  });

  it('finds a document tool preset by material or category', () => {
    const presets = [
      { material: 'hardwood', n: 1 },
      { material: 'plywood', n: 2 },
    ];
    expect(findPresetFor(presets, 'oak')?.n).toBe(1);
    expect(findPresetFor(presets, 'plywood')?.n).toBe(2);
    expect(findPresetFor(presets, 'mdf')).toBeUndefined();
    expect(findPresetFor(presets, 'nonsense')).toBeUndefined();
  });
});

describe('chip load calculator', () => {
  it('feed = rpm x flutes x chip load, and back', () => {
    expect(unwrap(feedFromChipLoad(18000, 2, 0.05))).toBeCloseTo(1800, 9);
    expect(unwrap(chipLoadFromFeed(1800, 18000, 2))).toBeCloseTo(0.05, 12);
    // The #201 plywood row: 100 in/min at 18950 rpm on 3 flutes.
    expect(unwrap(chipLoadFromFeed(100, 18950, 3))).toBeCloseTo(0.00176, 5);
  });

  it('refuses zero, negative, non-finite and fractional inputs', () => {
    for (const r of [
      feedFromChipLoad(0, 2, 0.05),
      feedFromChipLoad(18000, 0, 0.05),
      feedFromChipLoad(18000, 2, -1),
      feedFromChipLoad(Number.NaN, 2, 0.05),
      feedFromChipLoad(18000, 2.5, 0.05),
      chipLoadFromFeed(Number.POSITIVE_INFINITY, 18000, 2),
      chipLoadFromFeed(1000, 18000, 0),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-input');
    }
  });
});

describe('use in document', () => {
  it('copies a tool as expressions in its own unit, with its source and number', () => {
    const t = tool('c3d-302');
    const cam = libraryToolToCamTool(t, 'tool#3', BUILTIN_LIBRARY_ID);
    expect(cam).toMatchObject({
      id: 'tool#3',
      name: '#302 60 deg V-bit',
      kind: 'vbit',
      number: 302,
      flutes: 2,
      diameter: { source: '0.5in', lengthUnit: 'in', angleUnit: 'deg' },
      angle: { source: '60deg', lengthUnit: 'in', angleUnit: 'deg' },
      source: { library: 'builtin', id: 'c3d-302' },
    });
    expect(cam.presets).toHaveLength(t.presets.length);
    expect('cornerRadius' in cam).toBe(false);
    expect('tipDiameter' in cam).toBe(false);
    const metric = libraryToolToCamTool(tool('flat-6mm-2f'), 'tool#1', 'builtin');
    expect('number' in metric).toBe(false);
    expect(metric.diameter).toEqual({ source: '6mm', lengthUnit: 'mm', angleUnit: 'deg' });
  });

  it('every expression evaluates to the library value in internal units', () => {
    for (const t of BUILTIN_TOOLS) {
      const cam = libraryToolToCamTool(t, 'tool#1', BUILTIN_LIBRARY_ID);
      const length = (s: { source: string; lengthUnit: 'mm' | 'in' }) =>
        unwrap(parseLength(s.source, s.lengthUnit));
      expect(length(cam.diameter)).toBeCloseTo(toMm(t.diameter, t.unit), 9);
      expect(length(cam.fluteLength)).toBeCloseTo(toMm(t.fluteLength, t.unit), 9);
      if (t.angleDeg !== undefined) {
        expect(unwrap(parseAngle(cam.angle!.source))).toBeCloseTo((t.angleDeg * Math.PI) / 180, 12);
      }
      cam.presets.forEach((p, i) => {
        const r = unwrap(resolvePreset(t, t.presets[i]!.category));
        expect(p.material).toBe(r.category);
        expect(unwrap(parseSpindleSpeed(p.spindle.source))).toBeCloseTo(r.rpm, 9);
        expect(unwrap(parseFeed(p.feed.source, p.feed.lengthUnit))).toBeCloseTo(r.feed, 9);
        expect(unwrap(parseFeed(p.plunge.source, p.plunge.lengthUnit))).toBeCloseTo(r.plunge, 9);
        expect(length(p.stepdown)).toBeCloseTo(r.stepdown, 9);
        expect(Number(p.stepover.source)).toBe(r.stepover);
      });
    }
  });

  it('gives the evaluated tool in mm and radians', () => {
    const t = libraryToolToTool(tool('c3d-301'), 'tool#2');
    expect(t).toEqual({
      id: 'tool#2',
      name: '#301 90 deg V-bit',
      kind: 'vbit',
      number: 301,
      diameter: 12.7,
      fluteLength: 6.35,
      flutes: 2,
      angle: Math.PI / 2,
    });
  });
});
