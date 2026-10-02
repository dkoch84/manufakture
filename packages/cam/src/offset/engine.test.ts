import { describe, expect, it } from 'vitest';
import type { Loop2, Segment2, Vec2 } from '../types';
import { analyticOffset } from './analytic';
import {
  differenceLoops,
  intersectLoops,
  offsetLoops,
  offsetOpenPaths,
  regionArea,
  regionLoops,
  unionLoops,
} from './engine';
import type { Region2 } from './engine';
import { arcRadius, dist, loopArea, loopLength, signedSweep } from './geometry';
import { grblArcPrecheck } from './grbl';
import {
  allLoops,
  allSegments,
  circle,
  convexPolygon,
  dumbbell,
  hausdorff,
  hole,
  offsetDeviation,
  polygon,
  rect,
  rng,
  roundedRect,
  slot,
} from './test-shapes';
import { DEMOTE_SAGITTA, MAX_ARC_SWEEP, MAX_COORD_MM, REFIT_TOLERANCE } from './tolerances';

/** The offset budget after refit (ADR 0014 decision 12), plus float slack for the samples. */
const BUDGET = REFIT_TOLERANCE + 1e-6;
const PI = Math.PI;

function value<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/**
 * Every result loop is continuous and closed, outers run counter-clockwise and holes clockwise,
 * and every arc is on its circle, at most half a turn, never a full circle, and passes Grbl's
 * radius rule (error 33) and angular travel at 3 and 4 decimals.
 */
function expectWellFormed(regions: readonly Region2[]): void {
  for (const r of regions) {
    expect(loopArea(r.outer)).toBeGreaterThan(0);
    for (const h of r.holes) expect(loopArea(h)).toBeLessThan(0);
  }
  for (const loop of regionLoops(regions)) {
    expect(loop.segments.length).toBeGreaterThanOrEqual(2);
    loop.segments.forEach((s, i) => {
      const prev = loop.segments[(i + loop.segments.length - 1) % loop.segments.length]!;
      expect(s.start).toEqual(prev.end);
      if (s.kind === 'line') {
        expect(dist(s.start, s.end)).toBeGreaterThan(0);
        return;
      }
      expect(s.fullCircle).toBeUndefined();
      expect(Math.abs(dist(s.end, s.center) - arcRadius(s))).toBeLessThan(1e-9);
      expect(Math.abs(signedSweep(s))).toBeGreaterThan(0);
      expect(Math.abs(signedSweep(s))).toBeLessThanOrEqual(MAX_ARC_SWEEP + 1e-6);
      for (const decimals of [3, 4]) {
        const check = grblArcPrecheck(s, decimals);
        expect(check.radiusDiff).toBeLessThanOrEqual(0.005);
        expect(check.ok).toBe(true);
      }
    });
  }
}

const arcs = (regions: readonly Region2[]) =>
  allSegments(regions).filter((s): s is Segment2 & { kind: 'arc' } => s.kind === 'arc');

const radii = (regions: readonly Region2[]) => arcs(regions).map(arcRadius);

const totalArea = (regions: readonly Region2[]) => regions.reduce((a, r) => a + regionArea(r), 0);

/** Area tolerance: the whole boundary off by the budget. */
const areaTol = (regions: readonly Region2[]) =>
  regionLoops(regions).reduce((a, l) => a + loopLength(l), 0) * BUDGET;

/** Checks an offset against its exact answer: area, deviation and form. */
function expectOffset(
  source: readonly Loop2[],
  d: number,
  exactArea: number,
  analytic = false,
): Region2[] {
  const regions = value(offsetLoops(source, d, { analytic }));
  expectWellFormed(regions);
  expect(offsetDeviation(allLoops(regions), source, d)).toBeLessThanOrEqual(BUDGET);
  expect(Math.abs(totalArea(regions) - exactArea)).toBeLessThanOrEqual(areaTol(regions));
  return regions;
}

