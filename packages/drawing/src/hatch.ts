// Hatch lines for section faces. The display list keeps a hatch as its loops, angle and spacing
// (SVG can fill a pattern, DXF has HATCH); `hatchLines` expands it to plain segments for writers
// and canvases that draw lines only.

import type { HatchItem } from './display';
import { curvePoints, type Vec2 } from './geometry';

/**
 * The hatch's lines as segments, paper millimetres: parallel lines at `angle`, `spacing` apart,
 * through a point fixed on the sheet (the origin) so neighbouring sections line up, clipped to
 * the loops by the even-odd rule. Curves are flattened to `tolerance` (paper mm) first.
 */
export function hatchLines(hatch: HatchItem, tolerance = 0.05): [Vec2, Vec2][] {
  if (!(hatch.spacing > 0)) return [];
  const polygons = hatch.loops.map((loop) => {
    const pts: Vec2[] = [];
    for (const c of loop) for (const p of curvePoints(c, tolerance)) pts.push(p);
    return pts;
  });
  // Rotate the loops by -angle so hatch lines become horizontal (y = k * spacing).
  const c = Math.cos(hatch.angle);
  const s = Math.sin(hatch.angle);
  const toLocal = (p: Vec2): Vec2 => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const toPaper = (p: Vec2): Vec2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const edges: [Vec2, Vec2][] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of polygons) {
    const local = poly.map(toLocal);
    for (let i = 0; i < local.length; i++) {
      const a = local[i]!;
      const b = local[(i + 1) % local.length]!;
      edges.push([a, b]);
      minY = Math.min(minY, a[1]);
      maxY = Math.max(maxY, a[1]);
    }
  }
  const out: [Vec2, Vec2][] = [];
  for (let k = Math.ceil(minY / hatch.spacing); k * hatch.spacing <= maxY; k++) {
    const y = k * hatch.spacing;
    const xs: number[] = [];
    for (const [a, b] of edges) {
      // Half-open in y, so a vertex on the scan line counts once.
      if (a[1] <= y !== b[1] <= y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2)
      if (xs[i + 1]! - xs[i]! > 1e-9) out.push([toPaper([xs[i]!, y]), toPaper([xs[i + 1]!, y])]);
  }
  return out;
}
