import { describe, expect, it } from 'vitest';
import { csvField, csvTextField } from './csv';
import {
  UNIT_LABELS,
  exactLengthFormat,
  formatMeasure,
  formatRow,
  formatSize,
  isImperial,
} from './format';
import {
  MM3_PER_BOARD_FOOT,
  boardFeet,
  buildTakeoff,
  compareIds,
  lengthKey,
  mergeRows,
  mergeSources,
  scaleRow,
  sizeKey,
  totals,
  type TakeoffRow,
} from './takeoff';

const IN = 25.4;

function row(over: Partial<TakeoffRow> & Pick<TakeoffRow, 'key'>): TakeoffRow {
  return {
    item: 'Shelf',
    category: 'lumber',
    quantity: 1,
    unit: 'board-foot',
    extended: 1,
    measures: [],
    sources: [{ id: 'b1', quantity: 1 }],
    flags: [],
    ...over,
  };
}

describe('board feet', () => {
  it('counts a nominal 2x4x8 as 5.33 and a 1x12x12 as 12', () => {
    expect(boardFeet(2 * IN, 4 * IN, 96 * IN)).toBeCloseTo(16 / 3, 12);
    expect(boardFeet(1 * IN, 12 * IN, 144 * IN)).toBeCloseTo(12, 12);
    expect(MM3_PER_BOARD_FOOT).toBeCloseTo(2359737.216, 6);
  });
});

describe('keys', () => {
  it('groups sizes that differ only by floating point noise', () => {
    expect(lengthKey(600)).toBe(lengthKey(600 + 1e-10));
    expect(lengthKey(-0)).toBe('0');
    expect(lengthKey(600)).not.toBe(lengthKey(600.001));
    expect(sizeKey({ length: 600, width: 300, thickness: 18 })).toBe(
      sizeKey({ length: 600.0000000001, width: 299.9999999999, thickness: 18 }),
    );
    expect(sizeKey({ length: 1, width: 2 })).not.toBe(sizeKey({ length: 1, thickness: 2 }));
    expect(sizeKey(undefined)).toBe('-');
  });

  it('orders ids naturally', () => {
    const ids = ['extension#10', 'extension#2', 'extension#1'];
    expect(ids.sort(compareIds)).toEqual(['extension#1', 'extension#2', 'extension#10']);
  });
});

describe('merging rows', () => {
  it('adds quantities, extended values, measures and sources of rows with one key', () => {
    const merged = mergeRows([
      row({
        key: 'a',
        extended: 2,
        measures: [{ unit: 'length', value: 100 }],
        sources: [{ id: 'extension#10', part: 'p', quantity: 1 }],
        flags: ['z'],
      }),
      row({ key: 'b', item: 'Side' }),
      row({
        key: 'a',
        item: 'Top',
        extended: 3,
        measures: [{ unit: 'length', value: 50 }],
        sources: [
          { id: 'extension#2', part: 'p', quantity: 1 },
          { id: 'extension#10', part: 'p', quantity: 1 },
        ],
        flags: ['a', 'z'],
      }),
    ]);
    expect(merged.map((r) => r.key)).toEqual(['a', 'b']);
    expect(merged[0]).toMatchObject({
      item: 'Shelf, Top',
      quantity: 2,
      extended: 5,
      measures: [{ unit: 'length', value: 150 }],
      sources: [
        { id: 'extension#2', part: 'p', quantity: 1 },
        { id: 'extension#10', part: 'p', quantity: 2 },
      ],
      flags: ['a', 'z'],
    });
  });

  it('keeps sources of different instances apart and leaves its input alone', () => {
    const input = [
      row({ key: 'a', sources: [{ id: 'b', part: 'p', instance: 'inst#1', quantity: 1 }] }),
      row({ key: 'a', sources: [{ id: 'b', part: 'p', instance: 'inst#2', quantity: 1 }] }),
    ];
    const copy = structuredClone(input);
    const [merged] = mergeRows(input);
    expect(merged!.sources.map((s) => s.instance)).toEqual(['inst#1', 'inst#2']);
    expect(input).toEqual(copy);
  });

  it('refuses rows of one key in two units', () => {
    expect(() => mergeRows([row({ key: 'a' }), row({ key: 'a', unit: 'area' })])).toThrow(
      /mix the units/,
    );
  });

  it('merges sources and scales rows', () => {
    expect(
      mergeSources([
        { id: 'j', quantity: 4 },
        { id: 'j', quantity: 4 },
        { id: 'i', part: 'p', quantity: 1 },
      ]),
    ).toEqual([
      { id: 'j', quantity: 8 },
      { id: 'i', part: 'p', quantity: 1 },
    ]);
    const scaled = scaleRow(row({ key: 'a', measures: [{ unit: 'length', value: 10 }] }), 3);
    expect(scaled).toMatchObject({
      quantity: 3,
      extended: 3,
      measures: [{ unit: 'length', value: 30 }],
      sources: [{ id: 'b1', quantity: 3 }],
    });
  });
});

