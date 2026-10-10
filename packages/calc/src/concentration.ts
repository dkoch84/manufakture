// Theoretical stress-concentration factors from the published curve fits of Peterson's charts
// (Pilkey, Formulas for Stress, Strain, and Structural Matrices, Table 6-1). The fits reproduce the
// charts to a few percent inside their stated ranges; outside them the record is 'unknown'.

import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { PETERSON, pilkey } from './sources';

export type ConcentrationLoading = 'axial' | 'bending' | 'torsion';

/** Coefficients of C = c0 + c1 √(h/r) + c2 h/r. */
type Coef = readonly [number, number, number];
/** One range of h/r with the four C coefficients. */
interface FitRange {
  from: number;
  to: number;
  C: readonly [Coef, Coef, Coef, Coef];
}

function evaluate(ranges: readonly FitRange[], hr: number, x: number, what: string): number {
  const range = ranges.find((r) => hr >= r.from && hr <= r.to);
  requireRange(
    range !== undefined,
    `h/r = ${hr.toPrecision(3)} is outside the ${what} fit (${ranges[0]!.from} to ${ranges[ranges.length - 1]!.to})`,
  );
  const s = Math.sqrt(hr);
  const [C1, C2, C3, C4] = range!.C.map(([a, b, c]) => a + b * s + c * hr) as [
    number,
    number,
    number,
    number,
  ];
  return C1 + C2 * x + C3 * x * x + C4 * x ** 3;
}

/** Pilkey Table 6-1, III (fillets), case: shoulder fillet in stepped circular shaft. */
const SHOULDER: Record<ConcentrationLoading, readonly FitRange[]> = {
  axial: [
    {
      from: 0.1,
      to: 2,
      C: [
        [0.926, 1.157, -0.099],
        [0.012, -3.036, 0.961],
        [-0.302, 3.977, -1.744],
        [0.365, -2.098, 0.878],
      ],
    },
    {
      from: 2,
      to: 20,
      C: [
        [1.2, 0.86, -0.022],
        [-1.805, -0.346, -0.038],
        [2.198, -0.486, 0.165],
        [-0.593, -0.028, -0.106],
      ],
    },
  ],
  bending: [
    {
      from: 0.1,
      to: 2,
      C: [
        [0.947, 1.206, -0.131],
        [0.022, -3.405, 0.915],
        [0.869, 1.777, -0.555],
        [-0.81, 0.422, -0.26],
      ],
    },
    {
      from: 2,
      to: 20,
      C: [
        [1.232, 0.832, -0.008],
        [-3.813, 0.968, -0.26],
        [7.423, -4.868, 0.869],
        [-3.839, 3.07, -0.6],
      ],
    },
  ],
  torsion: [
    {
      from: 0.25,
      to: 4,
      C: [
        [0.905, 0.783, -0.075],
        [-0.437, -1.969, 0.553],
        [1.557, 1.073, -0.578],
        [-1.061, 0.171, 0.086],
      ],
    },
  ],
};

/** Pilkey Table 6-1, I (notches and grooves), case 7: U-shaped circumferential groove. */
const GROOVE: Record<ConcentrationLoading, readonly FitRange[]> = {
  axial: [
    {
      from: 0.1,
      to: 2,
      C: [
        [0.89, 2.208, -0.094],
        [-0.923, -6.678, 1.638],
        [2.893, 6.448, -2.516],
        [-1.912, -1.944, 0.963],
      ],
    },
    {
      from: 2,
      to: 50,
      C: [
        [1.037, 1.967, 0.002],
        [-2.679, -2.98, -0.053],
        [3.09, 2.124, 0.165],
        [-0.424, -1.153, -0.106],
      ],
    },
  ],
  bending: [
    {
      from: 0.25,
      to: 2,
      C: [
        [0.594, 2.958, -0.52],
        [0.422, -10.545, 2.692],
        [0.501, 14.375, -4.486],
        [-0.613, -6.573, 2.177],
      ],
    },
    {
      from: 2,
      to: 50,
      C: [
        [0.965, 1.926, 0],
        [-2.773, -4.414, -0.017],
        [4.785, 4.681, 0.096],
        [-1.995, -2.241, -0.074],
      ],
    },
  ],
  torsion: [
    {
      from: 0.25,
      to: 2,
      C: [
        [0.966, 1.056, -0.022],
        [-0.192, -4.037, 0.674],
        [0.808, 5.321, -1.231],
        [-0.567, -2.364, 0.566],
      ],
    },
    {
      from: 2,
      to: 50,
      C: [
        [1.089, 0.924, 0.018],
        [-1.504, -2.141, -0.047],
        [2.486, 2.289, 0.091],
        [-1.056, -1.104, -0.059],
      ],
    },
  ],
};

