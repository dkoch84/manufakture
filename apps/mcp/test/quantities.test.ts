// get_quantities' options as pure functions (src/quantities.ts), on hand-made quantities: which
// lists and rows are kept, what a category filter does to a takeoff's cost, subtotals and
// layouts, what `detail: false` leaves out, and that no option gives the quantities as they are.
// The tool itself, on the shed, is in scenarios/remodel-frame.test.ts.

import type { Quantities } from '@manufakture/session';
import { describe, expect, it } from 'vitest';
import { narrowed, optionProblem, quantityView, scopeOf } from '../src/quantities';

const row = (key: string, category: string, extra: Record<string, unknown> = {}) => ({
  key,
  item: key,
  category,
  quantity: 1,
  unit: 'each',
  extended: 1,
  measures: [],
  sources: [{ id: `${key}:src`, quantity: 1 }],
  flags: [],
  ...extra,
});

const total = (group: string) => ({ group, unit: 'each', value: 1, quantity: 1 });

function sample(): Quantities {
  const hardware = [row('dowel', 'hardware')];
  return {
    reviewed: false,
    cutList: {
      rows: [row('shelf', 'sheet', { stock: 'ply' }), row('rail', 'lumber', { stock: 'oak' })],
      hardware,
      totals: [total('sheet'), total('lumber'), total('hardware')],
      stockTotals: [total('ply'), total('oak')],
      sheets: [{ stock: 'ply' }],
      lumber: [{ stock: 'oak' }],
      excluded: [{ part: 'part#1', bodyId: 'b', reason: 'no-material' }],
      missing: [],
    },
    hardware,
    takeoffs: [
      {
        partId: 'part#2',
        notes: [],
        takeoff: {
          rows: [
            row('stud', 'framing'),
            row('2x4', 'lumber', { cost: 5 }),
            row('osb', 'sheet', { cost: 30 }),
            row('2x6', 'lumber'),
          ],
          totals: [total('framing'), total('lumber'), total('sheet')],
          cost: { total: 35, unpriced: ['2x6'] },
          subtotals: [{ kind: 'feature', id: 'extension#1', totals: [total('')] }],
          faces: [{ face: 'f' }],
          sheets: [{ stock: 'osb' }],
          lumber: [{ stock: '2x4' }],
          disclaimer: 'Not an engineering tool.',
        },
      },
    ],
    notes: ['a note'],
  } as unknown as Quantities;
}

describe('get_quantities options', () => {
  it('gives the quantities as they are with no option', () => {
    const q = sample();
    expect(quantityView(q, {})).toEqual(q);
    expect(quantityView(q, { compare: false })).toEqual(q);
    expect(narrowed(q, {})).toEqual(q);
  });

  it('keeps only the lists asked for, leaving the others out', () => {
    const v = quantityView(sample(), { lists: ['takeoffs'] });
    expect(Object.keys(v).sort()).toEqual(['notes', 'reviewed', 'takeoffs']);
    const h = quantityView(sample(), { lists: ['hardware'] });
    expect(Object.keys(h).sort()).toEqual(['hardware', 'notes', 'reviewed']);
    // The delta's input keeps the session's shape: hardware alone, no boards.
    const n = narrowed(sample(), { lists: ['hardware'] });
    expect(n.cutList!.rows).toEqual([]);
    expect(n.cutList!.hardware).toHaveLength(1);
    expect(n.cutList!.totals.map((t) => t.group)).toEqual(['hardware']);
    expect(n.cutList!.stockTotals).toEqual([]);
    expect(n.takeoffs).toEqual([]);
  });

  it('keeps rows and totals of the categories asked for, with the cost of what is kept', () => {
    const n = narrowed(sample(), { categories: ['lumber'] });
    expect(n.cutList!.rows.map((r) => r.key)).toEqual(['rail']);
    expect(n.cutList!.stockTotals.map((t) => t.group)).toEqual(['oak']);
    expect(n.cutList!.sheets).toEqual([]);
    expect(n.cutList!.lumber).toHaveLength(1);
    expect(n.hardware).toEqual([]);
    const t = n.takeoffs[0]!.takeoff;
    expect(t.rows.map((r) => r.key)).toEqual(['2x4', '2x6']);
    expect(t.totals.map((x) => x.group)).toEqual(['lumber']);
    expect(t.cost).toEqual({ total: 5, unpriced: ['2x6'] });
    expect(t.subtotals).toEqual([]);
    expect([t.faces, t.sheets, t.lumber.length]).toEqual([[], [], 1]);
  });

  it('leaves out sources and layouts without detail', () => {
    const v = quantityView(sample(), { detail: false }) as unknown as Quantities;
    const t = v.takeoffs[0]!.takeoff as unknown as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual(['cost', 'disclaimer', 'rows', 'subtotals', 'totals']);
    expect(v.takeoffs[0]!.takeoff.rows.every((r) => !('sources' in r))).toBe(true);
    expect(v.cutList).not.toHaveProperty('sheets');
    expect(v.cutList).not.toHaveProperty('lumber');
    expect(v.cutList!.rows.every((r) => !('sources' in r))).toBe(true);
    expect(v.hardware.every((r) => !('sources' in r))).toBe(true);
    expect(v.cutList!.excluded).toHaveLength(1);
  });

  it('scopes to owners, with only the takeoffs', () => {
    expect(scopeOf({})).toEqual({});
    expect(scopeOf({ owner: 'extension#2' })).toEqual({ owners: ['extension#2'] });
    expect(scopeOf({ owner: ['extension#2', 'extension#2', 'extension#10'] })).toEqual({
      owners: ['extension#2', 'extension#10'],
    });
    const v = quantityView({ ...sample(), cutList: null, hardware: [] }, { owner: 'extension#2' });
    expect(Object.keys(v).sort()).toEqual(['notes', 'reviewed', 'takeoffs']);
    expect(optionProblem({ owner: 'extension#2', lists: ['takeoffs'] })).toBeNull();
    expect(optionProblem({ owner: 'extension#2', lists: ['cutList'] })).toMatch(/only takeoffs/);
  });
});
