// The cut list as a PDF for the shop (M4 plan T4.3d): the cut list, hardware and totals on the
// first pages, then one page per sheet (drawn to scale with part numbers, offcuts and the cut
// order) and the lumber plans, through `@manufakture/io`'s PDF writer on its shared 2D sheets
// (`Sheet2`, T4.4f). Letter landscape for inch and foot documents, A4 landscape otherwise. The
// writer throws a RangeError on input it cannot write; the panel catches and reports it.

import type { DisplayUnits } from '@manufakture/core';
import type { CutList } from '@manufakture/domain-wood';
import {
  HELVETICA_CAP_HEIGHT,
  helveticaTextWidth,
  polylinePath,
  writePdf,
  type Item2,
  type Layer2,
  type Sheet2,
} from '@manufakture/io';
import { cutSequence, type SheetLayout, type StickLayout } from '@manufakture/nesting';
import { isImperial } from '@manufakture/takeoff';
import { formatLength, type LengthFormat } from '@manufakture/units';
import { displayRows, exactFormat, flagText, totalLines, type DisplayRow } from './cutlist';
import type { NestingResult } from './nesting';

const LETTER = { width: 279.4, height: 215.9 };
const A4 = { width: 297, height: 210 };
const MARGIN = 12;
const TEXT = 2.6;
const LINE = 5;

const LAYERS: Layer2[] = [
  { name: 'waste', color: '#e3e6ea' },
  { name: 'part', weight: 0.25, color: '#1f4fa8' },
  { name: 'offcut', weight: 0.2, dash: [2, 1], color: '#7a8591' },
  { name: 'sheet', weight: 0.4 },
  { name: 'rule', weight: 0.15, color: '#9aa3ad' },
  { name: 'text' },
];

interface Page {
  size: { width: number; height: number };
  items: Item2[];
}

function textWidth(text: string, height: number): number {
  return helveticaTextWidth(text, height / HELVETICA_CAP_HEIGHT);
}

