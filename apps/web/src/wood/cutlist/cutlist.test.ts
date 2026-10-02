// The Cut list panel's logic: the bookshelf's rows against a hand calculation, item names made
// short, excluded bodies named, the CSV files byte for byte, the settings command, the layout
// job (a glued-up blank wider than its stock is left out of the lumber plan), and the layouts.

import { MDF_4X8 } from '@manufakture/nesting/fixtures';
import { describe, expect, it } from 'vitest';
import { applyCommand, bareUnits, type ManufaktureDocument } from '@manufakture/core';
import { WOOD_DATA_VERSION } from '@manufakture/domain-wood';
import {
  bodiesToSize,
  bomCsv,
  csvField,
  csvTextField,
  cutListCsv,
  displayRows,
  documentCutList,
  documentSettings,
  excludedLines,
  groupRows,
  shortItem,
  totalLines,
} from './cutlist';
import { nestingJob, purchase } from './layout';
import { runNesting } from './nesting';
import { localNester } from './nester';
import { settingsCommand, settingsForm, trimNotes } from './settings';
import { bookshelfDocument, bookshelfModel, IN, PLY, withOakPanel } from './cutlist.test-fixture';

function list(options: { extras?: boolean; doc?: ManufaktureDocument } = {}) {
  const doc = options.doc ?? bookshelfDocument();
  const model = bookshelfModel(options);
  return { doc, list: documentCutList({ document: doc, parts: model.getState().parts }) };
}

function apply(doc: ManufaktureDocument, command: Parameters<typeof applyCommand>[1]) {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

describe('item names', () => {
  it('joins numbered names into runs and keeps others as they are', () => {
    expect(shortItem('Shelf 1, Shelf 2, Shelf 3, Shelf 4')).toBe('Shelf 1-4');
    expect(shortItem('Side 1, Side 2')).toBe('Side 1, 2');
    expect(shortItem('Top, Bottom, Shelf 1, Shelf 2, Shelf 3')).toBe('Top, Bottom, Shelf 1-3');
    expect(shortItem('Shelf 1, Shelf 3, Shelf 4, Shelf 5, Shelf 9')).toBe('Shelf 1, 3-5, 9');
    expect(shortItem('Leg')).toBe('Leg');
    expect(shortItem('A, B, C, D, E, F')).toBe('A, B, C and 3 more');
  });
});

describe('the bookshelf cut list', () => {
  it('matches the hand-computed table', () => {
    const { list: l } = list();
    const rows = displayRows(l.rows, bookshelfDocument().units);
    expect(
      rows.map((r) => [r.number, r.item, r.stock, r.size, r.quantity, r.extended, r.flags]),
    ).toEqual([
      // 2 x 72 x 11.25 = 1620 sq in = 11.25 sq ft.
      [1, 'Side 1, 2', '3/4" plywood', '72" x 11-1/4" x 23/32"', 2, '11.25 sq ft', []],
      // 5 x 29 x 11.25 = 1631.25 sq in = 11.33 sq ft.
      [2, 'Top, Bottom, Shelf 1-3', '3/4" plywood', '29" x 11-1/4" x 23/32"', 5, '11.33 sq ft', []],
      // 2 x 4 x 96 / 144 = 5.33 bd ft (nominal).
      [3, 'Rail', '2x4', '96" x 3-1/2" x 1-1/2"', 1, '5.33 bd ft', []],
      // Glued up 10" wide: 2 x 10 x 30 / 144 = 4.17 bd ft on the actual width.
      [4, 'Glued top', '2x4', '30" x 10" x 1-1/2"', 1, '4.17 bd ft', ['actual-width']],
    ]);
    expect(totalLines(l, bookshelfDocument().units)).toEqual([
      'Sheet goods: 22.58 sq ft, 7 pcs',
      // 96" + 30" of 2x4.
      'Lumber: 9.50 bd ft, 126", 2 pcs',
    ]);
  });

  it('groups by stock and sorts within a group', () => {
    const { doc, list: l } = list();
    const groups = groupRows(displayRows(l.rows, doc.units), 'length', false);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.number)])).toEqual([
      ['3/4" plywood', [2, 1]],
      ['2x4', [4, 3]],
    ]);
  });

  it('names the bodies it leaves out, and sizes a wood body that is not a board', () => {
    const doc = withOakPanel(bookshelfDocument());
    const { list: l } = list({ extras: true, doc });
    expect(excludedLines(l, doc)).toEqual([
      'pattern#1, copy of Shelf 3 (Part 1): not in the cut list, it has no material (a copy of a board is not a board: give it a wood material to list it by its shape)',
    ]);
    const model = bookshelfModel({ extras: true });
    expect(bodiesToSize(doc.parts[0]!, model.getState().parts[0]!)).toEqual(['extrude#1']);
    const sized = documentCutList({
      document: doc,
      parts: model.getState().parts,
      sizes: new Map([['part#1', [{ bodyId: 'extrude#1', sizes: [10 * IN, 40 * IN, 1 * IN] }]]]),
    });
    const oak = displayRows(sized.rows, doc.units).find((r) => r.item === 'Oak panel')!;
    expect([oak.size, oak.flags]).toEqual(['40" x 10" x 1"', ['estimated']]);
  });

  it('writes the cut list CSV exactly', () => {
    const { doc, list: l } = list();
    expect(cutListCsv(l, doc.units)).toBe(
      [
        '#,Item,Stock,Material,Length,Width,Thickness,Quantity,Total,Flags,Bodies',
        '1,"Side 1, Side 2","3/4"" plywood",Plywood (birch),"72""","11-1/4""","23/32""",2,11.25 sq ft,,extension#1 extension#2',
        '2,"Top, Bottom, Shelf 1, Shelf 2, Shelf 3","3/4"" plywood",Plywood (birch),"29""","11-1/4""","23/32""",5,11.33 sq ft,,extension#3 extension#4 extension#5 extension#6 extension#7',
        '3,Rail,2x4,Pine (eastern white),"96""","3-1/2""","1-1/2""",1,5.33 bd ft,,extension#8',
        '4,Glued top,2x4,Pine (eastern white),"30""","10""","1-1/2""",1,4.17 bd ft,ripped: board feet on the actual width,extension#9',
        '',
      ].join('\r\n'),
    );
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
  });

  it('keeps user text that a spreadsheet would read as a formula as text, in both CSV files', () => {
    const { doc, list: l } = list();
    expect(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', 'Side 1'].map(csvTextField)).toEqual([
      "'=1+1",
      "'+1",
      "'-1",
      "'@SUM(A1)",
      "'\tx",
      '"\'\rx"',
      'Side 1',
    ]);
    // A formatted number is not user text: a negative one stays a number.
    expect(csvField(-1.5)).toBe('-1.5');
    const evil: typeof l = {
      ...l,
      rows: [{ ...l.rows[2]!, item: '=HYPERLINK("http://x", "y")', stock: '+s', material: '-m' }],
      stockTotals: [{ ...l.stockTotals[0]!, group: '@stock' }],
      hardware: [{ ...l.rows[2]!, kind: 'hardware', item: '@SUM(A1)', size: { length: 10 } }],
    };
    const cut = cutListCsv(evil, doc.units).split('\r\n')[1]!;
    expect(cut.startsWith('1,"\'=HYPERLINK(""http://x"", ""y"")",\'+s,\'-m,')).toBe(true);
    const bom = bomCsv(evil, doc.units).split('\r\n');
    expect(bom[1]!.startsWith("'@stock (parts),")).toBe(true);
    expect(bom[2]!.startsWith("'@SUM(A1),")).toBe(true);
  });

  it('writes the BOM CSV with the stock to buy from the layouts', async () => {
    const { doc, list: l } = list();
    const job = nestingJob(l, documentSettings(doc).settings);
    const result = await runNesting(job);
    expect(bomCsv(l, doc.units, purchase(result))).toBe(
      [
        'Item,Size,Quantity,Total',
        '"3/4"" plywood (parts)",,7,22.58 sq ft',
        '2x4 (parts),,2,"9.50 bd ft; 126"""',
        '"3/4"" plywood (sheets to buy)",,1,',
        '2x4 (sticks to buy),"96""",1,',
        '',
      ].join('\r\n'),
    );
  });
});

