// The Manufacture workspace (M5 plan, T5.3a), loaded when it is first opened. Two panels:
//
// - `CamTree`, in the feature tree's place: the setups (pick, add), the new-operation buttons and
//   the active setup's operations in cut order, modelled on the feature tree: rename, suppress,
//   reorder, delete, move to another setup, per-operation status (geometry resolved or the stage's
//   errors, toolpath generated or failed, stale after an edit) and re-pick for lost geometry; and
//   Generate, which asks the CAM worker for the setup's toolpaths (ADR 0014 decision 8: CAM is
//   lazy, nothing is generated until asked); under it the toolpath preview and playback
//   (`preview/`), drawn into the viewport while the workspace is open; and Export G-code, which
//   opens the export dialog (`export/`) for the setup shown.
// - `CamSidePanel`, in the side panel: the open operation dialog or the Tools dialog, else the
//   setup panel (part, machine, post, stock, WCS, heights).
//
// The geometry of the active setup is asked of the regen worker's CAM stage whenever the document
// or the model changes while the workspace is open; it never starts a regen. Every change is one
// core command, so Undo and Redo cover all of it.

import type { CamOperation, Command, ManufaktureDocument } from '@manufakture/core';
import type { CamClient } from '@manufakture/cam/client';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { ExportedFile } from '../io/actions';
import { downloadBytes } from '../io/files';
import { useModel, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import {
  isGeometryRef,
  itemKey,
  type SelectableItem,
  type SelectionStore,
} from '../state/selection';
import {
  addSetupCommand,
  deleteOperationCommand,
  moveOperationCommand,
  sameWorkpiece,
  renameOperationCommand,
  reorderOperationCommand,
  suppressOperationCommand,
  wcsFaceCommand,
} from './commands';
import { ExportDialog } from './export/ExportDialog';
import { DIALOG_KINDS, OPERATION_LABELS } from './forms';
import type { CamGeometer } from './geometer';
import { OperationDialog } from './OperationDialog';
import { ToolpathPreview } from './preview/ToolpathPreview';
import { setupFaceReference, type CamFaceResolver } from './picking';
import { SetupPanel } from './SetupPanel';
import { activeCamSetup, type CamUiStore, type DialogOperationKind } from './state';
import { generateSetup } from './run';
import { STATE_LABELS, operationStatus } from './status';
import { ToolsDialog } from './ToolsDialog';
import type { ToolLibraryStore } from './library/store';
import './cam.css';

export interface CamTreeProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  camUi: CamUiStore;
  /** The regen worker's CAM geometry stage; null in the kernel-free scenes. */
  geometer: CamGeometer | null;
  /** The CAM worker's client (its worker starts on the first generation); null: none. */
  client: CamClient | null;
  /** Save an exported file; the app's download by default. */
  onSave?: (file: ExportedFile) => void;
  disabled?: boolean;
}

const download = (file: ExportedFile) => downloadBytes(file.bytes, file.name, file.type);

/** Run a command, reporting a refusal in the workspace's message line. */
function runner(documents: DocumentStoreApi, camUi: CamUiStore) {
  return (command: Command, label: string): boolean => {
    const r = documents.getState().execute(command, label);
    camUi.getState().setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };
}

