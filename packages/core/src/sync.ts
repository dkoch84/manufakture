import { z } from 'zod';
import { applyCommand, type Command } from './commands';
import { commandIds, isValidRename, type RenameTable } from './remap';
import type { CoreResult } from './result';
import { ok } from './result';
import type { ManufaktureDocument } from './schema';
import {
  DOCUMENT_SCOPE,
  documentCounters,
  idCounter,
  idText,
  nextNumber,
  type CounterTable,
  type ScopeKey,
} from './scopes';

/**
 * What sync needs from core (ADR 0009 and its amendment), as pure functions and schemas: the
 * ids a command creates, the checks a server makes before and after core, rename tables for a
 * client's queue, and the sync entry's storage form. The client engine and the reference server
 * are `packages/sync` (T7.1b); they build on these.
 */

/**
 * The version of the sync protocol: the shape of `SyncEntry` and of the messages around it.
 * Bumped when either changes incompatibly; independent of the document `FORMAT_VERSION`, which
 * each entry carries as `format`.
 */
export const PROTOCOL_VERSION = 1;

/** The longest id a `created` list holds (ids are tens of characters). */
const MAX_CREATED_ID = 64;
/** The longest scope key (`part:` plus a part id, which may be long). */
const MAX_SCOPE_KEY = 4200;
/** The most ids one entry may create (a whole replaced document's worth). */
export const MAX_CREATED_IDS = 1_000_000;

/**
 * The ids a command creates, by scope (`ScopeKey`), each scope's ids sorted by counter and
 * number: `{ "part:part#1": ["extrude#4", "e10", "e11"], "document": ["part#3"] }`. Ids in a scope
 * the command itself creates (a new part's, a new drawing's) are not listed: nobody else can hold
 * them, and the scope's own id is listed in its parent scope.
 */
export type CreatedIds = Readonly<Record<ScopeKey, readonly string[]>>;

export const CreatedIdsSchema = z
  .record(
    z.string().min(1).max(MAX_SCOPE_KEY),
    z
      .array(
        z
          .string()
          .max(MAX_CREATED_ID)
          .refine((id) => idCounter(id)?.split === '', 'Expected an id straight from a counter'),
      )
      .min(1),
  )
  .check((ctx) => {
    let n = 0;
    for (const ids of Object.values(ctx.value)) n += ids.length;
    if (n > MAX_CREATED_IDS) {
      ctx.issues.push({
        code: 'custom',
        message: `an entry creates at most ${MAX_CREATED_IDS} ids`,
        input: n,
      });
    }
  }) satisfies z.ZodType<CreatedIds>;

/** A rename table as data (ADR 0009 amendment, item 6), for a saved sync queue. */
export const RenameTableSchema = z
  .record(
    z.string().min(1).max(MAX_SCOPE_KEY),
    z.record(z.string().max(MAX_CREATED_ID), z.string().max(MAX_CREATED_ID).nullable()),
  )
  .check((ctx) => {
    for (const [scope, renames] of Object.entries(ctx.value)) {
      for (const [from, to] of Object.entries(renames)) {
        if (!isValidRename(from, to)) {
          ctx.issues.push({
            code: 'custom',
            message: `cannot rename "${from}" to ${JSON.stringify(to)}: both must be ids of one counter`,
            input: to,
            path: [scope, from],
          });
        }
      }
    }
  }) satisfies z.ZodType<RenameTable>;

function compareIds(a: string, b: string): number {
  const p = idCounter(a)!;
  const q = idCounter(b)!;
  return p.counter < q.counter ? -1 : p.counter > q.counter ? 1 : p.n - q.n;
}

function sortedCreated(sets: Map<ScopeKey, Set<string>>): CreatedIds {
  const out: Record<ScopeKey, string[]> = {};
  for (const scope of [...sets.keys()].sort()) {
    const ids = [...sets.get(scope)!].sort(compareIds);
    if (ids.length > 0) out[scope] = ids;
  }
  return out;
}

/**
 * The ids `command` allocates on `doc`, per scope (ADR 0009 amendment, item 1). They are the ids
 * in the command's fields (not inside names) that `applyCommand`'s allocation takes fresh: in a
 * scope `doc` has, at or above that scope's counter before the command and below it after.
 * Split pieces (`e2#a`) have no counter and are never listed. Refuses whatever `applyCommand`
 * refuses.
 *
 * A client computes this on the document it made the command on and sends it with the entry, and
 * rewrites it with the command (`remapCreatedIds`). The server cannot compute it: an `editFeature`
 * that adds `e10` to a sketch whose head already has another client's `e10` looks like an edit of
 * that `e10` to core.
 */
export function createdIds(doc: ManufaktureDocument, command: Command): CoreResult<CreatedIds> {
  const applied = applyCommand(doc, command);
  if (!applied.ok) return applied;
  const before = documentCounters(doc);
  const after = documentCounters(applied.value.document);
  const sets = new Map<ScopeKey, Set<string>>();
  for (const { scope, id } of commandIds([command], doc)) {
    if (!Object.hasOwn(before, scope)) continue;
    const c = idCounter(id);
    if (c === undefined || c.split !== '') continue;
    if (c.n < nextNumber(before[scope], c.counter)) continue;
    if (Object.hasOwn(after, scope) && c.n >= nextNumber(after[scope], c.counter)) continue;
    let set = sets.get(scope);
    if (set === undefined) sets.set(scope, (set = new Set()));
    set.add(id);
  }
  return ok(sortedCreated(sets));
}

/**
 * The created ids that are no longer fresh against `counters` (below their scope's counter):
 * the server refuses such an entry as `id-reused` before running core (amendment, item 2), and a
 * client knows an in-flight entry with any of them is refused (item 4). Scopes `counters` does not
 * have are skipped (the command fails in core if it needs them).
 */