/** `text` cut to fit `width` with an ellipsis (`...`, which every PDF font has). */
function fit(text: string, height: number, width: number): string {
  if (textWidth(text, height) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}...`, height) > width) t = t.slice(0, -1);
  return `${t}...`;
}

function text(
  page: Page,
  at: [number, number],
  value: string,
  options: { height?: number; anchor?: 'start' | 'middle' | 'end'; width?: number } = {},
): void {
  const height = options.height ?? TEXT;
  const shown = options.width === undefined ? value : fit(value, height, options.width);
  page.items.push({
    kind: 'text',
    layer: 'text',
    at,
    text: shown,
    height,
    rotation: 0,
    anchor: options.anchor ?? 'start',
    baseline: 'bottom',
  });
}

function rect(
  page: Page,
  layer: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill = false,
): void {
  page.items.push(
    polylinePath(
      layer,
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      { closed: true, fill },
    ),
  );
}

export interface CutListPdfOptions {
  title: string;
  units: DisplayUnits;
  /** The configuration row the list is for, when one is active. */
  configuration?: string;
  /** Lines to print under the list: excluded bodies, notes. */
  warnings?: readonly string[];
}

const COLUMNS: { key: keyof DisplayRow | 'flagsText'; title: string; width: number }[] = [
  { key: 'number', title: '#', width: 8 },
  { key: 'item', title: 'Item', width: 58 },
  { key: 'stock', title: 'Stock', width: 40 },
  { key: 'size', title: 'Size (L x W x T)', width: 62 },
  { key: 'quantity', title: 'Qty', width: 12 },
  { key: 'extended', title: 'Total', width: 28 },
  { key: 'flagsText', title: 'Notes', width: 47 },
];

/** The PDF of a cut list and its layouts. */
export function cutListPdf(
  list: CutList,
  layouts: NestingResult | null,
  options: CutListPdfOptions,
): Uint8Array<ArrayBuffer> {
  const format = exactFormat(options.units);
  const size = isImperial(format) ? LETTER : A4;
  const pages: Page[] = [];
  const newPage = (): Page => {
    const p = { size, items: [] };
    pages.push(p);
    return p;
  };
  const top = size.height - MARGIN;
  const bottom = MARGIN;

  // The cut list -----------------------------------------------------------------------------
  let page = newPage();
  let y = top - 5;
  const heading = `Cut list: ${options.title}${options.configuration ? ` (${options.configuration})` : ''}`;
  text(page, [MARGIN, y], heading, { height: 4.2 });
  y -= LINE * 1.6;
  const header = () => {
    let x = MARGIN;
    for (const c of COLUMNS) {
      text(page, [x, y], c.title, { width: c.width - 1.5 });
      x += c.width;
    }
    y -= 1.6;
    page.items.push(
      polylinePath('rule', [
        [MARGIN, y],
        [size.width - MARGIN, y],
      ]),
    );
    y -= LINE - 1.6;
  };
  const ensure = (lines: number, withHeader: boolean) => {
    if (y - lines * LINE >= bottom) return;
    page = newPage();
    y = top - 5;
    if (withHeader) header();
  };
  header();
  const rows = displayRows(list.rows, options.units);
  for (const r of rows) {
    ensure(1, true);
    let x = MARGIN;
    for (const c of COLUMNS) {
      const value =
        c.key === 'flagsText' ? r.flags.map(flagText).join('; ') : String(r[c.key] ?? '');
      text(page, [x, y], value, { width: c.width - 1.5 });
      x += c.width;
    }
    y -= LINE;
  }
  if (list.hardware.length > 0) {
    ensure(2 + list.hardware.length, false);
    y -= LINE / 2;
    text(page, [MARGIN, y], 'Hardware', { height: 3.2 });
    y -= LINE;
    for (const h of displayRows(list.hardware, options.units)) {
      ensure(1, false);
      text(page, [MARGIN, y], `${h.quantity} x ${h.item} ${h.size}`, {
        width: size.width - 2 * MARGIN,
      });
      y -= LINE;
    }
  }
  const totals = totalLines(list, options.units);
  ensure(2 + totals.length, false);
  y -= LINE / 2;
  text(page, [MARGIN, y], 'Totals', { height: 3.2 });
  y -= LINE;
  for (const t of totals) {
    text(page, [MARGIN, y], t, { width: size.width - 2 * MARGIN });
    y -= LINE;
  }
  for (const w of options.warnings ?? []) {
    ensure(1, false);
    text(page, [MARGIN, y], w, { width: size.width - 2 * MARGIN });
    y -= LINE;
  }

  // Sheet layouts ----------------------------------------------------------------------------
  const labels = new Map(rows.map((r) => [r.key, r]));
  for (const s of layouts?.sheets ?? []) {
    s.result.sheets.forEach((sheet, i) => {
      sheetPage(newPage(), sheet, {
        title: `${s.name}: sheet ${i + 1} of ${s.result.sheets.length}`,
        labels,
        format,
        size,
      });
    });
  }
  for (const s of layouts?.sticks ?? []) {
    const perPage = 10;
    for (let first = 0; first < s.result.sticks.length; first += perPage) {
      stickPage(newPage(), s.result.sticks.slice(first, first + perPage), {
        title: `${s.name}: sticks ${first + 1} to ${Math.min(first + perPage, s.result.sticks.length)} of ${s.result.sticks.length}`,
        labels,
        format,
        size,
      });
    }
  }

  const sheets: Sheet2[] = pages.map((p, i) => ({
    size: p.size,
    layers: LAYERS,
    items: [
      ...p.items,
      {
        kind: 'text',
        layer: 'text',
        at: [size.width - MARGIN, MARGIN / 2],
        text: `${i + 1} / ${pages.length}`,
        height: 2.2,
        rotation: 0,
        anchor: 'end',
        baseline: 'bottom',
      },
    ],
    title: `Cut list: ${options.title}`,
  }));
  return writePdf(sheets, { title: `Cut list: ${options.title}` });
}

interface DrawOptions {
  title: string;
  labels: ReadonlyMap<string, DisplayRow>;
  format: LengthFormat;
  size: { width: number; height: number };
}

function sheetPage(page: Page, sheet: SheetLayout, o: DrawOptions): void {
  const { size } = o;
  const len = (mm: number) => formatLength(mm, o.format);
  text(page, [MARGIN, size.height - MARGIN - 5], o.title, { height: 4.2 });
  text(
    page,
    [MARGIN, size.height - MARGIN - 11],
    `${len(sheet.length)} x ${len(sheet.width)}; waste ${sheet.wastePercent.toFixed(1)}%`,
  );
  // The drawing on the left, the cut order on the right.
  const listWidth = 62;
  const areaW = size.width - 3 * MARGIN - listWidth;
  const areaH = size.height - 2 * MARGIN - 18;
  const scale = Math.min(areaW / sheet.length, areaH / sheet.width);
  const ox = MARGIN;
  const oy = MARGIN + (areaH - sheet.width * scale);
  rect(page, 'waste', ox, oy, sheet.length * scale, sheet.width * scale, true);
  rect(page, 'sheet', ox, oy, sheet.length * scale, sheet.width * scale);
  for (const off of sheet.offcuts) {
    rect(
      page,
      'offcut',
      ox + off.x * scale,
      oy + off.y * scale,
      off.sizeX * scale,
      off.sizeY * scale,
    );
  }
  for (const p of sheet.placements) {
    const x = ox + p.x * scale;
    const y = oy + p.y * scale;
    const w = p.sizeX * scale;
    const h = p.sizeY * scale;
    page.items.push(
      polylinePath(
        'part',
        [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ],
        { closed: true },
      ),
    );
    const row = o.labels.get(p.partId);
    const label = row ? String(row.number) : p.partId;
    const th = Math.min(3.2, h / 3, w / 3);
    if (th >= 1) {
      text(page, [x + w / 2, y + h / 2], label, { height: th, anchor: 'middle' });
      if (row && h > 4 * th) {
        text(page, [x + w / 2, y + h / 2 - th * 1.8], row.item, {
          height: th * 0.7,
          anchor: 'middle',
          width: w - 2,
        });
      }
    }
  }
  const listX = size.width - MARGIN - listWidth;
  let y = size.height - MARGIN - 20;
  text(page, [listX, y], 'Cut order', { height: 3.2 });
  y -= LINE;
  const cuts = cutSequence(sheet);
  for (const [i, c] of cuts.entries()) {
    if (y < MARGIN + LINE) {
      text(page, [listX, y], `and ${cuts.length - i} more`);
      break;
    }
    const what = c.kind === 'trim' ? 'Trim' : c.kind === 'rip' ? 'Rip' : 'Crosscut';
    text(
      page,
      [listX, y],
      `${c.step}. ${what} at ${len(c.at - (c.axis === 'x' ? c.piece.x : c.piece.y))}`,
      {
        width: listWidth,
        height: 2.3,
      },
    );
    y -= LINE * 0.85;
  }
}

function stickPage(page: Page, sticks: readonly StickLayout[], o: DrawOptions): void {
  const { size } = o;
  const len = (mm: number) => formatLength(mm, o.format);
  text(page, [MARGIN, size.height - MARGIN - 5], o.title, { height: 4.2 });
  const longest = Math.max(...sticks.map((s) => s.length));
  const scale = (size.width - 2 * MARGIN) / longest;
  const bar = 8;
  let y = size.height - MARGIN - 20;
  for (const s of sticks) {
    text(
      page,
      [MARGIN, y + bar + 1.5],
      `${len(s.length)} stick; waste ${s.wastePercent.toFixed(1)}%`,
    );
    rect(page, 'waste', MARGIN, y, s.length * scale, bar, true);
    rect(page, 'sheet', MARGIN, y, s.length * scale, bar);
    for (const c of s.cuts) {
      const x = MARGIN + c.start * scale;
      const w = c.length * scale;
      rect(page, 'part', x, y, w, bar);
      const row = o.labels.get(c.partId);
      text(page, [x + w / 2, y + bar / 2 - 1], `${row ? row.number : c.partId}: ${len(c.length)}`, {
        anchor: 'middle',
        height: 2.2,
        width: w - 1,
      });
    }
    if (s.offcut) {
      rect(page, 'offcut', MARGIN + s.offcut.start * scale, y, s.offcut.length * scale, bar);
    }
    y -= bar + 9;
  }
}
