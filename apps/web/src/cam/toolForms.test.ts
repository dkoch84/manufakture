// Tools in the document: an edit keeps stored units and the library source, every size and preset
// is checked for kind and range (a zero or negative diameter, a corner radius past the radius, a
// zero stepover), and a new tool takes the next `tool#n`.

import { describe, expect, it } from 'vitest';
import { apply, setupDocument } from './cam.test-fixture';
import { buildTool, newToolForm, numberedName, toolFields, toolFormOf } from './toolForms';
import { camVariables } from './values';

const ctx = (doc: ReturnType<typeof setupDocument>, existing?: (typeof doc.cam.tools)[number]) => ({
  doc,
  ...(existing ? { existing } : {}),
  units: doc.units,
  variables: camVariables(doc),
});

describe('tool forms', () => {
  it('opens a copied tool and applies it unchanged, keeping its inch units and source', () => {
    const doc = setupDocument();
    const tool = doc.cam.tools[0]!;
    expect(tool.diameter).toEqual({ source: '0.25in', lengthUnit: 'in', angleUnit: 'deg' });
    const r = buildTool(toolFormOf(tool), ctx(doc, tool));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command).toEqual({ type: 'editCamTool', tool });
  });

  it('refuses sizes and presets out of range, each with a message', () => {
    const doc = setupDocument();
    const tool = doc.cam.tools[0]!;
    const form = toolFormOf(tool);
    const bad = {
      ...form,
      name: ' ',
      number: '1.5',
      diameter: '-3',
      fluteLength: '0',
      flutes: '0',
      presets: form.presets.map((p, i) =>
        i === 0 ? { ...p, values: { ...p.values, stepover: '0', feed: '12 mm' } } : p,
      ),
    };
    const r = buildTool(bad, ctx(doc, tool));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({
      name: expect.any(String),
      number: expect.stringMatching(/whole number/),
      diameter: 'The value must be greater than zero.',
      fluteLength: 'The value must be greater than zero.',
      flutes: expect.stringMatching(/whole number/),
      'presets.0.stepover': expect.stringMatching(/fraction/),
      'presets.0.feed': expect.stringMatching(/Expected/),
    });
  });

  it('checks the fields of each kind: corner radius, angle, tip', () => {
    const doc = setupDocument();
    expect(toolFields('bull')).toEqual(['cornerRadius']);
    expect(toolFields('vbit')).toEqual(['angle', 'tipDiameter']);
    expect(toolFields('flat')).toEqual([]);
    const bull = buildTool({ ...newToolForm(), kind: 'bull', cornerRadius: '4 mm' }, ctx(doc));
    expect(!bull.ok && bull.errors.cornerRadius).toMatch(/half the diameter/);
    const vbit = buildTool({ ...newToolForm(), kind: 'vbit', angle: '190 deg' }, ctx(doc));
    expect(!vbit.ok && vbit.errors.angle).toMatch(/less than 180/);
    const tip = buildTool(
      { ...newToolForm(), kind: 'vbit', angle: '90 deg', tipDiameter: '6 mm' },
      ctx(doc),
    );
    expect(!tip.ok && tip.errors.tipDiameter).toMatch(/smaller than the diameter/);
  });

  it('adds a new tool under the next id, which core takes', () => {
    const doc = setupDocument();
    const r = buildTool({ ...newToolForm(), name: 'Six', number: '6' }, ctx(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.command).toMatchObject({
      type: 'addCamTool',
      tool: { id: 'tool#2', name: 'Six', kind: 'flat', number: 6, flutes: 2, presets: [] },
    });
    expect(apply(doc, r.command).cam.tools.map((t) => t.id)).toEqual(['tool#1', 'tool#2']);
  });

  it('puts the number before the name once, not again when the name starts with it', () => {
    expect(numberedName(5, 'Facing mill')).toBe('#5 Facing mill');
    expect(numberedName(201, '#201 1/4" flat end mill')).toBe('#201 1/4" flat end mill');
    expect(numberedName(20, '#201 1/4" flat end mill')).toBe('#20 #201 1/4" flat end mill');
    expect(numberedName(undefined, 'Facing mill')).toBe('Facing mill');
  });
});
