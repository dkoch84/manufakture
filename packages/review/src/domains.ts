// Domain data in the bundle (ADR 0013 decision 3: `domains.<namespace>` is opaque to core). Each
// domain package that owns a namespace exports a summariser (`woodDataSummariser`,
// `stockDataSummariser` in domain-wood, `constructionDataSummariser` in domain-construction,
// `mechDataSummariser` in domain-mech); a namespace without one gets a generic list of the fields
// that changed. A domain that owns a typed document section (domain-mech's `mech`, ADR 0017
// decision 2) also summarises it (`mechSectionSummariser`): its lines join the namespace's entry.

import type { DomainData, ManufaktureDocument } from '@manufakture/core';
import { constructionDataSummariser } from '@manufakture/domain-construction';
import { mechDataSummariser, mechSectionSummariser } from '@manufakture/domain-mech';
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
  mechDataSummariser,
];

/**
 * The hook for a typed document section a domain owns: lines for how the section changed from
 * `before` to `after` (undefined when absent). It must not throw; one that does is replaced by a
 * generic list of the fields that changed.
 */
export interface SectionSummariser {
  readonly section: string;
  summarise(before: unknown, after: unknown): readonly string[];
}

/** The typed sections domain packages own, by key in the document and namespace. */
const SECTIONS: readonly {
  readonly namespace: string;
  readonly read: (doc: ManufaktureDocument) => unknown;
  readonly summariser: SectionSummariser;
}[] = [{ namespace: 'mech', read: (doc) => doc.mech, summariser: mechSectionSummariser }];

function sectionLines(summariser: SectionSummariser, before: unknown, after: unknown): string[] {
  let lines: readonly string[] | null = null;
  try {
    const r = summariser.summarise(before, after);
    if (Array.isArray(r) && r.every((l) => typeof l === 'string')) lines = r;
  } catch {
    lines = null;
  }
  if (lines === null) {
    const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    const a = before ?? (isObject(after) ? {} : undefined);
    const b = after ?? (isObject(before) ? {} : undefined);
    lines = fieldChanges(a, b, { max: LIMITS.domainLines }).map(
      (c) => `${c.path}: ${c.before} to ${c.after}`,
    );
  }
  return lines.map((l) => shown(l));
}

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
  const sections = new Map(SECTIONS.map((s) => [s.namespace, s]));
  const namespaces = new Set([...Object.keys(a), ...Object.keys(b), ...sections.keys()]);
  for (const ns of [...namespaces].sort()) {
    const x = Object.hasOwn(a, ns) ? a[ns] : undefined;
    const y = Object.hasOwn(b, ns) ? b[ns] : undefined;
    const section = sections.get(ns);
    const sx = section?.read(base);
    const sy = section?.read(head);
    const dataChanged = JSON.stringify(x) !== JSON.stringify(y);
    const sectionChanged = section !== undefined && JSON.stringify(sx) !== JSON.stringify(sy);
    if (!dataChanged && !sectionChanged) continue;
    const all = [
      ...(dataChanged ? domainLines(ns, x, y, summarisers) : []),
      ...(sectionChanged ? sectionLines(section.summariser, sx, sy) : []),
    ];
    const lines = bounded(all, LIMITS.domainLines);
    const was = x !== undefined || sx !== undefined;
    const is = y !== undefined || sy !== undefined;
    out.push({
      namespace: shown(ns, 64),
      change: !was ? 'added' : !is ? 'removed' : 'changed',
      lines: lines.items,
      omitted: lines.omitted,
    });
  }
  return out;
}
