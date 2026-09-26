// The measure tool's state: the latest exact measurement of the selection,
// shared by the Measure panel and the viewport overlay that draws its
// witness points. Requests go to the kernel through a `Measurer`; a request
// that finishes after a newer one started is dropped.

import type { MeasureTarget } from '@manufakture/kernel';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Measurement, Measurer } from '../measure/measurer';

export type MeasureStatus = 'idle' | 'measuring' | 'ready' | 'error' | 'unavailable';

export interface MeasureRequest {
  bodyId: string;
  targets: readonly MeasureTarget[];
  /** Changes whenever the bodies are rebuilt, so the same targets are measured again. */
  revision: number;
}

export interface MeasureState {
  status: MeasureStatus;
  /** What the current result (or the request in flight) measures. */
  request: MeasureRequest | null;
  result: Measurement | null;
  error: string | null;

  /**
   * Measure `targets` on `bodyId` (always with the body's properties), or
   * reset with a null request. Asking again for what is already measured (or
   * being measured) does nothing. Resolves when this request has settled or
   * was superseded. Without a measurer the tool is `unavailable`.
   */
  measure(measurer: Measurer | null, request: MeasureRequest | null): Promise<void>;
}

export type MeasureStore = StoreApi<MeasureState>;

function sameRequest(a: MeasureRequest | null, b: MeasureRequest | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createMeasureStore(): MeasureStore {
  let sequence = 0;
  return createStore<MeasureState>()((set, get) => ({
    status: 'idle',
    request: null,
    result: null,
    error: null,

    async measure(measurer, request) {
      const current = get();
      const settled = current.status === 'ready' || current.status === 'measuring';
      if (sameRequest(current.request, request) && (settled || request === null)) return;
      const seq = ++sequence;
      if (request === null) {
        set({ status: 'idle', request: null, result: null, error: null });
        return;
      }
      if (measurer === null) {
        set({ status: 'unavailable', request, result: null, error: null });
        return;
      }
      // Keep showing the previous result until the new one arrives.
      set({ status: 'measuring', request, error: null });
      try {
        const outcome = await measurer.measure(request.bodyId, request.targets, true);
        if (seq !== sequence) return;
        if (outcome === null) {
          // An edit superseded it: the body is being rebuilt, and is measured again after.
          set({ status: 'idle', request: null, result: null, error: null });
          return;
        }
        if (outcome.ok) set({ status: 'ready', result: outcome.result, error: null });
        else set({ status: 'error', result: null, error: outcome.message });
      } catch (e) {
        if (seq !== sequence) return;
        set({ status: 'error', result: null, error: e instanceof Error ? e.message : String(e) });
      }
    },
  }));
}

/** The app's measure tool. Tests create their own with `createMeasureStore()`. */
export const measureStore: MeasureStore = createMeasureStore();

export function useMeasure<T>(selector: (state: MeasureState) => T, store = measureStore): T {
  return useStore(store, selector);
}
