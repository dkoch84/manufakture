// The framing members the app holds, as regen sent them: shape meshes worker-wide (added and
// removed per regen), and per part studio its member sets (a set that did not change is kept
// from the regen before). The viewport draws the shown part's sets (`shownMemberView`), the info
// panel reads a picked member's data here, and STL and 3MF export write them (ADR 0015
// decision 4). The regen loop feeds it with `applyRegen` and the active part with `show`; tests
// and the kernel-free scenes load fixtures with `load`.

import type { MemberMeshData, MemberMeshUpdate, MemberSetResult } from '@manufakture/regen';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  EMPTY_MEMBER_VIEW,
  applyMeshUpdate,
  applySetResults,
  type MemberSetView,
  type MemberView,
} from './members';

/** What `applyRegen` reads of a regen result. */
export interface MemberRegenResult {
  parts: readonly { partId: string; members?: readonly MemberSetResult[] }[];
  memberMeshes?: MemberMeshUpdate;
}

export interface MemberStoreState {
  meshes: ReadonlyMap<string, MemberMeshData>;
  /** Per part studio, its member sets in the result's order (parts without sets are absent). */
  parts: ReadonlyMap<string, readonly MemberSetView[]>;
  /** The part studio whose members are shown; null: none. */
  shown: string | null;
  /** Take a completed regen: meshes added and removed, every part's sets. */
  applyRegen(result: MemberRegenResult): void;
  show(partId: string | null): void;
  /** Replace one part's sets and add meshes (fixtures, tests), and show that part. */
  load(partId: string, view: MemberView): void;
  clear(): void;
}

export type MemberStore = StoreApi<MemberStoreState>;

export function createMemberStore(): MemberStore {
  return createStore<MemberStoreState>()((set, get) => ({
    meshes: new Map(),
    parts: new Map(),
    shown: null,

    applyRegen(result) {
      const { meshes, parts } = get();
      const nextMeshes = applyMeshUpdate(meshes, result.memberMeshes);
      const nextParts = new Map<string, readonly MemberSetView[]>();
      let changed = nextMeshes !== meshes;
      for (const p of result.parts) {
        const before = parts.get(p.partId) ?? [];
        const after = applySetResults(before, p.members);
        if (after !== before) changed = true;
        if (after.length > 0) nextParts.set(p.partId, after);
      }
      if (nextParts.size !== parts.size) changed = true;
      if (!changed) return;
      set({ meshes: nextMeshes, parts: nextParts });
    },

    show(partId) {
      if (get().shown !== partId) set({ shown: partId });
    },

    load(partId, view) {
      const meshes = new Map(get().meshes);
      for (const [key, mesh] of view.meshes) meshes.set(key, mesh);
      const parts = new Map(get().parts);
      if (view.sets.length > 0) parts.set(partId, view.sets);
      else parts.delete(partId);
      set({ meshes, parts, shown: partId });
    },

    clear() {
      set({ meshes: new Map(), parts: new Map(), shown: null });
    },
  }));
}

const NO_SETS: readonly MemberSetView[] = [];
const views = new WeakMap<object, MemberView>();

/**
 * The shown part's members with every mesh. The same object while the meshes and the shown sets
 * are, so a consumer can compare by identity.
 */
export function shownMemberView(
  s: Pick<MemberStoreState, 'meshes' | 'parts' | 'shown'>,
): MemberView {
  const sets = (s.shown !== null ? s.parts.get(s.shown) : undefined) ?? NO_SETS;
  if (sets.length === 0) return EMPTY_MEMBER_VIEW;
  const key = sets as object;
  const cached = views.get(key);
  if (cached && cached.meshes === s.meshes) return cached;
  const view: MemberView = { meshes: s.meshes, sets };
  views.set(key, view);
  return view;
}

/** The app's member store. */
export const memberStore: MemberStore = createMemberStore();
