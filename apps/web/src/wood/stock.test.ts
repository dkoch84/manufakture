import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { findStock } from '@manufakture/domain-wood';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { buildBoard, newBoardForm } from './boards';
import { boardGrainLines } from './grain';
import {
  buildOverride,
  hasWoodwork,
  overrideCommand,
  overrideForm,
  stockRows,
  stocksInUse,
} from './stock';
import { documentStock } from './catalog';
import { woodDocument } from './wood.test-fixture';

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;

function run(doc: ManufaktureDocument, command: Command | null): ManufaktureDocument {
  if (command === null) return doc;
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

function withPanel(): ManufaktureDocument {
  const doc = woodDocument();
  const r = buildBoard(newBoardForm(doc, 'part#1'), { doc, partId: 'part#1' });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return run(doc, r.command);
}

describe('stock overrides', () => {
  const ply = findStock('mm-ply-18')!;

  it('lists the stocks in use and the overridden ones', () => {
    expect(hasWoodwork(woodDocument())).toBe(false);
    const doc = withPanel();
    expect(hasWoodwork(doc)).toBe(true);
    expect(stocksInUse(doc)).toEqual(['mm-ply-18']);
    const set = overrideCommand(doc, 'us-2x4', { thickness: mm('37') });
    if (!set.ok) throw new Error(set.message);
    const after = run(doc, set.command);
    const data = documentStock(after);
    const rows = stockRows(after, data.ok ? data.data : undefined);
    expect(rows.map((r) => [r.id, r.used, r.resolved?.thickness])).toEqual([
      ['us-2x4', false, 37],
      ['mm-ply-18', true, 18],
    ]);
  });

  it('takes constant lengths only, and keeps empty fields at the catalog value', () => {
    const form = { ...overrideForm(ply, undefined), thickness: '18.2' };
    expect(buildOverride(ply, form, woodDocument().units)).toEqual({
      ok: true,
      override: { thickness: mm('18.2') },
    });
    expect(buildOverride(ply, { ...form, thickness: '#t' }, woodDocument().units)).toMatchObject({
      ok: false,
      errors: { thickness: expect.stringContaining('constants only') },
    });
    expect(buildOverride(ply, { ...form, thickness: '0' }, woodDocument().units)).toMatchObject({
      ok: false,
      errors: { thickness: 'expected a length above zero' },
    });
    expect(
      buildOverride(ply, { ...form, sheetLength: '2500', sheetWidth: '' }, woodDocument().units),
    ).toEqual({ ok: false, errors: { sheetWidth: 'Give both sides of the sheet.' } });
    expect(
      buildOverride(ply, { ...form, price: '42.5', currency: 'eur' }, woodDocument().units),
    ).toEqual({
      ok: true,
      override: { thickness: mm('18.2'), price: { amount: 42.5, per: 'sheet', currency: 'EUR' } },
    });
  });

  it('sets and clears one stock as one setDomainData each, keeping the others', () => {
    const doc = withPanel();
    const a = overrideCommand(doc, 'mm-ply-18', { thickness: mm('18.2') });
    if (!a.ok) throw new Error(a.message);
    expect(a.label).toBe('Override 18 mm plywood');
    const one = run(doc, a.command);
    const b = overrideCommand(one, 'us-2x4', { width: mm('90') });
    const two = run(one, b.ok ? b.command : null);
    expect(two.domains?.stock).toEqual({
      schemaVersion: 1,
      data: {
        overrides: { 'mm-ply-18': { thickness: mm('18.2') }, 'us-2x4': { width: mm('90') } },
      },
    });
    // Setting what is there already changes nothing.
    expect(overrideCommand(two, 'us-2x4', { width: mm('90') })).toMatchObject({ command: null });
    const c = overrideCommand(two, 'mm-ply-18', undefined);
    expect(c.ok && c.label).toBe('Clear the 18 mm plywood override');
    const cleared = run(two, c.ok ? c.command : null);
    const d = overrideCommand(cleared, 'us-2x4', {});
    expect(d.ok && d.command).toEqual({ type: 'setDomainData', namespace: 'stock' });
    expect(run(cleared, d.ok ? d.command : null).domains).toBeUndefined();
  });

  it('refuses to rewrite stock data it cannot read', () => {
    const doc = run(withPanel(), {
      type: 'setDomainData',
      namespace: 'stock',
      schemaVersion: 9,
      data: { overrides: {} },
    });
    const r = overrideCommand(doc, 'mm-ply-18', { thickness: mm('18.2') });
    expect(r.ok).toBe(false);
    expect(documentStock(doc).ok).toBe(false);
  });
});

describe('grain arrows', () => {
  const board = (featureId: string, grain: boolean, status = 'ok') =>
    ({
      featureId,
      kind: 'extension',
      index: 0,
      status,
      errors: [],
      warnings: [],
      references: [],
      cached: false,
      ms: 0,
      metadata: {
        form: 'panel',
        stock: grain ? 'mm-ply-18' : 'mm-mdf-18',
        material: 'plywood',
        grain,
        frame: {
          origin: [0, 0, 0],
          axes: { length: [1, 0, 0], width: [0, 1, 0], thickness: [0, 0, 1] },
          size: { length: 600, width: 300, thickness: 18 },
        },
        overridden: { thickness: false, width: false },
      },
    }) as unknown as FeatureResult;

  it('are drawn for shown boards whose stock has a grain, and built', () => {
    const part = {
      features: [
        board('extension#1', true),
        board('extension#2', false),
        board('extension#3', true, 'error'),
        board('extension#4', true),
      ],
    };
    const shown = new Set(['extension#1', 'extension#2', 'extension#3']);
    expect(boardGrainLines(part, shown)).toHaveLength(4);
    expect(boardGrainLines(part, new Set())).toEqual([]);
    expect(boardGrainLines(undefined, shown)).toEqual([]);
  });
});
