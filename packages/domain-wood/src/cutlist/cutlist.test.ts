// The cut list against hand-computed fixtures (M4 plan T4.3a acceptance): a bookshelf's rows,
// quantities, board feet and hardware; grouping; assemblies (a part inserted twice, per-board
// instances); configurations; bodies that are not boards; board feet by basis; layout inputs.
// Board and joint metadata are fixtures here; `regen.test.ts` builds them with the real kernel.

import type { Part } from '@manufakture/core';
import { formatRow, totals } from '@manufakture/takeoff';
import { describe, expect, it } from 'vitest';
import type { BoardMetadata } from '../board';
import { findStock } from '../catalog';
import type { JointMetadata } from '../joints';
import { readStockData } from '../stock-data';
import { blankBoardFeet } from './board-feet';
import { cutList, stockName, type CutList, type CutListRow } from './cutlist';
import { cutListPart } from './from-regen';
import type { CutListFeature, CutListInput, CutListPart } from './input';

const IN = 25.4;
const SQ_IN = IN * IN;
const FRAC = { unit: 'in-fraction', denominator: 32 } as const;

/** A board's metadata: `size` is [length, width, thickness] in inches unless `mm` is set. */
function board(
  stock: string,
  size: readonly [number, number, number],
  form: 'panel' | 'stick' = 'panel',
  unit = IN,
): BoardMetadata {
  const entry = findStock(stock)!;
  const [length, width, thickness] = size.map((x) => x * unit) as [number, number, number];
  return {
    form,
    stock,
    material: entry.material,
    grain: entry.grain,
    frame: {
      origin: [0, 0, 0],
      axes: { length: [1, 0, 0], width: [0, 1, 0], thickness: [0, 0, 1] },
      size: { length, width, thickness },
    },
    overridden: { thickness: false, width: false },
  };
}

function boardFeature(id: string, name: string, meta: BoardMetadata): CutListFeature {
  return { featureId: id, name, metadata: meta };
}

const dowels = (id: string, a: string, b: string): CutListFeature => ({
  featureId: id,
  name: id,
  metadata: {
    kind: 'dowel',
    a,
    b,
    hardware: [{ item: 'dowel', diameter: 8, length: 32, quantity: 4 }],
    warnings: [],
    details: {},
  } satisfies JointMetadata,
});

const pockets = (id: string, a: string, b: string): CutListFeature => ({
  featureId: id,
  name: id,
  metadata: {
    kind: 'pocket-screw',
    a,
    b,
    hardware: [{ item: 'pocket-screw', length: 1.25 * IN, quantity: 3 }],
    warnings: [],
    details: {},
  } satisfies JointMetadata,
});

/** A part whose bodies are the given board features (body id = feature id), plus `extra` features. */
function part(id: string, boards: CutListFeature[], extra: CutListFeature[] = []): CutListPart {
  return {
    id,
    name: id,
    bodies: boards.map((f) => ({ bodyId: f.featureId, creator: f.featureId })),
    features: [...boards, ...extra],
  };
}

/**
 * The bookshelf: two 3/4" plywood sides 72" x 11-1/4", four 1x12 shelves 34-1/2" long, a 1/4"
 * plywood back 72" x 36"; each shelf doweled to both sides (8 joints of 4 dowels), and two
 * shelves pocket-screwed to the back (2 joints of 3 screws).
 */
function bookshelf(shelfWidth = 11.25): CutListPart {
  const side = board('us-ply-23-32', [72, 11.25, 23 / 32]);
  const shelf = board('us-1x12', [34.5, shelfWidth, 0.75], 'stick');
  const boards = [
    boardFeature('extension#1', 'Left side', side),
    boardFeature('extension#2', 'Right side', side),
    boardFeature('extension#3', 'Shelf 1', shelf),
    boardFeature('extension#4', 'Shelf 2', shelf),
    boardFeature('extension#5', 'Shelf 3', shelf),
    boardFeature('extension#6', 'Shelf 4', shelf),
    boardFeature('extension#7', 'Back', board('us-ply-7-32', [72, 36, 7 / 32])),
  ];
  const joints: CutListFeature[] = [];
  let n = 8;
  for (const s of ['extension#3', 'extension#4', 'extension#5', 'extension#6']) {
    joints.push(dowels(`extension#${n++}`, 'extension#1', s));
    joints.push(dowels(`extension#${n++}`, 'extension#2', s));
  }
  joints.push(pockets('extension#16', 'extension#4', 'extension#7'));
  joints.push(pockets('extension#17', 'extension#5', 'extension#7'));
  return part('part#1', boards, joints);
}

