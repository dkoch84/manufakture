import { describe, expect, it } from 'vitest';
import type { Vec2 } from './model';
import {
  MAX_OUTLINE_COMMANDS,
  MAX_OUTLINE_POINTS,
  MAX_OUTLINE_WORK,
  bezierPoint,
  flattenSegment,
  loopArea,
  outlineRegionArea,
  outlineRegions,
  type OutlineLoop,
  type OutlineRegion,
  type OutlineSegment,
  type PathCommand,
} from './outline';

const M = (x: number, y: number): PathCommand => ({ kind: 'moveTo', to: [x, y] });
const L = (x: number, y: number): PathCommand => ({ kind: 'lineTo', to: [x, y] });
const Q = (cx: number, cy: number, x: number, y: number): PathCommand => ({
  kind: 'quadTo',
  control: [cx, cy],
  to: [x, y],
});
const C = (ax: number, ay: number, bx: number, by: number, x: number, y: number): PathCommand => ({
  kind: 'cubicTo',
  control1: [ax, ay],
  control2: [bx, by],
  to: [x, y],
});
const Z: PathCommand = { kind: 'close' };
const SOURCE = { contour: 0, index: 0, split: 0, piece: 0, reversed: false };

/** An axis-aligned rectangle, counter-clockwise unless `cw`. */
function rect(x0: number, y0: number, x1: number, y1: number, cw = false): PathCommand[] {
  return cw
    ? [M(x0, y0), L(x0, y1), L(x1, y1), L(x1, y0), Z]
    : [M(x0, y0), L(x1, y0), L(x1, y1), L(x0, y1), Z];
}

