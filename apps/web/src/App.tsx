import { sketchToWorld } from '@manufakture/sketch/geometry';
import type { SketchPlacement, Vec2 } from '@manufakture/sketch/model';
import { findPart, type ManufaktureDocument } from '@manufakture/core';
import type { ExportTolerancePreset } from '@manufakture/io';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { homeActions, openedMessage, type ActionOutcome } from './home/actions';
import { HomeScreen } from './home/HomeScreen';
import { startAutosave, type Autosave, type SaveStatus } from './persistence/autosave';
import { MAIN_BRANCH, type Branch, type DocumentLibrary } from './persistence/library';
import { requestPersistence, storageInfo } from './persistence/storage';
import {
  branchFromSearch,
  docIdFromSearch,
  partIdFromSearch,
  showBranchInUrl,
  showDocIdInUrl,
  showPartIdInUrl,
} from './persistence/url';
import type { ExportFormat, ImportedBody } from './io/actions';
import { importBodyId, restorableImportIds } from './io/restorable';
import { downloadBytes, readFileBytes } from './io/files';
import type { ConfigurationExportFormat } from './io/configExport';
import { ExportMenu, ExportProgress, ImportButton } from './io/IoMenus';
import { withMeshBodies } from './io/meshBody';
import { MeasureOverlay } from './measure/MeasureOverlay';
import { MeasurePanel } from './measure/MeasurePanel';
import { PART_STUDIO_PANEL_ID } from './parts/names';
import { PartTabs } from './parts/PartTabs';
import { measureTargets } from './measure/measurer';
import { partBodies as bodiesOfPart, sameOr } from './model/bodies';
import {
  createModelStore,
  modelStore,
  shareRegenerator,
  startRegen,
  startView,
  useModel,
  type ModelStore,
  type ViewSession,
} from './model/model';
import { BranchSwitcher } from './history/BranchSwitcher';
import { HistoryPanel } from './history/HistoryPanel';
import { ViewerBanner } from './history/ViewerBanner';
import {
  compareDocuments,
  readTarget,
  restoreCommand,
  targetLabel,
  referenceImportIds,
  viewDocuments,
  viewSettingsFor,
  type HistoryTarget,
} from './history/history';
import { ConfigurationsPanel } from './configurations/ConfigurationsPanel';
import { ConfigurationSwitcher } from './configurations/ConfigurationSwitcher';
import { documentStore, historyShortcut, type DocumentStoreApi } from './state/document';
import { measureStore, type MeasureStore } from './state/measure';
import {
  isFeatureItem,
  isGeometryRef,
  selectionStore,
  type SelectionStore,
} from './state/selection';
import { hiddenBodiesOf, viewSettingsStore, type ViewSettingsStore } from './state/viewSettings';
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
import { VariablesPanel } from './variables/VariablesPanel';
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
import './parts/parts.css';

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
  /**
   * Where documents are saved (main.tsx passes the browser's library). Without one the
   * document lives in memory only, and there is no home screen.
   */
  library?: Promise<DocumentLibrary> | null;
  /** The document to open first (default: the URL's `doc`, else the most recent one). */
  initialDocumentId?: string | null;
  /** Autosave delays, for tests. */
  autosaveDelays?: { delayMs: number; maxDelayMs: number };
}

/** Whether `doc` has imported reference bodies, which live outside regen and must be read again. */
function hasReferenceImports(doc: ManufaktureDocument): boolean {
  return doc.parts.some((p) =>
    p.features.some((f) => f.kind === 'import' && f.operation === 'reference'),
  );
}

/** A version or revision shown read-only in place of the open document. */
interface Viewing {
  /** Hidden bodies while viewing, seeded from the open document's and dropped with the view. */
  settings: ViewSettingsStore;
  target: HistoryTarget;
  label: string;
  document: ManufaktureDocument;
  /** A read-only store of the viewed document, for the tree, the tabs and the panels. */
  documents: DocumentStoreApi;
  /** Its model, built in the worker beside the open document's (which stays as it is). */
  model: ModelStore;
  /** Null when there is no regen engine (the kernel-free test scenes). */
  session: ViewSession | null;
}

/** The save status shown when nothing is saved (no library). */
const NO_SAVING = createStore<SaveStatus>()(() => ({
  state: 'idle',
  message: null,
  documentId: '',
  documentName: '',
}));

