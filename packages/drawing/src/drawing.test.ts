import { describe, expect, it } from 'vitest';
import type { DisplayItem, DisplayList, TextItem } from './display';
import { layoutSheet, sheetScaleText, type DrawingInput } from './drawing';
import { BRACKET_FRONT, BRACKET_RIGHT, BRACKET_TOP } from './fixtures';
import { curveLength, type Curve2 } from './geometry';
import type { PlacedView } from './view';

/** The M1 bracket's third-angle drawing on A3 at 2:1, with dimensions, a note and a title block. */
const BRACKET_DRAWING: DrawingInput = {
  sheet: { size: 'A3' },
  scale: { paper: 2, model: 1 },
  views: [
    { id: 'view#1', edges: BRACKET_FRONT, position: [110, 130] },
    {
      id: 'view#2',
      edges: BRACKET_TOP,
      align: { parent: 'view#1', direction: 'vertical' },
      position: [0, 230],
    },
    {
      id: 'view#3',
      edges: BRACKET_RIGHT,
      align: { parent: 'view#1', direction: 'horizontal' },
      position: [240, 0],
    },
  ],
  dimensions: [
    {
      id: 'dim#1',
      view: 'view#1',
      kind: 'vertical',
      points: [
        [0, 0],
        [0, 40],
      ],
      offset: -10,
    },
    {
      id: 'dim#2',
      view: 'view#1',
      kind: 'horizontal',
      points: [
        [0, 0],
        [50, 0],
      ],
      offset: -10,
    },
    {
      id: 'dim#3',
      view: 'view#1',
      kind: 'vertical',
      points: [
        [50, 0],
        [50, 6],
      ],
      offset: 10,
    },
    {
      id: 'dim#4',
      view: 'view#1',
      kind: 'radius',
      circle: { center: [10, 10], radius: 4 },
      angle: (5 * Math.PI) / 4,
      textSide: 'inside',
    },
    {
      id: 'dim#5',
      view: 'view#2',
      kind: 'horizontal',
      points: [
        [25, 0],
        [40, 0],
      ],
      offset: 40,
    },
    {
      id: 'dim#6',
      view: 'view#2',
      kind: 'diameter',
      circle: { center: [40, 0], radius: 4 },
      angle: -Math.PI / 4,
      text: '2x <> CBORE',
    },
    {
      id: 'dim#7',
      view: 'view#3',
      kind: 'horizontal',
      points: [
        [-15, 0],
        [15, 0],
      ],
      offset: -10,
    },
  ],
  notes: [
    {
      id: 'note#1',
      text: 'BREAK ALL SHARP EDGES\nMATERIAL 6061-T6',
      at: [40, 70],
    },
  ],
  titleBlock: { title: 'M1 bracket', drawingNumber: 'MK-0001', revision: 'A', units: 'mm' },
};

const lengthOn = (list: DisplayList, layer: string, owner?: string) =>
  list.items
    .filter((i) => i.layer === layer && (owner === undefined || i.owner === owner))
    .reduce(
      (sum, i) => sum + (i.kind === 'text' || i.kind === 'hatch' ? 0 : curveLength(i as Curve2)),
      0,
    );

const texts = (items: readonly DisplayItem[], owner?: string) =>
  items
    .filter((i): i is TextItem => i.kind === 'text' && (owner === undefined || i.owner === owner))
    .map((t) => t.text);

/** Numbers rounded to 1e-6 (and no negative zero), so the golden is stable across platforms. */
function rounded(value: unknown): unknown {
  if (typeof value === 'number') {
    const r = Math.round(value * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rounded(v)]));
  return value;
}

