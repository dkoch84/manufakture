// What the assembly workspace shows besides the document: which panel is open (Insert, the Mate
// dialog for a new or an existing mate, Interference or Explode), poses shown in place of the solved ones
// while a drag or a mate preview is in progress, and the last interference check with the pair it
// highlights, and the Explode panel's view, slider, axis, checked instances and dragged step (T4.5a).
// Not document state: none of it is saved or undone.
//
// Shown poses outlive the gesture that made them until the model catches up: a drag commits its
// poses with `setPoses` on release, and the instances must not jump back to where they were
// while that regen runs. `until` names the document whose regen makes them redundant.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DraggedStep, ExplodeAxis } from './explode';
import type { InterferenceView } from './interference';

export type AssemblyPanel =
  | { kind: 'insert' }
  | { kind: 'mate'; mateId: string | null }
  | { kind: 'interference' }
  | { kind: 'explode' };

/**
 * The Explode panel: the exploded view it shows (null: none chosen yet; the viewport shows it
 * only while the panel is open), how far the slider is (0 assembled, 1 exploded), the axis new
 * steps go along, the instances a new step moves, and the step being dragged in the view.
 */
export interface ExplodeUi {
  viewId: string | null;
  progress: number;
  axis: ExplodeAxis;
  checked: readonly string[];
  dragged: DraggedStep | null;
}

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
  explode: ExplodeUi;
  setExplode(patch: Partial<ExplodeUi>): void;
}

export type AssemblyUiStore = StoreApi<AssemblyUiState>;

const NONE: ReadonlyMap<string, Pose> = new Map();

export const INITIAL_EXPLODE: ExplodeUi = {
  viewId: null,
  progress: 1,
  axis: '+z',
  checked: [],
  dragged: null,
};

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
    close: () =>
      set((s) => ({
        panel: null,
        interference: null,
        highlight: null,
        explode: { ...s.explode, dragged: null },
      })),
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
    explode: INITIAL_EXPLODE,
    setExplode: (patch) => set((s) => ({ explode: { ...s.explode, ...patch } })),
  }));
}
