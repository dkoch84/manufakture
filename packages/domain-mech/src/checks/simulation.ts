// What the checks read from the simulation (ADR 0017 decision 14): per load case, the envelopes
// of its series (peak, RMS, mean, energy, final value). The simulation itself is T9.4b's; this is
// the interface it will supply. Until a load case has run, every lookup is empty, so a check that
// needs it reports `unknown` and names the input and the load case.

import type { CheckInput } from './types';

export type SimulationStatistic = 'peak' | 'rms' | 'mean' | 'energy' | 'final';

/** Why a load case has no envelopes. */
export type SimulationState = 'done' | 'not-run' | 'budget';

export interface SimulationEnvelopes {
  /** A statistic of one series of a load case's run, SI; undefined when there is none. */
  envelope(loadCase: string, series: string, statistic: SimulationStatistic): number | undefined;
  /** Whether the load case has run: `budget` when automatic runs stopped at their budget. */
  state(loadCase: string): SimulationState;
}

/** No simulation has run: what the checks read until T9.4b supplies envelopes. */
export const NO_SIMULATION: SimulationEnvelopes = {
  envelope: () => undefined,
  state: () => 'not-run',
};

/**
 * Simulation envelopes from a table by load case, then `<series>:<statistic>`, for tests and for
 * a simulation that ran elsewhere.
 */
export function simulationFrom(
  table: Readonly<Record<string, Readonly<Record<string, number>>>>,
): SimulationEnvelopes {
  const has = (o: object, k: string) => Object.hasOwn(o, k);
  return {
    envelope: (loadCase, series, statistic) => {
      const run = has(table, loadCase) ? table[loadCase]! : undefined;
      const k = `${series}:${statistic}`;
      return run !== undefined && has(run, k) ? run[k] : undefined;
    },
    state: (loadCase) => (has(table, loadCase) ? 'done' : 'not-run'),
  };
}

/** A check input read from the simulation: `missing` names the load case when there is no value. */
export function simulationInput(
  simulation: SimulationEnvelopes,
  p: {
    name: string;
    loadCase: string;
    loadCaseName: string;
    series: string;
    statistic: SimulationStatistic;
    kind: CheckInput['kind'];
  },
): CheckInput {
  const value = simulation.envelope(p.loadCase, p.series, p.statistic);
  const where = `${p.statistic} of ${p.series} in the simulation of ${p.loadCaseName} (${p.loadCase})`;
  const state = simulation.state(p.loadCase);
  const input: CheckInput = {
    name: p.name,
    value,
    source: where,
    ref: { kind: 'simulation', loadCase: p.loadCase, series: p.series, statistic: p.statistic },
    kind: p.kind,
  };
  if (value === undefined) {
    input.missing =
      state === 'budget'
        ? `the simulation of ${p.loadCase} stopped at its time budget`
        : state === 'done'
          ? `the simulation of ${p.loadCase} gives no ${p.series}`
          : `no simulation of ${p.loadCase} has run`;
  }
  return input;
}
