// PDF from one or more `Sheet2`s, one page each: vector paths (lines, and arcs and ellipse arcs
// as cubic Beziers within a quarter turn each, under 3e-4 of the radius off), dash patterns and
// weights per layer, filled paths, and text in Helvetica, a standard 14 font, so nothing is
// embedded. Page size in points from the sheet's millimetres; the content stream draws in
// millimetres under one scaling `cm`. Written here rather than through jsPDF and svg2pdf.js: see
// the README's "Drawings" section for why.

import { zlibSync } from 'fflate';
import { HELVETICA_CAP_HEIGHT, helveticaTextWidth, winAnsiBytes } from './helvetica';
import {
  baselinePoint,
  connectedRuns,
  formatNumber,
  itemsByLayer,
  layerDash,
  pageOf,
  segmentBeziers,
  segmentPoint,
  type Layer2,
  type Path2,
  type Sheet2,
  type Text2,
} from './path2';

/** PDF points per millimetre. */
export const POINTS_PER_MM = 72 / 25.4;

export interface PdfWriteOptions {
  /** Document title (`/Title` in the info dictionary); default the first sheet's `title`. */
  readonly title?: string;
  /** Deflate the content streams (default true). */
  readonly compress?: boolean;
  /** `/CreationDate`; absent by default, so the same sheets give the same bytes. */
  readonly creationDate?: Date;
}

const n = (v: number): string => formatNumber(v, 4);

/** A PDF of the sheets, one page per sheet, each page the sheet's size. */
export function writePdf(
  sheets: Sheet2 | readonly Sheet2[],
  options: PdfWriteOptions = {},
): Uint8Array<ArrayBuffer> {
  const list: readonly Sheet2[] = Array.isArray(sheets) ? sheets : [sheets as Sheet2];
  if (!list.length) throw new Error('writePdf needs at least one sheet');
  const compress = options.compress ?? true;
  const title = options.title ?? list[0]!.title;

  // Object numbers: 1 catalog, 2 page tree, 3 font, 4 info, then a page and its content per sheet.
  const pageRef = (i: number) => 5 + 2 * i;
  const objects: (Uint8Array | string)[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${list.map((_, i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${list.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const info = ['/Producer (manufakture)'];
  if (title) info.push(`/Title ${pdfTextString(title)}`);
  if (options.creationDate) info.push(`/CreationDate (${pdfDate(options.creationDate)})`);
  objects[4] = `<< ${info.join(' ')} >>`;
  list.forEach((sheet, i) => {
    const page = pageOf(sheet);
    const w = page.width * POINTS_PER_MM;
    const h = page.height * POINTS_PER_MM;
    objects[pageRef(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(w)} ${n(h)}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageRef(i) + 1} 0 R >>`;
    const content = latin1(contentStream(sheet));
    objects[pageRef(i) + 1] = stream(
      compress ? zlibSync(content, { level: 9 }) : content,
      compress,
    );
  });

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array | string) => {
    const b = typeof bytes === 'string' ? latin1(bytes) : bytes;
    chunks.push(b);
    offset += b.length;
  };
  // The binary comment on line 2 tells transfer tools the file is binary.
  push(new Uint8Array([...latin1('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets: number[] = [];
  for (let k = 1; k < objects.length; k++) {
    offsets[k] = offset;
    push(`${k} 0 obj\n`);
    push(objects[k]!);
    push('\nendobj\n');
  }
  const xref = offset;
  const entries = ['0000000000 65535 f \n'];
  for (let k = 1; k < objects.length; k++)
    entries.push(`${String(offsets[k]).padStart(10, '0')} 00000 n \n`);
  push(`xref\n0 ${objects.length}\n${entries.join('')}`);
  push(
    `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  const out = new Uint8Array(new ArrayBuffer(offset));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function stream(data: Uint8Array, deflated: boolean): Uint8Array {
  const head = latin1(
    `<< /Length ${data.length}${deflated ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
  );
  const tail = latin1('\nendstream');
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

/** The page's drawing operators, in millimetres from the page's bottom left. */
export function contentStream(sheet: Sheet2): string {
  const page = pageOf(sheet);
  const k = POINTS_PER_MM;
  // The scale to nine decimals: at four, a 1 m sheet's far edge would be 6e-3 mm off.
  const scale = formatNumber(k, 9);
  const ops: string[] = [
    'q',
    `${scale} 0 0 ${scale} ${n(-page.origin[0] * k)} ${n(-page.origin[1] * k)} cm`,
    '1 j',
  ];
  for (const { layer, items } of itemsByLayer(sheet)) {
    if (!items.length) continue;
    ops.push(...layerState(layer));
    for (const item of items) {
      if (item.kind === 'path') ops.push(...pathOps(item));
      else ops.push(textOps(item));
    }
  }
  ops.push('Q', '');
  return ops.join('\n');
}

function rgb(hex: string | undefined): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '#000000');
  if (!m) return '0 0 0';
  return [m[1]!, m[2]!, m[3]!].map((x) => n(parseInt(x, 16) / 255)).join(' ');
}

function layerState(layer: Layer2): string[] {
  const dash = layerDash(layer);
  const c = rgb(layer.color);
  return [
    `${n(layer.weight ?? 0.25)} w`,
    `[${dash.map(n).join(' ')}] 0 d`,
    // Round caps lengthen dashes by the line width; dashed layers keep butt caps.
    `${dash.length ? 0 : 1} J`,
    `${c} RG ${c} rg`,
  ];
}

function pathOps(path: Path2): string[] {
  const ops: string[] = [];
  const runs = connectedRuns(path.segments);
  if (!runs.length) return ops;
  for (const run of runs) {
    const s = segmentPoint(run[0]!, 'start');
    ops.push(`${n(s[0])} ${n(s[1])} m`);
    for (const seg of run) {
      if (seg.kind === 'line') ops.push(`${n(seg.b[0])} ${n(seg.b[1])} l`);
      else
        for (const [, c1, c2, p] of segmentBeziers(seg))
          ops.push(`${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(p[0])} ${n(p[1])} c`);
    }
  }
  if (path.closed) {
    if (runs.length === 1) ops.push('h');
    else {
      const s = segmentPoint(runs[0]![0]!, 'start');
      ops.push(`${n(s[0])} ${n(s[1])} l`);
    }
  }
  ops.push(path.fill ? 'B' : 'S');
  return ops;
}

function textOps(t: Text2): string {
  const size = t.height / HELVETICA_CAP_HEIGHT;
  const width = helveticaTextWidth(t.text, size);
  const shift = t.anchor === 'middle' ? -width / 2 : t.anchor === 'end' ? -width : 0;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const p = baselinePoint(t);
  const x = p[0] + shift * c;
  const y = p[1] + shift * s;
  const hex = winAnsiBytes(t.text)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `BT /F1 ${n(size)} Tf ${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(x)} ${n(y)} Tm <${hex}> Tj ET`;
}

/** A PDF text string: PDFDocEncoding-safe ASCII as a literal, anything else as UTF-16BE hex. */
export function pdfTextString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++)
    hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(d: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** A string of code points under 256 as bytes. */
function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
