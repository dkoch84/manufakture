/**
 * Fit defaults for printed parts (ADR 0012 decision 10, plan M3 T3.2g): the diametral clearances
 * the **Insert fit variables** command writes as `#fit_press`, `#fit_slip` and `#fit_sliding`,
 * and hole sizes for heat-set inserts and self-tapping screws.
 *
 * A clearance is diametral: the hole is the pin's diameter plus the clearance (a 6 mm peg in a
 * 6.2 mm hole has a clearance of 0.2 mm). The defaults are **placeholders**: typical community
 * values for a 0.4 mm nozzle, estimates that were not measured on any printer. The fit-test
 * coupon (T3.2g) measures them and T3.2h replaces them with measured values and their provenance.
 * Real clearances depend on the printer, the nozzle, the filament and the slicer's settings (a
 * Bambu Lab process profile in OrcaSlicer 2.4.2 compensates the first layer's elephant foot by
 * 0.15 mm, for one), so every value here is a starting point for a document's own variables.
 */

import { findPrinter, type Printer } from './printers';

/** The three printed fits, loosest last. */
export const FIT_KINDS = ['press', 'slip', 'sliding'] as const;
export type FitKind = (typeof FIT_KINDS)[number];

/** The variable each fit is written to, without the `#`. */
export const FIT_VARIABLES: Readonly<Record<FitKind, string>> = {
  press: 'fit_press',
  slip: 'fit_slip',
  sliding: 'fit_sliding',
};

/** What each fit feels like, as the coupon's procedure tests it. */
export const FIT_DESCRIPTIONS: Readonly<Record<FitKind, string>> = {
  press: 'goes in with force and stays',
  slip: 'slides in by hand without play',
  sliding: 'moves freely',
};

/**
 * Printers that share fit defaults. `generic` is any printer the table has no row for (an
 * unknown printer id, or none).
 */
export type PrinterFamily = 'generic' | 'bambu-lab';

/** `placeholder`: an estimate to start from. `measured`: printed and checked (T3.2h). */
export type FitProvenance = 'placeholder' | 'measured';

export type FitClearances = Readonly<Record<FitKind, number>>;

/** One row of the fit table: diametral clearances in mm for a printer family and nozzle. */
export interface FitRow {
  readonly family: PrinterFamily;
  /** Nozzle diameter, mm. */
  readonly nozzle: number;
  readonly clearances: FitClearances;
  readonly provenance: FitProvenance;
  /** Where the values come from. */
  readonly source: string;
}

/** The nozzle the table's rows are given for. */
export const REFERENCE_NOZZLE = 0.4;

const PLACEHOLDER_SOURCE =
  'Placeholder: typical community values for FDM printing at a 0.4 mm nozzle (press 0.1, slip 0.2, sliding 0.4 mm diametral), estimates not measured on this printer family; T3.2h replaces them with values measured on the fit-test coupon';

/** The fit table. A row per family and nozzle; other nozzles scale the family's 0.4 mm row. */
export const FIT_TABLE: readonly FitRow[] = [
  {
    family: 'generic',
    nozzle: REFERENCE_NOZZLE,
    clearances: { press: 0.1, slip: 0.2, sliding: 0.4 },
    provenance: 'placeholder',
    source: PLACEHOLDER_SOURCE,
  },
  {
    family: 'bambu-lab',
    nozzle: REFERENCE_NOZZLE,
    clearances: { press: 0.1, slip: 0.2, sliding: 0.4 },
    provenance: 'placeholder',
    source: PLACEHOLDER_SOURCE,
  },
];

/** The family whose fit defaults a printer uses. */
export function printerFamily(printer: Printer | string | undefined): PrinterFamily {
  const p = typeof printer === 'string' ? findPrinter(printer) : printer;
  return p?.maker === 'Bambu Lab' ? 'bambu-lab' : 'generic';
}