/** The parts of a list that a hand calculation checks, without sources. */
const summary = (rows: readonly CutListRow[]) =>
  rows.map((r) => ({
    item: r.item,
    stock: r.stock,
    category: r.category,
    quantity: r.quantity,
    unit: r.unit,
    extended: r.extended,
  }));

const sourceIds = (r: CutListRow) => r.sources.map((s) => `${s.instance ?? '-'}/${s.id}`);

describe('a bookshelf, by hand', () => {
  const list = cutList({ parts: [bookshelf()] });

  it('gives a row per stock and blank, with quantities, areas and board feet', () => {
    // Sheets first, by catalog order (1/4" before 3/4" plywood), then lumber.
    expect(list.rows.map((r) => r.stock)).toEqual(['us-ply-7-32', 'us-ply-23-32', 'us-1x12']);
    const [back, sides, shelves] = list.rows as [CutListRow, CutListRow, CutListRow];

    // Back: 72 x 36 = 2592 sq in = 18 sq ft.
    expect(back).toMatchObject({ item: 'Back', quantity: 1, unit: 'area', category: 'sheet' });
    expect(back.extended / SQ_IN).toBeCloseTo(2592, 9);
    // Sides: 2 x 72 x 11-1/4 = 1620 sq in = 11.25 sq ft.
    expect(sides).toMatchObject({ item: 'Left side, Right side', quantity: 2, unit: 'area' });
    expect(sides.extended / SQ_IN).toBeCloseTo(1620, 9);
    expect(sides.size!.thickness).toBeCloseTo((23 / 32) * IN, 12);
    // Shelves: 1x12 is counted on nominal 1" x 12": 1 x 12 x 34.5 / 144 = 2.875 each, 11.5 in all,
    // and 4 x 34-1/2" = 138" of length.
    expect(shelves).toMatchObject({
      item: 'Shelf 1, Shelf 2, Shelf 3, Shelf 4',
      quantity: 4,
      unit: 'board-foot',
      category: 'lumber',
      flags: [],
    });
    expect(shelves.extended).toBeCloseTo(11.5, 12);
    expect(shelves.measures).toHaveLength(1);
    expect(shelves.measures[0]!.unit).toBe('length');
    expect(shelves.measures[0]!.value / IN).toBeCloseTo(138, 9);
    expect(sourceIds(shelves)).toEqual([
      '-/extension#3',
      '-/extension#4',
      '-/extension#5',
      '-/extension#6',
    ]);
  });

  it('lists the hardware: 32 dowels and 6 pocket screws', () => {
    expect(summary(list.hardware)).toEqual([
      {
        item: 'Dowel',
        stock: undefined,
        category: 'hardware',
        quantity: 32,
        unit: 'each',
        extended: 32,
      },
      {
        item: 'Pocket screw',
        stock: undefined,
        category: 'hardware',
        quantity: 6,
        unit: 'each',
        extended: 6,
      },
    ]);
    expect(list.hardware[0]!.size).toEqual({ diameter: 8, length: 32 });
    expect(list.hardware[0]!.sources).toHaveLength(8);
    expect(list.hardware[1]!.sources).toEqual([
      { id: 'extension#16', part: 'part#1', quantity: 3 },
      { id: 'extension#17', part: 'part#1', quantity: 3 },
    ]);
  });

  it('totals: 29.25 sq ft of sheets, 11.5 board feet, 38 pieces of hardware', () => {
    const t = (group: string, unit: string) =>
      list.totals.find((x) => x.group === group && x.unit === unit)!;
    expect(t('sheet', 'area').value / SQ_IN / 144).toBeCloseTo(29.25, 9);
    expect(t('sheet', 'area').quantity).toBe(3);
    expect(t('lumber', 'board-foot').value).toBeCloseTo(11.5, 12);
    expect(t('lumber', 'length').value / IN).toBeCloseTo(138, 9);
    expect(t('hardware', 'each')).toMatchObject({ value: 38, quantity: 38 });
    expect(list.stockTotals.map((x) => [x.group, x.unit])).toEqual([
      ['us-ply-7-32', 'area'],
      ['us-ply-23-32', 'area'],
      ['us-1x12', 'board-foot'],
      ['us-1x12', 'length'],
    ]);
  });

  it('formats in the document units, with fractions', () => {
    const cells = list.rows.map((r) => formatRow(r, FRAC, stockName));
    expect(cells).toEqual([
      {
        item: 'Back',
        stock: '1/4" plywood',
        size: '72" x 36" x 7/32"',
        quantity: '1',
        extended: '18.00 sq ft',
        measures: [],
      },
      {
        item: 'Left side, Right side',
        stock: '3/4" plywood',
        size: '72" x 11-1/4" x 23/32"',
        quantity: '2',
        extended: '11.25 sq ft',
        measures: [],
      },
      {
        item: 'Shelf 1, Shelf 2, Shelf 3, Shelf 4',
        stock: '1x12',
        size: '34-1/2" x 11-1/4" x 3/4"',
        quantity: '4',
        extended: '11.50 bd ft',
        measures: ['138"'],
      },
    ]);
    expect(formatRow(list.hardware[1]!, FRAC).size).toBe('1-1/4"');
    expect(formatRow(list.hardware[0]!, { unit: 'mm', decimals: 0 }).size).toBe('Ø8 mm x 32 mm');
  });

  it('gives the sheet and lumber parts for layouts', () => {
    expect(list.sheets.map((s) => [s.stock, s.sheet, s.grain, s.parts.length])).toEqual([
      ['us-ply-7-32', { length: 96 * IN, width: 48 * IN }, true, 1],
      ['us-ply-23-32', { length: 96 * IN, width: 48 * IN }, true, 1],
    ]);
    expect(list.sheets[1]!.parts[0]).toMatchObject({ quantity: 2, grainLocked: true });
    expect(list.sheets[1]!.parts[0]!.length / IN).toBeCloseTo(72, 9);
    expect(list.lumber).toHaveLength(1);
    expect(list.lumber[0]!.stock).toBe('us-1x12');
    expect(list.lumber[0]!.lengths).toEqual([96, 120, 144, 168, 192].map((ft) => ft * IN));
    expect(list.lumber[0]!.parts[0]).toMatchObject({ id: list.rows[2]!.key, quantity: 4 });
  });

  it('is pure and deterministic', () => {
    const input: CutListInput = { parts: [bookshelf()] };
    const copy = structuredClone(input);
    expect(cutList(input)).toEqual(list);
    expect(input).toEqual(copy);
  });
});