export function CamTree({
  documents,
  model,
  camUi,
  geometer,
  client,
  onSave = download,
  disabled = false,
}: CamTreeProps) {
  const doc = useStore(documents, (s) => s.document);
  const activePartId = useStore(documents, (s) => s.activePartId);
  const setupId = useStore(camUi, (s) => s.setupId);
  const selectedOp = useStore(camUi, (s) => s.operationId);
  const geometry = useStore(camUi, (s) => s.geometry);
  const generated = useStore(camUi, (s) => s.generated);
  const generating = useStore(camUi, (s) => s.generating);
  const generateMessage = useStore(camUi, (s) => s.generateMessage);
  const message = useStore(camUi, (s) => s.message);
  const dialog = useStore(camUi, (s) => s.dialog);
  const generation = useModel(model, (s) => s.generation);
  const setup = activeCamSetup(doc, setupId);
  const run = useMemo(() => runner(documents, camUi), [documents, camUi]);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  // The viewport shows the setup's part: picks and the view are of what it machines.
  const setupPart = setup?.part;
  useEffect(() => {
    if (setupPart !== undefined && documents.getState().activePartId !== setupPart) {
      documents.getState().setActivePart(setupPart);
    }
  }, [setupPart, documents]);

  // The setup's geometry, again whenever the document or the model changes. A reply superseded
  // by a newer regen is null and dropped; the next model generation asks again.
  const shownId = setup?.id;
  useEffect(() => {
    if (!geometer || shownId === undefined) return;
    let live = true;
    geometer.geometry(doc, shownId).then(
      (r) => {
        if (live && r && r.setupId === camUiSetup(camUi, doc)) camUi.getState().setGeometry(r, doc);
      },
      (e: unknown) => {
        if (live) camUi.getState().setMessage(`The geometry could not be resolved: ${String(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [geometer, doc, shownId, generation, camUi]);

  // The part's mesh for the simulation's gouge check, fetched for this document and setup.
  const loadPartMesh = useMemo(() => {
    const id = activeCamSetup(doc, setupId)?.id;
    if (!geometer || id === undefined) return undefined;
    return () => geometer.geometry(doc, id, { mesh: true }).then((g) => g?.mesh ?? null);
  }, [geometer, doc, setupId]);

  const shownGeometry = geometry?.setupId === setup?.id ? geometry : null;
  const ops = setup?.operations ?? [];
  // Only setups of the same part and body: an operation's faces, sketches and holes would find
  // look-alike geometry on another part, or on another body a feature also cut.
  const otherSetups = setup
    ? doc.cam.setups.filter((s) => s.id !== setup.id && sameWorkpiece(s, setup))
    : [];
  const edit = (op: CamOperation, repick?: number) => {
    if (op.kind === 'surface3d') {
      camUi.getState().setMessage('3D surfacing has no dialog yet.');
      return;
    }
    camUi.getState().openDialog({
      kind: 'operation',
      operation: op.kind,
      operationId: op.id,
      ...(repick !== undefined ? { repick } : {}),
    });
  };
  const commitRename = () => {
    if (!renaming || !setup) return;
    const op = setup.operations.find((o) => o.id === renaming.id);
    const text = renaming.text.trim();
    setRenaming(null);
    if (op && text !== '' && text !== op.name) {
      run(renameOperationCommand(setup.id, op, text), `Rename ${op.name} to ${text}`);
    }
  };
  const newSetup = () => {
    const partId = setup?.part ?? activePartId;
    const { command, setupId: id } = addSetupCommand(documents.getState().document, partId);
    if (run(command, 'Add CAM setup')) camUi.getState().setSetup(id);
  };

  return (
    <section className="feature-tree cam-tree" aria-label="Manufacture" data-testid="cam-tree">
      <h2>
        Manufacture
        {generating && (
          <span className="regen-pending" role="status">
            working...
          </span>
        )}
      </h2>
      <div className="cam-setup-bar">
        {doc.cam.setups.length > 0 && (
          <select
            aria-label="CAM setup"
            data-testid="cam-setup-select"
            value={setup?.id ?? ''}
            disabled={disabled || dialog !== null}
            onChange={(e) => camUi.getState().setSetup(e.target.value)}
          >
            {doc.cam.setups.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          data-testid="cam-add-setup"
          disabled={disabled || dialog !== null}
          onClick={newSetup}
        >
          New setup
        </button>
        <button
          type="button"
          data-testid="cam-open-tools"
          aria-pressed={dialog?.kind === 'tools'}
          disabled={disabled || dialog?.kind === 'operation'}
          onClick={() =>
            camUi.getState().openDialog(dialog?.kind === 'tools' ? null : { kind: 'tools' })
          }
        >
          Tools ({doc.cam.tools.length})
        </button>
      </div>
      {message && (
        <p className="tree-message" role="alert" data-testid="cam-message">
          {message}
        </p>
      )}
      {!setup ? (
        <p className="tree-empty" data-testid="cam-empty">
          No setup yet. A setup names the part to machine, the machine and its stock. New setup
          starts one for the part shown, on a Shapeoko 5 Pro 4x4.
        </p>
      ) : (
        <>
          <div className="cam-new-ops" role="toolbar" aria-label="New operation">
            {DIALOG_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`cam-new-${k}`}
                disabled={disabled || dialog !== null}
                onClick={() =>
                  camUi.getState().openDialog({
                    kind: 'operation',
                    operation: k as DialogOperationKind,
                  })
                }
              >
                {OPERATION_LABELS[k]}
              </button>
            ))}
          </div>
          {ops.length === 0 ? (
            <p className="tree-empty">No operations yet. Add one above; they cut in list order.</p>
          ) : (
            <ol className="feature-list cam-op-list" data-testid="cam-op-list">
              {ops.map((op, i) => {
                const status = operationStatus(op, shownGeometry, generated, geometer !== null);
                const tool = doc.cam.tools.find((t) => t.id === op.tool);
                const classes = [
                  'feature-row',
                  'cam-op-row',
                  `status-${status.state}`,
                  selectedOp === op.id ? 'selected' : '',
                  status.stale ? 'stale' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const toolpath =
                  status.toolpath === 'none'
                    ? ''
                    : status.stale
                      ? 'toolpath out of date'
                      : status.toolpath === 'generated'
                        ? 'toolpath generated'
                        : 'toolpath failed';
                return (
                  <li
                    key={op.id}
                    className={classes}
                    data-testid={`cam-op-${op.id}`}
                    aria-selected={selectedOp === op.id}
                    tabIndex={0}
                    onClick={() => camUi.getState().setOperation(op.id)}
                    onDoubleClick={() => !disabled && edit(op)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || disabled) return;
                      if (e.key === 'Enter' && dialog === null) edit(op);
                      if (e.key === 'F2') setRenaming({ id: op.id, text: op.name });
                      if (e.key === 'Delete') {
                        run(deleteOperationCommand(setup.id, op.id), `Delete ${op.name}`);
                      }
                    }}
                  >
                    <div className="cam-op-main">
                      <span className="kind" title={OPERATION_LABELS[op.kind]}>
                        {OPERATION_LABELS[op.kind]}
                      </span>
                      {renaming?.id === op.id ? (
                        <input
                          className="rename"
                          aria-label={`New name for ${op.name}`}
                          data-testid={`cam-rename-${op.id}`}
                          value={renaming.text}
                          autoFocus
                          onChange={(e) => setRenaming({ id: op.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={commitRename}
                        />
                      ) : (
                        <span className="name">{op.name}</span>
                      )}
                      <span
                        className={`cam-status cam-status-${status.state}`}
                        data-testid={`cam-op-status-${op.id}`}
                        data-state={status.state}
                        data-toolpath={status.toolpath}
                        data-stale={status.stale ? 'true' : 'false'}
                        title={[STATE_LABELS[status.state], toolpath].filter(Boolean).join('; ')}
                      >
                        {status.state === 'ok' ? 'ok' : STATE_LABELS[status.state]}
                        {status.stale ? ' (stale)' : ''}
                      </span>
                    </div>
                    <div className="cam-op-detail">
                      {tool ? tool.name : `missing tool ${op.tool}`}
                      {toolpath && ` | ${toolpath}`}
                    </div>
                    {status.errors.length + status.warnings.length > 0 && (
                      <ul className="cam-op-messages" data-testid={`cam-op-messages-${op.id}`}>
                        {status.errors.map((m, j) => (
                          <li key={`e${j}`} className="tip-error">
                            {m}
                          </li>
                        ))}
                        {status.warnings.map((m, j) => (
                          <li key={`w${j}`} className="tip-warning">
                            {m}
                          </li>
                        ))}
                      </ul>
                    )}
                    {status.repick.length > 0 && (
                      <div className="cam-repicks">
                        {status.repick.map((src) => (
                          <button
                            key={src}
                            type="button"
                            data-testid={`cam-op-repick-${op.id}-${src}`}
                            disabled={disabled || dialog !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              edit(op, src);
                            }}
                          >
                            Pick geometry {src + 1} again
                          </button>
                        ))}
                      </div>
                    )}
                    <span className="row-actions cam-op-actions">
                      <button
                        type="button"
                        disabled={disabled || dialog !== null}
                        aria-label={`Edit ${op.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          edit(op);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`Rename ${op.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ id: op.id, text: op.name });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`${op.suppressed ? 'Unsuppress' : 'Suppress'} ${op.name}`}
                        data-testid={`cam-suppress-${op.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          run(
                            suppressOperationCommand(setup.id, op, !op.suppressed),
                            `${op.suppressed ? 'Unsuppress' : 'Suppress'} ${op.name}`,
                          );
                        }}
                      >
                        {op.suppressed ? 'Unsuppress' : 'Suppress'}
                      </button>
                      <button
                        type="button"
                        disabled={disabled || i === 0}
                        aria-label={`Move ${op.name} up`}
                        data-testid={`cam-up-${op.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          run(reorderOperationCommand(setup.id, op.id, i - 1), `Move ${op.name}`);
                        }}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        disabled={disabled || i === ops.length - 1}
                        aria-label={`Move ${op.name} down`}
                        data-testid={`cam-down-${op.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          run(reorderOperationCommand(setup.id, op.id, i + 1), `Move ${op.name}`);
                        }}
                      >
                        Down
                      </button>
                      {otherSetups.length > 0 && (
                        <select
                          aria-label={`Move ${op.name} to another setup`}
                          data-testid={`cam-move-${op.id}`}
                          value=""
                          disabled={disabled}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const command = moveOperationCommand(
                              documents.getState().document,
                              setup.id,
                              op.id,
                              e.target.value,
                            );
                            const to = otherSetups.find((s) => s.id === e.target.value);
                            if (command && to) run(command, `Move ${op.name} to ${to.name}`);
                          }}
                        >
                          <option value="">Move to...</option>
                          {otherSetups.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`Delete ${op.name}`}
                        data-testid={`cam-delete-${op.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          run(deleteOperationCommand(setup.id, op.id), `Delete ${op.name}`);
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="cam-generate">
            <button
              type="button"
              className="primary"
              data-testid="cam-generate"
              disabled={disabled || generating || !geometer || !client || ops.length === 0}
              title={
                !geometer || !client
                  ? 'Toolpaths need the geometry kernel and the CAM worker'
                  : 'Generate the toolpaths of this setup'
              }
              onClick={() => {
                if (geometer && client) {
                  void generateSetup(documents.getState().document, setup, geometer, client, camUi);
                }
              }}
            >
              Generate toolpaths
            </button>
            <button
              type="button"
              data-testid="cam-export"
              disabled={disabled || dialog !== null || ops.length === 0}
              title="Export this setup as G-code, with its setup sheet"
              onClick={() => setExporting(setup.id)}
            >
              Export G-code
            </button>
            {generateMessage && (
              <p className="field-note" role="status" data-testid="cam-generate-message">
                {generateMessage}
              </p>
            )}
          </div>
          <ToolpathPreview
            setup={setup}
            camUi={camUi}
            {...(loadPartMesh ? { loadPartMesh } : {})}
          />
          {exporting === setup.id && (
            <ExportDialog
              documents={documents}
              camUi={camUi}
              setupId={setup.id}
              geometer={geometer}
              client={client}
              onSave={onSave}
              onClose={() => setExporting(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** The id of the setup the workspace shows now (the store's choice, or the first). */
function camUiSetup(camUi: CamUiStore, doc: ManufaktureDocument): string | undefined {
  return activeCamSetup(doc, camUi.getState().setupId)?.id;
}

export interface CamSidePanelProps {
  documents: DocumentStoreApi;
  camUi: CamUiStore;
  selection: SelectionStore;
  resolveFace: CamFaceResolver;
  /** Bodies of a part as the last regen made them, for the body picker. */
  bodiesOf: (partId: string) => readonly { id: string; name: string }[];
  /** Opens the user's tool library; null: none. */
  openLibrary: (() => Promise<ToolLibraryStore>) | null;
  disabled?: boolean;
}

export function CamSidePanel({
  documents,
  camUi,
  selection,
  resolveFace,
  bodiesOf,
  openLibrary,
  disabled = false,
}: CamSidePanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const setupId = useStore(camUi, (s) => s.setupId);
  const dialog = useStore(camUi, (s) => s.dialog);
  const pickingWcs = useStore(camUi, (s) => s.pickingWcs);
  const geometry = useStore(camUi, (s) => s.geometry);
  const setup = activeCamSetup(doc, setupId);
  const run = useMemo(() => runner(documents, camUi), [documents, camUi]);

  // While picking the WCS face, the next face clicked in the view becomes the up direction.
  useEffect(() => {
    if (!pickingWcs) return;
    let previous: readonly SelectableItem[] = selection.getState().selected;
    return selection.subscribe((s) => {
      if (s.selected === previous) return;
      const before = new Set(previous.map(itemKey));
      previous = s.selected;
      const geo = s.selected.find((i) => isGeometryRef(i) && !before.has(itemKey(i)));
      if (!geo || !isGeometryRef(geo)) return;
      const current = activeCamSetup(documents.getState().document, camUi.getState().setupId);
      if (!current) return;
      void setupFaceReference(resolveFace, geo, current).then((r) => {
        if (!camUi.getState().pickingWcs) return;
        if (!r.ok) {
          camUi.getState().setMessage(r.message);
          return;
        }
        const now = documents.getState().document;
        const target = now.cam.setups.find((x) => x.id === current.id);
        if (!target) return;
        // The face was resolved on the part (and body) the setup machined at the click; an undo
        // meanwhile may have pointed it elsewhere.
        if (target.part !== current.part || target.body !== current.body) {
          camUi.getState().setMessage('The setup now machines another part: pick the face again.');
          return;
        }
        if (run(wcsFaceCommand(now, target, r.ref), 'Set the WCS up from a face')) {
          camUi.getState().setPickingWcs(false);
        }
      });
    });
  }, [pickingWcs, selection, resolveFace, documents, camUi, run]);

  if (dialog?.kind === 'tools') {
    return (
      <ToolsDialog
        documents={documents}
        openLibrary={openLibrary}
        onClose={() => camUi.getState().openDialog(null)}
      />
    );
  }
  if (dialog?.kind === 'operation' && setup) {
    return (
      <OperationDialog
        key={`${setup.id}/${dialog.operation}/${dialog.operationId ?? 'new'}/${dialog.repick ?? ''}`}
        request={dialog}
        documents={documents}
        setupId={setup.id}
        selection={selection}
        resolveFace={resolveFace}
        geometry={geometry?.setupId === setup.id ? geometry : null}
        onClose={() => camUi.getState().openDialog(null)}
        onApplied={(id) => camUi.getState().setOperation(id)}
      />
    );
  }
  return (
    <aside className="selection-panel cam-panel" aria-label="CAM setup" data-testid="cam-panel">
      <div className="print-head">
        <h2>Setup</h2>
        {setup && (
          <button
            type="button"
            data-testid="cam-delete-setup"
            disabled={disabled}
            onClick={() => {
              if (run({ type: 'deleteCamSetup', setupId: setup.id }, `Delete ${setup.name}`)) {
                camUi.getState().setSetup(null);
              }
            }}
          >
            Delete setup
          </button>
        )}
      </div>
      {!setup ? (
        <p className="field-note">Add a setup in the Manufacture panel to edit it here.</p>
      ) : (
        <SetupPanel
          key={setup.id}
          doc={doc}
          setup={setup}
          bodiesOf={bodiesOf}
          geometry={geometry}
          pickingWcs={pickingWcs}
          onPickWcs={(on) => camUi.getState().setPickingWcs(on)}
          run={run}
          disabled={disabled}
        />
      )}
    </aside>
  );
}
