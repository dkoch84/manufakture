import { sketchToWorld } from '@manufakture/sketch/geometry';
import type { SketchPlacement, Vec2 } from '@manufakture/sketch/model';
import { DEFAULT_PART_ID, findPart } from '@manufakture/core';
import type { ExportTolerancePreset } from '@manufakture/io';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ExportFormat, ImportedBody } from './io/actions';
import { restorableImportIds } from './io/restorable';
import { downloadBytes, readFileBytes } from './io/files';
import { ExportMenu, ImportButton } from './io/IoMenus';
import { withMeshBodies } from './io/meshBody';
import { MeasureOverlay } from './measure/MeasureOverlay';
import { MeasurePanel } from './measure/MeasurePanel';
import { measureTargets } from './measure/measurer';
import { modelBodies, modelStore, startRegen, useModel, type ModelStore } from './model/model';
import { documentStore, historyShortcut, type DocumentStoreApi } from './state/document';
import { measureStore, type MeasureStore } from './state/measure';
import {
  isFeatureItem,
  isGeometryRef,
  selectionStore,
  type SelectionStore,
} from './state/selection';
import { viewSettingsStore, type ViewSettingsStore } from './state/viewSettings';
import { sketchFeatures, type SketchPlacements } from './sketcher/commit';
import { lazySolver, spawnDefaultSolver, type LazySolver } from './sketcher/lazySolver';
import { faceTarget } from './sketcher/planes';
import { createSketchSession, type SketchSessionStore } from './sketcher/session';
import { SketchLayer } from './sketcher/SketchLayer';
import {
  ConflictPanel,
  SketchSelectionList,
  SketchStatusBar,
  SketchToolbar,
} from './sketcher/SketchMode';
import { SketchMenu } from './sketcher/SketchPanels';
import { FeatureTree } from './tree/FeatureTree';
import type { DialogRequest } from './features/FeatureDialog';
import { FeatureToolbar } from './features/FeatureToolbar';
import type { RefKind } from './features/forms';
import { isDialogKind } from './features/kinds';
import type { GeometryRef } from './state/selection';
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
import './measure/measure.css';
import './io/io.css';
import './tree/tree.css';
import './features/features.css';

const defaultSolver = () => lazySolver(spawnDefaultSolver);

// The feature dialogs (and their forms and hole tables) load when one is first opened.
const FeatureDialog = lazy(() =>
  import('./features/FeatureDialog').then((m) => ({ default: m.FeatureDialog })),
);

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
  /**
   * Makes the sketch solver when no `sketchSession` is given (default: the solver worker,
   * started on the first sketch). The app disposes it when it unmounts.
   */
  createSolver?: () => LazySolver;
  /** The measure tool's state; it measures through the loader's `measurer`. */
  measure?: MeasureStore;
  /** The regenerated model, kept current through the loader's `regenerator`. */
  model?: ModelStore;
}

