// Whether an oriented, placed body fits a printer (plan T3.1b).
//
// The body is given by its bounding box in bed coordinates (after `orientationPlacement` and the
// caller's placement on the bed; `boundingBox` computes it from a mesh). It fits when the box's
// footprint lies inside the usable area, overlaps no excluded area, and the box lies between the
// bed (z = 0) and the usable height.
//
// On a two-nozzle printer the usable region depends on the nozzles the body is printed with,
// which the caller passes (from the bodies' colours and filament slots; this package does not
// guess). One nozzle: that nozzle's area and height. Both: the overlap of their areas, under the
// lower of their heights. None given: the printer's whole printable area and height, which is
// what the slicer checks before filaments are assigned.

import type { BoundingBox } from '@manufakture/kernel';
import {
  intersectConvex,
  outsideDistance,
  overlapDepth,
  polygonBounds,
  quatToMatrix,
  rectangle,
  type Placement,
  type Vec2,
} from './geometry';
import type { ExcludedArea, Printer } from './printers';

export type { BoundingBox };

/** Overshoots and overlaps up to this many mm count as fitting: float32 meshes and B-rep boxes. */
export const DEFAULT_FIT_TOLERANCE = 1e-3;

export interface BedFitBody {
  /** The placed body's bounding box, bed coordinates, mm. */
  box: BoundingBox;
  /**
   * Two-nozzle printers: indices into `printer.nozzleAreas` (OrcaSlicer's extruder order) of
   * the nozzles that print this body. Ignored by single-nozzle printers.
   */
  nozzles?: readonly number[];
}

export interface BedFitOptions {
  /** mm; default `DEFAULT_FIT_TOLERANCE`. */
  tolerance?: number;
}

/** What a body is checked against. */
export interface UsableRegion {
  /** Convex, counter-clockwise; empty when the nozzles' areas do not overlap. */
  area: Vec2[];
  height: number;
  /** Names of the nozzle areas that made it, in index order; empty for the whole printable area. */
  nozzles: string[];
  /** Nozzle indices the printer does not have (they are left out). */
  unknownNozzles: number[];
}

export interface BedFitResult {
  fits: boolean;
  /**
   * How far the box reaches outside the usable region along each axis, mm, summed over both
   * sides (so a box too big by 1 mm reports 1 however it is placed); 0 within the tolerance.
   * x and y are measured against the bounds of the usable area (exact for the rectangular areas
   * of every built-in printer); z against the bed and the usable height.
   */
  overshoot: { x: number; y: number; z: number };
  /** The excluded areas the footprint overlaps (id and display name), in table order. */
  exclusions: ExcludedArea[];
  region: UsableRegion;
}

/** The area and height a body printed with `nozzles` may use on `printer`. */
export function usableRegion(printer: Printer, nozzles?: readonly number[]): UsableRegion {
  const nozzleAreas = printer.nozzleAreas;
  if (!nozzleAreas || nozzleAreas.length === 0 || !nozzles || nozzles.length === 0) {
    return { area: [...printer.area], height: printer.height, nozzles: [], unknownNozzles: [] };
  }
  const used = [...new Set(nozzles)].sort((a, b) => a - b);
  const unknownNozzles = used.filter((i) => !Number.isInteger(i) || !nozzleAreas[i]);
  const known = used.filter((i) => !unknownNozzles.includes(i));
  let area: Vec2[] = [...printer.area];
  let height = printer.height;
  for (const i of known) {
    const n = nozzleAreas[i]!;
    area = intersectConvex(area, n.area);
    height = Math.min(height, n.height);
  }
  return { area, height, nozzles: known.map((i) => nozzleAreas[i]!.name), unknownNozzles };
}

/** Checks one placed body against a printer. */
export function checkBedFit(
  printer: Printer,
  body: BedFitBody,
  options: BedFitOptions = {},
): BedFitResult {
  const tol = options.tolerance ?? DEFAULT_FIT_TOLERANCE;
  const region = usableRegion(printer, body.nozzles);
  const { min, max } = body.box;

  const past = (v: number) => (v > tol ? v : 0);
  let overshoot: BedFitResult['overshoot'];
  let inside: boolean;
  if (region.area.length === 0) {
    overshoot = {
      x: max[0] - min[0],
      y: max[1] - min[1],
      z: past(-min[2]) + past(max[2] - region.height),
    };
    inside = false;
  } else {
    const bounds = polygonBounds(region.area);
    overshoot = {
      x: past(bounds.min[0] - min[0]) + past(max[0] - bounds.max[0]),
      y: past(bounds.min[1] - min[1]) + past(max[1] - bounds.max[1]),
      z: past(-min[2]) + past(max[2] - region.height),
    };
    const corners = rectangle([min[0], min[1]], [max[0], max[1]]);
    inside = corners.every((c) => outsideDistance(region.area, c) <= tol);
  }

  const footprint = rectangle([min[0], min[1]], [max[0], max[1]]);
  const exclusions = printer.excluded.filter((e) => overlapDepth(footprint, e.polygon) > tol);

  const fits =
    inside &&
    overshoot.x === 0 &&
    overshoot.y === 0 &&
    overshoot.z === 0 &&
    exclusions.length === 0 &&
    region.unknownNozzles.length === 0;
  return { fits, overshoot, exclusions, region };
}

/**
 * The bounding box of a mesh's points (xyz triples) after a placement, or null when there are
 * none. Several meshes printed as one item: pass them all.
 */
export function boundingBox(
  positions: ArrayLike<number> | readonly ArrayLike<number>[],
  placement?: Placement,
): BoundingBox | null {
  const m = quatToMatrix(placement?.rotation ?? [0, 0, 0, 1]);
  const t = placement?.translation ?? [0, 0, 0];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const lists =
    positions.length > 0 && typeof (positions as ArrayLike<unknown>)[0] !== 'number'
      ? (positions as readonly ArrayLike<number>[])
      : [positions as ArrayLike<number>];
  for (const p of lists) {
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i]!,
        y = p[i + 1]!,
        z = p[i + 2]!;
      for (let r = 0; r < 3; r++) {
        const v = m[3 * r]! * x + m[3 * r + 1]! * y + m[3 * r + 2]! * z + t[r]!;
        if (v < lo[r]!) lo[r] = v;
        if (v > hi[r]!) hi[r] = v;
      }
    }
  }
  if (!(lo[0]! <= hi[0]!)) return null;
  return { min: [lo[0]!, lo[1]!, lo[2]!], max: [hi[0]!, hi[1]!, hi[2]!] };
}
