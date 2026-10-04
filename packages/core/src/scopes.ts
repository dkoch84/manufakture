import { parseAnyId } from './ids';
import type { ManufaktureDocument } from './schema';

/**
 * Counter scopes (ADR 0009 decision 5): every `nextIds` object in a document, each the
 * namespace of the ids its counters hand out. The same id can exist in several scopes
 * (`extrude#1` in two parts, `r1` in a part and in CAM), so sync keys everything by scope.
 *
 * A scope key is a string:
 *
 * | Key                      | `nextIds`       | Counters                                                     |
 * | ------------------------ | --------------- | ------------------------------------------------------------ |
 * | `document`               | the document's  | `part`, `assembly`, `cp`, `cfg`, `font`, `drawing`, `script` |
 * | `part:<part id>`         | each part's     | one per feature kind, `e`, `k`, `r`                          |
 * | `assembly:<assembly id>` | each assembly's | `inst`, `mate`, `mc`, `r`, `explode`, `step`                 |
 * | `cam`                    | `cam.nextIds`   | `tool`, `setup`, one per operation kind, `r`                 |
 * | `print`                  | `print.nextIds` | `print`, `item`, `r`                                         |
 * | `drawing:<drawing id>`   | each drawing's  | `sheet`, `view`, `dim`, `note`                               |
 *
 * A counter added to an existing `nextIds` (as `script` was to the document's) needs nothing
 * here. A new `nextIds` object is one entry in `COUNTER_SCOPES`.
 */
export type ScopeKey = string;

/** A snapshot of counters: scope key to counter to the next number. Plain JSON. */
export type CounterTable = Readonly<Record<ScopeKey, Readonly<Record<string, number>>>>;

export const DOCUMENT_SCOPE = 'document';
export const CAM_SCOPE = 'cam';
export const PRINT_SCOPE = 'print';

export function partScope(partId: string): ScopeKey {
  return `part:${partId}`;
}
export function assemblyScope(assemblyId: string): ScopeKey {
  return `assembly:${assemblyId}`;
}
export function drawingScope(drawingId: string): ScopeKey {
  return `drawing:${drawingId}`;
}

/** One kind of `nextIds` object: where it lives in a document. */
export interface CounterScopeKind {
  /** The scope key's prefix (`part`), or the whole key for a singleton (`cam`). */
  readonly name: string;
  /** Every scope of this kind in `doc`, with its counters. */
  readonly list: (
    doc: ManufaktureDocument,
  ) => readonly (readonly [ScopeKey, Readonly<Record<string, number>>])[];
}

/** Every kind of counter scope in a document, as far as they have landed. */
export const COUNTER_SCOPES: readonly CounterScopeKind[] = [
  { name: DOCUMENT_SCOPE, list: (doc) => [[DOCUMENT_SCOPE, doc.nextIds]] },
  { name: 'part', list: (doc) => doc.parts.map((p) => [partScope(p.id), p.nextIds] as const) },
  {
    name: 'assembly',
    list: (doc) => doc.assemblies.map((a) => [assemblyScope(a.id), a.nextIds] as const),
  },
  { name: CAM_SCOPE, list: (doc) => [[CAM_SCOPE, doc.cam.nextIds]] },
  { name: PRINT_SCOPE, list: (doc) => [[PRINT_SCOPE, doc.print.nextIds]] },
  {
    name: 'drawing',
    list: (doc) => (doc.drawings ?? []).map((d) => [drawingScope(d.id), d.nextIds] as const),
  },
];

/** Every counter of every scope in `doc`. A scope with no counters yet is present and empty. */
export function documentCounters(doc: ManufaktureDocument): CounterTable {
  const out: Record<ScopeKey, Record<string, number>> = {};
  for (const kind of COUNTER_SCOPES) {
    for (const [key, nextIds] of kind.list(doc)) out[key] = { ...nextIds };
  }
  return out;
}

/** The next number `counter` hands out in a scope's counters; counters start at 1. */
export function nextNumber(
  counters: Readonly<Record<string, number>> | undefined,
  counter: string,
): number {
  const n = counters !== undefined && Object.hasOwn(counters, counter) ? counters[counter] : 1;
  return n ?? 1;
}

/**
 * Each counter at the higher of its values in `a` and `b`, scopes of both kept: a high-water
 * mark. A server keeps one per document branch across every head it accepted, so a scope that
 * was deleted (a part) still has its counters when it comes back.
 */
export function maxCounters(a: CounterTable, b: CounterTable): CounterTable {
  const out: Record<ScopeKey, Record<string, number>> = {};
  for (const table of [a, b]) {
    for (const [scope, counters] of Object.entries(table)) {
      const into = (out[scope] ??= {});
      for (const [counter, n] of Object.entries(counters)) {
        into[counter] = Math.max(nextNumber(into, counter), n);
      }
    }
  }
  return out;
}

/** A counter that went backwards. */
export interface CounterRegression {
  readonly scope: ScopeKey;
  readonly counter: string;
  /** The value it had (or its high-water mark). */
  readonly before: number;
  /** The lower value it has now. */
  readonly after: number;
}

/**
 * Every counter of `after` below its value in `before`, for scopes present in both (an absent
 * counter is 1). Counters only grow (ADR 0004 decision 4), so a server refuses an entry whose
 * head regresses against its high-water mark (ADR 0009 amendment, item 3): pass the high-water
 * mark (`maxCounters` over every accepted head) as `before`, so a deleted part that comes back
 * with lower counters is caught too. Scopes only in `before` are deleted ones and are skipped.
 */
export function counterRegressions(before: CounterTable, after: CounterTable): CounterRegression[] {
  const out: CounterRegression[] = [];
  for (const scope of Object.keys(before).sort()) {
    if (!Object.hasOwn(after, scope)) continue;
    const was = before[scope]!;
    const now = after[scope]!;
    for (const counter of Object.keys(was).sort()) {
      const b = was[counter]!;
      const a = nextNumber(now, counter);
      if (a < b) out.push({ scope, counter, before: b, after: a });
    }
  }
  return out;
}

/** The counter an id is counted by and its number: `extrude#4` gives `extrude`, 4; `e7` gives `e`, 7. */
export function idCounter(id: string): { counter: string; n: number; split: string } | undefined {
  const p = parseAnyId(id);
  return p === undefined ? undefined : { counter: p.counter, n: p.n, split: p.split };
}

/** The id `n` of `counter` gives: one-letter counters are sub-ids (`e7`), others `kind#n`. */
export function idText(counter: string, n: number): string {
  return counter.length === 1 ? `${counter}${n}` : `${counter}#${n}`;
}
