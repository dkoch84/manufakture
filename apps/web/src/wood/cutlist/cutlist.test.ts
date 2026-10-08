// The Cut list panel's logic that stays in the app: the settings form (kerf, trims, stages and
// grain stored in `domains.wood` as one command) and the in-process nester's protocol (a newer job
// cancels the one before it). The cut list itself is tested in `@manufakture/domain-wood`.

import { MDF_4X8 } from '@manufakture/nesting/fixtures';
import { describe, expect, it } from 'vitest';
import { applyCommand, bareUnits, type ManufaktureDocument } from '@manufakture/core';
import {
  WOOD_DATA_VERSION,
  documentCutList,
  documentSettings,
  nestingJob,
} from '@manufakture/domain-wood';
import { localNester } from './nester';
import { settingsCommand, settingsForm, trimNotes } from './settings';
import { bookshelfDocument, bookshelfModel, IN } from './cutlist.test-fixture';

function list() {
  const doc = bookshelfDocument();
  const model = bookshelfModel();
  return { doc, list: documentCutList({ document: doc, parts: model.getState().parts }) };
}

function apply(doc: ManufaktureDocument, command: Parameters<typeof applyCommand>[1]) {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

describe('the nester', () => {
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
