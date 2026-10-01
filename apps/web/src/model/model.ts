// The regenerated model: what the regen engine (in the kernel worker) made of the document, as
// the viewport and the feature tree read it. Per part: the status of every feature and the
// part's bodies, ready for the viewport.
//
// `startRegen` keeps it current: every document change (whatever caused it: a command, undo,
// redo, load) asks for one regen of the whole document (ADR 0007 decision 3), and so does a
// kernel recycle, which loses every body. Regens supersede each other in the worker; a result
// that completes is applied when it is newer than the one shown, so the model only moves forward.
// A regen that comes back null while it is still the newest request was dropped by something
// other than a newer regen (a batch at a newer generation, a worker restart): nobody else will
// report, so it is asked for again.
//
// Regen builds the document in its active configuration row (`configured`, T2.4b); the model's
// `document` stays the stored one, which is what the tree compares against. Exporting every
// configuration regenerates other rows through the same worker: `shareRegenerator` holds the
// open document's regens back meanwhile and builds it again when that is done.
//
// Viewing a past version (T2.5b) works the same way: `startView` builds the viewed document in
// its own model store, holding the worker for as long as the view is open, so the open
// document's model and history are not touched; when the view ends, the open document is built
// again.

import { configured, type ManufaktureDocument } from '@manufakture/core';
import type { AssemblyResult, FeatureResult } from '@manufakture/regen';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DocumentStoreApi } from '../state/document';
import type { BodyInput } from '../viewport/bodies';

/** One body of a regenerated part, as the app shows it. */
export interface ModelBody {
  /** Regen's body id: the id of the feature that made it (`extrude#3`), or of its copy. */
  bodyId: string;
  /** The feature that made it. */
  creator: string;
  /** How many solids it holds (a cut can leave a body in several pieces). */
  solids: number;
  /** The body for the viewport; its id is `<part id>/<body id>` (see `viewBodyId`). */
  view: BodyInput;
}

export interface PartModel {
  partId: string;
  /** Per feature, in document order. */
  features: readonly FeatureResult[];
  /**
   * The part's bodies after its last feature, in creator order. Bodies merged away (consumed)
   * are not listed.
   */
  bodies: readonly ModelBody[];
}

/**
 * A pinned part of another document that assembly instances show (regen's `SourceResult`), with
 * its bodies ready for the viewport like a part's.
 */
export interface SourceModel {
  /** `source:<sha256>:<part id>`, as `InstanceResult.source.source` names it. */
  key: string;
  partId: string;
  documentName: string;
  versionName: string;
  bodies: readonly ModelBody[];
}

/** One completed regen, as the app uses it. */
export interface RegenView {
  generation: number;
  parts: readonly PartModel[];
  /** Per assembly: instance transforms and mate diagnostics. Absent: none. */
  assemblies?: readonly AssemblyResult[];
  /** Pinned parts the instances show. Absent: none. */
  sources?: readonly SourceModel[];
  ms: number;
}

/** Turns documents into regen views; the kernel scene loader provides one. */
export interface Regenerator {
  /** Regenerate `document`. Resolves to null when a newer regen superseded it. */
  regen(document: ManufaktureDocument): Promise<RegenView | null>;
  /**
   * `listener` runs when every body the kernel held is gone (a recycle): the current document
   * must be regenerated again. Returns the unsubscribe function.
   */
  onInvalidated(listener: () => void): () => void;
}

export interface ModelState {
  /** Whether there is a regen engine at all (not in the kernel-free test scenes). */
  available: boolean;
  /** A regen is on its way for a document newer than the one shown. */
  pending: boolean;
  /**
   * The last regen failed as a whole (a programming error, never a feature error), or the kernel
   * kept dropping it.
   */
  error: string | null;
  /** Generation of the result shown; 0 before the first. */
  generation: number;
  /** The document the shown result was built from, as stored (before its configuration). */
  document: ManufaktureDocument | null;
  /**
   * The active configuration row could not be applied (a value that does not evaluate): the
   * document is built as it is, without the row, and this says why. Null otherwise.
   */
  configurationError: string | null;
  parts: readonly PartModel[];
  /** Per assembly of the document, in document order (T2.3c). */
  assemblies: readonly AssemblyResult[];
  /** Pinned parts of other documents that instances show. */
  sources: readonly SourceModel[];
  ms: number;
}

