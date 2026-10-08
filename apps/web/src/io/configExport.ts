// Export every configuration: one file per row of the configuration table, each from its own
// regen (M2 plan, T2.4b). Rows go one at a time through the one kernel worker, so the work is
// sequential and can be cancelled between steps; a row that fails is reported and the others
// still export. Kept free of React, like the other actions.

import { configured, findPart, type ConfigRow, type ManufaktureDocument } from '@manufakture/core';
import { exportAllowed, type ExportSource, type ExportTolerancePreset } from '@manufakture/io';
import { partBodies } from '../model/bodies';
import type { RegenView } from '../model/model';
import { exportBodies, type ExportFormat, type ExportedFile } from './actions';
import type { Exchanger } from './exchange';

/** The formats that give one file per row (STL "one file per body" would give several). */
export type ConfigurationExportFormat = Exclude<ExportFormat, 'stl-each'>;

export interface ConfigurationExportRequest {
  /** The document as stored; each row is applied to it with `configured`. */
  document: ManufaktureDocument;
  /** The branch it comes from: the export gate refuses an agent's unreviewed branch (T8.3c). */
  source: ExportSource | null;
  /** The rows to export, in order (default: every row of the table). */
  rowIds?: readonly string[];
  /** The part studio whose bodies are written. */
  partId: string;
  format: ConfigurationExportFormat;
  tolerance?: ExportTolerancePreset;
  /** Viewport ids of bodies not to write (hidden, or unticked in the menu). */
  skip?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Before each row's regen: which row, counting from 0. */
  onProgress?: (progress: { index: number; count: number; row: ConfigRow }) => void;
  /** Each file as soon as it is made, so a cancelled export keeps what it finished. */
  onFile?: (file: ExportedFile, row: ConfigRow) => void;
}

export interface ConfigurationExportResult {
  /** Every file made, in row order. */
  files: ExportedFile[];
  /** Rows that could not be exported, with why. */
  failures: { row: ConfigRow; message: string }[];
  /** Cancelled before every row was done. */
  cancelled: boolean;
  /** No failures and not cancelled. */
  ok: boolean;
  message: string;
}

/** The name, without extension, of a row's file: `<document>-<row>`. */
export function configurationFileBase(documentName: string, rowName: string): string {
  return `${documentName}-${rowName}`;
}

/** How often a regen the worker dropped (a kernel recycle) is asked for again, per row. */
const RETRIES = 1;

/**
 * Export each row of `request.document`'s configuration table as one file named
 * `<document>-<row>.<ext>`: the row is applied, regenerated with `regen`, and the part's bodies
 * that are not skipped are written like a normal export. `regen` must build documents that are
 * not the open one (see `shareRegenerator`). Refused before any regen when `request.source` is
 * an agent's unreviewed branch or is not known.
 */
export async function exportConfigurations(
  exchanger: Exchanger,
  regen: (document: ManufaktureDocument, stored?: ManufaktureDocument) => Promise<RegenView | null>,
  request: ConfigurationExportRequest,
): Promise<ConfigurationExportResult> {
  const gate = exportAllowed(request.source);
  if (!gate.ok) {
    return { files: [], failures: [], cancelled: false, ok: false, message: gate.message };
  }
  const { document, partId, format, skip = new Set<string>(), signal } = request;
  const table = document.configurations?.rows ?? [];
  const rows = request.rowIds
    ? request.rowIds.flatMap((id) => table.filter((r) => r.id === id))
    : table;
  const files: ExportedFile[] = [];
  const failures: { row: ConfigRow; message: string }[] = [];
  let done = 0;
  const finish = (cancelled: boolean): ConfigurationExportResult => {
    const ok = !cancelled && failures.length === 0 && rows.length > 0;
    return {
      files,
      failures,
      cancelled,
      ok,
      message: summary(rows.length, done, files, failures, cancelled),
    };
  };
  if (rows.length === 0) return finish(false);

  for (const [index, row] of rows.entries()) {
    if (signal?.aborted) return finish(true);
    request.onProgress?.({ index, count: rows.length, row });
    const variant = configured(document, row.id);
    if (!variant.ok) {
      failures.push({ row, message: variant.error.message });
      continue;
    }
    let view: RegenView | null = null;
    for (let attempt = 0; attempt <= RETRIES && view === null; attempt++) {
      // The stored document goes along, so instances in other rows are configured from it.
      view = await regen(variant.value, document);
      if (signal?.aborted) return finish(true);
    }
    if (view === null) {
      failures.push({ row, message: 'The kernel dropped the regen; try again.' });
      continue;
    }
    const model = view.parts.find((p) => p.partId === partId);
    const part = findPart(variant.value, partId);
    const failed = model?.features.find((f) => f.status === 'error');
    if (failed) {
      const feature = part?.features.find((f) => f.id === failed.featureId);
      const why = failed.errors.map((e) => e.message).join('; ');
      failures.push({
        row,
        message: `${feature?.name ?? failed.featureId} fails in this configuration${why ? `: ${why}` : ''}.`,
      });
      continue;
    }
    const bodies = partBodies(part, model)
      .filter((b) => !skip.has(b.viewId))
      .map((b) => ({ id: b.viewId, name: b.name }));
    if (bodies.length === 0) {
      failures.push({
        row,
        message: 'There is nothing to export: every body is hidden or not chosen.',
      });
      continue;
    }
    const r = await exportBodies(exchanger, format, {
      source: request.source,
      ...(request.tolerance ? { tolerance: request.tolerance } : {}),
      bodies,
      fileBase: configurationFileBase(document.name, row.name),
      // The viewport's members are the active row's; another row's are not built here.
      members: [],
    });
    if (!r.ok) {
      failures.push({ row, message: r.message });
      continue;
    }
    for (const f of r.value) {
      files.push(f);
      request.onFile?.(f, row);
    }
    done++;
  }
  return finish(false);
}

function summary(
  count: number,
  done: number,
  files: readonly ExportedFile[],
  failures: readonly { row: ConfigRow; message: string }[],
  cancelled: boolean,
): string {
  if (count === 0) return 'There are no configurations to export.';
  const names = files.map((f) => f.name).join(', ');
  const failed = failures.map((f) => `${f.row.name}: ${f.message}`).join(' ');
  const of = `${done} of ${count} configuration${count === 1 ? '' : 's'}`;
  if (cancelled) {
    return `Export cancelled after ${of}${names ? ` (${names})` : ''}.${failed ? ` ${failed}` : ''}`;
  }
  if (failures.length === 0) return `Exported ${of}: ${names}.`;
  return `Exported ${of}${names ? ` (${names})` : ''}. ${failed}`;
}