const SAVE_TEXT: Record<SaveStatus['state'], string> = {
  idle: '',
  pending: 'Unsaved changes',
  saving: 'Saving...',
  saved: 'Saved',
  error: 'Not saved',
  conflict: 'Not saved',
};

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
  library: libraryPromise = null,
  initialDocumentId,
  autosaveDelays,
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
  // An export of every configuration in progress: which row, and how to cancel it.
  const [exportAll, setExportAll] = useState<{
    index: number;
    count: number;
    row: string;
    controller: AbortController;
  } | null>(null);
  // Persistence: the library once open, autosave, and which screen shows.
  const [library, setLibrary] = useState<DocumentLibrary | null>(null);
  // The open document's branch (main for a document never branched, or not saved), its
  // branches as the library lists them (null: none to show), and a counter that moves when
  // the list changes, so it is read again.
  // A store, so autosave and the home actions read it when a change is made: `show` sets it at
  // once, so an edit made while a switch is in flight is saved to the branch it was made on.
  const [branchStore] = useState(() => createStore<{ id: string }>()(() => ({ id: MAIN_BRANCH })));
  const branch = useStore(branchStore, (s) => s.id);
  const [branches, setBranches] = useState<readonly Branch[] | null>(null);
  const [branchesRevision, setBranchesRevision] = useState(0);
  const [autosave, setAutosave] = useState<Autosave | null>(null);
  const [docReady, setDocReady] = useState(libraryPromise === null);
  const [view, setView] = useState<'editor' | 'home'>('editor');
  const [homeOutcome, setHomeOutcome] = useState<ActionOutcome | null>(null);
  const [homeRevision, setHomeRevision] = useState(0);
  // A document just opened whose reference imports must be read again, once the kernel is up.
  const [restoreRequest, setRestoreRequest] = useState<ManufaktureDocument | null>(null);
  // Version history: whether the panel shows, a counter that moves with every save (so the panel
  // reads the history again), and the version or revision being viewed, if any.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const viewingRef = useRef<Viewing | null>(null);
  // Reference import bodies of the viewed state that the open document does not hold (deleted
  // and pruned, or never read in this session): read for the view, released when it ends. The
  // ids being read are kept from pruning too, counted per id: two overlapping view reads of
  // the same import each hold it until they are done.
  const [viewImports, setViewImports] = useState<readonly ImportedBody[]>([]);
  const viewImportsRef = useRef<readonly ImportedBody[]>([]);
  const viewReading = useRef(new Map<string, number>());
  // While a past state is viewed, nothing can be edited, and what the tree, the tabs, the
  // viewport and the measure panel show is the viewed document and its model.
  const locked = viewing !== null;
  const shownDocuments = viewing?.documents ?? documents;
  const shownModel = viewing?.model ?? model;
  // Hiding a body while viewing is the view's own: the open document's hidden bodies stay.
  const shownSettings = viewing?.settings ?? settings;

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

  // Regenerate the document on every change, once the kernel is up. Exporting every
  // configuration shares the regenerator, holding the open document's regens meanwhile.
  const loaded = bodies !== null;
  const shared = useMemo(
    () => (loader.regenerator ? shareRegenerator(loader.regenerator) : null),
    [loader],
  );
  useEffect(() => {
    if (!loaded || !shared) return;
    return startRegen(shared.regenerator, documents, model);
  }, [loaded, shared, documents, model]);
  const configurationError = useModel(shownModel, (s) => s.configurationError);
  // Regen builds every part studio; the viewport, the sketches and the picks see the active one.
  const activePartId = useStore(documents, (s) => s.activePartId);
  // The part studio shown: the active one, or the viewed document's while viewing.
  const shownPartId = useStore(shownDocuments, (s) => s.activePartId);
  const allParts = useModel(shownModel, (s) => s.parts);
  const parts = useMemo(
    () => allParts.filter((p) => p.partId === shownPartId),
    [allParts, shownPartId],
  );
  const modelGeneration = useModel(shownModel, (s) => s.generation);
  const viewPending = useModel(shownModel, (s) => s.pending);
  const viewError = useModel(shownModel, (s) => s.error);
  const document = useStore(documents, (s) => s.document);
  const shownDocument = useStore(shownDocuments, (s) => s.document);
  // The active part's bodies with their names, colours and materials; hidden ones are neither
  // drawn nor picked (view state, per document).
  const hiddenIds = useStore(shownSettings, (s) => hiddenBodiesOf(s, document.id));
  const activeBodies = useMemo(
    () => bodiesOfPart(findPart(shownDocument, shownPartId), parts[0], new Set(hiddenIds)),
    [shownDocument, shownPartId, parts, hiddenIds],
  );
  // The same array while the shown bodies are the same objects, so a document change that
  // changes nothing in the view does not rebuild it (state from the previous render).
  const visibleBodies = useMemo(
    () => activeBodies.filter((b) => !b.hidden).map((b) => b.view),
    [activeBodies],
  );
  const [stableBodies, setStableBodies] = useState<readonly BodyInput[]>(visibleBodies);
  let partBodies = stableBodies;
  if (sameOr(stableBodies, visibleBodies) !== stableBodies) {
    setStableBodies(visibleBodies);
    partBodies = visibleBodies;
  }
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

  const sketches = useMemo(
    () => sketchFeatures(shownDocument, shownPartId),
    [shownDocument, shownPartId],
  );
  const shownImports = useMemo(() => {
    const features = findPart(shownDocument, shownPartId)?.features ?? [];
    return (locked ? [...imports, ...viewImports] : imports).filter(
      (i) => i.partId === shownPartId && features.some((f) => f.id === i.feature.id),
    );
  }, [imports, viewImports, locked, shownDocument, shownPartId]);
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
    // And the bodies of a state being viewed.
    for (const i of viewImportsRef.current) keep.add(importBodyId(i.partId, i.feature.id));
    for (const id of viewReading.current.keys()) keep.add(id);
    loader.exchanger?.retain(keep);
    const kept = (i: ImportedBody) => keep.has(importBodyId(i.partId, i.feature.id));
    setImports((prev) => (prev.every(kept) ? prev : prev.filter(kept)));
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
      const current = importsRef.current;
      if (!current.some((i) => i.feature.source.format === 'step')) return;
      void import('./io/actions')
        .then(({ reimportSteps }) => reimportSteps(exchanger, current))
        .catch(() => undefined);
    });
  }, [loader]);
  // A part studio that arrives with reference imports (a duplicate, a redo that puts one back
  // after its bodies were dropped, a restored version) has no bodies for them yet: read just
  // those from their files and add them to the ones held.
  const loadedRef = useRef(loaded);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);
  const reading = useRef(new Set<string>());
  useEffect(() => {
    return documents.core.subscribe((event) => {
      if (event.cause === 'load' || !loadedRef.current) return;
      // A restore (or its undo or redo) replaces the whole document: any part studio can hold a
      // reference import not read yet. Otherwise only part studios that arrived can.
      const whole = event.command?.type === 'replaceDocument';
      const added = new Set(
        event.change.parts.filter((p) => whole || p.status === 'added').map((p) => p.partId),
      );
      if (added.size === 0) return;
      const have = new Set(importsRef.current.map((i) => importBodyId(i.partId, i.feature.id)));
      const missing = new Set<string>();
      for (const part of event.document.parts) {
        if (!added.has(part.id)) continue;
        for (const f of part.features) {
          const id = importBodyId(part.id, f.id);
          if (f.kind !== 'import' || f.operation !== 'reference') continue;
          if (!have.has(id) && !reading.current.has(id)) missing.add(id);
        }
      }
      if (missing.size === 0) return;
      for (const id of missing) reading.current.add(id);
      const doc = event.document;
      import('./persistence/imports')
        .then(({ restoreImports }) => restoreImports(doc, loader.exchanger ?? null, missing))
        .then(
          (r) => {
            if (documents.getState().document.id !== doc.id) return;
            const key = (i: ImportedBody) => importBodyId(i.partId, i.feature.id);
            setImports((prev) => {
              const held = new Set(prev.map(key));
              const fresh = r.bodies.filter((b) => !held.has(key(b)));
              return fresh.length === 0 ? prev : [...prev, ...fresh];
            });
            if (r.errors.length > 0) {
              setIoStatus({
                error: true,
                text: `Could not read an import again: ${r.errors.join(' ')}`,
              });
            }
          },
          (e: unknown) =>
            setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => {
          for (const id of missing) reading.current.delete(id);
          pruneImports();
        });
    });
  }, [documents, loader, pruneImports]);
  // Open a document in the editor: the imported reference bodies of the one before are
  // dropped (feature ids repeat across documents), and this one's are read again from its files.
  // A stored document shows on the branch it was opened on (main unless `branch` says).
  const show = useCallback(
    (
      doc: ManufaktureDocument,
      options: { stored: boolean; stayHome?: boolean; branch?: string },
    ) => {
      loader.exchanger?.retain(new Set());
      setImports([]);
      documents.getState().load(doc);
      setRestoreRequest(hasReferenceImports(doc) ? doc : null);
      const on = options.stored ? (options.branch ?? MAIN_BRANCH) : MAIN_BRANCH;
      branchStore.setState({ id: on });
      setBranchesRevision((n) => n + 1);
      showDocIdInUrl(options.stored ? doc.id : null);
      showBranchInUrl(options.stored && on !== MAIN_BRANCH ? on : null);
      if (!options.stayHome) setView('editor');
    },
    [loader, documents, branchStore],
  );
  const restoring = useRef<ManufaktureDocument | null>(null);
  useEffect(() => {
    if (!loaded || !restoreRequest || restoring.current === restoreRequest) return;
    const doc = restoreRequest;
    restoring.current = doc;
    importing.current = true;
    import('./persistence/imports')
      .then(({ restoreImports }) => restoreImports(doc, loader.exchanger ?? null))
      .then(
        (r) => {
          if (documents.getState().document.id !== doc.id) return;
          setImports(r.bodies);
          if (r.errors.length > 0) {
            setIoStatus({
              error: true,
              text: `Could not read an import again: ${r.errors.join(' ')}`,
            });
          }
        },
        (e: unknown) =>
          setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => {
        importing.current = false;
        restoring.current = null;
        setRestoreRequest((current) => (current === doc ? null : current));
        pruneImports();
      });
  }, [loaded, restoreRequest, loader, documents, pruneImports]);

  // Open the library, then the document the URL names (or the most recent one). A scene with
  // its own document (the demo) keeps that one.
  const opening = useRef(false);
  // The part studio the URL names, read once before anything rewrites the URL.
  const [initialPartId] = useState(() =>
    typeof window === 'undefined' ? null : partIdFromSearch(window.location.search),
  );
  useEffect(() => {
    if (!libraryPromise || opening.current) return;
    opening.current = true;
    void (async () => {
      let lib: DocumentLibrary;
      try {
        lib = await libraryPromise;
      } catch (e) {
        setIoStatus({
          error: true,
          text: `Documents cannot be saved: ${e instanceof Error ? e.message : String(e)}`,
        });
        setDocReady(true);
        return;
      }
      if (!loader.initialDocument) {
        const fromUrl = initialDocumentId === undefined;
        const wanted = fromUrl ? docIdFromSearch(window.location.search) : initialDocumentId;
        // The branch the URL names, with its document; none means the main branch.
        const wantedBranch =
          fromUrl && wanted !== null ? branchFromSearch(window.location.search) : null;
        const id = wanted ?? (await lib.list()).find((d) => d.damaged === undefined)?.id ?? null;
        if (id !== null) {
          let on = wantedBranch ?? MAIN_BRANCH;
          let opened = await lib.open(id, on);
          let gone: string | null = null;
          if (!opened.ok && wantedBranch !== null) {
            // A branch deleted since the link was made: its document, on main. The message never
            // repeats the id from the link.
            gone = opened.message;
            on = MAIN_BRANCH;
            opened = await lib.open(id);
          }
          if (opened.ok) {
            show(opened.value.document, { stored: true, branch: on });
            if (wanted === id && initialPartId !== null) {
              documents.getState().setActivePart(initialPartId);
            }
            // Recovered or migrated: say so, as the home screen does.
            const note = openedMessage(opened.value, true);
            if (gone !== null) {
              setIoStatus({
                error: true,
                text: `The branch in the link cannot be opened (${gone}); this is the main branch.`,
              });
            } else if (note) setIoStatus({ error: false, text: note });
          } else {
            showDocIdInUrl(null);
            setHomeOutcome({
              ok: false,
              message: `The document could not be opened. ${opened.message}`,
            });
            setView('home');
          }
        }
      }
      setLibrary(lib);
      setDocReady(true);
    })();
  }, [libraryPromise, loader, initialDocumentId, show, documents, initialPartId]);

  // The URL names the active part studio (none for the first), once the document is open.
  useEffect(() => {
    if (!docReady) return;
    showPartIdInUrl(document.parts[0]?.id === activePartId ? null : activePartId);
  }, [docReady, document, activePartId]);
  // What was selected belongs to the part studio shown before.
  const shownPart = useRef(activePartId);
  useEffect(() => {
    if (shownPart.current === activePartId) return;
    shownPart.current = activePartId;
    selection.getState().clear();
  }, [activePartId, selection]);

  // Autosave the open document; ask once for persistent storage after the first save.
  const askedPersistence = useRef(false);
  useEffect(() => {
    if (!library) return;
    const auto = startAutosave(documents, library, {
      ...autosaveDelays,
      branch: () => branchStore.getState().id,
      onSaved: (summary) => {
        if (summary.id === documents.getState().document.id) showDocIdInUrl(summary.id);
        setHistoryRevision((n) => n + 1);
        if (!askedPersistence.current && library.kind !== 'memory') {
          askedPersistence.current = true;
          void requestPersistence();
        }
      },
    });
    setAutosave(auto);
    // Save before the page goes away (best effort: the browser may not wait).
    const onHide = () => {
      if (window.document.visibilityState === 'hidden') void auto.flush();
    };
    // Closing or reloading with changes not saved yet (waiting, being written, failed, or in
    // conflict with another tab): the browser asks the user first, and the save starts.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!auto.unsaved()) return;
      void auto.flush();
      e.preventDefault();
      // Older browsers ask only when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      void auto.stop();
    };
  }, [library, documents, autosaveDelays, branchStore]);
  const saveStatus = useStore(autosave?.status ?? NO_SAVING);

  // Test hooks for persistence (see testHooks.ts): named versions have no UI yet.
  useEffect(() => {
    if (!testHooksEnabled || !library || !autosave) return;
    window.__manufakture = { ...window.__manufakture, library, autosave };
    return () => {
      const hooks = window.__manufakture;
      if (!hooks) return;
      delete hooks.library;
      delete hooks.autosave;
      if (Object.keys(hooks).length === 0) delete window.__manufakture;
    };
  }, [library, autosave]);

  const actions = useMemo(
    () =>
      library
        ? homeActions({
            library,
            documents,
            autosave,
            show,
            download: downloadBytes,
            branch: () => branchStore.getState().id,
          })
        : null,
    [library, documents, autosave, show, branchStore],
  );

  // Viewing a version or a revision: read it back, build it in the worker beside the open
  // document, and show it read-only until Back or Restore.
  // Numbers the view requests. Each new request, Back, Restore and a change of the open
  // document's id move it on; a request that finds it moved after an await gives up, so a
  // superseded view never starts or keeps the worker.
  const viewRequests = useRef(0);
  const endView = useCallback((): Promise<void> => {
    const v = viewingRef.current;
    viewingRef.current = null;
    if (!v) return Promise.resolve();
    v.session?.stop();
    setViewing(null);
    // The view's own reference bodies go (unless a restore made them the document's).
    if (viewImportsRef.current.length > 0) {
      viewImportsRef.current = [];
      setViewImports([]);
      pruneImports();
    }
    return v.session ? v.session.done.catch(() => undefined) : Promise.resolve();
  }, [pruneImports]);
  const onView = useCallback(
    async (target: HistoryTarget) => {
      if (!library) return;
      const mine = ++viewRequests.current;
      const id = documents.getState().document.id;
      const label = targetLabel(target);
      const read = await readTarget(library, id, target);
      if (mine !== viewRequests.current) return;
      if (!read.ok) {
        setIoStatus({ error: true, text: `${label} cannot be read: ${read.message}` });
        return;
      }
      // Checked before endView so a read for a document no longer open does not end the current
      // view, and again after it because the open document can change while endView waits.
      if (documents.getState().document.id !== id) return;
      // The view before hands the worker back first.
      await endView();
      if (mine !== viewRequests.current || documents.getState().document.id !== id) return;
      let viewDocs: DocumentStoreApi;
      try {
        viewDocs = viewDocuments(read.value, documents.getState().activePartId);
      } catch (e) {
        setIoStatus({
          error: true,
          text: `${label} cannot be shown: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      // Its reference bodies that the open document does not hold, read from their files.
      const held = new Set(importsRef.current.map((i) => importBodyId(i.partId, i.feature.id)));
      const missing = new Set(referenceImportIds(read.value).filter((bodyId) => !held.has(bodyId)));
      let extra: readonly ImportedBody[] = [];
      if (missing.size > 0) {
        for (const bodyId of missing) {
          viewReading.current.set(bodyId, (viewReading.current.get(bodyId) ?? 0) + 1);
        }
        try {
          const { restoreImports } = await import('./persistence/imports');
          const r = await restoreImports(read.value, loader.exchanger ?? null, missing);
          extra = r.bodies;
          if (r.errors.length > 0) {
            setIoStatus({
              error: true,
              text: `Could not read an import of ${label}: ${r.errors.join(' ')}`,
            });
          }
        } catch (e) {
          setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) });
        } finally {
          for (const bodyId of missing) {
            const left = (viewReading.current.get(bodyId) ?? 1) - 1;
            if (left > 0) viewReading.current.set(bodyId, left);
            else viewReading.current.delete(bodyId);
          }
        }
        if (mine !== viewRequests.current || documents.getState().document.id !== id) {
          // Overtaken meanwhile: release what was read.
          pruneImports();
          return;
        }
      }
      // Nothing awaits from here to recording the view, so this session is the current one.
      const session = shared ? startView(shared, read.value) : null;
      viewImportsRef.current = extra;
      setViewImports(extra);
      const v: Viewing = {
        settings: viewSettingsFor(settings, id),
        target,
        label,
        document: read.value,
        documents: viewDocs,
        model: session?.model ?? createModelStore(),
        session,
      };
      session?.done.catch((e: unknown) => {
        if (viewingRef.current !== v) return;
        void endView();
        setIoStatus({
          error: true,
          text: `${label} cannot be shown now: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
      viewingRef.current = v;
      setViewing(v);
      setIoStatus(null);
    },
    [library, documents, shared, endView, loader, settings, pruneImports],
  );
  const onRestore = useCallback(() => {
    const v = viewingRef.current;
    if (!v) return;
    viewRequests.current += 1;
    // The view's reference bodies become the document's: the restored state has their features,
    // so the subscriber that reads missing imports (run by the restore) finds them held.
    const extra = viewImportsRef.current;
    const before = importsRef.current;
    if (extra.length > 0) {
      const merged = [...before, ...extra];
      importsRef.current = merged;
      setImports(merged);
      viewImportsRef.current = [];
      setViewImports([]);
    }
    const current = documents.getState().document;
    const r = documents
      .getState()
      .execute(restoreCommand(current, v.document), `Restore ${v.label}`);
    if (!r.ok) {
      setIoStatus({ error: true, text: `${v.label} cannot be restored: ${r.error.message}` });
      // Nothing changed: the view stays open, and its bodies go back to being the view's.
      if (extra.length > 0) {
        importsRef.current = before;
        setImports(before);
        viewImportsRef.current = extra;
        setViewImports(extra);
      }
      return;
    }
    void endView();
    // Other reference imports the restored state has and this session has not read yet are
    // read by the part studio subscriber above, which adds them beside the ones held now.
    setIoStatus({
      error: false,
      text: r.value.empty
        ? `${v.label} is the same as the current state: nothing changed.`
        : `Restored ${v.label}. Undo takes it back.`,
    });
  }, [documents, endView]);
  // Back ends the view and any view still being read.
  const onBack = useCallback(() => {
    viewRequests.current += 1;
    void endView();
  }, [endView]);
  // When the open document's id changes (another document is opened), any view, or view being
  // read, ends; so does leaving the app.
  useEffect(() => {
    viewRequests.current += 1;
    if (viewingRef.current && viewingRef.current.document.id !== document.id) void endView();
  }, [document.id, endView]);
  useEffect(() => () => viewingRef.current?.session?.stop(), []);
  // What was selected belongs to what was shown before.
  const shownView = useRef(viewing);
  useEffect(() => {
    if (shownView.current === viewing) return;
    shownView.current = viewing;
    selection.getState().clear();
  }, [viewing, selection]);
  const differences = useMemo(
    () => (viewing ? compareDocuments(document, viewing.document) : []),
    [viewing, document],
  );

  // Branches: the open document's, read again when it is saved (the first save stores it) or
  // its list changes. Null while it is not stored, so no switcher shows.
  const storedOnce = historyRevision > 0;
  useEffect(() => {
    if (!library) return;
    let cancelled = false;
    void (async () => {
      const r = (await library.has(document.id)) ? await library.listBranches(document.id) : null;
      if (!cancelled) setBranches(r?.ok ? r.value : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [library, document.id, branch, branchesRevision, storedOnce]);

  /**
   * Save what is pending on the open branch; null when that worked, else why not. Switching
   * branches never carries one branch's unsaved changes onto another.
   */
  const saveBranchFirst = useCallback(async (): Promise<string | null> => {
    if (!autosave || (await autosave.flush())) return null;
    const { message } = autosave.status.getState();
    return `The changes made here are not saved (${message ?? 'the save failed'}), so the branch was not changed.`;
  }, [autosave]);

  /** Open branch `target` of the open document in the editor. Null when it worked. */
  const openBranch = useCallback(
    async (target: string, done?: string): Promise<string | null> => {
      if (!library) return 'Nothing is saved here.';
      const id = documents.getState().document.id;
      const stop = await saveBranchFirst();
      if (stop) return stop;
      viewRequests.current += 1;
      await endView();
      const opened = await library.open(id, target);
      if (!opened.ok) return `The branch cannot be opened: ${opened.message}`;
      if (documents.getState().document.id !== id) return null;
      show(opened.value.document, { stored: true, branch: target });
      setIoStatus(done ? { error: false, text: done } : null);
      return null;
    },
    [library, documents, saveBranchFirst, endView, show],
  );
  const onSwitchBranch = useCallback(
    (target: string) => {
      const name = branches?.find((b) => b.id === target)?.name ?? target;
      void openBranch(target, `Switched to the branch ${name}.`).then((failure) => {
        if (failure) setIoStatus({ error: true, text: failure });
      });
    },
    [openBranch, branches],
  );
  const onRenameBranch = useCallback(
    async (target: string, name: string): Promise<string | null> => {
      if (!library) return 'Nothing is saved here.';
      const r = await library.renameBranch(documents.getState().document.id, target, name);
      setBranchesRevision((n) => n + 1);
      return r.ok ? null : r.message;
    },
    [library, documents],
  );
  const onDeleteBranch = useCallback(
    async (target: string): Promise<string | null> => {
      if (!library) return 'Nothing is saved here.';
      const id = documents.getState().document.id;
      const name = branches?.find((b) => b.id === target)?.name ?? target;
      // Its pending changes are saved first (they would otherwise be retried onto a branch that
      // is gone), then it goes, then main opens. Main always: the deleted branch was the open one
      // (the switcher offers Delete for the open branch only).
      const stop = await saveBranchFirst();
      if (stop) return stop;
      const r = await library.deleteBranch(id, target);
      setBranchesRevision((n) => n + 1);
      if (!r.ok) return r.message;
      return openBranch(MAIN_BRANCH, `Deleted the branch ${name}; this is the main branch.`);
    },
    [library, documents, branches, saveBranchFirst, openBranch],
  );
  // Branch from the version viewed: the new branch opens in the editor.
  const onBranchFrom = useCallback(
    async (name: string): Promise<string | null> => {
      const v = viewingRef.current;
      if (!library || !v || v.target.kind !== 'version') return null;
      const id = documents.getState().document.id;
      const stop = await saveBranchFirst();
      if (stop) return stop;
      const r = await library.createBranch(id, v.target.version.id, name);
      if (!r.ok) return r.message;
      setBranchesRevision((n) => n + 1);
      const failure = await openBranch(
        r.value.id,
        `Created the branch ${r.value.name} from ${v.label}; changes now go to it.`,
      );
      if (failure) setIoStatus({ error: true, text: failure });
      return null;
    },
    [library, documents, saveBranchFirst, openBranch],
  );
  const branchName =
    branch === MAIN_BRANCH ? undefined : (branches?.find((b) => b.id === branch)?.name ?? branch);

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

  const exportable = useMemo(
    () => activeBodies.map((b) => ({ id: b.viewId, name: b.name, hidden: b.hidden })),
    [activeBodies],
  );
  const onExport = useCallback(
    (format: ExportFormat, tolerance: ExportTolerancePreset, ids: readonly string[]) => {
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
          exportBodies(exchanger, format, {
            tolerance,
            documentName: document.name,
            // The active part's chosen bodies; a scene without regen exports what it holds.
            ...(loader.regenerator ? { bodies: exportable.filter((b) => ids.includes(b.id)) } : {}),
          }),
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
    [loader, document.name, exportable],
  );

  // Every configuration, one file per row, each from its own regen; the files download as they
  // are made, so a cancelled export keeps the ones it finished.
  const onExportAll = useCallback(
    (
      format: ConfigurationExportFormat,
      tolerance: ExportTolerancePreset,
      ids: readonly string[],
    ) => {
      const exchanger = loader.exchanger;
      if (!exchanger || !shared) {
        setIoStatus({ error: true, text: 'Export needs the geometry kernel.' });
        return;
      }
      const { document: doc, activePartId: partId } = documents.getState();
      // Bodies not chosen in the menu, and hidden ones it does not list (a body that exists only
      // in another configuration is written unless it is hidden).
      const chosen = new Set(ids);
      const skip = new Set(
        [...exportable.map((b) => b.id), ...hiddenIds].filter((id) => !chosen.has(id)),
      );
      const controller = new AbortController();
      setIoBusy(true);
      setIoStatus(null);
      setExportAll({ index: 0, count: doc.configurations?.rows.length ?? 0, row: '', controller });
      import('./io/configExport')
        .then(({ exportConfigurations }) =>
          shared.exclusive((regen) =>
            exportConfigurations(exchanger, regen, {
              document: doc,
              partId,
              format,
              tolerance,
              skip,
              signal: controller.signal,
              onProgress: ({ index, count, row }) =>
                setExportAll({ index, count, row: row.name, controller }),
              onFile: (f) => downloadBytes(f.bytes, f.name, f.type),
            }),
          ),
        )
        .then(
          (r) => setIoStatus({ error: !r.ok && !r.cancelled, text: r.message }),
          (e: unknown) =>
            setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => {
          setExportAll(null);
          setIoBusy(false);
        });
    },
    [loader, shared, documents, exportable, hiddenIds],
  );
  const configurationCount = document.configurations?.rows.length ?? 0;

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
  // A file dropped anywhere on the page: a .mfk opens as a document; in the editor, a STEP or
  // STL file is imported as a reference body. Never let the browser navigate to a dropped file.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      e.preventDefault();
      if (/\.mfk$/i.test(file.name)) {
        if (!actions) return;
        void actions
          .importPicked(file)
          .catch((e: unknown): ActionOutcome => ({
            ok: false,
            message: `${file.name}: ${e instanceof Error ? e.message : String(e)}`,
          }))
          .then((outcome) => {
            setHomeOutcome(outcome);
            setHomeRevision((n) => n + 1);
            if (!outcome.ok) setView('home');
          });
      } else if (viewRef.current === 'editor' && !viewingRef.current) onImport(file);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [actions, onImport]);

  const sketching = useSketching(session, documents, viewport, placements);
  // The open feature dialog, if any: a new feature from the toolbar, or one opened from the tree.
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const onEditFeature = useCallback(
    (featureId: string, options: { repick?: string } = {}) => {
      const { document: doc, activePartId: partId } = documents.getState();
      const feature = findPart(doc, partId)?.features.find((f) => f.id === featureId);
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
      // A past state being viewed cannot be changed; undo waits until the view ends.
      if (viewingRef.current) return;
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
    // Nothing selected in a part of several bodies: every shown body is measured too.
    const every = refs.length === 0 && partBodies.length > 1 ? partBodies.map((b) => b.id) : [];
    void measure.getState().measure(
      measurer,
      bodyId === null
        ? null
        : {
            bodyId,
            targets: measureTargets(refs.filter((r) => r.bodyId === bodyId)),
            revision: bodiesRevision.current,
            ...(every.length > 0 ? { bodies: every } : {}),
          },
    );
  }, [shownBodies, partBodies, modelGeneration, selected, measurer, measure]);
  const measuredBodies = useMemo(
    () => activeBodies.map((b) => ({ viewId: b.viewId, name: b.name, material: b.material })),
    [activeBodies],
  );

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

  if (view === 'home' && actions && library) {
    const open = documents.getState().document;
    return (
      <HomeScreen
        actions={actions}
        kind={library.kind}
        current={{ id: open.id, name: open.name }}
        onClose={() => setView('editor')}
        storage={storageInfo}
        onPersist={requestPersistence}
        outcome={homeOutcome}
        revision={homeRevision}
      />
    );
  }
  if (shownBodies === null || !docReady) {
    return (
      <LoadingSplash
        status={shownBodies === null ? status : { label: 'Opening the document', fraction: null }}
        error={error}
      />
    );
  }

  const stores = { selection, settings };
  // The save status is about the open document, unless an earlier one failed to save.
  const statusHere = saveStatus.documentId === document.id;
  const failing = saveStatus.state === 'error' || saveStatus.state === 'conflict';
  const saveText = failing
    ? `${statusHere ? 'Not saved' : `${saveStatus.documentName} not saved`}: ${saveStatus.message ?? ''}`
    : statusHere
      ? SAVE_TEXT[saveStatus.state]
      : '';
  const resolveConflict = async (action: () => Promise<ActionOutcome>) => {
    try {
      const r = await action();
      setIoStatus({ error: !r.ok, text: r.message });
    } catch (e) {
      setIoStatus({ error: true, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="app">
      <header className="app-header">
        <h1>manufakture</h1>
        {library && (
          <div className="toolbar-group document-title">
            <button
              type="button"
              disabled={sketching.active || dialog !== null || locked}
              onClick={() => {
                setHomeOutcome(null);
                void autosave?.flush();
                setView('home');
              }}
              data-testid="open-home"
              title="Your documents: open, new, rename, duplicate, delete, import and export"
            >
              Documents
            </button>
            <button
              type="button"
              aria-pressed={historyOpen}
              disabled={sketching.active}
              onClick={() => setHistoryOpen((open) => !open)}
              data-testid="open-history"
              title="Versions and the timeline of saved changes: view, compare and restore"
            >
              History
            </button>
            <span className="document-name" data-testid="document-name" title={document.name}>
              {document.name}
            </span>
            {branches && (
              <BranchSwitcher
                branches={branches}
                current={branch}
                onSwitch={onSwitchBranch}
                onRename={onRenameBranch}
                onDelete={onDeleteBranch}
                disabled={sketching.active || dialog !== null || locked || exportAll !== null}
              />
            )}
            <span
              className={failing ? 'save-status save-error' : 'save-status'}
              role={failing ? 'alert' : 'status'}
              data-testid="save-status"
              title={saveStatus.message ?? undefined}
            >
              {saveText}
            </span>
          </div>
        )}
        <div className="toolbar-group document-actions">
          <SketchMenu
            face={face}
            disabled={sketching.active || dialog !== null || locked}
            onPick={(target) => sketching.enter(target)}
          />
          <button
            type="button"
            disabled={sketching.active || locked || !canUndo}
            title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
            onClick={() => documents.getState().undo()}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={sketching.active || locked || !canRedo}
            title={redoLabel ? `Redo ${redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
            onClick={() => documents.getState().redo()}
          >
            Redo
          </button>
          <ConfigurationSwitcher
            documents={documents}
            disabled={sketching.active || dialog !== null || exportAll !== null || locked}
          />
          <ExportMenu
            disabled={sketching.active || ioBusy || !loader.exchanger || locked}
            bodies={exportable}
            onExport={onExport}
            configurations={shared ? configurationCount : 0}
            onExportAll={onExportAll}
          />
          <ImportButton disabled={sketching.active || ioBusy || locked} onFile={onImport} />
          {exportAll && (
            <ExportProgress
              index={exportAll.index}
              count={exportAll.count}
              row={exportAll.row}
              onCancel={() => exportAll.controller.abort()}
            />
          )}
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
      {actions && saveStatus.state === 'conflict' && statusHere && (
        <div className="save-conflict" role="alert" data-testid="save-conflict">
          <span>
            {document.name} was changed in another tab or window since this tab opened it, so the
            changes made here are not saved. Choose which version to keep:
          </span>
          <button
            type="button"
            data-testid="conflict-reload"
            onClick={() => void resolveConflict(actions.reloadNewer)}
          >
            Load the newer version (drop the changes made here)
          </button>
          <button
            type="button"
            data-testid="conflict-copy"
            onClick={() => void resolveConflict(actions.keepAsCopy)}
          >
            Keep this version as a copy
          </button>
        </div>
      )}
      {viewing && (
        <ViewerBanner
          label={viewing.label}
          differences={differences}
          pending={viewPending}
          error={viewError}
          onBack={onBack}
          onRestore={onRestore}
          onBranch={viewing.target.kind === 'version' && library ? onBranchFrom : undefined}
          branchName={viewing.target.kind === 'version' ? viewing.target.version.name : ''}
        />
      )}
      {/* The part tools; in a sketch the sketch toolbar takes this row. While a past state is
        viewed there is nothing to edit, so they step aside. */}
      {!sketching.active && !locked && (
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
        <div
          className="part-studio-panel"
          id={PART_STUDIO_PANEL_ID}
          role="tabpanel"
          aria-labelledby={`part-tab-${shownPartId}`}
        >
          {/* A sketch is edited on its own (the tree cannot change anything meanwhile), so the
            tree steps aside and the sketch gets the room. */}
          {!sketching.active && (
            <FeatureTree
              documents={shownDocuments}
              model={shownModel}
              selection={selection}
              settings={shownSettings}
              disabled={dialog !== null || locked}
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
                Nothing here yet. Start with <strong>New sketch</strong>: pick a plane, draw a
                closed shape, then extrude it.
              </p>
            )}
            {viewport && !sketching.active && (
              <MeasureOverlay viewport={viewport} measure={measure} units={shownDocument.units} />
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
                {historyOpen && library && (
                  <HistoryPanel
                    source={library}
                    documentId={document.id}
                    branch={branch}
                    branchName={branchName}
                    branches={branches}
                    refresh={historyRevision}
                    createVersion={autosave ? autosave.createVersion : null}
                    onView={(target) => void onView(target)}
                    viewing={viewing?.target ?? null}
                    disabled={exportAll !== null}
                    createDisabled={locked}
                    onClose={() => setHistoryOpen(false)}
                  />
                )}
                {!locked && (
                  <>
                    <VariablesPanel documents={documents} selection={selection} />
                    <ConfigurationsPanel
                      documents={documents}
                      configurationError={configurationError}
                      disabled={exportAll !== null}
                    />
                  </>
                )}
                <SelectionPanel selection={selection} />
                <MeasurePanel
                  measure={measure}
                  documents={shownDocuments}
                  bodies={measuredBodies}
                />
              </>
            )}
          </div>
        </div>
      </main>
      <PartTabs
        documents={shownDocuments}
        disabled={sketching.active || dialog !== null}
        readOnly={locked}
      />
    </div>
  );
}
