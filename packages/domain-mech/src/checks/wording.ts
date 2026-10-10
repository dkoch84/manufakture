// How a record reads for people (ADR 0017 decision 6): numbers and margins only. A factor reads
// against the user's own ("factor 2.28, above your 2"), or with nothing to compare when they set
// none; a result with a limit states its margin. Nothing here calls a design safe, certified,
// compliant, passing, failing or OK, and the internal status `ok` is never shown as a word.

import { factorText } from '../settings';
import type { MechRecord } from './types';

const PREFIXES: readonly [number, string][] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
];

/** Units that take an SI prefix in the working (`4.50 kN`, `182 MPa`). */
const PREFIXED = new Set(['N', 'Pa', 'W', 'J', 'V', 'A', 'Ω', 'H', 'Hz', 'N·m', 'C']);

/** A value in SI for people: about three significant figures, a prefix where the unit takes one. */
export function formatSI(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`.trim();
  const u = unit === '1' ? '' : unit;
  let v = value;
  let prefix = '';
  if (PREFIXED.has(u) && value !== 0) {
    const abs = Math.abs(value);
    const found = PREFIXES.find(([f]) => abs >= f * 0.9995) ?? PREFIXES.at(-1)!;
    v = value / found[0];
    prefix = found[1];
  }
  const a = Math.abs(v);
  const text =
    a >= 100
      ? v.toFixed(0)
      : a >= 10
        ? v.toFixed(1)
        : a >= 1 || a === 0
          ? v.toFixed(2)
          : String(Number(v.toPrecision(3)));
  return `${text} ${prefix}${u}`.trim();
}

/** The inputs that were given, as "load 890 N, rated load 4.50 kN" (the factor left out). */
export function inputsText(record: MechRecord): string {
  return record.inputs
    .filter((i) => i.symbol !== 'n_req' && i.value !== null)
    .map((i) => `${i.name.toLowerCase()} ${formatSI(i.value!, i.unit)}`)
    .join(', ');
}

/**
 * The comparison: for a factor record (`factor`: the check compares with one of the user's
 * factors) the factor against theirs, or with nothing to compare; otherwise the result against
 * its limit, with the margin.
 */
export function comparisonText(record: MechRecord, factor: boolean): string {
  if (record.result === null) return 'not computed';
  if (factor) {
    // A factor that could not be compared (the user's factor does not evaluate, a limit of zero)
    // says so, and the record's note says why.
    if (record.status === 'unknown') return `factor ${record.result.toFixed(2)}; not compared`;
    return factorText(record.result, record.limit);
  }
  const r = formatSI(record.result, record.unit);
  if (record.limit === undefined) return r;
  const side = record.limitKind === 'at-most' ? 'at most' : 'at least';
  const lim = formatSI(record.limit, record.unit);
  if (record.margin === undefined) return `${r}; your limit ${side} ${lim}`;
  return `${r}, your limit ${side} ${lim} (margin ${(record.margin * 100).toFixed(1)} %)`;
}

/**
 * One line for a record: "Cable tension, Rope in Rep: load 890 N, rated load 4.50 kN; factor
 * 5.06, above your 2". An `unknown` record names what is missing, or why it was not computed.
 */
export function recordText(record: MechRecord, factor: boolean): string {
  if (record.result === null) {
    return `${record.title}: not computed. ${record.note ?? ''}`.trim();
  }
  const given = inputsText(record);
  const head = given.length > 0 ? `${record.title}: ${given}; ` : `${record.title}: `;
  const tail = record.status === 'unknown' && record.note !== undefined ? `. ${record.note}` : '';
  return `${head}${comparisonText(record, factor)}${tail}`;
}

/**
 * A record's status in a few words, for a list: never the internal `ok`. "above your factor",
 * "below your factor", "not compared: no factor set", "not computed".
 */
export function statusLabel(record: MechRecord, factor: boolean): string {
  if (record.result === null) return 'not computed';
  if (record.status === 'unknown') return 'not compared';
  if (factor) {
    if (record.status === 'warning') return 'below your factor';
    if (record.limit === undefined) return 'not compared: no factor set';
    return record.result === record.limit ? 'at your factor' : 'above your factor';
  }
  if (record.status === 'warning') return 'outside your limit';
  return record.limit === undefined ? 'nothing to compare with' : 'within your limit';
}
