// The check registry and the runner (ADR 0017 decisions 5, 6 and 15; task T9.5a). Every check
// registers here with the same shape (`CheckDefinition`); the runner gathers each one's subjects,
// applies the user's overrides and factor, computes through `@manufakture/calc` and wraps the calc
// record with its provenance. Records are recomputed only when their inputs change: each is cached
// in memory by a key of everything that goes into it (the check and its version, the domain's
// implementation, the subject, every input's value and source, the factor), never stored.

import { stableKey } from './key';
import { applyInputOverrides, overridesFor, resolveFactor } from './overrides';
import type {
  CheckDefinition,
  CheckFactorKind,
  CheckModel,
  CheckSubject,
  InputRef,
  MechRecord,
} from './types';
import { recordText } from './wording';
import type { CalcRecord, Given } from '@manufakture/calc';
import type { DomainEvaluationWarning } from '@manufakture/regen';

/** A check id: lower-case segments joined by dots, at least two (`cable.tension`). */
export const CHECK_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** The checks a runner knows, by id. */
export class CheckRegistry {
  readonly #checks = new Map<string, CheckDefinition>();

  /** Register a check. Throws on a malformed or repeated id. Returns a function that removes it. */
  register(check: CheckDefinition): () => void {
    if (!CHECK_ID.test(check.id) || check.id.length > 128) {
      throw new TypeError(`"${check.id}" is not a check id`);
    }
    if (this.#checks.has(check.id))
      throw new TypeError(`check "${check.id}" is already registered`);
    if (!Number.isSafeInteger(check.version) || check.version < 1) {
      throw new TypeError(`check "${check.id}": the version must be a whole number from 1`);
    }
    this.#checks.set(check.id, check);
    return () => {
      if (this.#checks.get(check.id) === check) this.#checks.delete(check.id);
    };
  }

  get(id: string): CheckDefinition | undefined {
    return this.#checks.get(id);
  }

  /** Every check, by id. */
  list(): CheckDefinition[] {
    return [...this.#checks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** The records of the last run by key; a run keeps only what it used. */
export class RecordCache {
  #entries = new Map<string, MechRecord>();
  #next = new Map<string, MechRecord>();
  /** Records computed (not served from the cache) since this cache was made. */
  computed = 0;

  take(key: string): MechRecord | undefined {
    const hit = this.#entries.get(key) ?? this.#next.get(key);
    if (hit !== undefined) this.#next.set(key, hit);
    return hit;
  }

  put(key: string, record: MechRecord): void {
    this.computed++;
    this.#next.set(key, record);
  }

  /** End of a run: drop every record it did not use. */
  retain(): void {
    this.#entries = this.#next;
    this.#next = new Map();
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** One record with its line for people. */
export interface CheckEntry {
  record: MechRecord;
  /** The user's factor the check compares with; absent: it states a value with no factor. */
  factor?: CheckFactorKind;
  /** "Cable tension, Rope in Rep: load 890 N, rated load 4.50 kN; factor 5.06, above your 2". */
  text: string;
}

export interface CheckRun {
  entries: CheckEntry[];
  warnings: DomainEvaluationWarning[];
}

/** A record id: `<check>@<location>`. */
export const recordId = (check: string, location: string): string => `${check}@${location}`;

function wrap(
  def: CheckDefinition,
  subject: CheckSubject,
  calc: CalcRecord,
  refs: Record<string, InputRef>,
): MechRecord {
  return {
    ...calc,
    check: def.id,
    subject: subject.subject,
    ...(subject.loadCase === undefined ? {} : { loadCase: subject.loadCase }),
    inputRefs: refs,
  };
}

/** A record that could not be computed for a reason outside the inputs (a throw). */
function failedRecord(def: CheckDefinition, id: string, title: string, why: string): CalcRecord {
  return {
    id,
    title,
    method: def.title,
    formula: '',
    inputs: [],
    result: null,
    unit: '',
    derived: [],
    assumptions: [],
    sources: [],
    status: 'unknown',
    note: `The check could not compute: ${why}`,
  };
}

/** One record of one subject: overrides, factor, cache, compute, the framework's guards. */
function runSubject(
  model: CheckModel,
  def: CheckDefinition,
  subject: CheckSubject,
  cache: RecordCache,
  implementation: number,
): MechRecord {
  const id = recordId(def.id, subject.location);
  const overrides = overridesFor(model, def.id, subject.subject);
  const factor = resolveFactor(model, def, overrides);
  const { inputs, texts } = applyInputOverrides(model, subject, overrides);
  const key = stableKey({
    implementation,
    check: def.id,
    version: def.version,
    id,
    title: subject.title,
    subject: subject.subject,
    loadCase: subject.loadCase ?? null,
    inputs,
    texts,
    factor,
  });
  const cached = cache.take(key);
  if (cached !== undefined) return cached;

  const refs: Record<string, InputRef> = {};
  const given: Record<string, Given> = {};
  const missing: string[] = [];
  for (const [symbol, input] of Object.entries(inputs)) {
    refs[symbol] = input.ref;
    given[symbol] = { value: input.value, source: input.source };
    if (input.value === undefined && !input.optional) {
      missing.push(input.missing === undefined ? input.name : `${input.name} (${input.missing})`);
    }
  }
  if (factor.ref !== undefined) refs.n_req = factor.ref;
  let calc: CalcRecord;
  try {
    calc = def.compute({
      inputs: given,
      factor: factor.given,
      texts,
      options: { id, title: subject.title },
    });
  } catch (error) {
    calc = failedRecord(
      def,
      id,
      subject.title,
      error instanceof Error ? error.message : String(error),
    );
  }
  const record = wrap(def, subject, { ...calc, id, title: subject.title }, refs);
  if (missing.length > 0) {
    // Name the missing inputs as the check gathered them, with what would give each one.
    record.status = 'unknown';
    record.result = null;
    record.missing = Object.values(inputs)
      .filter((i) => i.value === undefined && !i.optional)
      .map((i) => i.name);
    record.note = `Missing: ${missing.join('; ')}`;
    delete record.margin;
  } else if (factor.problem !== undefined) {
    record.status = 'unknown';
    delete record.limit;
    delete record.limitKind;
    delete record.margin;
    record.note = `Not compared: ${factor.problem}`;
  } else if (
    (record.margin !== undefined && !Number.isFinite(record.margin)) ||
    (record.result !== null && !Number.isFinite(record.result))
  ) {
    // A non-finite number must never read as plenty of room.
    record.status = 'unknown';
    delete record.margin;
    if (record.result !== null && !Number.isFinite(record.result)) record.result = null;
    record.note = 'The inputs give no finite margin';
  }
  cache.put(key, record);
  return record;
}

/**
 * Run every check of `registry` on the model: one record per subject, in check order then
 * subject order, each with its line, and a `mech-check` warning for every record below the
 * user's factor or not computed. A record with no factor to compare with gives no warning.
 */
export function runChecks(
  model: CheckModel,
  registry: CheckRegistry,
  cache: RecordCache,
  implementation: number,
): CheckRun {
  const entries: CheckEntry[] = [];
  const warnings: DomainEvaluationWarning[] = [];
  for (const def of registry.list()) {
    let subjects: readonly CheckSubject[];
    try {
      subjects = def.subjects(model);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      const record = wrap(
        def,
        { location: 'all', title: def.title, subject: [], inputs: {} },
        failedRecord(def, recordId(def.id, 'all'), def.title, why),
        {},
      );
      subjects = [];
      entries.push({ record, text: recordText(record, false) });
    }
    for (const subject of subjects) {
      const record = runSubject(model, def, subject, cache, implementation);
      entries.push({
        record,
        ...(def.factor === undefined ? {} : { factor: def.factor }),
        text: recordText(record, def.factor !== undefined),
      });
    }
  }
  for (const { record, text } of entries) {
    if (record.status === 'ok') continue;
    warnings.push({
      code: 'mech-check',
      message: text,
      check: record.check,
      recordId: record.id,
      status: record.status,
    });
  }
  cache.retain();
  return { entries, warnings };
}
