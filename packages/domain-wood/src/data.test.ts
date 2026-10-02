import { describe, expect, it } from 'vitest';
import { findStock } from './catalog';
import { migrate, type Json, type Versioned } from './migrations';
import {
  EMPTY_STOCK_DATA,
  readStockData,
  resolveStock,
  writeStockData,
  type StoredStockOverride,
} from './stock-data';
import { DEFAULT_WOOD_SETTINGS, readWoodData, woodSettings, writeWoodData } from './wood-data';

// A JSON-shaped expression (an inferred type, so it also fits where stored JSON is expected).
const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });
const inch = (source: string) => ({ source, lengthUnit: 'in' as const, angleUnit: 'deg' as const });

describe('migrations', () => {
  const doubled: Versioned = {
    what: 'test data',
    migrations: [
      // 1 -> 2: rename `a` to `b`.
      (v) => ({ ok: true, value: { b: (v as { a: Json }).a } }),
      // 2 -> 3: refuse a negative `b`, else wrap it.
      (v) => {
        const b = (v as { b: number }).b;
        return b < 0 ? { ok: false, message: 'b is negative' } : { ok: true, value: { c: [b] } };
      },
    ],
  };

  it('runs every step from the stored version to the current one', () => {
    expect(migrate(doubled, { a: 2 }, 1)).toEqual({ ok: true, value: { c: [2] } });
    expect(migrate(doubled, { b: 3 }, 2)).toEqual({ ok: true, value: { c: [3] } });
    expect(migrate(doubled, { c: [4] }, 3)).toEqual({ ok: true, value: { c: [4] } });
  });

  it('refuses newer and malformed versions, and reports a refusing or throwing step', () => {
    expect(migrate(doubled, {}, 4)).toMatchObject({
      ok: false,
      message: expect.stringContaining('newer'),
    });
    expect(migrate(doubled, {}, 0)).toMatchObject({ ok: false });
    expect(migrate(doubled, {}, 1.5)).toMatchObject({ ok: false });
    expect(migrate(doubled, { a: -1 }, 1)).toMatchObject({
      ok: false,
      message: 'test data: migrating from version 2: b is negative',
    });
    const throwing: Versioned = {
      what: 'x',
      migrations: [
        () => {
          throw new Error('boom');
        },
      ],
    };
    expect(migrate(throwing, {}, 1)).toMatchObject({
      ok: false,
      message: expect.stringContaining('boom'),
    });
  });
});

describe('domains.stock', () => {
  it('reads overrides as stored and evaluated', () => {
    const r = readStockData(
      {
        overrides: {
          'us-ply-23-32': {
            thickness: mm('18.2mm'),
            sheet: { length: inch('97'), width: inch('49') },
            price: { amount: 62.5, per: 'sheet', currency: 'USD' },
          },
          'us-2x4': { width: inch('3 + 9/16') },
        },
      },
      1,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.overrides.get('us-ply-23-32')).toEqual({
      thickness: 18.2,
      sheet: { length: 97 * 25.4, width: 49 * 25.4 },
      price: { amount: 62.5, per: 'sheet', currency: 'USD' },
    });
    expect(r.value.overrides.get('us-2x4')!.width).toBeCloseTo((3 + 9 / 16) * 25.4, 12);
    expect(r.value.stored.get('us-ply-23-32')!.thickness).toEqual(mm('18.2mm'));
    expect(readStockData({}, 1)).toEqual({ ok: true, value: EMPTY_STOCK_DATA });
  });

  it('refuses variables, non-lengths, bad prices, unknown fields and newer versions', () => {
    const one = (override: Json) => readStockData({ overrides: { 'us-2x4': override } }, 1);
    expect(one({ thickness: mm('#ply - 0.3mm') })).toMatchObject({
      ok: false,
      field: ['overrides', 'us-2x4', 'thickness'],
      message: expect.stringContaining('#ply is a variable'),
    });
    expect(one({ thickness: mm('30deg') })).toMatchObject({ ok: false });
    expect(one({ thickness: mm('0') })).toMatchObject({
      ok: false,
      message: 'expected a length above zero',
    });
    expect(one({ thickness: mm('1 +') })).toMatchObject({ ok: false });
    expect(one({ thickness: { source: '1', lengthUnit: 'yd', angleUnit: 'deg' } })).toMatchObject({
      ok: false,
      field: ['overrides', 'us-2x4', 'thickness', 'lengthUnit'],
    });
    expect(one({ price: { amount: -1, per: 'piece' } })).toMatchObject({
      ok: false,
      field: ['overrides', 'us-2x4', 'price', 'amount'],
    });
    expect(one({ price: { amount: 1, per: 'bushel' } })).toMatchObject({ ok: false });
    expect(one({ price: { amount: 1, per: 'piece', currency: 'dollars' } })).toMatchObject({
      ok: false,
    });
    expect(one({ colour: 'red' })).toMatchObject({
      ok: false,
      field: ['overrides', 'us-2x4', 'colour'],
    });
    expect(readStockData({ overrides: [] }, 1)).toMatchObject({ ok: false, field: ['overrides'] });
    expect(readStockData([], 1)).toMatchObject({ ok: false });
    expect(readStockData({}, 2)).toMatchObject({
      ok: false,
      message: expect.stringContaining('newer'),
    });
  });

  it('treats inherited-looking keys as plain data', () => {
    const data = JSON.parse(
      '{"overrides":{"__proto__":{"thickness":{"source":"5","lengthUnit":"mm","angleUnit":"deg"}}}}',
    ) as Json;
    const r = readStockData(data, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.overrides.get('__proto__')).toEqual({ thickness: 5 });
    expect(resolveStock('constructor', r.value)).toBeUndefined();
  });

  it('resolves a stock with its override, keeping catalog values elsewhere', () => {
    const data = readStockData(
      {
        overrides: {
          'us-ply-23-32': { thickness: mm('18.2') },
          'not-in-this-build': { thickness: mm('3') },
        },
      },
      1,
    );
    expect(data.ok).toBe(true);
    if (!data.ok) return;
    const ply = resolveStock('us-ply-23-32', data.value)!;
    expect(ply.thickness).toBe(18.2);
    expect(ply.sheet).toEqual(findStock('us-ply-23-32')!.sheet);
    expect(ply.overridden).toEqual({ thickness: true, width: false, sheet: false, price: false });
    const stud = resolveStock('us-2x4', data.value)!;
    expect(stud.thickness).toBe(1.5 * 25.4);
    expect(stud.width).toBe(3.5 * 25.4);
    expect(stud.overridden.thickness).toBe(false);
    expect(resolveStock('us-hw-4-4')!.width).toBeUndefined();
    expect(resolveStock('not-in-this-build', data.value)).toBeUndefined();
  });

  it('writes sorted overrides at the current version, and nothing for none', () => {
    const overrides = new Map<string, StoredStockOverride>([
      ['us-2x4', { price: { amount: 4, per: 'piece' } }],
      ['mm-ply-18', { thickness: mm('17.6') }],
      ['us-1x6', {}],
    ]);
    const entry = writeStockData(overrides)!;
    expect(entry.schemaVersion).toBe(1);
    expect(Object.keys((entry.data as { overrides: object }).overrides)).toEqual([
      'mm-ply-18',
      'us-2x4',
    ]);
    const back = readStockData(entry.data, entry.schemaVersion);
    expect(back.ok && back.value.overrides.get('mm-ply-18')).toEqual({ thickness: 17.6 });
    expect(writeStockData(new Map())).toBeUndefined();
  });
});

