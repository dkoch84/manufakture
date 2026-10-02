// The spike's cases. Sketch fixtures are sketch entities run through
// `packages/sketch`'s `detectRegions`, as `packages/cam` will get them; the large
// outlines are plain polygons. Each case names its offsets, and the exact area
// where it is known in closed form.

import type { SketchEntity } from '@manufakture/sketch/geometry';
import { detectRegions } from '@manufakture/sketch/geometry';
import type { P, Shape } from './geometry.ts';
import { polygonShape, shapeFromRegion } from './geometry.ts';

type Vec2 = readonly [number, number];

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({
  id,
  kind: 'line',
  construction: false,
  start,
  end,
});
const arc = (id: string, center: Vec2, start: Vec2, end: Vec2): SketchEntity => ({
  id,
  kind: 'arc',
  construction: false,
  center,
  start,
  end,
});
const circle = (id: string, center: Vec2, radius: number): SketchEntity => ({
  id,
  kind: 'circle',
  construction: false,
  center,
  radius,
});

/** A rounded rectangle as 4 lines and 4 tangent arcs, counter-clockwise ids from `p`. */
function roundedRect(p: string, x0: number, y0: number, w: number, h: number, r: number) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  return [
    line(`${p}l1`, [x0 + r, y0], [x1 - r, y0]),
    arc(`${p}a1`, [x1 - r, y0 + r], [x1 - r, y0], [x1, y0 + r]),
    line(`${p}l2`, [x1, y0 + r], [x1, y1 - r]),
    arc(`${p}a2`, [x1 - r, y1 - r], [x1, y1 - r], [x1 - r, y1]),
    line(`${p}l3`, [x1 - r, y1], [x0 + r, y1]),
    arc(`${p}a3`, [x0 + r, y1 - r], [x0 + r, y1], [x0, y1 - r]),
    line(`${p}l4`, [x0, y1 - r], [x0, y0 + r]),
    arc(`${p}a4`, [x0 + r, y0 + r], [x0, y0 + r], [x0 + r, y0]),
  ];
}

/** A horizontal stadium (slot): centre line from (x0, y) to (x1, y), half width r. */
function stadium(p: string, x0: number, x1: number, y: number, r: number) {
  return [
    line(`${p}l1`, [x0, y - r], [x1, y - r]),
    arc(`${p}a1`, [x1, y], [x1, y - r], [x1, y + r]),
    line(`${p}l2`, [x1, y + r], [x0, y + r]),
    arc(`${p}a2`, [x0, y], [x0, y + r], [x0, y - r]),
  ];
}

function rect(p: string, x0: number, y0: number, w: number, h: number) {
  return [
    line(`${p}l1`, [x0, y0], [x0 + w, y0]),
    line(`${p}l2`, [x0 + w, y0], [x0 + w, y0 + h]),
    line(`${p}l3`, [x0 + w, y0 + h], [x0, y0 + h]),
    line(`${p}l4`, [x0, y0 + h], [x0, y0]),
  ];
}

/** Every region of the sketch (even depth), as shapes. */
function regionsOf(entities: SketchEntity[]): Shape[] {
  const { regions, diagnostics } = detectRegions(entities);
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  if (warnings.length > 0) throw new Error(warnings.map((w) => w.message).join('; '));
  return regions.map(shapeFromRegion);
}

export interface Case {
  name: string;
  what: string;
  /** What Clipper gets (flattened at the run's tolerance). */
  shapes: Shape[];
  /** The exact geometry to measure against (defaults to `shapes`). */
  reference?: Shape[];
  /** Offsets to run, mm, positive outward. */
  deltas: number[];
  /** Exact area of the offset result, where known in closed form. */
  exactArea?: (delta: number) => number | undefined;
  /** Polygon inputs are not flattened (their curves are lines already). */
  polygon?: boolean;
}

const PI = Math.PI;
/** Area of a rounded rectangle. */
const rrArea = (w: number, h: number, r: number) => w * h - (4 - PI) * r * r;

export function bracket(): Case {
  // 100 x 60, corner radius 8; holes: two r6 circles and a 30 x 10 slot.
  const shapes = regionsOf([
    ...roundedRect('o', 0, 0, 100, 60, 8),
    circle('c1', [15, 30], 6),
    circle('c2', [85, 30], 6),
    ...stadium('s', 35, 65, 30, 5),
  ]);
  return {
    name: 'bracket',
    what: 'rounded rectangle with two round holes and a slot (lines, tangent arcs, circles)',
    shapes,
    deltas: [3, -3],
    exactArea: (d) => {
      // Outer grows (Steiner); holes shrink or grow by d.
      const outer = rrArea(100 + 2 * d, 60 + 2 * d, 8 + d);
      const holes = 2 * PI * (6 - d) ** 2 + (30 * 2 * (5 - d) + PI * (5 - d) ** 2);
      return outer - holes;
    },
  };
}

