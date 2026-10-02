import { describe, expect, it } from 'vitest';
import type { OutlineEntity, PathCommand, SvgOutlinePath, Vec2 } from './model';
import { OutlineBudget, outlineRegionArea } from './outline';
import { placeOutline } from './outline-entity';
import { MAX_SVG_OUTLINE_COMMANDS, svgIssueShapes, svgOutlineRegions } from './outline-svg';
import { detectRegions } from './regions';
import { line } from './region-sketches';

/** A closed polygon, counter-clockwise when `ccw`. */
function polygon(points: Vec2[], ccw = true): PathCommand[] {
  const p = ccw ? points : [...points].reverse();
  return [
    { kind: 'moveTo', to: p[0]! },
    ...p.slice(1).map((to): PathCommand => ({ kind: 'lineTo', to })),
    { kind: 'close' },
  ];
}
const square = (x: number, y: number, s: number, ccw = true) =>
  polygon(
    [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
    ],
    ccw,
  );

/** A disc of radius r about c as four cubics, counter-clockwise when `ccw`. */
function disc(c: Vec2, r: number, ccw = true): PathCommand[] {
  const k = 0.5522847498 * r;
  const s = ccw ? 1 : -1;
  const p = (x: number, y: number): Vec2 => [c[0] + x, c[1] + s * y];
  return [
    { kind: 'moveTo', to: p(r, 0) },
    { kind: 'cubicTo', control1: p(r, k), control2: p(k, r), to: p(0, r) },
    { kind: 'cubicTo', control1: p(-k, r), control2: p(-r, k), to: p(-r, 0) },
    { kind: 'cubicTo', control1: p(-r, -k), control2: p(-k, -r), to: p(0, -r) },
    { kind: 'cubicTo', control1: p(k, -r), control2: p(r, -k), to: p(r, 0) },
    { kind: 'close' },
  ];
}

/** 120 thin bars crossing at one point about (offset, 0): costly to merge. */
const bars = (offset: number): PathCommand[] =>
  Array.from({ length: 120 }, (_, i) => {
    const a = (Math.PI * i) / 120;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const w = 0.01;
    return polygon([
      [offset - 50 * c + w * s, -50 * s - w * c],
      [offset + 50 * c + w * s, 50 * s - w * c],
      [offset + 50 * c - w * s, 50 * s + w * c],
      [offset - 50 * c - w * s, -50 * s + w * c],
    ]);
  }).flat();

const area = (paths: SvgOutlinePath[], scale = 1) =>
  svgOutlineRegions(paths, scale).regions.reduce((a, r) => a + outlineRegionArea(r), 0);