describe('layouts', () => {
  it('lays the bookshelf on one sheet and leaves the glued-up blank out of the lumber plan', async () => {
    const { doc, list: l } = list();
    const job = nestingJob(l, documentSettings(doc).settings);
    expect(job.notes).toEqual([
      {
        stock: 'us-2x4',
        row: l.rows[3]!.key,
        message: '1 blank is wider than 2x4: glue up from several pieces (not in the lumber plan)',
      },
    ]);
    expect(job.sheets.map((s) => [s.stock, s.input.settings.kerf])).toEqual([[PLY, 3.175]]);
    const progress: number[] = [];
    const result = await runNesting(job, { onProgress: (p) => progress.push(p.done / p.total) });
    expect(result.sheets[0]!.result.totals.sheets).toBe(1);
    expect(result.sheets[0]!.result.unplaced).toEqual([]);
    expect(result.sticks[0]!.result.sticks.map((s) => s.length)).toEqual([96 * IN]);
    expect(progress.at(-1)).toBe(1);
  });

  it('needs two sheets for four 24" x 48" panels with a 1/8" kerf and one without', async () => {
    const parts = [{ id: 'p', length: 48, width: 24, quantity: 4, grainLocked: false }];
    const job = (kerf: number) => ({
      sheets: [
        {
          stock: 'mdf',
          name: 'MDF',
          thickness: 0.75,
          input: { parts, stock: [MDF_4X8], settings: { kerf } },
        },
      ],
      sticks: [],
      notes: [],
    });
    const nester = localNester();
    expect((await nester.layout(job(0)))!.sheets[0]!.result.totals.sheets).toBe(1);
    expect((await nester.layout(job(1 / 8)))!.sheets[0]!.result.totals.sheets).toBe(2);
  });

  it('a newer job cancels the one before it', async () => {
    const { doc, list: l } = list();
    const job = nestingJob(l, documentSettings(doc).settings);
    const nester = localNester();
    const first = nester.layout(job);
    const second = nester.layout(job);
    expect(await first).toBeNull();
    expect((await second)!.sheets).toHaveLength(1);
  });
});