describe('offsets against analytic results', () => {
  for (const analytic of [false, true]) {
    const via = analytic ? 'fast path' : 'Clipper';
    it(`rectangle outward and inward (${via})`, () => {
      const r = rect(0, 0, 100, 60);
      const out = expectOffset([r], 3, 6000 + 2 * 3 * 160 + 9 * PI, analytic);
      // Four sides and four round joins of radius 3, exact.
      expect(allSegments(out)).toHaveLength(8);
      for (const x of radii(out)) expect(x).toBeCloseTo(3, 9);
      const inner = expectOffset([r], -3, 94 * 54, analytic);
      expect(allSegments(inner).every((s) => s.kind === 'line')).toBe(true);
      expect(allSegments(inner)).toHaveLength(4);
    });

    it(`rounded rectangle: arcs stay arcs on the exact circles (${via})`, () => {
      const r = roundedRect(100, 60, 8);
      const area = (w: number, h: number, rr: number) => w * h - (4 - PI) * rr * rr;
      const out = expectOffset([r], 3, area(106, 66, 11), analytic);
      expect(allSegments(out)).toHaveLength(8);
      for (const x of radii(out)) expect(x).toBeCloseTo(11, 9);
      const inner = expectOffset([r], -3, area(94, 54, 5), analytic);
      expect(allSegments(inner)).toHaveLength(8);
      for (const x of radii(inner)) expect(x).toBeCloseTo(5, 9);
    });

    it(`circle (${via})`, () => {
      const c = circle([10, -5], 10);
      for (const d of [3, -3, -9.5]) {
        const out = expectOffset([c], d, PI * (10 + d) ** 2, analytic);
        expect(out).toHaveLength(1);
        for (const x of radii(out)) expect(x).toBeCloseTo(10 + d, 9);
        expect(allSegments(out).every((s) => s.kind === 'arc')).toBe(true);
      }
    });

    it(`slot (${via})`, () => {
      const s = slot([0, 0], 30, 10);
      const area = (w: number) => 30 * w + PI * (w / 2) ** 2;
      const out = expectOffset([s], 3, area(16), analytic);
      for (const x of radii(out)) expect(x).toBeCloseTo(8, 9);
      const inner = expectOffset([s], -3, area(4), analytic);
      for (const x of radii(inner)) expect(x).toBeCloseTo(2, 9);
    });
  }

  it('a slot narrower than the tool vanishes, and one a little wider leaves a sliver', () => {
    expect(value(offsetLoops([slot([0, 0], 30, 5)], -3))).toEqual([]);
    expect(value(offsetLoops([rect(0, 0, 5, 40)], -3))).toEqual([]);
    expect(value(offsetLoops([circle([0, 0], 2)], -3))).toEqual([]);
    expect(value(offsetLoops([circle([0, 0], 2)], -3, { analytic: false }))).toEqual([]);
    // A 6.2 mm slot under a 6 mm tool: a 0.2 mm wide sliver remains.
    const sliver = expectOffset([rect(0, 0, 6.2, 40)], -3, 0.2 * 34);
    expect(sliver).toHaveLength(1);
  });

  it('an inward offset can split a shape in two', () => {
    const regions = value(offsetLoops([dumbbell(4)], -3));
    expect(regions).toHaveLength(2);
    expectWellFormed(regions);
    expect(offsetDeviation(allLoops(regions), [dumbbell(4)], -3)).toBeLessThanOrEqual(BUDGET);
    // Each half is the lobe's r7 circle, bulged slightly where it passes the neck's corners.
    for (const r of regions) {
      expect(regionArea(r)).toBeGreaterThan(49 * PI);
      expect(regionArea(r)).toBeLessThan(49 * PI + 1);
      expect(radii([r]).some((x) => Math.abs(x - 7) < 1e-9)).toBe(true);
    }
    // A neck wider than the tool keeps it in one piece.
    expect(value(offsetLoops([dumbbell(8)], -3))).toHaveLength(1);
  });

  it('holes grow and shrink with the material, and an island is its own region', () => {
    const bracket = [
      roundedRect(100, 60, 8),
      hole(circle([-35, 0], 6)),
      hole(circle([35, 0], 6)),
      hole(slot([0, 0], 20, 10)),
    ];
    const plate = 100 * 60 - (4 - PI) * 64 - 2 * 36 * PI - (20 * 10 + 25 * PI);
    expect(Math.abs(bracket.reduce((a, l) => a + loopArea(l), 0) - plate)).toBeLessThan(1e-9);
    // Inward (the material shrinks): holes of r6 become r9, the slot 16 wide.
    const inner = value(offsetLoops(bracket, -3));
    expectWellFormed(inner);
    expect(inner).toHaveLength(1);
    expect(inner[0]!.holes).toHaveLength(3);
    expect(offsetDeviation(allLoops(inner), bracket, -3)).toBeLessThanOrEqual(BUDGET);
    const innerArea = 94 * 54 - (4 - PI) * 25 - 2 * 81 * PI - (20 * 16 + 64 * PI);
    expect(Math.abs(totalArea(inner) - innerArea)).toBeLessThanOrEqual(areaTol(inner));
    // Outward: holes shrink to r3, the slot to 4 wide.
    const outer = value(offsetLoops(bracket, 3));
    expectWellFormed(outer);
    expect(outer[0]!.holes).toHaveLength(3);
    const outerArea = 106 * 66 - (4 - PI) * 121 - 2 * 9 * PI - (20 * 4 + 4 * PI);
    expect(Math.abs(totalArea(outer) - outerArea)).toBeLessThanOrEqual(areaTol(outer));

    // A frame with an island in its window.
    const frame = [rect(-50, -50, 100, 100), hole(rect(-30, -30, 60, 60)), circle([0, 0], 15)];
    const grown = value(offsetLoops(frame, 3));
    expectWellFormed(grown);
    expect(grown).toHaveLength(2);
    const ring = grown.find((r) => r.holes.length === 1)!;
    const island = grown.find((r) => r.holes.length === 0)!;
    expect(regionArea(ring)).toBeCloseTo(106 * 106 - (4 - PI) * 9 - 54 * 54, 1);
    expect(regionArea(island)).toBeCloseTo(PI * 18 * 18, 1);
    for (const x of radii([island])) expect(x).toBeCloseTo(18, 9);
    // Grow it far enough and the island merges into the frame: of the window, only its four
    // corners stay open.
    const merged = value(offsetLoops(frame, 8));
    expectWellFormed(merged);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.holes).toHaveLength(4);
  });

  it('every pocket ring is offset from the source and passes the checks', () => {
    // The spike's pocket: 200 x 160 rounded r20 with an r12 island, rings 1.5 apart.
    const pocket = [roundedRect(200, 160, 20), hole(circle([30, 20], 12))];
    let rings = 0;
    for (let k = 0; k < 50; k++) {
      const d = -3 - 1.5 * k;
      const regions = value(offsetLoops(pocket, d));
      if (regions.length === 0) continue;
      rings++;
      expectWellFormed(regions);
      expect(offsetDeviation(allLoops(regions), pocket, d)).toBeLessThanOrEqual(BUDGET);
    }
    expect(rings).toBeGreaterThan(30);
  });

  it('carries source tags through the offset', () => {
    const regions = value(offsetLoops([rect(0, 0, 40, 20, true)], 2, { analytic: false }));
    const lines = allSegments(regions).filter((s) => s.kind === 'line');
    expect(lines.map((s) => (s.source?.kind === 'sketch' ? s.source.entity : '')).sort()).toEqual([
      'e0',
      'e1',
      'e2',
      'e3',
    ]);
    // The round joins have no source.
    expect(arcs(regions).every((s) => s.source === undefined)).toBe(true);
    const src = { kind: 'hole', feature: 'hole#1' } as const;
    for (const analytic of [true, false]) {
      const ring = value(offsetLoops([circle([0, 0], 5, src)], -1, { analytic }));
      expect(arcs(ring).every((s) => s.source === src)).toBe(true);
    }
  });

  it('refits a dense polygon without tags to a few arcs', () => {
    const pts: Vec2[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = (i / 2000) * 2 * PI;
      pts.push([50 * Math.cos(a), 50 * Math.sin(a)]);
    }
    const regions = value(offsetLoops([polygon(pts)], 3));
    expectWellFormed(regions);
    expect(allSegments(regions).length).toBeLessThan(20);
    expect(offsetDeviation(allLoops(regions), [polygon(pts)], 3)).toBeLessThanOrEqual(BUDGET);
  });
});

