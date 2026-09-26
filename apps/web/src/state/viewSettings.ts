// Viewport display settings. The navigation preset and the projection are
// user preferences and persist in localStorage; the section plane and display
// toggles are per session.

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
  setPreset(preset: PresetId): void;
  setProjection(projection: Projection): void;
  toggleProjection(): void;
  setSection(patch: Partial<SectionSettings>): void;
  setShowEdges(show: boolean): void;
  setShowGrid(show: boolean): void;
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

export type ViewSettingsStore = StoreApi<ViewSettingsState>;

export const viewSettingsStore: ViewSettingsStore = createViewSettingsStore();

export function useViewSettings<T>(selector: (state: ViewSettingsState) => T): T {
  return useStore(viewSettingsStore, selector);
}
