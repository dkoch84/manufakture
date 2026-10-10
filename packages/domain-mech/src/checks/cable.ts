// The sample check of the framework (T9.5a): cable tension against the rope's minimum breaking
// load, as a factor against the user's strength factor. T9.5e owns the spool and cable checks and
// may refine it (bend ratio, wound layers); this one shows every kind of input the framework
// gathers: a catalog rating, a load case of the model, the simulation's envelope (until T9.4b
// runs, a dynamic load case reports `unknown` naming the missing peak), the user's factor and
// their overrides.
//
// One record per rope in the design (a purchased use whose entry is of the `rope` family) and per
// load case that pulls the cable: a dynamic load case reads the simulation's peak cable tension; a
// static one reads its largest cable pull.

import { loadFactor } from '@manufakture/calc';
import { mechItems, type LoadCase, type StoredExpression } from '@manufakture/core';
import { evaluate } from '@manufakture/units';
import { refText, resolveEntry } from '../parts/catalog';
import { simulationInput } from './simulation';
import type { CheckDefinition, CheckInput, CheckModel, CheckSubject } from './types';

export const CABLE_TENSION_CHECK = 'cable.tension';
/** The simulation series of the cable's tension (T9.4b names its series to match). */
export const CABLE_TENSION_SERIES = 'cable.tension';

/** A force expression of the model, in N, or why it has none. */
function force(
  model: CheckModel,
  expr: StoredExpression,
): { ok: true; value: number } | { ok: false; message: string } {
  const r = evaluate(expr.source, {
    expected: 'force',
    lengthUnit: expr.lengthUnit,
    angleUnit: expr.angleUnit,
    variables: (n) => model.variables.get(n),
  });
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error.message };
}

/** The tension input of one load case, or undefined when it does not pull the cable. */
function tension(model: CheckModel, lc: LoadCase): CheckInput | undefined {
  const name = 'Cable tension';
  if (lc.dynamic !== undefined) {
    return simulationInput(model.simulation, {
      name: `Peak ${name.toLowerCase()}`,
      loadCase: lc.id,
      loadCaseName: lc.name,
      series: CABLE_TENSION_SERIES,
      statistic: 'peak',
      kind: 'force',
    });
  }
  const pulls = (lc.static ?? []).filter((l) => l.kind === 'cable');
  if (pulls.length === 0) return undefined;
  let best: { value: number; name: string } | undefined;
  for (const pull of pulls) {
    const f = force(model, pull.force);
    if (!f.ok) {
      return {
        name,
        value: undefined,
        source: `load case ${lc.name} (${lc.id}), cable pull "${pull.name}"`,
        ref: { kind: 'given' },
        kind: 'force',
        missing: `its force "${pull.force.source}" does not evaluate: ${f.message}`,
      };
    }
    if (best === undefined || Math.abs(f.value) > best.value) {
      best = { value: Math.abs(f.value), name: pull.name };
    }
  }
  return {
    name,
    value: best!.value,
    source: `load case ${lc.name} (${lc.id}), cable pull "${best!.name}"`,
    ref: { kind: 'given' },
    kind: 'force',
  };
}

export const cableTension: CheckDefinition = {
  id: CABLE_TENSION_CHECK,
  title: 'Cable tension against the minimum breaking load',
  version: 1,
  factor: 'strength',
  subjects(model) {
    const doc = model.document;
    const out: CheckSubject[] = [];
    const loadCases = mechItems(doc.mech, 'loadCases');
    for (const use of mechItems(doc.mech, 'purchased')) {
      const resolved = resolveEntry(doc, use.entry);
      if (!resolved.ok || resolved.entry.family !== 'rope') continue;
      const entry = resolved.entry;
      const label = use.name ?? `${entry.maker} ${entry.partNumber}`.trim();
      const rated = Object.hasOwn(entry.ratings, 'minimumBreakingLoad')
        ? entry.ratings.minimumBreakingLoad
        : undefined;
      const rating: CheckInput = {
        name: 'Minimum breaking load',
        value: rated !== undefined && 'value' in rated ? rated.value : undefined,
        source: `${refText(use.entry)} ${label}, minimum breaking load${entry.verified ? '' : ' (catalog data, unverified)'}`,
        ref: { kind: 'catalog', entry: use.entry, field: 'minimumBreakingLoad' },
        kind: 'force',
      };
      if (rating.value === undefined) {
        rating.missing = `the catalog entry ${refText(use.entry)} gives none`;
      }
      for (const lc of loadCases) {
        const t = tension(model, lc);
        if (t === undefined) continue;
        out.push({
          location: `${use.id}/${lc.id}`,
          title: `Cable tension, ${label} in ${lc.name}`,
          subject: [
            { kind: 'purchased', use: use.id },
            { kind: 'loadCase', loadCase: lc.id },
          ],
          loadCase: lc.id,
          inputs: { F: t, F_break: rating },
        });
      }
    }
    return out;
  },
  compute({ inputs, factor, options }) {
    const record = loadFactor(
      { load: inputs.F, rating: inputs.F_break, requiredFactor: factor },
      options,
    );
    return {
      ...record,
      method: 'Minimum breaking load of the rope divided by the cable tension',
      assumptions: [
        ...record.assumptions,
        'The minimum breaking load is the catalog value for a new rope; terminations, bends over pulleys, wear and age reduce it.',
      ],
    };
  },
};
