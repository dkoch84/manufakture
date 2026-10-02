// Viewport display settings. The navigation preset and the projection are
// user preferences and persist in localStorage; the section plane and display
// toggles are per session. So are the hidden bodies, kept per document: hiding
// a body is view state like the camera, never an undo step and never in the
// file (M2 plan, decision 5). The slicer chosen for Open in slicer, and the slicers whose
// hand-off help was dismissed, are preferences too and persist (M3 plan, T3.3b).

import { createStore, type StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useStore } from 'zustand';
import { DEFAULT_PRESET, isPresetId, type PresetId } from '../viewport/navigation';

export type Projection = 'perspective' | 'orthographic';
export type Axis = 'x' | 'y' | 'z';

/** The slicers Open in slicer has help for (ADR 0012 decision 11); OrcaSlicer is the default. */
export const SLICER_IDS = ['orcaslicer', 'bambustudio', 'prusaslicer'] as const;
export type SlicerId = (typeof SLICER_IDS)[number];
export const DEFAULT_SLICER: SlicerId = 'orcaslicer';

export function isSlicerId(value: unknown): value is SlicerId {
  return typeof value === 'string' && (SLICER_IDS as readonly string[]).includes(value);
}

export interface SectionSettings {
  enabled: boolean;
  axis: Axis;
  /** Position of the plane along the axis, as a fraction 0..1 of the model's bounds. */
  position: number;
  /** Keep the other side. */
  flipped: boolean;
}

export interface ViewSettingsState {
  preset: PresetId;
  projection: Projection;
  section: SectionSettings;
  showEdges: boolean;
  showGrid: boolean;
  /** Per document id: the viewport ids of the bodies hidden in it (`<part id>/<body id>`). */
  hiddenBodies: Readonly<Record<string, readonly string[]>>;
  /** The slicer Open in slicer explains how to open the file in. */
  slicer: SlicerId;
  /** Slicers whose hand-off help was closed: it is not shown again unless asked for. */
  slicerHelpDismissed: readonly SlicerId[];
  setPreset(preset: PresetId): void;
  setProjection(projection: Projection): void;
  toggleProjection(): void;
  setSection(patch: Partial<SectionSettings>): void;
  setShowEdges(show: boolean): void;
  setShowGrid(show: boolean): void;
  /** Hide or show one body of document `documentId`. */
  setBodyHidden(documentId: string, bodyId: string, hidden: boolean): void;
  /** Replace which bodies of `among` are hidden in `documentId`: exactly `hidden` of them. */
  setHiddenBodies(documentId: string, among: readonly string[], hidden: readonly string[]): void;
  setSlicer(slicer: SlicerId): void;
  /** Do not show the hand-off help for `slicer` on its own again. */
  dismissSlicerHelp(slicer: SlicerId): void;
}

const NO_BODIES: readonly string[] = [];

/** The bodies hidden in a document, as a set of viewport body ids. */
export function hiddenBodiesOf(
  state: Pick<ViewSettingsState, 'hiddenBodies'>,
  documentId: string,
): readonly string[] {
  return state.hiddenBodies[documentId] ?? NO_BODIES;
}

export const VIEW_SETTINGS_KEY = 'manufakture.viewport';

export const DEFAULT_SECTION: SectionSettings = {
  enabled: false,
  axis: 'y',
  position: 0.5,
  flipped: false,
};

type Persisted = Pick<
  ViewSettingsState,
  'preset' | 'projection' | 'slicer' | 'slicerHelpDismissed'
>;

export function createViewSettingsStore(storage: () => Storage = () => localStorage) {
  return createStore<ViewSettingsState>()(
    persist(
      (set, get) => ({
        preset: DEFAULT_PRESET,
        projection: 'perspective',
        section: DEFAULT_SECTION,
        showEdges: true,
        showGrid: true,
        hiddenBodies: {},
        slicer: DEFAULT_SLICER,
        slicerHelpDismissed: [],
        setPreset: (preset) => set({ preset }),
        setProjection: (projection) => set({ projection }),
        toggleProjection: () =>
          set({ projection: get().projection === 'perspective' ? 'orthographic' : 'perspective' }),
        setSection: (patch) => {
          const next = { ...get().section, ...patch };
          next.position = Math.min(1, Math.max(0, next.position));
          set({ section: next });
        },
        setShowEdges: (showEdges) => set({ showEdges }),
        setShowGrid: (showGrid) => set({ showGrid }),
        setBodyHidden: (documentId, bodyId, hidden) => {
          const now = hiddenBodiesOf(get(), documentId);
          if (now.includes(bodyId) === hidden) return;
          const next = hidden ? [...now, bodyId] : now.filter((b) => b !== bodyId);
          set({ hiddenBodies: withEntry(get().hiddenBodies, documentId, next) });
        },
        setHiddenBodies: (documentId, among, hidden) => {
          const now = hiddenBodiesOf(get(), documentId);
          const next = [...now.filter((b) => !among.includes(b)), ...hidden];
          if (next.length === now.length && next.every((b) => now.includes(b))) return;
          set({ hiddenBodies: withEntry(get().hiddenBodies, documentId, next) });
        },
        setSlicer: (slicer) => {
          if (isSlicerId(slicer)) set({ slicer });
        },
        dismissSlicerHelp: (slicer) => {
          const now = get().slicerHelpDismissed;
          if (!isSlicerId(slicer) || now.includes(slicer)) return;
          set({ slicerHelpDismissed: [...now, slicer] });
        },
      }),
      {
        name: VIEW_SETTINGS_KEY,
        version: 1,
        storage: createJSONStorage(storage),
        partialize: (s): Persisted => ({
          preset: s.preset,
          projection: s.projection,
          slicer: s.slicer,
          slicerHelpDismissed: s.slicerHelpDismissed,
        }),
        // Stored data comes from an older or newer build, or was edited by hand.
        merge: (stored, current) => {
          const s = (stored ?? {}) as Partial<Persisted>;
          return {
            ...current,
            preset: isPresetId(s.preset) ? s.preset : current.preset,
            projection:
              s.projection === 'orthographic' || s.projection === 'perspective'
                ? s.projection
                : current.projection,
            slicer: isSlicerId(s.slicer) ? s.slicer : current.slicer,
            slicerHelpDismissed: Array.isArray(s.slicerHelpDismissed)
              ? [...new Set(s.slicerHelpDismissed.filter(isSlicerId))]
              : current.slicerHelpDismissed,
          };
        },
      },
    ),
  );
}

function withEntry(
  all: Readonly<Record<string, readonly string[]>>,
  documentId: string,
  ids: readonly string[],
): Record<string, readonly string[]> {
  const out = { ...all };
  if (ids.length === 0) delete out[documentId];
  else out[documentId] = ids;
  return out;
}

export type ViewSettingsStore = StoreApi<ViewSettingsState>;

export const viewSettingsStore: ViewSettingsStore = createViewSettingsStore();

export function useViewSettings<T>(selector: (state: ViewSettingsState) => T): T {
  return useStore(viewSettingsStore, selector);
}
