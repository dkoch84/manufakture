// The title block: a grid of labelled cells in the frame's bottom right corner. The layout is
// our choice. It is 180 mm wide, the largest width ISO 7200 is usually quoted as allowing (not
// read; unverified), and fits inside the frame of every size down to ANSI A in portrait.

import type { DisplayItem } from './display';
import type { Bounds, Vec2 } from './geometry';

export interface TitleBlockInput {
  readonly title?: string;
  readonly drawingNumber?: string;
  readonly revision?: string;
  /** `'1 / 3'`. Default `'1 / 1'`. */
  readonly sheet?: string;
  /** Default: the views' scale when they share one, `AS SHOWN` otherwise. */
  readonly scale?: string;
  readonly company?: string;
  readonly drawnBy?: string;
  readonly date?: string;
  readonly material?: string;
  /** `'mm'`, `'inches'`. */
  readonly units?: string;
  /** Default: the drawing's projection, written `THIRD ANGLE` or `FIRST ANGLE`. */
  readonly projection?: string;
}

interface Cell {
  readonly label: string;
  readonly key: keyof TitleBlockInput;
  readonly width: number;
}

const OWNER = 'titleBlock';
export const TITLE_BLOCK_WIDTH = 180;

/** Rows from the bottom up: height and cells left to right (widths add up to 180 mm). */
const ROWS: readonly { readonly height: number; readonly cells: readonly Cell[] }[] = [
  {
    height: 10,
    cells: [
      { label: 'DRAWING NO.', key: 'drawingNumber', width: 90 },
      { label: 'REV', key: 'revision', width: 20 },
      { label: 'SHEET', key: 'sheet', width: 30 },
      { label: 'SCALE', key: 'scale', width: 40 },
    ],
  },
  { height: 14, cells: [{ label: 'TITLE', key: 'title', width: 180 }] },
  {
    height: 10,
    cells: [
      { label: 'COMPANY', key: 'company', width: 90 },
      { label: 'DRAWN', key: 'drawnBy', width: 45 },
      { label: 'DATE', key: 'date', width: 45 },
    ],
  },
  {
    height: 10,
    cells: [
      { label: 'MATERIAL', key: 'material', width: 90 },
      { label: 'UNITS', key: 'units', width: 45 },
      { label: 'PROJECTION', key: 'projection', width: 45 },
    ],
  },
];

export const TITLE_BLOCK_HEIGHT = ROWS.reduce((sum, r) => sum + r.height, 0);

const LABEL_HEIGHT = 1.8;
const VALUE_HEIGHT = 3.5;
const TITLE_HEIGHT = 5;

/** The title block's rectangle in a frame (its bottom right corner). */
export function titleBlockBounds(frame: Bounds): Bounds {
  return {
    min: [frame.max[0] - TITLE_BLOCK_WIDTH, frame.min[1]],
    max: [frame.max[0], frame.min[1] + TITLE_BLOCK_HEIGHT],
  };
}

/** Lines and text of the title block, paper millimetres. Fields left out leave empty cells. */
export function layoutTitleBlock(input: TitleBlockInput, frame: Bounds): DisplayItem[] {
  const items: DisplayItem[] = [];
  const box = titleBlockBounds(frame);
  const x0 = box.min[0];
  const line = (a: Vec2, b: Vec2) =>
    items.push({ kind: 'line', layer: 'titleBlock', a, b, owner: OWNER });
  // The outer edges that are not the frame's own: left and top.
  line([x0, box.min[1]], [x0, box.max[1]]);
  line([x0, box.max[1]], [box.max[0], box.max[1]]);
  let y = box.min[1];
  ROWS.forEach((row, r) => {
    const top = y + row.height;
    if (r < ROWS.length - 1) line([x0, top], [box.max[0], top]);
    let x = x0;
    row.cells.forEach((cell, i) => {
      if (i > 0) line([x, y], [x, top]);
      items.push({
        kind: 'text',
        layer: 'text',
        at: [x + 1, top - 1],
        text: cell.label,
        height: LABEL_HEIGHT,
        rotation: 0,
        anchor: 'start',
        baseline: 'top',
        owner: OWNER,
      });
      const value = input[cell.key];
      if (value)
        items.push({
          kind: 'text',
          layer: 'text',
          at: [x + 2, y + 1.5],
          text: value,
          height: cell.key === 'title' ? TITLE_HEIGHT : VALUE_HEIGHT,
          rotation: 0,
          anchor: 'start',
          baseline: 'bottom',
          owner: OWNER,
        });
      x += cell.width;
    });
    y = top;
  });
  return items;
}