const NOMINAL: Record<ConcentrationLoading, string> = {
  axial: 'σ_nom = 4P / (π d²)',
  bending: 'σ_nom = 32M / (π d³)',
  torsion: 'τ_nom = 16T / (π d³)',
};

const GEOMETRY = {
  D: { name: 'Larger diameter', symbol: 'D', unit: 'm' },
  d: { name: 'Smaller diameter', symbol: 'd', unit: 'm' },
  r: { name: 'Fillet or root radius', symbol: 'r', unit: 'm' },
} as const;

/** Kt of a shoulder fillet between diameters D and d with fillet radius r. */
export function shoulderFilletKt(
  p: { D: Param; d: Param; r: Param },
  loading: ConcentrationLoading,
  options?: RecordOptions,
) {
  return calc(
    {
      id: `kt.shoulder-${loading}`,
      title: `Stress concentration, shoulder fillet (${loading})`,
      method: "Curve fit of Peterson's chart for a stepped round shaft",
      formula: `K_t = C₁ + C₂ (2h/D) + C₃ (2h/D)² + C₄ (2h/D)³, h = (D - d)/2; ${NOMINAL[loading]}`,
      unit: '1',
      sources: [pilkey('Table 6-1, part III, shoulder fillet in stepped circular shaft'), PETERSON],
      assumptions: ['Nominal stress on the smaller diameter d', 'Linear elastic, static Kt'],
      inputs: GEOMETRY,
    },
    p,
    options,
    (v) => {
      requireRange(v.D > v.d && v.d > 0 && v.r > 0, 'Needs D > d > 0 and r > 0');
      const h = (v.D - v.d) / 2;
      const x = (2 * h) / v.D;
      return {
        result: evaluate(SHOULDER[loading], h / v.r, x, 'shoulder'),
        derived: [
          value('Step height over radius', 'h/r', h / v.r, '1'),
          value('Relative step', '2h/D', x, '1'),
        ],
      };
    },
  );
}

/** Kt of a U-shaped circumferential groove of root diameter d and root radius r in a bar D. */
export function grooveKt(
  p: { D: Param; d: Param; r: Param },
  loading: ConcentrationLoading,
  options?: RecordOptions,
) {
  return calc(
    {
      id: `kt.groove-${loading}`,
      title: `Stress concentration, U-groove (${loading})`,
      method: "Curve fit of Peterson's chart for a U-shaped circumferential groove",
      formula: `K_t = C₁ + C₂ (2h/D) + C₃ (2h/D)² + C₄ (2h/D)³, h = (D - d)/2; ${NOMINAL[loading]}`,
      unit: '1',
      sources: [pilkey('Table 6-1, part I, case 7, U-shaped circumferential groove'), PETERSON],
      assumptions: ['Nominal stress on the root diameter d', 'Linear elastic, static Kt'],
      inputs: { ...GEOMETRY, d: { name: 'Root diameter', symbol: 'd', unit: 'm' } },
    },
    p,
    options,
    (v) => {
      requireRange(v.D > v.d && v.d > 0 && v.r > 0, 'Needs D > d > 0 and r > 0');
      const h = (v.D - v.d) / 2;
      const x = (2 * h) / v.D;
      return {
        result: evaluate(GROOVE[loading], h / v.r, x, 'groove'),
        derived: [
          value('Groove depth over radius', 'h/r', h / v.r, '1'),
          value('Relative depth', '2h/D', x, '1'),
        ],
      };
    },
  );
}

