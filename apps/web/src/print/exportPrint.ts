// Export for printing (M3 plan, T3.3b; ADR 0012 decisions 11 and 12): a print setup as one
// slicer-ready file. Every item's bodies are meshed at the export tolerance, oriented as the item
// says (lay flat, turned, as modelled) and dropped onto the bed; every copy is packed onto the
// printer's plate (`plate.ts`); each body keeps its name and colour. Kept free of React, like the
// other export actions.
//
// - 3MF (the default): through `export3mfAssembly`, each item a part and each copy an instance
//   placed by a build item, so the colours land on filament slots and the copies keep their names
//   (io README, "3MF"). An item of several bodies is written as one object with a part per body
//   (`oneObject`), so the slicer keeps a two-colour part together when it arranges the plate.
// - STL, one file per body: the fallback for a slicer that will not read 3MF. Each body is moved
//   to where the first copy of its item lies; STL holds no copies and no colours.
//
// Refused, with the problem named, when an item does not fit the bed on its own (`fit.fits` is
// false: too big, or no spot clear of an excluded area), when an item does not resolve (a lost
// reference, the model still regenerating), when the printer is unknown, and when packing leaves
// copies off the plate (found by packing, so only after the export was asked for; a total that is
// plainly too many is refused before the copies are listed one by one): an item that cannot be
// placed even alone is named with why (on a two-nozzle printer, a two-colour item on the plate
// keeps every copy where both nozzles reach), otherwise the copies need more than one plate. Other issues (overhangs,
// thin walls) never block an export; the message lists them.

import {
  configured,
  findPart,
  type ConfigRow,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  EXPORT_TOLERANCES,
  NotWatertightError,
  deflectionOf,
  export3mfAssembly,
  exportStl,
  fileName,
  placementMatrix,
  transformMesh,
  type ExportAssembly,
  type ExportBody,
  type ExportTolerancePreset,
} from '@manufakture/io';
import type { BoundingBox, MeshData } from '@manufakture/kernel';
import {
  boundingBox,
  orientationPlacement,
  type Placement,
  type Printer,
} from '@manufakture/print';
import type { RegenView } from '../model/model';
import type { ActionResult, ExportedFile } from '../io/actions';
import type { Exchanger } from '../io/exchange';
import { MIME, formatBytes } from '../io/files';
import { ISSUE_TITLES, bedFitReasons, type PrintIssue } from './issues';
import { packPlate, type PackedPlate, type PlateCopy } from './plate';
import { COPY_GAP, itemBedFit, nozzlesFor, resolveSetup, type ResolvedSetup } from './resolve';

/**
 * More copies than this are refused before they are packed one by one: no built-in printer's
 * plate holds this many, 5 mm apart, and a crafted file may ask for millions.
 */
export const MAX_PLATE_COPIES = 5000;

export type PrintExportFormat = '3mf' | 'stl';

export interface PrintExportOptions {
  /** The document's name: the 3MF title and the start of the file name. */
  documentName: string;
  /** For the sizes in messages. */
  units: DisplayUnits;
  format?: PrintExportFormat;
  tolerance?: ExportTolerancePreset;
  /** The file name without extension; default `<document>-<setup>` (`printFileBase`). */
  fileBase?: string;
  /** The Issues list, to say which issues the export did not block on. */
  issues?: readonly PrintIssue[];
}

/** The name, without extension, of a setup's file: `<document>-<setup>`, and `-<row>` per row. */
export function printFileBase(documentName: string, setupName: string, rowName?: string): string {
  return rowName === undefined
    ? `${documentName}-${setupName}`
    : `${documentName}-${setupName}-${rowName}`;
}

/** Why the setup cannot be exported as it is resolved now, or null when it can. */
export function exportRefusal(resolved: ResolvedSetup, units: DisplayUnits): string | null {
  const printer = resolved.printer;
  if (!printer) {
    return `This build does not know the printer "${resolved.setup.printer}", so the bed fit cannot be checked: pick a printer before exporting.`;
  }
  if (resolved.items.length === 0) return 'There is nothing to print: add an item first.';
  const problems: string[] = [];
  for (const item of resolved.items) {
    if (item.status !== 'ok') {
      problems.push(`${item.label}: ${item.message ?? 'it does not resolve.'}`);
      continue;
    }
    if (item.fit && !item.fit.fits) {
      const { reasons } = bedFitReasons(item.fit, units);
      problems.push(`${item.label} does not fit the ${printer.name}'s bed: ${reasons.join('; ')}.`);
    }
  }
  return problems.length > 0 ? `Not exported. ${problems.join(' ')}` : null;
}

