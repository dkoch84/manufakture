import { useEffect, useRef, useState } from 'react';
import { selectionStore, type SelectionStore } from './state/selection';
import { viewSettingsStore, type ViewSettingsStore } from './state/viewSettings';
import type { BodyInput } from './viewport/bodies';
import { LoadingSplash } from './viewport/LoadingSplash';
import { loaderForLocation, type LoadStatus, type SceneLoader } from './viewport/scenes';
import { SelectionPanel, Toolbar } from './viewport/Toolbar';
import { Viewport, type EngineFactory, type ViewportApi } from './viewport/Viewport';
import './viewport/viewport.css';

export interface AppProps {
  /** A loader owned by the caller: the app uses it but never disposes it. */
  loader?: SceneLoader;
  /**
   * Makes the app's own loader when none is given (default: the scene the
   * page URL names). The app disposes that one, and with it the kernel
   * worker, when it unmounts.
   */
  createLoader?: () => SceneLoader;
  createEngine?: EngineFactory;
  selection?: SelectionStore;
  settings?: ViewSettingsStore;
}

export function App({
  loader: given,
  createLoader = loaderForLocation,
  createEngine,
  selection = selectionStore,
  settings = viewSettingsStore,
}: AppProps) {
  // A loader starts nothing until `load`, so the initialiser running twice
  // under StrictMode leaves nothing behind.
  const [{ loader, owned }] = useState(() =>
    given ? { loader: given, owned: false } : { loader: createLoader(), owned: true },
  );
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<LoadStatus>({ label: 'Starting', fraction: null });
  const [bodies, setBodies] = useState<readonly BodyInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportApi | null>(null);

  useEffect(() => {
    // The loader outlives a remount (StrictMode): aborting only stops status updates.
    const controller = new AbortController();
    loader.load(setStatus, controller.signal).then(
      (b) => {
        if (!controller.signal.aborted) setBodies(b);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => controller.abort();
  }, [loader]);

  useEffect(() => {
    if (!owned) return;
    // StrictMode unmounts and remounts every effect once in development, with
    // the same state: disposing in the cleanup would kill the live worker.
    // Defer it, and let a remount cancel it.
    if (pendingDispose.current !== null) {
      clearTimeout(pendingDispose.current);
      pendingDispose.current = null;
    }
    return () => {
      pendingDispose.current = setTimeout(() => {
        pendingDispose.current = null;
        loader.dispose();
      }, 0);
    };
  }, [loader, owned]);

  if (bodies === null) return <LoadingSplash status={status} error={error} />;

  const stores = { selection, settings };
  return (
    <div className="app">
      <header className="app-header">
        <h1>manufakture</h1>
        <Toolbar viewport={viewport} {...stores} />
      </header>
      <main className="app-main">
        <Viewport
          bodies={bodies}
          onReady={setViewport}
          {...(createEngine ? { createEngine } : {})}
          {...stores}
        />
        <SelectionPanel selection={selection} />
      </main>
    </div>
  );
}
