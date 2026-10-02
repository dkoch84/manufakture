import { describe, expect, it } from 'vitest';
import type { SketchEntity, Vec3 } from './model';
import { XY_PLANE, cross3, distanceFromPlane, dot3, placementFromNormal } from './placement';
import {
  MAX_FLATTEN_POINTS,
  MAX_REFINE_WORK,
  flattenRegion,
  regionFill,
  regionFills,
  triangulateRegion2D,
} from './region-mesh';
import { SKETCHES, circle, line, rect } from './region-sketches';
import { detectRegions, type Region, type RegionCurve } from './regions';

function polygonArea(region: Region, deflection = { linear: 0.05, angular: 0.25 }): number {
  const area = (pts: readonly (readonly [number, number])[]) =>
    Math.abs(
      pts.reduce((a, p, i) => {
        const q = pts[(i + 1) % pts.length]!;
        return a + (p[0] * q[1] - q[0] * p[1]) / 2;
      }, 0),
    );
  const [outer, ...holes] = flattenRegion(region, deflection);
  return area(outer!) - holes.reduce((a, h) => a + area(h), 0);
}

function expectTriangulated(region: Region): void {
  const { points, triangles } = triangulateRegion2D(region);
  expect(triangles.length % 3).toBe(0);
  let sum = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [
      points[triangles[t]!]!,
      points[triangles[t + 1]!]!,
      points[triangles[t + 2]!]!,
    ];
    const doubled = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    expect(doubled).toBeGreaterThan(0);
    sum += doubled / 2;
  }
  // The triangles cover the flattened region exactly...
  expect(sum).toBeCloseTo(polygonArea(region), 6);
  // ...which is the region less the chord error.
  expect(Math.abs(sum - region.area) / region.area).toBeLessThan(0.01);
}

const all = (entities: SketchEntity[]) => {
  const r = detectRegions(entities);
  return [...r.regions, ...r.voids];
};

describe('region fills', () => {
  it.each(Object.entries(SKETCHES))('triangulate every face of %s', (_, make) => {
    for (const region of all(make())) expectTriangulated(region);
  });

  it('triangulate a crescent whose hole touches the outline', () => {
    for (const region of all([circle('c1', [0, 0], 10), circle('c2', [5, 0], 5)])) {
      expectTriangulated(region);
    }
  });

  it('triangulate several holes and a non-convex outline', () => {
    const entities: SketchEntity[] = [
      line('e1', [0, 0], [40, 0]),
      line('e2', [40, 0], [40, 30]),
      line('e3', [40, 30], [20, 10]),
      line('e4', [20, 10], [0, 30]),
      line('e5', [0, 30], [0, 0]),
      circle('h1', [8, 8], 3),
      circle('h2', [32, 8], 3),
      ...rect('r', 16, 2, 24, 6),
    ];
    const regions = detectRegions(entities).regions;
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(3);
    expectTriangulated(regions[0]!);
  });

  it('are exact for straight-edged regions', () => {
    const r = detectRegions(SKETCHES.overlappingRects()).regions;
    for (const region of r) {
      expect(regionFill(region, XY_PLANE).area).toBeCloseTo(region.area, 9);
    }
  });

  it('map to 3D through the placement and face along its normal', () => {
    const placement = placementFromNormal([5, -3, 2], [1, 1, 1], [1, -1, 0]);
    const regions = detectRegions(SKETCHES.rectWithHole()).regions;
    const [fill] = regionFills(regions, placement);
    expect(fill!.regionId).toBe(regions[0]!.id);
    expect(fill!.normal).toEqual(placement.normal);
    const p = fill!.positions;
    const at = (i: number): Vec3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
    for (let i = 0; i < p.length / 3; i++) {
      expect(Math.abs(distanceFromPlane(placement, at(i)))).toBeLessThan(1e-4);
    }
    const idx = fill!.indices;
    let area3 = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [at(idx[t]!), at(idx[t + 1]!), at(idx[t + 2]!)];
      const n = cross3(
        [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
      );
      // Counter-clockwise about the placement normal.
      expect(dot3(n, placement.normal)).toBeGreaterThan(0);
      area3 += dot3(n, placement.normal) / 2;
    }
    expect(area3).toBeCloseTo(fill!.area, 2);
    expect(Math.abs(fill!.area - regions[0]!.area) / regions[0]!.area).toBeLessThan(0.01);
  });
});

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Exact area the rectangles' outlines enclose (their union plus any pocket
 * they close off), by coordinate compression and a flood fill from outside.
 */
