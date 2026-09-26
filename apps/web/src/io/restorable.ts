// Which imported reference bodies can still come back: the import features in the document or
// in the undo and redo history. Apart from actions.ts, so the app can prune reference bodies on
// every document change without loading the import and export code, which is loaded on first use.

import type { Command, ManufaktureDocument } from '@manufakture/core';

/** Collect the ids of every import feature inside `value` (a command, a feature list). */
function collectImportIds(value: unknown, out: Set<string>, depth = 0): void {
  // Commands nest a few levels (batch, feature, sketch entities); strings are skipped,
  // so a stored file is never scanned.
  if (depth > 32 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectImportIds(v, out, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  if (o.kind === 'import' && typeof o.id === 'string') out.add(o.id);
  for (const v of Object.values(o)) collectImportIds(v, out, depth + 1);
}

/**
 * The import features that are in the document or that undo or redo can
 * bring back: the ones whose reference bodies must be kept. A body whose
 * import is in neither can be dropped for good (its kernel shape released).
 */
export function restorableImportIds(
  document: ManufaktureDocument,
  history: readonly { command: Command }[],
): Set<string> {
  const ids = new Set<string>();
  for (const part of document.parts) collectImportIds(part.features, ids);
  for (const entry of history) collectImportIds(entry.command, ids);
  return ids;
}