/** The longest disclaimer drawn, in characters; a longer one is cut with an ellipsis. */
export const MAX_DISCLAIMER_LENGTH = 2_000;
/**
 * The most lines a disclaimer wraps to; the last one ends in an ellipsis when cut. Enough for
 * `MAX_DISCLAIMER_LENGTH` characters across the title block (about 115 a line), so only text
 * longer than that is ever cut.
 */
export const MAX_DISCLAIMER_LINES = 24;
/** The disclaimer's text height, paper mm. */
export const DISCLAIMER_TEXT_HEIGHT = 1.8;
const DISCLAIMER_PAD = 1.5;
const LINE_PITCH = 1.5;

/**
 * Words of `text` wrapped to lines of at most `width` paper mm at `height`, at most
 * `MAX_DISCLAIMER_LINES` lines. A character is taken as 0.85 cap heights wide: wider than the
 * dimensions' estimate, because running text must stay inside its box in Helvetica (about 0.7 cap
 * heights a character) and in a monospaced fallback (about 0.84). A word longer than a line
 * stands on its own line. Linear in the text, which is cut to `MAX_DISCLAIMER_LENGTH` first.
 */
export function wrapText(text: string, width: number, height: number): string[] {
  const perChar = height * 0.85;
  const max = Math.max(1, Math.floor(width / perChar));
  let source = text.replace(/\s+/g, ' ').trim();
  if (source.length > MAX_DISCLAIMER_LENGTH)
    source = `${source.slice(0, MAX_DISCLAIMER_LENGTH)}...`;
  const lines: string[] = [];
  let line = '';
  for (const word of source.split(' ')) {
    if (word === '') continue;
    const next = line === '' ? word : `${line} ${word}`;
    if ([...next].length <= max || line === '') line = next;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length >= MAX_DISCLAIMER_LINES) break;
  }
  if (line !== '' && lines.length < MAX_DISCLAIMER_LINES) lines.push(line);
  if (lines.length === MAX_DISCLAIMER_LINES && lines.join(' ').length < source.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/\.*$/, '')}...`;
  }
  return lines;
}

/**
 * A disclaimer as a box of small text the title block's width, its bottom at `bottom` (paper mm),
 * right-aligned with the frame: drawn on top of the title block, or in the frame's bottom right
 * corner when the sheet has none. Its bottom edge is the title block's top line or the frame, so
 * only its left and top edges are drawn. Owned by `titleBlock`. Returns its items and its height.
 */
export function layoutDisclaimer(
  text: string,
  frame: Bounds,
  bottom: number,
): { items: DisplayItem[]; height: number } {
  const lines = wrapText(text, TITLE_BLOCK_WIDTH - 2 * DISCLAIMER_PAD, DISCLAIMER_TEXT_HEIGHT);
  if (lines.length === 0) return { items: [], height: 0 };
  const step = DISCLAIMER_TEXT_HEIGHT * LINE_PITCH;
  const height = lines.length * step + 2 * DISCLAIMER_PAD - (step - DISCLAIMER_TEXT_HEIGHT);
  const x0 = frame.max[0] - TITLE_BLOCK_WIDTH;
  const x1 = frame.max[0];
  const top = bottom + height;
  const items: DisplayItem[] = [
    { kind: 'line', layer: 'titleBlock', a: [x0, bottom], b: [x0, top], owner: OWNER },
    { kind: 'line', layer: 'titleBlock', a: [x0, top], b: [x1, top], owner: OWNER },
  ];
  lines.forEach((t, i) =>
    items.push({
      kind: 'text',
      layer: 'text',
      at: [x0 + DISCLAIMER_PAD, top - DISCLAIMER_PAD - i * step],
      text: t,
      height: DISCLAIMER_TEXT_HEIGHT,
      rotation: 0,
      anchor: 'start',
      baseline: 'top',
      owner: OWNER,
    }),
  );
  return { items, height };
}