/** The kinds of issue listed, as a note that they did not block the export; empty when none. */
function warningsText(issues: readonly PrintIssue[] | undefined): string {
  const listed = (issues ?? []).filter((i) => i.kind !== 'bedFit');
  if (listed.length === 0) return '';
  const kinds = [...new Set(listed.map((i) => ISSUE_TITLES[i.kind].toLowerCase()))];
  const n = listed.length;
  return ` ${n} ${n === 1 ? 'issue' : 'issues'} in the list did not block it (${kinds.join(', ')}).`;
}

/** `name`, or `name (2)`, `name (3)` ... when it is taken. */
function uniquer(): (name: string) => string {
  const used = new Set<string>();
  return (name) => {
    let out = name;
    for (let n = 2; used.has(out); n++) out = `${name} (${n})`;
    used.add(out);
    return out;
  };
}

/**
 * The same for file names: `name` as `fileName` writes it (without the extension), made unique
 * after that cleaning and regardless of case, since two names that differ before it (`a:b` and
 * `a*b`, or `A` and `a` on most desktops) would otherwise land on one file. The number is kept
 * when the name is cut to the longest a file system holds.
 */
function fileUniquer(extension: string): (name: string) => string {
  const used = new Set<string>();
  const clean = (name: string) => fileName(name, extension).slice(0, -(extension.length + 1));
  return (name) => {
    const base = clean(name);
    let out = base;
    for (let n = 2; used.has(out.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      let head = [...base];
      while (head.length > 0 && clean(head.join('') + suffix) !== head.join('') + suffix) {
        head = head.slice(0, -1);
      }
      out = clean(head.join('') + suffix);
    }
    used.add(out.toLowerCase());
    return out;
  };
}

/** The note on an export packed closer than the gap to an excluded area, naming the items. */
function nearExcludedNote(
  printer: Printer,
  items: ResolvedSetup['items'],
  owners: readonly { item: number }[],
  near: readonly number[],
): string {
  if (near.length === 0) return '';
  const labels = [...new Set(near.map((k) => items[owners[k]!.item]!.label))];
  const which = labels.length === 1 ? `${labels[0]} sits` : `${labels.join(', ')} sit`;
  return ` ${which} within ${COPY_GAP} mm of an excluded area of the ${printer.name}, since the plate has no room to keep ${COPY_GAP} mm clear of it; slicers flag parts very close to an excluded area, so check the plate in the slicer.`;
}

/**
 * Why packing left copies off the plate: each item no copy of which can be placed even alone is
 * named with its cause; otherwise the copies need more than one plate.
 */
function overflowRefusal(
  printer: Printer,
  oriented: readonly { copy: PlateCopy; box: BoundingBox }[],
  items: ResolvedSetup['items'],
  copies: readonly PlateCopy[],
  plate: PackedPlate,
): string {
  // The nozzles the plate was packed for: on a two-nozzle printer with a two-colour item, the area
  // both nozzles reach holds every copy (`packPlate`).
  const shared = [...new Set(copies.flatMap((c) => c.nozzles ?? []))];
  const problems: string[] = [];
  for (const [index, o] of oriented.entries()) {
    const alone = packPlate(printer, [
      { ...o.copy, ...(shared.length > 0 ? { nozzles: shared } : {}) },
    ]);
    if (alone.overflow === 0) continue;
    const label = items[index]!.label;
    if (shared.length > 0 && !itemBedFit(printer, o.box, shared).fits) {
      problems.push(
        `${label} fits the ${printer.name}'s bed only where one nozzle reaches, and a two-colour item on the plate keeps every copy in the area both nozzles reach: move it to another setup.`,
      );
    } else if (printer.excluded.length > 0) {
      problems.push(
        `${label} fits the ${printer.name}'s bed alone, but the plate packing finds no spot for it clear of an excluded area: turn it or pick a bigger printer.`,
      );
    } else {
      problems.push(
        `${label} fits the ${printer.name}'s bed alone, but the plate packing finds no spot for it: turn it or pick a bigger printer.`,
      );
    }
  }
  if (problems.length > 0) return `Not exported. ${problems.join(' ')}`;
  const fitting = copies.length - plate.overflow;
  return `Not exported. The ${copies.length} copies need more than one plate: the ${printer.name}'s holds ${fitting} of them as they are listed. An export writes one plate, so lower the copies or move some items to another setup.`;
}

/** The refusal for copies that need more than one plate, when how many fit is not counted. */
function tooManyCopies(total: number, printer: { name: string }): string {
  return `Not exported. The ${total} copies need more than one plate: they need more room than the ${printer.name}'s plate has. An export writes one plate, so lower the copies or move some items to another setup.`;
}

/**
 * Export a resolved setup for printing: one 3MF of the whole plate, or one STL per body. The
 * bodies are tessellated through `exchanger` at `tolerance` (default `normal`) under their view
 * ids, which the kernel holds for the regen `resolved` was made from.
 */
export async function exportPrintSetup(
  exchanger: Pick<Exchanger, 'tessellate'>,
  resolved: ResolvedSetup,
  options: PrintExportOptions,
): Promise<ActionResult<ExportedFile[]>> {
  const refusal = exportRefusal(resolved, options.units);
  if (refusal !== null) return { ok: false, message: refusal };
  const printer = resolved.printer!;
  const items = resolved.items;
  const total = items.reduce((n, i) => n + (i.item.copies ?? 1), 0);
  if (total > MAX_PLATE_COPIES) return { ok: false, message: tooManyCopies(total, printer) };

  // Each body once, however many items print it.
  const ids = [...new Set(items.flatMap((i) => i.bodies.map((b) => b.sourceId)))];
  const names = new Map(items.flatMap((i) => i.bodies.map((b) => [b.sourceId, b.name] as const)));
  const deflection = deflectionOf(EXPORT_TOLERANCES[options.tolerance ?? 'normal']);
  const meshed = await exchanger.tessellate(ids, deflection, names);
  if (!meshed.ok) return meshed;
  const meshOf = new Map<string, MeshData>(ids.map((id, i) => [id, meshed.value[i]!.mesh]));

  // Each item oriented on the bed, from the meshes written: its placement and box.
  const oriented: {
    placement: Placement;
    min: [number, number];
    box: BoundingBox;
    copy: PlateCopy;
    count: number;
  }[] = [];
  // Packed copies, each grown by the gap on its right and back, never overlap and stay within the
  // printable area grown by the gap: more than that much room needed cannot fit on one plate.
  const xs = printer.area.map((p) => p[0]);
  const ys = printer.area.map((p) => p[1]);
  const room =
    (Math.max(...xs) - Math.min(...xs) + COPY_GAP) * (Math.max(...ys) - Math.min(...ys) + COPY_GAP);
  let need = 0;
  for (const item of items) {
    const positions = item.bodies.map((b) => meshOf.get(b.sourceId)!.positions);
    const placement = orientationPlacement(item.orientation!, positions);
    const box = boundingBox(positions, placement);
    if (!box) return { ok: false, message: `Not exported. ${item.label} has no geometry.` };
    const nozzles = nozzlesFor(printer, item.bodies);
    // At the export tolerance the mesh can be a hair larger than the one checked.
    const fit = itemBedFit(printer, box, nozzles);
    if (!fit.fits) {
      const { reasons } = bedFitReasons(fit, options.units);
      return {
        ok: false,
        message: `Not exported. ${item.label} does not fit the ${printer.name}'s bed: ${reasons.join('; ')}.`,
      };
    }
    const copy: PlateCopy = {
      width: box.max[0] - box.min[0],
      depth: box.max[1] - box.min[1],
      ...(nozzles ? { nozzles } : {}),
    };
    const count = item.item.copies ?? 1;
    oriented.push({ placement, min: [box.min[0], box.min[1]], box, copy, count });
    need += count * (copy.width + COPY_GAP) * (copy.depth + COPY_GAP);
  }
  if (total > 1 && need > room) return { ok: false, message: tooManyCopies(total, printer) };

  const copies: PlateCopy[] = [];
  const owners: { item: number; copy: number }[] = [];
  for (const [index, o] of oriented.entries()) {
    for (let copy = 0; copy < o.count; copy++) {
      copies.push(o.copy);
      owners.push({ item: index, copy });
    }
  }
  const plate = packPlate(printer, copies);
  if (plate.overflow > 0) {
    return { ok: false, message: overflowRefusal(printer, oriented, items, copies, plate) };
  }
  const placed = (item: number, at: readonly [number, number]): Placement => {
    const o = oriented[item]!;
    const t = o.placement.translation;
    return {
      rotation: o.placement.rotation,
      translation: [t[0] + at[0] - o.min[0], t[1] + at[1] - o.min[1], t[2]],
    };
  };

  const base = options.fileBase ?? printFileBase(options.documentName, resolved.setup.name);
  let files: ExportedFile[];
  try {
    if ((options.format ?? '3mf') === '3mf') {
      const unique = uniquer();
      let next = 0;
      const parts = items.map((item) => {
        const bodies = item.bodies.map(() => next++);
        return { name: unique(item.label), bodies, oneObject: bodies.length > 1 };
      });
      const assembly: ExportAssembly = {
        bodies: items.flatMap((item) =>
          item.bodies.map((b): ExportBody => ({
            name: b.name,
            mesh: meshOf.get(b.sourceId)!,
            color: b.color,
          })),
        ),
        parts,
        instances: owners.map((o, k) => ({
          part: o.item,
          name: `${parts[o.item]!.name} ${o.copy + 1}`,
          placement: placed(o.item, plate.spots[k]!),
        })),
      };
      const bytes = export3mfAssembly(assembly, { title: options.documentName });
      files = [{ name: fileName(base, '3mf'), bytes, type: MIME['3mf'] }];
    } else {
      const unique = fileUniquer('stl');
      const bodies: ExportBody[] = [];
      for (const [index, item] of items.entries()) {
        const first = owners.findIndex((o) => o.item === index);
        const matrix = placementMatrix(placed(index, plate.spots[first]!));
        for (const b of item.bodies) {
          const mesh = meshOf.get(b.sourceId)!;
          const moved = transformMesh(
            {
              positions: Float32Array.from(mesh.positions),
              indices: Uint32Array.from(mesh.indices),
            },
            matrix,
          );
          const name = item.bodies.length > 1 ? `${item.label} ${b.name}` : item.label;
          bodies.push({ name: unique(`${base}-${name}`), mesh: moved });
        }
      }
      files = exportStl(bodies, { merge: false }).map((f) => ({ ...f, type: MIME.stl }));
    }
  } catch (e) {
    if (e instanceof NotWatertightError)
      return { ok: false, message: `Not exported. ${e.message}` };
    throw e;
  }

  const sizes = files.map((f) => `${f.name} (${formatBytes(f.bytes.length)})`).join(', ');
  const what =
    (options.format ?? '3mf') === '3mf'
      ? `${total} ${total === 1 ? 'copy' : 'copies'} of ${items.length} ${items.length === 1 ? 'item' : 'items'} on the ${printer.name}'s plate`
      : `each body where its first copy lies on the ${printer.name}'s plate${total > items.length ? '; STL holds no copies or colours, so add the copies in the slicer' : '; STL holds no colours'}`;
  return {
    ok: true,
    value: files,
    message: `Exported ${sizes}: ${what}.${nearExcludedNote(printer, items, owners, plate.nearExcluded)}${warningsText(options.issues)}`,
  };
}

export interface PrintConfigurationsRequest {
  /** The document as stored; each row is applied to it with `configured`. */
  document: ManufaktureDocument;
  setupId: string;
  /** The rows to export, in order (default: every row). */
  rowIds?: readonly string[];
  format?: PrintExportFormat;
  tolerance?: ExportTolerancePreset;
  signal?: AbortSignal;
  onProgress?: (progress: { index: number; count: number; row: ConfigRow }) => void;
  /**
   * Each file as soon as it is made, so a cancelled export keeps what it finished. Only its name
   * is kept afterwards, so the rows' bytes are not all held at once.
   */
  onFile?: (file: ExportedFile, row: ConfigRow) => void;
}

export interface PrintConfigurationsResult {
  /** The names of the files made, in row order (the bytes went to `onFile`). */
  files: string[];
  failures: { row: ConfigRow; message: string }[];
  cancelled: boolean;
  ok: boolean;
  message: string;
}

/**
 * Export a setup once per configuration row, one file per row named
 * `<document>-<setup>-<row>.<ext>`: the row is applied, regenerated with `regen` (which must build
 * documents that are not the open one, see `shareRegenerator`), the setup resolved against that
 * model and exported as `exportPrintSetup` does. A row where a feature of a part the setup prints
 * fails, or whose setup is refused, is reported and the others still export.
 */
export async function exportPrintConfigurations(
  exchanger: Pick<Exchanger, 'tessellate'>,
  regen: (document: ManufaktureDocument, stored?: ManufaktureDocument) => Promise<RegenView | null>,
  request: PrintConfigurationsRequest,
): Promise<PrintConfigurationsResult> {
  const { document, setupId, signal } = request;
  const table = document.configurations?.rows ?? [];
  const rows = request.rowIds
    ? request.rowIds.flatMap((id) => table.filter((r) => r.id === id))
    : table;
  const files: string[] = [];
  const failures: { row: ConfigRow; message: string }[] = [];
  let done = 0;
  const finish = (cancelled: boolean): PrintConfigurationsResult => ({
    files,
    failures,
    cancelled,
    ok: !cancelled && failures.length === 0 && rows.length > 0,
    message: configurationsSummary(rows.length, done, files, failures, cancelled),
  });
  if (rows.length === 0) return finish(false);
  for (const [index, row] of rows.entries()) {
    if (signal?.aborted) return finish(true);
    request.onProgress?.({ index, count: rows.length, row });
    const variant = configured(document, row.id);
    if (!variant.ok) {
      failures.push({ row, message: variant.error.message });
      continue;
    }
    const setup = variant.value.print.setups.find((s) => s.id === setupId);
    if (!setup) {
      failures.push({ row, message: 'The print setup is gone.' });
      continue;
    }
    let view: RegenView | null = null;
    // Once more when the worker dropped the regen (a kernel recycle).
    for (let attempt = 0; attempt < 2 && view === null; attempt++) {
      view = await regen(variant.value, document);
      if (signal?.aborted) return finish(true);
    }
    if (view === null) {
      failures.push({ row, message: 'The kernel dropped the regen; try again.' });
      continue;
    }
    // A failing feature in a part it prints: its bodies would be of the last feature that worked.
    const printed = new Set(setup.items.map((i) => i.part));
    const why = failingFeature(variant.value, view, printed);
    if (why !== null) {
      failures.push({ row, message: why });
      continue;
    }
    const resolved = resolveSetup(variant.value, setup, view.parts);
    const r = await exportPrintSetup(exchanger, resolved, {
      documentName: document.name,
      units: document.units,
      fileBase: printFileBase(document.name, setup.name, row.name),
      ...(request.format ? { format: request.format } : {}),
      ...(request.tolerance ? { tolerance: request.tolerance } : {}),
    });
    if (signal?.aborted) return finish(true);
    if (!r.ok) {
      failures.push({ row, message: r.message.replace(/^Not exported\. /, '') });
      continue;
    }
    for (const f of r.value) {
      files.push(f.name);
      request.onFile?.(f, row);
    }
    done++;
  }
  return finish(false);
}

/** "<feature> fails in this configuration", for the first failing feature of `parts`; else null. */
function failingFeature(
  doc: ManufaktureDocument,
  view: RegenView,
  parts: ReadonlySet<string>,
): string | null {
  for (const model of view.parts) {
    if (!parts.has(model.partId)) continue;
    const failed = model.features.find((f) => f.status === 'error');
    if (!failed) continue;
    const feature = findPart(doc, model.partId)?.features.find((f) => f.id === failed.featureId);
    const why = failed.errors.map((e) => e.message).join('; ');
    return `${feature?.name ?? failed.featureId} fails in this configuration${why ? `: ${why}` : ''}.`;
  }
  return null;
}

function configurationsSummary(
  count: number,
  done: number,
  files: readonly string[],
  failures: readonly { row: ConfigRow; message: string }[],
  cancelled: boolean,
): string {
  if (count === 0) return 'There are no configurations to export.';
  const names = files.join(', ');
  const failed = failures.map((f) => `${f.row.name}: ${f.message}`).join(' ');
  const of = `${done} of ${count} configuration${count === 1 ? '' : 's'}`;
  if (cancelled) {
    return `Export cancelled after ${of}${names ? ` (${names})` : ''}.${failed ? ` ${failed}` : ''}`;
  }
  if (failures.length === 0) return `Exported ${of}: ${names}.`;
  return `Exported ${of}${names ? ` (${names})` : ''}. ${failed}`;
}