describe('the analytic fast path', () => {
  it('agrees with Clipper where it applies, and is exact', () => {
    const random = rng(7);
    const shapes = [
      roundedRect(80, 30, 6),
      slot([5, 5], 40, 12),
      rect(-10, -10, 20, 35),
      convexPolygon(random, 7, 40, 25),
    ];
    for (const shape of shapes) {
      const fast = analyticOffset(shape, 2.5);
      expect(fast).toBeDefined();
      const clip = value(offsetLoops([shape], 2.5, { analytic: false }));
      expect(hausdorff(fast!, allLoops(clip))).toBeLessThanOrEqual(BUDGET);
      // Exact but for joins short enough to be written as lines.
      expect(offsetDeviation(fast!, [shape], 2.5)).toBeLessThanOrEqual(DEMOTE_SAGITTA + 1e-9);
    }
  });

  it('declines what it cannot do safely', () => {
    expect(analyticOffset(roundedRect(80, 30, 6), -2)).toBeUndefined(); // inward
    expect(analyticOffset(dumbbell(), 2)).toBeUndefined(); // not convex
    expect(analyticOffset(hole(roundedRect(80, 30, 6)), 2)).toBeUndefined(); // clockwise
    expect(analyticOffset(hole(circle([0, 0], 5)), 2)).toBeUndefined();
    const pts: Vec2[] = [];
    for (let i = 0; i < 500; i++) pts.push([Math.cos(i / 79.6), Math.sin(i / 79.6)]);
    expect(analyticOffset(polygon(pts), 2)).toBeUndefined(); // joins too small to be arcs
  });
});