describe('grouping', () => {
  it('groups two identical shelves into one row of 2, floating point noise included', () => {
    const a = board('us-1x12', [30, 11.25, 0.75], 'stick');
    const b = structuredClone(a);
    b.frame.size.length += 1e-9;
    b.frame.axes.length = [0, 1, 0];
    const list = cutList({
      parts: [part('p', [boardFeature('e#1', 'Shelf', a), boardFeature('e#2', 'Shelf', b)])],
    });
    expect(summary(list.rows)).toEqual([
      expect.objectContaining({ item: 'Shelf', quantity: 2, unit: 'board-foot' }),
    ]);
  });

  it('keeps blanks a thirty-second apart, other stock and other material apart', () => {
    const a = board('us-1x12', [30, 11.25, 0.75], 'stick');
    const longer = board('us-1x12', [30 + 1 / 32, 11.25, 0.75], 'stick');
    const oak = { ...board('us-1x12', [30, 11.25, 0.75], 'stick'), material: 'oak' };
    const pine1x10 = board('us-1x10', [30, 9.25, 0.75], 'stick');
    const list = cutList({
      parts: [
        part('p', [
          boardFeature('e#1', 'A', a),
          boardFeature('e#2', 'B', longer),
          boardFeature('e#3', 'C', oak),
          boardFeature('e#4', 'D', pine1x10),
        ]),
      ],
    });
    expect(list.rows).toHaveLength(4);
    expect(list.rows.every((r) => r.quantity === 1)).toBe(true);
  });

  it("uses a body's own name and material over the board's", () => {
    const p = part('p', [
      boardFeature('e#1', 'Board 1', board('us-1x12', [30, 11.25, 0.75], 'stick')),
    ]);
    const named = {
      ...p,
      bodies: [{ bodyId: 'e#1', creator: 'e#1', name: 'Top', material: 'oak' }],
    };
    expect(cutList({ parts: [named] }).rows[0]).toMatchObject({ item: 'Top', material: 'oak' });
  });
});

