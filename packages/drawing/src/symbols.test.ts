import { describe, expect, it } from 'vitest';
import type { DisplayItem, TextItem } from './display';
import { layoutSheet } from './drawing';
import type { Vec2 } from './geometry';
import { layoutPitchSymbol, pitchLabels } from './symbols';
import {
  DISCLAIMER_TEXT_HEIGHT,
  MAX_DISCLAIMER_LINES,
  TITLE_BLOCK_HEIGHT,
  TITLE_BLOCK_WIDTH,
  layoutDisclaimer,
  wrapText,
} from './title-block';

const IDENTITY = { scale: 1, offset: [0, 0] as const };
const texts = (items: readonly DisplayItem[]) =>
  items.filter((i): i is TextItem => i.kind === 'text');

describe('the pitch symbol', () => {
  it('labels a pitch as rise over 12, through packages/units', () => {
    expect(pitchLabels(Math.atan(6 / 12))).toEqual({ rise: '6', run: '12', text: '6/12' });
    expect(pitchLabels(Math.atan(7.5 / 12))?.text).toBe('7.5/12');
    expect(pitchLabels(Math.atan(12 / 12))?.rise).toBe('12');
    for (const bad of [0, -0.1, Math.PI / 2, Number.NaN, Infinity])
      expect(pitchLabels(bad)).toBe(null);
  });

  it('draws a right triangle whose hypotenuse has the roof slope, 12 on the run and p on the rise', () => {
    const items = layoutPitchSymbol(
      { id: 'pitch#1', view: 'view#1', at: [10, 20], pitch: Math.atan(6 / 12), rises: 'right' },
      IDENTITY,
    );
    const tri = items.find((i) => i.kind === 'polyline');
    expect(tri?.kind === 'polyline' && tri.closed).toBe(true);
    if (tri?.kind !== 'polyline') return;
    const [a, b, c] = tri.points as unknown as [Vec2, Vec2, Vec2];
    expect(a).toEqual([10, 23]);
    expect(b).toEqual([18, 23]);
    expect(c[0]).toBe(18);
    expect((c[1]! - a[1]!) / (c[0]! - a[0]!)).toBeCloseTo(0.5, 12);
    expect(texts(items).map((t) => t.text)).toEqual(['12', '6']);
    expect(items.every((i) => i.owner === 'pitch#1')).toBe(true);
  });

  it('mirrors for a roof rising to the left, and draws nothing for a pitch that is not one', () => {
    const items = layoutPitchSymbol(
      { id: 'p', view: 'v', at: [0, 0], pitch: Math.atan(4 / 12), rises: 'left', size: 12 },
      IDENTITY,
    );
    const tri = items.find((i) => i.kind === 'polyline');
    if (tri?.kind !== 'polyline') throw new Error('no triangle');
    expect(tri.points[1]![0]).toBe(-12);
    expect(texts(items)[1]!.anchor).toBe('end');
    expect(
      layoutPitchSymbol({ id: 'p', view: 'v', at: [0, 0], pitch: 0, rises: 'left' }, IDENTITY),
    ).toEqual([]);
  });

  it('is laid out by layoutSheet in its view', () => {
    const list = layoutSheet({
      sheet: { size: 'A4' },
      views: [{ id: 'view#1', edges: [], bounds: { min: [0, 0], max: [100, 100] } }],
      symbols: [
        { id: 'pitch#1', view: 'view#1', at: [0, 0], pitch: Math.atan(6 / 12), rises: 'right' },
      ],
      titleBlock: false,
    });
    expect(
      texts(list.items)
        .filter((t) => t.owner === 'pitch#1')
        .map((t) => t.text),
    ).toEqual(['12', '6']);
  });
});

describe('the disclaimer', () => {
  const TEXT =
    'Not an engineering tool: this lays out framing by rules you choose. It does no structural ' +
    'calculation. Consult your local building authority before building.';

  it('wraps words to the width, never splitting one', () => {
    const lines = wrapText(TEXT, 60, 1.8);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(TEXT);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(Math.floor(60 / (1.8 * 0.85)));
    expect(wrapText('', 60, 1.8)).toEqual([]);
  });

  it('never cuts a text of the longest allowed length across the title block', () => {
    const text = 'abcdefghi '.repeat(200).trim();
    expect(wrapText(text, TITLE_BLOCK_WIDTH - 3, 1.8).join(' ')).toBe(text);
  });

  it('caps the lines and the length, ending a cut text with an ellipsis', () => {
    const long = 'word '.repeat(5_000);
    const lines = wrapText(long, 40, 1.8);
    expect(lines).toHaveLength(MAX_DISCLAIMER_LINES);
    expect(lines.at(-1)!.endsWith('...')).toBe(true);
  });

  it('sits on top of the title block, its width, in the title block layer', () => {
    const frame = { min: [20, 10], max: [410, 287] } as const;
    const { items, height } = layoutDisclaimer(TEXT, frame, 10 + TITLE_BLOCK_HEIGHT);
    expect(height).toBeGreaterThan(DISCLAIMER_TEXT_HEIGHT);
    expect(
      texts(items)
        .map((t) => t.text)
        .join(' '),
    ).toBe(TEXT);
    for (const t of texts(items)) {
      expect(t.at[0]).toBeGreaterThanOrEqual(410 - TITLE_BLOCK_WIDTH);
      expect(t.at[1]).toBeGreaterThan(10 + TITLE_BLOCK_HEIGHT);
      expect(t.at[1]).toBeLessThanOrEqual(10 + TITLE_BLOCK_HEIGHT + height);
    }
    expect(items.every((i) => i.owner === 'titleBlock')).toBe(true);
  });

  it('is drawn by layoutSheet with or without a title block', () => {
    for (const titleBlock of [{ title: 'Shed' }, false] as const) {
      const list = layoutSheet({ sheet: { size: 'A3' }, views: [], titleBlock, disclaimer: TEXT });
      const text = texts(list.items)
        .filter((t) => t.height === DISCLAIMER_TEXT_HEIGHT && t.owner === 'titleBlock')
        .map((t) => t.text)
        .filter((t) => t === t.toLowerCase() || /[a-z]/.test(t))
        .join(' ');
      expect(text).toContain('Not an engineering tool');
    }
  });
});
