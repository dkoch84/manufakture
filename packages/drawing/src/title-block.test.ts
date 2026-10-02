import { describe, expect, it } from 'vitest';
import type { TextItem } from './display';
import {
  TITLE_BLOCK_HEIGHT,
  TITLE_BLOCK_WIDTH,
  layoutTitleBlock,
  titleBlockBounds,
} from './title-block';

const frame = { min: [20, 10], max: [410, 287] } as const;

describe('title block', () => {
  it('sits in the bottom right corner of the frame', () => {
    expect(titleBlockBounds(frame)).toEqual({
      min: [410 - TITLE_BLOCK_WIDTH, 10],
      max: [410, 10 + TITLE_BLOCK_HEIGHT],
    });
    expect(TITLE_BLOCK_WIDTH).toBe(180);
  });

  it('labels every cell and writes the given values inside it', () => {
    const items = layoutTitleBlock(
      { title: 'Bracket', drawingNumber: 'MK-001', scale: '2:1' },
      frame,
    );
    const texts = items.filter((i): i is TextItem => i.kind === 'text');
    expect(texts.filter((t) => t.height === 1.8).map((t) => t.text)).toEqual([
      'DRAWING NO.',
      'REV',
      'SHEET',
      'SCALE',
      'TITLE',
      'COMPANY',
      'DRAWN',
      'DATE',
      'MATERIAL',
      'UNITS',
      'PROJECTION',
    ]);
    const title = texts.find((t) => t.text === 'Bracket')!;
    expect(title.height).toBe(5);
    expect(texts.find((t) => t.text === 'MK-001')!.at).toEqual([232, 11.5]);
    expect(texts.find((t) => t.text === '2:1')!.at).toEqual([372, 11.5]);
    const box = titleBlockBounds(frame);
    for (const i of items) {
      const pts = i.kind === 'line' ? [i.a, i.b] : i.kind === 'text' ? [i.at] : [];
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(box.min[0]);
        expect(x).toBeLessThanOrEqual(box.max[0]);
        expect(y).toBeGreaterThanOrEqual(box.min[1]);
        expect(y).toBeLessThanOrEqual(box.max[1]);
      }
    }
    expect(items.every((i) => i.owner === 'titleBlock')).toBe(true);
  });
});