describe('totals', () => {
  it('totals per group and unit, measures included', () => {
    const rows = [
      row({ key: 'a', quantity: 4, extended: 11.5, measures: [{ unit: 'length', value: 1000 }] }),
      row({ key: 'b', category: 'sheet', unit: 'area', extended: 2e6, quantity: 2 }),
      row({ key: 'c', category: 'sheet', unit: 'area', extended: 1e6 }),
      row({ key: 'd', quantity: 2, extended: 2.5 }),
    ];
    expect(totals(rows)).toEqual([
      { group: '', unit: 'board-foot', value: 14, quantity: 6 },
      { group: '', unit: 'area', value: 3e6, quantity: 3 },
      { group: '', unit: 'length', value: 1000, quantity: 4 },
    ]);
    expect(buildTakeoff(rows).totals).toEqual([
      { group: 'lumber', unit: 'board-foot', value: 14, quantity: 6 },
      { group: 'lumber', unit: 'length', value: 1000, quantity: 4 },
      { group: 'sheet', unit: 'area', value: 3e6, quantity: 3 },
    ]);
  });
});

describe('formatting', () => {
  const frac = { unit: 'in-fraction', denominator: 32 } as const;

  it('formats a blank in fractions and in millimetres', () => {
    const size = { length: 72 * IN, width: 11.25 * IN, thickness: (23 / 32) * IN };
    expect(formatSize(size, frac)).toBe('72" x 11-1/4" x 23/32"');
    expect(formatSize(size, { unit: 'ft-in', denominator: 32 })).toBe(`6' 0" x 11-1/4" x 23/32"`);
    expect(
      formatSize({ length: 600, width: 300, thickness: 18 }, { unit: 'mm', decimals: 1 }),
    ).toBe('600.0 mm x 300.0 mm x 18.0 mm');
    expect(formatSize({ diameter: 8, length: 32 }, { unit: 'mm', decimals: 0 })).toBe(
      'Ø8 mm x 32 mm',
    );
    expect(formatSize(undefined, frac)).toBe('');
  });

  it('formats measures by unit and by the document units', () => {
    expect(formatMeasure({ unit: 'board-foot', value: 16 / 3 }, frac)).toBe('5.33 bd ft');
    expect(formatMeasure({ unit: 'area', value: 72 * 11.25 * IN * IN * 2 }, frac)).toBe(
      '11.25 sq ft',
    );
    expect(formatMeasure({ unit: 'area', value: 1.22 * 2.44 * 1e6 }, { unit: 'mm' })).toBe(
      '2.977 m²',
    );
    expect(formatMeasure({ unit: 'volume', value: IN ** 3 * 10 }, frac)).toBe('10.0 in³');
    expect(formatMeasure({ unit: 'volume', value: 12345 }, { unit: 'cm' })).toBe('12 cm³');
    expect(formatMeasure({ unit: 'length', value: 138 * IN }, frac)).toBe('138"');
    expect(formatMeasure({ unit: 'length', value: 138 * IN }, { unit: 'ft-in' })).toBe(`11' 6"`);
    expect(formatMeasure({ unit: 'sheet', value: 1 }, frac)).toBe('1 sheet');
    expect(formatMeasure({ unit: 'sheet', value: 2.5 }, frac)).toBe('2.5 sheets');
    expect(formatMeasure({ unit: 'each', value: 32 }, frac)).toBe('32 pcs');
    expect(isImperial({ unit: 'ft' })).toBe(true);
    expect(isImperial({ unit: 'm' })).toBe(false);
  });

  it('formats a row', () => {
    const r = row({
      key: 'a',
      stock: 'us-1x12',
      size: { length: 34.5 * IN, width: 11.25 * IN, thickness: 0.75 * IN },
      quantity: 4,
      extended: 11.5,
      measures: [{ unit: 'length', value: 138 * IN }],
    });
    expect(formatRow(r, frac, (id) => (id === 'us-1x12' ? '1x12' : id))).toEqual({
      item: 'Shelf',
      stock: '1x12',
      size: '34-1/2" x 11-1/4" x 3/4"',
      quantity: '4',
      extended: '11.50 bd ft',
      measures: ['138"'],
    });
    expect(formatRow(row({ key: 'b' }), frac).stock).toBe('');
  });
});

