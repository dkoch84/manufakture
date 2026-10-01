// What the assembly workspace shows besides the document: which panel is open (Insert, or the
// Mate dialog for a new or an existing mate), and poses shown in place of the solved ones while a
// drag or a mate preview is in progress. Not document state: none of it is saved or undone.
//
// Shown poses outlive the gesture that made them until the model catches up: a drag commits its
// poses with `setPoses` on release, and the instances must not jump back to where they were
// while that regen runs. `until` names the document whose regen makes them redundant.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type AssemblyPanel = { kind: 'insert' } | { kind: 'mate'; mateId: string | null };

export interface AssemblyUiState {
  panel: AssemblyPanel | null;
  /** Poses shown in place of the solved ones, by instance id, for assembly `posesFor`. */
  poses: ReadonlyMap<string, Pose>;
  posesFor: string | null;
  /** Clear the poses once the model shows this document (null: keep them until cleared). */
  until: ManufaktureDocument | null;
  /** The last thing that went wrong (a refused command, a drag that could not start). */
  message: string | null;

  open(panel: AssemblyPanel): void;
  close(): void;
  show(assemblyId: string, poses: ReadonlyMap<string, Pose>): void;
  /** Keep showing the poses until the model shows `document`. */
  holdUntil(document: ManufaktureDocument): void;
  clearPoses(): void;
  setMessage(message: string | null): void;
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
    open: (panel) => set({ panel, message: null }),
    close: () => set({ panel: null }),
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
  }));
}
