// The G-code export dialog (M5 plan, T5.4e), opened from the Manufacture workspace for the setup
// it shows. On opening it generates the operations that are not generated yet or were generated
// from inputs that have changed since (with the workspace's progress line and a Cancel), then
// shows the export settings (post, units, multi-tool mode, grouping by tool), a summary (files,
// tools in order, estimated time, extents, warnings) and the setup sheet, which can be printed
// and saved. Save hands the G-code (or a zip of the files, for one file per tool) to the app's
// download. An operation with an error, or a post that refuses the job, refuses the export with
// the reason, and Save stays disabled.
//
// The workspace's geometry may be of an older document (it is asked for asynchronously after each
// edit), so the dialog asks for the current document's geometry itself and treats every operation
// as pending until a reply for that exact document arrives; it generates again whenever the
// document changes while it is open, and Save checks once more that nothing changed since.

import type { CamClient } from '@manufakture/cam/client';
import type { PostUnits } from '@manufakture/cam';
import type { ManufaktureDocument } from '@manufakture/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ExportedFile } from '../../io/actions';
import { formatBytes } from '../../io/files';
import type { DocumentStoreApi } from '../../state/document';
import { POST_IDS, machineById, postName } from '../commands';
import type { CamGeometer } from '../geometer';
import { generateSetup } from '../run';
import { activeCamSetup, type CamUiStore } from '../state';
import {
  HTML_MIME,
  MULTI_TOOL_LABELS,
  buildExport,
  defaultExportSettings,
  exportFiles,
  exportReadiness,
  formatLength,
  localDate,
  multiToolModes,
  sheetFileName,
  toolLabel,
  withPost,
  type ExportSettings,
  type MultiToolMode,
} from './export';
import { setupSheetHtml } from './sheet';
import { formatMinutes } from '../preview/format';
import './export.css';

export interface ExportDialogProps {
  documents: DocumentStoreApi;
  camUi: CamUiStore;
  setupId: string;
  /** The regen worker's CAM geometry stage; null where there is none (nothing can generate). */
  geometer: CamGeometer | null;
  client: CamClient | null;
  /** Save a file (the app's download). */
  onSave: (file: ExportedFile) => void;
  onClose: () => void;
  /** The date written into the files and the sheet; today when absent. */
  date?: string;
}

const today = () => localDate(new Date());

