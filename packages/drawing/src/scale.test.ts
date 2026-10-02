import { describe, expect, it } from 'vitest';
import {
  IMPERIAL_SCALES,
  METRIC_SCALES,
  chooseScale,
  formatScale,
  modelToPaper,
  paperToModel,
  parseScale,
  scaleFactor,
} from './scale';

describe('scale arithmetic', () => {
  it('converts model to paper millimetres', () => {
    expect(scaleFactor({ paper: 1, model: 5 })).toBe(0.2);
    expect(modelToPaper(100, { paper: 1, model: 5 })).toBe(20);
    expect(modelToPaper(10, { paper: 2, model: 1 })).toBe(20);
    expect(paperToModel(20, { paper: 1, model: 5 })).toBe(100);
  });

  it('reads 1-1/2" = 1\' as an eighth', () => {
    const r = parseScale('1-1/2" = 1\'');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(scaleFactor(r.scale)).toBeCloseTo(1 / 8, 12);
    // A 24" shelf is 3" on paper.
    expect(modelToPaper(609.6, r.scale)).toBeCloseTo(76.2, 9);
    expect(formatScale(r.scale)).toBe('1-1/2" = 1\'');
  });

  it('reads and writes the other imperial forms', () => {
    const r = parseScale('3/4" = 1\'-0"');
    expect(r.ok && scaleFactor(r.scale)).toBeCloseTo(1 / 16, 12);
    const s = parseScale("1 = 10'");
    expect(s.ok && scaleFactor(s.scale)).toBeCloseTo(1 / 120, 12);
    if (s.ok) expect(formatScale(s.scale)).toBe('1" = 10\'');
    expect(IMPERIAL_SCALES.map(formatScale)).toEqual([
      '3" = 1\'',
      '1-1/2" = 1\'',
      '1" = 1\'',
      '3/4" = 1\'',
      '1/2" = 1\'',
      '3/8" = 1\'',
      '1/4" = 1\'',
      '3/16" = 1\'',
      '1/8" = 1\'',
      '3/32" = 1\'',
      '1/16" = 1\'',
    ]);
  });

  it('reads and writes ratios', () => {
    expect(parseScale('1:5')).toEqual({ ok: true, scale: { paper: 1, model: 5 } });
    expect(parseScale(' 2 : 1 ')).toEqual({ ok: true, scale: { paper: 2, model: 1 } });
    expect(formatScale({ paper: 1, model: 2.5 })).toBe('1:2.5');
    expect(METRIC_SCALES.map(formatScale)).toContain('1:20');
  });

  it('reads metric paper = model scales as ratios, and round-trips them', () => {
    const r = parseScale('10 mm = 1 m');
    expect(r).toEqual({ ok: true, scale: { paper: 1, model: 100 } });
    if (!r.ok) return;
    expect(formatScale(r.scale)).toBe('1:100');
    expect(parseScale(formatScale(r.scale))).toEqual(r);
    expect(parseScale('5 cm = 1 cm')).toEqual({ ok: true, scale: { paper: 5, model: 1 } });
    // One metric side is enough to make it a ratio.
    const mixed = parseScale('1" = 1 m');
    expect(mixed.ok && mixed.scale.notation).toBeUndefined();
    expect(mixed.ok && scaleFactor(mixed.scale)).toBeCloseTo(25.4 / 1000, 12);
    // Inches and feet, in words or marks, stay imperial and round-trip.
    for (const text of ['1-1/2" = 1\'', '1 in = 1 ft', '3/4 inch = 1 foot']) {
      const s = parseScale(text);
      expect(s.ok && s.scale.notation).toBe('imperial');
      if (!s.ok) continue;
      const again = parseScale(formatScale(s.scale));
      expect(again.ok && scaleFactor(again.scale)).toBeCloseTo(scaleFactor(s.scale), 12);
      expect(again.ok && again.scale.notation).toBe('imperial');
    }
  });

  it('rejects nonsense', () => {
    expect(parseScale('1:0').ok).toBe(false);
    expect(parseScale('fish').ok).toBe(false);
    expect(parseScale('1" = 1 deg').ok).toBe(false);
    expect(parseScale('0" = 1\'').ok).toBe(false);
  });
});

describe('chooseScale', () => {
  it('takes the largest standard scale that fits', () => {
    expect(chooseScale({ width: 50, height: 40 }, { width: 120, height: 100 })).toEqual({
      paper: 2,
      model: 1,
    });
    expect(chooseScale({ width: 900, height: 1800 }, { width: 300, height: 250 })).toEqual({
      paper: 1,
      model: 10,
    });
    const bookshelf = chooseScale(
      { width: 914.4, height: 1828.8 },
      { width: 250, height: 250 },
      IMPERIAL_SCALES,
    );
    expect(formatScale(bookshelf)).toBe('1-1/2" = 1\'');
  });

  it('falls back to the smallest candidate', () => {
    expect(chooseScale({ width: 1e7, height: 1 }, { width: 10, height: 10 })).toEqual({
      paper: 1,
      model: 1000,
    });
  });
});
