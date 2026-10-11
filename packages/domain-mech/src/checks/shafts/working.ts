// How the shaft checks write their records: every symbol an input may have (its name and SI unit,
// for the working), and one record composed from the steps of `@manufakture/calc` a check chains
// (the moment at the section, the stress-concentration factors, the stress, the factor), so the
// working shows every step and every source. A step that cannot be computed makes the record
// `unknown`, saying which step and why.

import type { CalcInput, CalcRecord, CalcSource, CalcValue, Given } from '@manufakture/calc';
import { OPTIONAL } from './model';

/** The name and SI unit of every input symbol the shaft checks gather. */
export const SYMBOLS: Readonly<Record<string, { name: string; symbol: string; unit: string }>> = {
  F: { name: 'Transverse load on the shaft', symbol: 'F', unit: 'N' },
  T: { name: 'Torque through the shaft', symbol: 'T', unit: 'N·m' },
  L: { name: 'Span between the bearings', symbol: 'L', unit: 'm' },
  a: { name: 'Load distance from the first bearing', symbol: 'a', unit: 'm' },
  x: { name: 'Section distance from the first bearing', symbol: 'x', unit: 'm' },
  d: { name: 'Shaft diameter', symbol: 'd', unit: 'm' },
  D: { name: 'Larger diameter beside the section', symbol: 'D', unit: 'm' },
  r: { name: 'Fillet or root radius', symbol: 'r', unit: 'm' },
  d_i: { name: 'Bore diameter (hollow shaft)', symbol: 'd_i', unit: 'm' },
  Sy: { name: 'Yield strength', symbol: 'S_y', unit: 'Pa' },
  Sut: { name: 'Ultimate tensile strength', symbol: 'S_ut', unit: 'Pa' },
  E: { name: "Young's modulus", symbol: 'E', unit: 'Pa' },
  nu: { name: "Poisson's ratio", symbol: 'ν', unit: '1' },
  rho: { name: 'Density', symbol: 'ρ', unit: 'kg/m^3' },
  M: { name: 'Bending moment at the section', symbol: 'M', unit: 'N·m' },
  Ma: { name: 'Alternating bending moment', symbol: 'M_a', unit: 'N·m' },
  Mm: { name: 'Mean bending moment', symbol: 'M_m', unit: 'N·m' },
  Ta: { name: 'Alternating torque', symbol: 'T_a', unit: 'N·m' },
  Tm: { name: 'Mean torque', symbol: 'T_m', unit: 'N·m' },
  Kf: { name: 'Fatigue stress-concentration factor, bending', symbol: 'K_f', unit: '1' },
  Kfs: { name: 'Fatigue stress-concentration factor, torsion', symbol: 'K_fs', unit: '1' },
  Se: { name: 'Endurance limit at the section', symbol: 'S_e', unit: 'Pa' },
  R: { name: 'Reliability', symbol: 'R', unit: '1' },
  y_max: { name: 'Your allowed deflection', symbol: 'y_allow', unit: 'm' },
  theta_max: { name: 'Your allowed slope', symbol: 'θ_allow', unit: 'rad' },
  m: { name: 'Mass carried on the shaft', symbol: 'm', unit: 'kg' },
  omega: { name: 'Highest operating speed', symbol: 'ω', unit: 'rad/s' },
  w: { name: 'Key width', symbol: 'w', unit: 'm' },
  h: { name: 'Key height', symbol: 'h', unit: 'm' },
  l_key: { name: 'Key length', symbol: 'l', unit: 'm' },
  Sy_key: { name: 'Yield strength of the key', symbol: 'S_y,key', unit: 'Pa' },
  delta: { name: 'Diametral interference', symbol: 'δ', unit: 'm' },
  D_hub: { name: 'Hub outside diameter', symbol: 'd_o', unit: 'm' },
  l_hub: { name: 'Fit length', symbol: 'l', unit: 'm' },
  f: { name: 'Friction coefficient', symbol: 'f', unit: '1' },
  E_hub: { name: "Young's modulus of the hub", symbol: 'E_o', unit: 'Pa' },
  nu_hub: { name: "Poisson's ratio of the hub", symbol: 'ν_o', unit: '1' },
  Sy_hub: { name: 'Yield strength of the hub', symbol: 'S_y,hub', unit: 'Pa' },
};