/** A circle of four cubic quarter arcs (the usual 0.5523 handle), counter-clockwise unless `cw`. */
function circle(cx: number, cy: number, r: number, cw = false): PathCommand[] {
  const k = 0.5522847498 * r;
  const ccw = [
    M(cx + r, cy),
    C(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
    C(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
    C(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
    C(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    Z,
  ];
  if (!cw) return ccw;
  return [
    M(cx + r, cy),
    C(cx + r, cy - k, cx + k, cy - r, cx, cy - r),
    C(cx - k, cy - r, cx - r, cy - k, cx - r, cy),
    C(cx - r, cy + k, cx - k, cy + r, cx, cy + r),
    C(cx + k, cy + r, cx + r, cy + k, cx + r, cy),
    Z,
  ];
}

const start = (s: OutlineSegment): Vec2 => (s.kind === 'bezier' ? s.points[0]! : s.start);
const end = (s: OutlineSegment): Vec2 => (s.kind === 'bezier' ? s.points.at(-1)! : s.end);

/** Every segment starts exactly where the previous one ends, the last ending at the first. */
function expectClosed(loop: OutlineLoop): void {
  loop.segments.forEach((s, i) => {
    const previous = loop.segments.at(i - 1)!;
    expect(start(s)).toEqual(end(previous));
  });
}

function loops(region: OutlineRegion): OutlineLoop[] {
  return [region.outer, ...region.holes];
}

/** Distance from a point to a line or arc segment. */
function distanceTo(p: Vec2, s: OutlineSegment): number {
  if (s.kind === 'line') {
    const [ax, ay] = s.start;
    const dx = s.end[0] - ax;
    const dy = s.end[1] - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
  }
  if (s.kind === 'arc') {
    // Within the arc's sweep: the radial distance; else the nearer end.
    const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
    const angle = (q: Vec2) => Math.atan2(q[1] - s.center[1], q[0] - s.center[0]);
    const turn = (from: number, to: number) => {
      let d = s.clockwise ? from - to : to - from;
      while (d < 0) d += 2 * Math.PI;
      return d;
    };
    const sweep = turn(angle(s.start), angle(s.end));
    if (turn(angle(s.start), angle(p)) <= sweep) {
      return Math.abs(Math.hypot(p[0] - s.center[0], p[1] - s.center[1]) - r);
    }
    return Math.min(
      Math.hypot(p[0] - s.start[0], p[1] - s.start[1]),
      Math.hypot(p[0] - s.end[0], p[1] - s.end[1]),
    );
  }
  throw new Error('not a line or arc');
}

describe('outlineRegions: loops and nesting', () => {
  it('turns one closed contour into one counter-clockwise region', () => {
    const { regions, issues } = outlineRegions(rect(0, 0, 10, 5, true));
    expect(issues).toEqual([]);
    expect(regions).toHaveLength(1);
    const outer = regions[0]!.outer;
    expect(outer.contour).toBe(0);
    expect(outer.segments.every((s) => s.reversed && s.contour === 0)).toBe(true);
    expect(outer.area).toBeCloseTo(50, 12);
    expect(outer.segments.map((s) => s.kind)).toEqual(['line', 'line', 'line', 'line']);
    // Reversed, the segments keep the index of the command they came from.
    expect(outer.segments.map((s) => s.index)).toEqual([3, 2, 1, 0]);
    expectClosed(outer);
  });

  it('makes an opposite-winding inner contour a hole (nonzero), an "O"', () => {
    const { regions, issues } = outlineRegions([...circle(0, 0, 10), ...circle(0, 0, 6, true)]);
    expect(issues).toEqual([]);
    expect(regions).toHaveLength(1);
    const [region] = regions;
    expect(region!.holes).toHaveLength(1);
    expect(region!.outer.area).toBeGreaterThan(0);
    expect(region!.holes[0]!.area).toBeLessThan(0);
    expect(region!.holes[0]!.contour).toBe(1);
    expect(outlineRegionArea(region!)).toBe(region!.outer.area + region!.holes[0]!.area);
    // The four-cubic circle encloses about 0.03 % more than the true circle.
    expect(outlineRegionArea(region!) / (Math.PI * (100 - 36)) - 1).toBeLessThan(5e-4);
    loops(region!).forEach(expectClosed);
  });

  it('orients holes clockwise whatever the input direction, under even-odd', () => {
    const path = [...rect(0, 0, 10, 10), ...rect(2, 2, 8, 8)];
    // Nonzero: the same-direction inner square has fill on both sides, so it bounds nothing.
    const nonzero = outlineRegions(path);
    expect(nonzero.regions).toHaveLength(1);
    expect(nonzero.regions[0]!.holes).toEqual([]);
    // Even-odd: it is a hole, turned clockwise.
    const evenodd = outlineRegions(path, { fillRule: 'evenodd' });
    expect(evenodd.regions[0]!.holes).toHaveLength(1);
    const hole = evenodd.regions[0]!.holes[0]!;
    expect(hole.segments.every((s) => s.reversed)).toBe(true);
    expect(hole.area).toBeCloseTo(-36, 12);
  });

  it('gives separate contours separate regions, ordered by contour ("i")', () => {
    const { regions } = outlineRegions([...rect(0, 8, 2, 10), ...rect(0, 0, 2, 6)]);
    expect(regions.map((r) => r.outer.contour)).toEqual([0, 1]);
    expect(regions.map((r) => r.holes.length)).toEqual([0, 0]);
  });

  it('puts an island inside a hole as a region of its own, holes under the smallest outer loop', () => {
    const path = [
      ...rect(0, 0, 30, 30),
      ...rect(5, 5, 25, 25, true),
      ...rect(10, 10, 20, 20),
      ...rect(12, 12, 18, 18, true),
    ];
    const { regions, issues } = outlineRegions(path);
    expect(issues).toEqual([]);
    expect(regions.map((r) => [r.outer.contour, r.holes.map((h) => h.contour)])).toEqual([
      [0, [1]],
      [2, [3]],
    ]);
    expect(regions.map(outlineRegionArea)).toEqual([900 - 400, 100 - 36]);
  });

  it('nests independently of contour order', () => {
    const path = [...rect(2, 2, 8, 8, true), ...rect(40, 0, 50, 10), ...rect(0, 0, 10, 10)];
    const { regions } = outlineRegions(path);
    expect(regions.map((r) => [r.outer.contour, r.holes.map((h) => h.contour)])).toEqual([
      [1, []],
      [2, [0]],
    ]);
  });
});

describe('outlineRegions: cleaning up', () => {
  it('drops zero-length segments (a glyph moveTo followed by a lineTo to the same point)', () => {
    const { regions, issues } = outlineRegions([
      M(0, 0),
      L(0, 0),
      L(10, 0),
      L(10, 10),
      L(10, 10),
      L(0, 10),
      Z,
    ]);
    expect(issues).toEqual([]);
    const outer = regions[0]!.outer;
    expect(outer.segments.map((s) => s.index)).toEqual([1, 2, 4, 5]);
    expectClosed(outer);
  });

  it('snaps ends that agree within the tolerance', () => {
    const { regions } = outlineRegions([
      M(0, 0),
      L(10, 1e-9),
      L(10, 10),
      L(1e-9, 10),
      L(0, 1e-9),
      Z,
    ]);
    const outer = regions[0]!.outer;
    expect(outer.segments).toHaveLength(4);
    expectClosed(outer);
  });

  it('makes a Bezier with its control points on its chord a line', () => {
    const { regions } = outlineRegions([
      M(0, 0),
      Q(5, 0, 10, 0),
      C(10, 2, 10, 8, 10, 10),
      L(0, 10),
      Z,
    ]);
    expect(regions[0]!.outer.segments.map((s) => s.kind)).toEqual(['line', 'line', 'line', 'line']);
  });

  it('closes an open contour with a line and warns; an explicit close does not warn', () => {
    const open = outlineRegions([M(0, 0), L(10, 0), L(10, 10)]);
    expect(open.issues.map((i) => [i.code, i.severity, i.contours])).toEqual([
      ['open-contour', 'warning', [0]],
    ]);
    expect(open.regions[0]!.outer.segments.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(open.regions[0]!.outer.area).toBeCloseTo(50, 12);

    const closed = outlineRegions([M(0, 0), L(10, 0), L(10, 10), Z]);
    expect(closed.issues).toEqual([]);
    expect(closed.regions[0]!.outer.segments).toHaveLength(3);
  });

  it('starts a new contour at the start point when drawing continues after close', () => {
    const { regions, issues } = outlineRegions([
      M(0, 0),
      L(10, 0),
      L(10, 10),
      Z,
      L(-10, 0),
      L(-10, -10),
      Z,
    ]);
    // Two triangles meeting at (0, 0): touching contours, merged into two loops.
    expect(issues.map((i) => i.code)).toEqual(['merged']);
    expect(regions.map((r) => [r.outer.contour, r.outer.area])).toEqual([
      [0, 50],
      [1, 50],
    ]);
  });

  it('ignores contours that enclose nothing', () => {
    const { regions, issues } = outlineRegions([
      M(0, 0),
      L(10, 0),
      Z,
      ...rect(0, 2, 5, 5),
      M(3, 3),
    ]);
    expect(regions.map((r) => r.outer.contour)).toEqual([1]);
    // The bare moveTo (contour 2) draws nothing and is skipped without a warning.
    expect(issues.map((i) => [i.code, i.contours])).toEqual([['empty-contour', [0]]]);
  });

  it('accepts an empty path', () => {
    expect(outlineRegions([])).toEqual({ regions: [], issues: [] });
  });
});

describe('outlineRegions: merging overlaps', () => {
  it('merges contours that cross into one outline, and says so', () => {
    const { regions, issues } = outlineRegions([...rect(0, 0, 10, 10), ...rect(5, 5, 15, 15)]);
    expect(issues).toEqual([
      {
        code: 'merged',
        severity: 'info',
        message: 'Contours that cross or touch were merged into one outline.',
        contours: [0, 1],
      },
    ]);
    expect(regions).toHaveLength(1);
    const outer = regions[0]!.outer;
    expect(outer.area).toBeCloseTo(175, 9);
    expectClosed(outer);
    // Cut edges are numbered along their command; the corners inside the other square are gone.
    const names = outer.segments.map((s) => `${s.contour}.${s.index}.${s.split}`).sort();
    expect(names).toEqual(['0.0.0', '0.1.0', '0.2.1', '0.3.0', '1.0.1', '1.1.0', '1.2.0', '1.3.0']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('cuts a hole in two where a bar crosses a ring ("Ø")', () => {
    const path = [...rect(0, 0, 30, 30), ...rect(10, 10, 20, 20, true), ...rect(-5, 13, 35, 17)];
    const { regions, issues } = outlineRegions(path);
    expect(issues.map((i) => [i.code, i.contours])).toEqual([['merged', [0, 1, 2]]]);
    expect(regions).toHaveLength(1);
    const [region] = regions;
    expect(region!.outer.area).toBeCloseTo(940, 9);
    expect(region!.holes.map((h) => h.area)).toEqual([
      expect.closeTo(-30, 9),
      expect.closeTo(-30, 9),
    ]);
    expect(outlineRegionArea(region!)).toBeCloseTo(880, 9);
    loops(region!).forEach(expectClosed);
  });

  it('keeps contours that touch at a point as two loops, and drops a shared edge', () => {
    const corner = outlineRegions([...rect(0, 0, 10, 10), ...rect(10, 10, 20, 20)]);
    expect(corner.issues.map((i) => i.code)).toEqual(['merged']);
    expect(corner.regions.map((r) => r.outer.area)).toEqual([100, 100]);
    corner.regions.forEach((r) => expectClosed(r.outer));

    const edge = outlineRegions([...rect(0, 0, 10, 10), ...rect(10, 0, 20, 10)]);
    expect(edge.regions).toHaveLength(1);
    expect(edge.regions[0]!.outer.area).toBeCloseTo(200, 9);
    expect(
      edge.regions[0]!.outer.segments.every(
        (s) => s.kind === 'line' && !(s.start[0] === 10 && s.end[0] === 10),
      ),
    ).toBe(true);
  });

  it('fills both lobes of a figure eight under nonzero', () => {
    const { regions, issues } = outlineRegions([M(0, 0), L(10, 10), L(10, 0), L(0, 20), Z]);
    expect(issues.map((i) => [i.code, i.contours])).toEqual([['merged', [0]]]);
    expect(regions).toHaveLength(2);
    expect(
      regions.every((r) => r.outer.area > 0 && r.outer.segments.every((s) => s.contour === 0)),
    ).toBe(true);
    // The lobes meet where (0, 0)-(10, 10) crosses (10, 0)-(0, 20), at (20/3, 20/3): one lobe
    // is the triangle with (10, 10) and (10, 0), the other the one with (0, 20) and (0, 0).
    const areas = regions.map((r) => r.outer.area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(0.5 * 10 * (10 - 20 / 3), 9);
    expect(areas[1]).toBeCloseTo(0.5 * 20 * (20 / 3), 9);
  });

  it('merges a curved contour crossing a straight one, keeping the curves exact', () => {
    const { regions, issues } = outlineRegions([...circle(0, 0, 10), ...rect(5, -1, 20, 1)]);
    expect(issues.map((i) => i.code)).toEqual(['merged']);
    expect(regions).toHaveLength(1);
    const outer = regions[0]!.outer;
    expectClosed(outer);
    expect(outer.segments.filter((s) => s.kind === 'bezier').length).toBeGreaterThanOrEqual(4);
    // The circle plus the part of the bar outside it, from the circle's own area.
    const circleArea = outlineRegions(circle(0, 0, 10)).regions[0]!.outer.area;
    const x = Math.sqrt(100 - 1); // where the bar's edges leave the (true) circle
    expect(outer.area).toBeGreaterThan(circleArea + 2 * (20 - 10));
    expect(outer.area).toBeLessThan(circleArea + 2 * (20 - x));
  });

  it('merges a contour drawn twice into one', () => {
    const same = outlineRegions([...circle(0, 0, 10), ...circle(0, 0, 10)]);
    expect(same.regions).toHaveLength(1);
    expect(same.regions[0]!.outer.segments).toHaveLength(4);
    const opposite = outlineRegions([...rect(0, 0, 10, 10), ...rect(0, 0, 10, 10, true)]);
    expect(opposite.regions).toEqual([]);
  });

  it('refuses curves that partly run on top of each other', () => {
    // A cubic, and its first half (split at t = 0.5) as part of another contour.
    const half = [
      [0, 0],
      [2.5, 5],
      [6.25, 7.5],
      [10, 7.5],
    ] as const;
    const { regions, issues } = outlineRegions([
      M(0, 0),
      C(5, 10, 15, 10, 20, 0),
      Z,
      M(0, 0),
      C(half[1][0], half[1][1], half[2][0], half[2][1], half[3][0], half[3][1]),
      L(10, 20),
      Z,
    ]);
    expect(regions).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'crossing', severity: 'error', contours: [0, 1] });
    expect(issues[0]!.message).toContain('could not be merged');
  });

  it('refuses non-finite coordinates', () => {
    const { regions, issues } = outlineRegions([M(0, 0), L(Number.NaN, 0), L(1, 1), Z]);
    expect(regions).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(['not-finite']);
  });
});

describe('outlineRegions: limits', () => {
  /** `n` 20 by 2 bars through one point at even angles: every bar crosses every other. */
  function star(n: number): PathCommand[] {
    const path: PathCommand[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const corners: Vec2[] = [
        [-10, -1],
        [10, -1],
        [10, 1],
        [-10, 1],
      ];
      const [first, ...rest] = corners.map(([x, y]) => [x * c - y * s, x * s + y * c] as Vec2);
      path.push(M(...first!), ...rest.map((p) => L(...p)), Z);
    }
    return path;
  }

  const timed = (fn: () => ReturnType<typeof outlineRegions>) => {
    const started = performance.now();
    const result = fn();
    return { ...result, ms: performance.now() - started };
  };

  it('merges a few dozen overlapping contours', () => {
    const { regions, issues } = outlineRegions(star(40));
    expect(regions).toHaveLength(1);
    expect(issues.map((i) => i.code)).toEqual(['merged']);
  });

  it('refuses hundreds of contours all crossing each other with too-complex, in bounded time', () => {
    // 640 bars took 26 s to merge before the work budget; 320 took 4 s.
    expect(MAX_OUTLINE_WORK).toBe(250_000_000);
    for (const n of [320, 640]) {
      const { regions, issues, ms } = timed(() => outlineRegions(star(n)));
      expect(regions).toEqual([]);
      expect(issues).toEqual([
        {
          code: 'too-complex',
          severity: 'error',
          message: 'The outline has too many segments or overlaps to be converted.',
          contours: [],
        },
      ]);
      expect(ms).toBeLessThan(5000);
    }
  });

  it('refuses a path of more than MAX_OUTLINE_COMMANDS commands up front', () => {
    expect(MAX_OUTLINE_COMMANDS).toBe(100_000);
    const path: PathCommand[] = [];
    for (let i = 0; path.length <= MAX_OUTLINE_COMMANDS; i++) {
      const [x, y] = [(i % 200) * 3, Math.floor(i / 200) * 3];
      path.push(M(x, y), L(x + 1, y), L(x + 1, y + 1), Z);
    }
    const { regions, issues, ms } = timed(() => outlineRegions(path));
    expect(regions).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(['too-complex']);
    expect(ms).toBeLessThan(100);
    // A thousand separate triangles are fine.
    expect(outlineRegions(path.slice(0, 4000)).regions).toHaveLength(1000);
  });

  it('caps the vertices flattening makes at MAX_OUTLINE_POINTS', () => {
    expect(MAX_OUTLINE_POINTS).toBe(1_000_000);
    // 5,000 S-curves far taller than wide: 256 chords each, 1.28 million vertices.
    const path: PathCommand[] = [M(0, 0)];
    for (let i = 0; i < 5000; i++) path.push(C(i + 0.3, 10000, i + 0.6, -10000, i + 1, 0));
    path.push(L(5000, -20000), L(0, -20000), Z);
    const { regions, issues, ms } = timed(() => outlineRegions(path));
    expect(regions).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(['too-complex']);
    expect(ms).toBeLessThan(5000);
  });

  it('refuses arcs at a tolerance so fine the fitting would not end', () => {
    const path: PathCommand[] = [M(0, 0)];
    for (let i = 0; i < 2000; i++) path.push(C(i, 50, i + 0.5, -50, i + 1, 0));
    path.push(L(0, -100), Z);
    const { regions, issues, ms } = timed(() =>
      outlineRegions(path, { arcs: { tolerance: 1e-12 } }),
    );
    expect(regions).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(['too-complex']);
    expect(ms).toBeLessThan(5000);
  });

  it('rejects a tolerance or arc tolerance that is not finite and above 0', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => outlineRegions(rect(0, 0, 1, 1), { arcs: { tolerance: bad } })).toThrow(
        RangeError,
      );
      expect(() => outlineRegions(rect(0, 0, 1, 1), { tolerance: bad })).toThrow(RangeError);
    }
    expect(outlineRegions(rect(0, 0, 1, 1), { tolerance: 1e-3 }).regions).toHaveLength(1);
  });

  it('rejects a flattening tolerance that is not finite and above 0', () => {
    const { regions } = outlineRegions([M(0, 0), Q(1, 2, 2, 0), Z]);
    const curve = regions[0]!.outer.segments.find((s) => s.kind === 'bezier')!;
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => flattenSegment(curve, bad)).toThrow(RangeError);
    }
    expect(flattenSegment(curve, 1e-3).length).toBeGreaterThan(2);
  });
});

describe('outline areas', () => {
  it('integrates a quadratic Bezier exactly (a parabolic segment is 2/3 of its triangle)', () => {
    const { regions } = outlineRegions([M(0, 0), Q(1, 2, 2, 0), Z]);
    // Clockwise as drawn (over the top, back along the base): reversed to counter-clockwise.
    expect(regions[0]!.outer.area).toBeCloseTo(4 / 3, 14);
  });

  it('integrates a cubic Bezier exactly', () => {
    // x = 4t and y = 9t(1 - t): the area under it is 36 / 6 = 6.
    const { regions } = outlineRegions([M(0, 0), C(4 / 3, 3, 8 / 3, 3, 4, 0), Z]);
    expect(regions[0]!.outer.area).toBeCloseTo(6, 14);
  });

  it('matches a fine polygon on an asymmetric cubic', () => {
    const points: Vec2[] = [
      [0, 0],
      [3, 7],
      [9, -4],
      [12, 2],
    ];
    const segments: OutlineSegment[] = [
      { kind: 'bezier', ...SOURCE, points },
      { kind: 'line', ...SOURCE, index: 1, start: [12, 2], end: [0, 0] },
    ];
    let shoelace = 0;
    const n = 20000;
    let prev = bezierPoint(points, 0);
    for (let i = 1; i <= n; i++) {
      const p = bezierPoint(points, i / n);
      shoelace += prev[0] * p[1] - p[0] * prev[1];
      prev = p;
    }
    shoelace += prev[0] * 0 - 0 * prev[1];
    expect(loopArea(segments)).toBeCloseTo(shoelace / 2, 5);
  });
});

describe('outlineRegions: arcs', () => {
  /** Samples of the original Beziers, and the arcs and lines that replaced them. */
  function expectWithin(path: PathCommand[], tolerance: number): void {
    const bezier = outlineRegions(path);
    const arcs = outlineRegions(path, { arcs: { tolerance } });
    expect(arcs.issues).toEqual(bezier.issues);
    expect(arcs.regions).toHaveLength(bezier.regions.length);
    bezier.regions.forEach((region, r) => {
      loops(region).forEach((loop, l) => {
        const replaced = loops(arcs.regions[r]!)[l]!;
        expect(replaced.segments.every((s) => s.kind !== 'bezier')).toBe(true);
        expectClosed(replaced);
        for (const segment of loop.segments) {
          const pieces = replaced.segments.filter((s) => s.index === segment.index);
          // Numbered along the source command: pieces 0..n-1.
          expect(pieces.map((p) => p.piece).sort((a, b) => a - b)).toEqual(pieces.map((_, i) => i));
          // Bezier to pieces: every sample of the curve is near a piece.
          if (segment.kind !== 'bezier') continue;
          const samples = Array.from({ length: 2001 }, (_, i) =>
            bezierPoint(segment.points, i / 2000),
          );
          for (const p of samples) {
            expect(Math.min(...pieces.map((s) => distanceTo(p, s)))).toBeLessThanOrEqual(
              tolerance * 1.001,
            );
          }
          // Pieces to Bezier: every point on the pieces is near the curve.
          for (const piece of pieces) {
            for (const p of flattenSegment(piece, tolerance / 20)) {
              const nearest = Math.min(
                ...samples
                  .slice(0, -1)
                  .map((a, i) =>
                    distanceTo(p, { kind: 'line', ...SOURCE, start: a, end: samples[i + 1]! }),
                  ),
              );
              expect(nearest).toBeLessThanOrEqual(tolerance * 1.001);
            }
          }
        }
      });
    });
  }

  it('replaces a circle of cubics by a few arcs within the tolerance', () => {
    const tolerance = 0.001;
    expectWithin(circle(0, 0, 10), tolerance);
    const { regions } = outlineRegions(circle(0, 0, 10), { arcs: { tolerance } });
    const segments = regions[0]!.outer.segments;
    expect(segments.every((s) => s.kind === 'arc' && !s.clockwise)).toBe(true);
    expect(segments.length).toBeLessThanOrEqual(8);
  });

  it('follows S-curves and holes, keeping each piece on the right side', () => {
    const path = [
      M(0, 0),
      C(10, 15, 20, -15, 30, 0),
      Q(35, 10, 30, 20),
      C(20, 35, 10, 5, 0, 20),
      Z,
      ...circle(15, 10, 3, true),
    ];
    expectWithin(path, 0.01);
    expectWithin(path, 0.0001);
    const { regions } = outlineRegions(path, { arcs: { tolerance: 0.01 } });
    expect(regions[0]!.holes[0]!.segments.every((s) => s.kind === 'arc' && s.clockwise)).toBe(true);
  });

  it('keeps lines as they are', () => {
    const { regions } = outlineRegions(rect(0, 0, 3, 4), { arcs: { tolerance: 0.01 } });
    expect(regions[0]!.outer.segments.every((s) => s.kind === 'line' && s.piece === 0)).toBe(true);
  });
});
