// Wiring: AWG sizes, conductor resistance with temperature, ampacity from the NEC copper table or
// from a bare-conductor heat balance, voltage drop, and I²R heating.

import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { astmB258, incropera, nbs100, nec } from './sources';

/** Annealed copper (IACS) at 20 °C, Ω·m. */
export const COPPER_RESISTIVITY_20C = 1.7241e-8;
/** Temperature coefficient of resistance of annealed copper at 20 °C, 1/K. */
export const COPPER_ALPHA_20C = 0.00393;
const T20 = 293.15;

/**
 * AWG gauge as a number: 18, 16, ..., 1, then 0 for 1/0, -1 for 2/0, -2 for 3/0, -3 for 4/0.
 */
export type AwgGauge = number;

/** Nominal diameter of a solid AWG conductor, m (ASTM B258). */
export function awgDiameter(gauge: AwgGauge): number {
  return 0.127e-3 * 92 ** ((36 - gauge) / 39);
}

/** Cross-section of a solid AWG conductor, m². */
export function awgArea(gauge: AwgGauge): number {
  const d = awgDiameter(gauge);
  return (Math.PI * d * d) / 4;
}

/** Display name of a gauge: "10 AWG", "2/0 AWG". */
export function awgName(gauge: AwgGauge): string {
  return gauge > 0 ? `${gauge} AWG` : `${1 - gauge}/0 AWG`;
}

const RESISTIVITY = {
  name: 'Resistivity at 20 °C',
  symbol: 'ρ₂₀',
  unit: 'Ω·m',
  default: { value: COPPER_RESISTIVITY_20C, note: 'annealed copper, IACS' },
} as const;
const ALPHA = {
  name: 'Temperature coefficient at 20 °C',
  symbol: 'α₂₀',
  unit: '1/K',
  default: { value: COPPER_ALPHA_20C, note: 'annealed copper' },
} as const;

/** Resistance per unit length of a conductor at a temperature. */
export function conductorResistance(
  p: { area: Param; temperature?: Param; resistivity?: Param; alpha?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'wire.resistance',
      title: 'Conductor resistance per metre',
      method: 'Resistivity over area, linear temperature coefficient',
      formula: "R' = ρ₂₀ (1 + α₂₀ (T - 20 °C)) / A",
      unit: 'Ω/m',
      sources: [nbs100('resistivity of annealed copper and its temperature coefficient')],
      assumptions: ['DC resistance, solid conductor; skin effect neglected'],
      inputs: {
        area: { name: 'Conductor cross-section', symbol: 'A', unit: 'm^2' },
        temperature: {
          name: 'Conductor temperature',
          symbol: 'T',
          unit: 'K',
          default: { value: T20, note: '20 °C' },
        },
        resistivity: RESISTIVITY,
        alpha: ALPHA,
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.area > 0, 'The area must be positive');
      return { result: (v.resistivity * (1 + v.alpha * (v.temperature - T20))) / v.area };
    },
  );
}

/** NEC Table 310.16, copper, 30 °C ambient, not more than three current-carrying conductors. */
const NEC_COPPER: Record<number, readonly [number | null, number | null, number]> = {
  18: [null, null, 14],
  16: [null, null, 18],
  14: [15, 20, 25],
  12: [20, 25, 30],
  10: [30, 35, 40],
  8: [40, 50, 55],
  6: [55, 65, 75],
  4: [70, 85, 95],
  3: [85, 100, 115],
  2: [95, 115, 130],
  1: [110, 130, 145],
  0: [125, 150, 170],
  [-1]: [145, 175, 195],
  [-2]: [165, 200, 225],
  [-3]: [195, 230, 260],
};

export type InsulationRating = 60 | 75 | 90;

/** Ampacity of a copper conductor from NEC Table 310.16, compared with a current if given. */
export function wireAmpacityTable(
  p: { current?: Param },
  wire: { gauge: AwgGauge; rating: InsulationRating },
  options?: RecordOptions,
) {
  const name = awgName(wire.gauge);
  return calc(
    {
      id: 'wire.ampacity-nec',
      title: `Wire ampacity, ${name} copper, ${wire.rating} °C insulation`,
      method: 'NEC Table 310.16 lookup',
      formula: `I_z = Table 310.16(${name}, ${wire.rating} °C)`,
      unit: 'A',
      sources: [nec('Table 310.16, copper')],
      assumptions: [
        'Building-wire table: 30 °C ambient, not more than three current-carrying conductors in a raceway, cable or earth',
        'No correction for ambient or bundling; chassis wiring in free air usually carries more',
        'NEC 240.4(D) limits overcurrent protection of 14, 12 and 10 AWG to 15, 20 and 30 A',
      ],
      inputs: {},
      optional: { current: { name: 'Design current', symbol: 'I', unit: 'A' } },
      limit: { input: 'current', kind: 'at-least' },
    },
    p,
    options,
    () => {
      const row = NEC_COPPER[wire.gauge];
      requireRange(row !== undefined, `${name} is not in the table (18 AWG to 4/0 AWG)`);
      const amps = row![wire.rating === 60 ? 0 : wire.rating === 75 ? 1 : 2];
      requireRange(amps !== null, `The table lists ${name} only in the 90 °C column`);
      return { result: amps as number };
    },
  );
}

