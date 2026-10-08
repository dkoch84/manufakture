// The construction takeoff's files (M6 plan T6.3b; one entry point since M8 plan T8.1b): the CSV
// and the PDF for the lumber yard, each opening with the short "not an engineering tool" text. The
// app's Takeoff panel writes them through `takeoffFile`; a headless session through
// `exportTakeoff`, which takes the regenerated part studio. Both name the file the same way and
// write the same bytes for the same input.

import type { DisplayUnits, ManufaktureDocument } from '@manufakture/core';
import { FABRICATION_MIME, documentFileName, type FabricationFile } from '@manufakture/io';
import { documentStock } from '@manufakture/stock';
import { documentConstruction } from '../data';
import { displayRows, subtotalLines, takeoffCsv, type TakeoffDisplayRow } from '../takeoff/display';
import { takeoffModel, type TakeoffSources } from '../takeoff/from-regen';
import { constructionTakeoff } from '../takeoff/takeoff';
import type { ConstructionTakeoff } from '../takeoff/types';
import { takeoffPdf } from './takeoff-pdf';

export type TakeoffFileKind = 'csv' | 'pdf';

export interface TakeoffFileOptions {
  /** The document's name: the files' title and the file's name. */
  documentName: string;
  units: DisplayUnits;
  /** Subtotals per level and feature (`subtotalLines`). */
  subtotals: readonly { kind: string; name: string; text: string }[];
  /** What the takeoff could not count (`TakeoffModel.notes`), for the PDF. */
  notes: readonly string[];
}

/**
 * One file of a takeoff. Throws a RangeError for input the PDF writer cannot write (the app's
 * panel catches it and reports it).
 */
export function takeoffFile(
  kind: TakeoffFileKind,
  takeoff: ConstructionTakeoff,
  rows: readonly TakeoffDisplayRow[],
  options: TakeoffFileOptions,
): FabricationFile {
  const { documentName, units, subtotals } = options;
  const common = { title: documentName, units, subtotals };
  if (kind === 'pdf') {
    return {
      name: documentFileName(documentName, 'takeoff', 'pdf'),
      bytes: takeoffPdf(takeoff, rows, { ...common, notes: options.notes }),
      type: FABRICATION_MIME.pdf,
    };
  }
  return {
    name: documentFileName(documentName, 'takeoff', 'csv'),
    bytes: new TextEncoder().encode(takeoffCsv(takeoff, rows, common)),
    type: FABRICATION_MIME.csv,
  };
}

/**
 * The takeoff file of `kind` for a regenerated part studio (the entry point for headless
 * sessions): its feature results and member sets (regen's `PartResult.features` and `members` from
 * a completed regen), with the document's construction settings and stock prices, written as the
 * panel writes it. As in the panel, settings that cannot be read count as none. Throws when the
 * takeoff cannot be counted.
 */
export function exportTakeoff(
  kind: TakeoffFileKind,
  sources: Omit<TakeoffSources, 'settings' | 'stock'>,
): FabricationFile {
  const doc: ManufaktureDocument = sources.document;
  const data = documentConstruction(doc);
  const settings = data.ok ? data.data?.settings : undefined;
  const stock = documentStock(doc);
  const model = takeoffModel({ ...sources, settings, stock: stock.ok ? stock.data : undefined });
  const takeoff = constructionTakeoff(model.input);
  return takeoffFile(kind, takeoff, displayRows(takeoff, doc.units), {
    documentName: doc.name,
    units: doc.units,
    subtotals: subtotalLines(takeoff, doc, sources.partId, settings),
    notes: model.notes,
  });
}
