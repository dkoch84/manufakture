// Domain data in the bundle (ADR 0013 decision 3: `domains.<namespace>` is opaque to core). Each
// domain package that owns a namespace exports a summariser (`woodDataSummariser`,
// `stockDataSummariser` in domain-wood, `constructionDataSummariser` in domain-construction);
// a namespace without one gets a generic list of the fields that changed.

import type { DomainData, ManufaktureDocument } from '@manufakture/core';
import { constructionDataSummariser } from '@manufakture/domain-construction';
import { stockDataSummariser, woodDataSummariser } from '@manufakture/domain-wood';
import { bounded, fieldChanges, shown } from './text';
import { LIMITS, type DomainDiff } from './types';

/**
 * The hook a domain package implements: lines for a reviewer on how `domains.<namespace>`
 * changed from `before` to `after` (undefined when absent). It must not throw; one that does is
 * replaced by the generic lines.
 */
export interface DomainSummariser {
  readonly namespace: string;
  summarise(before: DomainData | undefined, after: DomainData | undefined): readonly string[];
}

/** The summarisers of the domain packages in this repository. */
export const DEFAULT_SUMMARISERS: readonly DomainSummariser[] = [
  woodDataSummariser,
  stockDataSummariser,
  constructionDataSummariser,
];

export function summariserMap(
  list: readonly DomainSummariser[] = DEFAULT_SUMMARISERS,
): ReadonlyMap<string, DomainSummariser> {
  return new Map(list.map((s) => [s.namespace, s]));
}

function generic(before: DomainData | undefined, after: DomainData | undefined): string[] {
  const lines: string[] = [];
  if (before?.schemaVersion !== after?.schemaVersion) {
    lines.push(
      `schema version ${before?.schemaVersion ?? 'none'} to ${after?.schemaVersion ?? 'none'}`,
    );
  }
  // An absent side compares as an empty object, so a new namespace lists its fields.
  const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const a = before?.data ?? (isObject(after?.data) ? {} : undefined);
  const b = after?.data ?? (isObject(before?.data) ? {} : undefined);
  for (const c of fieldChanges(a, b, { max: LIMITS.domainLines })) {
    lines.push(`${c.path}: ${c.before} to ${c.after}`);
  }
  return lines;
}

/** The lines for one namespace's change, from its summariser or the generic diff. */
export function domainLines(
  namespace: string,
  before: DomainData | undefined,
  after: DomainData | undefined,
  summarisers: ReadonlyMap<string, DomainSummariser>,
): string[] {
  const s = summarisers.get(namespace);
  let lines: readonly string[] | null = null;
  if (s !== undefined) {
    try {
      const r = s.summarise(before, after);
      if (Array.isArray(r) && r.every((l) => typeof l === 'string')) lines = r;
    } catch {
      lines = null;
    }
  }
  return (lines ?? generic(before, after)).map((l) => shown(l));
}

/** Every namespace whose data differs between the two documents. */
export function domainDiffs(
  base: ManufaktureDocument,
  head: ManufaktureDocument,
  summarisers: ReadonlyMap<string, DomainSummariser>,
): DomainDiff[] {
  const a = base.domains ?? {};
  const b = head.domains ?? {};
  const out: DomainDiff[] = [];
  for (const ns of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = Object.hasOwn(a, ns) ? a[ns] : undefined;
    const y = Object.hasOwn(b, ns) ? b[ns] : undefined;
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const lines = bounded(domainLines(ns, x, y, summarisers), LIMITS.domainLines);
    out.push({
      namespace: shown(ns, 64),
      change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed',
      lines: lines.items,
      omitted: lines.omitted,
    });
  }
  return out;
}
