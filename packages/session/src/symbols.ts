// Symbolic ids (ADR 0016 decision 8). A model cannot reliably compute the next free id of each
// counter, so in a batch any id may have its number replaced by `$name`: `extrude#$boss`,
// `sketch#$s`, `e$p1`, `part#$side`, and inside a face name `extrude#$boss:side:e$l1`. The
// counter stays written (it is the part before the number), so every symbol has exactly one.
//
// Resolution:
// 1. Every symbol in the batch's strings becomes a placeholder id of its counter with a number no
//    counter reaches (`PLACEHOLDER_BASE + i`), so the batch is schema-shaped.
// 2. Core's own walk of the commands (`commandIds`) says in which counter scope each placeholder
//    sits in a plain id field: a symbol is defined by where it is created, and used elsewhere.
// 3. Real ids are allocated per scope and counter in order of first appearance, from the
//    document's counters (`nextNumber`), past any literal fresh id of the same counter in the
//    batch, as `previewIds` would hand them out.
// 4. Core's `remapIds` substitutes them through the whole batch, face names included, through the
//    naming parser: never by string replacement.
// 5. Core does not read an extension's `params` (ADR 0013 decision 2), so the fields its type
//    declares as ids (`ParamIdField`: a board's `sketch`, a joint's `a` and `b`) get the real ids
//    here, from the same table. A symbol there must be one the batch creates.
// 6. A placeholder left in a string no id walk reaches (a name, a note, any other params field)
//    was text, not an id, and is put back as the agent wrote it.
//
// Before any of it, the batch's shape is checked without recursion (`batchProblem`): commands
// counted through nested batches, batches nested at most `MAX_BATCH_DEPTH` deep and the JSON at
// most `MAX_JSON_DEPTH` deep, so a hostile batch costs neither stack nor a full parse. A literal id
// numbered at or above `PLACEHOLDER_BASE` is refused, so no literal can pass for a placeholder.
//
// A symbol lives for one batch; later batches use the real ids from the returned table. A symbol
// that no command of the batch creates is refused, as is one written with two counters or in two
// scopes. Two creations of one symbol, or a use before its creation, are refused by core like any
// such command (`duplicate`, `not-found`).

import type { ParamIdField } from '@manufakture/regen';
import {
  CommandSchema,
  commandIds,
  createdIds,
  documentCounters,
  idCounter,
  idText,
  nextNumber,
  remapIds,
  schemaError,
  type Command,
  type CoreError,
  type ManufaktureDocument,
  type RenameTable,
} from '@manufakture/core';

/** Placeholder numbers: far above any counter, below the tombstone (999,999,999,999,999). */
export const PLACEHOLDER_BASE = 900_000_000_000_000;
/** At most this many distinct symbols in one batch. */
export const MAX_SYMBOLS = 10_000;
/** Batches inside batches: at most this deep (the batch itself is 1). */
export const MAX_BATCH_DEPTH = 8;
/** Arrays and objects inside one another in a batch: at most this deep. */
export const MAX_JSON_DEPTH = 100;
/** Core's tombstone in a face name (`TOMBSTONE_NAME` of core's `ids.ts`): never binds. */
const TOMBSTONE_NAME = 999_999_999_999_999;

/**
 * A symbolic id: an id's counter, then `$` and a name where its number goes. Not after another id
 * character, so `abc$x` in text is left alone.
 */