export function takenIds(counters: CounterTable, created: CreatedIds): CreatedIds {
  const sets = new Map<ScopeKey, Set<string>>();
  for (const [scope, ids] of Object.entries(created)) {
    if (!Object.hasOwn(counters, scope)) continue;
    for (const id of ids) {
      const c = idCounter(id);
      if (c === undefined || c.n >= nextNumber(counters[scope], c.counter)) continue;
      let set = sets.get(scope);
      if (set === undefined) sets.set(scope, (set = new Set()));
      set.add(id);
    }
  }
  return sortedCreated(sets);
}

export interface FreshRenamesOptions {
  /**
   * Ids never to hand out, by scope: tombstones of dropped commands (amendment, item 7) and ids
   * held entries hold. Usually unnecessary, since counters already pass them.
   */
  readonly reserved?: CreatedIds;
}

/**
 * Next free ids for `ids` from `counters`: a table renaming each to the next number of its
 * counter in its scope (in counter and number order, so renamed ids keep their relative order),
 * and the counters after allocating them. The client builds its queue's one table from this,
 * with the counters of the document it has replayed so far (amendment, item 6), and renames an
 * in-flight entry whose ids were taken in its own naming (item 4).
 */
export function freshRenames(
  counters: CounterTable,
  ids: CreatedIds,
  options: FreshRenamesOptions = {},
): { table: RenameTable; counters: CounterTable } {
  const next: Record<ScopeKey, Record<string, number>> = {};
  for (const [scope, c] of Object.entries(counters)) next[scope] = { ...c };
  const table: Record<ScopeKey, Record<string, string>> = {};
  for (const scope of Object.keys(ids).sort()) {
    const reserved = new Set(options.reserved?.[scope] ?? []);
    const into = (next[scope] ??= {});
    for (const id of [...ids[scope]!].sort(compareIds)) {
      const c = idCounter(id);
      if (c === undefined) continue;
      let n = nextNumber(into, c.counter);
      while (reserved.has(idText(c.counter, n))) n++;
      into[c.counter] = n + 1;
      (table[scope] ??= {})[id] = idText(c.counter, n);
    }
  }
  return { table, counters: next };
}

/** A table that turns every id of `ids` into a tombstone (a dropped command's ids, item 7). */
export function tombstoneTable(ids: CreatedIds): RenameTable {
  const out: Record<ScopeKey, Record<string, null>> = {};
  for (const [scope, list] of Object.entries(ids)) {
    for (const id of list) (out[scope] ??= {})[id] = null;
  }
  return out;
}

/** Scope keys that embed an id of the document scope (`part:part#3`). */
const NESTED_SCOPE = /^(part|assembly|drawing):(.+)$/s;

/** The key a scope has after the table renames its own id (`part:part#3` to `part:part#5`). */
export function remapScopeKey(scope: ScopeKey, table: RenameTable): ScopeKey {
  const m = NESTED_SCOPE.exec(scope);
  if (!m) return scope;
  const doc = Object.hasOwn(table, DOCUMENT_SCOPE) ? table[DOCUMENT_SCOPE] : undefined;
  const to = doc !== undefined && Object.hasOwn(doc, m[2]!) ? doc[m[2]!] : undefined;
  return typeof to === 'string' ? `${m[1]}:${to}` : scope;
}

/** `created` rewritten with its command (`remapIds` with the same table). */
export function remapCreatedIds(created: CreatedIds, table: RenameTable): CreatedIds {
  const sets = new Map<ScopeKey, Set<string>>();
  for (const [scope, ids] of Object.entries(created)) {
    const renames = Object.hasOwn(table, scope) ? table[scope] : undefined;
    const key = remapScopeKey(scope, table);
    let set = sets.get(key);
    if (set === undefined) sets.set(key, (set = new Set()));
    for (const id of ids) {
      const to = renames !== undefined && Object.hasOwn(renames, id) ? renames[id] : id;
      if (typeof to === 'string') set.add(to);
    }
  }
  return sortedCreated(sets);
}

/**
 * One sync entry in storage form (ADR 0009 decision 2 and amendment, item 1): the persistence
 * `LogEntry` (`cause`, `label`, `command`, `at`) plus what ordering needs. `command` is stored as
 * written, under document format `format`; read it with `migrateCommand(entry.command,
 * entry.format)` before applying it, so entries written before a format bump still replay.
 */
export const SyncEntrySchema = z.strictObject({
  /** A random id per installation and document. */
  clientId: z.string().min(1).max(128),
  /**
   * Increases by one per entry the client sends; never reused for a different command, a refused
   * one included. Assigned when the entry is sent (moves from unsent to in flight).
   */
  clientSeq: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  /**
   * The `clientSeq` of the entry this one was built on, assigned with `clientSeq` when the entry
   * is sent: the nearest entry before it in the client's queue that is neither refused nor doomed,
   * else the client's latest accepted entry, else absent. Never an entry the client knows was
   * refused or doomed.
   */
  prevSeq: z.int().min(1).max(Number.MAX_SAFE_INTEGER).exactOptional(),
  /** The server revision the client had when it made the command. */
  baseRev: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** The `FORMAT_VERSION` the command was written under. */
  format: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  cause: z.enum(['execute', 'undo', 'redo']),
  label: z.string().max(1000),
  /** The command in storage form, not yet migrated or validated. */
  command: z.looseObject({ type: z.string() }),
  /** The ids the command creates, computed on the document it was made on (`createdIds`). */
  created: CreatedIdsSchema,
  /** When the command was made, ISO 8601. */
  at: z.string().max(64),
});

export type SyncEntry = z.infer<typeof SyncEntrySchema>;