/** The fit defaults for a printer and nozzle, with how they were found. */
export interface FitDefaults {
  readonly family: PrinterFamily;
  readonly nozzle: number;
  readonly clearances: FitClearances;
  readonly provenance: FitProvenance;
  /**
   * `table`: a row for this family and nozzle. `scaled`: the family's 0.4 mm row scaled by
   * nozzle / 0.4 (an estimate on top of the row's own provenance).
   */
  readonly basis: 'table' | 'scaled';
  readonly source: string;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
/** Round to 0.01 mm, the resolution a clearance is written with. */
const round = (x: number) => Math.round(x * 100) / 100;

/**
 * The fit defaults for a printer (an id or a row; unknown or absent: the generic family) and a
 * nozzle in mm (absent: the printer's default nozzle, or 0.4). A nozzle without a row of its own
 * takes the family's 0.4 mm row scaled in proportion to the nozzle, rounded to 0.01 mm.
 */
export function fitDefaults(
  options: { printer?: Printer | string | undefined; nozzle?: number | undefined } = {},
): FitDefaults {
  const printer =
    typeof options.printer === 'string' ? findPrinter(options.printer) : options.printer;
  const family = printerFamily(printer);
  const nozzle =
    options.nozzle !== undefined && Number.isFinite(options.nozzle) && options.nozzle > 0
      ? options.nozzle
      : (printer?.defaultNozzle ?? REFERENCE_NOZZLE);
  const rows = FIT_TABLE.filter((r) => r.family === family);
  const exact = rows.find((r) => same(r.nozzle, nozzle));
  if (exact) {
    const { clearances, provenance, source } = exact;
    return { family, nozzle, clearances, provenance, basis: 'table', source };
  }
  const base = rows.find((r) => same(r.nozzle, REFERENCE_NOZZLE))!;
  const k = nozzle / REFERENCE_NOZZLE;
  return {
    family,
    nozzle,
    clearances: {
      press: round(base.clearances.press * k),
      slip: round(base.clearances.slip * k),
      sliding: round(base.clearances.sliding * k),
    },
    provenance: 'placeholder',
    basis: 'scaled',
    source: `${base.source}; scaled by ${nozzle} / ${REFERENCE_NOZZLE} for a ${nozzle} mm nozzle`,
  };
}

// Inserts and screws ---------------------------------------------------------------------------

/** The metric sizes covered for inserts and screws. */
export const SCREW_SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5'] as const;
export type ScrewSize = (typeof SCREW_SIZES)[number];

/** A heat-set threaded insert and the hole it is melted into, mm. */
export interface HeatSetInsert {
  readonly size: ScrewSize;
  /** The hole to model (vendor's D3). */
  readonly hole: number;
  /** The insert's outer diameter (D1). */
  readonly insertDiameter: number;
  /** The insert's length (L); model the hole at least this deep. */
  readonly length: number;
  /** The thinnest wall around the hole the vendor recommends (W). */
  readonly minWall: number;
  /** Checked against the cited table. */
  readonly verified: boolean;
  readonly source: string;
}

const CNC_KITCHEN =
  'CNC Kitchen "threaded inserts in comparison" table (standard length), as reproduced on the 3DJake product pages for CNC Kitchen threaded inserts M2 to M5 standard (3djake.com/cnc-kitchen/threaded-inserts-<size>-standard), read 2026-10-01';

const insert = (
  size: ScrewSize,
  length: number,
  insertDiameter: number,
  hole: number,
  minWall: number,
): HeatSetInsert => ({
  size,
  hole,
  insertDiameter,
  length,
  minWall,
  verified: true,
  source: CNC_KITCHEN,
});

/**
 * Heat-set inserts, CNC Kitchen's standard lengths: L, D1, D3 and W copied from the vendor's
 * comparison table (the same table on each size's page). Other brands differ; use their table.
 */
export const HEAT_SET_INSERTS: readonly HeatSetInsert[] = [
  insert('M2', 3.0, 3.6, 3.2, 1.3),
  insert('M2.5', 4.0, 4.6, 4.0, 1.6),
  insert('M3', 5.7, 4.6, 4.0, 1.6),
  insert('M4', 8.1, 6.3, 5.6, 2.1),
  insert('M5', 9.5, 7.1, 6.4, 2.6),
];

/** A hole a machine screw cuts or forms its own thread in, mm. */
export interface SelfTappingHole {
  readonly size: ScrewSize;
  /** Nominal screw diameter. */
  readonly nominal: number;
  /** The hole to model. */
  readonly hole: number;
  readonly verified: boolean;
  readonly source: string;
}

const TAP_DRILL =
  'Unverified estimate: the ISO coarse-thread tap drill (nominal minus pitch) as a starting point; no vendor table for screws threading into printed plastic was found';

const tapped = (size: ScrewSize, nominal: number, pitch: number): SelfTappingHole => ({
  size,
  nominal,
  hole: round(nominal - pitch),
  verified: false,
  source: TAP_DRILL,
});

/**
 * Holes for machine screws driven straight into the print. **Not verified**: no vendor publishes
 * these for printed plastic; print a test and adjust.
 */
export const SELF_TAPPING_HOLES: readonly SelfTappingHole[] = [
  tapped('M2', 2, 0.4),
  tapped('M2.5', 2.5, 0.45),
  tapped('M3', 3, 0.5),
  tapped('M4', 4, 0.7),
  tapped('M5', 5, 0.8),
];

export function heatSetInsert(size: string): HeatSetInsert | undefined {
  return HEAT_SET_INSERTS.find((i) => i.size === size);
}

export function selfTappingHole(size: string): SelfTappingHole | undefined {
  return SELF_TAPPING_HOLES.find((h) => h.size === size);
}

// The fit-test coupon --------------------------------------------------------------------------

/** The coupon's clearances: 0.0 to 0.5 mm in 0.05 mm steps, hole 1 first. */
export const COUPON_CLEARANCES: readonly number[] = Array.from({ length: 11 }, (_, i) =>
  round(i * 0.05),
);
