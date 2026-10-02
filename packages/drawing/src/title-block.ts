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