describe('open paths', () => {
  const lineTo = (a: Vec2, b: Vec2): Segment2 => ({ kind: 'line', start: a, end: b });

  it('a line with round and butt ends', () => {
    const path = { segments: [lineTo([0, 0], [50, 0])] };
    const round = value(offsetOpenPaths([path], 3));
    expectWellFormed(round);
    expect(totalArea(round)).toBeCloseTo(300 + 9 * PI, 9);
    for (const x of radii(round)) expect(x).toBeCloseTo(3, 9);
    expect(offsetDeviation(allLoops(round), [{ segments: path.segments }], 3)).toBeLessThan(BUDGET);
    const butt = value(offsetOpenPaths([path], 3, { ends: 'butt' }));
    expectWellFormed(butt);
    expect(totalArea(butt)).toBeCloseTo(300, 9);
    expect(arcs(butt)).toHaveLength(0);
  });

  it('an arc path gives an annular sector with concentric arcs', () => {
    // A quarter arc of radius 20, 2 mm each side, butt ends.
    const path = {
      segments: [{ kind: 'arc', start: [20, 0], end: [0, 20], center: [0, 0], ccw: true } as const],
    };
    const regions = value(offsetOpenPaths([path], 2, { ends: 'butt' }));
    expectWellFormed(regions);
    expect(totalArea(regions)).toBeCloseTo((PI / 4) * (22 * 22 - 18 * 18), 2);
    const rs = radii(regions).sort((a, b) => a - b);
    expect(rs[0]).toBeCloseTo(18, 9);
    expect(rs[rs.length - 1]).toBeCloseTo(22, 9);
    // The butt ends are square to the arc's tangent (not to its first chord): exact radial lines.
    const caps = allSegments(regions).filter((x) => x.kind === 'line');
    expect(caps).toHaveLength(2);
    for (const cap of caps) {
      const ends = [cap.start, cap.end].map((p) => [Math.hypot(...p), Math.atan2(p[1], p[0])]);
      expect(ends.map(([r]) => r).sort()).toEqual([expect.closeTo(18, 9), expect.closeTo(22, 9)]);
      expect(ends[0]![1]).toBeCloseTo(ends[1]![1]!, 9);
    }
    // Round ends add two half disks.
    const round = value(offsetOpenPaths([path], 2));
    expectWellFormed(round);
    expect(Math.abs(totalArea(round) - (PI / 4) * (22 * 22 - 18 * 18) - 4 * PI)).toBeLessThan(
      areaTol(round),
    );
    expect(offsetDeviation(allLoops(round), [{ segments: path.segments }], 2)).toBeLessThan(BUDGET);
  });

  it('a self-crossing stroke is united into one region', () => {
    const path = {
      segments: [lineTo([0, 0], [40, 0]), lineTo([40, 0], [20, 20]), lineTo([20, 20], [20, -20])],
    };
    const regions = value(offsetOpenPaths([path], 1));
    expectWellFormed(regions);
    expect(regions).toHaveLength(1);
  });
});