describe('layoutSheet: the M1 bracket in three views', () => {
  const list = layoutSheet(BRACKET_DRAWING);

  it('lays out without warnings on an A3 landscape sheet', () => {
    expect(list.warnings).toEqual([]);
    expect([list.width, list.height]).toEqual([420, 297]);
  });

  it('draws hidden lines dashed, without the ones under visible lines', () => {
    expect(list.layers.hidden.lineType).toBe('dashed');
    expect(list.layers.hidden.dash.length).toBeGreaterThan(0);
    expect(list.layers.visible.lineType).toBe('continuous');
    // Front: 20 mm of hidden hole lines per hole (2 x 1.6 + 2 x 4.4 + 8), twice, at 2:1; the
    // hole circles seen edge on are gone. Right: both holes on the same lines, drawn once. Top:
    // nothing hidden shows.
    expect(lengthOn(list, 'hidden', 'view#1')).toBeCloseTo(2 * 40, 9);
    expect(lengthOn(list, 'hidden', 'view#3')).toBeCloseTo(40, 9);
    expect(lengthOn(list, 'hidden', 'view#2')).toBe(0);
  });

  it('draws visible edges wide and tangent edges thin', () => {
    // Front: the L outline, 50 + 6 + 40 + 30 + 6 + 40 mm of lines and a quarter circle R 4
    // (2 pi mm), at 2:1.
    expect(lengthOn(list, 'visible', 'view#1')).toBeCloseTo(
      2 * (50 + 6 + 40 + 30 + 6 + 40 + 2 * Math.PI),
      9,
    );
    expect(list.items.filter((i) => i.layer === 'smooth').map((i) => i.owner)).toEqual([
      'view#2',
      'view#3',
    ]);
  });

  it('marks the centres of the holes in the top view, once per hole', () => {
    const centre = list.items.filter((i) => i.layer === 'centre');
    expect(centre).toHaveLength(4);
    expect(centre.every((i) => i.owner === 'view#2')).toBe(true);
    // Through the first hole's centre (paper 110, 230), 2 mm past its counterbore (R 8 on paper).
    expect(centre[0]).toMatchObject({ kind: 'line', a: [100, 230], b: [120, 230] });
    expect(centre[1]).toMatchObject({ kind: 'line', a: [110, 220], b: [110, 240] });
  });

  it('keeps the views aligned', () => {
    const first = (owner: string) =>
      list.items.find((i) => i.owner === owner && i.layer === 'visible');
    const front = first('view#1');
    const top = first('view#2');
    // The front's bottom edge (X 0 to 50) and the top's front edge share paper x.
    expect(front).toMatchObject({ a: [60, 90], b: [160, 90] });
    expect(top).toMatchObject({ a: [60, 200], b: [160, 200] });
  });

  it('writes the dimension values, the note and the title block', () => {
    expect(
      ['dim#1', 'dim#2', 'dim#3', 'dim#4', 'dim#5', 'dim#6', 'dim#7'].map((d) =>
        texts(list.items, d),
      ),
    ).toEqual([['40'], ['50'], ['6'], ['R4'], ['15'], ['2x Ø8 CBORE'], ['30']]);
    expect(texts(list.items, 'note#1')).toEqual(['BREAK ALL SHARP EDGES', 'MATERIAL 6061-T6']);
    expect(texts(list.items, 'titleBlock')).toEqual(
      expect.arrayContaining(['MK-0001', 'A', '1 / 1', '2:1', 'M1 bracket', 'mm', 'THIRD ANGLE']),
    );
  });

  it('matches the golden display list', async () => {
    // JSON lines: the sheet (size, layers, warnings), then one display item per line, so a change
    // shows up in review as the items it touches. Update with `vitest -u` after checking the diff.
    const { items, ...sheet } = rounded(list) as DisplayList;
    const golden = [sheet, ...items].map((x) => JSON.stringify(x)).join('\n') + '\n';
    await expect(golden).toMatchFileSnapshot('./goldens/bracket-three-view.jsonl');
  });
});

