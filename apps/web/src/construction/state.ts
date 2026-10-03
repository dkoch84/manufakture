// What the construction toolbar group and panels show, not stored anywhere: whether the
// Construction panel is open, which tool takes the side panel (the Wall tool, the Opening tool,
// or none), the active level the Wall tool draws on, and which documents' disclaimer notice was
// put away (shown again with Help).

import { createStore, type StoreApi } from 'zustand/vanilla';

export type ConstructionTool =
  { kind: 'wall' } | { kind: 'opening'; featureId: string | null; wall: string | null };

export interface ConstructionUiState {
  open: boolean;
  tool: ConstructionTool | null;
  /** The level the Wall tool draws on; null: the first level. */
  level: string | null;
  /** The wall whose framing settings the panel shows, or null. */
  editingWall: string | null;
  /** Documents whose disclaimer notice the user put away this session (by document id). */
  noticeHidden: ReadonlySet<string>;
  setOpen(open: boolean): void;
  startTool(tool: ConstructionTool): void;
  endTool(): void;
  setLevel(level: string | null): void;
  editWall(wallId: string | null): void;
  hideNotice(documentId: string): void;
}

export type ConstructionUiStore = StoreApi<ConstructionUiState>;

export function createConstructionUiStore(): ConstructionUiStore {
  return createStore<ConstructionUiState>()((set, get) => ({
    open: false,
    tool: null,
    level: null,
    editingWall: null,
    noticeHidden: new Set(),
    setOpen: (open) => set({ open }),
    startTool: (tool) => set({ tool, open: true }),
    endTool: () => set({ tool: null }),
    setLevel: (level) => set({ level }),
    editWall: (editingWall) => set({ editingWall }),
    hideNotice: (documentId) => {
      if (get().noticeHidden.has(documentId)) return;
      set({ noticeHidden: new Set([...get().noticeHidden, documentId]) });
    },
  }));
}
