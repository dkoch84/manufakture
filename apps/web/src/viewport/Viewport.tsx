import { useCallback, useEffect, useState } from 'react';
import { selectionStore as defaultSelection, type SelectionStore } from '../state/selection';
import {
  viewSettingsStore as defaultSettings,
  type ViewSettingsStore,
} from '../state/viewSettings';
import { testHooksEnabled } from '../testHooks';
import type { BodyInput } from './bodies';
import { ViewportEngine, type EngineStores } from './engine';

/** The part of the engine the UI and tests use. */
export type ViewportApi = Pick<
  ViewportEngine,
  | 'setBodies'
  | 'setStandardView'
  | 'setViewDirection'
  | 'fitAll'
  | 'pickAt'
  | 'projectToClient'
  | 'info'
  | 'measureFrames'
  | 'geometrySamples'
  | 'hiddenDepth'
  | 'dispose'
>;

export type EngineFactory = (canvas: HTMLCanvasElement, stores: EngineStores) => ViewportApi;

const createDefaultEngine: EngineFactory = (canvas, stores) => new ViewportEngine(canvas, stores);

declare global {
  interface Window {
    /** Test and tooling hook: the live viewport and its stores (see testHooks.ts). */
    __manufakture?: {
      viewport: ViewportApi;
      selection: SelectionStore;
      settings: ViewSettingsStore;
    };
  }
}

export interface ViewportProps {
  bodies: readonly BodyInput[];
  onReady?: (api: ViewportApi | null) => void;
  createEngine?: EngineFactory;
  selection?: SelectionStore;
  settings?: ViewSettingsStore;
}

export function Viewport({
  bodies,
  onReady,
  createEngine = createDefaultEngine,
  selection = defaultSelection,
  settings = defaultSettings,
}: ViewportProps) {
  const [engine, setEngine] = useState<ViewportApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The engine lives exactly as long as the canvas element: a ref callback
  // with a cleanup (React 19) creates it on attach and disposes it on detach.
  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      let api: ViewportApi;
      try {
        api = createEngine(canvas, { selection, settings });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      setError(null);
      setEngine(api);
      if (testHooksEnabled) window.__manufakture = { viewport: api, selection, settings };
      return () => {
        if (window.__manufakture?.viewport === api) delete window.__manufakture;
        api.dispose();
        setEngine(null);
      };
    },
    [createEngine, selection, settings],
  );

  useEffect(() => {
    engine?.setBodies(bodies);
  }, [engine, bodies]);

  useEffect(() => {
    onReady?.(engine);
  }, [engine, onReady]);

  return (
    <div className="viewport">
      <canvas
        ref={attach}
        className="viewport-canvas"
        tabIndex={0}
        aria-label="3D viewport"
        data-testid="viewport-canvas"
      />
      {error !== null && (
        <div className="viewport-error" role="alert">
          The 3D view could not start: {error}. It needs a browser with WebGL 2.
        </div>
      )}
    </div>
  );
}
