// Printing the sheet shown (M4 plan T4.4g): its SVG, from the same writer as the export
// (`@manufakture/io`), at paper size in a hidden frame. The files themselves are written by
// `@manufakture/io`'s `drawingFile`.

import type { DisplayList } from '@manufakture/drawing';
import { drawingToSvg } from '@manufakture/io';

/**
 * Print one sheet through the browser: its SVG at paper size in a hidden frame, so the printout is
 * to scale when the printer's page matches the sheet.
 */
export function printSheet(list: DisplayList, title: string): { ok: boolean; message?: string } {
  let svg: string;
  try {
    svg = drawingToSvg(list, { title });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    frame.remove();
    return { ok: false, message: 'The browser cannot print from here.' };
  }
  doc.open();
  doc.write(
    `<!doctype html><html><head><title></title><style>@page { size: ${list.width}mm ${list.height}mm; margin: 0 } html, body { margin: 0 } svg { display: block }</style></head><body>${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body></html>`,
  );
  doc.close();
  win.focus();
  win.print();
  setTimeout(() => frame.remove(), 60_000);
  return { ok: true };
}