describe('assemblies', () => {
  const shelfPart = bookshelf();
  const studio = cutList({ parts: [shelfPart] });

  it('doubles every quantity when the part is inserted twice', () => {
    const twice = cutList({
      parts: [shelfPart],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#1' },
          { id: 'inst#2', part: 'part#1' },
        ],
      },
    });
    expect(twice.rows.map((r) => r.quantity)).toEqual(studio.rows.map((r) => 2 * r.quantity));
    twice.rows.forEach((r, i) => expect(r.extended).toBeCloseTo(2 * studio.rows[i]!.extended, 9));
    expect(twice.hardware.map((r) => r.quantity)).toEqual([64, 12]);
    expect(sourceIds(twice.rows[0]!)).toEqual(['inst#1/extension#7', 'inst#2/extension#7']);
  });

  it('gives exactly the part studio list for per-board instances, without double counting', () => {
    const perBoard = cutList({
      parts: [shelfPart],
      assembly: {
        instances: shelfPart.bodies.map((b, i) => ({
          id: `inst#${i + 1}`,
          part: 'part#1',
          bodies: [b.bodyId],
        })),
      },
    });
    expect(summary(perBoard.rows)).toEqual(summary(studio.rows));
    expect(summary(perBoard.hardware)).toEqual(summary(studio.hardware));
    expect(perBoard.totals).toEqual(studio.totals);
    expect(perBoard.sheets).toEqual(studio.sheets);
    expect(perBoard.lumber).toEqual(studio.lumber);
    expect(perBoard.rows[2]!.sources.map((s) => s.instance)).toEqual([
      'inst#3',
      'inst#4',
      'inst#5',
      'inst#6',
    ]);
  });

  it('counts hardware only where both boards are shown, and skips suppressed instances', () => {
    const sidesOnly = cutList({
      parts: [shelfPart],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#1', bodies: ['extension#1', 'extension#2'] },
          { id: 'inst#2', part: 'part#1', suppressed: true },
        ],
      },
    });
    expect(sidesOnly.rows.map((r) => [r.stock, r.quantity])).toEqual([['us-ply-23-32', 2]]);
    expect(sidesOnly.hardware).toEqual([]);

    // One whole bookshelf plus a second set of shelves only: the dowels follow the sides (1 set).
    const extraShelves = cutList({
      parts: [shelfPart],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#1' },
          {
            id: 'inst#2',
            part: 'part#1',
            bodies: ['extension#3', 'extension#4', 'extension#5', 'extension#6'],
          },
        ],
      },
    });
    expect(extraShelves.rows.find((r) => r.stock === 'us-1x12')!.quantity).toBe(8);
    expect(extraShelves.hardware.map((r) => r.quantity)).toEqual([32, 6]);
  });

  it('reports instances of parts and bodies the input does not have', () => {
    const list = cutList({
      parts: [shelfPart],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#9' },
          { id: 'inst#2', part: 'part#1', bodies: ['extension#1', 'extrude#4'] },
        ],
      },
    });
    expect(list.missing).toEqual([
      { instance: 'inst#1', part: 'part#9' },
      { instance: 'inst#2', part: 'part#1', bodyId: 'extrude#4' },
    ]);
    expect(list.rows.map((r) => r.quantity)).toEqual([1]);
  });
});

