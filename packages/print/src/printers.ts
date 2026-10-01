/**
 * The built-in printers: what a print setup names (`PrintSetup.printer`) and the bed-fit and
 * nozzle checks read. Ids are permanent, because documents store them: a row may gain fields or
 * have its numbers corrected, but an id is never removed or reused for another printer.
 *
 * The Bambu Lab geometry is copied as numbers from OrcaSlicer 2.4.2's printer profiles
 * (`resources/profiles/BBL/machine`, each model's `<model> 0.4 nozzle.json` resolved through
 * `inherits` to `fdm_bbl_3dp_001_common.json` or `fdm_bbl_3dp_002_common.json` and then
 * `fdm_machine_common.json`). They are facts about the machines as the slicer sees them, which
 * is what a part has to fit; the AGPL profile files themselves are not copied. Every nozzle
 * variant (0.2, 0.6, 0.8) of every model inherits its geometry from the 0.4 profile unchanged.
 * When a later OrcaSlicer changes a number, update the row and its source together.
 *
 * Coordinates are the slicer's bed coordinates in millimetres: the origin at the bed corner the
 * profile calls 0x0, x to the right, y to the back, z up from the bed surface.
 */

import type { Vec2 } from './geometry';

/** A region the slicer will not print on, as a convex counter-clockwise polygon. */
export interface ExcludedArea {
  /** Stable within the printer: 'origin-corner'. */
  readonly id: string;
  readonly name: string;
  readonly polygon: readonly Vec2[];
}

/**
 * What one nozzle of a two-nozzle printer can reach, in OrcaSlicer's extruder order (index 0
 * first). A body printed with that nozzle must fit here.
 */
export interface NozzleArea {
  /** 'left' or 'right', as the printer's maker names the nozzles. */
  readonly name: string;
  readonly area: readonly Vec2[];
  readonly height: number;
}

export interface Printer {
  readonly id: string;
  /** Display name. */
  readonly name: string;
  readonly maker: string;
  /** The printable area (OrcaSlicer `printable_area`), convex and counter-clockwise. */
  readonly area: readonly Vec2[];
  /** The printable height in mm (OrcaSlicer `printable_height`). */
  readonly height: number;
  /** Regions of the area that may not be printed on (OrcaSlicer `bed_exclude_area`). */
  readonly excluded: readonly ExcludedArea[];
  /**
   * Two-nozzle printers only: what each nozzle reaches (OrcaSlicer `extruder_printable_area`
   * and `extruder_printable_height`). Absent for single-nozzle printers.
   */
  readonly nozzleAreas?: readonly NozzleArea[];
  /** Nozzle diameters in mm the printer is sold with or supports, ascending. */
  readonly nozzles: readonly number[];
  /** The nozzle diameter it ships with. */
  readonly defaultNozzle: number;
  /** Where the geometry comes from. */
  readonly source: string;
  /** Where the nozzle sizes come from. */
  readonly nozzleSource: string;
}

const ORCA = 'OrcaSlicer 2.4.2, resources/profiles/BBL/machine';

const BED_256: readonly Vec2[] = [
  [0, 0],
  [256, 0],
  [256, 256],
  [0, 256],
];

/** The 18 x 28 mm corner at the bed origin that the X1 and P1 profiles exclude. */
const ORIGIN_CORNER: ExcludedArea = {
  id: 'origin-corner',
  name: 'Excluded corner at the bed origin (18 x 28 mm)',
  polygon: [
    [0, 0],
    [18, 0],
    [18, 28],
    [0, 28],
  ],
};

const SIZES = [0.2, 0.4, 0.6, 0.8] as const;

/** The nozzle-size note for models whose sizes were read off Bambu Lab's own pages. */
const bambuPage = (page: string, wording: string) =>
  `Bambu Lab ${page}, read 2026-10-01: ${wording}; OrcaSlicer 2.4.2 has 0.2, 0.4, 0.6 and 0.8 nozzle profiles`;

const INCLUDED_OPTIONAL =
  '"Nozzle Diameter (Included) 0.4 mm", "(Optional) 0.2 mm, 0.6 mm, 0.8 mm"';
const SUPPORTED =
  '"Nozzle Diameter 0.4 mm", "Supported Nozzle Diameter 0.2 mm, 0.4 mm, 0.6 mm, 0.8 mm"';

