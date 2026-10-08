// The export gate (M8 plan T8.3c, ADR 0016 decision 12): no fabrication file is made from an
// agent's unreviewed work. Every fabrication entry point takes the branch its document comes from
// (`ExportSource`) as a required argument (null where the caller does not know it, which is
// refused) and asks `exportAllowed` before it writes a byte.
//
// The rule lives here, not in `@manufakture/library`, because every package with a fabrication
// entry point depends on this one, and the library depends on it too; the library exports the
// same function under the same name, with its `Branch` record as the argument.
//
// It fails closed: a source that is missing, is not a branch record, or carries provenance that
// does not read as an approved agent branch is refused. Only a record with no provenance (main,
// or a person's branch) or with an agent's provenance in review state `approved` passes.

/**
 * The branch a fabrication export reads from, as the library lists it (`Branch`): its id, and
 * the provenance an agent's branch carries. Main and a person's branch have none.
 */
export interface ExportSource {
  readonly id: string;
  readonly provenance?: { readonly origin: 'agent'; readonly review: string } | undefined;
}

export type ExportVerdict = { ok: true } | { ok: false; message: string };

/** Why an export from an agent's branch that is not approved is refused. */
export const UNREVIEWED_EXPORT =
  "This is an agent's unreviewed branch. Review it in History first.";

/** Why an export whose branch is not known is refused. */
export const UNKNOWN_EXPORT_SOURCE =
  'It is not known which branch this comes from, so nothing is exported. Open the branch again.';

/** Thrown by the entry points that return a file rather than a result when the gate refuses. */
export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a fabrication file may be made from branch `source`: yes for main and a person's
 * branch (no provenance), and for an agent's branch in review state `approved`; no for an agent's
 * branch in any other state (`open`, `submitted`, `changes-requested`, `rejected`, or a state
 * this release does not know), and no for anything that is not a branch record.
 */
export function exportAllowed(source: ExportSource | null | undefined): ExportVerdict {
  if (!isRecord(source)) return { ok: false, message: UNKNOWN_EXPORT_SOURCE };
  const { id, provenance } = source as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, message: UNKNOWN_EXPORT_SOURCE };
  }
  if (provenance === undefined) return { ok: true };
  if (isRecord(provenance) && provenance.origin === 'agent' && provenance.review === 'approved') {
    return { ok: true };
  }
  return { ok: false, message: UNREVIEWED_EXPORT };
}

/** `exportAllowed`, throwing `ExportRefusedError` with the reason when it refuses. */
export function assertExportAllowed(source: ExportSource | null | undefined): void {
  const verdict = exportAllowed(source);
  if (!verdict.ok) throw new ExportRefusedError(verdict.message);
}
