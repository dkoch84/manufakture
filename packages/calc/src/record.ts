// The calc record (M9 plan, decision 4) and the builder every formula in this package uses.
//
// A record states one result with its working: the method, the formula, every input with where it
// came from, the assumptions and the published sources. Where the caller gives a limit (a safety
// factor they chose, an allowed deflection, a maximum temperature) the record compares the result
// with it and states the margin. A record never says a design is safe, passes or fails: the status
// is 'ok' (computed and, where a limit was given, on the right side of it), 'warning' (on the wrong
// side of the caller's limit) or 'unknown' (an input is missing or out of the method's range).

/** A published source a formula comes from. */
export interface CalcSource {
  /** Short citation, e.g. "Shigley's Mechanical Engineering Design, 10th ed." */
  title: string;
  /** Where in it: equation, table or section. */
  locator: string;
}

export type CalcStatus = 'ok' | 'warning' | 'unknown';

/** Which side of the limit the result must be on. */
export type LimitKind = 'at-least' | 'at-most';

/** One input of a record: its value in SI units and where it came from. */
export interface CalcInput {
  name: string;
  symbol: string;
  /** SI value; null when the input was not given. */
  value: number | null;
  unit: string;
  /** Where the value came from: a requirement, a catalog field, a material property, a default. */
  source: string;
}

/** A value derived on the way to the result, shown in the working. */
export interface CalcValue {
  name: string;
  symbol: string;
  value: number;
  unit: string;
}

export interface CalcRecord {
  id: string;
  title: string;
  method: string;
  formula: string;
  inputs: CalcInput[];
  /** SI value; null when the status is 'unknown'. */
  result: number | null;
  unit: string;
  /** Intermediate values, in the order they were computed. */
  derived: CalcValue[];
  /** The caller's limit the result is compared with, when one was given. */
  limit?: number;
  limitKind?: LimitKind;
  /**
   * Room left against the limit as a fraction of it: (result - limit) / limit for an 'at-least'
   * limit, (limit - result) / limit for an 'at-most' one. Negative means the limit is not met.
   */
  margin?: number;
  assumptions: string[];
  sources: CalcSource[];
  status: CalcStatus;
  /** Names of the inputs that were missing, when the status is 'unknown' for that reason. */
  missing?: string[];
  /** Why the status is 'unknown' when it is not a missing input (out of range, invalid). */
  note?: string;
}

/** A value handed to a formula with a description of where it came from. */
export interface Given {
  value: number | undefined;
  source: string;
}

/** What a formula parameter accepts: a bare number (source "given"), a Given, or nothing. */
export type Param = number | Given | undefined;

/** Optional id and title overrides, so a check can name the location ("shaft at bearing A"). */
export interface RecordOptions {
  id?: string;
  title?: string;
}

/** Wraps a number with its source. */
export function given(value: number | undefined, source: string): Given {
  return { value, source };
}

/** Uses another record's result as an input, citing the record. */
export function fromRecord(record: CalcRecord): Given {
  return { value: record.result ?? undefined, source: `calc record ${record.id}` };
}

/** Uses one of another record's derived values as an input, citing the record. */
export function fromDerived(record: CalcRecord, symbol: string): Given {
  const value = record.derived.find((d) => d.symbol === symbol)?.value;
  return { value, source: `calc record ${record.id}, ${symbol}` };
}

/** Reads a derived value by symbol. */
export function derivedValue(record: CalcRecord, symbol: string): number | undefined {
  return record.derived.find((d) => d.symbol === symbol)?.value;
}

/** Margin of a result against a limit, positive when the limit is met. */
export function marginOf(result: number, limit: number, kind: LimitKind): number {
  return kind === 'at-least' ? (result - limit) / limit : (limit - result) / limit;
}

/** Thrown inside a compute function when the inputs are outside the method's range. */
export class OutOfRange extends Error {}

export interface InputSpec {
  name: string;
  symbol: string;
  unit: string;
  /** Used when the parameter is not given; the note becomes the input's source. */
  default?: { value: number; note: string };
}

export interface ComputeOutput {
  result: number;
  derived?: CalcValue[];
  assumptions?: string[];
}

