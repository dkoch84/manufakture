import { describe, expect, it } from 'vitest';
import { DEFAULT_DIMENSION_STYLE, layoutDimension, type DimensionInput } from './dimension';
import type { DisplayItem, TextItem } from './display';
import { distance, type Vec2 } from './geometry';

const at = { scale: 1, offset: [100, 100] as Vec2 };
const texts = (items: readonly DisplayItem[]) =>
  items.filter((i): i is TextItem => i.kind === 'text');
const ofKind = <K extends DisplayItem['kind']>(items: readonly DisplayItem[], kind: K) =>
  items.filter((i): i is Extract<DisplayItem, { kind: K }> => i.kind === kind);
const close = (a: Vec2, b: Vec2, digits = 9) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

describe('linear dimensions', () => {
  it('lays out a horizontal dimension between two points exactly', () => {
    const { items, warning } = layoutDimension(
      {
        id: 'dim#1',
        view: 'v',
        kind: 'horizontal',
        points: [
          [0, 0],
          [50, 0],
        ],
        offset: -10,
      },
      at,
    );
    expect(warning).toBeUndefined();
    expect(items).toEqual([
      // Extension lines: 1 mm gap from the feature, 2 mm past the dimension line.
      { kind: 'line', layer: 'dimension', a: [100, 99], b: [100, 88], owner: 'dim#1' },
      { kind: 'line', layer: 'dimension', a: [150, 99], b: [150, 88], owner: 'dim#1' },
      // The dimension line, 10 mm below the anchors.
      { kind: 'line', layer: 'dimension', a: [100, 90], b: [150, 90], owner: 'dim#1' },
      {
        kind: 'text',
        layer: 'text',
        at: [125, 91],
        text: '50',
        height: 3.5,
        rotation: 0,
        anchor: 'middle',
        baseline: 'bottom',
        owner: 'dim#1',
      },
      // Arrowheads 3 x 1 mm, tips on the extension lines, pointing out.
      {
        kind: 'polyline',
        layer: 'dimension',
        points: [
          [100, 90],
          [103, 89.5],
          [103, 90.5],
        ],
        closed: true,
        fill: true,
        owner: 'dim#1',
      },
      {
        kind: 'polyline',
        layer: 'dimension',
        points: [
          [150, 90],
          [147, 90.5],
          [147, 89.5],
        ],
        closed: true,
        fill: true,
        owner: 'dim#1',
      },
    ]);
  });

  it('clears the anchor nearest the dimension line and measures in model units', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'horizontal',
        points: [
          [0, 0],
          [20, 6],
        ],
        offset: 8,
      },
      { scale: 2, offset: [0, 0] },
    );
    const [e1, e2, dim] = ofKind(items, 'line');
    // Above the higher anchor (paper y 12) by 8.
    expect(dim).toMatchObject({ a: [0, 20], b: [40, 20] });
    expect(e1).toMatchObject({ a: [0, 1], b: [0, 22] });
    expect(e2).toMatchObject({ a: [40, 13], b: [40, 22] });
    expect(texts(items)[0]!.text).toBe('20');
  });

  it('puts vertical text along the line, reading from the right', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'vertical',
        points: [
          [50, 0],
          [50, 6],
        ],
        offset: 10,
      },
      at,
    );
    const lines = ofKind(items, 'line');
    // 6 mm is too short for two arrows and the text: arrows outside pointing in, text past the
    // upper end, the line run out under it.
    const t = texts(items)[0]!;
    expect(t.text).toBe('6');
    expect(t.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(t.at[1]).toBeGreaterThan(106 + 6);
    expect(t.at[0]).toBeCloseTo(159, 9);
    // The line starts two arrow lengths below the lower end and runs past the text.
    expect(lines[2]!.a).toEqual([160, 94]);
    expect(lines[2]!.b[1]).toBeGreaterThan(t.at[1]);
    const arrows = ofKind(items, 'polyline');
    expect(arrows[0]!.points[0]).toEqual([160, 100]);
    // The lower arrow's body is below its tip: it points up, into the dimension.
    expect(arrows[0]!.points[1]![1]).toBe(97);
  });

  it('measures aligned dimensions along the points', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'aligned',
        points: [
          [0, 0],
          [30, 40],
        ],
        offset: 5,
      },
      at,
    );
    const t = texts(items)[0]!;
    expect(t.text).toBe('50');
    expect(t.rotation).toBeCloseTo(Math.atan2(40, 30), 12);
    const dim = ofKind(items, 'line')[2]!;
    // Offset to the left of the direction (0,0) -> (30,40): along (-0.8, 0.6).
    close(dim.a, [96, 103]);
    close(dim.b, [126, 143]);
  });

  it('writes the document units and overrides', () => {
    const inch = { length: { unit: 'ft-in', denominator: 16 } } as const;
    const wide = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'horizontal',
        points: [
          [0, 0],
          [1028.7, 0],
        ],
        offset: 10,
      },
      { scale: 1 / 8, offset: [0, 0] },
      inch,
    );
    expect(texts(wide.items)[0]!.text).toBe('3\' 4-1/2"');
    const ref = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'horizontal',
        points: [
          [0, 0],
          [18, 0],
        ],
        offset: 10,
        text: '(<>)',
        format: { length: { unit: 'in-fraction', denominator: 32 } },
      },
      at,
      inch,
    );
    expect(texts(ref.items)[0]!.text).toBe('(23/32")');
  });

  it('draws ticks instead of arrows when asked, and horizontal text in a break', () => {
    const style = {
      ...DEFAULT_DIMENSION_STYLE,
      terminator: 'tick',
      textOrientation: 'horizontal',
    } as const;
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'vertical',
        points: [
          [0, 0],
          [0, 40],
        ],
        offset: -10,
      },
      at,
      {},
      style,
    );
    expect(ofKind(items, 'polyline')).toEqual([]);
    const lines = ofKind(items, 'line');
    // Two extension lines, the dimension line in two pieces around the text, two ticks.
    expect(lines).toHaveLength(6);
    expect(lines[2]).toMatchObject({ a: [90, 100] });
    expect(lines[3]).toMatchObject({ b: [90, 140] });
    const gapStart = (lines[2] as { b: Vec2 }).b[1];
    const gapEnd = (lines[3] as { a: Vec2 }).a[1];
    expect(gapEnd - gapStart).toBeCloseTo(3.5 + 2, 9);
    const t = texts(items)[0]!;
    expect(t).toMatchObject({ at: [90, 120], rotation: 0, baseline: 'middle' });
    // Ticks: 3 mm strokes at 45 degrees through the ends.
    const tick = lines[4] as { a: Vec2; b: Vec2 };
    expect(distance(tick.a, tick.b)).toBeCloseTo(3, 12);
    close([(tick.a[0] + tick.b[0]) / 2, (tick.a[1] + tick.b[1]) / 2], [90, 100]);
  });

  it('warns about coincident points', () => {
    const r = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'aligned',
        points: [
          [1, 1],
          [1, 1],
        ],
        offset: 5,
      },
      at,
    );
    expect(r.items).toEqual([]);
    expect(r.warning).toMatchObject({ code: 'degenerate-dimension', subject: 'd' });
  });
});