/**
 * Current at which a bare conductor in air reaches a temperature limit, from a steady heat
 * balance: I² R'(T_max) = h π d (T_max - T_amb).
 */
export function wireAmpacityHeatBalance(
  p: {
    d: Param;
    h: Param;
    Tmax: Param;
    Tambient: Param;
    resistivity?: Param;
    alpha?: Param;
    current?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'wire.ampacity-heat-balance',
      title: 'Wire ampacity from a heat balance',
      method: 'Steady state: Joule heat equals convective and radiative loss from the surface',
      formula:
        "I = √(h π d (T_max - T_amb) / R'(T_max)), R' = ρ₂₀ (1 + α₂₀ (T_max - 20 °C)) / (π d² / 4)",
      unit: 'A',
      sources: [incropera('Ch. 3, steady conduction with heat generation; Newton cooling')],
      assumptions: [
        'Bare round conductor; h lumps convection and radiation from its surface',
        'Insulation resistance and neighbouring conductors neglected',
      ],
      inputs: {
        d: { name: 'Conductor diameter', symbol: 'd', unit: 'm' },
        h: { name: 'Surface heat-transfer coefficient', symbol: 'h', unit: 'W/(m^2·K)' },
        Tmax: { name: 'Allowed conductor temperature', symbol: 'T_max', unit: 'K' },
        Tambient: { name: 'Ambient temperature', symbol: 'T_amb', unit: 'K' },
        resistivity: RESISTIVITY,
        alpha: ALPHA,
      },
      optional: { current: { name: 'Design current', symbol: 'I', unit: 'A' } },
      limit: { input: 'current', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.d > 0 && v.h > 0 && v.Tmax > v.Tambient, 'Needs d > 0, h > 0, T_max > T_amb');
      const R = (v.resistivity * (1 + v.alpha * (v.Tmax - T20))) / ((Math.PI * v.d * v.d) / 4);
      return {
        result: Math.sqrt((v.h * Math.PI * v.d * (v.Tmax - v.Tambient)) / R),
        derived: [value('Resistance per metre at T_max', "R'", R, 'Ω/m')],
      };
    },
  );
}

/** Voltage drop over a run: ΔV = I R' L n (n conductors in the loop, 2 for out and back). */
export function voltageDrop(
  p: {
    I: Param;
    resistancePerLength: Param;
    length: Param;
    conductors?: Param;
    supply?: Param;
    allowed?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'wire.voltage-drop',
      title: 'Voltage drop',
      method: "Ohm's law over the conductors in the current loop",
      formula: "ΔV = I R' L n",
      unit: 'V',
      sources: [
        nec('Chapter 9, Table 8 conductor resistances and informational notes on voltage drop'),
      ],
      assumptions: ['DC or resistive load; reactance neglected'],
      inputs: {
        I: { name: 'Current', symbol: 'I', unit: 'A' },
        resistancePerLength: { name: 'Resistance per metre', symbol: "R'", unit: 'Ω/m' },
        length: { name: 'One-way run length', symbol: 'L', unit: 'm' },
        conductors: {
          name: 'Conductors in the loop',
          symbol: 'n',
          unit: '1',
          default: { value: 2, note: 'out and back' },
        },
      },
      optional: {
        supply: { name: 'Supply voltage', symbol: 'V_s', unit: 'V' },
        allowed: { name: 'Allowed drop', symbol: 'ΔV_allow', unit: 'V' },
      },
      limit: { input: 'allowed', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      const dV = v.I * v.resistancePerLength * v.length * v.conductors;
      return {
        result: dV,
        derived:
          v.supply === undefined || v.supply === 0
            ? []
            : [value('Drop over supply voltage', 'ΔV/V_s', dV / v.supply, '1')],
      };
    },
  );
}

/** Joule heating P = I² R(T), with R(T) from the resistance at 20 °C. */
export function jouleHeating(
  p: { I: Param; R20: Param; temperature?: Param; alpha?: Param; allowed?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'electrical.joule-heating',
      title: 'Resistive (I²R) heating',
      method: 'Joule heating with the resistance corrected to temperature',
      formula: 'P = I² R₂₀ (1 + α₂₀ (T - 20 °C))',
      unit: 'W',
      sources: [nbs100('temperature coefficient of resistance')],
      inputs: {
        I: { name: 'Current (RMS)', symbol: 'I', unit: 'A' },
        R20: { name: 'Resistance at 20 °C', symbol: 'R₂₀', unit: 'Ω' },
        temperature: {
          name: 'Conductor temperature',
          symbol: 'T',
          unit: 'K',
          default: { value: T20, note: '20 °C' },
        },
        alpha: ALPHA,
      },
      optional: { allowed: { name: 'Allowed dissipation', symbol: 'P_allow', unit: 'W' } },
      limit: { input: 'allowed', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      const R = v.R20 * (1 + v.alpha * (v.temperature - T20));
      return { result: v.I * v.I * R, derived: [value('Resistance at temperature', 'R', R, 'Ω')] };
    },
  );
}

/** For ASTM B258 citations from callers that show the AWG diameter in a record. */
export const AWG_SOURCE = astmB258('nominal diameter d = 0.127 mm × 92^((36 - n)/39)');