export function ExportDialog({
  documents,
  camUi,
  setupId,
  geometer,
  client,
  onSave,
  onClose,
  date,
}: ExportDialogProps) {
  const doc = useStore(documents, (s) => s.document);
  const geometry = useStore(camUi, (s) => s.geometry);
  const geometryDocument = useStore(camUi, (s) => s.geometryDocument);
  const generated = useStore(camUi, (s) => s.generated);
  const toolpaths = useStore(camUi, (s) => s.toolpaths);
  const generating = useStore(camUi, (s) => s.generating);
  const generateMessage = useStore(camUi, (s) => s.generateMessage);
  const setup = doc.cam.setups.find((s) => s.id === setupId);
  const machine = setup ? machineById(setup.machine) : undefined;
  const [settings, setSettings] = useState<ExportSettings>(() =>
    defaultExportSettings(setup ?? { post: '' }, machine),
  );
  const [stamp] = useState(() => date ?? today());
  const [cancelled, setCancelled] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** The document the last automatic generation was started for. */
  const autoFor = useRef<ManufaktureDocument | null>(null);
  /** A document whose geometry request came back empty or failed: generating resolves it again. */
  const [unresolved, setUnresolved] = useState<ManufaktureDocument | null>(null);
  const sheetFrame = useRef<HTMLIFrameElement>(null);
  const available = geometer !== null && client !== null;

  // The kept geometry is the current document's: otherwise everything is pending.
  const current = geometryDocument === doc;
  const readiness = setup
    ? exportReadiness(setup, geometry, generated, toolpaths, available, current)
    : null;
  const staleCount = readiness?.stale.length ?? 0;
  const pending = readiness?.pending ?? false;
  /** The kept geometry and toolpaths are still the current document's (checked again at Save). */
  const upToDate = () => {
    const ui = camUi.getState();
    return !ui.generating && ui.geometryDocument === documents.getState().document;
  };

  /** Generate the setup's out-of-date operations, cancellable through `abort`. */
  const startGeneration = useCallback(() => {
    const current = documents.getState().document;
    const target = current.cam.setups.find((s) => s.id === setupId);
    if (!target || !geometer || !client) return;
    const controller = new AbortController();
    abort.current = controller;
    void generateSetup(current, target, geometer, client, camUi, controller.signal);
  }, [documents, setupId, geometer, client, camUi]);

  const generate = () => {
    setCancelled(false);
    setSaved(null);
    startGeneration();
  };

  const cancel = () => {
    abort.current?.abort();
    setCancelled(true);
    void client?.cancel();
  };

  // The current document's geometry, asked for as the dialog opens and again whenever the kept
  // one is not the current document's (an edit since, or a reply for an older document).
  useEffect(() => {
    if (!geometer || current) return;
    let live = true;
    geometer.geometry(doc, setupId).then(
      (r) => {
        if (!live) return;
        const shown = activeCamSetup(doc, camUi.getState().setupId)?.id === setupId;
        if (r && r.setupId === setupId && shown && documents.getState().document === doc) {
          camUi.getState().setGeometry(r, doc);
        } else if (!r) {
          setUnresolved(doc);
        }
      },
      () => {
        if (live) setUnresolved(doc);
      },
    );
    return () => {
      live = false;
    };
  }, [geometer, doc, setupId, current, camUi, documents]);

  // Generate what is out of date as the dialog opens, once its geometry is known (or could not be
  // resolved, which the generation tries again), and again after every edit while it is open; a
  // cancel holds until the next edit or Generate.
  const resolved = current || unresolved === doc;
  useEffect(() => {
    if (autoFor.current === doc || !available || generating || !resolved || staleCount === 0) {
      return;
    }
    autoFor.current = doc;
    startGeneration();
  }, [doc, available, generating, resolved, staleCount, startGeneration]);

  // A cancel stops an export that is still generating when the dialog closes.
  useEffect(
    () => () => {
      if (abort.current && camUi.getState().generating) {
        abort.current.abort();
        void client?.cancel();
      }
    },
    [camUi, client],
  );

  const ready =
    setup !== undefined &&
    machine !== undefined &&
    readiness !== null &&
    readiness.message === null &&
    readiness.blocked.length === 0 &&
    readiness.stale.length === 0 &&
    !generating &&
    toolpaths?.setupId === setupId;
  const build = useMemo(
    () =>
      ready && setup && machine && toolpaths
        ? buildExport({
            data: toolpaths,
            operations: setup.operations,
            settings,
            jobName: doc.name,
            setupName: setup.name,
            machine,
            date: stamp,
          })
        : null,
    [ready, setup, machine, toolpaths, settings, doc.name, stamp],
  );
  const plan = build?.ok ? build.plan : null;
  const sheet = useMemo(() => (plan ? setupSheetHtml(plan) : null), [plan]);

  const reasons: string[] = [];
  if (!setup) reasons.push('The setup no longer exists.');
  else if (!machine) reasons.push(`This version does not know the machine ${setup.machine}.`);
  if (readiness?.message) reasons.push(readiness.message);
  for (const b of readiness?.blocked ?? []) reasons.push(`${b.name}: ${b.message}`);
  if (build && !build.ok) reasons.push(...build.reasons);

  const save = () => {
    if (!plan || !sheet || !upToDate()) return;
    const files = exportFiles(plan, sheet);
    for (const f of files) onSave(f);
    setSaved(`Saved ${files.map((f) => `${f.name} (${formatBytes(f.bytes.length)})`).join(', ')}.`);
  };
  const saveSheet = () => {
    if (!plan || !sheet || !upToDate()) return;
    onSave({ name: sheetFileName(plan), bytes: new TextEncoder().encode(sheet), type: HTML_MIME });
  };

  const modes = multiToolModes(settings.post);
  const units = settings.units;
  const posts = machine
    ? [...machine.posts, ...POST_IDS.filter((p) => !machine.posts.includes(p))].filter((p) =>
        POST_IDS.includes(p),
      )
    : POST_IDS;

  return (
    <div className="cam-export-backdrop">
      <section
        className="cam-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cam-export-title"
        data-testid="cam-export-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="cam-export-head">
          <h2 id="cam-export-title">Export G-code{setup ? `: ${setup.name}` : ''}</h2>
          <button type="button" data-testid="cam-export-close" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="cam-export-settings">
          <label>
            <span>Post</span>
            <select
              data-testid="cam-export-post"
              value={settings.post}
              onChange={(e) => setSettings((s) => withPost(s, e.target.value))}
            >
              {posts.map((p) => (
                <option key={p} value={p}>
                  {postName(p)}
                  {machine?.posts[0] === p ? ' (machine default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Units</span>
            <select
              data-testid="cam-export-units"
              value={settings.units}
              onChange={(e) => setSettings((s) => ({ ...s, units: e.target.value as PostUnits }))}
            >
              <option value="mm">Millimetres (G21)</option>
              <option value="inch">Inches (G20)</option>
            </select>
          </label>
          <label>
            <span>Tool changes</span>
            <select
              data-testid="cam-export-multitool"
              value={settings.multiTool}
              disabled={modes.length < 2}
              onChange={(e) =>
                setSettings((s) => ({ ...s, multiTool: e.target.value as MultiToolMode }))
              }
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {MULTI_TOOL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="cam-export-check">
            <input
              type="checkbox"
              data-testid="cam-export-group"
              checked={settings.groupByTool}
              onChange={(e) => setSettings((s) => ({ ...s, groupByTool: e.target.checked }))}
            />
            <span>Group operations by tool (fewer tool changes; changes the cut order)</span>
          </label>
        </div>

        {(generating || cancelled || (staleCount > 0 && available)) && (
          <div className="cam-export-progress" data-testid="cam-export-progress">
            {generating ? (
              <>
                <span role="status">
                  {generateMessage ?? 'Generating toolpaths...'} ({staleCount}{' '}
                  {staleCount === 1 ? 'operation' : 'operations'} out of date)
                </span>
                <button type="button" data-testid="cam-export-cancel" onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span role="status">
                  {cancelled ? 'Generation cancelled. ' : ''}
                  {pending && !resolved
                    ? 'Resolving the geometry of the document as it is now...'
                    : staleCount > 0
                      ? `${staleCount} ${staleCount === 1 ? 'operation needs' : 'operations need'} generating before export.`
                      : ''}
                </span>
                {staleCount > 0 && resolved && (
                  <button type="button" data-testid="cam-export-generate" onClick={generate}>
                    Generate
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {reasons.length > 0 && !generating && (
          <div className="cam-export-refused" role="alert" data-testid="cam-export-refused">
            <p>Export refused:</p>
            <ul>
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {plan && (
          <div className="cam-export-summary" data-testid="cam-export-summary">
            <h3>Summary</h3>
            <dl>
              <dt>Files</dt>
              <dd>
                <ol data-testid="cam-export-files">
                  {plan.files.map((f) => (
                    <li key={f.index}>{f.name}</li>
                  ))}
                </ol>
              </dd>
              <dt>Tools in order</dt>
              <dd>
                <ol data-testid="cam-export-tools">
                  {plan.toolChanges.map((c) => (
                    <li key={c.index}>
                      {toolLabel(c.tool)}: {c.operation}
                    </li>
                  ))}
                </ol>
              </dd>
              <dt>Estimated time</dt>
              <dd data-testid="cam-export-time">
                {plan.stats ? formatMinutes(plan.stats.estimate.totalMinutes) : '-'} (an estimate:
                no acceleration or tool change time)
              </dd>
              <dt>Extents (tool tip)</dt>
              <dd data-testid="cam-export-extents">
                {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                  <span key={axis}>
                    {axis} {formatLength(plan.extents.all.min[i]!, units)} to{' '}
                    {formatLength(plan.extents.all.max[i]!, units)}
                    {i < 2 ? '; ' : ''}
                  </span>
                ))}
              </dd>
            </dl>
            {plan.warnings.length > 0 && (
              <ul className="cam-export-warnings" data-testid="cam-export-warnings">
                {plan.warnings.map((w, i) => (
                  <li key={i} className="tip-warning">
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {sheet && (
          <iframe
            ref={sheetFrame}
            className="cam-export-sheet"
            title="Setup sheet"
            data-testid="cam-export-sheet"
            srcDoc={sheet}
            sandbox="allow-same-origin allow-modals"
          />
        )}

        <footer className="cam-export-actions">
          <button
            type="button"
            data-testid="cam-export-print"
            disabled={!sheet}
            onClick={() => sheetFrame.current?.contentWindow?.print()}
          >
            Print setup sheet
          </button>
          <button
            type="button"
            data-testid="cam-export-save-sheet"
            disabled={!sheet}
            onClick={saveSheet}
          >
            Save setup sheet
          </button>
          <button
            type="button"
            className="primary"
            data-testid="cam-export-save"
            disabled={!plan}
            onClick={save}
          >
            {plan && plan.files.length > 1
              ? `Save ${plan.files.length} files (zip)`
              : 'Save G-code'}
          </button>
        </footer>
        {saved && (
          <p className="field-note" role="status" data-testid="cam-export-saved">
            {saved}
          </p>
        )}
      </section>
    </div>
  );
}