export type ModelStore = StoreApi<ModelState>;

export function createModelStore(): ModelStore {
  return createStore<ModelState>()(() => ({
    available: false,
    pending: false,
    error: null,
    generation: 0,
    document: null,
    configurationError: null,
    parts: [],
    assemblies: [],
    sources: [],
    ms: 0,
  }));
}

/** The app's model. Tests create their own with `createModelStore()`. */
export const modelStore: ModelStore = createModelStore();

export function useModel<T>(store: ModelStore, selector: (state: ModelState) => T): T {
  return useStore(store, selector);
}

/** The regen result of one feature, if the shown model has it. */
export function featureResult(
  state: Pick<ModelState, 'parts'>,
  partId: string,
  featureId: string,
): FeatureResult | undefined {
  return state.parts
    .find((p) => p.partId === partId)
    ?.features.find((f) => f.featureId === featureId);
}

/** The regen result of one assembly, if the shown model has it. */
export function assemblyResult(
  state: Pick<ModelState, 'assemblies'>,
  assemblyId: string,
): AssemblyResult | undefined {
  return state.assemblies.find((a) => a.assemblyId === assemblyId);
}

/** Every part body of the shown model, in part order, each part's bodies in creator order. */
export function modelBodies(state: Pick<ModelState, 'parts'>): BodyInput[] {
  return state.parts.flatMap((p) => p.bodies.map((b) => b.view));
}

/**
 * What regen builds for `document`: the document with its active configuration row applied, or
 * `document` itself when it has none. A row that cannot be applied leaves the document as it
 * is, with the reason. (`configured(doc, null)` keeps `active` as it is; the app never asks for
 * that: no active row simply builds the stored document.)
 */
export function buildable(document: ManufaktureDocument): {
  document: ManufaktureDocument;
  error: string | null;
} {
  const r = configured(document);
  if (r.ok) return { document: r.value, error: null };
  return {
    document,
    error: `The active configuration cannot be applied, so the part is shown without it: ${r.error.message}`,
  };
}

/** How often a dropped regen is asked for again before `startRegen` gives up until the next edit. */
const MAX_REGEN_RETRIES = 3;

/**
 * Keep `model` current with `documents` through `regenerator`: a regen now, one per document
 * change and one after every kernel recycle. Returns the stop function.
 */
export function startRegen(
  regenerator: Regenerator,
  documents: DocumentStoreApi,
  model: ModelStore,
): () => void {
  let stopped = false;
  let latest: ManufaktureDocument | null = null;
  // Numbers the requests, so a dropped regen knows whether a newer one will report.
  let requests = 0;

  const request = (document: ManufaktureDocument, retries = 0) => {
    latest = document;
    const mine = ++requests;
    model.setState({ available: true, pending: true });
    const built = buildable(document);
    regenerator.regen(built.document).then(
      (view) => {
        if (stopped) return;
        if (view === null) {
          // Superseded by a newer request, which reports: nothing to do.
          if (mine !== requests) return;
          if (retries < MAX_REGEN_RETRIES) request(document, retries + 1);
          else {
            model.setState({
              pending: false,
              error: 'the kernel kept dropping the request. Edit the part to try again.',
            });
          }
          return;
        }
        if (view.generation <= model.getState().generation) return;
        model.setState({
          generation: view.generation,
          document,
          configurationError: built.error,
          parts: view.parts,
          assemblies: view.assemblies ?? [],
          sources: view.sources ?? [],
          ms: view.ms,
          error: null,
          pending: document !== latest,
        });
      },
      (e: unknown) => {
        if (stopped) return;
        model.setState({
          error: e instanceof Error ? e.message : String(e),
          pending: document !== latest ? model.getState().pending : false,
        });
      },
    );
  };

  const unsubscribe = documents.core.subscribe((event) => request(event.document));
  const uninvalidate = regenerator.onInvalidated(() => {
    if (latest) request(latest);
  });
  request(documents.core.document);
  return () => {
    stopped = true;
    unsubscribe();
    uninvalidate();
  };
}

