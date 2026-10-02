// Fixture data for the G-code verifier's tests and the golden runner (T5.4d).

import type { Box3, Vec3 } from '../src/types';
import type { VerifyMachine, VerifyTool } from './verify-gcode';

/**
 * Test fixtures, not machine data: plausible travels for the two M5 machines, so the bounds
 * checks have something to check against. The machine profiles (T5.1d) own the real, cited
 * numbers; pass a profile instead once it exists.
 */
export const SHAPEOKO_5_PRO_4X4_FIXTURE: VerifyMachine = {
  name: 'Shapeoko 5 Pro 4x4 (test fixture)',
  travel: [1245, 1245, 120],
};

/** See `SHAPEOKO_5_PRO_4X4_FIXTURE`: a test fixture, not machine data. */
export const SHAPEOKO_4_XXL_FIXTURE: VerifyMachine = {
  name: 'Shapeoko 4 XXL (test fixture)',
  travel: [838, 838, 95],
};

/**
 * Where the goldens' WCS origin (stock top, front left corner) sits in the travel, for the tests:
 * 100 mm in from the front left, the stock top 60 mm above the lowest the tool tip reaches.
 */
export const FIXTURE_ORIGIN: Vec3 = [100, 100, 60];

/**
 * The stock the GRBL goldens (`post/grbl.test.ts`) are cut from, WCS mm: 12 mm plywood from
 * -5 to 125 in X and -5 to 45 in Y, the origin on its top. The fixture jobs cut a 60 x 40 mm
 * outline at the origin, a pocket at (80..120, 0..30) and holes 8 mm deep.
 */
export const GOLDEN_STOCK: Box3 = { min: [-5, -5, -12], max: [125, 45, 0] };

/** The goldens' tools, as `post/grbl.test.ts` defines them. */
export const FLAT_201: VerifyTool = {
  number: 201,
  name: '#201 1/4" flat end mill',
  diameter: 6.35,
};
export const VBIT_302: VerifyTool = { number: 302, name: '#302 60 deg V-bit', diameter: 12.7 };
export const DRILL_3: VerifyTool = { number: 3, name: '3 mm drill', diameter: 3 };

export interface GoldenFixture {
  /** The file's tools in the order it uses them. */
  readonly tools: readonly VerifyTool[];
  /** How the file changes tools: one tool per file, or an M0 pause per change. */
  readonly toolChange: 'none' | 'm0-pause';
}

/**
 * Every GRBL golden file by name. The golden runner fails on a golden missing from this table,
 * so a new golden needs its fixture here.
 */
export const GRBL_GOLDENS: Readonly<Record<string, GoldenFixture>> = {
  'profile-tabs.nc': { tools: [FLAT_201], toolChange: 'none' },
  'profile-tabs-inch.nc': { tools: [FLAT_201], toolChange: 'none' },
  'pocket.nc': { tools: [FLAT_201], toolChange: 'none' },
  'drilling.nc': { tools: [DRILL_3], toolChange: 'none' },
  'two-tools-files-1.nc': { tools: [FLAT_201], toolChange: 'none' },
  'two-tools-files-2.nc': { tools: [VBIT_302], toolChange: 'none' },
  'two-tools-pause.nc': { tools: [FLAT_201, VBIT_302], toolChange: 'm0-pause' },
};