describe('circle dimensions', () => {
  it('lays out a diameter across the circle with a leader to the text', () => {
    const dim: DimensionInput = {
      id: 'd',
      view: 'v',
      kind: 'diameter',
      circle: { center: [0, 0], radius: 10 },
      angle: 0,
    };
    const { items } = layoutDimension(dim, at);
    expect(ofKind(items, 'line')).toEqual([
      { kind: 'line', layer: 'dimension', a: [90, 100], b: [110, 100], owner: 'd' },
      { kind: 'line', layer: 'dimension', a: [110, 100], b: [116, 100], owner: 'd' },
      { kind: 'line', layer: 'dimension', a: [116, 100], b: [119, 100], owner: 'd' },
    ]);
    const arrows = ofKind(items, 'polyline');
    expect(arrows.map((a) => a.points[0])).toEqual([
      [110, 100],
      [90, 100],
    ]);
    expect(texts(items)[0]).toMatchObject({
      text: 'Ø20',
      at: [120, 100],
      anchor: 'start',
      baseline: 'middle',
    });
  });

  it('uses the model value and an outside arrow on small circles', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'diameter',
        circle: { center: [25, 0], radius: 2.25 },
        angle: Math.PI,
      },
      at,
    );
    // 4.5 < 3 arrow lengths: one arrow outside, its tip on the rim, pointing at the centre.
    const arrows = ofKind(items, 'polyline');
    expect(arrows).toHaveLength(1);
    expect(arrows[0]!.points[0]).toEqual([122.75, 100]);
    expect(arrows[0]!.points[1]![0]).toBeCloseTo(119.75, 12);
    const t = texts(items)[0]!;
    expect(t).toMatchObject({ text: 'Ø4.5', anchor: 'end' });
  });

  it('lays out a radius from the centre, or from outside when small', () => {
    const big = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'radius',
        circle: { center: [0, 0], radius: 20 },
        angle: Math.PI / 2,
      },
      at,
    );
    expect(ofKind(big.items, 'line')[0]).toMatchObject({ a: [100, 100] });
    expect(texts(big.items)[0]!.text).toBe('R20');
    const fillet = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'radius',
        circle: { center: [10, 10], radius: 4 },
        angle: (5 * Math.PI) / 4,
        value: 4,
      },
      at,
    );
    // 4 < 2 arrow lengths: no line from the centre; the leader starts at the rim.
    const lines = ofKind(fillet.items, 'line');
    close(lines[0]!.a, [110 - 4 * Math.SQRT1_2, 110 - 4 * Math.SQRT1_2]);
    expect(texts(fillet.items)[0]).toMatchObject({ text: 'R4', anchor: 'end' });
    // A concave fillet: the leader runs back through the centre, into the empty side.
    const inside = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'radius',
        circle: { center: [10, 10], radius: 4 },
        angle: (5 * Math.PI) / 4,
        textSide: 'inside',
      },
      at,
    );
    const [toCentre, leader] = ofKind(inside.items, 'line');
    close(toCentre!.a, [110 - 4 * Math.SQRT1_2, 110 - 4 * Math.SQRT1_2]);
    expect(toCentre!.b).toEqual([110, 110]);
    expect(leader!.a).toEqual([110, 110]);
    close(leader!.b, [110 + 6 * Math.SQRT1_2, 110 + 6 * Math.SQRT1_2]);
    expect(ofKind(inside.items, 'polyline')[0]!.points[0]).toEqual(toCentre!.a);
    expect(texts(inside.items)[0]).toMatchObject({ text: 'R4', anchor: 'start' });
  });

  it('dimensions a cylinder seen across by its silhouettes', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'diameter',
        lines: [
          [
            [22.75, 0],
            [22.75, 1.6],
          ],
          [
            [27.25, 1.6],
            [27.25, 0],
          ],
        ],
        value: 4.5,
      },
      { scale: 4, offset: [0, 0] },
    );
    const dim = ofKind(items, 'line')[0]!;
    // Across the middle of the silhouettes, which are 18 mm apart on paper: room for both
    // arrows and the text inside.
    close(dim.a, [91, 3.2]);
    close(dim.b, [109, 3.2]);
    expect(ofKind(items, 'polyline').map((a) => a.points[0])).toEqual([dim.a, dim.b]);
    expect(texts(items)[0]!.text).toBe('Ø4.5');
  });

  it('runs extension lines out to a silhouette dimension moved past the lines', () => {
    const lines = [
      [
        [0, 0],
        [0, 20],
      ],
      [
        [10, 20],
        [10, 0],
      ],
    ] as const;
    const { items } = layoutDimension(
      { id: 'd', view: 'v', kind: 'diameter', lines, offset: 30 },
      at,
    );
    // The dimension line 30 mm along the lines from the middle of the first: at y 40, past both
    // lines' upper ends (y 20). Extension lines from those ends, 1 mm gap, 2 mm overshoot.
    const [ext1, ext2, dim] = ofKind(items, 'line');
    close(ext1!.a, [100, 121]);
    close(ext1!.b, [100, 142]);
    close(ext2!.a, [110, 121]);
    close(ext2!.b, [110, 142]);
    // Room for the arrows but not the text: the line runs on past the second arrow to it.
    close(dim!.a, [100, 140]);
    expect(dim!.b[0]).toBeGreaterThan(110);
    expect(dim!.b[1]).toBeCloseTo(140, 9);
    expect(ofKind(items, 'polyline').map((a) => a.points[0])).toEqual([
      [100, 140],
      [110, 140],
    ]);
    expect(texts(items)[0]!.text).toBe('Ø10');
    // Below the lines: extension lines from their lower ends.
    const below = ofKind(
      layoutDimension({ id: 'd', view: 'v', kind: 'diameter', lines, offset: -15 }, at).items,
      'line',
    );
    close(below[0]!.a, [100, 99]);
    close(below[0]!.b, [100, 93]);
    close(below[1]!.a, [110, 99]);
    // Within the lines: no extension lines.
    const within = layoutDimension({ id: 'd', view: 'v', kind: 'diameter', lines, offset: 5 }, at);
    expect(ofKind(within.items, 'line')).toHaveLength(1);
  });

  it('takes a silhouette offset up the lines whatever the order of their points', () => {
    const up = [
      [
        [0, 0],
        [0, 20],
      ],
      [
        [10, 20],
        [10, 0],
      ],
    ] as const;
    const down = [
      [up[0][1], up[0][0]],
      [up[1][1], up[1][0]],
    ] as const;
    const dimLine = (lines: typeof up | typeof down) =>
      ofKind(
        layoutDimension({ id: 'd', view: 'v', kind: 'diameter', lines, offset: 5 }, at).items,
        'line',
      )[0]!;
    // 5 mm up from the middle (y 10 at 1:1 plus the view's offset of 100).
    expect(dimLine(up).a[1]).toBeCloseTo(115, 9);
    expect(dimLine(down)).toEqual(dimLine(up));
    // Horizontal lines: positive is to the right.
    const flat = [
      [
        [20, 0],
        [0, 0],
      ],
      [
        [0, 10],
        [20, 10],
      ],
    ] as const;
    const across = ofKind(
      layoutDimension({ id: 'd', view: 'v', kind: 'diameter', lines: flat, offset: 5 }, at).items,
      'line',
    )[0]!;
    expect(across.a[0]).toBeCloseTo(115, 9);
  });

  it('orders a silhouette dimension line left to right, then bottom to top', () => {
    // Lines along (1, -1): the dimension line runs along (1, 1), the same whichever line is first.
    const l1 = [
      [0, 10],
      [10, 0],
    ] as const;
    const l2 = [
      [10, 20],
      [20, 10],
    ] as const;
    const arrows = (lines: readonly [typeof l1, typeof l2] | readonly [typeof l2, typeof l1]) =>
      ofKind(
        layoutDimension({ id: 'd', view: 'v', kind: 'diameter', lines }, at).items,
        'polyline',
      ).map((a) => a.points[0]!);
    const forward = arrows([l1, l2]);
    expect(forward[0]![0]).toBeLessThan(forward[1]![0]);
    const backward = arrows([l2, l1]);
    expect(backward[0]![0]).toBeLessThan(backward[1]![0]);
    // Vertical: bottom to top.
    const flat = [
      [
        [0, 0],
        [20, 0],
      ],
      [
        [0, 10],
        [20, 10],
      ],
    ] as const;
    const v = ofKind(
      layoutDimension({ id: 'd', view: 'v', kind: 'diameter', lines: [flat[1], flat[0]] }, at)
        .items,
      'polyline',
    ).map((a) => a.points[0]!);
    expect(v[0]![1]).toBeLessThan(v[1]![1]);
  });

  it('warns when the silhouette lines are not parallel, and still lays them out', () => {
    const r = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'diameter',
        lines: [
          [
            [0, 0],
            [0, 20],
          ],
          [
            [10, 0],
            [12, 20],
          ],
        ],
      },
      at,
    );
    expect(r.warning).toMatchObject({ code: 'degenerate-dimension', subject: 'd' });
    expect(r.items.length).toBeGreaterThan(0);
    const parallel = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'diameter',
        lines: [
          [
            [0, 0],
            [0, 20],
          ],
          [
            [10, 0],
            [10, 20],
          ],
        ],
      },
      at,
    );
    expect(parallel.warning).toBeUndefined();
  });

  it('warns about a circle with no radius', () => {
    const r = layoutDimension(
      { id: 'd', view: 'v', kind: 'radius', circle: { center: [0, 0], radius: 0 } },
      at,
    );
    expect(r.warning?.code).toBe('degenerate-dimension');
  });
});

