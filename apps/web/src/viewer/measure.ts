// Point-to-point measuring on the meshes: two clicks on the model, the straight distance between
// the points hit and its components along X, Y and Z. A third click starts a new measurement.
// The points are where the click's ray meets the drawn triangles (the engine's `surfacePoint`), so
// on curved faces they are as exact as the mesh, not the B-rep; the viewer has no kernel to ask.

import type { Vec3 } from '@manufakture/kernel/types';
import type { PointerDelegate } from '../viewport/engine';

export interface Measurement {
  from: Vec3;
  /** Null until the second point is picked. */
  to: Vec3 | null;
}

export interface Distance {
  value: number;
  dx: number;
  dy: number;
  dz: number;
}

/** The distance of a finished measurement, or null. */
export function distanceOf(m: Measurement | null): Distance | null {
  if (!m?.to) return null;
  const dx = m.to[0] - m.from[0];
  const dy = m.to[1] - m.from[1];
  const dz = m.to[2] - m.from[2];
  return { value: Math.hypot(dx, dy, dz), dx: Math.abs(dx), dy: Math.abs(dy), dz: Math.abs(dz) };
}

/** The measurement after a click on `point`. */
export function nextMeasurement(m: Measurement | null, point: Vec3): Measurement {
  if (!m || m.to) return { from: point, to: null };
  return { from: m.from, to: point };
}

/**
 * The viewport input while measuring: a left click on the model adds a point; a press beside the
 * model is not taken, so it still turns the view. Dragging after a press on the model does nothing.
 */
export function measureDelegate(
  surfacePoint: (x: number, y: number) => Vec3 | null,
  onPoint: (p: Vec3) => void,
): PointerDelegate {
  return {
    down(_e, p) {
      const hit = surfacePoint(p.x, p.y);
      if (!hit) return false;
      onPoint(hit);
      return true;
    },
    move() {},
    up() {},
  };
}
