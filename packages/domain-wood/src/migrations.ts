// Versioned stored JSON (ADR 0013 decision 4): extension params per type and domain data per
// namespace each carry a `schemaVersion`. A migration is a pure function from version N to N + 1;
// they run in memory wherever params or data are read, and the stored value is written at the
// current version only when the user edits it. A domain keeps every migration it has shipped, so
// `migrations[i]` takes version `i + 1` to `i + 2`, and the current version is
// `migrations.length + 1`.

import { fail, ok, type Read } from './read';

/** A JSON value as core stores params and domain data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One step: the value at version N, to the value at N + 1. Pure; may refuse with a message. */
export type Migration = (value: Json) => Read<Json>;

/** The migrations of one versioned value (an extension type's params, a namespace's data). */
export interface Versioned {
  /** What the value is, for messages (`"wood.board" params`). */
  readonly what: string;
  /** `migrations[i]` takes version `i + 1` to `i + 2`. */
  readonly migrations: readonly Migration[];
}

/** The newest version a `Versioned` reads. */
export function currentVersion(v: Versioned): number {
  return v.migrations.length + 1;
}

/**
 * The value stored at `from`, migrated to the current version. A version that is not an integer
 * from 1, or newer than this build reads, is refused (regen reports a newer one as `unsupported`
 * before it gets here; this is the same check for callers outside regen, such as dialogs).
 */
export function migrate(v: Versioned, value: Json, from: number): Read<Json> {
  const current = currentVersion(v);
  if (!Number.isSafeInteger(from) || from < 1) {
    return fail(`${v.what}: version ${String(from)} is not a version`);
  }
  if (from > current) {
    return fail(`${v.what}: version ${from} is newer than this build reads (version ${current})`);
  }
  let out = value;
  for (let version = from; version < current; version++) {
    let step: Read<Json>;
    try {
      step = v.migrations[version - 1]!(out);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return fail(`${v.what}: migrating from version ${version} failed: ${why}`);
    }
    if (!step.ok) {
      return { ...step, message: `${v.what}: migrating from version ${version}: ${step.message}` };
    }
    out = step.value;
  }
  return ok(out);
}