describe('layoutSheet: a woodworking drawing', () => {
  it('dimensions in feet, inches and fractions at an imperial scale', () => {
    const side: Curve2[] = [
      { kind: 'line', a: [0, 0], b: [1028.7, 0] },
      { kind: 'line', a: [1028.7, 0], b: [1028.7, 18] },
      { kind: 'line', a: [1028.7, 18], b: [0, 18] },
      { kind: 'line', a: [0, 18], b: [0, 0] },
    ];
    const list = layoutSheet({
      sheet: { size: 'ANSI B' },
      scale: { paper: 38.1, model: 304.8, notation: 'imperial' },
      format: { length: { unit: 'ft-in', denominator: 16 } },
      views: [
        {
          id: 'view#1',
          edges: side.map((curve) => ({ item: 0, cls: 'sharp', visible: true, curve })),
        },
      ],
      dimensions: [
        {
          id: 'dim#1',
          view: 'view#1',
          kind: 'horizontal',
          points: [
            [0, 0],
            [1028.7, 0],
          ],
          offset: -10,
        },
        {
          id: 'dim#2',
          view: 'view#1',
          kind: 'vertical',
          points: [
            [1028.7, 0],
            [1028.7, 18],
          ],
          offset: 10,
          format: { length: { unit: 'in-fraction', denominator: 32 } },
        },
      ],
      titleBlock: { units: 'inches' },
    });
    expect(list.warnings).toEqual([]);
    expect(texts(list.items, 'dim#1')).toEqual(['3\' 4-1/2"']);
    expect(texts(list.items, 'dim#2')).toEqual(['23/32"']);
    expect(texts(list.items, 'titleBlock')).toContain('1-1/2" = 1\'');
    // 40-1/2" at 1/8 scale is 5-1/16" on paper.
    const outline = list.items.find((i) => i.owner === 'view#1' && i.kind === 'line')!;
    expect(outline.kind === 'line' && outline.b[0] - outline.a[0]).toBeCloseTo(128.5875, 9);
  });
});

