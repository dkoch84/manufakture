// Viewport display settings. The navigation preset and the projection are
// user preferences and persist in localStorage; the section plane and display
// toggles are per session. So are the hidden bodies, kept per document: hiding
// a body is view state like the camera, never an undo step and never in the
// file (M2 plan, decision 5).

import { createStore, type StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useStore } from 'zustand';
import { DEFAULT_PRESET, isPresetId, type PresetId } from '../viewport/navigation';

export type Projection = 'perspective' | 'orthographic';
export type Axis = 'x' | 'y' | 'z';

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

type Persisted = Pick<ViewSettingsState, 'preset' | 'projection'>;

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
      }),
      {
        name: VIEW_SETTINGS_KEY,
        version: 1,
        storage: createJSONStorage(storage),
        partialize: (s): Persisted => ({ preset: s.preset, projection: s.projection }),
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