export type Inputs = Readonly<Record<string, Given>>;

/** A gathered input's value, or undefined. */
export function val(inputs: Inputs, symbol: string): number | undefined {
  return Object.hasOwn(inputs, symbol) ? inputs[symbol]!.value : undefined;
}

/** A gathered input as a calc parameter: its value and source. */
export function given(inputs: Inputs, symbol: string): Given | undefined {
  return Object.hasOwn(inputs, symbol) ? inputs[symbol] : undefined;
}

/** A computed value handed to the next step, with the step it came from. */
export function computed(value: number | undefined, source: string): Given {
  return { value, source };
}

/** The gathered inputs, in the order given, as the record's inputs. */
export function inputList(inputs: Inputs, order: readonly string[]): CalcInput[] {
  const out: CalcInput[] = [];
  for (const s of order) {
    if (!Object.hasOwn(inputs, s)) continue;
    const sym = SYMBOLS[s] ?? { name: s, symbol: s, unit: '' };
    const g = inputs[s]!;
    // An optional input that was not given is not part of the working.
    if (g.value === undefined && g.source.startsWith(OPTIONAL)) continue;
    out.push({
      name: sym.name,
      symbol: sym.symbol,
      value: g.value ?? null,
      unit: sym.unit,
      source: g.source,
    });
  }
  return out;
}

function unique<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface Composition {
  /** The step whose result is the record's (the factor, the deflection). */
  main: CalcRecord;
  /** The steps before it, in order. */
  steps: readonly CalcRecord[];
  method: string;
  formula: string;
  /** The record's inputs: the comparison's first, then what was gathered. */
  inputs: CalcInput[];
  /** Values derived by the check itself (the moment from statics), before the steps' own. */
  derived?: CalcValue[];
  assumptions?: string[];
  sources?: CalcSource[];
}

/**
 * One record from a chain of calc steps. The main step gives the result, limit, margin and status;
 * every step adds its derived values, assumptions and sources. A step with no result makes the
 * record `unknown` with that step's reason.
 */
export function compose(c: Composition): CalcRecord {
  const all = [...c.steps, c.main];
  const derived = unique(
    [
      ...(c.derived ?? []),
      ...all.flatMap((s) => [
        ...s.derived,
        ...(s === c.main || s.result === null
          ? []
          : [{ name: s.title, symbol: s.id, value: s.result, unit: s.unit }]),
      ]),
    ],
    (v) => v.symbol,
  );
  const record: CalcRecord = {
    id: c.main.id,
    title: c.main.title,
    method: c.method,
    formula: c.formula,
    inputs: c.inputs,
    result: c.main.result,
    unit: c.main.unit,
    derived,
    assumptions: unique([...all.flatMap((s) => s.assumptions), ...(c.assumptions ?? [])], (a) => a),
    sources: unique(
      [...all.flatMap((s) => s.sources), ...(c.sources ?? [])],
      (s) => s.title + s.locator,
    ),
    status: c.main.status,
  };
  if (c.main.limit !== undefined) record.limit = c.main.limit;
  if (c.main.limitKind !== undefined) record.limitKind = c.main.limitKind;
  if (c.main.margin !== undefined) record.margin = c.main.margin;
  if (c.main.note !== undefined) record.note = c.main.note;
  const stuck = all.find((s) => s.result === null);
  if (stuck !== undefined) {
    record.result = null;
    record.status = 'unknown';
    delete record.margin;
    record.note = `${stuck.title}: ${stuck.note ?? 'not computed'}`;
    if (stuck.missing !== undefined) record.missing = stuck.missing;
  }
  return record;
}

/** A record that could not start: the check's own reason (an input it needs is missing). */
export function notComputed(
  base: Pick<CalcRecord, 'id' | 'title' | 'unit'>,
  method: string,
  formula: string,
  inputs: CalcInput[],
  note: string,
  missing?: string[],
): CalcRecord {
  return {
    ...base,
    method,
    formula,
    inputs,
    result: null,
    derived: [],
    assumptions: [],
    sources: [],
    status: 'unknown',
    note,
    ...(missing !== undefined ? { missing } : {}),
  };
}
