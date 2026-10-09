// The cut list's files (M4 plan T4.3d; one entry point since M8 plan T8.1b): the cut list CSV,
// the bill of materials CSV and the shop PDF with its sheet layouts and lumber plans. The app's
// Cut list panel writes them through `cutListFile`; a headless session through `exportCutList`,
// which takes the regenerated model and lays the sheets out in-process. Both name the file the
// same way and write the same bytes for the same input.

import type { DisplayUnits } from '@manufakture/core';
import { FABRICATION_MIME, documentFileName, type FabricationFile } from '@manufakture/io';
import { documentStock } from '@manufakture/stock';
import type { CutList } from '../cutlist/cutlist';
import {
  bomCsv,
  cutListCsv,
  documentCutList,
  documentSettings,
  excludedLines,
  missingLines,
  type CutListSources,
} from '../cutlist/display';
import { nestingJob, purchase } from '../cutlist/layout';
import { runNesting, type LayoutNote, type NestingResult } from '../cutlist/nesting';
import { cutListPdf } from './cutlist-pdf';

/** The cut list's files: the list (CSV), the bill of materials (CSV) and the shop PDF. */
export type CutListFileKind = 'list' | 'bom' | 'pdf';

export interface CutListFileOptions {
  /** The document's name: the PDF's title and the file's name. */
  documentName: string;
  units: DisplayUnits;
  /** The sheet layouts and lumber plans; null while they are not known (no stock to buy then). */
  layouts: NestingResult | null;
  /** Why stocks or parts have no layout (the nesting job's notes), when `layouts` is null. */
  notes: readonly LayoutNote[];
  /** Lines the PDF prints under the totals: bodies left out, instances not counted. */
  warnings: readonly string[];
}

/**
 * One file of a cut list. Throws a RangeError for input the PDF writer cannot write (the app's
 * panel catches it and reports it).
 */
export function cutListFile(
  kind: CutListFileKind,
  list: CutList,
  options: CutListFileOptions,
): FabricationFile {
  const { documentName, units, layouts } = options;
  if (kind === 'pdf') {
    const bytes = cutListPdf(list, layouts, {
      title: documentName,
      units,
      ...(list.configuration ? { configuration: list.configuration.name } : {}),
      warnings: [...options.warnings, ...(layouts?.notes ?? options.notes).map((n) => n.message)],
    });
    return {
      name: documentFileName(documentName, 'cut list', 'pdf'),
      bytes,
      type: FABRICATION_MIME.pdf,
    };
  }
  const text =
    kind === 'list'
      ? cutListCsv(list, units)
      : bomCsv(list, units, layouts ? purchase(layouts) : undefined);
  return {
    name: documentFileName(documentName, kind === 'list' ? 'cut list' : 'bill of materials', 'csv'),
    bytes: new TextEncoder().encode(text),
    type: FABRICATION_MIME.csv,
  };
}

/**
 * The cut list file of `kind` for a regenerated model (the entry point for headless sessions):
 * the list of `sources` (regen's `PartResult`s and `AssemblyResult`s fit `parts` and
 * `assemblies`), its sheets and sticks laid out in-process, and the file written as the panel
 * writes it. `sizingErrors` are lines about bodies whose oriented size could not be measured.
 */
export async function exportCutList(
  kind: CutListFileKind,
  sources: CutListSources,
  options: { sizingErrors?: readonly string[]; signal?: AbortSignal } = {},
): Promise<FabricationFile> {
  const doc = sources.document;
  const list = documentCutList(sources);
  const stock = documentStock(doc);
  const job = nestingJob(list, documentSettings(doc).settings, stock.ok ? stock.data : undefined);
  const layouts =
    job.sheets.length === 0 && job.sticks.length === 0
      ? { sheets: [], sticks: [], notes: job.notes }
      : await runNesting(job, options.signal ? { signal: options.signal } : {});
  return cutListFile(kind, list, {
    documentName: doc.name,
    units: doc.units,
    layouts,
    notes: job.notes,
    warnings: [...excludedLines(list, doc), ...missingLines(list), ...(options.sizingErrors ?? [])],
  });
}
