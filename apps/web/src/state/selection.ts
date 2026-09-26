// Selection state shared by the viewport and, later, the sketcher (#929), the
// feature tree (#933) and the measure tool (#936).
//
// Items are identified by stable ids, never by mesh or topology indices (ADR
// 0007, decision 8): the viewport resolves a picked triangle or edge to its
// name before anything reaches this store. Other tools add their own item
// kinds (a sketch entity, a feature, a plane) by giving them a `kind` and an
// `id`; the store only relies on those two fields, and the selection filter
// is keyed by kind, so a new kind needs no change here.

import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

/** Anything selectable: `kind` plus an id that is stable within that kind. */
export interface SelectableItem {
  kind: string;
  id: string;
}

export type GeometryKind = 'face' | 'edge' | 'vertex';

export const GEOMETRY_KINDS: readonly GeometryKind[] = ['face', 'edge', 'vertex'];

/** A face, edge or vertex of a body, by name. */
export interface GeometryRef extends SelectableItem {
  kind: GeometryKind;
  bodyId: string;
  /** The naming layer's name for the sub-shape. */
  name: string;
  /** The name is positional and may move to another sub-shape after an edit (T0.5). */
  fragile: boolean;
  /**
   * The name is a viewport placeholder, not one from the naming layer (#931
   * has not filled it yet). Such a name must not be stored in the document.
   */
  placeholder: boolean;
}

export function geometryRef(
  kind: GeometryKind,
  bodyId: string,
  name: string,
  flags: { fragile?: boolean; placeholder?: boolean } = {},
): GeometryRef {
  return {
    kind,
    id: `${bodyId}/${name}`,
    bodyId,
    name,
    fragile: flags.fragile ?? false,
    placeholder: flags.placeholder ?? false,
  };
}

export function isGeometryRef(item: SelectableItem): item is GeometryRef {
  return (GEOMETRY_KINDS as readonly string[]).includes(item.kind) && 'bodyId' in item;
}

/** A feature of the part (the feature tree selects and hovers these), by feature id. */
export const FEATURE_KIND = 'feature';

export function featureItem(featureId: string): SelectableItem {
  return { kind: FEATURE_KIND, id: featureId };
}

export function isFeatureItem(item: SelectableItem | null): item is SelectableItem {
  return item !== null && item.kind === FEATURE_KIND;
}

export function itemKey(item: SelectableItem): string {
  return `${item.kind}:${item.id}`;
}

export function sameItem(a: SelectableItem | null, b: SelectableItem | null): boolean {
  if (a === null || b === null) return a === b;
  return itemKey(a) === itemKey(b);
}

/** replace: the item becomes the selection; add: it joins it; toggle: it joins or leaves it. */
export type SelectMode = 'replace' | 'add' | 'toggle';

/** Shift adds, Ctrl (Cmd on macOS) toggles, a plain click replaces. */
export function selectModeFor(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  if (e.ctrlKey || e.metaKey) return 'toggle' satisfies SelectMode;
  if (e.shiftKey) return 'add' satisfies SelectMode;
  return 'replace' satisfies SelectMode;
}

export interface SelectionState {
  /** In the order the user selected them; tools such as measure rely on the order. */
  selected: readonly SelectableItem[];
  hovered: SelectableItem | null;
  /** Kinds switched off in the selection filter. Kinds not listed are selectable. */
  disabledKinds: readonly string[];

  setHovered(item: SelectableItem | null): void;
  /** Apply a click. A click on nothing clears the selection in replace mode only. */
  click(item: SelectableItem | null, mode: SelectMode): void;
  /** Replace the selection, dropping duplicates and kinds the filter disables. */
  select(items: readonly SelectableItem[]): void;
  deselect(item: SelectableItem): void;
  clear(): void;
  /** Keep only items for which `keep` holds, e.g. after a regen removed some names. */
  prune(keep: (item: SelectableItem) => boolean): void;
  setKindEnabled(kind: string, enabled: boolean): void;
  isKindEnabled(kind: string): boolean;
  isSelected(item: SelectableItem): boolean;
}

export type SelectionStore = StoreApi<SelectionState>;

function unique(items: readonly SelectableItem[]): SelectableItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = itemKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function createSelectionStore(): SelectionStore {
  return createStore<SelectionState>()((set, get) => ({
    selected: [],
    hovered: null,
    disabledKinds: [],

    setHovered(item) {
      if (item !== null && !get().isKindEnabled(item.kind)) item = null;
      if (sameItem(item, get().hovered)) return;
      set({ hovered: item });
    },

    click(item, mode) {
      const { selected } = get();
      if (item === null || !get().isKindEnabled(item.kind)) {
        if (mode === 'replace' && selected.length > 0) set({ selected: [] });
        return;
      }
      const key = itemKey(item);
      const present = selected.some((s) => itemKey(s) === key);
      if (mode === 'replace') {
        if (selected.length === 1 && present) return;
        set({ selected: [item] });
      } else if (mode === 'add') {
        if (!present) set({ selected: [...selected, item] });
      } else if (present) {
        set({ selected: selected.filter((s) => itemKey(s) !== key) });
      } else {
        set({ selected: [...selected, item] });
      }
    },

    select(items) {
      set({ selected: unique(items.filter((i) => get().isKindEnabled(i.kind))) });
    },

    deselect(item) {
      const key = itemKey(item);
      const { selected } = get();
      if (selected.some((s) => itemKey(s) === key)) {
        set({ selected: selected.filter((s) => itemKey(s) !== key) });
      }
    },

    clear() {
      if (get().selected.length > 0) set({ selected: [] });
    },

    prune(keep) {
      const { selected, hovered } = get();
      const kept = selected.filter(keep);
      const patch: Partial<SelectionState> = {};
      if (kept.length !== selected.length) patch.selected = kept;
      if (hovered !== null && !keep(hovered)) patch.hovered = null;
      if (Object.keys(patch).length > 0) set(patch);
    },

    setKindEnabled(kind, enabled) {
      const { disabledKinds, hovered } = get();
      const has = disabledKinds.includes(kind);
      if (enabled === !has) return;
      const next = enabled ? disabledKinds.filter((k) => k !== kind) : [...disabledKinds, kind];
      // Keep what is already selected (as Onshape does); only the hover goes.
      set({
        disabledKinds: next,
        hovered: !enabled && hovered?.kind === kind ? null : hovered,
      });
    },

    isKindEnabled(kind) {
      return !get().disabledKinds.includes(kind);
    },

    isSelected(item) {
      const key = itemKey(item);
      return get().selected.some((s) => itemKey(s) === key);
    },
  }));
}

/** The app's selection. Tests create their own with `createSelectionStore()`. */
export const selectionStore: SelectionStore = createSelectionStore();

export function useSelection<T>(selector: (state: SelectionState) => T): T {
  return useStore(selectionStore, selector);
}