export function App({
  loader: given,
  createLoader = loaderForLocation,
  createEngine,
  selection = selectionStore,
  settings = viewSettingsStore,
  documents = documentStore,
  sketchSession,
  createSolver = defaultSolver,
  measure = measureStore,
  model = modelStore,
}: AppProps) {
  // A loader starts nothing until `load`, so the initialiser running twice
  // under StrictMode leaves nothing behind.
  const [{ loader, owned }] = useState(() =>
    given ? { loader: given, owned: false } : { loader: createLoader(), owned: true },
  );
  // Likewise the solver: its worker starts on the first sketch.
  // The app owns the solver it makes (and disposes it with the loader); a given session's
  // solver is the caller's.
  const [{ session, solver: ownedSolver }] = useState(() => {
    if (sketchSession) return { session: sketchSession, solver: null };
    const solver = createSolver();
    return { session: createSketchSession(solver), solver };
  });
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<LoadStatus>({ label: 'Starting', fraction: null });
  const [bodies, setBodies] = useState<readonly BodyInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportApi | null>(null);
  // Imported reference bodies, shown next to the loaded ones while their
  // import feature is in the document (so undo hides them, redo brings them back).
  const [imports, setImports] = useState<readonly ImportedBody[]>([]);
  const [ioStatus, setIoStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [ioBusy, setIoBusy] = useState(false);

  // The scene's own document (the demo scene) replaces the open one once, when the scene loads.
  const openedInitial = useRef(false);
  useEffect(() => {
    // The loader outlives a remount (StrictMode): aborting only stops status updates.
    const controller = new AbortController();
    loader.load(setStatus, controller.signal).then(
      (b) => {
        if (controller.signal.aborted) return;
        if (loader.initialDocument && !openedInitial.current) {
          openedInitial.current = true;
          documents.getState().load(loader.initialDocument);
        }
        setBodies(b);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => controller.abort();
  }, [loader, documents]);

  // Regenerate the document on every change, once the kernel is up.
  const loaded = bodies !== null;
  useEffect(() => {
    const regenerator = loader.regenerator;
    if (!loaded || !regenerator) return;
    return startRegen(regenerator, documents, model);
  }, [loaded, loader, documents, model]);
  const parts = useModel(model, (s) => s.parts);
  const modelGeneration = useModel(model, (s) => s.generation);
  const partBodies = useMemo(() => modelBodies({ parts }), [parts]);
  // Where regen placed each sketch, for sketches on faces.
  const placements = useMemo<SketchPlacements>(() => {
    const out = new Map<string, SketchPlacement>();
    for (const p of parts) {
      for (const f of p.features) if (f.placement) out.set(f.featureId, f.placement);
    }
    return out;
  }, [parts]);

  useEffect(() => {
    if (!owned && !ownedSolver) return;
    // StrictMode unmounts and remounts every effect once in development, with
    // the same state: disposing in the cleanup would kill the live workers.
    // Defer it, and let a remount cancel it.
    if (pendingDispose.current !== null) {
      clearTimeout(pendingDispose.current);
      pendingDispose.current = null;
    }
    return () => {
      pendingDispose.current = setTimeout(() => {
        pendingDispose.current = null;
        if (owned) loader.dispose();
        ownedSolver?.dispose();
      }, 0);
    };
  }, [loader, owned, ownedSolver]);

  const document = useStore(documents, (s) => s.document);
  const sketches = useMemo(() => sketchFeatures(document), [document]);
  const shownImports = useMemo(() => {
    const features = findPart(document, DEFAULT_PART_ID)?.features ?? [];
    return imports.filter((i) => features.some((f) => f.id === i.feature.id));
  }, [imports, document]);
  // Forget imported bodies whose import feature can no longer come back (not
  // in the document, the undo stack or the redo stack), releasing their
  // kernel shapes. Runs on every document change, except while an import
  // runs: its body is registered before its feature lands in the document,
  // so the import prunes once more when it is done.
  const importing = useRef(false);
  const pruneImports = useCallback(() => {
    if (importing.current) return;
    const { core } = documents;
    const keep = restorableImportIds(core.document, [...core.undoStack, ...core.redoStack]);
    loader.exchanger?.retain(keep);
    setImports((prev) =>
      prev.every((i) => keep.has(i.feature.id)) ? prev : prev.filter((i) => keep.has(i.feature.id)),
    );
  }, [documents, loader]);
  useEffect(() => {
    const unsubscribe = documents.core.subscribe(pruneImports);
    return () => {
      unsubscribe();
    };
  }, [documents, pruneImports]);
  // After a recycle or restart the kernel holds none of the imported STEP bodies: read them
  // again from the files their import features store, so measuring them keeps working.
  const importsRef = useRef(imports);
  useEffect(() => {
    importsRef.current = imports;
  }, [imports]);
  useEffect(() => {
    const { regenerator, exchanger } = loader;
    if (!regenerator || !exchanger) return;
    return regenerator.onInvalidated(() => {
      const features = importsRef.current.map((i) => i.feature);
      if (!features.some((f) => f.source.format === 'step')) return;
      void import('./io/actions')
        .then(({ reimportSteps }) => reimportSteps(exchanger, features))
        .catch(() => undefined);
    });
  }, [loader]);
  const shownBodies = useMemo(
    () =>
      bodies === null
        ? null
        : partBodies.length === 0 && shownImports.length === 0
          ? bodies
          : [...bodies, ...partBodies, ...shownImports.map((i) => i.body)],
    [bodies, partBodies, shownImports],
  );
  const measurer = useMemo(() => {
    const meshes = new Map(
      shownImports.flatMap((i) => (i.mesh ? [[i.body.id, i.mesh] as const] : [])),
    );
    return meshes.size > 0
      ? withMeshBodies(loader.measurer ?? null, () => meshes)
      : (loader.measurer ?? null);
  }, [loader, shownImports]);

  const onExport = useCallback(
    (format: ExportFormat, tolerance: ExportTolerancePreset) => {
      const exchanger = loader.exchanger;
      if (!exchanger) {
        setIoStatus({ error: true, text: 'Export needs the geometry kernel.' });
        return;
      }
      setIoBusy(true);
      setIoStatus({ error: false, text: 'Exporting...' });
      // The export code (STL, 3MF with its zip library, STEP) loads on first use.
      import('./io/actions')
        .then(({ exportBodies }) =>
          exportBodies(exchanger, format, { tolerance, documentName: document.name }),
        )
        .then(
          (r) => {
            if (r.ok) for (const f of r.value) downloadBytes(f.bytes, f.name, f.type);
            setIoStatus({ error: !r.ok, text: r.message });
          },
          (e: unknown) =>
            setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => setIoBusy(false));
    },
    [loader, document.name],
  );

  const onImport = useCallback(
    (file: File) => {
      setIoBusy(true);
      importing.current = true;
      setIoStatus({ error: false, text: `Importing ${file.name}...` });
      readFileBytes(file)
        .then(async (bytes) => {
          const { importFile } = await import('./io/actions');
          return importFile({ name: file.name, bytes }, documents, loader.exchanger ?? null);
        })
        .then(
          (r) => {
            if (r.ok) setImports((prev) => [...prev, r.value]);
            setIoStatus({ error: !r.ok, text: r.message });
          },
          (e: unknown) =>
            setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => {
          importing.current = false;
          setIoBusy(false);
          pruneImports();
        });
    },
    [loader, documents, pruneImports],
  );
  const sketching = useSketching(session, documents, viewport, placements);
  // The open feature dialog, if any: a new feature from the toolbar, or one opened from the tree.
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const onEditFeature = useCallback(
    (featureId: string, options: { repick?: string } = {}) => {
      const feature = findPart(documents.getState().document, DEFAULT_PART_ID)?.features.find(
        (f) => f.id === featureId,
      );
      if (!feature) return;
      if (feature.kind === 'sketch') sketching.enter({ kind: 'edit', featureId });
      else if (isDialogKind(feature.kind)) {
        setDialog({
          kind: feature.kind,
          featureId,
          ...(options.repick ? { repick: options.repick } : {}),
        });
      }
    },
    [documents, sketching],
  );
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
      model,
    };
    return () => {
      const hooks = window.__manufakture;
      if (!hooks) return;
      delete hooks.sketcher;
      delete hooks.document;
      delete hooks.model;
      if (Object.keys(hooks).length === 0) delete window.__manufakture;
    };
  }, [viewport, session, documents, model]);

  const selected = useStore(selection, (s) => s.selected);
  const hoveredFeature = useStore(selection, (s) =>
    isFeatureItem(s.hovered) ? s.hovered.id : null,
  );
  const face = useMemo(() => {
    if (!shownBodies) return null;
    const ref = selected.find((i) => isGeometryRef(i) && i.kind === 'face');
    const parts = new Set(partBodies.map((b) => b.id));
    return ref && isGeometryRef(ref) ? faceTarget(shownBodies, ref, parts) : null;
  }, [shownBodies, partBodies, selected]);

  // Viewport picks to references for the feature dialogs, against the bodies shown now.
  const pickContext = useRef({ bodies: [] as readonly BodyInput[], partBodies: new Set<string>() });
  useEffect(() => {
    pickContext.current = {
      bodies: shownBodies ?? [],
      partBodies: new Set(partBodies.map((b) => b.id)),
    };
  }, [shownBodies, partBodies]);
  const resolveReference = useCallback(
    async (geo: GeometryRef, accepts: readonly RefKind[]) => {
      const { referenceFor } = await import('./features/references');
      return referenceFor(geo, accepts, { ...pickContext.current, referencer: loader.referencer });
    },
    [loader],
  );

  // Measure the selection (and the body it is on) whenever either changes.
  const bodiesRevision = useRef(0);
  useEffect(() => {
    bodiesRevision.current++;
  }, [shownBodies, modelGeneration]);
  useEffect(() => {
    if (shownBodies === null) return;
    const refs = selected.filter(isGeometryRef);
    const bodyId = refs[0]?.bodyId ?? shownBodies[0]?.id ?? null;
    void measure.getState().measure(
      measurer,
      bodyId === null
        ? null
        : {
            bodyId,
            targets: measureTargets(refs.filter((r) => r.bodyId === bodyId)),
            revision: bodiesRevision.current,
          },
    );
  }, [shownBodies, modelGeneration, selected, measurer, measure]);

  // Registered with the viewport, like the other hooks: tests wait for the viewport hook.
  useEffect(() => {
    if (!testHooksEnabled || !viewport) return;
    window.__manufakture = { ...window.__manufakture, measure };
    return () => {
      const hooks = window.__manufakture;
      if (!hooks) return;
      delete hooks.measure;
      if (Object.keys(hooks).length === 0) delete window.__manufakture;
    };
  }, [viewport, measure]);

  const canUndo = useStore(documents, (s) => s.canUndo);
  const canRedo = useStore(documents, (s) => s.canRedo);
  const undoLabel = useStore(documents, (s) => s.undoLabel);
  const redoLabel = useStore(documents, (s) => s.redoLabel);

  if (shownBodies === null) return <LoadingSplash status={status} error={error} />;

  const stores = { selection, settings };
  return (
    <div className="app">
      <header className="app-header">
        <h1>manufakture</h1>
        <div className="toolbar-group document-actions">
          <SketchMenu
            face={face}
            disabled={sketching.active || dialog !== null}
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
          <ExportMenu
            disabled={sketching.active || ioBusy || !loader.exchanger}
            onExport={onExport}
          />
          <ImportButton disabled={sketching.active || ioBusy} onFile={onImport} />
          {ioStatus && (
            <span
              className={ioStatus.error ? 'io-status io-error' : 'io-status'}
              role={ioStatus.error ? 'alert' : 'status'}
              data-testid="io-status"
            >
              {ioStatus.text}
            </span>
          )}
        </div>
        <Toolbar viewport={viewport} {...stores} />
      </header>
      {/* The part tools; in a sketch the sketch toolbar takes this row. */}
      {!sketching.active && (
        <div className="feature-bar">
          <FeatureToolbar disabled={dialog !== null} onOpen={(kind) => setDialog({ kind })} />
        </div>
      )}
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
        {/* A sketch is edited on its own (the tree cannot change anything meanwhile), so the
            tree steps aside and the sketch gets the room. */}
        {!sketching.active && (
          <FeatureTree
            documents={documents}
            model={model}
            selection={selection}
            disabled={dialog !== null}
            onEdit={onEditFeature}
          />
        )}
        <Viewport
          bodies={shownBodies}
          onReady={setViewport}
          {...(createEngine ? { createEngine } : {})}
          {...stores}
        >
          {viewport && (
            <SketchLayer
              viewport={viewport}
              session={session}
              sketches={sketches}
              placements={placements}
              highlighted={hoveredFeature}
            />
          )}
          {shownBodies.length === 0 && !sketching.active && (
            <p className="viewport-hint" data-testid="empty-hint">
              Nothing here yet. Start with <strong>New sketch</strong>: pick a plane, draw a closed
              shape, then extrude it.
            </p>
          )}
          {viewport && !sketching.active && (
            <MeasureOverlay viewport={viewport} measure={measure} units={document.units} />
          )}
          {sketching.active && <SketchStatusBar session={session} />}
        </Viewport>
        <div className="side-panel">
          {sketching.active ? (
            <aside className="selection-panel" aria-label="Sketch">
              <ConflictPanel session={session} />
              <h2>Sketch selection</h2>
              <SketchSelectionList session={session} />
            </aside>
          ) : dialog ? (
            <Suspense
              fallback={
                <aside className="selection-panel" aria-busy="true">
                  Opening...
                </aside>
              }
            >
              <FeatureDialog
                key={`${dialog.kind}/${dialog.featureId ?? 'new'}/${dialog.repick ?? ''}`}
                request={dialog}
                documents={documents}
                model={model}
                selection={selection}
                resolve={resolveReference}
                onClose={() => setDialog(null)}
              />
            </Suspense>
          ) : (
            <>
              <SelectionPanel selection={selection} />
              <MeasurePanel measure={measure} documents={documents} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