describe('domains.wood', () => {
  it('reads settings over the defaults', () => {
    const r = readWoodData(
      {
        kerf: inch('3/32'),
        sheetTrims: { lengthStart: mm('10'), widthEnd: mm('5') },
        lumberTrims: { start: inch('1') },
        maxStages: 3,
        grain: 'ignore',
      },
      1,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.settings).toEqual({
      kerf: (3 / 32) * 25.4,
      sheetTrims: { lengthStart: 10, lengthEnd: 0, widthStart: 0, widthEnd: 5 },
      lumberTrims: { start: 25.4, end: 0 },
      maxStages: 3,
      grain: 'ignore',
    });
    expect(woodSettings(undefined)).toEqual({ ok: true, value: DEFAULT_WOOD_SETTINGS });
    expect(woodSettings({ schemaVersion: 1, data: {} })).toEqual({
      ok: true,
      value: DEFAULT_WOOD_SETTINGS,
    });
  });

  it('refuses bad settings with the field at fault', () => {
    expect(readWoodData({ kerf: mm('#kerf') }, 1)).toMatchObject({ ok: false, field: ['kerf'] });
    expect(readWoodData({ kerf: mm('-1') }, 1)).toMatchObject({ ok: false, field: ['kerf'] });
    expect(readWoodData({ maxStages: 0 }, 1)).toMatchObject({ ok: false, field: ['maxStages'] });
    expect(readWoodData({ maxStages: 2.5 }, 1)).toMatchObject({ ok: false, field: ['maxStages'] });
    expect(readWoodData({ maxStages: 'unlimited' }, 1)).toMatchObject({ ok: true });
    expect(readWoodData({ grain: 'sideways' }, 1)).toMatchObject({ ok: false, field: ['grain'] });
    expect(readWoodData({ sheetTrims: { top: mm('1') } }, 1)).toMatchObject({
      ok: false,
      field: ['sheetTrims', 'top'],
    });
    expect(readWoodData({ blade: 'x' }, 1)).toMatchObject({ ok: false, field: ['blade'] });
    expect(readWoodData(null, 1)).toMatchObject({ ok: false });
    expect(readWoodData({}, 2)).toMatchObject({ ok: false });
  });

  it('writes what the document sets and round-trips it', () => {
    const entry = writeWoodData({
      kerf: mm('3'),
      sheetTrims: { widthEnd: mm('5'), lengthStart: mm('10') },
      grain: 'respect',
    })!;
    expect(entry).toEqual({
      schemaVersion: 1,
      data: {
        kerf: mm('3'),
        sheetTrims: { lengthStart: mm('10'), widthEnd: mm('5') },
        grain: 'respect',
      },
    });
    const back = readWoodData(entry.data, 1);
    expect(back.ok && back.value.settings.kerf).toBe(3);
    expect(writeWoodData({})).toBeUndefined();
  });
});
