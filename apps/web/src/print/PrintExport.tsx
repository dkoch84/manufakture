// The Export section of the print panel (M3 plan, T3.3b): Export for printing (3MF, or STL per
// body as a fallback, at a mesh tolerance), Open in slicer (the same 3MF, then the hand-off help)
// and, with configurations, one file per row. An export that would be refused says why up front
// and its buttons are off; issues that do not block are named in the message after it. The
// export meshes the bodies the kernel holds now, so it waits while the model regenerates or the
// kernel is building another document (an export of every configuration, a version viewed).

import type { ManufaktureDocument } from '@manufakture/core';
import { EXPORT_TOLERANCES, fileName, type ExportTolerancePreset } from '@manufakture/io';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ExportedFile } from '../io/actions';
import type { Exchanger } from '../io/exchange';
import { ExportGateNotice } from '../io/ExportGateNotice';
import { currentExportSource, useExportRefusal } from '../io/exportSource';
import { downloadBytes } from '../io/files';
import type { SharedRegenerator } from '../model/model';
import { viewSettingsStore, type ViewSettingsStore } from '../state/viewSettings';
import {
  exportPrintConfigurations,
  exportPrintSetup,
  exportRefusal,
  printFileBase,
  type PrintExportFormat,
} from './exportPrint';
import type { PrintIssue } from './issues';
import type { ResolvedSetup } from './resolve';
import { SlicerHandoff } from './SlicerHandoff';

/** What exporting needs from the app: the kernel's meshes, and regens of other configurations. */
export interface PrintExporter {
  exchanger: Pick<Exchanger, 'tessellate'>;
  /** Exporting every configuration holds the worker meanwhile; null: not offered. */
  exclusive: SharedRegenerator['exclusive'] | null;
  /** Whether other work holds the worker (the kernel then holds another document's bodies). */
  busy?: () => boolean;
}

export interface PrintExportProps {
  doc: ManufaktureDocument;
  resolved: ResolvedSetup | null;
  issues: readonly PrintIssue[];
  exporter: PrintExporter | null;
  disabled?: boolean;
  /** The open document is regenerating: `resolved` may be of the model before the last edit. */
  modelPending?: boolean;
  /** Told when an export starts and ends, so the app keeps its other exports off meanwhile. */
  onBusy?: (busy: boolean) => void;
  settings?: ViewSettingsStore;
  /** Saves a file; default a browser download. */
  download?: (file: ExportedFile) => void;
}

const TOLERANCE_LABELS: Record<ExportTolerancePreset, string> = {
  draft: 'Draft (0.1 mm)',
  normal: 'Normal (0.02 mm)',
  fine: 'Fine (0.005 mm)',
};

interface Progress {
  index: number;
  count: number;
  row: string;
  controller: AbortController;
}

const save = (f: ExportedFile) => downloadBytes(f.bytes, f.name, f.type);

const kernelBusy =
  'The kernel is busy with another export or a version you are viewing; try again when it is done.';

