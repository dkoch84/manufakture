// Region fills for hover highlighting: each region triangulated in the sketch
// plane (holes included) and mapped to 3D through the sketch placement, as
// plain typed arrays a viewport can upload as they are.
//
// Arcs and circles are flattened to chords within a linear and an angular
// deflection; holes are bridged into the outer loop and the polygon is ear
// clipped. Triangles run counter-clockwise seen from the placement normal.

import type { Vec2, Vec3 } from './model';
import { placementFrame, type SketchPlacement } from './placement';
import { flattenSegment } from './outline';
import type { Region, RegionLoop } from './regions';

export interface FillDeflection {
  /** Largest distance between an arc and its chords, in millimetres. */
  linear: number;
  /** Largest angle one chord may span, in radians. */
  angular: number;
}

export const DEFAULT_FILL_DEFLECTION: FillDeflection = { linear: 0.05, angular: 0.25 };

/**
 * Most points `flattenRegion` makes of one region, its loops together. Glyph Beziers flatten
 * to up to 256 chords each and a text may have hundreds of thousands of them (regen's
 * `MAX_TEXT_CURVES`), so without a cap a large or hostile text could make tens of millions of
 * points here, and ear clipping is quadratic in them. Past the cap `flattenRegion` throws a
 * `RangeError` and the caller draws no fill for the region. A region of real text is a glyph
 * (a few hundred points at 0.05 mm), or a plate with a text's letters as holes (a few hundred
 * per letter).
 */
export const MAX_FLATTEN_POINTS = 100_000;

export interface FlattenOptions {
  /** Default `MAX_FLATTEN_POINTS`. */
  maxPoints?: number;
  /** Default `MAX_REFINE_WORK`. */
  maxRefineWork?: number;
}

/** The `RangeError` for a region that flattens to more than `max` points. */
function tooManyPoints(max: number): RangeError {
  return new RangeError(`The region flattens to more than ${max} points; it is not drawn.`);
}

export interface RegionFill {
  regionId: string;
  /** xyz per vertex, in world coordinates. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise about `normal`. */
  indices: Uint32Array;
  /** The placement normal: the side the fill faces. */
  normal: Vec3;
  /** Area of the triangles, in square millimetres (the region's, less the chord error). */
  area: number;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

const same = (a: Vec2, b: Vec2) => a[0] === b[0] && a[1] === b[1];

/** The arc a chord approximates: its circle and the sense it turns in. */
interface ChordArc {
  center: Vec2;
  radius: number;
  /** 1 counter-clockwise, -1 clockwise. */
  sense: number;
}

/** A flattened loop: points, and per point the arc of the chord to the next point (null for lines). */
interface Flat {
  points: Vec2[];
  arcs: (ChordArc | null)[];
}

const TAU = 2 * Math.PI;

function flatten(
  loop: RegionLoop,
  deflection: FillDeflection,
  budget: { left: number; readonly max: number },
): Flat {
  const points: Vec2[] = [];
  const arcs: (ChordArc | null)[] = [];
  // The error names the region's cap, not what was left of it when this loop started.
  const { max } = budget;
  const spend = (n: number, cap: number) => {
    budget.left -= n;
    if (budget.left < 0) throw tooManyPoints(cap);
  };
  for (const c of loop.curves) {
    if (c.kind === 'line') {
      spend(1, max);
      points.push(c.start);
      arcs.push(null);
      continue;
    }
    if (c.kind === 'bezier') {
      // Glyph curves: chords within the linear deflection, starting exactly at the start.
      const chord = flattenSegment(
        {
          kind: 'bezier',
          points: c.points,
          contour: 0,
          index: 0,
          split: 0,
          piece: 0,
          reversed: false,
        },
        deflection.linear,
      );
      spend(chord.length - 1, max);
      for (const p of chord.slice(0, -1)) {
        points.push(p);
        arcs.push(null);
      }
      continue;
    }
    const sense = c.reversed ? -1 : 1;
    const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
    let sweep = TAU;
    if (c.kind === 'arc') {
      const a1 = Math.atan2(c.end[1] - c.center[1], c.end[0] - c.center[0]);
      sweep = ((((a1 - a0) * sense) % TAU) + TAU) % TAU || TAU;
    }
    const byChord =
      deflection.linear < c.radius ? 2 * Math.acos(1 - deflection.linear / c.radius) : Math.PI;
    const step = Math.max(1e-3, Math.min(deflection.angular, byChord, Math.PI / 2));
    const n = Math.max(1, Math.ceil(sweep / step - 1e-9));
    spend(n, max);
    const arc: ChordArc = { center: c.center, radius: c.radius, sense };
    // Start exactly at the curve's start: other loops may touch it there.
    points.push(c.start);
    arcs.push(arc);
    for (let k = 1; k < n; k++) {
      const a = a0 + (sense * sweep * k) / n;
      points.push([c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)]);
      arcs.push(arc);
    }
  }
  return { points, arcs };
}