describe('layoutSheet: options and warnings', () => {
  const box: Curve2[] = [
    { kind: 'line', a: [0, 0], b: [10, 0] },
    { kind: 'line', a: [10, 0], b: [10, 10] },
  ];
  const edges = [
    ...box.map((curve) => ({ item: 0, cls: 'sharp' as const, visible: true, curve })),
    {
      item: 1,
      cls: 'sharp' as const,
      visible: false,
      curve: { kind: 'line', a: [0, 5], b: [10, 5] } as Curve2,
    },
    {
      item: 1,
      cls: 'smooth' as const,
      visible: false,
      curve: { kind: 'line', a: [0, 6], b: [10, 6] } as Curve2,
    },
    {
      item: 1,
      cls: 'sewn' as const,
      visible: true,
      curve: { kind: 'line', a: [5, 0], b: [5, 10] } as Curve2,
    },
    {
      item: 1,
      cls: 'outline' as const,
      visible: true,
      curve: { kind: 'line', a: [0, 10], b: [10, 10] } as Curve2,
    },
  ];

  it('leaves out hidden lines, smooth and sewn edges as asked, and keeps items', () => {
    const base = layoutSheet({
      sheet: { size: 'A4' },
      views: [{ id: 'v', edges }],
      titleBlock: false,
    });
    expect(base.items.filter((i) => i.owner === 'v').map((i) => [i.layer, i.item])).toEqual([
      ['hidden', 1],
      ['visible', 0],
      ['visible', 0],
      ['visible', 1],
    ]);
    const all = layoutSheet({
      sheet: { size: 'A4' },
      views: [{ id: 'v', edges, display: { hidden: false, sewn: true, smooth: 'omit' } }],
      titleBlock: false,
    });
    expect(all.items.filter((i) => i.owner === 'v').map((i) => i.layer)).toEqual([
      'visible',
      'visible',
      'sewn',
      'visible',
    ]);
  });

  it('marks hidden circles only when hidden edges are drawn', () => {
    const hole = (visible: boolean, x: number) => ({
      item: 0,
      cls: 'sharp' as const,
      visible,
      curve: { kind: 'arc', center: [x, 0], radius: 2, start: 0, end: 2 * Math.PI } as Curve2,
    });
    const marks = (hidden: boolean) =>
      layoutSheet({
        sheet: { size: 'A4' },
        views: [{ id: 'v', edges: [hole(true, 0), hole(false, 10)], display: { hidden } }],
        titleBlock: false,
      }).items.filter((i) => i.layer === 'centre');
    expect(marks(true)).toHaveLength(4);
    expect(marks(false)).toHaveLength(2);
  });

  describe('hidden lines under edges that are not drawn', () => {
    const under = (cls: 'smooth' | 'sewn') => [
      {
        item: 0,
        cls,
        visible: true,
        curve: { kind: 'line', a: [0, 10], b: [50, 10] } as Curve2,
      },
      {
        item: 1,
        cls: 'sharp' as const,
        visible: false,
        curve: { kind: 'line', a: [10, 10], b: [40, 10] } as Curve2,
      },
    ];
    const layers = (view: DrawingInput['views'][number]) =>
      layoutSheet({ sheet: { size: 'A4' }, views: [view], titleBlock: false })
        .items.filter((i) => i.owner === 'v')
        .map((i) => [i.layer, i.item]);

    it('keeps a hidden line under a smooth edge the view omits', () => {
      expect(layers({ id: 'v', edges: under('smooth'), display: { smooth: 'omit' } })).toEqual([
        ['hidden', 1],
      ]);
      // Drawn thin, the smooth edge covers it.
      expect(layers({ id: 'v', edges: under('smooth') })).toEqual([['smooth', 0]]);
    });

    it('keeps a hidden line under a seam when seams are not drawn (the default)', () => {
      expect(layers({ id: 'v', edges: under('sewn') })).toEqual([['hidden', 1]]);
      expect(layers({ id: 'v', edges: under('sewn'), display: { sewn: true } })).toEqual([
        ['sewn', 0],
      ]);
    });

    it('keeps a hidden line under a hidden smooth edge, which is never drawn', () => {
      const edges = [{ ...under('smooth')[0]!, visible: false }, under('smooth')[1]!];
      expect(layers({ id: 'v', edges })).toEqual([['hidden', 1]]);
    });
  });

  it('draws only the first of views sharing an id, with a warning', () => {
    const list = layoutSheet({
      sheet: { size: 'A4' },
      views: [
        { id: 'v', edges },
        { id: 'v', edges, position: [50, 50] },
      ],
      titleBlock: false,
    });
    expect(list.warnings.map((w) => [w.code, w.subject])).toEqual([['duplicate-view', 'v']]);
    expect(list.items.filter((i) => i.owner === 'v')).toHaveLength(4);
  });

  it('hatches sections, labels views and draws note leaders into a view', () => {
    const list = layoutSheet({
      sheet: { size: 'A4' },
      views: [
        {
          id: 'v',
          label: 'SECTION A-A',
          edges,
          position: [100, 100],
          sections: [{ item: 0, loops: [box] }],
        },
      ],
      notes: [{ id: 'n', text: 'SEE DETAIL', at: [150, 150], leader: { view: 'v', to: [10, 10] } }],
      titleBlock: false,
    });
    const hatch = list.items.find((i) => i.kind === 'hatch')!;
    expect(hatch).toMatchObject({ layer: 'hatch', item: 0, angle: Math.PI / 4, spacing: 3 });
    expect(hatch.kind === 'hatch' && hatch.loops[0]![0]).toEqual({
      kind: 'line',
      a: [95, 95],
      b: [105, 95],
    });
    expect(texts(list.items, 'v')).toEqual(['SECTION A-A']);
    const leader = list.items.filter((i) => i.owner === 'n' && i.kind !== 'text');
    expect(leader[0]).toMatchObject({ kind: 'line', a: [149, 151.75], b: [105, 105] });
    expect(leader[1]).toMatchObject({ kind: 'polyline', fill: true });
  });

  it('warns about dimensions and leaders in views that are not on the sheet', () => {
    const list = layoutSheet({
      sheet: { size: 'A4' },
      views: [{ id: 'v', edges }],
      dimensions: [
        {
          id: 'd1',
          view: 'gone',
          kind: 'horizontal',
          points: [
            [0, 0],
            [1, 0],
          ],
          offset: 5,
        },
        {
          id: 'd2',
          view: 'v',
          kind: 'horizontal',
          points: [
            [0, 0],
            [0, 0],
          ],
          offset: 5,
        },
      ],
      notes: [{ id: 'n', text: 'X', at: [0, 0], leader: { view: 'gone', to: [0, 0] } }],
    });
    expect(list.warnings.map((w) => [w.code, w.subject])).toEqual([
      ['unknown-view', 'd1'],
      ['degenerate-dimension', 'd2'],
      ['unknown-view', 'n'],
    ]);
  });

  it('writes AS SHOWN for views at different scales', () => {
    const at = (paper: number, model: number) =>
      ({ scale: { paper, model } }) as unknown as PlacedView;
    expect(sheetScaleText([at(1, 2), at(1, 2)])).toBe('1:2');
    expect(sheetScaleText([at(1, 2), at(1, 5)])).toBe('AS SHOWN');
    expect(sheetScaleText([])).toBe('1:1');
  });
});
