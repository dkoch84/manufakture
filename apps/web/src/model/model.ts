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

import type { ManufaktureDocument } from '@manufakture/core';
import type { FeatureResult } from '@manufakture/regen';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DocumentStoreApi } from '../state/document';
import type { BodyInput } from '../viewport/bodies';

export interface PartModel {
  partId: string;
  /** Per feature, in document order. */
  features: readonly FeatureResult[];
  /** The part's first body for the viewport (its id is the part id), or null when it has none. */
  body: BodyInput | null;
  /**
   * Every body of the part for the viewport, `body` first; absent means `body` alone. The others
   * are `<part id>/<body id>` (see `viewBodyId`).
   */
  bodies?: readonly BodyInput[];
}

/** One completed regen, as the app uses it. */
export interface RegenView {
  generation: number;
  parts: readonly PartModel[];
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
  /** The document the shown result was built from. */
  document: ManufaktureDocument | null;
  parts: readonly PartModel[];
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
    parts: [],
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

/** Every part body of the shown model, in part order, each part's bodies in creator order. */
export function modelBodies(state: Pick<ModelState, 'parts'>): BodyInput[] {
  return state.parts.flatMap((p) => p.bodies ?? (p.body ? [p.body] : []));
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
    regenerator.regen(document).then(
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
          parts: view.parts,
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