/** A uniform grid over a set of points, cells about one point each on average. */
interface PointGrid {
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** Per cell, its first entry in `items`; `cols * rows + 1` offsets. */
  starts: Int32Array;
  /** Point indices, grouped by cell. */
  items: Int32Array;
}

function pointGrid(points: readonly Vec2[]): PointGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const n = Math.max(1, points.length);
  const w = maxX - minX;
  const h = maxY - minY;
  // Cell size so that cols * rows stays within about 3n, even for a degenerate (flat) box.
  const cell = Math.max(Math.sqrt((w * h) / n), Math.max(w, h) / n, 1e-12);
  const cols = Math.floor(w / cell) + 1;
  const rows = Math.floor(h / cell) + 1;
  const starts = new Int32Array(cols * rows + 1);
  const cellOf = (q: Vec2) =>
    Math.min(rows - 1, Math.floor((q[1] - minY) / cell)) * cols +
    Math.min(cols - 1, Math.floor((q[0] - minX) / cell));
  const cells = new Int32Array(points.length);
  points.forEach((q, i) => {
    cells[i] = cellOf(q);
    starts[cells[i]! + 1]!++;
  });
  for (let c = 0; c < cols * rows; c++) starts[c + 1]! += starts[c]!;
  const fill = starts.slice(0, -1);
  const items = new Int32Array(points.length);
  for (let i = 0; i < points.length; i++) items[fill[cells[i]!]!++] = i;
  return { minX, minY, cell, cols, rows, starts, items };
}

/**
 * Most units of work `refine` does for one region: grid cells visited plus points tested
 * against a chord's circular segment, over all its rounds. A region of real geometry takes a
 * few per chord; geometry crowded against a long arc could take far more on every drag frame,
 * so past this `flattenRegion` throws its `RangeError` and the region is not filled.
 */
export const MAX_REFINE_WORK = 2_000_000;

/**
 * Split every chord whose circular segment (between the chord and its arc)
 * holds a point of another chord end, until none does. A chord cuts inside
 * its circle by up to the linear deflection, so geometry closer to the arc
 * than that (a corner just inside, a hole touching it) would otherwise end up
 * outside the flattened loop, and the polygon would cross itself.
 *
 * Each chord looks only at the points in its segment's box (the chord's box
 * grown by the sagitta), found through a uniform grid, and the total work is
 * capped at `maxWork`: past it this throws `tooManyPoints(maxPoints)`.
 */
