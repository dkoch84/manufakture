// What the print workspace shows besides the document (M3 plan, T3.1d): whether it is open, the
// active setup and item, the shading mode, whether the next click lays an item flat, and the issue
// the view is framing. Not document state: none of it is saved or undone. The setups themselves
// live in the document (`doc.print`, ADR 0012 decision 1).

import type { ManufaktureDocument, PrintSetup } from '@manufakture/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** How the print workspace colours the bodies. */
export type PrintShading = 'normal' | 'overhang' | 'thickness';

export interface PrintUiState {
  open: boolean;
  /** The setup being worked on; null or a removed id falls back to the first (`activeSetup`). */
  setupId: string | null;
  /** The item the orientation tools act on; null or a removed id: the setup's first item. */
  itemId: string | null;
  shading: PrintShading;
  /** The next face clicked in the view lays the item it belongs to flat on the bed. */
  layingFlat: boolean;
  /** The key of the issue the view frames, or null. */
  focus: string | null;
  /** The last thing that went wrong (a refused command, a pick that is not a planar face). */
  message: string | null;

  setOpen(open: boolean): void;
  setSetup(setupId: string | null): void;
  setItem(itemId: string | null): void;
  setShading(shading: PrintShading): void;
  setLayingFlat(on: boolean): void;
  setFocus(key: string | null): void;
  setMessage(message: string | null): void;
}

export type PrintUiStore = StoreApi<PrintUiState>;

export function createPrintUiStore(): PrintUiStore {
  return createStore<PrintUiState>()((set) => ({
    open: false,
    setupId: null,
    itemId: null,
    shading: 'overhang',
    layingFlat: false,
    focus: null,
    message: null,
    setOpen: (open) => set(open ? { open } : { open, layingFlat: false, focus: null }),
    setSetup: (setupId) => set({ setupId, itemId: null, focus: null, layingFlat: false }),
    setItem: (itemId) => set({ itemId }),
    setShading: (shading) => set({ shading }),
    setLayingFlat: (layingFlat) => set({ layingFlat, message: null }),
    setFocus: (focus) => set({ focus }),
    setMessage: (message) => set({ message }),
  }));
}

/** The setup the workspace shows: the chosen one while it exists, else the document's first. */
export function activeSetup(
  doc: ManufaktureDocument,
  setupId: string | null,
): PrintSetup | undefined {
  return (
    (setupId === null ? undefined : doc.print.setups.find((s) => s.id === setupId)) ??
    doc.print.setups[0]
  );
}

/** The item the orientation tools act on: the chosen one while it exists, else the first. */
export function activeItemId(setup: PrintSetup | undefined, itemId: string | null): string | null {
  if (!setup) return null;
  return (
    (itemId === null ? undefined : setup.items.find((i) => i.id === itemId))?.id ??
    setup.items[0]?.id ??
    null
  );
}