/** Kt of a central circular hole of diameter d in a plate of width W in tension. */
export function holeInPlateKt(p: { W: Param; d: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'kt.hole-in-plate',
      title: 'Stress concentration, central hole in a plate (tension)',
      method: "Curve fit of Peterson's chart for a central hole in a finite-width plate",
      formula: 'K_t = 3.000 - 3.140 (d/W) + 3.667 (d/W)² - 1.527 (d/W)³; σ_nom = P / ((W - d) t)',
      unit: '1',
      sources: [pilkey('Table 6-1, part II, case 2a'), PETERSON],
      assumptions: ['Nominal stress on the net section', 'Linear elastic, static Kt'],
      inputs: {
        W: { name: 'Plate width', symbol: 'W', unit: 'm' },
        d: { name: 'Hole diameter', symbol: 'd', unit: 'm' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.d > 0 && v.d < v.W, 'Needs 0 < d < W');
      const x = v.d / v.W;
      return {
        result: 3 - 3.14 * x + 3.667 * x * x - 1.527 * x ** 3,
        derived: [value('Hole over width', 'd/W', x, '1')],
      };
    },
  );
}

/**
 * Kt of an end-milled keyseat with a semicircular end (width D/4, depth D/8) in a round shaft:
 * the larger of the surface value at the keyseat end (A) and the fillet value at its bottom (B).
 * In torsion the factor is the maximum principal stress over the nominal shear stress.
 */
export function keyseatKt(
  p: { D: Param; r: Param },
  loading: 'bending' | 'torsion',
  options?: RecordOptions,
) {
  const torsion = loading === 'torsion';
  return calc(
    {
      id: `kt.keyseat-${loading}`,
      title: `Stress concentration, end-milled keyseat (${loading})`,
      method: "Peterson's keyseat data as fitted in Pilkey",
      formula: torsion
        ? 'K_tA ≈ 3.4; K_tB = 1.953 + 0.1434 (0.1/(r/D)) - 0.0021 (0.1/(r/D))²; τ_nom = 16T / (π D³)'
        : 'K_tA = 1.6; K_tB = 1.426 + 0.1643 (0.1/(r/D)) - 0.0019 (0.1/(r/D))²; σ_nom = 32M / (π D³)',
      unit: '1',
      sources: [
        pilkey('Table 6-1, part IV, case 1, round shaft with semicircular end key seat'),
        PETERSON,
      ],
      assumptions: [
        'Keyseat width D/4 and depth D/8; nominal stress on the full diameter D',
        ...(torsion ? ['Torsion: factor is σ_max / τ_nom'] : []),
        'D up to 6.5 in (165 mm); for larger shafts Pilkey suggests the r/D = 0.0208 value',
      ],
      inputs: {
        D: { name: 'Shaft diameter', symbol: 'D', unit: 'm' },
        r: { name: 'Keyseat bottom fillet radius', symbol: 'r', unit: 'm' },
      },
    },
    p,
    options,
    (v) => {
      const rd = v.r / v.D;
      const max = torsion ? 0.07 : 0.04;
      requireRange(
        rd >= 0.005 && rd <= max,
        `r/D = ${rd.toPrecision(3)} is outside 0.005 to ${max}`,
      );
      const x = 0.1 / rd;
      const A = torsion ? 3.4 : 1.6;
      const B = torsion ? 1.953 + 0.1434 * x - 0.0021 * x * x : 1.426 + 0.1643 * x - 0.0019 * x * x;
      return {
        result: Math.max(A, B),
        derived: [
          value('Fillet radius over diameter', 'r/D', rd, '1'),
          value('Factor at the keyseat end (surface)', 'K_tA', A, '1'),
          value('Factor in the bottom fillet', 'K_tB', B, '1'),
        ],
      };
    },
  );
}