describe('svgOutlineRegions', () => {
  it('follows each path fill rule: an "O" drawn both ways round, and drawn one way', () => {
    const sameWay = [...disc([0, 0], 10), ...disc([0, 0], 5)];
    const opposite = [...disc([0, 0], 10), ...disc([0, 0], 5, false)];
    const ring = Math.PI * (100 - 25);
    // evenodd: a hole either way.
    expect(area([{ fillRule: 'evenodd', commands: sameWay }])).toBeCloseTo(ring, 0);
    expect(area([{ fillRule: 'evenodd', commands: opposite }])).toBeCloseTo(ring, 0);
    // nonzero: a hole only when the counter runs the other way.
    expect(area([{ fillRule: 'nonzero', commands: opposite }])).toBeCloseTo(ring, 0);
    expect(area([{ fillRule: 'nonzero', commands: sameWay }])).toBeCloseTo(Math.PI * 100, 0);
    const r = svgOutlineRegions([{ fillRule: 'evenodd', commands: sameWay }], 1);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0]!.holes).toHaveLength(1);
  });

  it('unites overlapping paths whatever their directions', () => {
    const paths: SvgOutlinePath[] = [
      { fillRule: 'nonzero', commands: square(0, 0, 10) },
      { fillRule: 'nonzero', commands: square(5, 5, 10, false) },
    ];
    const r = svgOutlineRegions(paths, 1);
    expect(r.regions).toHaveLength(1);
    expect(outlineRegionArea(r.regions[0]!)).toBeCloseTo(175, 9);
    // Apart, two regions, each from its own path.
    const apart = svgOutlineRegions(
      [
        { fillRule: 'nonzero', commands: square(0, 0, 10) },
        { fillRule: 'evenodd', commands: square(20, 0, 10, false) },
      ],
      1,
    );
    expect(apart.regions.map((g) => g.outer.part)).toEqual([0, 1]);
  });

  it('scales about the origin and caches per paths array and scale', () => {
    const paths: SvgOutlinePath[] = [{ fillRule: 'nonzero', commands: square(1, 1, 2) }];
    expect(area(paths, 3)).toBeCloseTo(36, 9);
    const a = svgOutlineRegions(paths, 2);
    expect(svgOutlineRegions(paths, 2)).toBe(a);
    expect(svgOutlineRegions([...paths], 2)).not.toBe(a);
    expect(svgOutlineRegions(paths, 0).issues[0]!.code).toBe('too-complex');
    expect(svgOutlineRegions(paths, Number.NaN).regions).toEqual([]);
  });

  it('refuses too many commands, and bounds the work of many paths together', () => {
    const many = Array.from({ length: MAX_SVG_OUTLINE_COMMANDS / 5 + 1 }, (_, i) => ({
      fillRule: 'nonzero' as const,
      commands: square(i * 2, 0, 1),
    }));
    const r = svgOutlineRegions(many, 1);
    expect(r.regions).toEqual([]);
    expect(r.issues[0]!.message).toMatch(/has 100,005 path commands, more than the 100,000/);
    // Many paths of crossing bars, each cheap alone but costly together: one shared budget.
    const heavy = Array.from({ length: 40 }, (_, i) => ({
      fillRule: 'nonzero' as const,
      commands: bars(i * 200),
    }));
    const t0 = performance.now();
    const out = svgOutlineRegions(heavy, 1);
    const ms = performance.now() - t0;
    console.log(`SVG-OUTLINE 40 crossing-bar paths: ${ms.toFixed(0)} ms`);
    expect(out.issues.some((i) => i.code === 'too-complex')).toBe(true);
    expect(ms).toBeLessThan(15_000);
  }, 60_000);

  it('shares one budget between outlines, and caches no refusal for a spent shared budget', () => {
    // Outlines each just under the per-outline budget alone: 120 bars crossing at one point
    // (one path) costs about half of it.
    const heavy = (offset: number): SvgOutlinePath[] =>
      Array.from({ length: 1 }, (_, i) => ({
        fillRule: 'nonzero' as const,
        commands: bars(offset + i * 200),
      }));
    const alone = svgOutlineRegions(heavy(0), 1);
    expect(alone.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Three of them under one shared budget: the pass stops early instead of adding up.
    const shared = new OutlineBudget();
    const t0 = performance.now();
    const results = [heavy(10_000), heavy(20_000), heavy(30_000)].map((paths) => ({
      paths,
      result: svgOutlineRegions(paths, 1, { budget: shared }),
    }));
    const ms = performance.now() - t0;
    console.log(`SVG-OUTLINE 3 outlines under one shared budget: ${ms.toFixed(0)} ms`);
    expect(shared.exhausted).toBe(true);
    const refused = results.filter((r) => r.result.issues.some((i) => i.code === 'too-complex'));
    expect(refused.length).toBeGreaterThan(0);
    // Not cached: with a budget of its own, the same paths array converts.
    const again = svgOutlineRegions(refused[0]!.paths, 1);
    expect(again.issues.filter((i) => i.severity === 'error')).toEqual([]);
  }, 120_000);

  it('places as an outline entity and makes holes in a plate, like text', () => {
    const paths: SvgOutlinePath[] = [
      { fillRule: 'evenodd', commands: [...disc([0, 0], 4), ...disc([0, 0], 2)] },
    ];
    const entity: OutlineEntity = {
      id: 'e5',
      kind: 'outline',
      construction: false,
      anchor: [20, 10],
      angle: 0,
      source: { kind: 'svg', fileName: 'o.svg', paths },
    };
    const result = svgOutlineRegions(paths, 1);
    const shapes = placeOutline(
      entity,
      paths.map((_, i) => i),
      result,
    );
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.key).toBe('e5.g0.c0');
    const plate = [
      line('l1', [0, 0], [40, 0]),
      line('l2', [40, 0], [40, 20]),
      line('l3', [40, 20], [0, 20]),
      line('l4', [0, 20], [0, 0]),
    ];
    const found = detectRegions([...plate, entity], { outlines: shapes });
    const ids = found.regions.map((r) => r.id).sort();
    expect(ids).toContain('e5.g0.c0');
    expect(ids.some((id) => id.endsWith('/counter'))).toBe(true);
    const plateRegion = found.regions.find((r) => r.id.startsWith('l1'))!;
    expect(plateRegion.area).toBeCloseTo(800 - Math.PI * 16, 1);
  });

  it('names at most three paths in any issue, with the true count kept', () => {
    // Four rectangles that cross, and almost 20,000 more pinched across them: too complex to
    // merge, as one error involving every path.
    const rect = (x0: number, y0: number, x1: number, y1: number): SvgOutlinePath => ({
      fillRule: 'nonzero',
      commands: polygon([
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]),
    });
    const n = 19_996;
    const paths = [
      rect(0, 0, 10, 10),
      rect(10, 10, 20, 20),
      rect(-5, 18, 25, 25),
      rect(-5, 0, 2, 25),
      ...Array.from({ length: n }, (_, i) => {
        const x = -4 + (i * 28) / n;
        return rect(x, 16 + (i % 7) * 0.13, x + 1.7 + (i % 5) * 0.011, 23 + (i % 3) * 0.17);
      }),
    ];
    const r = svgOutlineRegions(paths, 1);
    const error = r.issues.find((i) => i.severity === 'error')!;
    expect(error.code).toBe('too-complex');
    for (const issue of r.issues) {
      expect(issue.parts.length).toBeLessThanOrEqual(3);
      expect(issue.contours.length).toBeLessThanOrEqual(3);
    }
    expect(error.partCount).toBe(20_000);
    expect(r.issues.map((i) => i.message).join('').length).toBeLessThan(1000);
    expect(svgIssueShapes(error)).toBe('1, 2, 3 and 19,997 more');
    expect(svgIssueShapes({ parts: [4] })).toBe('5');
    expect(svgIssueShapes({ parts: [] })).toBe('');
  }, 60_000);

  it('gives the same regions for a shape with many open subpaths beside it as for the shape alone', () => {
    const shape: SvgOutlinePath = {
      fillRule: 'evenodd',
      commands: [...square(0, 0, 10), ...square(2, 2, 6)],
    };
    const open: PathCommand[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = 20 + (i % 50) * 0.5;
      const y = Math.floor(i / 50) * 0.5;
      open.push({ kind: 'moveTo', to: [x, y] }, { kind: 'lineTo', to: [x + 0.2, y] });
    }
    const alone = svgOutlineRegions([shape], 1);
    const beside = svgOutlineRegions([shape, { fillRule: 'nonzero', commands: open }], 1);
    expect(beside.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(beside.issues.map((i) => i.code).sort()).toEqual(['empty-contour', 'open-contour']);
    const strip = (x: typeof alone) =>
      x.regions.map((r) => ({
        outer: { area: r.outer.area, segments: r.outer.segments.length },
        holes: r.holes.map((h) => ({ area: h.area, segments: h.segments.length })),
      }));
    expect(strip(beside)).toEqual(strip(alone));
    expect(alone.regions).toHaveLength(1);
    expect(alone.regions[0]!.holes).toHaveLength(1);
  });
});
