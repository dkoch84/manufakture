import { describe, expect, it } from 'vitest';
import { BRACKET_FRONT, BRACKET_RIGHT, BRACKET_TOP } from './fixtures';
import { applyPoint } from './geometry';
import { placeViews, viewBounds, type ViewInput } from './view';

const frame = { min: [20, 10], max: [410, 287] } as const;

describe('viewBounds', () => {
  it('comes from the edges, or the input', () => {
    expect(viewBounds({ id: 'v', edges: BRACKET_FRONT })).toEqual({ min: [0, 0], max: [50, 40] });
    const given = { min: [1, 2], max: [3, 4] } as const;
    expect(viewBounds({ id: 'v', edges: BRACKET_FRONT, bounds: given })).toBe(given);
  });
});

describe('placeViews', () => {
  const front: ViewInput = { id: 'front', edges: BRACKET_FRONT, position: [100, 120] };

  it('centres a view on its position at its scale', () => {
    const { placed, warnings } = placeViews([front], { frame, scale: { paper: 2, model: 1 } });
    expect(warnings).toEqual([]);
    const p = placed.get('front')!;
    expect(p.transform).toEqual({ scale: 2, offset: [50, 80] });
    expect(p.paperBounds).toEqual({ min: [50, 80], max: [150, 160] });
    expect(p.scale).toEqual({ paper: 2, model: 1 });
  });

  it('defaults to the frame centre at 1:1', () => {
    const { placed } = placeViews([{ id: 'v', edges: BRACKET_FRONT }], { frame });
    expect(placed.get('v')!.paperBounds).toEqual({ min: [190, 128.5], max: [240, 168.5] });
  });

  it('keeps projected views aligned with their parent', () => {
    const views: ViewInput[] = [
      {
        id: 'top',
        edges: BRACKET_TOP,
        align: { parent: 'front', direction: 'vertical' },
        position: [999, 230],
      },
      front,
      {
        id: 'right',
        edges: BRACKET_RIGHT,
        align: { parent: 'front', direction: 'horizontal' },
        position: [240, -5],
      },
    ];
    const { placed, warnings } = placeViews(views, { frame, scale: { paper: 2, model: 1 } });
    expect(warnings).toEqual([]);
    const f = placed.get('front')!.transform;
    const t = placed.get('top')!.transform;
    const r = placed.get('right')!.transform;
    // The same model X lands at the same paper x in front and top; the same Z at the same paper
    // y in front and right.
    expect(applyPoint(t, [25, 0])[0]).toBe(applyPoint(f, [25, 0])[0]);
    expect(applyPoint(r, [0, 6])[1]).toBe(applyPoint(f, [25, 6])[1]);
    // The free coordinate comes from the position.
    expect(placed.get('top')!.paperBounds).toEqual({ min: [50, 200], max: [150, 260] });
    expect(placed.get('right')!.paperBounds.min[0]).toBe(210);
  });

  it('places aligned views without a position beside the parent, third or first angle', () => {
    const views: ViewInput[] = [
      front,
      { id: 'top', edges: BRACKET_TOP, align: { parent: 'front', direction: 'vertical' } },
      { id: 'right', edges: BRACKET_RIGHT, align: { parent: 'front', direction: 'horizontal' } },
    ];
    const third = placeViews(views, { frame, gap: 10 }).placed;
    expect(third.get('top')!.paperBounds.min[1]).toBe(third.get('front')!.paperBounds.max[1] + 10);
    expect(third.get('right')!.paperBounds.min[0]).toBe(
      third.get('front')!.paperBounds.max[0] + 10,
    );
    const first = placeViews(views, { frame, gap: 10, projection: 'first' }).placed;
    expect(first.get('top')!.paperBounds.max[1]).toBe(first.get('front')!.paperBounds.min[1] - 10);
    expect(first.get('right')!.paperBounds.max[0]).toBe(
      first.get('front')!.paperBounds.min[0] - 10,
    );
  });

  it('places left and bottom views on the other side, flipped in first angle', () => {
    const views: ViewInput[] = [
      front,
      {
        id: 'bottom',
        edges: BRACKET_TOP,
        align: { parent: 'front', direction: 'vertical', side: 'before' },
      },
      {
        id: 'left',
        edges: BRACKET_RIGHT,
        align: { parent: 'front', direction: 'horizontal', side: 'before' },
      },
    ];
    // Third angle: a bottom view below the front, a left view to its left.
    const third = placeViews(views, { frame, gap: 10 }).placed;
    const f3 = third.get('front')!.paperBounds;
    expect(third.get('bottom')!.paperBounds.max[1]).toBe(f3.min[1] - 10);
    expect(third.get('left')!.paperBounds.max[0]).toBe(f3.min[0] - 10);
    // First angle: the bottom view above, the left view to the right.
    const first = placeViews(views, { frame, gap: 10, projection: 'first' }).placed;
    const f1 = first.get('front')!.paperBounds;
    expect(first.get('bottom')!.paperBounds.min[1]).toBe(f1.max[1] + 10);
    expect(first.get('left')!.paperBounds.min[0]).toBe(f1.max[0] + 10);
    // Still aligned: the left view shares the front's row.
    expect(first.get('left')!.transform.offset[1]).toBe(first.get('front')!.transform.offset[1]);
  });

  it('warns about views sharing an id and places only the first', () => {
    const { placed, warnings } = placeViews([front, { ...front, position: [300, 200] }], { frame });
    expect(placed.size).toBe(1);
    expect(placed.get('front')!.paperBounds.min).toEqual([75, 100]);
    expect(warnings.map((w) => [w.code, w.subject])).toEqual([['duplicate-view', 'front']]);
  });

  it('gives aligned views the parent scale, with a warning when they asked for another', () => {
    const { placed, warnings } = placeViews(
      [
        { ...front, scale: { paper: 1, model: 2 } },
        {
          id: 'top',
          edges: BRACKET_TOP,
          scale: { paper: 1, model: 1 },
          align: { parent: 'front', direction: 'vertical' },
        },
      ],
      { frame },
    );
    expect(placed.get('top')!.scale).toEqual({ paper: 1, model: 2 });
    expect(warnings.map((w) => w.code)).toEqual(['alignment-scale']);
  });

  it('warns about unknown parents, cycles and views outside the frame', () => {
    const { placed, warnings } = placeViews(
      [
        { id: 'a', edges: BRACKET_FRONT, align: { parent: 'b', direction: 'vertical' } },
        { id: 'b', edges: BRACKET_FRONT, align: { parent: 'a', direction: 'vertical' } },
        { id: 'c', edges: BRACKET_FRONT, align: { parent: 'zzz', direction: 'vertical' } },
        { id: 'd', edges: BRACKET_FRONT, position: [0, 0] },
      ],
      { frame },
    );
    expect(placed.size).toBe(4);
    expect(warnings.map((w) => [w.code, w.subject])).toEqual([
      ['alignment-cycle', 'a'],
      ['unknown-parent', 'c'],
      ['outside-frame', 'd'],
    ]);
  });
});