export function PrintExport({
  doc,
  resolved,
  issues,
  exporter,
  disabled = false,
  modelPending = false,
  onBusy,
  settings = viewSettingsStore,
  download = save,
}: PrintExportProps) {
  const [format, setFormat] = useState<PrintExportFormat>('3mf');
  const [tolerance, setTolerance] = useState<ExportTolerancePreset>('normal');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const lastFile = useRef<string | null>(null);
  // The export of every configuration running, so leaving the panel cancels it.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const slicer = useStore(settings, (s) => s.slicer);
  const dismissed = useStore(settings, (s) => s.slicerHelpDismissed);
  // The export gate (T8.3c): nothing is exported from an agent's unreviewed branch.
  const gated = useExportRefusal();

  if (!resolved) return null;
  const setup = resolved.setup;
  const pending = modelPending || resolved.items.some((i) => i.status === 'pending');
  // An empty setup is not a refusal yet: there is just nothing to export.
  const empty = resolved.items.length === 0;
  const refusal = pending || empty ? null : exportRefusal(resolved, doc.units);
  const rows = doc.configurations?.rows ?? [];
  const off =
    disabled || busy || !exporter || pending || empty || refusal !== null || gated !== null;
  const defaultName = fileName(printFileBase(doc.name, setup.name), '3mf');

  const run = async (as: PrintExportFormat, open: boolean) => {
    if (!exporter) return;
    if (exporter.busy?.()) {
      setStatus({ error: true, text: kernelBusy });
      return;
    }
    setBusy(true);
    onBusy?.(true);
    setStatus(null);
    try {
      const r = await exportPrintSetup(exporter.exchanger, resolved, {
        source: currentExportSource(),
        documentName: doc.name,
        units: doc.units,
        format: as,
        tolerance,
        issues,
      });
      if (!r.ok) {
        setStatus({ error: true, text: r.message });
        return;
      }
      for (const f of r.value) download(f);
      setStatus({ error: false, text: r.message });
      if (open) {
        lastFile.current = r.value[0]!.name;
        setHandoff(dismissed.includes(slicer) ? null : r.value[0]!.name);
      }
    } catch (e) {
      setStatus({ error: true, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  const runAll = async () => {
    const exclusive = exporter?.exclusive;
    if (!exporter || !exclusive) return;
    if (exporter.busy?.()) {
      setStatus({ error: true, text: kernelBusy });
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    onBusy?.(true);
    setStatus(null);
    setProgress({ index: 0, count: rows.length, row: '', controller });
    try {
      const r = await exclusive((regen) =>
        exportPrintConfigurations(exporter.exchanger, regen, {
          source: currentExportSource(),
          document: doc,
          setupId: setup.id,
          format,
          tolerance,
          signal: controller.signal,
          onProgress: ({ index, count, row }) =>
            setProgress({ index, count, row: row.name, controller }),
          onFile: (f) => download(f),
        }),
      );
      setStatus({ error: !r.ok && !r.cancelled, text: r.message });
    } catch (e) {
      setStatus({ error: true, text: e instanceof Error ? e.message : String(e) });
    } finally {
      if (running.current === controller) running.current = null;
      setProgress(null);
      setBusy(false);
      onBusy?.(false);
    }
  };

  return (
    <section className="print-export" aria-label="Export for printing" data-testid="print-export">
      <h3>Export</h3>
      <div className="print-export-options">
        <label className="print-field">
          <span>Format</span>
          <select
            data-testid="print-export-format"
            value={format}
            disabled={disabled || busy}
            onChange={(e) => setFormat(e.target.value === 'stl' ? 'stl' : '3mf')}
          >
            <option value="3mf">3MF: colours, copies, orientation</option>
            <option value="stl">STL, one file per body</option>
          </select>
        </label>
        <label className="print-field">
          <span>Mesh</span>
          <select
            data-testid="print-export-tolerance"
            value={tolerance}
            disabled={disabled || busy}
            onChange={(e) => {
              const v = e.target.value;
              if (v in EXPORT_TOLERANCES) setTolerance(v as ExportTolerancePreset);
            }}
          >
            {(Object.keys(EXPORT_TOLERANCES) as ExportTolerancePreset[]).map((t) => (
              <option key={t} value={t}>
                {TOLERANCE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!exporter && (
        <p className="field-note" data-testid="print-export-unavailable">
          Export needs the geometry kernel.
        </p>
      )}
      {empty && (
        <p className="field-note" data-testid="print-export-empty">
          Add an item to export the setup.
        </p>
      )}
      {pending && (
        <p className="field-note" data-testid="print-export-waiting">
          Waiting for the model.
        </p>
      )}
      <ExportGateNotice refusal={gated} />
      {refusal && (
        <p className="field-error" role="alert" data-testid="print-export-refusal">
          {refusal}
        </p>
      )}
      <div className="print-export-buttons">
        <button
          type="button"
          className="primary"
          data-testid="print-export-button"
          disabled={off}
          title={`Download ${format === '3mf' ? defaultName : 'one STL per body'}`}
          onClick={() => void run(format, false)}
        >
          Export for printing
        </button>
        <button
          type="button"
          data-testid="print-open-slicer"
          disabled={off}
          title={`Download ${defaultName} and see how to open it in the slicer`}
          onClick={() => void run('3mf', true)}
        >
          Open in slicer
        </button>
        {rows.length > 0 && exporter?.exclusive && (
          <button
            type="button"
            data-testid="print-export-configurations"
            disabled={disabled || busy || !exporter || modelPending || gated !== null}
            title={`One file per configuration: ${fileName(printFileBase(doc.name, setup.name, rows[0]!.name), format === '3mf' ? '3mf' : 'stl')}, ...`}
            onClick={() => void runAll()}
          >
            Export all {rows.length} configurations
          </button>
        )}
      </div>
      {progress && (
        <p className="field-note" role="status" data-testid="print-export-progress">
          Exporting configuration {progress.index + 1} of {progress.count}
          {progress.row ? `: ${progress.row}` : ''}.{' '}
          <button
            type="button"
            data-testid="print-export-cancel"
            onClick={() => progress.controller.abort()}
          >
            Cancel
          </button>
        </p>
      )}
      {status && (
        <p
          className={status.error ? 'field-error' : 'field-note'}
          role={status.error ? 'alert' : 'status'}
          data-testid="print-export-status"
        >
          {status.text}
        </p>
      )}
      {handoff === null ? (
        <button
          type="button"
          className="print-export-help"
          data-testid="print-slicer-help"
          onClick={() => setHandoff(lastFile.current ?? defaultName)}
        >
          How to open the file in a slicer
        </button>
      ) : (
        <SlicerHandoff fileName={handoff} settings={settings} onClose={() => setHandoff(null)} />
      )}
    </section>
  );
}
