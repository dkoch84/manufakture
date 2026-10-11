// Sessions per charge (the `sessionsPerCharge` requirement, T9.4b): the load case's session run
// back to back from a full pack, the charge carried from one to the next and the motor, pack and
// resistor cooled to ambient between them (as the T9.0b spike did), until a session takes the
// pack's terminal voltage below its cutoff or empties it. The count is the sessions completed
// before that one.

import { Simulation, type SimJob } from './engine';

export interface SessionRun {
  socStart: number;
  socEnd: number;
  /** Chemical energy the pack released, J. */
  packEnergy: number;
  /** Lowest terminal voltage, V. */
  minVoltage: number;
  /** Steps below the pack's cutoff. */
  belowCutoff: number;
}

export interface SessionsPerCharge {
  /** `budget`: stopped at the wall-clock budget before the count was settled. */
  status: 'done' | 'budget' | 'limit';
  /** Sessions completed before the cutoff (or before the pack emptied). */
  sessions: number;
  runs: SessionRun[];
}

/**
 * Back-to-back sessions of `job` from full charge. Stops at `maxSessions` (status `limit`) or at
 * `budgetMs` of wall time over all of them (status `budget`; default the job's own budget).
 */
export function sessionsPerCharge(
  job: SimJob,
  options: { maxSessions?: number; budgetMs?: number } = {},
): SessionsPerCharge {
  const max = options.maxSessions ?? 100;
  const budget = options.budgetMs ?? job.options?.budgetMs;
  const now = () => globalThis.performance?.now() ?? Date.now();
  const t0 = now();
  const runs: SessionRun[] = [];
  let soc = 1;
  for (let s = 0; s < max; s++) {
    const options = { ...job.options, record: { maxPoints: 1 } };
    delete options.budgetMs;
    const sim = new Simulation({ ...job, start: { soc }, options });
    while (!sim.advance(4096)) {
      if (budget !== undefined && now() - t0 > budget) {
        return { status: 'budget', sessions: completed(runs), runs };
      }
    }
    const r = sim.result();
    const v = r.envelopes['pack/voltage'];
    const below = r.warnings.find((w) => w.code === 'below-cutoff')?.steps ?? 0;
    runs.push({
      socStart: soc,
      socEnd: r.end.soc,
      packEnergy: r.ledger.packChemical,
      minVoltage: v?.min ?? NaN,
      belowCutoff: below,
    });
    soc = r.end.soc;
    if (below > 0 || soc <= 0) return { status: 'done', sessions: completed(runs), runs };
  }
  return { status: 'limit', sessions: completed(runs), runs };
}

function completed(runs: readonly SessionRun[]): number {
  return runs.filter((r) => r.belowCutoff === 0 && r.socEnd > 0).length;
}
