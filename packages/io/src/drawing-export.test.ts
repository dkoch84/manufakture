import { DEFAULT_LAYERS, LAYER_NAMES, type DisplayList } from '@manufakture/drawing';
import { describe, expect, it } from 'vitest';
import {
  DRAWING_LINETYPES,
  displayListToSheet,
  drawingToDxf,
  drawingToPdf,
  drawingToSvg,
} from './drawing-export';
import { segmentPoint, type Path2 } from './path2';
import { contentStream } from './pdf';
import { SHAPES_SHEET, bracketSheet } from './sheet-test-helpers';

describe('displayListToSheet', () => {
  it('keeps the paper, every layer in order with its style, and the owners', () => {
    const list = bracketSheet();
    const sheet = displayListToSheet(list, { title: 'M1 bracket' });
    expect(sheet.size).toEqual({ width: 420, height: 297 });
    expect(sheet.title).toBe('M1 bracket');
    expect(sheet.layers.map((l) => l.name)).toEqual(LAYER_NAMES);
    for (const layer of sheet.layers) {
      const style = DEFAULT_LAYERS[layer.name as keyof typeof DEFAULT_LAYERS];
      expect(layer).toEqual({
        name: layer.name,
        weight: style.weight,
        dash: style.dash,
        ...(DRAWING_LINETYPES[style.lineType]
          ? { lineType: DRAWING_LINETYPES[style.lineType] }
          : {}),
      });
    }
    expect(sheet.items).toHaveLength(list.items.length);
    expect(sheet.items.map((i) => i.owner)).toEqual(list.items.map((i) => i.owner));
    expect(sheet.items.map((i) => i.layer)).toEqual(list.items.map((i) => i.layer));
  });

  it('gives arcs a signed counter-clockwise sweep and polylines lines, and expands hatches', () => {
    const sheet = displayListToSheet(SHAPES_SHEET);
    const wrap = sheet.items.find(
      (i): i is Path2 => i.kind === 'path' && i.segments[0]?.kind === 'arc' && i.owner === 'view#2',
    )!;
    // 3 pi / 2 to pi / 2, counter-clockwise: a half turn through 0.
    expect(wrap.segments[0]).toMatchObject({ start: (3 * Math.PI) / 2, end: (5 * Math.PI) / 2 });
    const arrow = sheet.items.find((i): i is Path2 => i.kind === 'path' && i.fill === true)!;
    expect(arrow.closed).toBe(true);
    expect(arrow.segments.map((s) => segmentPoint(s, 'start'))).toEqual([
      [100, 60],
      [103, 59.5],
    ]);
    const hatch = sheet.items.find((i): i is Path2 => i.kind === 'path' && i.layer === 'hatch')!;
    expect(hatch.segments.length).toBeGreaterThan(20);
    expect(hatch.segments.every((s) => s.kind === 'line')).toBe(true);
  });

  it('drops a hatch with no lines', () => {
    const list: DisplayList = {
      ...SHAPES_SHEET,
      items: [{ kind: 'hatch', layer: 'hatch', loops: [], angle: 0, spacing: 2 }],
    };
    expect(displayListToSheet(list).items).toEqual([]);
  });
});

describe('golden files: the M1 bracket drawing', () => {
  // After a deliberate change, look at the diff, then `vitest run packages/io -u`.
  const list = bracketSheet();

  it('SVG', async () => {
    await expect(drawingToSvg(list, { title: 'M1 bracket' })).toMatchFileSnapshot(
      './goldens/bracket.svg',
    );
  });

  it('DXF', async () => {
    await expect(drawingToDxf(list)).toMatchFileSnapshot('./goldens/bracket.dxf');
  });

  it('PDF page content', async () => {
    await expect(contentStream(displayListToSheet(list))).toMatchFileSnapshot(
      './goldens/bracket-pdf-page.txt',
    );
    // The page content is what the PDF carries, deflated or not.
    const plain = String.fromCharCode(...drawingToPdf(list, { compress: false }));
    expect(plain).toContain(contentStream(displayListToSheet(list)));
  });
});
