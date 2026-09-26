import { describe, expect, it } from 'vitest';
import type { SketchEntity, Vec2 } from './model';
import { SKETCHES, arc, circle, line, rect, slot } from './region-sketches';
import {
  detectRegions,
  type Region,
  type RegionDiagnosticCode,
  type SketchRegions,
} from './regions';

const codes = (r: SketchRegions, severity?: 'info' | 'warning'): RegionDiagnosticCode[] =>
  r.diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

const edgeIds = (region: Region): string[] =>
  [region.outer, ...region.holes].flatMap((l) => l.curves.map((c) => c.edgeId));

/** Every loop is closed: each curve starts where the previous one ends. */
function expectClosed(region: Region): void {
  for (const loop of [region.outer, ...region.holes]) {
    const n = loop.curves.length;
    loop.curves.forEach((c, i) => {
      if (c.kind === 'circle') {
        expect(n).toBe(1);
        return;
      }
      const next = loop.curves[(i + 1) % n]!;
      expect(next.kind).not.toBe('circle');
      if (next.kind !== 'circle') {
        expect(Math.hypot(c.end[0] - next.start[0], c.end[1] - next.start[1])).toBeLessThan(1e-9);
      }
    });
  }
  expect(region.outer.area).toBeGreaterThan(0);
  for (const h of region.holes) expect(h.area).toBeLessThan(0);
}

/** Everything that names or classifies: ids, holes, edge ids, diagnostics (not coordinates). */
const signature = (r: SketchRegions) => ({
  regions: r.regions.map((x) => [x.id, x.holes.length, edgeIds(x)]),
  voids: r.voids.map((x) => [x.id, x.holes.length, edgeIds(x)]),
  diagnostics: r.diagnostics.map((d) => [d.code, d.severity, d.message, d.entityIds]),
});

function detect(entities: SketchEntity[]): SketchRegions {
  const r = detectRegions(entities);
  for (const region of [...r.regions, ...r.voids]) expectClosed(region);
  return r;
}