const TOKEN =
  /(?<![A-Za-z0-9_#$])(?:([a-z][a-zA-Z0-9]*)#|([ekr]))\$([A-Za-z_][A-Za-z0-9_]{0,63})(?![A-Za-z0-9_$])/g;

/** A symbolic id, or (group 4) a literal id's number of 15 digits or more. One scan finds both. */
const SCAN =
  /(?<![A-Za-z0-9_#$])(?:([a-z][a-zA-Z0-9]*)#|([ekr]))(?:\$([A-Za-z_][A-Za-z0-9_]{0,63})(?![A-Za-z0-9_$])|([0-9]{15,})(?![0-9]))/g;
/** A placeholder as `idText` writes it (`extrude#900000000000003`, `e900000000000001`). */
const PLACEHOLDER_TEXT = /(?<![A-Za-z0-9_#$])(?:[a-z][a-zA-Z0-9]*#|[a-z])9[0-9]{14}(?![0-9])/g;

export type SymbolProblem =
  | { kind: 'core'; error: CoreError }
  | { kind: 'symbol'; message: string }
  | { kind: 'too-deep'; message: string; limit: number };

/** Why a batch's shape is refused before anything else reads it. */
export interface BatchProblem {
  code: 'too-many-commands' | 'too-deep';
  message: string;
  limit: number;
}

/**
 * Whether `commands` (a batch's list, plain JSON from a client) is too deep or holds more than
 * `maxCommands` commands, nested batches counted by their commands. No recursion: a batch nested
 * a million deep is refused as cheaply as one nested nine deep.
 */
export function batchProblem(
  commands: readonly unknown[],
  maxCommands: number,
): BatchProblem | null {
  // The JSON depth, stopping at the limit.
  const values: [unknown, number][] = [[commands, 1]];
  while (values.length > 0) {
    const [value, depth] = values.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth > MAX_JSON_DEPTH) {
      return {
        code: 'too-deep',
        message: `A batch nests lists and objects at most ${MAX_JSON_DEPTH} deep.`,
        limit: MAX_JSON_DEPTH,
      };
    }
    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      if (v !== null && typeof v === 'object') values.push([v, depth + 1]);
    }
  }
  // Commands, through nested batches.
  let count = 0;
  const lists: [readonly unknown[], number][] = [[commands, 1]];
  while (lists.length > 0) {
    const [list, depth] = lists.pop()!;
    for (const c of list) {
      const nested = c as { type?: unknown; commands?: unknown } | null;
      if (nested !== null && typeof nested === 'object' && nested.type === 'batch') {
        if (Array.isArray(nested.commands)) {
          if (depth + 1 > MAX_BATCH_DEPTH) {
            return {
              code: 'too-deep',
              message: `Batches nest at most ${MAX_BATCH_DEPTH} deep.`,
              limit: MAX_BATCH_DEPTH,
            };
          }
          lists.push([nested.commands, depth + 1]);
        }
        continue;
      }
      if (++count > maxCommands) {
        return {
          code: 'too-many-commands',
          message: `A batch holds at most ${maxCommands} commands, counting those in nested batches.`,
          limit: maxCommands,
        };
      }
    }
  }
  return null;
}

/** The params fields of an extension type that hold ids; undefined for a type no domain builds. */
export type IdFieldsOf = (extensionType: string) => readonly ParamIdField[] | undefined;

export interface ResolveOptions {
  /** Which params fields of each extension type hold ids. Without it, params are all text. */
  idFields?: IdFieldsOf;
}

/** Single-letter counters: sketch entities and references, not features. */
const ENTITY_COUNTER = /^[a-z]$/;

/**
 * `value` with `f` applied to the strings of every declared id field of every extension feature
 * in it (`kind: 'extension'`, wherever a command carries one). Other strings are left alone.
 */
function mapIdFields(
  value: unknown,
  idFields: IdFieldsOf,
  f: (s: string, field: ParamIdField, feature: string) => string,
): unknown {
  if (Array.isArray(value)) return value.map((v) => mapIdFields(v, idFields, f));
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = mapIdFields(v, idFields, f);
  const params = o.params;
  if (
    o.kind === 'extension' &&
    typeof o.extension === 'string' &&
    typeof o.id === 'string' &&
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params)
  ) {
    let p: unknown = params;
    for (const field of idFields(o.extension) ?? []) {
      p = mapPath(p, field.path, 0, (s) => f(s, field, o.id as string));
    }
    out.params = p;
  }
  return out;
}

/** `value` with `f` applied to the strings at `path` (from `i`); `*` is each element of a list. */
function mapPath(
  value: unknown,
  path: readonly string[],
  i: number,
  f: (s: string) => string,
): unknown {
  if (i === path.length) return typeof value === 'string' ? f(value) : value;
  const key = path[i]!;
  if (key === '*') {
    return Array.isArray(value) ? value.map((v) => mapPath(v, path, i + 1, f)) : value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Object.hasOwn(value, key)) return value;
  const o = value as Record<string, unknown>;
  return { ...o, [key]: mapPath(o[key], path, i + 1, f) };
}

export interface ResolvedSymbols {
  /** The batch with real ids. */
  command: Command;
  /** Each symbol (`$boss`) and the real id it got (`extrude#3`), in order of appearance. */
  table: Record<string, string>;
}

/** Every string in plain JSON, rewritten by `f`. */
function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') return f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, f);
    return out;
  }
  return value;
}

/** Whether `command` (plain JSON from a client) mentions any symbolic id. */
export function hasSymbols(command: unknown): boolean {
  let found = false;
  mapStrings(command, (s) => {
    TOKEN.lastIndex = 0;
    if (!found && TOKEN.test(s)) found = true;
    return s;
  });
  return found;
}

/**
 * Resolve the symbolic ids of `command` (a batch, plain JSON from a client) against `document`,
 * the document it is to apply to. Returns the batch with real ids and the table, or why not.
 */
export function resolveSymbols(
  document: ManufaktureDocument,
  command: unknown,
  options: ResolveOptions = {},
): { ok: true; value: ResolvedSymbols } | { ok: false; problem: SymbolProblem } {
  const symbol = (message: string) => ({
    ok: false as const,
    problem: { kind: 'symbol' as const, message },
  });
  // The shape first: `mapStrings` and the schema recurse.
  const list = (command as { commands?: unknown } | null)?.commands;
  const shape = batchProblem(Array.isArray(list) ? list : [command], Number.MAX_SAFE_INTEGER);
  if (shape !== null) {
    return { ok: false, problem: { kind: 'too-deep', message: shape.message, limit: shape.limit } };
  }
  // 1. Placeholders, in one scan of each string, which also finds literal ids numbered where
  // placeholders are.
  const counters = new Map<string, string>();
  const index = new Map<string, number>();
  const order: string[] = [];
  const tokens = new Map<string, string>();
  let problem: string | null = null;
  const placeholder = (name: string): string =>
    idText(counters.get(name)!, PLACEHOLDER_BASE + index.get(name)!);
  const withPlaceholders = mapStrings(command, (s) =>
    s.replace(
      SCAN,
      (
        token,
        kind: string | undefined,
        sub: string | undefined,
        name: string | undefined,
        digits: string | undefined,
      ) => {
        if (digits !== undefined) {
          const n = Number(digits);
          if (n >= PLACEHOLDER_BASE && n !== TOMBSTONE_NAME) {
            problem ??= `The id ${token} is numbered at or above ${PLACEHOLDER_BASE}, which no counter reaches.`;
          }
          return token;
        }
        const counter = kind ?? sub!;
        const key = `$${name!}`;
        const known = counters.get(key);
        if (known === undefined) {
          if (order.length >= MAX_SYMBOLS) {
            problem ??= `A batch holds at most ${MAX_SYMBOLS} symbolic ids.`;
            return token;
          }
          counters.set(key, counter);
          index.set(key, order.length);
          order.push(key);
        } else if (known !== counter) {
          problem ??= `The symbol ${key} is written with two counters (${known} and ${counter}).`;
          return token;
        }
        const id = placeholder(key);
        tokens.set(id, token);
        return id;
      },
    ),
  );
  if (problem !== null) return symbol(problem);
  const parsed = CommandSchema.safeParse(withPlaceholders);
  if (!parsed.success) {
    return {
      ok: false,
      problem: { kind: 'core', error: schemaError('Invalid command', parsed.error) },
    };
  }
  const batch = parsed.data;
  if (order.length === 0) return { ok: true, value: { command: batch, table: {} } };

  // 2. Where each placeholder sits in a plain id field, and the literal ids beside them.
  const placeholders = new Map(order.map((name) => [placeholder(name), name]));
  const scopeOf = new Map<string, string>();
  const literalMax = new Map<string, number>();
  let walked: { scope: string; id: string }[];
  try {
    walked = commandIds([batch], document);
  } catch (e) {
    return symbol(
      `The batch cannot be read for ids: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const { scope, id } of walked) {
    const name = placeholders.get(id);
    if (name === undefined) {
      const c = idCounter(id);
      if (c === undefined || c.split !== '') continue;
      if (c.n >= PLACEHOLDER_BASE) {
        return symbol(`The id ${id} is numbered at or above ${PLACEHOLDER_BASE}.`);
      }
      const key = `${scope}\u0000${c.counter}`;
      literalMax.set(key, Math.max(literalMax.get(key) ?? 0, c.n));
      continue;
    }
    const seen = scopeOf.get(name);
    if (seen === undefined) scopeOf.set(name, scope);
    else if (seen !== scope) {
      return symbol(`The symbol ${name} is used for two different things (${seen} and ${scope}).`);
    }
  }

  // 3. Real ids, per scope and counter, in order of first appearance.
  const docCounters = documentCounters(document);
  const next = new Map<string, number>();
  const table: Record<string, Record<string, string>> = {};
  const result: Record<string, string> = {};
  for (const name of order) {
    const scope = scopeOf.get(name);
    if (scope === undefined) continue;
    const counter = counters.get(name)!;
    const key = `${scope}\u0000${counter}`;
    let n = next.get(key);
    if (n === undefined) {
      const own = Object.hasOwn(docCounters, scope) ? docCounters[scope] : undefined;
      n = Math.max(
        own === undefined ? 1 : nextNumber(own, counter),
        (literalMax.get(key) ?? 0) + 1,
      );
    }
    next.set(key, n + 1);
    const real = idText(counter, n);
    (table[scope] ??= {})[placeholder(name)] = real;
    result[name] = real;
  }

  // 4. Substitute through the batch, names included.
  let remapped: Command;
  try {
    remapped = remapIds([batch], table as RenameTable, { document })[0]!;
  } catch (e) {
    return symbol(
      `The symbolic ids cannot be substituted: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 5. The id fields of extension params, which core does not walk.
  const inParams =
    options.idFields === undefined
      ? remapped
      : mapIdFields(remapped, options.idFields, (s, field, feature) =>
          s.replace(PLACEHOLDER_TEXT, (id) => {
            const name = placeholders.get(id);
            if (name === undefined) return id;
            const where = `params.${field.path.join('.')} of ${feature.replace(PLACEHOLDER_TEXT, (p) => tokens.get(p) ?? p)}`;
            const entity = ENTITY_COUNTER.test(counters.get(name)!);
            if (entity !== (field.kind === 'entity')) {
              problem ??= `The symbol ${name} in ${where} is written as ${entity ? 'a sketch entity' : 'a feature'} id (${tokens.get(id)!}), but the field names ${field.kind === 'entity' ? 'a sketch entity' : 'a feature'}.`;
              return id;
            }
            const real = result[name];
            if (real === undefined) {
              problem ??= `No command of the batch creates ${name}: a symbol names something the batch makes.`;
              return id;
            }
            return real;
          }),
        );
  if (problem !== null) return symbol(problem);
  // 6. Placeholders the walk did not reach were text: put back as written.
  const restored = mapStrings(inParams, (s) =>
    s.replace(PLACEHOLDER_TEXT, (id) => tokens.get(id) ?? id),
  ) as Command;

  // Every symbol must be created by the batch.
  const created = createdIds(document, restored);
  if (!created.ok) {
    // A symbol only referred to is an id no counter handed out: core refuses it as missing.
    for (const name of order) {
      const id = result[name];
      const missing = created.error.code === 'not-found' || created.error.code === 'invalid-id';
      if (id !== undefined && missing && created.error.message.includes(`"${id}"`)) {
        return symbol(
          `No command of the batch creates ${name}: a symbol names something the batch makes.`,
        );
      }
    }
  } else {
    const fresh = new Set(Object.values(created.value).flat() as string[]);
    for (const name of order) {
      const id = result[name];
      // A symbol no id field holds was text (restored above), not an id. Ids in a scope the batch
      // itself makes (the instances of a new assembly) are not listed by `createdIds`.
      if (id === undefined || !Object.hasOwn(docCounters, scopeOf.get(name)!)) continue;
      if (!fresh.has(id)) {
        return symbol(
          `No command of the batch creates ${name}: a symbol names something the batch makes.`,
        );
      }
    }
  }
  // When the batch does not apply, the caller's apply reports core's error.
  return { ok: true, value: { command: restored, table: result } };
}
