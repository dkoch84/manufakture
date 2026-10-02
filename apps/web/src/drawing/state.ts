// Which drawing tab is open (M4 plan, T4.4g). A drawing tab is shown over the part studio or
// assembly tab, which stays as it was underneath; picking a part studio or assembly tab closes
// the drawing. `creating`: the New drawing form shows, before there is a drawing.

import { createStore, type StoreApi } from 'zustand/vanilla';

export interface DrawingUiState {
  drawingId: string | null;
  creating: boolean;
  open(drawingId: string): void;
  create(): void;
  close(): void;
}

export type DrawingUiStore = StoreApi<DrawingUiState>;

export function createDrawingUiStore(): DrawingUiStore {
  return createStore<DrawingUiState>()((set) => ({
    drawingId: null,
    creating: false,
    open: (drawingId) => set({ drawingId, creating: false }),
    create: () => set({ drawingId: null, creating: true }),
    close: () => set({ drawingId: null, creating: false }),
  }));
}
