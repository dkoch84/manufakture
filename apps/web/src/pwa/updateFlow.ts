// The update flow (T7.4a): what the page does when a new service worker has installed and waits.
//
// A new version never takes over on its own, and never while a change is unsaved. When the
// waiting worker is found, autosave is flushed first; only once every change is saved does the
// app offer **Reload**. A flush that fails (storage error, or a conflict with another tab) keeps
// the offer back and is tried again every `retryMs`, so the user sees the update once their work
// is safe. Choosing Reload flushes once more (the user may have kept editing), then tells the
// waiting worker to take over; `register.ts` reloads the page when it has.
//
// Pure state and callbacks, no service worker API, so it is unit tested (updateFlow.test.ts).

import { createStore, type StoreApi } from 'zustand/vanilla';

export type UpdateState =
  /** No new version waits. */
  | { kind: 'idle' }
  /** A new version waits; autosave is being flushed before it is offered. */
  | { kind: 'saving' }
  /** The flush failed; it is tried again. `message` says what to do meanwhile. */
  | { kind: 'blocked'; message: string }
  /** Everything is saved: Reload is offered. */
  | { kind: 'ready' }
  /** The user chose Reload; the new version is taking over. */
  | { kind: 'reloading' }
  /** The user put the offer away; the new version starts when every tab is closed. */
  | { kind: 'dismissed' };

export interface UpdateFlowOptions {
  /** Save every pending change; true when all are saved (autosave's `flush`). */
  flush: () => Promise<boolean>;
  /** Make the waiting worker take over (posts `skipWaiting` to it). */
  activate: () => void;
  /** Delay before a failed flush is tried again. */
  retryMs?: number;
}

export interface UpdateFlow {
  state: StoreApi<UpdateState>;
  /** A new worker is installed and waiting. */
  updateFound(): void;
  /** The user chose Reload. Resolves once the worker was told to take over, or the flush failed. */
  reload(): Promise<void>;
  /** The user chose Later. */
  dismiss(): void;
  /** Stop retrying (tests, or the page going away). */
  stop(): void;
}

export const BLOCKED_MESSAGE =
  'A new version is ready. It will be offered once your changes are saved.';

export function createUpdateFlow(options: UpdateFlowOptions): UpdateFlow {
  const { flush, activate, retryMs = 5000 } = options;
  const state = createStore<UpdateState>()(() => ({ kind: 'idle' }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Counts flush attempts, so an old attempt that resolves late changes nothing. */
  let attempt = 0;

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
      state.setState({ kind: 'ready' }, true);
    } else {
      state.setState({ kind: 'blocked', message: BLOCKED_MESSAGE }, true);
      timer = setTimeout(() => void trySave(), retryMs);
    }
  };

  return {
    state,
    updateFound() {
      if (stopped) return;
      const kind = state.getState().kind;
      if (kind !== 'idle' && kind !== 'dismissed') return;
      state.setState({ kind: 'saving' }, true);
      void trySave();
    },
    async reload() {
      if (stopped || state.getState().kind !== 'ready') return;
      state.setState({ kind: 'reloading' }, true);
      let saved: boolean;
      try {
        saved = await flush();
      } catch {
        saved = false;
      }
      if (stopped) return;
      if (!saved) {
        state.setState({ kind: 'blocked', message: BLOCKED_MESSAGE }, true);
        timer = setTimeout(() => void trySave(), retryMs);
        return;
      }
      activate();
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
