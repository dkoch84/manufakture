import { MAX_DOCUMENT_NAME } from '@manufakture/core';
import { z } from 'zod';

/**
 * Named versions and branches on the server (ADR 0009 decision 9, T7.1e): plain records beside the
 * command logs, shared by the server (which validates every one it is sent) and the app (which
 * validates every one it reads). No transport here; apps/server carries them over HTTP.
 *
 * - A **version** names a revision of one branch's server log, for good: append-only, keyed by
 *   its id, which is the id the app gave it (a UUID), so a pin by `documentId` plus `versionId`
 *   means the same on every device.
 * - A **branch** is a second server log of the document, starting at revision 0 from the document
 *   of a version (`fromVersion`). Its id is the app's branch id. The main branch is `main` and has
 *   no record.
 */

/** The main branch, which every document has and no record describes. */
export const MAIN_BRANCH_ID = 'main';

/** A version or branch id: URL-safe, as the app makes them (UUIDs). */
export const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The longest version description (the app's `MAX_VERSION_DESCRIPTION`). */
export const MAX_RECORD_DESCRIPTION = 2000;

/** An agent token's id (`agent.<id>.<secret>`, T8.4b): 128 random bits, base64url. */
export const AGENT_TOKEN_ID = /^[A-Za-z0-9_-]{22}$/;

/** The largest review bundle, as JSON in UTF-8 bytes (the session's `MAX_BUNDLE_BYTES`). */
export const MAX_REVIEW_BUNDLE_BYTES = 64 * 1024 * 1024;

/** The longest time stamp kept (ISO 8601 is 24 characters). */
const MAX_TIME = 64;

const recordId = z.string().regex(RECORD_ID);
const name = z
  .string()
  .min(1)
  .max(MAX_DOCUMENT_NAME)
  .refine((s) => s.trim() === s, { message: 'a name has no surrounding spaces' });
const time = z
  .string()
  .min(1)
  .max(MAX_TIME)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'not a date' });

/** A named version on the server. */
export const ServerVersionSchema = z.strictObject({
  id: recordId,
  name,
  description: z.string().max(MAX_RECORD_DESCRIPTION),
  /** The branch whose log it names a revision of: `main` or a branch id. */
  branch: recordId,
  /** The revision of that branch's log; 0 is the state the branch started from. */
  rev: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** When it was made, ISO 8601, as the device that made it says. */
  createdAt: time,
  /**
   * Set by the server, never sent to it (T8.4b): the id of the agent token that made the version.
   * Absent: the owner made it. The app shows such a version as made by an agent.
   */
  createdBy: z.string().regex(AGENT_TOKEN_ID).exactOptional(),
});
export type ServerVersion = z.infer<typeof ServerVersionSchema>;