describe('booleans', () => {
  it('stock minus part', () => {
    const part = roundedRect(100, 60, 8);
    const regions = value(differenceLoops([rect(-60, -40, 120, 80)], [part]));
    expectWellFormed(regions);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(1);
    expect(regionArea(regions[0]!)).toBeCloseTo(9600 - (6000 - (4 - PI) * 64), 6);
    for (const x of radii(regions)) expect(x).toBeCloseTo(8, 9);
  });

  it('pocket minus islands, and the island crossing the wall', () => {
    const pocket = rect(0, 0, 100, 60);
    const regions = value(differenceLoops([pocket], [circle([30, 30], 10), circle([100, 30], 10)]));
    expectWellFormed(regions);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(1);
    expect(totalArea(regions)).toBeCloseTo(6000 - 100 * PI - 50 * PI, 2);
    for (const x of radii(regions)) expect(x).toBeCloseTo(10, 9);
  });

  it('union and intersection of two circles', () => {
    const a = circle([0, 0], 10);
    const b = circle([12, 0], 10);
    // Lens: 2 r^2 acos(d / 2r) - (d / 2) sqrt(4 r^2 - d^2).
    const lens = 2 * 100 * Math.acos(12 / 20) - 6 * Math.sqrt(400 - 144);
    const both = value(unionLoops([a, b]));
    expectWellFormed(both);
    expect(both).toHaveLength(1);
    expect(totalArea(both)).toBeCloseTo(200 * PI - lens, 2);
    const common = value(intersectLoops([a], [b]));
    expectWellFormed(common);
    expect(totalArea(common)).toBeCloseTo(lens, 2);
    for (const x of radii(common)) expect(x).toBeCloseTo(10, 9);
    // A boolean's arcs keep their source arcs' circles: two arcs for the lens.
    expect(arcs(common)).toHaveLength(2);
  });

  it('a zero offset is the union of the loops', () => {
    const regions = value(offsetLoops([rect(0, 0, 10, 10), rect(5, 5, 10, 10)], 0));
    expect(regions).toHaveLength(1);
    expect(totalArea(regions)).toBeCloseTo(175, 9);
  });
});

