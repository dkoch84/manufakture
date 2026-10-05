// Which imported reference bodies can still come back: the import features in the document or
// in the undo and redo history. Apart from actions.ts, so the app can prune reference bodies on
// every document change without loading the import and export code, which is loaded on first use.

import type { Command, ManufaktureDocument } from '@manufakture/core';
import { visitJson } from '../persistence/walk';

/**
 * The viewport and kernel id of the reference body of import feature `featureId` in part studio
 * `partId`. Feature ids are counted per part, so two part studios can both have `import#1`.
 */
export function importBodyId(partId: string, featureId: string): string {
  return `${partId}/${featureId}`;
}

/**
 * Collect the body ids of every import feature inside `value` (a command, a part, a feature
 * list), qualified with the part it is in: the `partId` of the command that holds it, or the id
 * of the part (a `restorePart` carries a whole part).
 */
function collectImportIds(value: unknown, partId: string | null, out: Set<string>): void {
  visitJson(
    value,
    partId,
    (o, part) => {
      // The qualifier follows the shape of the commands that carry features: `addFeature`,
      // `editFeature` and `restoreFeature` name their part in `partId`, and `restorePart` holds
      // a whole part (an object with `id`, `features` and `nextIds`). A new command that carries
      // features some other way must be added here, or its imports are not kept.
      let inner = part;
      if (typeof o.partId === 'string') inner = o.partId;
      else if (
        typeof o.id === 'string' &&
        Array.isArray(o.features) &&
        typeof o.nextIds === 'object'
      ) {
        inner = o.id;
      }
      if (o.kind === 'import' && typeof o.id === 'string' && inner !== null) {
        out.add(importBodyId(inner, o.id));
      }
      return inner;
    },
    // Commands nest a few levels (batch, part, feature, sketch entities); strings are leaves, so
    // a stored file is never scanned. Anything deeper is not a command's feature and is skipped.
    { maxDepth: 32 },
  );
}

/**
 * The import features that are in the document or that undo or redo can
 * bring back, by body id (`importBodyId`): the ones whose reference bodies must be kept. A body
 * whose import is in neither can be dropped for good (its kernel shape released).
 */
export function restorableImportIds(
  document: ManufaktureDocument,
  history: readonly { command: Command }[],
): Set<string> {
  const ids = new Set<string>();
  for (const part of document.parts) collectImportIds(part.features, part.id, ids);
  for (const entry of history) collectImportIds(entry.command, null, ids);
  return ids;
}
