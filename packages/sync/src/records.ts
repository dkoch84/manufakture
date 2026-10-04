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
});
export type ServerVersion = z.infer<typeof ServerVersionSchema>;

/** A branch on the server (never the main branch). */
export const ServerBranchSchema = z.strictObject({
  id: recordId.refine((id) => id !== MAIN_BRANCH_ID, { message: 'main has no record' }),
  name,
  /** The version whose document is the branch's revision 0. */
  fromVersion: recordId,
  createdAt: time,
});
export type ServerBranch = z.infer<typeof ServerBranchSchema>;

/** `POST /api/documents/:id/versions`. */
export const CreateVersionSchema = z.strictObject({ version: ServerVersionSchema });

/** `POST /api/documents/:id/branches`. */
export const CreateBranchSchema = z.strictObject({ branch: ServerBranchSchema });

/** Whether two records say the same (a resend of one already stored is not a conflict). */
export function sameRecord<T extends ServerVersion | ServerBranch>(a: T, b: T): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  if (keys.join() !== other.join()) return false;
  return keys.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}
