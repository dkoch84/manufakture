import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  | 'projectToCanvas'
  | 'canvasToPlane'
  | 'alignView'
  | 'setPointerDelegate'
  | 'setObjectDrag'
  | 'setTransforms'
  | 'surfacePoint'
  | 'viewDirection'
  | 'onViewChange'
  | 'requestRender'
  | 'setBuildVolume'
  | 'setShading'
  | 'setThreadLines'
  | 'frameBox'
  | 'dispose'
>;

export type EngineFactory = (canvas: HTMLCanvasElement, stores: EngineStores) => ViewportApi;

const createDefaultEngine: EngineFactory = (canvas, stores) => new ViewportEngine(canvas, stores);

/**
 * Test and tooling hook (see testHooks.ts): the live viewport and its stores,
 * plus whatever other parts of the app register (the sketcher, the document).
 */
export interface TestHookRegistry {
  viewport?: ViewportApi;
  selection?: SelectionStore;
  settings?: ViewSettingsStore;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __manufakture?: TestHookRegistry;
  }
}

export interface ViewportProps {
  bodies: readonly BodyInput[];
  onReady?: (api: ViewportApi | null) => void;
  createEngine?: EngineFactory;
  selection?: SelectionStore;
  settings?: ViewSettingsStore;
  /** Overlays drawn over the canvas (the sketcher), in the viewport's element. */
  children?: ReactNode;
}

export function Viewport({
  bodies,
  onReady,
  createEngine = createDefaultEngine,
  selection = defaultSelection,
  settings = defaultSettings,
  children,
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
      if (testHooksEnabled) {
        window.__manufakture = { ...window.__manufakture, viewport: api, selection, settings };
      }
      return () => {
        const hooks = window.__manufakture;
        if (hooks?.viewport === api) {
          const rest: TestHookRegistry = { ...hooks };
          delete rest.viewport;
          delete rest.selection;
          delete rest.settings;
          if (Object.keys(rest).length > 0) window.__manufakture = rest;
          else delete window.__manufakture;
        }
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
      {children}
      {error !== null && (
        <div className="viewport-error" role="alert">
          The 3D view could not start: {error}. It needs a browser with WebGL 2.
        </div>
      )}
    </div>
  );
}