/**
 * One regenerator shared by the open document (`regenerator`, for `startRegen`) and work that
 * builds other documents through the same kernel worker (`exclusive`), such as exporting every
 * configuration. While exclusive work runs, regens of the open document are held (they would
 * cancel the work's regens, and `startRegen` would ask again); when it ends, the listeners hear
 * that the kernel no longer holds the open document's bodies, so `startRegen` builds it again,
 * and the held requests resolve to null as superseded.
 */
export interface SharedRegenerator {
  regenerator: Regenerator;
  /** Whether exclusive work is running. */
  busy(): boolean;
  /**
   * Run `work`, which regenerates what it likes with `regen`, with the worker to itself. Refused
   * (rejects) while other exclusive work runs.
   */
  exclusive<T>(
    work: (regen: (document: ManufaktureDocument) => Promise<RegenView | null>) => Promise<T>,
  ): Promise<T>;
}

export function shareRegenerator(inner: Regenerator): SharedRegenerator {
  let running = false;
  let held: ((v: RegenView | null) => void)[] = [];
  const listeners = new Set<() => void>();
  return {
    regenerator: {
      regen(document) {
        if (!running) return inner.regen(document);
        return new Promise((resolve) => held.push(resolve));
      },
      onInvalidated(listener) {
        listeners.add(listener);
        const off = inner.onInvalidated(listener);
        return () => {
          listeners.delete(listener);
          off();
        };
      },
    },
    busy: () => running,
    async exclusive(work) {
      if (running) throw new Error('Another export is running.');
      running = true;
      try {
        return await work((document) => inner.regen(document));
      } finally {
        running = false;
        const waiting = held;
        held = [];
        for (const l of [...listeners]) l();
        for (const resolve of waiting) resolve(null);
      }
    },
  };
}

/**
 * A document shown read-only in place of the open one (a version or a revision from its
 * history): its own model, built through the shared regenerator's exclusive slot, which it holds
 * until `stop`. The open document's model stays as it was; its regens wait, and it is built
 * again once the view ends.
 */
export interface ViewSession {
  /** The viewed document, as stored (before its configuration). */
  readonly document: ManufaktureDocument;
  /** The viewed document's model; the open document's is a different store. */
  readonly model: ModelStore;
  /** End the view. Idempotent. */
  stop(): void;
  /**
   * Resolves when the worker is released (after `stop`); rejects when the view could not take
   * it (other exclusive work, such as an export, is running).
   */
  readonly done: Promise<void>;
}

/** Build `document` in a model of its own, holding `shared`'s worker until the view stops. */
export function startView(shared: SharedRegenerator, document: ManufaktureDocument): ViewSession {
  const model = createModelStore();
  let stopped = false;
  let release: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    release = resolve;
  });
  const built = buildable(document);
  const done = shared.exclusive(async (regen) => {
    let requests = 0;
    const request = (retries = 0) => {
      const mine = ++requests;
      model.setState({ available: true, pending: true });
      regen(built.document).then(
        (view) => {
          if (stopped) return;
          if (view === null) {
            if (mine !== requests) return;
            if (retries < MAX_REGEN_RETRIES) request(retries + 1);
            else {
              model.setState({
                pending: false,
                error: 'the kernel kept dropping the request. Go back and view it again.',
              });
            }
            return;
          }
          if (view.generation <= model.getState().generation) return;
          model.setState({
            generation: view.generation,
            document,
            configurationError: built.error,
            parts: view.parts,
            assemblies: view.assemblies ?? [],
            sources: view.sources ?? [],
            ms: view.ms,
            error: null,
            pending: mine !== requests,
          });
        },
        (e: unknown) => {
          if (stopped) return;
          model.setState({ error: e instanceof Error ? e.message : String(e), pending: false });
        },
      );
    };
    // A kernel recycle while viewing loses the viewed bodies too: build them again.
    const off = shared.regenerator.onInvalidated(() => {
      if (!stopped) request();
    });
    if (!stopped) request();
    await ended;
    off();
  });
  return {
    document,
    model,
    stop() {
      stopped = true;
      release();
    },
    done,
  };
}