describe('configurations', () => {
  it('a row with a wider shelf changes the shelf width and nothing else', () => {
    const base = cutList({ parts: [bookshelf()] });
    const wide = cutList({
      parts: [bookshelf(13.25)],
      configuration: { id: 'cfg#1', name: 'Wide' },
    });
    expect(wide.configuration).toEqual({ id: 'cfg#1', name: 'Wide' });
    expect(base.configuration).toBeUndefined();
    expect(wide.rows.slice(0, 2)).toEqual(base.rows.slice(0, 2));
    expect(wide.hardware).toEqual(base.hardware);
    const [was, now] = [base.rows[2]!, wide.rows[2]!];
    expect(now.size!.width! / IN).toBeCloseTo(13.25, 9);
    expect({ ...now.size, width: 0 }).toEqual({ ...was.size, width: 0 });
    expect(now.quantity).toBe(4);
    // Ripped from a 1x12 no longer: a 13-1/4" shelf is a glued-up blank, counted on its width.
    expect(now.flags).toEqual(['actual-width']);
    expect(now.extended).toBeCloseTo((4 * 13.25 * 34.5) / 144, 12);
  });

  it('counts each instance in the configuration it shows', () => {
    const list = cutList({
      parts: [bookshelf(), { ...bookshelf(13.25), id: 'part#1@cfg#1' }],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#1' },
          { id: 'inst#2', part: 'part#1@cfg#1' },
        ],
      },
    });
    const shelves = list.rows.filter((r) => r.stock === 'us-1x12');
    expect(shelves.map((r) => [Math.round((r.size!.width! / IN) * 64) / 64, r.quantity])).toEqual([
      [13.25, 4],
      [11.25, 4],
    ]);
    expect(list.rows.find((r) => r.stock === 'us-ply-23-32')!.quantity).toBe(4);
    expect(list.hardware.map((r) => r.quantity)).toEqual([64, 12]);
  });
});

describe('bodies that are not boards', () => {
  const extrusion = (material?: string): CutListPart => ({
    id: 'p',
    bodies: [
      { bodyId: 'extrude#1', creator: 'extrude#1', ...(material ? { material } : {}) },
      { bodyId: 'extrude#2', creator: 'extrude#2', volume: 1000 },
      { bodyId: 'extrude#3', creator: 'extrude#3', material: 'steel' },
    ],
    features: [
      { featureId: 'extrude#1', name: 'Panel' },
      { featureId: 'extrude#2', name: 'Block' },
      { featureId: 'extrude#3', name: 'Bracket' },
    ],
    orientedSizes: [{ bodyId: 'extrude#1', sizes: [18, 600, 300] }],
  });

  it('lists a wood extrusion by its oriented box, estimated, and one without a box by volume', () => {
    const list = cutList({ parts: [{ ...extrusion('plywood'), material: 'pine' }] });
    expect(list.rows.map((r) => [r.item, r.kind, r.category, r.unit, r.flags])).toEqual([
      ['Block', 'shape', 'part', 'each', ['size-unknown']],
      ['Panel', 'shape', 'part', 'each', ['estimated']],
    ]);
    expect(list.rows[1]).toMatchObject({
      material: 'plywood',
      size: { length: 600, width: 300, thickness: 18 },
      quantity: 1,
    });
    expect(list.rows[0]).toMatchObject({
      material: 'pine',
      measures: [{ unit: 'volume', value: 1000 }],
    });
    expect(list.rows[0]!.size).toBeUndefined();
    expect(list.excluded).toEqual([{ part: 'p', bodyId: 'extrude#3', reason: 'not-wood' }]);
    // Not boards: nothing for sheet or lumber layouts.
    expect(list.sheets).toEqual([]);
    expect(list.lumber).toEqual([]);
  });

  it('leaves out bodies with no material at all', () => {
    const list = cutList({ parts: [extrusion()] });
    expect(list.rows).toEqual([]);
    expect(list.excluded.map((e) => [e.bodyId, e.reason])).toEqual([
      ['extrude#1', 'no-material'],
      ['extrude#2', 'no-material'],
      ['extrude#3', 'not-wood'],
    ]);
  });

  it('groups identical estimated shapes', () => {
    const p = extrusion('plywood');
    const list = cutList({
      parts: [p],
      assembly: {
        instances: [
          { id: 'i#1', part: 'p', bodies: ['extrude#1'] },
          { id: 'i#2', part: 'p', bodies: ['extrude#1'] },
        ],
      },
    });
    expect(list.rows.map((r) => [r.item, r.quantity])).toEqual([['Panel', 2]]);
  });
});

