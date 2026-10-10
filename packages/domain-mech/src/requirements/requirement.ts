// Requirements (ADR 0017 decision 10): named targets, each a quantity with a comparison and an
// optional tolerance. This file gives them meaning beyond core's shape: what each quantity is in
// words, whether a requirement's values evaluate in the kind its quantity needs, the load cases
// and drivetrains it names, and the line that states it. A requirement says what the user wants;
// whether the design meets it is T9.4c's requirement result ("meets" or "misses", against the
// user's own target only).

import {
  mechItems,
  requirementKind,
  type LoadCase,
  type ManufaktureDocument,
  type Requirement,
  type RequirementQuantity,
  type StoredExpression,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { resolveDynamic } from './motion';
import { FieldReader, type ItemProblem } from './values';

type NamedQuantity = Extract<RequirementQuantity, string>;

/** What each named quantity is, for people. */
export const REQUIREMENT_QUANTITY_TEXT: Readonly<Record<NamedQuantity, string>> = {
  maxForce: 'Maximum force',
  minForce: 'Minimum force',
  forceStep: 'Force step',
  peakCableSpeed: 'Peak cable speed',
  travel: 'Travel',
  holdDuration: 'Hold duration',
  sessionsPerCharge: 'Sessions per charge',
  chargeTime: 'Charge time',
  packEnergy: 'Pack energy',
  mass: 'Mass',
  envelope: 'Envelope',
  surfaceTemperature: 'Surface temperature',
};

/** The quantity in words: a named one, a record or a simulation series with its statistic. */
export function quantityText(q: RequirementQuantity): string {
  if (typeof q === 'string') return REQUIREMENT_QUANTITY_TEXT[q];
  if ('record' in q) return `Record ${q.record}`;
  return `${q.statistic} of ${q.series}`;
}

const COMPARISON_TEXT: Readonly<Record<Requirement['comparison'], string>> = {
  '>=': 'at least',
  '<=': 'at most',
  '>': 'above',
  '<': 'below',
  within: 'within',
};

/** A requirement's comparison in words. */
export function comparisonWords(c: Requirement['comparison']): string {
  return COMPARISON_TEXT[c];
}

/**
 * One line for a requirement, its values as the user typed them: "Maximum force at least 200 lbf",
 * "Envelope within 330 mm x 140 mm x 100 mm", with its tolerance and load case.
 */
export function requirementText(r: Requirement, loadCases: readonly LoadCase[] = []): string {
  const values = Array.isArray(r.value)
    ? (r.value as readonly StoredExpression[]).map((v) => v.source.trim()).join(' x ')
    : (r.value as StoredExpression).source.trim();
  let text = `${quantityText(r.quantity)} ${comparisonWords(r.comparison)} ${values}`;
  if (r.tolerance !== undefined) text += `, tolerance ${r.tolerance.source.trim()}`;
  if (r.loadCase !== undefined) {
    const lc = loadCases.find((l) => l.id === r.loadCase);
    text += lc !== undefined ? `, in ${lc.name}` : `, in ${r.loadCase} (missing)`;
  }
  return text;
}

/**
 * Every problem with one requirement, by its path from the requirement: a value or tolerance that
 * does not evaluate in its quantity's kind, an envelope size not above zero, a tolerance below
 * zero, a load case or drivetrain the document does not have.
 */
export function requirementProblems(
  doc: ManufaktureDocument,
  r: Requirement,
  variables: VariableLookup,
): ItemProblem[] {
  const reader = new FieldReader(variables);
  const kind = requirementKind(r.quantity);
  if (Array.isArray(r.value)) {
    (r.value as readonly StoredExpression[]).forEach((v, i) =>
      reader.read(['value', i], v, kind, { above: 0, what: 'a size' }),
    );
  } else reader.read(['value'], r.value as StoredExpression, kind);
  if (r.tolerance !== undefined) {
    reader.read(['tolerance'], r.tolerance, kind === 'temperature' ? 'temperatureDelta' : kind, {
      min: 0,
      what: 'the tolerance',
    });
  }
  if (
    r.loadCase !== undefined &&
    !mechItems(doc.mech, 'loadCases').some((l) => l.id === r.loadCase)
  ) {
    reader.problem(['loadCase'], `there is no load case ${r.loadCase}`);
  }
  if (
    r.drivetrain !== undefined &&
    !mechItems(doc.mech, 'drivetrains').some((d) => d.id === r.drivetrain)
  ) {
    reader.problem(['drivetrain'], `there is no drivetrain ${r.drivetrain}`);
  }
  return reader.problems;
}

/**
 * Every problem with one load case, by its path from the load case: its dynamic part
 * (`resolveDynamic`), each static load's values, and a drivetrain the document does not have. A
 * load case needs a dynamic part or static loads.
 */
export function loadCaseProblems(
  doc: ManufaktureDocument,
  lc: LoadCase,
  variables: VariableLookup,
): ItemProblem[] {
  const out: ItemProblem[] = [];
  if (lc.dynamic === undefined && (lc.static ?? []).length === 0) {
    out.push({ path: [], message: 'a load case needs a motion or a static load' });
  }
  if (lc.dynamic !== undefined) {
    const d = resolveDynamic(lc.dynamic, variables);
    if (!d.ok) out.push(...d.problems);
  }
  const reader = new FieldReader(variables);
  (lc.static ?? []).forEach((s, i) => {
    switch (s.kind) {
      case 'cable':
        reader.read(['static', i, 'force'], s.force, 'force', { min: 0, what: 'the force' });
        reader.read(['static', i, 'angle'], s.angle, 'angle');
        if (s.azimuth !== undefined) reader.read(['static', i, 'azimuth'], s.azimuth, 'angle');
        break;
      case 'point':
        reader.read(['static', i, 'force'], s.force, 'force', { min: 0, what: 'the force' });
        break;
      case 'acceleration':
        reader.read(['static', i, 'acceleration'], s.acceleration, 'acceleration', {
          min: 0,
          what: 'the acceleration',
        });
        break;
    }
  });
  out.push(...reader.problems);
  if (
    lc.drivetrain !== undefined &&
    !mechItems(doc.mech, 'drivetrains').some((d) => d.id === lc.drivetrain)
  ) {
    out.push({ path: ['drivetrain'], message: `there is no drivetrain ${lc.drivetrain}` });
  }
  return out;
}

/** A problem's path and message as one line: "dynamic.mode.factor: the factor must be at least 1". */
export function itemProblemText(p: ItemProblem): string {
  return p.path.length === 0 ? p.message : `${p.path.join('.')}: ${p.message}`;
}
