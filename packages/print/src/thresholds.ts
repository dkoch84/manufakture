// The printability thresholds of a print setup, as numbers (plan T3.1c, ADR 0012 decision 3).
// Core stores them as expressions (`PrintSetup.thresholds`); the caller evaluates them and passes
// the ones set as overrides. Absent ones default from the nozzle.
//
// Only the minimum feature is a slicer value (OrcaSlicer's `min_feature_size`, 25% of the
// nozzle). The others are estimates, documented as such and editable per setup:
// - minimum wall: two line widths (0.84 mm at a 0.4 mm nozzle), "at least two perimeters";
// - minimum gap: 0.2 mm, which the fit presets (T3.2g, T3.2h) may later inform;
// - minimum hole: two nozzle diameters (0.8 mm at a 0.4 mm nozzle);
// - teardrop size: 3 mm. Below it the top of a horizontal hole bridges acceptably on a
//   well-tuned FDM printer; above it the hole needs a teardrop or support.

import { defaultLineWidth, minFeatureSize } from './printers';

export interface PrintThresholds {
  /** mm: thinner than this is not printed at all (OrcaSlicer's `min_feature_size`). */
  minFeature: number;
  /** mm: walls thinner than this may print badly. */
  minWall: number;
  /** mm: gaps narrower than this may close up. */
  minGap: number;
  /** mm: hole diameters below this may close up. */
  minHole: number;
  /** mm: horizontal holes above this diameter need a teardrop or support. */
  teardrop: number;
}

/** Default minimum gap, mm (an estimate). */
export const DEFAULT_MIN_GAP = 0.2;
/** Default teardrop size, mm (an estimate). */
export const DEFAULT_TEARDROP = 3;
/** Default minimum wall, in line widths (an estimate: two perimeters). */
export const MIN_WALL_LINES = 2;
/** Default minimum hole, in nozzle diameters (an estimate). */
export const MIN_HOLE_NOZZLES = 2;

/** The thresholds for a nozzle diameter (mm), with `overrides` taking precedence. */
export function printThresholds(
  nozzle: number,
  overrides: Partial<PrintThresholds> = {},
): PrintThresholds {
  return {
    minFeature: overrides.minFeature ?? minFeatureSize(nozzle),
    minWall: overrides.minWall ?? MIN_WALL_LINES * defaultLineWidth(nozzle),
    minGap: overrides.minGap ?? DEFAULT_MIN_GAP,
    minHole: overrides.minHole ?? MIN_HOLE_NOZZLES * nozzle,
    teardrop: overrides.teardrop ?? DEFAULT_TEARDROP,
  };
}
