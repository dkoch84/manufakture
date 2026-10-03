// The viewport that is on screen now, for workspaces that draw into it without being handed it
// (the Manufacture workspace's toolpath preview). `Viewport` sets it when its engine starts and
// clears it when that engine goes; null while there is none (or no WebGL).

import { createStore } from 'zustand/vanilla';
import type { ViewportApi } from './Viewport';

export interface LiveViewportState {
  api: ViewportApi | null;
}

export const liveViewport = createStore<LiveViewportState>()(() => ({ api: null }));
