// A drawing's files (`drawing-files.ts`): the names, the formats, the PDF of every sheet, and the
// refusals a sheet that could not be laid out or a writer's error give instead of a file.

import { describe, expect, it } from 'vitest';
import { DRAWING_MIME, drawingFile, drawingFileName, screenSvg } from './drawing-files';
import { UNKNOWN_EXPORT_SOURCE, UNREVIEWED_EXPORT, type ExportSource } from './export-gate';
import { bracketSheet } from './sheet-test-helpers';

const main: ExportSource = { id: 'main' };
const agent = (review: string): ExportSource => ({
  id: 'b-1',
  provenance: { origin: 'agent', review },
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('drawing files', () => {
  it('names the file after the drawing and the sheet, with no character file systems refuse', () => {
    expect(drawingFileName(['Bracket', 'Sheet 1'], 'dxf')).toBe('Bracket - Sheet 1.dxf');
    expect(drawingFileName(['a/b:c*d?e"f<g>h|i\\j'], 'svg')).toBe('a_b_c_d_e_f_g_h_i_j.svg');
    expect(drawingFileName(['\u0001 '], 'pdf')).toBe('_.pdf');
    expect(drawingFileName(['  '], 'pdf')).toBe('drawing.pdf');
  });

  it('writes one sheet as SVG or DXF, and every sheet as one PDF', () => {
    const list = bracketSheet();
    const names = { drawing: 'Bracket', sheets: ['Sheet 1', 'Sheet 2'] };
    const svg = drawingFile('svg', [list], names, main);
    const dxf = drawingFile('dxf', [list], names, main);
    const pdf = drawingFile('pdf', [list, list], names, main);
    if (!svg.ok || !dxf.ok || !pdf.ok) throw new Error('refused');
    expect([svg.fileName, svg.type]).toEqual(['Bracket - Sheet 1.svg', DRAWING_MIME.svg]);
    expect(text(svg.bytes)).toContain('<title>Bracket - Sheet 1</title>');
    expect([dxf.fileName, dxf.type]).toEqual(['Bracket - Sheet 1.dxf', DRAWING_MIME.dxf]);
    expect([pdf.fileName, pdf.type]).toEqual(['Bracket.pdf', DRAWING_MIME.pdf]);
    expect(text(pdf.bytes)).toContain('/Count 2');
  });

  it('refuses a sheet that could not be laid out, and a sheet the writer cannot write', () => {
    const names = { drawing: 'Bracket', sheets: ['Front', 'Plan'] };
    expect(drawingFile('pdf', [bracketSheet(), null], names, main)).toEqual({
      ok: false,
      message: 'Plan cannot be laid out: check its size and views.',
    });
    expect(drawingFile('svg', [], names, main)).toMatchObject({ ok: false });
    const bad = { ...bracketSheet(), width: Number.NaN };
    const r = drawingFile('dxf', [bad], names, main);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/^The DXF could not be written: /);
  });

  it('refuses every format from an agent’s unreviewed branch, and allows main, a person’s and an approved one', () => {
    const names = { drawing: 'Bracket', sheets: ['Sheet 1'] };
    for (const format of ['svg', 'dxf', 'pdf'] as const) {
      for (const review of ['open', 'submitted', 'changes-requested', 'rejected']) {
        expect(drawingFile(format, [bracketSheet()], names, agent(review))).toEqual({
          ok: false,
          message: UNREVIEWED_EXPORT,
        });
      }
      expect(drawingFile(format, [bracketSheet()], names, undefined as never)).toEqual({
        ok: false,
        message: UNKNOWN_EXPORT_SOURCE,
      });
      for (const source of [main, { id: 'b-2' }, agent('approved')]) {
        expect(drawingFile(format, [bracketSheet()], names, source).ok).toBe(true);
      }
    }
  });

  it('scales the screen SVG to its box', () => {
    const r = screenSvg(bracketSheet());
    expect(r.ok && r.markup.startsWith('<svg')).toBe(true);
    expect(r.ok && r.markup).toContain('width="100%" height="100%"');
  });
});