export interface CalcDefinition<R extends string, O extends string> {
  id: string;
  title: string;
  method: string;
  formula: string;
  unit: string;
  sources: CalcSource[];
  assumptions?: string[];
  /** Inputs the result needs (an input with a default is never missing). */
  inputs: Record<R, InputSpec>;
  /** Inputs the result does not need (limits, refinements). */
  optional?: Record<O, InputSpec>;
  /** An input the result is compared with. */
  limit?: { input: NoInfer<R | O>; kind: LimitKind };
}

function read(param: Param): { value: number | undefined; source: string } {
  if (param === undefined) return { value: undefined, source: 'not given' };
  if (typeof param === 'number') return { value: param, source: 'given' };
  return { value: param.value, source: param.source };
}

/**
 * Builds a record: reads every parameter, reports missing required ones as 'unknown', runs the
 * computation, and compares the result with the limit input when one was given.
 */
export function calc<R extends string, O extends string = never>(
  def: CalcDefinition<R, O>,
  params: Partial<Record<NoInfer<R | O>, Param>>,
  options: RecordOptions | undefined,
  compute: (v: Record<R, number> & Partial<Record<O, number>>) => ComputeOutput,
): CalcRecord {
  const inputs: CalcInput[] = [];
  const missing: string[] = [];
  const values: Record<string, number> = {};
  const specs: [string, InputSpec, boolean][] = [
    ...Object.entries<InputSpec>(def.inputs).map(([k, s]): [string, InputSpec, boolean] => [
      k,
      s,
      true,
    ]),
    ...Object.entries<InputSpec>(def.optional ?? ({} as Record<O, InputSpec>)).map(
      ([k, s]): [string, InputSpec, boolean] => [k, s, false],
    ),
  ];
  for (const [key, spec, required] of specs) {
    let { value, source } = read((params as Record<string, Param>)[key]);
    if (value !== undefined && !Number.isFinite(value)) {
      value = undefined;
      source = `${source} (not a finite number)`;
    }
    if (value === undefined && spec.default) {
      value = spec.default.value;
      source = `default: ${spec.default.note}`;
    }
    if (value === undefined) {
      if (required) missing.push(spec.name);
      if (!required) continue;
    } else {
      values[key] = value;
    }
    inputs.push({
      name: spec.name,
      symbol: spec.symbol,
      value: value ?? null,
      unit: spec.unit,
      source,
    });
  }
  const base = {
    id: options?.id ?? def.id,
    title: options?.title ?? def.title,
    method: def.method,
    formula: def.formula,
    inputs,
    unit: def.unit,
    sources: def.sources,
  };
  if (missing.length > 0) {
    return {
      ...base,
      result: null,
      derived: [],
      assumptions: [...(def.assumptions ?? [])],
      status: 'unknown',
      missing,
      note: `Missing: ${missing.join(', ')}`,
    };
  }
  let out: ComputeOutput;
  try {
    out = compute(values as Record<R, number> & Partial<Record<O, number>>);
  } catch (error) {
    if (!(error instanceof OutOfRange)) throw error;
    return {
      ...base,
      result: null,
      derived: [],
      assumptions: [...(def.assumptions ?? [])],
      status: 'unknown',
      note: error.message,
    };
  }
  if (!Number.isFinite(out.result)) {
    return {
      ...base,
      result: null,
      derived: out.derived ?? [],
      assumptions: [...(def.assumptions ?? []), ...(out.assumptions ?? [])],
      status: 'unknown',
      note: 'The inputs give no finite result',
    };
  }
  const record: CalcRecord = {
    ...base,
    result: out.result,
    derived: out.derived ?? [],
    assumptions: [...(def.assumptions ?? []), ...(out.assumptions ?? [])],
    status: 'ok',
  };
  if (def.limit) {
    const limit = values[def.limit.input];
    if (limit !== undefined) {
      record.limit = limit;
      record.limitKind = def.limit.kind;
      record.margin = marginOf(out.result, limit, def.limit.kind);
      if (record.margin < 0) record.status = 'warning';
    }
  }
  return record;
}

/** Shorthand for a derived value. */
export function value(name: string, symbol: string, v: number, unit: string): CalcValue {
  return { name, symbol, value: v, unit };
}

/** Throws OutOfRange unless the condition holds. */
export function requireRange(condition: boolean, message: string): void {
  if (!condition) throw new OutOfRange(message);
}
