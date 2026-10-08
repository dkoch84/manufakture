// The construction takeoff as a PDF for the lumber yard (M6 plan T6.3b; moved from the app in M8
// plan T8.1b), through `@manufakture/io`'s PDF writer (T4.4f): the rows by section with their
// totals, cost and notes, the subtotals per level and feature, and the cost in all. The short
// "not an engineering tool" text opens the first page and closes every page (ADR 0015 decision 8).
// Letter landscape for inch and foot documents, A4 landscape otherwise. The writer throws a
// RangeError on input it cannot write; the caller catches and reports it.

import type { DisplayUnits } from '@manufakture/core';
import {
  HELVETICA_CAP_HEIGHT,
  helveticaTextWidth,
  polylinePath,
  writePdf,
  type Item2,
  type Layer2,
  type Sheet2,
} from '@manufakture/io';
import { isImperial } from '@manufakture/takeoff';
import { DISCLAIMER_SHORT } from '../disclaimer';
import {
  SECTIONS,
  costLines,
  exactFormat,
  flagText,
  sections,
  totalsText,
  type TakeoffDisplayRow,
} from '../takeoff/display';
import type { ConstructionTakeoff } from '../takeoff/types';

const LETTER = { width: 279.4, height: 215.9 };
const A4 = { width: 297, height: 210 };
const MARGIN = 12;
const TEXT = 2.6;
const SMALL = 2.1;
const LINE = 5;
/** Room kept at the foot of every page for the disclaimer. */
const FOOT = 12;

const LAYERS: Layer2[] = [{ name: 'rule', weight: 0.15, color: '#9aa3ad' }, { name: 'text' }];

interface Page {
  items: Item2[];
}

const width = (text: string, height: number) =>
  helveticaTextWidth(text, height / HELVETICA_CAP_HEIGHT);

function fit(text: string, height: number, w: number): string {
  if (width(text, height) <= w) return text;
  let t = text;
  while (t.length > 1 && width(`${t}...`, height) > w) t = t.slice(0, -1);
  return `${t}...`;
}

/** `text` broken into lines of at most `w` mm. */
export function wrap(text: string, height: number, w: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && width(next, height) > w) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function put(
  page: Page,
  at: [number, number],
  value: string,
  options: { height?: number; anchor?: 'start' | 'end'; width?: number } = {},
): void {
  const height = options.height ?? TEXT;
  page.items.push({
    kind: 'text',
    layer: 'text',
    at,
    text: options.width === undefined ? value : fit(value, height, options.width),
    height,
    rotation: 0,
    anchor: options.anchor ?? 'start',
    baseline: 'bottom',
  });
}

const COLUMNS: { title: string; width: number; value: (r: TakeoffDisplayRow) => string }[] = [
  { title: '#', width: 8, value: (r) => String(r.number) },
  { title: 'Item', width: 48, value: (r) => r.item },
  { title: 'Stock', width: 30, value: (r) => r.stock },
  { title: 'Size', width: 26, value: (r) => r.size },
  { title: 'Qty', width: 12, value: (r) => String(r.quantity) },
  { title: 'Total', width: 30, value: (r) => r.extended },
  { title: 'Cost', width: 22, value: (r) => r.cost },
  {
    title: 'Notes',
    width: 79,
    value: (r) => [r.counted, ...r.flags.map(flagText)].filter((s) => s !== '').join('; '),
  },
];

export interface TakeoffPdfOptions {
  title: string;
  units: DisplayUnits;
  subtotals?: readonly { kind: string; name: string; text: string }[];
  /** Lines under the rows: what the takeoff could not count. */
  notes?: readonly string[];
}

/** The PDF of a takeoff. */
export function takeoffPdf(
  takeoff: ConstructionTakeoff,
  rows: readonly TakeoffDisplayRow[],
  options: TakeoffPdfOptions,
): Uint8Array<ArrayBuffer> {
  const size = isImperial(exactFormat(options.units)) ? LETTER : A4;
  const inner = size.width - 2 * MARGIN;
  const pages: Page[] = [];
  let page: Page = { items: [] };
  pages.push(page);
  const top = size.height - MARGIN;
  const bottom = MARGIN + FOOT;
  let y = top - 5;
  const newPage = () => {
    page = { items: [] };
    pages.push(page);
    y = top - 5;
  };
  const ensure = (lines: number) => {
    if (y - lines * LINE < bottom) newPage();
  };
  const rule = () => {
    page.items.push(
      polylinePath('rule', [
        [MARGIN, y],
        [size.width - MARGIN, y],
      ]),
    );
  };

  put(page, [MARGIN, y], `Takeoff: ${options.title}`, { height: 4.2, width: inner });
  y -= LINE * 1.4;
  for (const line of wrap(DISCLAIMER_SHORT, TEXT, inner)) {
    put(page, [MARGIN, y], line);
    y -= LINE * 0.8;
  }
  y -= LINE * 0.6;

  const header = () => {
    let x = MARGIN;
    for (const c of COLUMNS) {
      put(page, [x, y], c.title, { width: c.width - 1.5 });
      x += c.width;
    }
    y -= 1.6;
    rule();
    y -= LINE - 1.6;
  };
  for (const section of sections(rows)) {
    ensure(4);
    const s = SECTIONS[section.category];
    put(page, [MARGIN, y], s.title, { height: 3.4 });
    y -= LINE * 0.9;
    put(page, [MARGIN, y], s.note, { height: SMALL, width: inner });
    y -= LINE;
    header();
    for (const r of section.rows) {
      if (y - LINE < bottom) {
        newPage();
        header();
      }
      let x = MARGIN;
      for (const c of COLUMNS) {
        put(page, [x, y], c.value(r), { width: c.width - 1.5 });
        x += c.width;
      }
      y -= LINE;
    }
    const totals = takeoff.totals.filter((t) => t.group === section.category);
    if (totals.length > 0) {
      put(page, [MARGIN + COLUMNS[0]!.width, y], `In all: ${totalsText(totals, options.units)}`, {
        width: inner - COLUMNS[0]!.width,
      });
      y -= LINE * 1.4;
    }
  }

  if (options.subtotals && options.subtotals.length > 0) {
    ensure(3);
    put(page, [MARGIN, y], 'Subtotals as framed and laid', { height: 3.4 });
    y -= LINE;
    for (const s of options.subtotals) {
      ensure(1);
      put(page, [MARGIN, y], `${s.kind === 'level' ? 'Level' : 'Feature'} ${s.name}: ${s.text}`, {
        width: inner,
      });
      y -= LINE;
    }
    y -= LINE * 0.4;
  }
  ensure(3);
  for (const line of [...costLines(takeoff, rows), ...(options.notes ?? [])]) {
    for (const part of wrap(line, TEXT, inner)) {
      ensure(1);
      put(page, [MARGIN, y], part);
      y -= LINE;
    }
  }

  const footer = wrap(DISCLAIMER_SHORT, SMALL * 0.9, inner - 20);
  const sheets: Sheet2[] = pages.map((p, i) => ({
    size,
    layers: LAYERS,
    items: [
      ...p.items,
      ...footer.map((line, k): Item2 => ({
        kind: 'text',
        layer: 'text',
        at: [MARGIN, MARGIN / 2 + (footer.length - 1 - k) * SMALL * 1.5],
        text: line,
        height: SMALL * 0.9,
        rotation: 0,
        anchor: 'start',
        baseline: 'bottom',
      })),
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
    title: `Takeoff: ${options.title}`,
  }));
  return writePdf(sheets, { title: `Takeoff: ${options.title}` });
}
