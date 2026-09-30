import type { UnitsError } from '@manufakture/units';
import type { z } from 'zod';

/** Broad category of a core error, so callers can react without parsing messages. */
export type CoreErrorCode =
  /** The input does not match the schema (a command, a feature or a loaded document). */
  | 'schema'
  /** A part, feature or variable that the command names does not exist. */
  | 'not-found'
  /** Two things share an id or a name that must be unique. */
  | 'duplicate'
  /** An id is malformed, does not match its kind, or was never allocated. */
  | 'invalid-id'
  /** A command tried to give something an id that was already used, possibly by a deleted item. */
  | 'id-reused'
  /** A feature would come before something it references, or after something that references it. */
  | 'dependency'
  /** An expression does not parse. */
  | 'expression'
  /** An expression mentions a variable that does not exist. */
  | 'unknown-variable'
  /** Variables reference each other in a cycle. */
  | 'variable-cycle'
  /** A variable cannot be deleted because something references it. */
  | 'variable-in-use'
  /** A variable or feature name is not allowed. */
  | 'invalid-name'
  /** An index is outside the list it points into. */
  | 'invalid-index'
  /** An edit changes a feature's kind, or a reference points at a feature of the wrong kind. */
  | 'kind-mismatch'
  /** A sketch is inconsistent: a constraint names a missing entity or has the wrong arity. */
  | 'sketch'
  /** The text is not JSON. */
  | 'json'
  /** The JSON is not a manufakture document at all. */
  | 'format'
  /** The file or naming scheme version is invalid or newer than this app. */
  | 'version'
  /** A migration failed. */
  | 'migration'
  /** Undo or redo with an empty stack. */
  | 'empty-history'
  /** The command would delete the document's only part studio. */
  | 'last-part';

export interface CoreError {
  readonly code: CoreErrorCode;
  readonly message: string;
  /** Where in the document or command the problem is, as keys and indices. */
  readonly path: readonly (string | number)[];
  /** Ids of the features (or names of the variables) that block the operation. */
  readonly blockers?: readonly string[];
  /** For `expression` errors: the parser's error, with the range to highlight. */
  readonly unitsError?: UnitsError;
  /** For `schema` errors and failed validation: every individual problem. */
  readonly issues?: readonly CoreError[];
}

export type CoreResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CoreError };

export function ok<T>(value: T): CoreResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  code: CoreErrorCode,
  message: string,
  path: readonly (string | number)[] = [],
  extra: Omit<CoreError, 'code' | 'message' | 'path'> = {},
): CoreResult<T> {
  return { ok: false, error: { code, message, path, ...extra } };
}

/** A zod error as a `schema` CoreError: the first issue is the message, all of them `issues`. */
export function schemaError(prefix: string, error: z.ZodError): CoreError {
  const issues: CoreError[] = error.issues.map((i) => ({
    code: 'schema',
    message: i.message,
    path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
  }));
  const first = issues[0];
  return {
    code: 'schema',
    message: first ? `${prefix}: ${first.message} at ${first.path.join('.') || '(root)'}` : prefix,
    path: first?.path ?? [],
    issues,
  };
}
