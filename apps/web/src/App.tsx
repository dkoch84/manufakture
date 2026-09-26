import { sketchToWorld } from '@manufakture/sketch';
import type { Vec2 } from '@manufakture/sketch/model';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { documentStore, historyShortcut, type DocumentStoreApi } from './state/document';
import { isGeometryRef, selectionStore, type SelectionStore } from './state/selection';
import { viewSettingsStore, type ViewSettingsStore } from './state/viewSettings';
import { sketchFeatures } from './sketcher/commit';
import { lazySolver, spawnDefaultSolver } from './sketcher/lazySolver';
import { facePlacement } from './sketcher/planes';
import { createSketchSession, type SketchSessionStore } from './sketcher/session';
import { SketchLayer } from './sketcher/SketchLayer';
import {
  ConflictPanel,
  SketchSelectionList,
  SketchStatusBar,
  SketchToolbar,
} from './sketcher/SketchMode';
import { SketchList, SketchMenu } from './sketcher/SketchPanels';
import { useSketchShortcuts } from './sketcher/shortcuts';
import { useSketching } from './sketcher/useSketching';
import { testHooksEnabled } from './testHooks';
import type { BodyInput } from './viewport/bodies';
import { LoadingSplash } from './viewport/LoadingSplash';
import { loaderForLocation, type LoadStatus, type SceneLoader } from './viewport/scenes';
import { SelectionPanel, Toolbar } from './viewport/Toolbar';
import { Viewport, type EngineFactory, type ViewportApi } from './viewport/Viewport';
import './viewport/viewport.css';
import './sketcher/sketcher.css';

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
  documents?: DocumentStoreApi;
  /** The sketch session; by default one on the solver worker, started on the first sketch. */
  sketchSession?: SketchSessionStore;
}

export function App({
  loader: given,
  createLoader = loaderForLocation,
  createEngine,
  selection = selectionStore,
  settings = viewSettingsStore,
  documents = documentStore,
  sketchSession,
}: AppProps) {
  // A loader starts nothing until `load`, so the initialiser running twice
  // under StrictMode leaves nothing behind.
  const [{ loader, owned }] = useState(() =>
    given ? { loader: given, owned: false } : { loader: createLoader(), owned: true },
  );
  // Likewise the solver: its worker starts on the first sketch.
  const [session] = useState(
    () => sketchSession ?? createSketchSession(lazySolver(spawnDefaultSolver)),
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

  const document = useStore(documents, (s) => s.document);
  const sketches = useMemo(() => sketchFeatures(document), [document]);
  const sketching = useSketching(session, documents, viewport);
  useSketchShortcuts(session, sketching.active);

  // Undo and redo: the sketch's own history while sketching, else the document's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = historyShortcut(e);
      if (!action) return;
      e.preventDefault();
      const target = session.getState().active ? session.getState() : documents.getState();
      if (action === 'undo') target.undo();
      else target.redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, documents]);

  // Test hooks for the sketcher and the document (see testHooks.ts).
  useEffect(() => {
    if (!testHooksEnabled || !viewport) return;
    const toClient = (p: Vec2) => {
      const placement = session.getState().source?.placement;
      if (!placement) throw new Error('No sketch is open');
      return viewport.projectToClient(sketchToWorld(placement, p));
    };
    window.__manufakture = {
      ...window.__manufakture,
      sketcher: { store: session, toClient },
      document: documents,
    };
    return () => {
      const hooks = window.__manufakture;
      if (!hooks) return;
      delete hooks.sketcher;
      delete hooks.document;
      if (Object.keys(hooks).length === 0) delete window.__manufakture;
    };
  }, [viewport, session, documents]);

  const selected = useStore(selection, (s) => s.selected);
  const face = useMemo(() => {
    if (!bodies) return null;
    const ref = selected.find((i) => isGeometryRef(i) && i.kind === 'face');
    return ref && isGeometryRef(ref) ? facePlacement(bodies, ref) : null;
  }, [bodies, selected]);

  const canUndo = useStore(documents, (s) => s.canUndo);
  const canRedo = useStore(documents, (s) => s.canRedo);
  const undoLabel = useStore(documents, (s) => s.undoLabel);
  const redoLabel = useStore(documents, (s) => s.redoLabel);

  if (bodies === null) return <LoadingSplash status={status} error={error} />;

  const stores = { selection, settings };
  return (
    <div className="app">
      <header className="app-header">
        <h1>manufakture</h1>
        <div className="toolbar-group document-actions">
          <SketchMenu
            face={face}
            disabled={sketching.active}
            onPick={(target) => sketching.enter(target)}
          />
          <button
            type="button"
            disabled={sketching.active || !canUndo}
            title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
            onClick={() => documents.getState().undo()}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={sketching.active || !canRedo}
            title={redoLabel ? `Redo ${redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
            onClick={() => documents.getState().redo()}
          >
            Redo
          </button>
        </div>
        <Toolbar viewport={viewport} {...stores} />
      </header>
      {sketching.active && (
        <SketchToolbar
          session={session}
          onFinish={() => void sketching.finish()}
          onCancel={sketching.cancel}
        />
      )}
      {sketching.error && (
        <div className="app-error" role="alert">
          {sketching.error}{' '}
          <button type="button" onClick={sketching.dismissError}>
            Dismiss
          </button>
        </div>
      )}
      <main className="app-main">
        <Viewport
          bodies={bodies}
          onReady={setViewport}
          {...(createEngine ? { createEngine } : {})}
          {...stores}
        >
          {viewport && <SketchLayer viewport={viewport} session={session} sketches={sketches} />}
          {sketching.active && <SketchStatusBar session={session} />}
        </Viewport>
        <div className="side-panel">
          {sketching.active ? (
            <aside className="selection-panel" aria-label="Sketch">
              <ConflictPanel session={session} />
              <h2>Sketch selection</h2>
              <SketchSelectionList session={session} />
            </aside>
          ) : (
            <>
              <SelectionPanel selection={selection} />
              <aside className="selection-panel">
                <SketchList
                  sketches={sketches}
                  onEdit={(featureId) => sketching.enter({ kind: 'edit', featureId })}
                />
              </aside>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