export function frame(): Case {
  // A square frame (sharp corners) with a round island inside its opening: two regions.
  const shapes = regionsOf([...rect('o', 0, 0, 100, 100), ...rect('i', 20, 20, 60, 60)]);
  const island = regionsOf([circle('c', [50, 50], 15)]);
  return {
    name: 'frame',
    what: 'square frame with a sharp-cornered square hole, and a round island in the hole',
    shapes: [...shapes, ...island],
    deltas: [3, -3],
    exactArea: (d) => {
      // Outer square: grows with round corners, shrinks with sharp ones; the hole the other way.
      const outer = d > 0 ? 100 * 100 + 400 * d + PI * d * d : (100 + 2 * d) ** 2;
      const hole = d > 0 ? (60 - 2 * d) ** 2 : 60 * 60 - 240 * d + PI * d * d;
      return outer - hole + PI * (15 + d) ** 2;
    },
  };
}

export function dumbbell(): Case {
  // Two r10 lobes joined by a 4 mm neck: an inward offset of 3 splits it in two.
  const y = 2;
  const x = Math.sqrt(100 - y * y);
  const shapes = regionsOf([
    arc('a1', [0, 0], [x, y], [x, -y]),
    line('l1', [x, -y], [40 - x, -y]),
    arc('a2', [40, 0], [40 - x, -y], [40 - x, y]),
    line('l2', [40 - x, y], [x, y]),
  ]);
  return {
    name: 'dumbbell',
    what: 'two r10 lobes joined by a 4 mm neck (the inward offset splits)',
    shapes,
    // No closed-form area: near the neck each piece bulges past its r7 circle up to the
    // round joins around the neck's concave corners.
    deltas: [3, -3],
  };
}

export function narrowSlots(): Case {
  // A 5 mm slot (vanishes at d = -3) and a 6.2 mm slot (a 0.2 mm sliver survives).
  const shapes = [
    ...regionsOf(stadium('s', 0, 40, 0, 2.5)),
    ...regionsOf(stadium('t', 0, 40, 20, 3.1)),
  ];
  return {
    name: 'narrow-slots',
    what: 'slots 5 mm and 6.2 mm wide, offset inward by a 6 mm tool (r 3)',
    shapes,
    deltas: [-3],
    exactArea: () => 40 * 0.2 + PI * 0.1 * 0.1,
  };
}

/** A regular polygon with `n` vertices on a circle (counter-clockwise). */
export function circlePoints(c: P, r: number, n: number): P[] {
  return Array.from({ length: n }, (_, i): P => {
    const a = (2 * PI * i) / n;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  });
}

export function circle10k(): Case {
  const pts = circlePoints([0, 0], 50, 10_000);
  return {
    name: 'circle-10k',
    what: 'a 10,000-vertex polygon on an r50 circle, against the exact circle',
    shapes: [polygonShape(pts)],
    reference: [
      { loops: [[{ kind: 'arc', c: [0, 0], r: 50, a0: 0, sweep: 2 * PI, entityId: 'c' }]] },
    ],
    deltas: [3, -3],
    exactArea: (d) => PI * (50 + d) ** 2,
    polygon: true,
  };
}

export function flower10k(): Case {
  const n = 10_000;
  const pts = Array.from({ length: n }, (_, i): P => {
    const a = (2 * PI * i) / n;
    const r = 40 + 6 * Math.sin(9 * a);
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  return {
    name: 'flower-10k',
    what: 'a 10,000-vertex wavy outline r = 40 + 6 sin 9t (concave and convex)',
    shapes: [polygonShape(pts)],
    deltas: [3, -3],
    polygon: true,
  };
}

/** The pocket-clearing case: 50 rings inward, 1.5 mm apart, from a 6 mm tool. */
export function pocket(): Case {
  const shapes = regionsOf([...roundedRect('o', 0, 0, 200, 160, 10), circle('c', [100, 80], 12)]);
  return {
    name: 'pocket',
    what: '200 x 160 rounded pocket with an r12 island, 50 rings 1.5 mm apart (6 mm tool)',
    shapes,
    deltas: Array.from({ length: 50 }, (_, i) => -(3 + 1.5 * i)),
  };
}

export function allCases(): Case[] {
  return [bracket(), frame(), dumbbell(), narrowSlots(), circle10k(), flower10k(), pocket()];
}
