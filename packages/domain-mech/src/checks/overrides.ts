// Check overrides (`mech.checks`, ADR 0017 decisions 2 and 5): per check, or per family of checks
// (`shaft.`), and per subject or for every subject, the user's own factor and the inputs geometry
// and the catalog do not give (a preload, a fit class, `thread-locker`).
//
// Which override applies: the most specific one that matches, field by field (the factor, and
// each input symbol on its own). A subject beats no subject, the exact check id beats a family,
// a longer family beats a shorter one, and among equals the later in the list wins. The factor
// then falls back to `domains.mech` (the check's own setting, its family's, its kind's), and with
// none set the check states its factor with nothing to compare against (decision 6).

import type { Given } from '@manufakture/calc';
import { mechItems, type CheckOverride, type SubjectRef } from '@manufakture/core';
import { evaluate } from '@manufakture/units';
import { factorSetting } from '../settings';
import type { CheckDefinition, CheckInput, CheckModel, CheckSubject, InputRef } from './types';

/** Whether an override's check field (an id or a `family.` prefix) covers a check id. */
export function overrideCovers(field: string, check: string): boolean {
  return field.endsWith('.') ? check.startsWith(field) : field === check;
}

/** Whether two subjects name the same thing; an `at` on `wanted` must match too. */
export function sameSubject(wanted: SubjectRef, got: SubjectRef): boolean {
  if (wanted.kind !== got.kind) return false;
  for (const [k, v] of Object.entries(wanted)) {
    if (k === 'at' && v === undefined) continue;
    if ((got as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

function specificity(o: CheckOverride, check: string): number {
  const subject = o.subject === undefined ? 0 : 1_000_000;
  const exact = o.check === check ? 1000 : o.check.length;
  return subject + exact;
}

/** The overrides that apply to one record, least specific first (so a later one wins). */
export function overridesFor(
  model: CheckModel,
  check: string,
  subject: readonly SubjectRef[],
): CheckOverride[] {
  const all = mechItems(model.document.mech, 'checks');
  const matching = all
    .map((o, i) => ({ o, i }))
    .filter(
      ({ o }) =>
        overrideCovers(o.check, check) &&
        (o.subject === undefined || subject.some((s) => sameSubject(o.subject!, s))),
    );
  matching.sort((a, b) => specificity(a.o, check) - specificity(b.o, check) || a.i - b.i);
  return matching.map(({ o }) => o);
}

/** The factor a record compares with, where it came from, or why it cannot be used. */
export interface ResolvedFactor {
  given?: Given;
  ref?: InputRef;
  /** An override's factor that does not evaluate or is not above zero. */
  problem?: string;
}

const MAX_FACTOR = 100;

/** The user's factor for one record: an override's, else `domains.mech`'s, else none. */
export function resolveFactor(
  model: CheckModel,
  def: CheckDefinition,
  overrides: readonly CheckOverride[],
): ResolvedFactor {
  if (def.factor === undefined) return {};
  const o = overrides.findLast((x) => x.factor !== undefined);
  if (o !== undefined) {
    const ref: InputRef = { kind: 'override', id: o.id };
    const r = evaluate(o.factor!.source, {
      expected: 'number',
      lengthUnit: o.factor!.lengthUnit,
      angleUnit: o.factor!.angleUnit,
      variables: (n) => model.variables.get(n),
    });
    if (!r.ok)
      return { ref, problem: `your factor in ${o.id} does not evaluate: ${r.error.message}` };
    if (!(Number.isFinite(r.value) && r.value > 0 && r.value <= MAX_FACTOR)) {
      return {
        ref,
        problem: `your factor in ${o.id} is ${r.value}; it must be above 0 and at most ${MAX_FACTOR}`,
      };
    }
    return { ref, given: { value: r.value, source: `your factor, override ${o.id}` } };
  }
  const setting = factorSetting(model.settings, def.id, def.factor);
  if (setting === undefined) return {};
  return {
    ref: { kind: 'setting', key: setting.key },
    given: { value: setting.value, source: `your factor, setting ${setting.key}` },
  };
}

/** A subject's inputs with the overrides' inputs applied, and the overrides' texts. */
export function applyInputOverrides(
  model: CheckModel,
  subject: CheckSubject,
  overrides: readonly CheckOverride[],
): { inputs: Record<string, CheckInput>; texts: Record<string, string> } {
  const inputs: Record<string, CheckInput> = { ...subject.inputs };
  const texts: Record<string, string> = {};
  for (const o of overrides) {
    for (const [symbol, value] of Object.entries(o.inputs ?? {})) {
      const ref: InputRef = { kind: 'override', id: o.id };
      if (typeof value === 'string') {
        texts[symbol] = value;
        continue;
      }
      const base = Object.hasOwn(inputs, symbol) ? inputs[symbol] : undefined;
      // An expression for a symbol the check does not read is kept out of the record.
      if (base === undefined) continue;
      const r = evaluate(value.source, {
        expected: base.kind,
        physical: true,
        lengthUnit: value.lengthUnit,
        angleUnit: value.angleUnit,
        variables: (n) => model.variables.get(n),
      });
      const next: CheckInput = {
        name: base.name,
        kind: base.kind,
        ref,
        // A length evaluates in millimetres; the checks work in metres.
        value:
          r.ok && Number.isFinite(r.value)
            ? base.kind === 'length'
              ? r.value / 1000
              : r.value
            : undefined,
        source: `your value, override ${o.id}`,
      };
      if (base.optional) next.optional = true;
      if (!r.ok)
        next.missing = `${o.id} gives "${value.source}", which does not evaluate: ${r.error.message}`;
      inputs[symbol] = next;
    }
  }
  return { inputs, texts };
}
