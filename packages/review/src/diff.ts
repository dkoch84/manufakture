// The document diff of a bundle, by comparing base and head (not the commands, so an edit undone
// in the branch leaves nothing): per part, the features added, edited (with the fields that
// changed), deleted, renamed, reordered and suppressed; per assembly, its instances and mates;
// the other document-level changes as fields; and the scripts added or changed, in full.

import type {
  Assembly,
  Feature,
  Instance,
  ManufaktureDocument,
  Mate,
  Part,
  Script,
} from '@manufakture/core';
import { describeFeature, featureKind, featureTitle, Names } from './describe';
import { changesText } from './summaries';
import { bounded, fieldChanges, hasHiddenCharacters, omit, shown } from './text';
import {
  LIMITS,
  type ContainerDiff,
  type FieldChange,
  type ItemChange,
  type ItemChangeKind,
  type ScriptDiff,
} from './types';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The ids of `after` (in its order) that moved relative to the others both lists hold: those
 * outside a longest common subsequence of the shared ids. Long lists compare positions instead.
 */
export function movedIds(before: readonly string[], after: readonly string[]): Set<string> {
  const inBoth = new Set(before.filter((id) => after.includes(id)));
  const a = before.filter((id) => inBoth.has(id));
  const b = after.filter((id) => inBoth.has(id));
  if (a.length * b.length > 4_000_000) {
    return new Set(b.filter((id, i) => a[i] !== id));
  }
  // LCS by dynamic programming over the shared ids.
  const n = a.length;
  const m = b.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      kept.add(a[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return new Set(b.filter((id) => !kept.has(id)));
}

interface Item {
  id: string;
  name: string;
  suppressed?: boolean;
}

function itemChange<T extends Item>(
  before: T | undefined,
  after: T | undefined,
  options: {
    kind: (x: T) => string;
    title: (x: T) => string;
    describe: (x: T) => string;
    moved: boolean;
    positions: { before: number; after: number } | null;
  },
): ItemChange | null {
  const x = (after ?? before)!;
  const changes: ItemChangeKind[] = [];
  let fields: FieldChange[] = [];
  const lines: string[] = [];
  if (before === undefined) {
    changes.push('added');
    lines.push(`Added ${options.describe(x)}`);
  } else if (after === undefined) {
    changes.push('deleted');
    lines.push(`Deleted ${options.title(x)}`);
  } else {
    if (before.name !== after.name) {
      changes.push('renamed');
      lines.push(`Renamed ${shown(before.name)} to ${shown(after.name)}`);
    }
    if (before.suppressed !== after.suppressed && after.suppressed !== undefined) {
      changes.push(after.suppressed ? 'suppressed' : 'unsuppressed');
      lines.push(`${after.suppressed ? 'Suppressed' : 'Unsuppressed'} ${options.title(after)}`);
    }
    fields = fieldChanges(before, after, { skip: ['id', 'kind', 'name', 'suppressed'] });
    if (fields.length > 0) {
      changes.push('edited');
      lines.push(`Edited ${options.title(after)}: ${changesText(fields)}`);
    }
    if (options.moved && options.positions) {
      changes.push('reordered');
      lines.push(
        `Moved ${options.title(after)} from position ${options.positions.before} to ${options.positions.after}`,
      );
    }
  }
  if (changes.length === 0) return null;
  return {
    id: shown(x.id, 120),
    kind: shown(options.kind(x), 120),
    name: shown(x.name),
    changes,
    summary: shown(lines.join('; ')),
    fields,
    ...(changes.includes('reordered') && options.positions ? { position: options.positions } : {}),
  };
}

function itemChanges<T extends Item>(
  before: readonly T[],
  after: readonly T[],
  options: {
    kind: (x: T) => string;
    title: (x: T) => string;
    describe: (x: T) => string;
    order: boolean;
  },
): ItemChange[] {
  const was = new Map(before.map((x, i) => [x.id, { x, i }]));
  const now = new Map(after.map((x, i) => [x.id, { x, i }]));
  const moved = options.order
    ? movedIds(
        before.map((x) => x.id),
        after.map((x) => x.id),
      )
    : new Set<string>();
  const out: ItemChange[] = [];
  for (const [id, { x, i }] of now) {
    const old = was.get(id);
    const c = itemChange(old?.x, x, {
      ...options,
      moved: moved.has(id),
      positions: old ? { before: old.i + 1, after: i + 1 } : null,
    });
    if (c) out.push(c);
  }
  for (const [id, { x }] of was) {
    if (now.has(id)) continue;
    const c = itemChange(x, undefined, { ...options, moved: false, positions: null });
    if (c) out.push(c);
  }
  return out;
}

function partFields(p: Part | undefined): Record<string, unknown> {
  if (p === undefined) return {};
  return omit(p, ['features', 'nextIds', 'id']);
}

/** Per part that differs: the part's own fields and its features. */
export function partDiffs(base: ManufaktureDocument, head: ManufaktureDocument): ContainerDiff[] {
  const names = new Names([head, base]);
  const out: ContainerDiff[] = [];
  const was = new Map(base.parts.map((p) => [p.id, p]));
  const now = new Map(head.parts.map((p) => [p.id, p]));
  const ids = [
    ...head.parts.map((p) => p.id),
    ...base.parts.filter((p) => !now.has(p.id)).map((p) => p.id),
  ];
  for (const id of ids) {
    const a = was.get(id);
    const b = now.get(id);
    if (a !== undefined && b !== undefined && same(a, b)) continue;
    const describe = (f: Feature) => describeFeature(f, names, id);
    const items = itemChanges<Feature>(a?.features ?? [], b?.features ?? [], {
      kind: featureKind,
      title: featureTitle,
      describe,
      order: true,
    });
    out.push({
      id: shown(id, 120),
      name: shown((b ?? a)!.name),
      change: a === undefined ? 'added' : b === undefined ? 'deleted' : 'changed',
      fields: a !== undefined && b !== undefined ? fieldChanges(partFields(a), partFields(b)) : [],
      items: bounded(items, LIMITS.items),
    });
  }
  return out;
}

function assemblyFields(a: Assembly | undefined): Record<string, unknown> {
  if (a === undefined) return {};
  return omit(a, ['instances', 'mates', 'nextIds', 'id']);
}

/** Per assembly that differs: its own fields, then its instances and mates. */
export function assemblyDiffs(
  base: ManufaktureDocument,
  head: ManufaktureDocument,
): ContainerDiff[] {
  const names = new Names([head, base]);
  const out: ContainerDiff[] = [];
  const was = new Map(base.assemblies.map((a) => [a.id, a]));
  const now = new Map(head.assemblies.map((a) => [a.id, a]));
  const ids = [
    ...head.assemblies.map((a) => a.id),
    ...base.assemblies.filter((a) => !now.has(a.id)).map((a) => a.id),
  ];
  for (const id of ids) {
    const a = was.get(id);
    const b = now.get(id);
    if (a !== undefined && b !== undefined && same(a, b)) continue;
    const instances = itemChanges<Instance>(a?.instances ?? [], b?.instances ?? [], {
      kind: () => 'instance',
      title: (i) => `instance ${shown(i.name)}`,
      describe: (i) =>
        `instance ${shown(i.name)} of ${'part' in i.source ? names.part(i.source.part) : shown(i.source.documentName)}`,
      order: false,
    });
    const mates = itemChanges<Mate>(a?.mates ?? [], b?.mates ?? [], {
      kind: (m) => m.kind,
      title: (m) => `mate ${shown(m.name)}`,
      describe: (m) => `${m.kind} mate ${shown(m.name)}`,
      order: false,
    });
    out.push({
      id: shown(id, 120),
      name: shown((b ?? a)!.name),
      change: a === undefined ? 'added' : b === undefined ? 'deleted' : 'changed',
      fields:
        a !== undefined && b !== undefined
          ? fieldChanges(assemblyFields(a), assemblyFields(b))
          : [],
      items: bounded([...instances, ...mates], LIMITS.items),
    });
  }
  return out;
}

/** The document's other changes: name, units, variables, configurations, fonts, drawings, CAM, print. */
export function documentChanges(
  base: ManufaktureDocument,
  head: ManufaktureDocument,
): FieldChange[] {
  const view = (d: ManufaktureDocument) => ({
    name: d.name,
    units: d.units,
    variables: Object.fromEntries(d.variables.map((v) => [v.name, v.expression])),
    configurations: d.configurations,
    fonts: Object.fromEntries(d.fonts.map((f) => [f.id, `${f.family} ${f.style}`])),
    drawings: Object.fromEntries((d.drawings ?? []).map((x) => [x.id, x])),
    cam: {
      tools: Object.fromEntries(d.cam.tools.map((t) => [t.id, t])),
      setups: Object.fromEntries(d.cam.setups.map((s) => [s.id, s])),
    },
    print: Object.fromEntries(d.print.setups.map((s) => [s.id, s])),
  });
  return fieldChanges(view(base), view(head), { depth: 3 });
}

/** Scripted features at head that run each script, by script id. */
function scriptUsers(doc: ManufaktureDocument): Map<string, string[]> {
  const users = new Map<string, string[]>();
  for (const p of doc.parts) {
    for (const f of p.features) {
      if (f.kind !== 'scripted') continue;
      users.set(f.script, [...(users.get(f.script) ?? []), `${p.id}/${f.id}`]);
    }
  }
  return users;
}

/**
 * Scripts added, changed or deleted, and those unchanged that a scripted feature the branch added
 * or edited runs: each in full (up to the limits), since a script is logic the reviewer must read
 * (cross-cutting decision 1).
 */
export function scriptDiffs(base: ManufaktureDocument, head: ManufaktureDocument): ScriptDiff[] {
  const was = new Map((base.scripts ?? []).map((s) => [s.id, s]));
  const now = new Map((head.scripts ?? []).map((s) => [s.id, s]));
  const users = scriptUsers(head);
  // Scripts run by a scripted feature that is new or changed in the branch.
  const touched = new Set<string>();
  for (const p of head.parts) {
    const old = base.parts.find((x) => x.id === p.id);
    for (const f of p.features) {
      if (f.kind !== 'scripted') continue;
      const prior = old?.features.find((x) => x.id === f.id);
      if (prior === undefined || !same(prior, f)) touched.add(f.script);
    }
  }
  let budget: number = LIMITS.scriptsTotal;
  const take = (source: string): { text: string; cut: boolean } => {
    const max = Math.min(LIMITS.scriptSource, Math.max(0, budget));
    const text = source.length <= max ? source : source.slice(0, max);
    budget -= text.length;
    return { text, cut: text.length < source.length };
  };
  const entry = (s: Script, change: ScriptDiff['change'], previous?: Script): ScriptDiff => {
    const source = take(s.source);
    const prior = previous === undefined ? undefined : take(previous.source);
    return {
      scriptId: shown(s.id, 64),
      name: shown(s.name),
      language: s.language,
      apiVersion: s.apiVersion,
      change,
      source: source.text,
      ...(prior !== undefined ? { previous: prior.text } : {}),
      truncated: source.cut || (prior?.cut ?? false),
      hiddenCharacters:
        hasHiddenCharacters(s.source) || (previous ? hasHiddenCharacters(previous.source) : false),
      features: (users.get(s.id) ?? []).slice(0, LIMITS.items).map((u) => shown(u, 200)),
    };
  };
  const out: ScriptDiff[] = [];
  for (const [id, s] of now) {
    const old = was.get(id);
    if (old === undefined) out.push(entry(s, 'added'));
    else if (!same(old, s)) out.push(entry(s, 'changed', old));
    else if (touched.has(id)) out.push(entry(s, 'used'));
  }
  for (const [id, s] of was) if (!now.has(id)) out.push(entry(s, 'deleted'));
  return out;
}