/** Where an agent branch stands in review (`@manufakture/library`'s `REVIEW_STATES`). */
export const REVIEW_STATES = [
  'open',
  'submitted',
  'changes-requested',
  'approved',
  'rejected',
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const ReviewStateSchema = z.enum(REVIEW_STATES);

/** A client's self-reported name, at most this many characters (the library's `MAX_CLIENT_NAME`). */
export const MAX_CLIENT_NAME = 200;
/** A reviewer's comment, at most this many characters (the library's `MAX_REVIEW_COMMENT`). */
export const MAX_REVIEW_COMMENT = 4000;

/** Whether `v` is a reviewer's comment as provenance keeps one (the library's `isReviewComment`). */
export const isReviewComment = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= MAX_REVIEW_COMMENT &&
  v.trim().length > 0 &&
  !/[\p{Cs}]|(?![\n\t])[\p{Cc}\p{Cf}]/u.test(v);

const clientName = z
  .string()
  .min(1)
  .max(MAX_CLIENT_NAME)
  .refine((s) => s.trim() === s && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(s), {
    message: 'a client name is plain text, not padded',
  });

/**
 * An agent branch's provenance on the server (ADR 0016 decision 9, T8.4b), checked as strictly as
 * the library's `parseProvenance` checks it: the session id is a storable id, the client name is
 * self-reported text (shown, never trusted), the review state one of the five, and the reviewer's
 * comment, when there is one, text of 1 to `MAX_REVIEW_COMMENT` characters. Only the server sets
 * the review state and the comment after the branch is made; it decides who may (README).
 */
export const ProvenanceSchema = z.strictObject({
  origin: z.literal('agent'),
  sessionId: z.string().regex(RECORD_ID),
  clientName,
  review: ReviewStateSchema,
  comment: z
    .string()
    .refine((s) => isReviewComment(s), { message: 'not a review comment' })
    .exactOptional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** A branch on the server (never the main branch). */
export const ServerBranchSchema = z.strictObject({
  id: recordId.refine((id) => id !== MAIN_BRANCH_ID, { message: 'main has no record' }),
  name,
  /** The version whose document is the branch's revision 0. */
  fromVersion: recordId,
  createdAt: time,
  /**
   * Set on an agent branch (T8.4b), absent on a person's. Fixed when the branch is made, except
   * its review state and comment, which change only through the review route.
   */
  provenance: ProvenanceSchema.exactOptional(),
});
export type ServerBranch = z.infer<typeof ServerBranchSchema>;

/** `POST /api/documents/:id/versions`. */
export const CreateVersionSchema = z.strictObject({ version: ServerVersionSchema });

/**
 * `POST /api/documents/:id/branches`. A new agent branch is `open` with no comment;
 * `commentFrom` names the agent branch an update from Main replaces, whose reviewer's comment the
 * server copies (same session and client), so the comment never comes from the agent.
 *
 * `startVersion` (an agent branch only, T8.4b) is the version of Main the branch starts from when
 * no version of Main's head is there yet: the server stores it with the branch, in one
 * transaction, recording the agent token that made it; it goes again when its branch is deleted
 * and nothing else starts from it. Its id is the branch's `fromVersion`.
 */
export const CreateBranchSchema = z.strictObject({
  branch: ServerBranchSchema,
  commentFrom: recordId.exactOptional(),
  startVersion: ServerVersionSchema.exactOptional(),
});

/**
 * `POST /api/documents/:id/branches/:branch/review`: a new review state, compare-and-set when
 * `expected` is given (the state, or one of the states, the branch must be in). `comment` sets
 * (a string) or removes (null) the reviewer's comment; absent keeps it.
 */
export const ReviewChangeSchema = z.strictObject({
  review: ReviewStateSchema,
  expected: z.union([ReviewStateSchema, z.array(ReviewStateSchema).min(1).max(5)]).exactOptional(),
  comment: z
    .union([
      z.string().refine((s) => isReviewComment(s), { message: 'not a review comment' }),
      z.null(),
    ])
    .exactOptional(),
});
export type ReviewChange = z.infer<typeof ReviewChangeSchema>;

/** The envelope a stored review bundle has (the session's `StoredBundle`; its content unchecked). */
export const REVIEW_BUNDLE_FORMAT = 'manufakture-review-bundle';

/** `PUT /api/documents/:id/branches/:branch/bundle`: a review bundle for head `revision`. */
export const PutBundleSchema = z.strictObject({
  /** The branch head revision it was built for, as the library counts (the server log's + 1). */
  revision: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  record: z.looseObject({
    format: z.literal(REVIEW_BUNDLE_FORMAT),
    documentId: z.string(),
    branch: z.string(),
    revision: z.int(),
  }),
});

/**
 * Whether two version records say the same (a resend of one stored is not a conflict). Who made
 * it (`createdBy`) is the server's to say, so it is left out.
 */
export function sameRecord(a: ServerVersion, b: ServerVersion): boolean {
  const keys = Object.keys(a)
    .filter((k) => k !== 'createdBy')
    .sort();
  const other = Object.keys(b)
    .filter((k) => k !== 'createdBy')
    .sort();
  if (keys.join() !== other.join()) return false;
  return keys.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/**
 * Whether `sent` is a resend of branch `stored`: the same id, name, version and time, and the
 * same origin (agent or person, the same session and client). The review state and comment are
 * left out: they may have moved since the branch was made.
 */
export function sameBranch(stored: ServerBranch, sent: ServerBranch): boolean {
  if (
    stored.id !== sent.id ||
    stored.name !== sent.name ||
    stored.fromVersion !== sent.fromVersion ||
    stored.createdAt !== sent.createdAt
  ) {
    return false;
  }
  const a = stored.provenance;
  const b = sent.provenance;
  if (a === undefined || b === undefined) return a === b;
  return a.sessionId === b.sessionId && a.clientName === b.clientName;
}
