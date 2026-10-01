// The Thread dialog's logic, free of React (M3 plan, T3.2f; ADR 0012 decision 9): what the
// picked cylinder is (a shaft or a hole, and how big), which standard sizes can be cut into it
// with the clearance, and the best of them to start from. The sizes and their limits are the kernel's (`THREAD_SIZES`, `threadLimits`), so the
// dialog offers exactly what regen accepts.

import {
  THREAD_SIZES,
  threadLimits,
  type ThreadStandardSize,
  type ThreadSystem,
} from '@manufakture/kernel';
import type { BodyInput } from '../viewport/bodies';
import { subShapeIndex } from './references';

/** The cylinder a thread goes on, as the last regen made it. */
export interface PickedCylinder {
  side: 'external' | 'internal';
  radius: number;
}

/** The picked face's cylinder, from the shown bodies' topology; null when it is not one. */
export function pickedCylinder(bodies: readonly BodyInput[], face: string): PickedCylinder | null {
  for (const body of bodies) {
    const index = subShapeIndex(body, 'face', face);
    if (index === null) continue;
    const info = body.topology?.faces[index - 1];
    if (
      info === undefined ||
      info.surface !== 'cylinder' ||
      typeof info.radius !== 'number' ||
      typeof info.hole !== 'boolean'
    ) {
      return null;
    }
    return { side: info.hole ? 'internal' : 'external', radius: info.radius };
  }
  return null;
}

/** Whether a size can be cut into the cylinder with a diametral `clearance` (mm). */
export function sizeFits(
  size: ThreadStandardSize,
  cyl: PickedCylinder,
  clearance: number,
): boolean {
  const l = threadLimits(cyl.side, size.major, size.pitch, Math.max(0, clearance) / 2);
  return cyl.radius >= l.min - 1e-6 && cyl.radius <= l.max + 1e-6;
}

/** The sizes of a system, only those that fit the cylinder when there is one. */
export function threadSizesFor(
  system: ThreadSystem,
  cyl: PickedCylinder | null,
  clearance: number,
): ThreadStandardSize[] {
  return THREAD_SIZES.filter(
    (s) => s.system === system && (cyl === null || sizeFits(s, cyl, clearance)),
  );
}

/**
 * The size a cylinder was most likely made for: a shaft's nearest major diameter, a hole's
 * nearest tap drill or minor diameter. Undefined when no size fits.
 */
export function bestSize(
  system: ThreadSystem,
  cyl: PickedCylinder,
  clearance: number,
): ThreadStandardSize | undefined {
  const d = 2 * cyl.radius;
  const off = (s: ThreadStandardSize) =>
    cyl.side === 'external'
      ? Math.abs(s.major - d)
      : Math.min(Math.abs(s.tapDrill - d), Math.abs(s.minor - d));
  let best: ThreadStandardSize | undefined;
  for (const s of threadSizesFor(system, cyl, clearance)) {
    if (best === undefined || off(s) < off(best) - 1e-9) best = s;
  }
  return best;
}

/** What the size list shows: `M6 x 1`, `1/4-20`, `#10-24`. */
export function sizeLabel(s: ThreadStandardSize): string {
  return s.system === 'iso-metric' ? `${s.size} x ${s.pitch}` : s.size;
}

/** What the dialog says of the picked cylinder: `A shaft 6 mm across`. */
export function cylinderLabel(cyl: PickedCylinder): string {
  const d = Math.round(2 * cyl.radius * 1000) / 1000;
  return `${cyl.side === 'external' ? 'A shaft' : 'A hole'} ${d} mm across`;
}