/** Every built-in printer, in display order. Ids are permanent (they are stored in documents). */
export const PRINTERS = [
  {
    id: 'bambu-a1-mini',
    name: 'Bambu Lab A1 mini',
    maker: 'Bambu Lab',
    area: [
      [0, 0],
      [180, 0],
      [180, 180],
      [0, 180],
    ],
    height: 180,
    excluded: [],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab A1 mini 0.4 nozzle.json: printable_area 0x0 to 180x180, printable_height 180, bed_exclude_area empty`,
    nozzleSource: bambuPage(
      'A1 mini tech specs (bambulab.com/en/a1-mini/tech-specs)',
      INCLUDED_OPTIONAL,
    ),
  },
  {
    id: 'bambu-a1',
    name: 'Bambu Lab A1',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 256,
    excluded: [],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab A1 0.4 nozzle.json: printable_height 256, bed_exclude_area empty; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json`,
    nozzleSource: bambuPage('A1 tech specs (bambulab.com/en/a1/tech-specs)', INCLUDED_OPTIONAL),
  },
  {
    id: 'bambu-p1p',
    name: 'Bambu Lab P1P',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 250,
    excluded: [ORIGIN_CORNER],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab P1P 0.4 nozzle.json: bed_exclude_area 0x0 to 18x28; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json; printable_height 250 from fdm_machine_common.json (Bambu Lab states 256)`,
    nozzleSource: bambuPage(
      'P1P tech specs (public-cdn.bambulab.com/store/bambulab-P1P-tech-specs.pdf)',
      INCLUDED_OPTIONAL,
    ),
  },
  {
    id: 'bambu-p1s',
    name: 'Bambu Lab P1S',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 250,
    excluded: [ORIGIN_CORNER],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab P1S 0.4 nozzle.json: bed_exclude_area 0x0 to 18x28; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json; printable_height 250 from fdm_machine_common.json (Bambu Lab states 256)`,
    nozzleSource: bambuPage('store, P1S (us.store.bambulab.com/products/p1s)', INCLUDED_OPTIONAL),
  },
  {
    id: 'bambu-p2s',
    name: 'Bambu Lab P2S',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 256,
    excluded: [],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab P2S 0.4 nozzle.json: printable_height 256, bed_exclude_area empty; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json`,
    nozzleSource: bambuPage('P2S specs (bambulab.com/en/p2s/specs)', SUPPORTED),
  },
  {
    id: 'bambu-x1',
    name: 'Bambu Lab X1',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 250,
    excluded: [ORIGIN_CORNER],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab X1 0.4 nozzle.json: bed_exclude_area 0x0 to 18x28; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json; printable_height 250 from fdm_machine_common.json (Bambu Lab states 256)`,
    nozzleSource: bambuPage(
      'X1 series tech specs (bambulab.com/en/x1, X1 column)',
      INCLUDED_OPTIONAL,
    ),
  },
  {
    id: 'bambu-x1c',
    name: 'Bambu Lab X1 Carbon',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 250,
    excluded: [ORIGIN_CORNER],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab X1 Carbon 0.4 nozzle.json: bed_exclude_area 0x0 to 18x28; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json; printable_height 250 from fdm_machine_common.json (Bambu Lab states 256)`,
    nozzleSource: bambuPage(
      'X1-Carbon tech specs (public-cdn.bambulab.com/store/X1-Carbon tech specs.pdf)',
      INCLUDED_OPTIONAL,
    ),
  },
  {
    id: 'bambu-x1e',
    name: 'Bambu Lab X1E',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 250,
    excluded: [ORIGIN_CORNER],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab X1E 0.4 nozzle.json: bed_exclude_area 0x0 to 18x28; printable_area 0x0 to 256x256 from fdm_bbl_3dp_001_common.json; printable_height 250 from fdm_machine_common.json`,
    nozzleSource:
      'OrcaSlicer 2.4.2 profiles Bambu Lab X1E 0.2, 0.4, 0.6 and 0.8 nozzle.json (default 0.4); no Bambu Lab spec page for the X1E could be read on 2026-10-01',
  },
  {
    id: 'bambu-h2s',
    name: 'Bambu Lab H2S',
    maker: 'Bambu Lab',
    area: [
      [0, 0],
      [340, 0],
      [340, 320],
      [0, 320],
    ],
    height: 340,
    excluded: [],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab H2S 0.4 nozzle.json: printable_area 0x0 to 340x320, printable_height 340, bed_exclude_area empty`,
    nozzleSource: bambuPage('H2S tech specs (bambulab.com/en/h2s/tech-specs)', SUPPORTED),
  },
  {
    id: 'bambu-h2d',
    name: 'Bambu Lab H2D',
    maker: 'Bambu Lab',
    area: [
      [0, 0],
      [350, 0],
      [350, 320],
      [0, 320],
    ],
    height: 325,
    excluded: [],
    nozzleAreas: [
      {
        name: 'left',
        area: [
          [0, 0],
          [325, 0],
          [325, 320],
          [0, 320],
        ],
        height: 320,
      },
      {
        name: 'right',
        area: [
          [25, 0],
          [350, 0],
          [350, 320],
          [25, 320],
        ],
        height: 325,
      },
    ],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab H2D 0.4 nozzle.json: printable_area 0x0 to 350x320, extruder_printable_area 0x0 to 325x320 and 25x0 to 350x320; printable_height 325, bed_exclude_area empty and extruder_printable_height 320 and 325 from fdm_bbl_3dp_002_common.json`,
    nozzleSource: bambuPage('H2D tech specs (bambulab.com/en/h2d/tech-specs)', SUPPORTED),
  },
  {
    id: 'bambu-h2d-pro',
    name: 'Bambu Lab H2D Pro',
    maker: 'Bambu Lab',
    area: [
      [0, 0],
      [350, 0],
      [350, 320],
      [0, 320],
    ],
    height: 325,
    excluded: [],
    nozzleAreas: [
      {
        name: 'left',
        area: [
          [0, 0],
          [325, 0],
          [325, 320],
          [0, 320],
        ],
        height: 320,
      },
      {
        name: 'right',
        area: [
          [25, 0],
          [350, 0],
          [350, 320],
          [25, 320],
        ],
        height: 325,
      },
    ],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab H2D Pro 0.4 nozzle.json: printable_area 0x0 to 350x320, extruder_printable_area 0x0 to 325x320 and 25x0 to 350x320; printable_height 325, bed_exclude_area empty and extruder_printable_height 320 and 325 from fdm_bbl_3dp_002_common.json`,
    nozzleSource: bambuPage('H2D Pro tech specs (bambulab.com/en/h2d-pro/tech-specs)', SUPPORTED),
  },
  {
    id: 'bambu-x2d',
    name: 'Bambu Lab X2D',
    maker: 'Bambu Lab',
    area: BED_256,
    height: 261,
    excluded: [],
    nozzleAreas: [
      { name: 'left', area: BED_256, height: 261 },
      {
        name: 'right',
        area: [
          [20.5, 0],
          [256, 0],
          [256, 256],
          [20.5, 256],
        ],
        height: 256,
      },
    ],
    nozzles: SIZES,
    defaultNozzle: 0.4,
    source: `${ORCA}/Bambu Lab X2D 0.4 nozzle.json: printable_area 0x0 to 256x256, printable_height 261, extruder_printable_area 0x0 to 256x256 and 20.5x0 to 256x256, extruder_printable_height 261 and 256; bed_exclude_area empty from fdm_bbl_3dp_002_common.json (Bambu Lab states 260 for the main nozzle)`,
    nozzleSource: bambuPage('X2D specs (bambulab.com/en/x2d/specs)', SUPPORTED),
  },
] as const satisfies readonly Printer[];

export type PrinterId = (typeof PRINTERS)[number]['id'];

/** Every printer id, in display order. */
export const PRINTER_IDS = PRINTERS.map((p) => p.id) as unknown as readonly [
  PrinterId,
  ...PrinterId[],
];

/**
 * The printer with this id, or undefined for an unknown one. A document may name a printer this
 * build does not know (a newer table, a typo); the caller reports it rather than failing to load.
 */
export function findPrinter(id: string): Printer | undefined {
  return (PRINTERS as readonly Printer[]).find((p) => p.id === id);
}

/**
 * Default line widths by nozzle diameter, from OrcaSlicer 2.4.2's BBL process profiles
 * (`resources/profiles/BBL/process`): `line_width` 0.42 in `fdm_process_common.json` for the
 * 0.4 nozzle, 0.22 in `fdm_process_single_0.10_nozzle_0.2.json`, 0.62 in
 * `fdm_process_single_0.30_nozzle_0.6.json` and 0.82 in `fdm_process_single_0.40_nozzle_0.8.json`.
 */
export const LINE_WIDTHS: readonly (readonly [nozzle: number, lineWidth: number])[] = [
  [0.2, 0.22],
  [0.4, 0.42],
  [0.6, 0.62],
  [0.8, 0.82],
];

/**
 * The default line width in mm for a nozzle diameter: the profile value for 0.2 to 0.8 mm, and
 * for any other diameter the same rule extended (nozzle + 0.02 mm, which every profile value
 * follows).
 */
export function defaultLineWidth(nozzle: number): number {
  const row = LINE_WIDTHS.find(([n]) => Math.abs(n - nozzle) < 1e-9);
  return row ? row[1] : nozzle + 0.02;
}

/**
 * OrcaSlicer's `min_feature_size` default: 25% of the nozzle diameter (`PrintConfig.cpp` at
 * 2.4.2: "Model features that are thinner than this value will not be printed").
 */
export const MIN_FEATURE_FRACTION = 0.25;

/** The thinnest feature the slicer prints at all, in mm, for a nozzle diameter. */
export function minFeatureSize(nozzle: number): number {
  return MIN_FEATURE_FRACTION * nozzle;
}

/** True when the printer offers this nozzle diameter (within 1e-9 mm). */
export function hasNozzle(printer: Printer, nozzle: number): boolean {
  return printer.nozzles.some((n) => Math.abs(n - nozzle) < 1e-9);
}
