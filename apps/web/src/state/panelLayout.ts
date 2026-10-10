// The editor's side panels: how wide each one is and whether it is collapsed. A per-device
// preference like the navigation preset, so it persists in localStorage and never goes in a
// document. A storage that throws (private windows, blocked site data) only loses the memory.

import { createStore, type StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist } from 'zustand/middleware';

export type PanelSide = 'left' | 'right';

export interface PanelState {
  /** Width in CSS pixels. */
  width: number;
  collapsed: boolean;
}

/** Narrowest and widest a panel may be dragged, in CSS pixels. */
export const PANEL_MIN_WIDTH = 180;
export const PANEL_MAX_WIDTH = 900;
/** The widths the panels had before they could be resized (15rem and 16rem). */
export const DEFAULT_PANELS: Readonly<Record<PanelSide, PanelState>> = {
  left: { width: 240, collapsed: false },
  right: { width: 256, collapsed: false },
};

export interface PanelLayoutState {
  left: PanelState;
  right: PanelState;
  setWidth(side: PanelSide, width: number): void;
  setCollapsed(side: PanelSide, collapsed: boolean): void;
  toggle(side: PanelSide): void;
}

export const PANEL_LAYOUT_KEY = 'manufakture.panels';

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_MIN_WIDTH;
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

function readPanel(value: unknown, fallback: PanelState): PanelState {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Partial<Record<keyof PanelState, unknown>>;
  return {
    width: typeof v.width === 'number' ? clampPanelWidth(v.width) : fallback.width,
    collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : fallback.collapsed,
  };
}

/** Storage that never throws: reads come back empty and writes are dropped when it fails. */
function safeStorage(storage: () => Storage): Storage {
  const attempt = <T>(f: (s: Storage) => T, otherwise: T): T => {
    try {
      return f(storage());
    } catch {
      return otherwise;
    }
  };
  return {
    get length() {
      return attempt((s) => s.length, 0);
    },
    clear: () => attempt((s) => s.clear(), undefined),
    getItem: (key) => attempt((s) => s.getItem(key), null),
    key: (index) => attempt((s) => s.key(index), null),
    removeItem: (key) => attempt((s) => s.removeItem(key), undefined),
    setItem: (key, value) => attempt((s) => s.setItem(key, value), undefined),
  };
}

export function createPanelLayoutStore(storage: () => Storage = () => localStorage) {
  return createStore<PanelLayoutState>()(
    persist(
      (set, get) => ({
        left: DEFAULT_PANELS.left,
        right: DEFAULT_PANELS.right,
        setWidth: (side, width) => {
          const next = clampPanelWidth(width);
          if (get()[side].width !== next) set({ [side]: { ...get()[side], width: next } });
        },
        setCollapsed: (side, collapsed) => {
          if (get()[side].collapsed !== collapsed) set({ [side]: { ...get()[side], collapsed } });
        },
        toggle: (side) => set({ [side]: { ...get()[side], collapsed: !get()[side].collapsed } }),
      }),
      {
        name: PANEL_LAYOUT_KEY,
        version: 1,
        storage: createJSONStorage(() => safeStorage(storage)),
        partialize: (s) => ({ left: s.left, right: s.right }),
        // Stored data comes from an older or newer build, or was edited by hand.
        merge: (stored, current) => {
          const s = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
            string,
            unknown
          >;
          return {
            ...current,
            left: readPanel(s.left, DEFAULT_PANELS.left),
            right: readPanel(s.right, DEFAULT_PANELS.right),
          };
        },
      },
    ),
  );
}

export type PanelLayoutStore = StoreApi<PanelLayoutState>;

export const panelLayoutStore: PanelLayoutStore = createPanelLayoutStore();
