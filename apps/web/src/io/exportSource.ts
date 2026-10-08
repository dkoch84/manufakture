// The branch the open document is on, as the export gate reads it (M8 plan T8.3c, ADR 0016
// decision 12). The app sets it whenever the open branch or its record changes (`App.tsx`, before
// the browser paints); every fabrication export reads it when it runs, passes it to the entry
// point, which refuses an agent's unreviewed branch, and the export dialogs show the refusal.
//
// It starts unknown (null), and an unknown source is refused: a dialog rendered before the app has
// said which branch is open, or outside the app, exports nothing.

import { exportAllowed, type ExportSource } from '@manufakture/io';
import { MAIN_BRANCH, type Branch } from '@manufakture/library';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export const exportSourceStore = createStore<{ source: ExportSource | null }>()(() => ({
  source: null,
}));

/** The source to pass to an export entry point now. */
export const currentExportSource = (): ExportSource | null => exportSourceStore.getState().source;

/** Why a fabrication export from the open branch is refused now, or null when it is allowed. */
export function exportRefusal(source: ExportSource | null = currentExportSource()): string | null {
  const verdict = exportAllowed(source);
  return verdict.ok ? null : verdict.message;
}

/** `exportRefusal`, kept current in a component. */
export function useExportRefusal(): string | null {
  return exportRefusal(useStore(exportSourceStore, (s) => s.source));
}

/**
 * The source for branch `branch` of the open document: main, or that branch's record as the
 * library lists it in `branches`. Null (refused) when the branch is not listed: not read yet, or
 * gone.
 */
export function branchExportSource(
  branch: string,
  branches: readonly Branch[] | null,
): ExportSource | null {
  if (branch === MAIN_BRANCH) return { id: MAIN_BRANCH };
  return branches?.find((b) => b.id === branch) ?? null;
}
