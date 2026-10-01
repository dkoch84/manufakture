// What the assembly workspace shows besides the document: which panel is open (Insert, the Mate
// dialog for a new or an existing mate, or Interference), poses shown in place of the solved ones
// while a drag or a mate preview is in progress, and the last interference check with the pair it
// highlights. Not document state: none of it is saved or undone.
//
// Shown poses outlive the gesture that made them until the model catches up: a drag commits its
// poses with `setPoses` on release, and the instances must not jump back to where they were
// while that regen runs. `until` names the document whose regen makes them redundant.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { InterferenceView } from './interference';

export type AssemblyPanel =
  { kind: 'insert' } | { kind: 'mate'; mateId: string | null } | { kind: 'interference' };

export interface AssemblyUiState {
  panel: AssemblyPanel | null;
  /** Poses shown in place of the solved ones, by instance id, for assembly `posesFor`. */
  poses: ReadonlyMap<string, Pose>;
  posesFor: string | null;
  /** Clear the poses once the model shows this document (null: keep them until cleared). */
  until: ManufaktureDocument | null;
  /** The last thing that went wrong (a refused command, a drag that could not start). */
  message: string | null;
  /** The Interference panel's check (null: none yet); dropped with the panel. */
  interference: InterferenceView | null;
  /** The key (`pairKey`) of the pair whose instances and overlap the view highlights. */
  highlight: string | null;

  open(panel: AssemblyPanel): void;
  close(): void;
  show(assemblyId: string, poses: ReadonlyMap<string, Pose>): void;
  /** Keep showing the poses until the model shows `document`. */
  holdUntil(document: ManufaktureDocument): void;
  clearPoses(): void;
  setMessage(message: string | null): void;
  setInterference(view: InterferenceView | null): void;
  /** Update the check of run `run`; a check that was replaced (or dropped) is left alone. */
  updateInterference(run: number, update: (view: InterferenceView) => InterferenceView): void;
  setHighlight(key: string | null): void;
}

export type AssemblyUiStore = StoreApi<AssemblyUiState>;

const NONE: ReadonlyMap<string, Pose> = new Map();

export function createAssemblyUiStore(): AssemblyUiStore {
  return createStore<AssemblyUiState>()((set, get) => ({
    panel: null,
    poses: NONE,
    posesFor: null,
    until: null,
    message: null,
    interference: null,
    highlight: null,
    open: (panel) =>
      set(
        panel.kind === 'interference'
          ? { panel, message: null }
          : { panel, message: null, interference: null, highlight: null },
      ),
    close: () => set({ panel: null, interference: null, highlight: null }),
    show: (assemblyId, poses) => set({ poses, posesFor: assemblyId, until: null }),
    holdUntil: (document) => {
      if (get().poses.size > 0) set({ until: document });
    },
    clearPoses: () => {
      if (get().poses.size > 0 || get().posesFor !== null) {
        set({ poses: NONE, posesFor: null, until: null });
      }
    },
    setMessage: (message) => set({ message }),
    setInterference: (interference) => set({ interference, highlight: null }),
    updateInterference: (run, update) => {
      const current = get().interference;
      if (current !== null && current.run === run) set({ interference: update(current) });
    },
    setHighlight: (highlight) => set({ highlight }),
  }));
}
