// The update flow (T7.4a): what the page does when a new service worker has installed and waits.
//
// A new version never takes over on its own, and never while a change is unsaved. When the
// waiting worker is found, autosave is flushed first; only once every change is saved does the
// app offer **Reload**. A flush that fails (storage error, or a conflict with another tab) keeps
// the offer back and is tried again every `retryMs`, so the user sees the update once their work
// is safe. Choosing Reload flushes once more (the user may have kept editing), then tells the
// waiting worker to take over; `register.ts` reloads the page when it has.
//
// Version skew (T7.4b). Two more things lead to the same offer, with their own wording:
// - `tookOver`: another tab chose Reload, so the new worker now controls this tab too, which still
//   runs the old build. The old build's precache is gone, so a chunk it has not loaded yet can no
//   longer be fetched; the tab should reload soon. Reload then simply reloads the page.
// - `chunkFailed`: loading a chunk of the app failed (index.ts catches it), most likely for the
//   same reason. Reload reloads the page, or lets a waiting worker take over when there is one.
//
// Pure state and callbacks, no service worker API, so it is unit tested (updateFlow.test.ts).

import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Why Reload is offered, when it is not simply a new version waiting: another tab updated the
 * app (`other-tab`), or a chunk of the app failed to load (`chunk`).
 */
export type UpdateReason = 'other-tab' | 'chunk';

export type UpdateState =
  /** No new version waits. */
  | { kind: 'idle' }
  /** A new version waits; autosave is being flushed before it is offered. */
  | { kind: 'saving'; reason?: UpdateReason }
  /** The flush failed; it is tried again. `message` says what to do meanwhile. */
  | { kind: 'blocked'; message: string; reason?: UpdateReason }
  /** Everything is saved: Reload is offered. */
  | { kind: 'ready'; reason?: UpdateReason }
  /** The user chose Reload; the new version is taking over. */
  | { kind: 'reloading'; reason?: UpdateReason }
  /** The user put the offer away; the new version starts when every tab is closed. */
  | { kind: 'dismissed' };

export interface UpdateFlowOptions {
  /** Save every pending change; true when all are saved (autosave's `flush`). */
  flush: () => Promise<boolean>;
  /** Make the waiting worker take over (posts `skipWaiting` to it). */
  activate: () => void;
  /** Reload the page (when the new version already controls it, or no worker waits). */
  reloadPage?: () => void;
  /** Delay before a failed flush is tried again. */
  retryMs?: number;
}

export interface UpdateFlow {
  state: StoreApi<UpdateState>;
  /** A new worker is installed and waiting. */
  updateFound(): void;
  /** Another tab let a new worker take over; it now controls this tab, which runs the old build. */
  tookOver(): void;
  /** Loading a chunk of the app failed. */
  chunkFailed(): void;
  /** The user chose Reload. Resolves once the worker was told to take over, or the flush failed. */
  reload(): Promise<void>;
  /** The user chose Later. */
  dismiss(): void;
  /** Stop retrying (tests, or the page going away). */
  stop(): void;
}

export const BLOCKED_MESSAGE =
  'A new version is ready. It will be offered once your changes are saved.';

/** What the blocked offer says, by reason. */
export const BLOCKED_MESSAGES: Record<UpdateReason, string> = {
  'other-tab':
    'manufakture was updated in another tab. Reload will be offered once your changes are saved.',
  chunk:
    'Part of manufakture could not be loaded. Reload will be offered once your changes are saved.',
};

export function createUpdateFlow(options: UpdateFlowOptions): UpdateFlow {
  const { flush, activate, retryMs = 5000 } = options;
  const reloadPage = options.reloadPage ?? (() => window.location.reload());
  const state = createStore<UpdateState>()(() => ({ kind: 'idle' }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Counts flush attempts, so an old attempt that resolves late changes nothing. */
  let attempt = 0;
  /** A new worker was found waiting (`updateFound`). */
  let waiting = false;
  /** The new version already controls this tab (`tookOver`). */
  let takenOver = false;
  /** Why the offer is shown, when not simply for a waiting worker. */
  let reason: UpdateReason | null = null;

  const withReason = <T extends object>(s: T): T => (reason ? { ...s, reason } : s);
  const blocked = (): UpdateState =>
    withReason({ kind: 'blocked', message: reason ? BLOCKED_MESSAGES[reason] : BLOCKED_MESSAGE });

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const trySave = async (): Promise<void> => {
    clear();
    const mine = ++attempt;
    let saved: boolean;
    try {
      saved = await flush();
    } catch {
      saved = false;
    }
    if (stopped || mine !== attempt) return;
    const kind = state.getState().kind;
    if (kind !== 'saving' && kind !== 'blocked') return;
    if (saved) {
      state.setState(withReason({ kind: 'ready' }), true);
    } else {
      state.setState(blocked(), true);
      timer = setTimeout(() => void trySave(), retryMs);
    }
  };

  /** Offer Reload for `why`: flush first, as for an update, unless already offering it. */
  const offer = (why: UpdateReason) => {
    if (stopped) return;
    const kind = state.getState().kind;
    if (kind === 'reloading') return;
    // Another tab's update says more than a failed chunk (it is the likely cause of one).
    if (reason !== 'other-tab') reason = why;
    if (kind === 'idle' || kind === 'dismissed') {
      state.setState(withReason({ kind: 'saving' }), true);
      void trySave();
    } else if (kind === 'blocked') {
      state.setState(blocked(), true);
    } else {
      // Saving or ready: same progress, new wording.
      state.setState(withReason({ kind }), true);
    }
  };

  return {
    state,
    updateFound() {
      if (stopped) return;
      waiting = true;
      const kind = state.getState().kind;
      if (kind !== 'idle' && kind !== 'dismissed') return;
      state.setState(withReason({ kind: 'saving' }), true);
      void trySave();
    },
    tookOver() {
      takenOver = true;
      offer('other-tab');
    },
    chunkFailed() {
      offer('chunk');
    },
    async reload() {
      if (stopped || state.getState().kind !== 'ready') return;
      state.setState(withReason({ kind: 'reloading' }), true);
      let saved: boolean;
      try {
        saved = await flush();
      } catch {
        saved = false;
      }
      if (stopped) return;
      if (!saved) {
        state.setState(blocked(), true);
        timer = setTimeout(() => void trySave(), retryMs);
        return;
      }
      if (waiting && !takenOver) activate();
      else reloadPage();
    },
    dismiss() {
      clear();
      attempt++;
      if (state.getState().kind !== 'reloading') state.setState({ kind: 'dismissed' }, true);
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
