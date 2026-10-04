// Counter scopes (ADR 0009 decision 5) as they exist in core today, and the ids a command
// allocates in each, found by diffing the counters before and after the command.
//
// A scope key names the `nextIds` object a counter lives in:
//   doc                     document nextIds: part, assembly, cp, cfg, font, drawing
//   part:<part id>          a part's nextIds: one per feature kind, e, k, r
//   asm:<assembly id>       an assembly's nextIds: inst, mate, mc, r, explode, step
//   cam                     cam.nextIds: tool, setup, one per operation kind, r
//   print                   print.nextIds: print, item, r
//   drawing:<drawing id>    a drawing's nextIds: sheet, view, dimension, note counters

import type { ManufaktureDocument } from '@manufakture/core';

export type ScopeKey = string;

/** `scope|counter` to the next number. */
export type Counters = Map<string, number>;

export function counterKey(scope: ScopeKey, counter: string): string {
  return `${scope}|${counter}`;
}

export function splitCounterKey(key: string): [ScopeKey, string] {
  const i = key.lastIndexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** The empty counter name marks that a scope exists, even with no counters yet. */
const EXISTS = '';

function add(out: Counters, scope: ScopeKey, nextIds: Readonly<Record<string, number>>): void {
  out.set(counterKey(scope, EXISTS), 0);
  for (const [c, n] of Object.entries(nextIds)) out.set(counterKey(scope, c), n);
}

export function counters(doc: ManufaktureDocument): Counters {
  const out: Counters = new Map();
  add(out, 'doc', doc.nextIds);
  for (const p of doc.parts) add(out, `part:${p.id}`, p.nextIds);
  for (const a of doc.assemblies) add(out, `asm:${a.id}`, a.nextIds);
  add(out, 'cam', doc.cam.nextIds);
  add(out, 'print', doc.print.nextIds);
  for (const d of doc.drawings ?? []) add(out, `drawing:${d.id}`, d.nextIds);
  return out;
}

/** The text of id `n` of `counter`: one-letter counters are sub-ids (`e7`), others `kind#n`. */
export function idText(counter: string, n: number): string {
  return counter.length === 1 ? `${counter}${n}` : `${counter}#${n}`;
}

export interface FreshRange {
  scope: ScopeKey;
  counter: string;
  /** First number allocated. */
  start: number;
  /** One past the last. */
  end: number;
}

/**
 * The ids a command allocated, as counter ranges: every counter that moved forward in a scope
 * that existed before the command. A scope the command creates starts empty (addPart) or with
 * copied counters (duplicatePart), which allocate nothing.
 */
export function freshRanges(before: Counters, after: Counters): FreshRange[] {
  const out: FreshRange[] = [];
  for (const [key, n] of after) {
    const [scope, counter] = splitCounterKey(key);
    if (counter === EXISTS || !before.has(counterKey(scope, EXISTS))) continue;
    const was = before.get(key) ?? 1;
    if (n > was) {
      out.push({ scope, counter, start: was, end: n });
    }
  }
  return out;
}

/** Counters that went backwards between two documents, for scopes present in both. */
export function regressions(before: Counters, after: Counters): string[] {
  const out: string[] = [];
  for (const [key, n] of before) {
    const [scope, counter] = splitCounterKey(key);
    if (counter === EXISTS || !after.has(counterKey(scope, EXISTS))) continue;
    const m = after.get(key) ?? 1;
    if (m < n) out.push(`${key}: ${n} -> ${m}`);
  }
  return out;
}
