// Errors as data (ADR 0007 decision 5; M8 plan cross-cutting decision 6): every expected failure
// of a session is a value the caller reads, never a throw. Core's refusals keep their `CoreError`;
// everything the session itself refuses (a limit, a branch in the wrong state, a write aimed at
// Main) is a `SessionError` with a code of its own.

import type { CoreError } from '@manufakture/core';

/** Why the session refused, or could not do, what was asked. */
export type SessionErrorCode =
  /** The session was closed (by the caller, or after it was idle). */
  | 'closed'
  /** A write would land on Main, which an agent never writes (ADR 0016 decision 12). */
  | 'main-refused'
  /** The branch is not an agent branch, or not in a review state the call allows. */
  | 'branch-state'
  /** The branch, document or version asked for is not there. */
  | 'not-found'
  /** Another session holds the branch's lock. */
  | 'locked'
  /** This session's branch lock was broken (another process took the branch). */
  | 'lock-lost'
  /** More commands in one batch than `SessionLimits.commandsPerBatch`. */
  | 'too-many-commands'
  /** More batches than `SessionLimits.batchesPerSession`. */
  | 'too-many-batches'
  /** The regen of a batch ran over `SessionLimits.regenMsPerBatch`; the batch was rolled back. */
  | 'regen-timeout'
  /**
   * A kernel call (a measurement, a STEP read) ran over `SessionLimits.kernelMsPerCall`: the
   * kernel was ended (a worker engine) and started again.
   */
  | 'kernel-timeout'
  /** Batches nested deeper than `MAX_BATCH_DEPTH`, or JSON deeper than `MAX_JSON_DEPTH`. */
  | 'too-deep'
  /** The document would be larger than `SessionLimits.documentBytes`. */
  | 'document-too-large'
  /** More open sessions than `SessionLimits.sessionsPerProcess`. */
  | 'too-many-sessions'
  /** A label that is empty, too long, or holds control characters. */
  | 'invalid-label'
  /** A symbolic id (`extrude#$boss`) that cannot be resolved: see the message. */
  | 'symbol'
  /** The batch changes nothing. */
  | 'no-change'
  /** Nothing to undo: no batch of this branch is left. */
  | 'nothing-to-undo'
  /** An input the session does not take (a query, a client name, a note): see the message. */
  | 'invalid-input'
  /** The library could not read or write (a damaged file, a full disk): see the message. */
  | 'storage'
  /** The geometry kernel failed outside any feature (it could not start, or crashed). */
  | 'kernel'
  /** The review bundle could not be built or stored. */
  | 'bundle';

export interface SessionError {
  readonly kind: 'session';
  readonly code: SessionErrorCode;
  readonly message: string;
  /** For limits: the limit that was hit. */
  readonly limit?: number;
}

/** A refusal: core's (with its `CoreError`), or the session's own. */
export type Refusal = { readonly kind: 'core'; readonly error: CoreError } | SessionError;

export type SessionResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Refusal };

export function sessionError(
  code: SessionErrorCode,
  message: string,
  limit?: number,
): { ok: false; error: SessionError } {
  return {
    ok: false,
    error: { kind: 'session', code, message, ...(limit === undefined ? {} : { limit }) },
  };
}

export function coreRefusal(error: CoreError): { ok: false; error: Refusal } {
  return { ok: false, error: { kind: 'core', error } };
}

export function done<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