describe('board feet by basis', () => {
  const bf = (stock: string, size: [number, number, number], form: 'panel' | 'stick' = 'stick') =>
    cutList({ parts: [part('p', [boardFeature('e#1', 'X', board(stock, size, form))])] }).rows[0]!;

  it('counts a 2x4x8 as 5.33 board feet (nominal)', () => {
    const row = bf('us-2x4', [96, 3.5, 1.5]);
    expect(row.extended).toBeCloseTo(16 / 3, 12);
    expect(formatRow(row, FRAC).extended).toBe('5.33 bd ft');
    expect(row.flags).toEqual([]);
  });

  it('counts a ripped 2x4 on its actual width', () => {
    const row = bf('us-2x4', [96, 2.5, 1.5]);
    expect(row.extended).toBeCloseTo((2 * 2.5 * 96) / 144, 12);
    expect(row.flags).toEqual(['actual-width']);
  });

  it('counts hardware on its rough thickness and actual width (4/4 x 6" x 8\' = 4)', () => {
    const row = bf('us-hw-4-4', [96, 6, 13 / 16]);
    expect(row.extended).toBeCloseTo(4, 12);
    expect(row.flags).toEqual([]);
  });

  it('counts a stock width override as full width', () => {
    const entry = findStock('us-2x4')!;
    expect(blankBoardFeet(entry, { length: 96 * IN, width: 3.45 * IN }, 3.45 * IN)).toEqual({
      value: expect.closeTo(16 / 3, 12),
      width: 'nominal',
    });
    const stock = readStockData({ overrides: { 'us-2x4': { width: mmExpr('3.45in') } } }, 1);
    if (!stock.ok) throw new Error(stock.message);
    const list = cutList({
      parts: [part('p', [boardFeature('e#1', 'X', board('us-2x4', [96, 3.45, 1.5], 'stick'))])],
      stock: stock.value,
    });
    expect(list.rows[0]!.extended).toBeCloseTo(16 / 3, 12);
  });

  it('counts metric lumber on its nominal millimetres, and no board feet for sheets', () => {
    const row = cutList({
      parts: [part('p', [boardFeature('e#1', 'X', board('mm-38x89', [2400, 89, 38], 'stick', 1))])],
    }).rows[0]!;
    expect(row.extended).toBeCloseTo((38 * 89 * 2400) / 144 / IN ** 3, 12);
    expect(blankBoardFeet(findStock('mm-ply-18')!, { length: 1, width: 1 }, undefined)).toBe(
      undefined,
    );
  });
});

/** A stored length expression in the units it is typed in. */
function mmExpr(source: string) {
  return { source, lengthUnit: 'mm', angleUnit: 'deg' };
}