function enclosedArea(rects: [number, number, number, number][]): number {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  // Cells -1..n; the ring of cells outside the grid is where the fill starts.
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const onVertical = (x: number, y0: number, y1: number) =>
    rects.some((r) => (r[0] === x || r[2] === x) && r[1] <= y0 && y1 <= r[3]);
  const onHorizontal = (y: number, x0: number, x1: number) =>
    rects.some((r) => (r[1] === y || r[3] === y) && r[0] <= x0 && x1 <= r[2]);
  const outside = new Set<string>();
  const stack: [number, number][] = [[-1, -1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    const key = `${i},${j}`;
    if (i < -1 || j < -1 || i > nx || j > ny || outside.has(key)) continue;
    outside.add(key);
    // Moving to (i + 1, j) crosses x = xs[i + 1] over row j: blocked only on an outline.
    const blockedX = (a: number) =>
      j >= 0 && j < ny && a >= 0 && a <= nx && onVertical(xs[a]!, ys[j]!, ys[j + 1]!);
    const blockedY = (b: number) =>
      i >= 0 && i < nx && b >= 0 && b <= ny && onHorizontal(ys[b]!, xs[i]!, xs[i + 1]!);
    if (!blockedX(i + 1)) stack.push([i + 1, j]);
    if (!blockedX(i)) stack.push([i - 1, j]);
    if (!blockedY(j + 1)) stack.push([i, j + 1]);
    if (!blockedY(j)) stack.push([i, j - 1]);
  }
  let area = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!outside.has(`${i},${j}`)) area += (xs[i + 1]! - xs[i]!) * (ys[j + 1]! - ys[j]!);
    }
  }
  return area;
}

describe('grid-snapped rectangles (shared corners, T-junctions, collinear overlaps)', () => {
  it('faces tile the enclosed area exactly, and every fill matches its region', () => {
    const next = random(930);
    for (let run = 0; run < 60; run++) {
      const rects: [number, number, number, number][] = [];
      const entities: SketchEntity[] = [];
      const count = 2 + Math.floor(next() * 5);
      for (let k = 0; k < count; k++) {
        const x0 = Math.floor(next() * 8);
        const y0 = Math.floor(next() * 8);
        const x1 = x0 + 1 + Math.floor(next() * 6);
        const y1 = y0 + 1 + Math.floor(next() * 6);
        rects.push([x0, y0, x1, y1]);
        entities.push(...rect(`r${k}_`, x0, y0, x1, y1));
      }
      const r = detectRegions(entities);
      const faces = [...r.regions, ...r.voids];
      const total = faces.reduce((a, f) => a + f.area, 0);
      expect(total, JSON.stringify(rects)).toBeCloseTo(enclosedArea(rects), 9);
      const ids = faces.map((f) => f.id);
      expect(new Set(ids).size, JSON.stringify(rects)).toBe(ids.length);
      for (const f of faces) {
        expect(regionFill(f, XY_PLANE).area, JSON.stringify(rects)).toBeCloseTo(f.area, 9);
      }
    }
  });
});

