// A drawing's files (`drawing-files.ts`): the names, the formats, the PDF of every sheet, and the
// refusals a sheet that could not be laid out or a writer's error give instead of a file.

import { describe, expect, it } from 'vitest';
import { DRAWING_MIME, drawingFile, drawingFileName, screenSvg } from './drawing-files';
import { bracketSheet } from './sheet-test-helpers';

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
    const svg = drawingFile('svg', [list], names);
    const dxf = drawingFile('dxf', [list], names);
    const pdf = drawingFile('pdf', [list, list], names);
    if (!svg.ok || !dxf.ok || !pdf.ok) throw new Error('refused');
    expect([svg.fileName, svg.type]).toEqual(['Bracket - Sheet 1.svg', DRAWING_MIME.svg]);
    expect(text(svg.bytes)).toContain('<title>Bracket - Sheet 1</title>');
    expect([dxf.fileName, dxf.type]).toEqual(['Bracket - Sheet 1.dxf', DRAWING_MIME.dxf]);
    expect([pdf.fileName, pdf.type]).toEqual(['Bracket.pdf', DRAWING_MIME.pdf]);
    expect(text(pdf.bytes)).toContain('/Count 2');
  });

  it('refuses a sheet that could not be laid out, and a sheet the writer cannot write', () => {
    const names = { drawing: 'Bracket', sheets: ['Front', 'Plan'] };
    expect(drawingFile('pdf', [bracketSheet(), null], names)).toEqual({
      ok: false,
      message: 'Plan cannot be laid out: check its size and views.',
    });
    expect(drawingFile('svg', [], names)).toMatchObject({ ok: false });
    const bad = { ...bracketSheet(), width: Number.NaN };
    const r = drawingFile('dxf', [bad], names);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/^The DXF could not be written: /);
  });

  it('scales the screen SVG to its box', () => {
    const r = screenSvg(bracketSheet());
    expect(r.ok && r.markup.startsWith('<svg')).toBe(true);
    expect(r.ok && r.markup).toContain('width="100%" height="100%"');
  });
});
