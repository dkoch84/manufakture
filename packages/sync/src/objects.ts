import {
  DOCUMENT_SCOPE,
  partScope,
  type ManufaktureDocument,
  type RenameTable,
} from '@manufakture/core';

/**
 * The objects of a document that selective undo compares (ADR 0009 decision 8): each feature,
 * each part's own settings, each variable, each assembly, each drawing, and every other top-level
 * field (units, configurations, CAM, print, fonts, ...) as one object. Counters are left out: they
 * change with every add and are nobody's edit.
 *
 * A key is a string: `f\0<part id>\0<feature id>`, `p\0<part id>`, `v\0<name>`, `a\0<assembly
 * id>`, `d\0<drawing id>` or `k\0<field>`. Keys that hold ids are renamed with the queue's table
 * (`renameObjectKeys`), so an undo record follows its own renamed feature.
 */
export type ObjectKey = string;

const SEP = '\u0000';
const SKIPPED = new Set(['format', 'version', 'namingScheme', 'nextIds', 'id']);

function without<T extends object>(value: T, key: string): unknown {
  if (!Object.hasOwn(value, key)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete out[key];
  return out;
}

/** Every object of `doc`, by key. Values are the objects themselves (compare with `sameObject`). */
export function documentObjects(doc: ManufaktureDocument): Map<ObjectKey, unknown> {
  const out = new Map<ObjectKey, unknown>();
  for (const [field, value] of Object.entries(doc)) {
    if (SKIPPED.has(field)) continue;
    switch (field) {
      case 'parts':
        for (const p of doc.parts) {
          for (const f of p.features) out.set(`f${SEP}${p.id}${SEP}${f.id}`, f);
          out.set(`p${SEP}${p.id}`, without(without(p, 'features') as object, 'nextIds'));
        }
        break;
      case 'variables':
        for (const v of doc.variables) out.set(`v${SEP}${v.name}`, v);
        break;
      case 'assemblies':
        for (const a of doc.assemblies) out.set(`a${SEP}${a.id}`, without(a, 'nextIds'));
        break;
      case 'drawings':
        for (const d of doc.drawings ?? []) out.set(`d${SEP}${d.id}`, without(d, 'nextIds'));
        break;
      default:
        out.set(
          `k${SEP}${field}`,
          typeof value === 'object' && value !== null ? without(value, 'nextIds') : value,
        );
    }
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The keys of objects that differ between `before` and `after`: changed, added or removed. With
 * `existing`, only objects `before` had (what another client's change did to objects that were
 * there; an object it adds is new, and cannot be one a local command restores).
 */
export function changedObjects(
  before: ManufaktureDocument,
  after: ManufaktureDocument,
  existing = false,
): ObjectKey[] {
  const a = documentObjects(before);
  const b = documentObjects(after);
  const out: ObjectKey[] = [];
  for (const [k, v] of a) if (!b.has(k) || !same(v, b.get(k))) out.push(k);
  if (!existing) for (const k of b.keys()) if (!a.has(k)) out.push(k);
  return out.sort();
}

function rename(table: RenameTable, scope: string, id: string): string | null {
  const renames = Object.hasOwn(table, scope) ? table[scope] : undefined;
  if (renames === undefined || !Object.hasOwn(renames, id)) return id;
  return renames[id] ?? null;
}

/** Keys after a rename: ids follow the table; a key whose id became a tombstone is dropped. */
export function renameObjectKeys(keys: readonly ObjectKey[], table: RenameTable): ObjectKey[] {
  const out: ObjectKey[] = [];
  for (const key of keys) {
    const [kind, a, b] = key.split(SEP) as [string, string, string | undefined];
    if (kind === 'f') {
      const part = rename(table, DOCUMENT_SCOPE, a);
      const feature = rename(table, partScope(a), b!);
      if (part !== null && feature !== null) out.push(`f${SEP}${part}${SEP}${feature}`);
    } else if (kind === 'p' || kind === 'a' || kind === 'd') {
      const id = rename(table, DOCUMENT_SCOPE, a);
      if (id !== null) out.push(`${kind}${SEP}${id}`);
    } else {
      out.push(key);
    }
  }
  return out;
}
