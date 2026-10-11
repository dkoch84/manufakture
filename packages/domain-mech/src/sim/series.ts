// The simulation's outputs by name (T9.4b): every series it records, its unit and what it is, and
// the envelope of each (peak, RMS, mean, the integral over time, the final value), computed from
// every step, not from the recorded points. The electrical parts follow the T9.7a contract
// `electrical/<component id>/<quantity>` (`electricalSeries`), so the connection currents and
// the electrical checks read them by the component's id. `simulationEnvelopes` turns finished
// runs into the `SimulationEnvelopes` the checks read (`checks/simulation.ts`).

import type {
  SimulationEnvelopes,
  SimulationState,
  SimulationStatistic,
} from '../checks/simulation';

/** The series every run gives, by name. */
export const SIM_SERIES = {
  'cable/position': { unit: 'm', text: 'cable extension' },
  'cable/speed': { unit: 'm/s', text: 'cable speed, positive paying out' },
  'cable/force': { unit: 'N', text: 'cable force the user feels' },
  'cable/target-force': { unit: 'N', text: 'cable force the resistance law asks for' },
  'user/power': {
    unit: 'W',
    text: 'power the user puts into the cable (negative: the machine works on the user)',
  },
  'cable/loss-power': { unit: 'W', text: 'loss in the cable path' },
  'reduction/loss-power': { unit: 'W', text: 'loss in the reductions' },
  'motor/speed': { unit: 'rad/s', text: 'rotor speed' },
  'motor/torque': { unit: 'N*m', text: 'electromagnetic torque' },
  // The amplitude, not a sinusoid's RMS: in a hold the rotor stands still and one phase can carry
  // the full amplitude as DC, so that is what a phase wire may see.
  'motor/current': { unit: 'A', text: 'phase current amplitude' },
  'motor/voltage-use': { unit: '1', text: 'voltage vector over what the bus offers' },
  'motor/copper-power': { unit: 'W', text: 'copper loss' },
  'motor/iron-power': { unit: 'W', text: 'iron loss' },
  'motor/friction-power': { unit: 'W', text: 'friction loss' },
  'motor/shaft-power': {
    unit: 'W',
    text: 'electromagnetic torque times rotor speed (negative: generating)',
  },
  'controller/loss-power': { unit: 'W', text: 'controller loss (fixed, conduction, switching)' },
  'bus/power': { unit: 'W', text: 'power drawn from the DC bus (negative: returned to it)' },
  'aux/power': { unit: 'W', text: 'always-on loads' },
  'pack/current': { unit: 'A', text: 'pack current (negative: charging)' },
  'pack/voltage': { unit: 'V', text: 'pack terminal voltage' },
  'pack/state-of-charge': { unit: '1', text: 'state of charge' },
  'pack/loss-power': { unit: 'W', text: 'loss in the pack’s internal resistance' },
  'pack/charge-power': { unit: 'W', text: 'power into the pack at its terminals while charging' },
  'resistor/power': { unit: 'W', text: 'braking resistor power' },
  'resistor/duty': { unit: '1', text: 'resistor power over what it can take at the bus voltage' },
  'pack/unsupplied-power': {
    unit: 'W',
    text: 'power the bus asked for beyond the most the pack can give',
  },
  'unabsorbed/power': {
    unit: 'W',
    text: 'regenerated power neither the pack nor a resistor takes',
  },
  'motor/winding-temperature': { unit: 'K', text: 'winding temperature' },
  'motor/housing-temperature': { unit: 'K', text: 'motor housing temperature' },
  'pack/temperature': { unit: 'K', text: 'pack (cell) temperature' },
  'resistor/temperature': { unit: 'K', text: 'braking resistor temperature' },
} as const satisfies Record<string, { unit: string; text: string }>;

export type SimSeriesName = keyof typeof SIM_SERIES;

/** One series' envelope over a run, SI. */
export interface Envelope {
  /** The largest magnitude. */
  peak: number;
  max: number;
  min: number;
  /** The time average. */
  mean: number;
  /** The root of the time average of the square. */
  rms: number;
  /** The integral over time: energy for a power (J), charge for a current (C). */
  energy: number;
  /** The value at the end of the run. */
  final: number;
}

/** Streaming accumulators of many series at once. */
export class EnvelopeAccumulator {
  private readonly max: Float64Array;
  private readonly min: Float64Array;
  private readonly sum: Float64Array;
  private readonly sq: Float64Array;
  private readonly last: Float64Array;
  private time = 0;

  constructor(readonly names: readonly string[]) {
    const n = names.length;
    this.max = new Float64Array(n).fill(-Infinity);
    this.min = new Float64Array(n).fill(Infinity);
    this.sum = new Float64Array(n);
    this.sq = new Float64Array(n);
    this.last = new Float64Array(n);
  }

  /** Adds one step of length `dt` with the values in name order. */
  add(values: Float64Array, dt: number): void {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (v > this.max[i]!) this.max[i] = v;
      if (v < this.min[i]!) this.min[i] = v;
      this.sum[i]! += v * dt;
      this.sq[i]! += v * v * dt;
      this.last[i] = v;
    }
    this.time += dt;
  }

  /** The envelopes by name; empty before any step. */
  envelopes(): Record<string, Envelope> {
    const out: Record<string, Envelope> = {};
    if (!(this.time > 0)) return out;
    this.names.forEach((name, i) => {
      const max = this.max[i]!;
      const min = this.min[i]!;
      out[name] = {
        peak: Math.max(Math.abs(max), Math.abs(min)),
        max,
        min,
        mean: this.sum[i]! / this.time,
        rms: Math.sqrt(this.sq[i]! / this.time),
        energy: this.sum[i]!,
        final: this.last[i]!,
      };
    });
    return out;
  }
}

/** What `simulationEnvelopes` reads of one load case. */
export interface LoadCaseRun {
  /** `budget`: the run stopped at its time budget; its envelopes are not served. */
  state: 'done' | 'budget';
  envelopes?: Readonly<Record<string, Envelope>>;
}

/**
 * The checks' view of finished runs by load case id. A run that stopped at its budget serves no
 * envelopes (`state` says `budget`), since a partial run's peaks and energies are not the load
 * case's.
 */
export function simulationEnvelopes(
  runs: Readonly<Record<string, LoadCaseRun>>,
): SimulationEnvelopes {
  const run = (id: string) => (Object.hasOwn(runs, id) ? runs[id] : undefined);
  return {
    envelope(loadCase: string, series: string, statistic: SimulationStatistic) {
      const r = run(loadCase);
      if (r === undefined || r.state !== 'done' || r.envelopes === undefined) return undefined;
      if (!Object.hasOwn(r.envelopes, series)) return undefined;
      return r.envelopes[series]![statistic];
    },
    state(loadCase: string): SimulationState {
      const r = run(loadCase);
      return r === undefined ? 'not-run' : r.state;
    },
  };
}