function refine(flats: Flat[], maxPoints: number, maxWork: number): void {
  let work = 0;
  const spend = (n: number) => {
    work += n;
    if (work > maxWork) throw tooManyPoints(maxPoints);
  };
  for (let round = 0; round < 40; round++) {
    const points = flats.flatMap((f) => f.points);
    spend(points.length);
    const grid = pointGrid(points);
    const col = (x: number) =>
      Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.minX) / grid.cell)));
    const row = (y: number) =>
      Math.min(grid.rows - 1, Math.max(0, Math.floor((y - grid.minY) / grid.cell)));
    let changed = false;
    for (const f of flats) {
      for (let k = 0; k < f.points.length; k++) {
        const arc = f.arcs[k];
        if (!arc) continue;
        const a = f.points[k]!;
        const b = f.points[(k + 1) % f.points.length]!;
        const r = arc.radius;
        const r2 = r * r * (1 - 1e-12);
        // The segment's box: the chord's, grown by the sagitta (the whole circle's for a
        // chord of more than half the circle, which flattening never makes).
        let lo: Vec2;
        let hi: Vec2;
        if (cross(a, b, arc.center) * arc.sense >= 0) {
          const half2 = ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) / 4;
          const sagitta = half2 / (r + Math.sqrt(Math.max(0, r * r - half2)));
          const grow = sagitta * (1 + 1e-6) + r * 1e-9;
          lo = [Math.min(a[0], b[0]) - grow, Math.min(a[1], b[1]) - grow];
          hi = [Math.max(a[0], b[0]) + grow, Math.max(a[1], b[1]) + grow];
        } else {
          lo = [arc.center[0] - r, arc.center[1] - r];
          hi = [arc.center[0] + r, arc.center[1] + r];
        }
        let hit = false;
        const c0 = col(lo[0]);
        const c1 = col(hi[0]);
        const r1 = row(hi[1]);
        for (let y = row(lo[1]); y <= r1 && !hit; y++) {
          spend(c1 - c0 + 1);
          for (let x = c0; x <= c1 && !hit; x++) {
            const cellIndex = y * grid.cols + x;
            const end = grid.starts[cellIndex + 1]!;
            const from = grid.starts[cellIndex]!;
            spend(end - from);
            for (let i = from; i < end; i++) {
              const q = points[grid.items[i]!]!;
              if (q[0] < lo[0] || q[0] > hi[0] || q[1] < lo[1] || q[1] > hi[1]) continue;
              if (same(q, a) || same(q, b)) continue;
              const dx = q[0] - arc.center[0];
              const dy = q[1] - arc.center[1];
              // Inside the circle, and on the arc's side of the chord (it bulges
              // to the right of a counter-clockwise chord).
              if (dx * dx + dy * dy < r2 && cross(a, b, q) * arc.sense < 0) {
                hit = true;
                break;
              }
            }
          }
        }
        if (!hit) continue;
        const t0 = Math.atan2(a[1] - arc.center[1], a[0] - arc.center[0]);
        const t1 = Math.atan2(b[1] - arc.center[1], b[0] - arc.center[0]);
        const delta = ((((t1 - t0) * arc.sense) % TAU) + TAU) % TAU;
        const t = t0 + (arc.sense * delta) / 2;
        f.points.splice(k + 1, 0, [
          arc.center[0] + arc.radius * Math.cos(t),
          arc.center[1] + arc.radius * Math.sin(t),
        ]);
        f.arcs.splice(k + 1, 0, arc);
        changed = true;
        k++;
      }
    }
    if (!changed) return;
  }
}

/**
 * A region's loops as polygons (outer first, then holes), without repeating
 * first points: arcs flattened within `deflection`, and refined wherever
 * other geometry comes closer to an arc than its chords do. Throws a
 * `RangeError` when the loops would take more than `options.maxPoints`
 * (`MAX_FLATTEN_POINTS`) points in all, or refining them more than
 * `options.maxRefineWork` (`MAX_REFINE_WORK`) work.
 */
export function flattenRegion(
  region: Region,
  deflection: FillDeflection,
  options: FlattenOptions = {},
): Vec2[][] {
  const max = options.maxPoints ?? MAX_FLATTEN_POINTS;
  const budget = { left: max, max };
  const flats = [region.outer, ...region.holes].map((l) => flatten(l, deflection, budget));
  refine(flats, max, options.maxRefineWork ?? MAX_REFINE_WORK);
  if (flats.reduce((n, f) => n + f.points.length, 0) > max) throw tooManyPoints(max);
  return flats.map((f) => f.points);
}