describe('angle dimensions', () => {
  it('draws an arc between the legs and the angle under 180 degrees', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'angle',
        vertex: [0, 0],
        points: [
          [0, 10],
          [10, 0],
        ],
        radius: 20,
      },
      at,
    );
    const arc = ofKind(items, 'arc')[0]!;
    expect(arc).toMatchObject({ center: [100, 100], radius: 20, start: 0 });
    expect(arc.end).toBeCloseTo(Math.PI / 2, 12);
    expect(texts(items)[0]!.text).toBe('90°');
    // Both legs are shorter than the arc radius: extension lines along each.
    const ext = ofKind(items, 'line');
    expect(ext).toHaveLength(2);
    close(ext[0]!.a, [100, 111]);
    close(ext[0]!.b, [100, 122]);
    close(ext[1]!.a, [111, 100]);
  });

  it('puts arrows outside a short arc, pointing in, with the arc run on under them', () => {
    const sw = (10 * Math.PI) / 180;
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'angle',
        vertex: [0, 0],
        points: [
          [10, 0],
          [10 * Math.cos(sw), 10 * Math.sin(sw)],
        ],
        radius: 10,
      },
      at,
    );
    // 10 degrees at R 10 is 1.75 mm of arc: no room for two 3 mm arrows.
    const arc = ofKind(items, 'arc')[0]!;
    expect(arc.start).toBeCloseTo(-0.6, 12);
    expect(arc.end).toBeCloseTo(sw + 0.6, 12);
    const [first, second] = ofKind(items, 'polyline');
    // Tips on the legs; the first arrow comes from below (clockwise of the arc) pointing up.
    close(first!.points[0]!, [110, 100]);
    expect(first!.points[1]![1]).toBeCloseTo(97, 9);
    close(second!.points[0]!, [100 + 10 * Math.cos(sw), 100 + 10 * Math.sin(sw)]);
    // A long arc keeps its arrows inside: the first arrow's base is above its tip.
    const wide = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'angle',
        vertex: [0, 0],
        points: [
          [10, 0],
          [0, 10],
        ],
        radius: 10,
      },
      at,
    );
    expect(ofKind(wide.items, 'arc')[0]!.start).toBe(0);
    expect(ofKind(wide.items, 'polyline')[0]!.points[1]![1]).toBeCloseTo(103, 9);
  });

  it('formats other angles and refuses parallel legs', () => {
    const { items } = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'angle',
        vertex: [0, 0],
        points: [
          [10, 0],
          [10, 10 * Math.tan(Math.PI / 8)],
        ],
        radius: 5,
      },
      at,
    );
    expect(texts(items)[0]!.text).toBe('22.5°');
    const r = layoutDimension(
      {
        id: 'd',
        view: 'v',
        kind: 'angle',
        vertex: [0, 0],
        points: [
          [10, 0],
          [20, 0],
        ],
        radius: 5,
      },
      at,
    );
    expect(r.warning?.code).toBe('degenerate-dimension');
  });
});