describe('the flattening cap', () => {
  /** A disk of radius `r` bounded by `n` cubic Beziers (a glyph-like loop). */
  function bezierDisk(n: number, r: number): Region {
    const k = (4 / 3) * Math.tan(Math.PI / (2 * n));
    const at = (a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
    const curves: RegionCurve[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = (2 * Math.PI * i) / n;
      const a1 = (2 * Math.PI * (i + 1)) / n;
      const p0 = at(a0);
      const p3 = at(a1);
      const p1: [number, number] = [p0[0] - k * p0[1], p0[1] + k * p0[0]];
      const p2: [number, number] = [p3[0] + k * p3[1], p3[1] - k * p3[0]];
      curves.push({
        kind: 'bezier',
        points: [p0, p1, p2, p3],
        start: p0,
        end: p3,
        edgeId: `e1.g0.c0.s${i}#1`,
        entityId: 'e1',
        fragile: true,
        reversed: false,
      } as RegionCurve);
    }
    return {
      id: 'r',
      fragile: true,
      outer: { curves, area: Math.PI * r * r },
      holes: [],
      area: Math.PI * r * r,
    } as unknown as Region;
  }

  it('flattens a glyph-like region of Beziers within the cap', () => {
    const [outer] = flattenRegion(bezierDisk(8, 5), { linear: 0.05, angular: 0.25 });
    expect(outer!.length).toBeGreaterThan(8);
    expect(outer!.length).toBeLessThan(MAX_FLATTEN_POINTS);
  });

  it('refuses a region whose Beziers would flatten past the cap, before making the points', () => {
    // 2000 Beziers of a 10 m disk at 1 micron: tens of thousands of points if not stopped.
    const huge = bezierDisk(2000, 10_000);
    const deflection = { linear: 0.001, angular: 0.25 };
    expect(() => flattenRegion(huge, deflection, { maxPoints: 5000 })).toThrow(RangeError);
    const started = performance.now();
    expect(() => flattenRegion(bezierDisk(400_000, 10_000), deflection)).toThrow(
      /more than 100000 points/,
    );
    expect(performance.now() - started).toBeLessThan(2000);
    // A lower cap that the region fits in is fine.
    expect(() => flattenRegion(bezierDisk(8, 5), deflection, { maxPoints: 5000 })).not.toThrow();
  });

  it('names the region cap when a hole passes it, not what the outer loop left of it', () => {
    const deflection = { linear: 0.001, angular: 0.25 };
    const plate = bezierDisk(8, 5);
    // The outer loop fits; a hole of 2000 Beziers takes the region past 5000 points.
    const region = { ...plate, holes: [bezierDisk(2000, 10_000).outer] } as Region;
    expect(() => flattenRegion(region, deflection, { maxPoints: 5000 })).toThrow(
      /^The region flattens to more than 5000 points/,
    );
  });

  /** A circle of radius `r` around `n` 1 mm square holes (4 lines each) spread over the disk. */
  function plateWithHoles(r: number, n: number): Region {
    const edge = { edgeId: 'e', entityId: 'e', fragile: false, reversed: false };
    const holes = [];
    const side = Math.ceil(Math.sqrt(n));
    const pitch = (1.2 * r) / side;
    for (let i = 0; i < n; i++) {
      const x = -0.6 * r + (i % side) * pitch;
      const y = -0.6 * r + Math.floor(i / side) * pitch;
      const p: [number, number][] = [
        [x, y],
        [x, y + 1],
        [x + 1, y + 1],
        [x + 1, y],
      ];
      holes.push({
        curves: p.map((start, k) => ({ ...edge, kind: 'line', start, end: p[(k + 1) % 4]! })),
        area: -1,
      });
    }
    return {
      id: 'plate',
      fragile: false,
      outer: {
        curves: [{ ...edge, kind: 'circle', center: [0, 0], radius: r, start: [r, 0] }],
        area: Math.PI * r * r,
      },
      holes,
      area: Math.PI * r * r - n,
    } as unknown as Region;
  }

  it('refines a large circle around many holes quickly, looking only near each chord', () => {
    // 400 m radius at 0.05 mm: about 6300 chords, each formerly tested against all 180,000
    // hole corners (seconds, on every drag frame).
    const region = plateWithHoles(400_000, 45_000);
    const started = performance.now();
    const loops = flattenRegion(region, { linear: 0.05, angular: 0.25 }, { maxPoints: 300_000 });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(loops).toHaveLength(45_001);
    // No hole comes near the arc, so no chord was split.
    expect(loops[0]!.length).toBeLessThan(7000);
  });

  it('still splits a chord of a large circle where a hole corner comes inside it', () => {
    // A hole corner just inside the arc, closer to it than the chord there: the chord splits.
    const r = 400_000;
    const region = plateWithHoles(r, 1);
    const hole = region.holes[0]!;
    // The arc is at r - 0.05 there, the chord below it at about r - 0.1.
    const near: [number, number] = [200, r - 0.06];
    const p: [number, number][] = [near, [199, r - 2], [201, r - 2]];
    const edge = { edgeId: 'h', entityId: 'h', fragile: false, reversed: false };
    hole.curves = p.map(
      (start, k) => ({ ...edge, kind: 'line', start, end: p[(k + 1) % 3]! }) as RegionCurve,
    );
    const [outer] = flattenRegion(region, { linear: 0.05, angular: 0.25 });
    const [plain] = flattenRegion(plateWithHoles(r, 1), { linear: 0.05, angular: 0.25 });
    expect(outer!.length).toBeGreaterThan(plain!.length);
    // Every chord keeps the corner on the polygon's inside.
    for (let k = 0; k < outer!.length; k++) {
      const a = outer![k]!;
      const b = outer![(k + 1) % outer!.length]!;
      const c = (b[0] - a[0]) * (near[1] - a[1]) - (b[1] - a[1]) * (near[0] - a[0]);
      if (Math.min(a[0], b[0]) <= 200 && Math.max(a[0], b[0]) >= 200 && a[1] > 0) {
        expect(c).toBeGreaterThan(0);
      }
    }
  });

  it('caps the refining work, failing like a region past the point cap', () => {
    const region = plateWithHoles(400_000, 45_000);
    const deflection = { linear: 0.05, angular: 0.25 };
    expect(() =>
      flattenRegion(region, deflection, { maxPoints: 300_000, maxRefineWork: 100_000 }),
    ).toThrow(/^The region flattens to more than 300000 points/);
    expect(MAX_REFINE_WORK).toBeGreaterThan(MAX_FLATTEN_POINTS);
  });
});
