// Between the sketch plane and the canvas: sketch coordinates to CSS pixels
// through the viewport camera, and back by casting the line of sight onto
// the plane. Works in any view, not only the one normal to the sketch.

import { sketchToWorld, worldToSketch } from '@manufakture/sketch/geometry';
import type { SketchPlacement, Vec2 } from '@manufakture/sketch/model';
import type { ViewportApi } from '../viewport/Viewport';

export interface SketchView {
  placement: SketchPlacement;
  toCanvas(p: Vec2): { x: number; y: number };
  fromCanvas(x: number, y: number): Vec2 | null;
  /** Sketch units per CSS pixel at a canvas point (1 when unknown). */
  unitsPerPixel(x: number, y: number): number;
}

export type Projector = Pick<ViewportApi, 'projectToCanvas' | 'canvasToPlane'>;

export function sketchView(viewport: Projector, placement: SketchPlacement): SketchView {
  const fromCanvas = (x: number, y: number): Vec2 | null => {
    const w = viewport.canvasToPlane(x, y, placement.origin, placement.normal);
    return w ? worldToSketch(placement, w) : null;
  };
  return {
    placement,
    toCanvas: (p) => viewport.projectToCanvas(sketchToWorld(placement, p)),
    fromCanvas,
    unitsPerPixel(x, y) {
      const a = fromCanvas(x, y);
      const b = fromCanvas(x + 1, y);
      const c = fromCanvas(x, y + 1);
      if (!a || !b || !c) return 1;
      const d = Math.max(
        Math.hypot(b[0] - a[0], b[1] - a[1]),
        Math.hypot(c[0] - a[0], c[1] - a[1]),
      );
      return Number.isFinite(d) && d > 0 ? d : 1;
    },
  };
}

/**
 * SVG path data for a polyline of sketch points; empty when a point does not project (before the
 * canvas has a size, the camera maps everything to infinity).
 */
export function pathData(
  view: Pick<SketchView, 'toCanvas'>,
  points: readonly Vec2[],
  close = false,
): string {
  let d = '';
  for (const [i, p] of points.entries()) {
    const c = view.toCanvas(p);
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return '';
    d += `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`;
  }
  return close && d ? `${d}Z` : d;
}