describe('layout inputs', () => {
  const panels = (stock: string): CutListPart =>
    part('p', [
      boardFeature('e#1', 'A', board(stock, [600, 300, 18], 'panel', 1)),
      boardFeature('e#2', 'B', board(stock, [400, 300, 18], 'panel', 1)),
    ]);

  it('takes the sheet size from the stock override and the grain rule from the settings', () => {
    const stock = readStockData(
      {
        overrides: {
          'mm-ply-18': {
            thickness: mmExpr('17.6'),
            sheet: { length: mmExpr('2500'), width: mmExpr('1250') },
          },
        },
      },
      1,
    );
    if (!stock.ok) throw new Error(stock.message);
    const list = cutList({ parts: [panels('mm-ply-18')], stock: stock.value });
    expect(list.sheets).toEqual([
      {
        stock: 'mm-ply-18',
        thickness: 17.6,
        sheet: { length: 2500, width: 1250 },
        grain: true,
        parts: [
          { id: list.rows[0]!.key, length: 600, width: 300, quantity: 1, grainLocked: true },
          { id: list.rows[1]!.key, length: 400, width: 300, quantity: 1, grainLocked: true },
        ],
      },
    ]);
    const free = cutList({ parts: [panels('mm-ply-18')], settings: { grain: 'ignore' } });
    expect(free.sheets[0]!.parts.every((p) => !p.grainLocked)).toBe(true);
    const mdf = cutList({ parts: [panels('mm-mdf-18')] });
    expect(mdf.sheets[0]).toMatchObject({ grain: false });
    expect(mdf.sheets[0]!.parts.every((p) => !p.grainLocked)).toBe(true);
  });

  it('lists random-length hardwood with no stock lengths', () => {
    const list = cutList({
      parts: [part('p', [boardFeature('e#1', 'Rail', board('us-hw-4-4', [30, 3, 13 / 16]))])],
    });
    expect(list.lumber).toEqual([
      {
        stock: 'us-hw-4-4',
        lengths: [],
        parts: [{ id: list.rows[0]!.key, length: 30 * IN, width: 3 * IN, quantity: 1 }],
      },
    ]);
  });

  it('lists a board of a stock this build does not know, flagged, outside the layouts', () => {
    const meta = { ...board('us-2x4', [96, 3.5, 1.5], 'stick'), stock: 'us-9x9' };
    const list = cutList({ parts: [part('p', [boardFeature('e#1', 'X', meta)])] });
    expect(list.rows[0]).toMatchObject({
      stock: 'us-9x9',
      category: 'part',
      unit: 'each',
      flags: ['stock-unknown'],
    });
    expect(list.lumber).toEqual([]);
    expect(stockName('us-9x9')).toBe('us-9x9');
    expect(stockName('us-2x4')).toBe('2x4');
  });
});

describe('cutListPart', () => {
  it('maps a document part and its regen result', () => {
    const doc: Pick<Part, 'id' | 'name' | 'material' | 'features' | 'bodies'> = {
      id: 'part#1',
      name: 'Shelf unit',
      material: 'pine',
      features: [
        {
          id: 'extension#1',
          kind: 'extension',
          name: 'Side',
          suppressed: false,
          extension: 'wood.board',
          schemaVersion: 1,
          dependsOn: [],
          references: [],
          expressions: {},
          params: {},
          operation: 'new',
        },
      ],
      bodies: [{ id: 'extension#1', name: 'Left side' }],
    };
    const meta = board('mm-ply-18', [600, 300, 18], 'panel', 1);
    const mapped = cutListPart(
      doc,
      {
        features: [{ featureId: 'extension#1', metadata: meta }, { featureId: 'sketch#9' }],
        bodies: [
          { bodyId: 'extension#1', creator: 'extension#1' },
          {
            bodyId: 'derived#2:from/x',
            creator: 'derived#2',
            inherited: { name: 'Foot', material: 'oak' },
          },
        ],
      },
      {
        id: 'part#1@cfg#1',
        volumes: new Map([['derived#2:from/x', 5]]),
        orientedSizes: [{ bodyId: 'derived#2:from/x', sizes: [1, 2, 3] }],
      },
    );
    expect(mapped).toEqual({
      id: 'part#1@cfg#1',
      name: 'Shelf unit',
      material: 'pine',
      bodies: [
        { bodyId: 'extension#1', creator: 'extension#1', name: 'Left side' },
        {
          bodyId: 'derived#2:from/x',
          creator: 'derived#2',
          name: 'Foot',
          material: 'oak',
          volume: 5,
        },
      ],
      features: [
        { featureId: 'extension#1', name: 'Side', metadata: meta },
        { featureId: 'sketch#9' },
      ],
      orientedSizes: [{ bodyId: 'derived#2:from/x', sizes: [1, 2, 3] }],
    });
    const list: CutList = cutList({ parts: [mapped] });
    expect(list.rows.map((r) => [r.item, r.kind])).toEqual([
      ['Left side', 'board'],
      ['Foot', 'shape'],
    ]);
    expect(totals(list.rows).length).toBeGreaterThan(0);
  });
});
