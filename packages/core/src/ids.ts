/**
 * Id rules (ADR 0004, decision 4).
 *
 * - Feature ids are `kind#n` (`extrude#1`), counted per kind.
 * - Sketch entity ids are `e<n>`, sketch constraint ids `k<n>` and reference ids `r<n>`, counted
 *   per prefix across the whole part.
 * - A sketch split names its pieces `<id>#a`, `<id>#b`, ... in order along the original entity;
 *   the pieces of a piece are `<id>#a#a` and so on. Split ids carry no counter of their own.
 * - The part's `nextIds` holds the next number per counter. It only ever increases, so an id is
 *   never handed out twice, including after the item is deleted.
 */

/** Counter prefixes of ids that live inside features. */
export const ENTITY_PREFIX = 'e';
export const CONSTRAINT_PREFIX = 'k';
export const REFERENCE_PREFIX = 'r';

export type SubIdPrefix = typeof ENTITY_PREFIX | typeof CONSTRAINT_PREFIX | typeof REFERENCE_PREFIX;

export const FEATURE_ID_PATTERN = /^([a-z][a-zA-Z0-9]*)#([1-9][0-9]*)$/;
const SUB_ID_PATTERN = /^([ekr])([1-9][0-9]*)((?:#[a-z]+)*)$/;

export interface ParsedId {
  /** The `nextIds` key: the feature kind, or the sub-id prefix. */
  readonly counter: string;
  /** The allocated number. */
  readonly n: number;
  /** The split suffix (`#a#b`), empty for an id straight from the counter. */
  readonly split: string;
}

export function parseFeatureId(id: string): ParsedId | undefined {
  const m = FEATURE_ID_PATTERN.exec(id);
  if (!m) return undefined;
  return { counter: m[1]!, n: Number(m[2]), split: '' };
}

export function parseSubId(id: string): ParsedId | undefined {
  const m = SUB_ID_PATTERN.exec(id);
  if (!m) return undefined;
  return { counter: m[1]!, n: Number(m[2]), split: m[3]! };
}

/** Parses either kind of id. Feature ids are tried first; the two patterns never overlap. */
export function parseAnyId(id: string): ParsedId | undefined {
  return parseFeatureId(id) ?? parseSubId(id);
}

/** Whether `id` is a sub-id with the given prefix (split pieces included). */
export function isSubId(id: string, prefix: SubIdPrefix): boolean {
  return parseSubId(id)?.counter === prefix;
}

/** The next number `counter` will hand out. Counters start at 1. */
export function peekCounter(nextIds: Readonly<Record<string, number>>, counter: string): number {
  return nextIds[counter] ?? 1;
}

/**
 * The next `count` ids for `counter` without allocating them. A command that adds items with
 * these ids allocates them when it is applied. `counter` is a feature kind (giving `kind#n`) or
 * a sub-id prefix (giving `e7`).
 */
export function previewIds(
  nextIds: Readonly<Record<string, number>>,
  counter: string,
  count = 1,
): string[] {
  const start = peekCounter(nextIds, counter);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(counter.length === 1 ? `${counter}${start + i}` : `${counter}#${start + i}`);
  }
  return out;
}

/** Names of the pieces a sketch split makes from `id`: `id#a`, `id#b`, ... */
export function splitIds(id: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`${id}#${letters(i)}`);
  return out;
}

/** 0 -> a, 25 -> z, 26 -> aa: bijective base 26, so split names never run out. */
function letters(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