describe('winding and consistency', () => {
  it('a clockwise loop that nothing encloses encloses nothing', () => {
    for (const analytic of [true, false]) {
      for (const d of [0, 1e-3, 1, -1]) {
        expect(value(offsetLoops([hole(rect(0, 0, 10, 10))], d, { analytic }))).toEqual([]);
        expect(value(offsetLoops([hole(circle([0, 0], 5))], d, { analytic }))).toEqual([]);
      }
    }
    expect(value(unionLoops([hole(rect(0, 0, 10, 10))]))).toEqual([]);
  });

  it('a stray clockwise loop beside an outer changes nothing', () => {
    const alone = value(offsetLoops([rect(0, 0, 10, 10)], 1, { analytic: false }));
    const stray = value(offsetLoops([rect(0, 0, 10, 10), hole(rect(20, 0, 5, 5))], 1));
    expectWellFormed(stray);
    expect(stray).toHaveLength(1);
    expect(stray[0]!.holes).toHaveLength(0);
    expect(totalArea(stray)).toBeCloseTo(totalArea(alone), 9);
    expect(totalArea(stray)).toBeCloseTo(100 + 40 + PI, 6);
    // A clockwise loop crossing the outer still cuts it: positive winding is inside.
    const notch = value(offsetLoops([rect(0, 0, 10, 10), hole(rect(8, 4, 4, 2))], -0.5));
    expectWellFormed(notch);
    expect(notch).toHaveLength(1);
    expect(totalArea(notch)).toBeLessThan(9 * 9);
  });

  it('a circle shrinking to a speck vanishes the same way on both paths', () => {
    for (const analytic of [true, false]) {
      expect(value(offsetLoops([circle([0, 0], 5)], -(5 - 0.001), { analytic }))).toEqual([]);
      const small = value(offsetLoops([circle([0, 0], 5)], -(5 - 0.05), { analytic }));
      expect(small).toHaveLength(1);
      expect(totalArea(small)).toBeCloseTo(PI * 0.05 * 0.05, 4);
    }
  });

  it('honours the decimals of the Grbl pre-check on both paths', () => {
    // Round joins of radius 0.01 mm: arcs at 3 decimals, but at 1 decimal their written ends
    // coincide, so they become lines.
    for (const analytic of [true, false]) {
      const fine = value(offsetLoops([rect(0, 0, 10, 10)], 0.01, { analytic }));
      expect(arcs(fine)).toHaveLength(4);
      const coarse = value(offsetLoops([rect(0, 0, 10, 10)], 0.01, { analytic, decimals: 1 }));
      expect(arcs(coarse)).toHaveLength(0);
      expect(allSegments(coarse)).toHaveLength(8);
    }
  });
});

describe('invalid input', () => {
  it('refuses non-finite, out-of-range and broken loops, and bad offsets', () => {
    const cases: [readonly Loop2[], number][] = [
      [[rect(0, 0, 10, Number.NaN)], 1],
      [[rect(0, 0, MAX_COORD_MM + 1, 10)], 1],
      [
        [
          polygon([
            [0, 0],
            [10, 0],
            [10, 10],
          ]).segments.slice(0, 2),
        ].map((s) => ({ segments: s })),
        1,
      ],
      [[rect(0, 0, 10, 10)], Number.POSITIVE_INFINITY],
      [
        [
          {
            segments: [
              { kind: 'arc', start: [1, 0], end: [1, 0], center: [0, 0], ccw: true },
            ] as const,
          },
        ],
        1,
      ],
    ];
    for (const [loops, d] of cases) {
      const r = offsetLoops(loops, d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-input');
    }
    const open = offsetOpenPaths([{ segments: rect(0, 0, 1, 1).segments }], 0);
    expect(open.ok).toBe(false);
    expect(differenceLoops([rect(0, 0, 1, 1)], [rect(0, 0, Infinity, 1)]).ok).toBe(false);
    expect(value(offsetLoops([], 3))).toEqual([]);
    expect(value(offsetOpenPaths([], 3))).toEqual([]);
  });
});
