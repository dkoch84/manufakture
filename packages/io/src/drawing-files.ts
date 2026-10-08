// A drawing's files (M4 plan T4.4g, written by T4.4f's writers; moved here from the app's drawing
// workspace in M8 plan T8.1b): one sheet as SVG or DXF, or every sheet as one PDF, from the
// display lists regen lays out (`RegenEngine.drawingSheet`'s `display`). A construction set is a
// drawing like any other, so its sheets go through here too. The writers throw on input they
// cannot write (a non-finite coordinate, a sheet of no size); that is caught and reported, never
// thrown at the user.

import type { DisplayList } from '@manufakture/drawing';
import { drawingToDxf, drawingToPdf, drawingToSvg } from './drawing-export';
import { exportAllowed, type ExportSource } from './export-gate';

export type DrawingFormat = 'svg' | 'dxf' | 'pdf';

export const DRAWING_MIME: Record<DrawingFormat, string> = {
  svg: 'image/svg+xml',
  dxf: 'application/dxf',
  pdf: 'application/pdf',
};

export type DrawingFile =
  { ok: true; bytes: Uint8Array; fileName: string; type: string } | { ok: false; message: string };

/** A file name from a drawing's (and sheet's) name: no characters file systems refuse. */
export function drawingFileName(parts: readonly string[], format: DrawingFormat): string {
  const base = [...parts.join(' - ')]
    .map((c) => (c.charCodeAt(0) < 32 ? '_' : c))
    .join('')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim();
  return `${base || 'drawing'}.${format}`;
}

/**
 * The file for `format`: SVG and DXF of one sheet (`lists[0]`), PDF of every sheet in `lists`,
 * a page each. A sheet that could not be laid out (`null`) is reported by `names[i]`. Drawings
 * are fabrication files: refused when `source`, the branch the drawing's document comes from, is
 * an agent's unreviewed branch or is not known (`exportAllowed`).
 */
export function drawingFile(
  format: DrawingFormat,
  lists: readonly (DisplayList | null)[],
  names: { drawing: string; sheets: readonly string[] },
  source: ExportSource | null,
): DrawingFile {
  const gate = exportAllowed(source);
  if (!gate.ok) return gate;
  const missing = lists.findIndex((l) => l === null);
  if (missing >= 0 || lists.length === 0) {
    const sheet = names.sheets[missing] ?? 'The sheet';
    return { ok: false, message: `${sheet} cannot be laid out: check its size and views.` };
  }
  const ready = lists as readonly DisplayList[];
  try {
    if (format === 'pdf') {
      return {
        ok: true,
        bytes: drawingToPdf(ready, { title: names.drawing }),
        fileName: drawingFileName([names.drawing], 'pdf'),
        type: DRAWING_MIME.pdf,
      };
    }
    const title = [names.drawing, names.sheets[0] ?? ''].filter(Boolean).join(' - ');
    const text =
      format === 'svg' ? drawingToSvg(ready[0]!, { title }) : drawingToDxf(ready[0]!, { title });
    return {
      ok: true,
      bytes: new TextEncoder().encode(text),
      fileName: drawingFileName([names.drawing, names.sheets[0] ?? ''].filter(Boolean), format),
      type: DRAWING_MIME[format],
    };
  } catch (e) {
    return {
      ok: false,
      message: `The ${format.toUpperCase()} could not be written: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The SVG of a sheet for the screen: the export's own markup (the same writer, so the screen
 * shows what the file will), scaled to its box rather than to millimetres.
 */
export function screenSvg(
  list: DisplayList,
): { ok: true; markup: string } | { ok: false; message: string } {
  try {
    const svg = drawingToSvg(list);
    const markup = svg
      .replace(/^<\?xml[^>]*>\s*/, '')
      .replace(/ width="[^"]*mm" height="[^"]*mm"/, ' width="100%" height="100%"');
    return { ok: true, markup };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