describe('the settings form', () => {
  it('stores the kerf, trims, stages and grain as one command, and reads them back', () => {
    const doc = bookshelfDocument();
    expect(settingsForm(doc)).toEqual({
      kerf: '',
      sheetTrim: '',
      lumberTrim: '',
      maxStages: 'unlimited',
      grain: 'respect',
    });
    const r = settingsCommand(
      doc,
      { kerf: '3/32', sheetTrim: '1/4', lumberTrim: '', maxStages: '2', grain: 'ignore' },
      doc.units,
    );
    if (!r.ok || r.command === null) throw new Error('expected a command');
    const next = apply(doc, r.command);
    expect(settingsForm(next)).toEqual({
      kerf: '3/32',
      sheetTrim: '1/4',
      lumberTrim: '',
      maxStages: '2',
      grain: 'ignore',
    });
    const s = documentSettings(next).settings;
    expect(s.kerf).toBeCloseTo((3 / 32) * IN, 12);
    expect(s.sheetTrims.widthEnd).toBeCloseTo(0.25 * IN, 12);
    expect(s.maxStages).toBe(2);
    // The same form again changes nothing; an empty one removes the settings.
    expect(settingsCommand(next, settingsForm(next), doc.units)).toMatchObject({ command: null });
    const cleared = settingsCommand(
      next,
      { kerf: '', sheetTrim: '', lumberTrim: '', maxStages: 'unlimited', grain: 'respect' },
      doc.units,
    );
    expect(cleared.ok && cleared.command).toEqual({ type: 'setDomainData', namespace: 'wood' });
  });

  it('keeps per-edge trims when only the kerf changes, and sets every edge when the trim does', () => {
    const base = bookshelfDocument();
    const e = (source: string) => ({ source, ...bareUnits(base.units) });
    const doc = apply(base, {
      type: 'setDomainData',
      namespace: 'wood',
      schemaVersion: WOOD_DATA_VERSION,
      data: {
        sheetTrims: { lengthStart: e('1/4'), widthEnd: e('1/2') },
        lumberTrims: { start: e('1'), end: e('2') },
      },
    });
    expect(trimNotes(doc)).toEqual([
      'The sheet edges have different trims (length start 1/4, length end default, width start default, width end 1/2). The field shows the length start trim; they are kept as they are unless you change it, which sets all four edges.',
      'The lumber ends have different trims (start 1, end 2). The field shows the start trim; they are kept as they are unless you change it, which sets both ends.',
    ]);
    const form = settingsForm(doc);
    expect([form.sheetTrim, form.lumberTrim]).toEqual(['1/4', '1']);

    const kerfOnly = settingsCommand(doc, { ...form, kerf: '3/32' }, doc.units);
    if (!kerfOnly.ok || kerfOnly.command === null) throw new Error('expected a command');
    const a = documentSettings(apply(doc, kerfOnly.command)).settings;
    expect(a.kerf).toBeCloseTo((3 / 32) * IN, 12);
    expect(a.sheetTrims.lengthStart).toBeCloseTo(0.25 * IN, 12);
    expect(a.sheetTrims.lengthEnd).toBe(0);
    expect(a.sheetTrims.widthEnd).toBeCloseTo(0.5 * IN, 12);
    expect([a.lumberTrims.start, a.lumberTrims.end]).toEqual([1 * IN, 2 * IN]);

    const trims = settingsCommand(doc, { ...form, sheetTrim: '1/8', lumberTrim: '3' }, doc.units);
    if (!trims.ok || trims.command === null) throw new Error('expected a command');
    const next = apply(doc, trims.command);
    const b = documentSettings(next).settings;
    for (const v of Object.values(b.sheetTrims)) expect(v).toBeCloseTo(0.125 * IN, 12);
    expect([b.lumberTrims.start, b.lumberTrims.end]).toEqual([3 * IN, 3 * IN]);
    expect(trimNotes(next)).toEqual([]);
  });

  it('refuses a variable and a negative kerf', () => {
    const doc = bookshelfDocument();
    const r = settingsCommand(
      doc,
      { kerf: '#k', sheetTrim: '-1', lumberTrim: '', maxStages: 'unlimited', grain: 'respect' },
      doc.units,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['kerf', 'sheetTrim']);
  });
});
