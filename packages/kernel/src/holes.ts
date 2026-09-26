// Standard hole sizes for the hole feature: clearance holes for screws, with
// counterbore and countersink sizes for the usual heads. Plain data in
// millimetres (inch sizes are converted with 25.4 mm/in exactly).
//
// Sources and status (every value that was not checked is marked, per size,
// in `verified`):
//
// - Metric clearance holes, M3 to M12: ISO 273:1979 "Fasteners: Clearance
//   holes for bolts and screws", series fine / medium / coarse, used here as
//   close / normal / loose. ASME B18.2.8-1999 (metric table) gives the same
//   values. Checked against the ASME B18.2.8 metric chart reproduced at
//   https://amesweb.info/Screws/Metric-Clearance-Hole-Chart.aspx (a secondary
//   source, not the standard text): all 21 values agree.
// - Inch clearance holes, #6 to 1/2": ASME B18.2.8-1999 (R2017), close /
//   normal / loose, taken as the nominal diameter of the drill the standard
//   names (#23, #18, #13 for #6, ...). Checked against the chart reproduced at
//   https://amesweb.info/Screws/Clearance-Hole-Chart.aspx (secondary source).
// - Counterbores: sized for socket head cap screws (ISO 4762 metric, ASME
//   B18.3 inch) after DIN 974-1 style tables; depth is the head height plus
//   a small allowance. NOT verified against the standards.
// - Countersinks: 90 degrees for ISO 10642 metric flat heads, 82 degrees for
//   ASME B18.3 inch flat heads; the diameter is the head's maximum head
//   diameter rounded up. NOT verified against the standards.

export type HoleFit = 'close' | 'normal' | 'loose';

export interface HoleStandardSize {
  /** `M3` ... `M12`, `#6`, `#8`, `#10`, `1/4`, `5/16`, `3/8`, `7/16`, `1/2`. */
  size: string;
  system: 'metric' | 'inch';
  /** Nominal screw diameter, mm. */
  nominal: number;
  /** Clearance hole diameter per fit, mm. */
  clearance: Record<HoleFit, number>;
  counterbore: { diameter: number; depth: number };
  countersink: { diameter: number; angle: number };
  /** Which groups of values were checked against the cited tables. */
  verified: { clearance: boolean; counterbore: boolean; countersink: boolean };
}

const IN = 25.4;
const DEG = Math.PI / 180;

function metric(
  size: string,
  nominal: number,
  [close, normal, loose]: [number, number, number],
  cbore: [number, number],
  csink: number,
): HoleStandardSize {
  return {
    size,
    system: 'metric',
    nominal,
    clearance: { close, normal, loose },
    counterbore: { diameter: cbore[0], depth: cbore[1] },
    countersink: { diameter: csink, angle: 90 * DEG },
    verified: { clearance: true, counterbore: false, countersink: false },
  };
}

function inch(
  size: string,
  nominal: number,
  [close, normal, loose]: [number, number, number],
  cbore: [number, number],
  csink: number,
): HoleStandardSize {
  return {
    size,
    system: 'inch',
    nominal: nominal * IN,
    clearance: { close: close * IN, normal: normal * IN, loose: loose * IN },
    counterbore: { diameter: cbore[0] * IN, depth: cbore[1] * IN },
    countersink: { diameter: csink * IN, angle: 82 * DEG },
    verified: { clearance: true, counterbore: false, countersink: false },
  };
}

/** The supported sizes, metric then inch, each in increasing size. */
export const HOLE_SIZES: readonly HoleStandardSize[] = [
  metric('M3', 3, [3.2, 3.4, 3.6], [6.5, 3.4], 6.8),
  metric('M4', 4, [4.3, 4.5, 4.8], [8, 4.4], 9),
  metric('M5', 5, [5.3, 5.5, 5.8], [10, 5.4], 11.3),
  metric('M6', 6, [6.4, 6.6, 7], [11, 6.5], 13.5),
  metric('M8', 8, [8.4, 9, 10], [15, 8.6], 18),
  metric('M10', 10, [10.5, 11, 12], [18, 10.6], 22.5),
  metric('M12', 12, [13, 13.5, 14.5], [20, 12.6], 27),
  // Clearance drills: #6 #23 / #18 / #13, #8 #15 / #9 / #3, #10 #5 / #2 / B,
  // then fractional drills.
  inch('#6', 0.138, [0.154, 0.1695, 0.185], [0.25, 0.145], 0.28),
  inch('#8', 0.164, [0.18, 0.196, 0.213], [0.3125, 0.17], 0.33),
  inch('#10', 0.19, [0.2055, 0.221, 0.238], [0.375, 0.2], 0.385),
  inch('1/4', 0.25, [17 / 64, 9 / 32, 19 / 64], [0.4375, 0.26], 0.51),
  inch('5/16', 0.3125, [21 / 64, 11 / 32, 23 / 64], [0.53125, 0.33], 0.64),
  inch('3/8', 0.375, [25 / 64, 13 / 32, 27 / 64], [0.625, 0.39], 0.77),
  inch('7/16', 0.4375, [29 / 64, 15 / 32, 31 / 64], [0.71875, 0.45], 0.9),
  inch('1/2', 0.5, [17 / 32, 9 / 16, 39 / 64], [0.8125, 0.52], 1.02),
];

/** A standard size by name (`M6`, `#10`, `1/4`), or undefined. */
export function holeSize(size: string): HoleStandardSize | undefined {
  return HOLE_SIZES.find((s) => s.size === size);
}

/** The clearance hole diameter for a size and fit, mm; undefined for an unknown size. */
export function clearanceDiameter(size: string, fit: HoleFit = 'normal'): number | undefined {
  return holeSize(size)?.clearance[fit];
}
