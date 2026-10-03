// What the Manufacture workspace shows besides the document (M5 plan, T5.3a): whether it is open,
// the setup and operation being worked on, the open dialog (an operation, the tools), whether the
// next face clicked sets the WCS up direction, the last message, and the last generation's
// toolpaths for the preview. Not document state: none of it is saved or undone. Setups,
// operations and tools live in the document (`doc.cam`, ADR 0014 decision 2).

import type { CamOperationKind, CamSetup, ManufaktureDocument } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { GeneratedToolpaths } from './preview/job';
import type { GeneratedOutcome } from './status';

/** The operation kinds the workspace has a dialog for: all of them (3D surfaces since T5.5b). */
export type DialogOperationKind = CamOperationKind;

export type CamDialog =
  | {
      kind: 'operation';
      operation: DialogOperationKind;
      /** Edit this operation; absent for a new one. */
      operationId?: string;
      /** The index of a geometry source to pick again (from the list's re-pick action). */
      repick?: number;
    }
  | { kind: 'tools' };

export interface CamUiState {
  open: boolean;
  /** The setup being worked on; null or a removed id falls back to the first (`activeCamSetup`). */
  setupId: string | null;
  /** The operation selected in the list, or null. */
  operationId: string | null;
  dialog: CamDialog | null;
  /** The next face clicked in the view becomes the setup's WCS up direction. */
  pickingWcs: boolean;
  /** The last thing that went wrong (a refused command, a pick that is not a planar face). */
  message: string | null;
  /** The last geometry reply for the active setup (regen worker), or null while none came. */
  geometry: CamGeometryResult | null;
  /**
   * The document `geometry` was resolved for (by identity), or null when unknown. A geometry made
   * for another document may be out of date: the export treats it as pending.
   */
  geometryDocument: ManufaktureDocument | null;
  /** The last generation's outcome per operation id, for the active setup. */
  generated: ReadonlyMap<string, GeneratedOutcome>;
  /** A generation is running. */
  generating: boolean;
  /** What the last generation said as a whole (a summary, or why it could not run). */
  generateMessage: string | null;
  /** The last generation's toolpaths for the active setup (packed), for the preview; or null. */
  toolpaths: GeneratedToolpaths | null;

  setOpen(open: boolean): void;
  setSetup(setupId: string | null): void;
  setOperation(operationId: string | null): void;
  openDialog(dialog: CamDialog | null): void;
  setPickingWcs(on: boolean): void;
  setMessage(message: string | null): void;
  /** Keep a geometry reply with the document it was resolved for (null: unknown). */
  setGeometry(geometry: CamGeometryResult | null, document?: ManufaktureDocument | null): void;
  setGenerated(
    generated: ReadonlyMap<string, GeneratedOutcome>,
    generateMessage: string | null,
  ): void;
  setGenerating(generating: boolean, generateMessage?: string | null): void;
  setToolpaths(toolpaths: GeneratedToolpaths | null): void;
}

export type CamUiStore = StoreApi<CamUiState>;

export function createCamUiStore(): CamUiStore {
  return createStore<CamUiState>()((set) => ({
    open: false,
    setupId: null,
    operationId: null,
    dialog: null,
    pickingWcs: false,
    message: null,
    geometry: null,
    geometryDocument: null,
    generated: new Map(),
    generating: false,
    generateMessage: null,
    toolpaths: null,
    setOpen: (open) =>
      set(open ? { open, message: null } : { open, dialog: null, pickingWcs: false }),
    // Another setup: its geometry and toolpaths are another setup's, so they go.
    setSetup: (setupId) =>
      set({
        setupId,
        operationId: null,
        dialog: null,
        pickingWcs: false,
        message: null,
        geometry: null,
        geometryDocument: null,
        generated: new Map(),
        generateMessage: null,
        toolpaths: null,
      }),
    setOperation: (operationId) => set({ operationId }),
    openDialog: (dialog) => set({ dialog, pickingWcs: false, message: null }),
    setPickingWcs: (pickingWcs) => set({ pickingWcs, message: null }),
    setMessage: (message) => set({ message }),
    setGeometry: (geometry, document = null) => set({ geometry, geometryDocument: document }),
    setGenerated: (generated, generateMessage) =>
      set({ generated, generateMessage, generating: false }),
    setGenerating: (generating, generateMessage = null) => set({ generating, generateMessage }),
    setToolpaths: (toolpaths) => set({ toolpaths }),
  }));
}

/** The setup the workspace shows: the chosen one while it exists, else the document's first. */
export function activeCamSetup(
  doc: ManufaktureDocument,
  setupId: string | null,
): CamSetup | undefined {
  return (
    (setupId === null ? undefined : doc.cam.setups.find((s) => s.id === setupId)) ??
    doc.cam.setups[0]
  );
}
