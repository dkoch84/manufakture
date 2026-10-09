// Tool results. Every tool answers with structured content (checked against its output schema)
// and the same JSON as text, for clients that read only text. Expected failures are data
// (ADR 0007 decision 5, ADR 0016 decision 6): `{ ok: false, error }` with `isError` set, never a
// thrown error. Every result is held under the JSON limit (bounds.ts).
//
// ADR 0016 decision 13: text from a document (names, notes, labels, comments) travels only in
// data fields. Messages composed here never quote it; where a package's message may (a G-code
// export naming an operation, a drawing sheet's name), it goes into `error.details`, as data.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Refusal } from '@manufakture/session';
import { boundJson, type Truncation } from './bounds';

/** Codes of the server's own refusals (the session's and core's keep their own). */
export type ServerErrorCode =
  /** No open session has that id (closed, idle-closed, or never opened here). */
  | 'no-session'
  /** The call names Main as something to write or work on (ADR 0016 decision 12). */
  | 'main-refused'
  /** An input the tool does not take: see the message. */
  | 'invalid-input'
  /** The branch is not an agent branch, or not there. */
  | 'not-found'
  /** No output directory is configured, so nothing is exported. */
  | 'no-output'
  /** An export's file name or target that would leave the output directory, or is not a file. */
  | 'path'
  /** The file is there already; pass `overwrite: true` to replace it. */
  | 'exists'
  /** More than a limit allows: see `limit`. */
  | 'too-large'
  /** The export could not be made: `details` says why. */
  | 'export'
  /** The views could not be drawn: `details` says why. */
  | 'render'
  /** A regen for a render or an export ran over the session's regen limit. */
  | 'regen-timeout'
  /** The geometry kernel failed outside any feature. */
  | 'kernel'
  /** Writing the file failed (the system error code only). */
  | 'storage';

export interface ServerError {
  kind: 'server';
  code: ServerErrorCode;
  message: string;
  limit?: number;
  /** Messages from the packages that did the work, as data (they may quote the document). */
  details?: string[];
}

export type ToolError = Refusal | ServerError;

export function serverError(
  code: ServerErrorCode,
  message: string,
  extra: { limit?: number; details?: string[] } = {},
): ServerError {
  return {
    kind: 'server',
    code,
    message,
    ...(extra.limit === undefined ? {} : { limit: extra.limit }),
    ...(extra.details === undefined ? {} : { details: extra.details.slice(0, 50) }),
  };
}

export interface ResultLimits {
  /** UTF-8 bytes of a result's JSON. */
  jsonBytes: number;
}

export const DEFAULT_RESULT_LIMITS: ResultLimits = { jsonBytes: 256 * 1024 };

/** A successful result: `data`'s fields beside `ok: true`, held under the limit. */
export function okResult(
  data: Record<string, unknown>,
  limits: ResultLimits,
  extra: CallToolResult['content'] = [],
): CallToolResult {
  const bounded = boundJson(data, limits.jsonBytes);
  const fields =
    bounded.value !== null && typeof bounded.value === 'object'
      ? (bounded.value as Record<string, unknown>)
      : {};
  const structured: Record<string, unknown> = {
    ok: true,
    ...fields,
    ...(bounded.truncated.length > 0
      ? { truncated: { limit: limits.jsonBytes, cuts: bounded.truncated } }
      : {}),
  };
  return {
    structuredContent: structured,
    content: [{ type: 'text', text: JSON.stringify(structured) }, ...extra],
  };
}

/** A refusal or failure, as data. */
export function errorResult(error: ToolError, limits: ResultLimits): CallToolResult {
  const bounded = boundJson(error, limits.jsonBytes);
  const structured = {
    ok: false,
    error: bounded.value ?? serverError('too-large', 'The error was too large to show.'),
  };
  return {
    isError: true,
    structuredContent: structured,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
  };
}

export type { Truncation };