function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Whether `q` is inside or on triangle (a, b, c), whatever its orientation. */
function inTriangle(a: Vec2, b: Vec2, c: Vec2, q: Vec2): boolean {
  const d1 = cross(a, b, q);
  const d2 = cross(b, c, q);
  const d3 = cross(c, a, q);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

/**
 * Join a clockwise hole into a counter-clockwise ring (vertex indices into
 * `pts`) with a two-way bridge from the hole's rightmost vertex to a ring
 * vertex it can see (Eberly, "Triangulation by ear clipping").
 */
function bridgeHole(ring: number[], hole: number[], pts: readonly Vec2[]): number[] {
  const splice = (at: number, mi: number) => [
    ...ring.slice(0, at + 1),
    ...hole.slice(mi),
    ...hole.slice(0, mi),
    hole[mi]!,
    ring[at]!,
    ...ring.slice(at + 1),
  ];
  // A hole touching the ring at a vertex is joined there, with no bridge.
  for (let mi = 0; mi < hole.length; mi++) {
    const at = ring.findIndex((r) => same(pts[r]!, pts[hole[mi]!]!));
    if (at >= 0) return splice(at, mi);
  }
  let mi = 0;
  for (let i = 1; i < hole.length; i++) {
    if (pts[hole[i]!]![0] > pts[hole[mi]!]![0]) mi = i;
  }
  const m = pts[hole[mi]!]!;
  // The nearest ring edge the ray from m towards +x crosses, and its right end.
  let candidate = -1;
  let hitX = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const a = pts[ring[i]!]!;
    const b = pts[ring[j]!]!;
    if (Math.min(a[1], b[1]) > m[1] || Math.max(a[1], b[1]) < m[1]) continue;
    const x =
      a[1] === b[1] ? Math.min(a[0], b[0]) : a[0] + ((m[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (x < m[0] || x >= hitX) continue;
    hitX = x;
    candidate = a[0] >= b[0] ? i : j;
  }
  if (candidate < 0) candidate = 0;
  // A ring vertex inside the triangle (m, hit, candidate) could block the
  // view; the one at the smallest angle from the ray is visible.
  const p = pts[ring[candidate]!]!;
  const hit: Vec2 = [Number.isFinite(hitX) ? hitX : p[0], m[1]];
  let chosen = candidate;
  let bestAngle = Math.abs(Math.atan2(p[1] - m[1], p[0] - m[0]));
  let bestDist = Math.hypot(p[0] - m[0], p[1] - m[1]);
  for (let i = 0; i < ring.length; i++) {
    const q = pts[ring[i]!]!;
    if (i === candidate || q[0] < m[0] || !inTriangle(m, hit, p, q)) continue;
    const angle = Math.abs(Math.atan2(q[1] - m[1], q[0] - m[0]));
    const d = Math.hypot(q[0] - m[0], q[1] - m[1]);
    if (angle < bestAngle || (angle === bestAngle && d < bestDist)) {
      bestAngle = angle;
      bestDist = d;
      chosen = i;
    }
  }
  return splice(chosen, mi);
}

/**
 * Ear clipping of a counter-clockwise ring (bridges allowed). Returns index
 * triples. When no clean ear is left (flattened loops that touch can cross by
 * a hair near the touching point), the convex vertex whose ear holds the
 * fewest other vertices is clipped, so the error stays at the scale of the
 * crossing.
 */
function earClip(ring: readonly number[], pts: readonly Vec2[]): number[] {
  const out: number[] = [];
  const poly = [...ring];
  /** Vertices inside the ear at `i` (on its edges too, unless `strict`), up to `limit`. */
  const intruders = (i: number, strict: boolean, limit: number): number => {
    const n = poly.length;
    const a = pts[poly[(i - 1 + n) % n]!]!;
    const b = pts[poly[i]!]!;
    const c = pts[poly[(i + 1) % n]!]!;
    let count = 0;
    for (let k = 0; k < n && count < limit; k++) {
      const q = pts[poly[k]!]!;
      if (same(q, a) || same(q, b) || same(q, c)) continue;
      const d1 = cross(a, b, q);
      const d2 = cross(b, c, q);
      const d3 = cross(c, a, q);
      if (strict ? d1 > 0 && d2 > 0 && d3 > 0 : d1 >= 0 && d2 >= 0 && d3 >= 0) count++;
    }
    return count;
  };
  const turn = (i: number) => {
    const n = poly.length;
    return cross(pts[poly[(i - 1 + n) % n]!]!, pts[poly[i]!]!, pts[poly[(i + 1) % n]!]!);
  };
  const clip = (i: number) => {
    const n = poly.length;
    out.push(poly[(i - 1 + n) % n]!, poly[i]!, poly[(i + 1) % n]!);
    poly.splice(i, 1);
  };
  let i = 0;
  let misses = 0;
  while (poly.length > 3) {
    const n = poly.length;
    i %= n;
    const t = turn(i);
    if (t === 0) {
      // Collinear or repeated: the vertex adds no area.
      poly.splice(i, 1);
      misses = 0;
    } else if (t > 0 && intruders(i, false, 1) === 0) {
      clip(i);
      misses = 0;
    } else if (++misses < n) {
      i++;
    } else {
      // Stuck: the least bad convex ear, or the flattest vertex if none is convex.
      let best = -1;
      let bestCount = Infinity;
      let bestArea = Infinity;
      for (let k = 0; k < n; k++) {
        const tk = turn(k);
        if (tk <= 0) continue;
        const count = intruders(k, true, bestCount);
        if (count < bestCount || (count === bestCount && tk < bestArea)) {
          best = k;
          bestCount = count;
          bestArea = tk;
        }
      }
      if (best >= 0) {
        clip(best);
      } else {
        let flattest = 0;
        for (let k = 1; k < n; k++) if (Math.abs(turn(k)) < Math.abs(turn(flattest))) flattest = k;
        poly.splice(flattest, 1);
      }
      misses = 0;
    }
  }
  if (poly.length === 3 && turn(1) > 0) out.push(poly[0]!, poly[1]!, poly[2]!);
  return out;
}

/** Triangles of a region in sketch coordinates: points and index triples. */
export function triangulateRegion2D(
  region: Region,
  deflection: FillDeflection = DEFAULT_FILL_DEFLECTION,
): { points: Vec2[]; triangles: number[] } {
  const points: Vec2[] = [];
  const add = (pts: readonly Vec2[], ccw: boolean): number[] => {
    const oriented = signedArea(pts) > 0 === ccw ? pts : [...pts].reverse();
    const first = points.length;
    points.push(...oriented);
    return oriented.map((_, i) => first + i);
  };
  const [outer, ...holeLoops] = flattenRegion(region, deflection);
  let ring = add(outer!, true);
  const holes = holeLoops
    .map((h) => add(h, false))
    .sort(
      (a, b) => Math.max(...b.map((i) => points[i]![0])) - Math.max(...a.map((i) => points[i]![0])),
    );
  for (const hole of holes) ring = bridgeHole(ring, hole, points);
  return { points, triangles: earClip(ring, points) };
}

/** A region's fill in world coordinates, for highlighting. */
export function regionFill(
  region: Region,
  placement: SketchPlacement,
  deflection: FillDeflection = DEFAULT_FILL_DEFLECTION,
): RegionFill {
  const { points, triangles } = triangulateRegion2D(region, deflection);
  const f = placementFrame(placement);
  const positions = new Float32Array(points.length * 3);
  points.forEach(([u, v], i) => {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = f.origin[k]! + f.x[k]! * u + f.y[k]! * v;
  });
  let area = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    area +=
      cross(points[triangles[t]!]!, points[triangles[t + 1]!]!, points[triangles[t + 2]!]!) / 2;
  }
  return {
    regionId: region.id,
    positions,
    indices: Uint32Array.from(triangles),
    normal: placement.normal,
    area,
  };
}

/**
 * Fills for every region, in the same order. A region past the flattening cap throws its
 * `RangeError` for the whole list: to skip only that region, call `regionFill` per region.
 */
export function regionFills(
  regions: readonly Region[],
  placement: SketchPlacement,
  deflection: FillDeflection = DEFAULT_FILL_DEFLECTION,
): RegionFill[] {
  return regions.map((r) => regionFill(r, placement, deflection));
}