describe('mass', () => {
  const frac = { unit: 'in-fraction', denominator: 32 } as const;
  const LB = 0.45359237;

  it('formats a mass in kg or lb by the length format, or in the chosen unit', () => {
    expect(formatMeasure({ unit: 'mass', value: 2.35 }, { unit: 'mm' })).toBe('2.350 kg');
    expect(formatMeasure({ unit: 'mass', value: 2.35 }, { unit: 'm' })).toBe('2.350 kg');
    expect(formatMeasure({ unit: 'mass', value: 5 * LB }, frac)).toBe('5.000 lb');
    expect(formatMeasure({ unit: 'mass', value: 5 * LB }, { unit: 'ft-in' })).toBe('5.000 lb');
    expect(formatMeasure({ unit: 'mass', value: 0.25 }, { unit: 'mm' }, { mass: 'g' })).toBe(
      '250.0 g',
    );
    expect(formatMeasure({ unit: 'mass', value: 0.25 }, frac, { mass: 'kN' })).toBe('0.551 lb');
  });

  it('totals mass rows and measures, after volume', () => {
    const rows = [
      row({
        key: 'motor',
        category: 'part',
        unit: 'each',
        extended: 1,
        measures: [{ unit: 'mass', value: 1.2 }],
      }),
      row({
        key: 'frame',
        category: 'part',
        unit: 'mass',
        extended: 3.4,
        quantity: 2,
        measures: [{ unit: 'volume', value: 1e6 }],
      }),
    ];
    expect(totals(rows)).toEqual([
      { group: '', unit: 'volume', value: 1e6, quantity: 2 },
      { group: '', unit: 'mass', value: 4.6, quantity: 3 },
      { group: '', unit: 'each', value: 1, quantity: 1 },
    ]);
    expect(scaleRow(rows[1]!, 2).extended).toBe(6.8);
  });

  it('formats a weight row in the chosen unit', () => {
    const r = row({ key: 'frame', item: 'Frame', unit: 'mass', extended: 3.4, quantity: 2 });
    expect(formatRow(r, { unit: 'mm' }).extended).toBe('3.400 kg');
    expect(formatRow(r, { unit: 'mm' }, undefined, { mass: 'lb' }).extended).toBe('7.496 lb');
    expect(UNIT_LABELS.mass).toBe('Mass');
  });
});

describe('takeoff files', () => {
  it('show fractional sizes to 1/64" and other formats as they are', () => {
    expect(exactLengthFormat({ unit: 'in-fraction', denominator: 16 })).toEqual({
      unit: 'in-fraction',
      denominator: 64,
    });
    expect(exactLengthFormat({ unit: 'ft-in', denominator: 8 })).toEqual({
      unit: 'ft-in',
      denominator: 64,
    });
    expect(exactLengthFormat({ unit: 'mm', decimals: 1 })).toEqual({ unit: 'mm', decimals: 1 });
  });

  it('quote CSV fields that need it, and keep text a spreadsheet would run as text', () => {
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField(-1.5)).toBe('-1.5');
    expect(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', 'Side 1'].map(csvTextField)).toEqual([
      "'=1+1",
      "'+1",
      "'-1",
      "'@SUM(A1)",
      "'\tx",
      'Side 1',
    ]);
  });
});
