// App state that names features follows sync's renames (ADR 0009 decision 5; plan risk "Remapping
// ids under an open dialog or a selection"): when a rebase renames ids (another browser took
// `extrude#3`, so this browser's becomes `extrude#4`), the selection and an open feature dialog
// are moved to the new id where there is one, and dropped or closed where there is not.

import type { RenameTable } from '@manufakture/core';
import {
  FEATURE_KIND,
  isGeometryRef,
  type SelectableItem,
  type SelectionStore,
} from '../state/selection';

/** The renames of part `partId`'s features and other part-scoped ids, if any. */
function partRenames(
  table: RenameTable,
  partId: string,
): Readonly<Record<string, string | null>> | undefined {
  const scope = `part:${partId}`;
  return Object.hasOwn(table, scope) ? table[scope] : undefined;
}

/**
 * Feature `featureId` of part `partId` after the renames: the same id (not renamed), the new id,
 * or null (it no longer exists under any id).
 */
export function renamedFeature(
  table: RenameTable,
  partId: string,
  featureId: string,
): string | null {
  const renames = partRenames(table, partId);
  if (renames === undefined || !Object.hasOwn(renames, featureId)) return featureId;
  return renames[featureId] ?? null;
}

/**
 * The selection after the renames: a selected feature takes its new id, or leaves the selection
 * when it has none. A face, edge or vertex of the part is dropped when anything of the part was
 * renamed, since its name may embed a renamed id.
 */
export function followSelection(
  selection: SelectionStore,
  table: RenameTable,
  partId: string,
): void {
  const renames = partRenames(table, partId);
  if (renames === undefined || Object.keys(renames).length === 0) return;
  const { selected } = selection.getState();
  const next: SelectableItem[] = [];
  let changed = false;
  for (const item of selected) {
    if (item.kind === FEATURE_KIND) {
      const id = renamedFeature(table, partId, item.id);
      if (id !== item.id) changed = true;
      if (id !== null) next.push(id === item.id ? item : { ...item, id });
    } else if (isGeometryRef(item) && item.bodyId.startsWith(`${partId}/`)) {
      changed = true;
    } else {
      next.push(item);
    }
  }
  if (changed) selection.getState().select(next);
  // A hovered feature or sub-shape may name an old id too.
  const hovered = selection.getState().hovered;
  if (
    hovered !== null &&
    (hovered.kind === FEATURE_KIND
      ? renamedFeature(table, partId, hovered.id) !== hovered.id
      : isGeometryRef(hovered) && hovered.bodyId.startsWith(`${partId}/`))
  ) {
    selection.getState().setHovered(null);
  }
}

/**
 * An open dialog after the renames: one editing a renamed feature is opened on its new id (so it
 * reads the feature again), one whose feature is gone is closed (null), any other is kept.
 */
export function followDialog<D extends { featureId?: string }>(
  dialog: D | null,
  table: RenameTable,
  partId: string,
): D | null {
  if (dialog === null || dialog.featureId === undefined) return dialog;
  const id = renamedFeature(table, partId, dialog.featureId);
  if (id === dialog.featureId) return dialog;
  return id === null ? null : { ...dialog, featureId: id };
}
