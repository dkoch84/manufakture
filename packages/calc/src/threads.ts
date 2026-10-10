// Thread stripping: shear areas of the external and internal threads over the engaged length
// (FED-STD-H28/2B, as given in Machinery's Handbook), and the factor of the weaker one against the
// axial load.

import { REQUIRED_FACTOR } from './factor';
import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { fedStdH28, machinerysHandbook } from './sources';

const TAN30 = 0.57735;

/**
 * Factor against thread stripping. Shear areas, with n = 1/P threads per unit length:
 * external A_s = π n L_e K_n [1/(2n) + 0.57735 (E_s - K_n)],
 * internal A_n = π n L_e D_s [1/(2n) + 0.57735 (D_s - E_n)].
 * Without tolerance dimensions the ISO basic profile is used.
 */
export function threadStrippingFactor(
  p: {
    d: Param;
    P: Param;
    Le: Param;
    F: Param;
    /** Shear strength of the external (bolt) thread material. */
    tauExternal: Param;
    /** Shear strength of the internal (nut, tapped part, insert) thread material. */
    tauInternal: Param;
    /** Maximum minor diameter of the internal thread. */
    KnMax?: Param;
    /** Minimum pitch diameter of the external thread. */
    EsMin?: Param;
    /** Minimum major diameter of the external thread. */
    DsMin?: Param;
    /** Maximum pitch diameter of the internal thread. */
    EnMax?: Param;
    requiredFactor?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'thread.stripping-factor',
      title: 'Thread stripping factor',
      method: 'Shear areas of the external and internal threads over the engaged length',
      formula:
        'A_s = π n L_e K_n [1/(2n) + 0.57735 (E_s - K_n)]; A_n = π n L_e D_s [1/(2n) + 0.57735 (D_s - E_n)]; n_strip = min(τ_e A_s, τ_i A_n) / F',
      unit: '1',
      sources: [
        fedStdH28('Appendix A, length of engagement and shear areas'),
        machinerysHandbook(
          'Strength of screw threads: shear area of external and internal threads',
        ),
      ],
      assumptions: [
        '60° thread; load shared evenly by every engaged thread',
        'Shear strength usually taken as 0.577 of tensile yield (or about 0.6 of ultimate)',
      ],
      inputs: {
        d: { name: 'Nominal diameter', symbol: 'd', unit: 'm' },
        P: { name: 'Pitch', symbol: 'P', unit: 'm' },
        Le: { name: 'Length of engagement', symbol: 'L_e', unit: 'm' },
        F: { name: 'Axial load', symbol: 'F', unit: 'N' },
        tauExternal: { name: 'Shear strength, external thread', symbol: 'τ_e', unit: 'Pa' },
        tauInternal: { name: 'Shear strength, internal thread', symbol: 'τ_i', unit: 'Pa' },
      },
      optional: {
        KnMax: { name: 'Internal minor diameter, max', symbol: 'K_n', unit: 'm' },
        EsMin: { name: 'External pitch diameter, min', symbol: 'E_s', unit: 'm' },
        DsMin: { name: 'External major diameter, min', symbol: 'D_s', unit: 'm' },
        EnMax: { name: 'Internal pitch diameter, max', symbol: 'E_n', unit: 'm' },
        requiredFactor: REQUIRED_FACTOR,
      },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(
        v.P > 0 && v.d > v.P && v.Le > 0 && v.F > 0,
        'Needs d > P > 0, L_e > 0 and F > 0',
      );
      const basic = [v.KnMax, v.EsMin, v.DsMin, v.EnMax].some((x) => x === undefined);
      const Kn = v.KnMax ?? v.d - 1.082532 * v.P;
      const Es = v.EsMin ?? v.d - 0.649519 * v.P;
      const Ds = v.DsMin ?? v.d;
      const En = v.EnMax ?? v.d - 0.649519 * v.P;
      const n = 1 / v.P;
      const As = Math.PI * n * v.Le * Kn * (1 / (2 * n) + TAN30 * (Es - Kn));
      const An = Math.PI * n * v.Le * Ds * (1 / (2 * n) + TAN30 * (Ds - En));
      const external = v.tauExternal * As;
      const internal = v.tauInternal * An;
      return {
        result: Math.min(external, internal) / v.F,
        derived: [
          value('External thread shear area', 'A_s', As, 'm^2'),
          value('Internal thread shear area', 'A_n', An, 'm^2'),
          value('Stripping load, external thread', 'F_s', external, 'N'),
          value('Stripping load, internal thread', 'F_n', internal, 'N'),
        ],
        assumptions: basic
          ? [
              'Missing tolerance dimensions taken from the ISO basic profile (no allowance or tolerance)',
            ]
          : [],
      };
    },
  );
}