describe('detectRegions: acceptance', () => {
  it('a rectangle with a circular hole is one region with one hole', () => {
    const r = detect(SKETCHES.rectWithHole());
    expect(r.regions).toHaveLength(1);
    const [region] = r.regions;
    expect(region!.id).toBe('l1/L+l2/L+l3/L+l4/L');
    expect(region!.fragile).toBe(false);
    expect(region!.holes).toHaveLength(1);
    expect(region!.area).toBeCloseTo(40 * 30 - Math.PI * 25, 9);
    expect(region!.depth).toBe(0);
    const hole = region!.holes[0]!.curves;
    expect(hole).toHaveLength(1);
    expect(hole[0]).toMatchObject({ kind: 'circle', edgeId: 'c1', reversed: true, radius: 5 });
    expect(edgeIds(region!)).toEqual(['l1', 'l2', 'l3', 'l4', 'c1']);
    // The disc inside the hole is a void, selectable on its own.
    expect(r.voids.map((v) => v.id)).toEqual(['c1/L']);
    expect(r.voids[0]!.depth).toBe(1);
    expect(r.diagnostics).toEqual([]);
  });

  it('two overlapping rectangles are three regions', () => {
    const r = detect(SKETCHES.overlappingRects());
    expect(r.regions).toHaveLength(3);
    expect(r.voids).toHaveLength(0);
    const areas = r.regions.map((x) => x.area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(25, 9);
    expect(areas[1]).toBeCloseTo(75, 9);
    expect(areas[2]).toBeCloseTo(75, 9);
    expect(r.regions.map((x) => x.id)).toEqual([
      'a1/L+a2/L+a3/L+a4/L+b1/R+b4/R',
      'a2/L+a3/L+b1/L+b4/L',
      'a2/R+a3/R+b1/L+b2/L+b3/L+b4/L',
    ]);
    // The crossings split a2, a3, b1 and b4 into positional pieces.
    const middle = r.regions.find((x) => x.area < 30)!;
    expect(edgeIds(middle).sort()).toEqual(['a2#2', 'a3#1', 'b1#1', 'b4#2']);
    expect(middle.outer.curves.every((c) => c.fragile)).toBe(true);
    expect(codes(r)).toEqual(['crossing', 'crossing']);
    expect(r.diagnostics.every((d) => d.severity === 'info')).toBe(true);
  });

  it('an open polyline is no region, with a warning naming it and its open ends', () => {
    const r = detect([
      line('p1', [0, 0], [10, 0]),
      line('p2', [10, 0], [10, 5]),
      line('p3', [10, 5], [3, 8]),
    ]);
    expect(r.regions).toEqual([]);
    expect(r.voids).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    const [d] = r.diagnostics;
    expect(d).toMatchObject({
      code: 'open-profile',
      severity: 'warning',
      entityIds: ['p1', 'p2', 'p3'],
    });
    expect(d!.points).toEqual(
      expect.arrayContaining([
        [0, 0],
        [3, 8],
      ]),
    );
  });
});

describe('detectRegions: shapes', () => {
  it('an arc-bounded slot', () => {
    const r = detect(SKETCHES.slot());
    expect(r.regions).toHaveLength(1);
    const region = r.regions[0]!;
    expect(region.id).toBe('s1/L+s2/L+s3/L+s4/L');
    expect(region.area).toBeCloseTo(30 * 10 + Math.PI * 25, 9);
    expect(region.outer.curves.map((c) => c.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    expect(region.outer.curves.every((c) => !c.reversed && !c.fragile)).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it('a rounded rectangle: lines tangent to corner arcs', () => {
    const r = 2;
    const entities: SketchEntity[] = [
      line('e1', [r, 0], [20 - r, 0]),
      arc('a1', [20 - r, r], [20 - r, 0], [20, r]),
      line('e2', [20, r], [20, 10 - r]),
      arc('a2', [20 - r, 10 - r], [20, 10 - r], [20 - r, 10]),
      line('e3', [20 - r, 10], [r, 10]),
      arc('a3', [r, 10 - r], [r, 10], [0, 10 - r]),
      line('e4', [0, 10 - r], [0, r]),
      arc('a4', [r, r], [0, r], [r, 0]),
    ];
    const out = detect(entities);
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0]!.area).toBeCloseTo(200 - (4 - Math.PI) * r * r, 9);
  });

  it('internally tangent circles: a crescent whose hole touches it, and the inner disc', () => {
    const r = detect([circle('c1', [0, 0], 10), circle('c2', [5, 0], 5)]);
    expect(r.regions.map((x) => x.id)).toEqual(['c1/L', 'c2/L']);
    const crescent = r.regions.find((x) => x.id === 'c1/L')!;
    expect(crescent.area).toBeCloseTo(Math.PI * 75, 9);
    expect(crescent.holes).toHaveLength(1);
    expect(crescent.outer.curves).toMatchObject([{ kind: 'circle', edgeId: 'c1' }]);
    expect(crescent.holes[0]!.curves).toMatchObject([
      { kind: 'circle', edgeId: 'c2', reversed: true },
    ]);
    expect(r.regions.find((x) => x.id === 'c2/L')!.area).toBeCloseTo(Math.PI * 25, 9);
    expect(codes(r)).toEqual(['touching']);
    expect(r.diagnostics[0]!.points![0]![0]).toBeCloseTo(10, 9);
  });

  it('externally tangent circles are two discs that do not cross', () => {
    const r = detect([circle('c1', [0, 0], 4), circle('c2', [7, 0], 3)]);
    expect(r.regions.map((x) => x.id)).toEqual(['c1/L', 'c2/L']);
    expect(r.regions.map((x) => x.area)).toEqual([
      expect.closeTo(Math.PI * 16, 9),
      expect.closeTo(Math.PI * 9, 9),
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  it('a circle crossing a line: two regions told apart by side, with split circle edges', () => {
    const r = detect(SKETCHES.circleAndLine());
    expect(r.regions.map((x) => x.id)).toEqual(['c1/L+l1/L', 'c1/L+l1/R']);
    const total = r.regions.reduce((a, x) => a + x.area, 0);
    expect(total).toBeCloseTo(Math.PI * 100, 9);
    const above = r.regions[0]!;
    expect(above.area).toBeLessThan(total / 2);
    // The line bounds each region in one stretch, so it keeps its own id;
    // the circle is used in two stretches.
    expect(above.outer.curves.map((c) => [c.edgeId, c.fragile]).sort()).toEqual([
      ['c1#1', true],
      ['l1', false],
    ]);
    expect(edgeIds(r.regions[1]!).sort()).toEqual(['c1#2', 'l1']);
    expect(codes(r, 'info')).toEqual(['crossing', 'overhang']);
  });

  it('an island in a hole is a region again (even-odd)', () => {
    const r = detect(SKETCHES.island());
    expect(r.regions.map((x) => [x.id, x.depth, x.holes.length])).toEqual([
      ['c2/L', 2, 0],
      ['l1/L+l2/L+l3/L+l4/L', 0, 1],
    ]);
    expect(r.voids.map((x) => [x.id, x.depth, x.holes.length])).toEqual([['c1/L', 1, 1]]);
    expect(r.voids[0]!.area).toBeCloseTo(Math.PI * (144 - 25), 9);
    expect(r.regions[1]!.area).toBeCloseTo(1600 - Math.PI * 144, 9);
  });

  it('a T-junction splits the rectangle and names the split sides by position', () => {
    const r = detect(SKETCHES.tJunction());
    expect(r.regions.map((x) => x.id)).toEqual(['l1/L+l2/L+l3/L+m/R', 'l1/L+l3/L+l4/L+m/L']);
    expect(edgeIds(r.regions[0]!).sort()).toEqual(['l1#2', 'l2', 'l3#1', 'm']);
    expect(edgeIds(r.regions[1]!).sort()).toEqual(['l1#1', 'l3#2', 'l4', 'm']);
    expect(r.regions.map((x) => x.area)).toEqual([expect.closeTo(100, 9), expect.closeTo(100, 9)]);
    expect(r.diagnostics).toEqual([]);
  });

  it('collinear overlapping lines share one edge, with a warning', () => {
    // b's left side lies on a's right side, over part of its length.
    const r = detect([...rect('a', 0, 0, 10, 10), ...rect('b', 10, 2, 20, 8)]);
    expect(r.regions).toHaveLength(2);
    expect(r.regions.map((x) => x.area).sort((p, q) => p - q)).toEqual([
      expect.closeTo(60, 9),
      expect.closeTo(100, 9),
    ]);
    const b = r.regions.find((x) => x.area < 80)!;
    expect(b.id).toBe('a2/R+b1/L+b2/L+b3/L');
    expect(edgeIds(b).sort()).toEqual(['a2#2', 'b1', 'b2', 'b3']);
    expect(r.diagnostics.filter((d) => d.severity === 'warning')).toMatchObject([
      { code: 'overlap', entityIds: ['a2', 'b4'] },
    ]);
  });

  it('an exact duplicate with a larger id is dropped with a warning', () => {
    const r = detect([...rect('l', 0, 0, 4, 4), line('x', [4, 0], [4, 4])]);
    expect(r.regions.map((x) => x.id)).toEqual(['l1/L+l2/L+l3/L+l4/L']);
    expect(codes(r)).toEqual(['overlap']);
  });

  it('a bowtie crosses itself: two triangles and a crossing', () => {
    const r = detect([
      line('e1', [0, 0], [10, 10]),
      line('e2', [10, 10], [10, 0]),
      line('e3', [10, 0], [0, 10]),
      line('e4', [0, 10], [0, 0]),
    ]);
    expect(r.regions).toHaveLength(2);
    expect(r.regions.map((x) => x.area)).toEqual([expect.closeTo(25, 9), expect.closeTo(25, 9)]);
    expect(r.diagnostics).toMatchObject([
      { code: 'crossing', entityIds: ['e1', 'e3'], points: [[5, 5]] },
    ]);
  });

  it('reports dangling edges and bridges, and keeps the regions', () => {
    const r = detect([
      ...rect('a', 0, 0, 10, 10),
      ...rect('b', 20, 0, 30, 10),
      line('bridge', [10, 5], [20, 5]),
      line('tail', [30, 10], [35, 15]),
    ]);
    expect(r.regions.map((x) => x.id)).toEqual(['a1/L+a2/L+a3/L+a4/L', 'b1/L+b2/L+b3/L+b4/L']);
    // a2 is split where the bridge meets it, but the bridge is gone, so a2 is whole again.
    expect(edgeIds(r.regions[0]!)).toContain('a2');
    expect(r.diagnostics.map((d) => [d.code, d.entityIds])).toEqual([
      ['dangling-edge', ['bridge']],
      ['dangling-edge', ['tail']],
    ]);
  });

  it('ignores construction geometry and points, and reports degenerate entities', () => {
    const r = detect([
      ...rect('l', 0, 0, 5, 5),
      line('diag', [0, 0], [5, 5], true),
      { id: 'p', kind: 'point', construction: false, position: [1, 1] },
      line('zero', [7, 7], [7, 7]),
      arc('bad', [0, 0], [1, 0], [0, 2]),
    ]);
    expect(r.regions).toHaveLength(1);
    expect(r.diagnostics.map((d) => [d.code, d.entityIds])).toEqual([
      ['degenerate', ['zero']],
      ['degenerate', ['bad']],
    ]);
  });

  it('closes loops whose ends miss by less than the tolerance', () => {
    const e = 1e-9;
    const r = detect([
      line('e1', [0, 0], [10, 0]),
      line('e2', [10 + e, 0], [10, 10]),
      line('e3', [10, 10 - e], [0, 10]),
      line('e4', [0, 10], [e, 0]),
    ]);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0]!.area).toBeCloseTo(100, 6);
  });

  it('numbers faces by position when entities and sides do not tell them apart', () => {
    // A vertical line cuts off both horns of a crescent: two faces bounded by
    // c1 inside, c2 outside and l1 on its right.
    const r = detect([
      circle('c1', [0, 0], 10),
      circle('c2', [4, 0], 10),
      line('l1', [1, -20], [1, 20]),
    ]);
    const horns = r.regions.filter((x) => x.id.startsWith('c1/L+c2/R+l1/R#'));
    expect(horns.map((x) => x.id)).toEqual(['c1/L+c2/R+l1/R#1', 'c1/L+c2/R+l1/R#2']);
    expect(horns.every((x) => x.fragile)).toBe(true);
    // #1 is the lower one.
    const y = (x: Region) =>
      x.outer.curves[0]!.kind === 'circle' ? 0 : x.outer.curves[0]!.start[1];
    expect(y(horns[0]!)).toBeLessThan(0);
    expect(y(horns[1]!)).toBeGreaterThan(0);
    expect(codes(r)).toContain('ambiguous-id');
    const ids = [...r.regions, ...r.voids].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('detectRegions: near-tangency', () => {
  // Each sketch is exactly tangent at eps = 0; eps > 0 overlaps, eps < 0 separates.
  const cases: [string, (eps: number) => SketchEntity[]][] = [
    [
      'a circle tangent to a line',
      (eps) => [...rect('l', 0, 0, 40, 30), circle('c1', [20, 10 - eps], 10)],
    ],
    [
      'two half arcs tangent to a line',
      (eps) => [
        ...rect('l', 0, 0, 40, 30),
        arc('c1', [20, 10 - eps], [10, 10 - eps], [30, 10 - eps]),
        arc('c2', [20, 10 - eps], [30, 10 - eps], [10, 10 - eps]),
      ],
    ],
    [
      'internally tangent circles',
      (eps) => [circle('c1', [0, 0], 10), circle('c2', [5 + eps, 0], 5)],
    ],
    [
      'externally tangent circles',
      (eps) => [circle('c1', [0, 0], 4), circle('c2', [7 - eps, 0], 3)],
    ],
    [
      'internally tangent arcs',
      (eps) => [
        circle('c1', [0, 0], 10),
        arc('c2', [5 + eps, 0], [5 + eps, -5], [5 + eps, 5]),
        arc('c3', [5 + eps, 0], [5 + eps, 5], [5 + eps, -5]),
      ],
    ],
  ];

  describe.each(cases)('%s', (_, sketch) => {
    const exact = detect(sketch(0));
    const tol = exact.tolerance;

    it('is a tangency when exact', () => {
      expect(codes(exact)).not.toContain('crossing');
      expect(codes(exact)).not.toContain('overlap');
      expect(exact.regions.length).toBeGreaterThan(0);
    });

    it.each([
      ['overlapping by 1e-10', () => 1e-10],
      ['overlapping by half the tolerance', () => 0.5 * tol],
      ['separated by 1e-10', () => -1e-10],
      ['separated by half the tolerance', () => -0.5 * tol],
    ])('gives the same regions %s', (_, eps) => {
      expect(signature(detect(sketch(eps())))).toEqual(signature(exact));
    });
  });

  it('keeps the curvature order at a tangent point, so the hole touches its region', () => {
    const r = detect([...rect('l', 0, 0, 40, 30), circle('c1', [20, 10 - 1e-10], 10)]);
    expect(r.regions.map((x) => [x.id, x.holes.length])).toEqual([
      ['c1/L', 0],
      ['l1/L+l2/L+l3/L+l4/L', 1],
    ]);
    expect(r.diagnostics).toMatchObject([
      { code: 'touching', entityIds: ['c1', 'l1', 'l2', 'l3', 'l4'] },
    ]);
    const [p] = r.diagnostics[0]!.points!;
    expect(p![0]).toBeCloseTo(20, 9);
    expect(p![1]).toBeCloseTo(0, 9);
  });

  it('still splits a line that dips more than the tolerance into a circle', () => {
    const r = detect([...rect('l', 0, 0, 40, 30), circle('c1', [20, 10 - 1e-3], 10)]);
    expect(codes(r)).toContain('crossing');
  });
});

describe('detectRegions: curve ends at a tangent contact', () => {
  // A curve that ends within the tolerance of a tangent contact is welded to
  // it, so its leaving direction must be the one at the contact: the end
  // itself may sit on the wrong side of it, turned by about sqrt(2 dip / r).

  /**
   * Box 0..40 split by `d` at x = 20 + R; the arc `a` rises from the bottom
   * line tangentially at x = 20 to the divider, leaving a cusp pocket. The
   * centre sits `dip` too low and the arc starts where its circle meets the
   * line: before the contact (the overshoot side) or after it.
   */
  const cuspPocket = (R: number, dip: number, side: -1 | 1 = -1): SketchEntity[] => {
    const c: Vec2 = [20, R - dip];
    const half = Math.sqrt(dip * (2 * R - dip));
    return [
      line('b', [0, 0], [40, 0]),
      line('r', [40, 0], [40, 40]),
      line('t', [40, 40], [0, 40]),
      line('w', [0, 40], [0, 0]),
      line('d', [20 + R, 0], [20 + R, 40]),
      arc('a', c, [20 + side * half, 0], [20 + R, R - dip]),
    ];
  };

  describe.each([10, 1, 0.1])('a cusp pocket of radius %s', (R) => {
    const exact = detect(cuspPocket(R, 0));

    it('is three regions when exact', () => {
      expect(exact.regions.map((x) => x.id)).toEqual([
        'a/L+b/L+d/L+t/L+w/L',
        'a/R+b/L+d/L',
        'b/L+d/R+r/L+t/L',
      ]);
      expect(codes(exact, 'warning')).toEqual([]);
    });

    it.each([1e-14, 1e-12, 1e-10])(
      'keeps them when the arc dips %s and starts on either side of the contact',
      (dip) => {
        expect(signature(detect(cuspPocket(R, dip, -1)))).toEqual(signature(exact));
        expect(signature(detect(cuspPocket(R, dip, 1)))).toEqual(signature(exact));
      },
    );
  });

  /**
   * A circle of radius R inside a unit square, tangent to its bottom at
   * (0.5, 0) and drawn as two half arcs that meet there; the second one runs
   * `over` millimetres past the contact.
   */
  const overshoot = (R: number, over: number): SketchEntity[] => {
    const c: Vec2 = [0.5, R];
    const at = (a: number): Vec2 => [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
    return [
      ...rect('l', 0, 0, 1, 1),
      arc('c1', c, at(-Math.PI / 2), at(Math.PI / 2)),
      arc('c2', c, at(Math.PI / 2), at(-Math.PI / 2 + over / R)),
    ];
  };

  describe('an arc overshooting a tangent point inside a rectangle', () => {
    const exact = detect(overshoot(0.1, 0));

    it('is a disc touching its hole when exact', () => {
      expect(exact.regions.map((x) => [x.id, x.holes.length])).toEqual([
        ['c1/L+c2/L', 0],
        ['l1/L+l2/L+l3/L+l4/L', 1],
      ]);
      expect(codes(exact, 'warning')).toEqual(['touching']);
    });

    it.each([1e-9, 1e-8, 1e-7])('gives the same regions overshooting by %s', (over) => {
      expect(signature(detect(overshoot(0.1, over)))).toEqual(signature(exact));
    });
  });

  /**
   * Circle `c1` (radius 0.2) with a smaller circle inside it, internally
   * tangent at (0.2, 0) and drawn as two arcs that end at the contact; each
   * runs `over` millimetres past it.
   */
  const internal = (over: number): SketchEntity[] => {
    const c: Vec2 = [0.1, 0];
    const r = 0.1;
    const at = (a: number): Vec2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
    return [
      circle('c1', [0, 0], 0.2),
      arc('c2', c, at(-over / r), at(Math.PI)),
      arc('c3', c, at(Math.PI), at(over / r)),
    ];
  };

  describe('an internally tangent arc ending at its contact point', () => {
    const exact = detect(internal(0));

    it('is a crescent whose hole touches it, and the inner disc', () => {
      expect(exact.regions.map((x) => [x.id, x.holes.length])).toEqual([
        ['c1/L', 1],
        ['c2/L+c3/L', 0],
      ]);
      expect(codes(exact, 'warning')).toEqual(['touching']);
    });

    it.each([1e-9, 1e-8, 1e-7])('gives the same regions overshooting by %s', (over) => {
      expect(signature(detect(internal(over)))).toEqual(signature(exact));
    });
  });
});

describe('detectRegions: overlaps', () => {
  it('give the shared stretch to the smaller entity id, whatever the order', () => {
    const a = rect('a', 0, 0, 10, 10);
    const b = rect('b', 10, 2, 20, 8);
    const run = (entities: SketchEntity[]) => {
      const r = detect(entities);
      return {
        ids: r.regions.map((x) => [x.id, edgeIds(x).sort()]),
        overlaps: r.diagnostics.filter((d) => d.code === 'overlap'),
      };
    };
    const forward = run([...a, ...b]);
    expect(run([...b, ...a])).toEqual(forward);
    expect(run([...a, ...b].reverse())).toEqual(forward);
    expect(forward.overlaps).toMatchObject([
      { message: "'a2' and 'b4' lie on top of each other; the shared stretch belongs to 'a2'" },
    ]);
  });

  it('give an exact duplicate to the smaller id, whatever the order', () => {
    const square = rect('l', 0, 0, 4, 4);
    const dup = line('k', [4, 0], [4, 4]);
    for (const entities of [
      [...square, dup],
      [dup, ...square],
    ]) {
      const r = detect(entities);
      expect(r.regions.map((x) => x.id)).toEqual(['k/L+l1/L+l3/L+l4/L']);
      expect(r.diagnostics).toMatchObject([
        { code: 'overlap', message: expect.stringContaining("belongs to 'k'") },
      ]);
    }
  });
});

describe('detectRegions: stable ids', () => {
  const ids = (entities: SketchEntity[]) => detect(entities).regions.map((x) => x.id);

  it('survive resizing and moving', () => {
    expect(ids(SKETCHES.rectWithHole(80, 20, 3))).toEqual(ids(SKETCHES.rectWithHole()));
    expect(ids(SKETCHES.overlappingRects(3.7))).toEqual(ids(SKETCHES.overlappingRects()));
    expect(ids(slot(-50, 5, 12, 1))).toEqual(ids(SKETCHES.slot()));
  });

  it('survive adding and removing a hole', () => {
    const plain = ids(rect('l', 0, 0, 40, 30));
    expect(ids(SKETCHES.rectWithHole())).toEqual(plain);
  });

  it('survive another line splitting a neighbouring region', () => {
    const before = detect(SKETCHES.circleAndLine()).regions.map((x) => x.id);
    expect(before).toEqual(['c1/L+l1/L', 'c1/L+l1/R']);
    const after = detect([...SKETCHES.circleAndLine(), line('l2', [-15, -6], [15, -6])]);
    // The part above l1 is untouched; the part below is now two regions.
    expect(after.regions.map((x) => x.id)).toEqual(['c1/L+l1/L', 'c1/L+l1/R+l2/L', 'c1/L+l2/R']);
  });

  it('do not depend on entity order', () => {
    const entities = SKETCHES.overlappingRects();
    const shuffled = [...entities].reverse();
    expect(ids(shuffled)).toEqual(ids(entities));
  });

  it('are deterministic', () => {
    expect(JSON.stringify(detect(SKETCHES.island()))).toBe(
      JSON.stringify(detect(SKETCHES.island())),
    );
  });
});
