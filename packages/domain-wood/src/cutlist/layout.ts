// Sheet layouts and lumber plans from a cut list (M4 plan T4.3d; moved from the app in M8 plan
// T8.1b): the cut list's nesting-ready parts (`CutList.sheets`, `CutList.lumber`) with the
// document's settings (`domains.wood`: kerf, trims, stages) as `@manufakture/nesting` inputs (run
// by `nesting.ts`), and what to buy.

import type { SheetInput, StickInput } from '@manufakture/nesting';
import { resolveStock, type StockData } from '../stock-data';
import type { WoodSettings } from '../wood-data';
import { stockName, type CutList } from './cutlist';
import type { LayoutNote, NestingJob, NestingResult, SheetJob, StickJob } from './nesting';

/** Lengths closer than this (mm) are equal when checking a blank against its stock's width. */
const WIDTH_EPS = 1e-6;

/** The layouts' settings from the woodworking settings. */
function sheetSettings(s: WoodSettings): SheetInput['settings'] {
  return { kerf: s.kerf, trims: { ...s.sheetTrims }, maxStages: s.maxStages };
}

function stickSettings(s: WoodSettings): StickInput['settings'] {
  return { kerf: s.kerf, trims: { ...s.lumberTrims } };
}

/**
 * The nesting job for a cut list. A sheet stock with no sheet size, or lumber with no lengths it
 * is sold in, has no layout (a note says so). A lumber blank wider than its stock (a glued-up
 * panel, `actual-width`) cannot come from one stick: it is left out of the plan with a note.
 */
export function nestingJob(list: CutList, settings: WoodSettings, stock?: StockData): NestingJob {
  const notes: LayoutNote[] = [];
  const sheets: SheetJob[] = [];
  for (const s of list.sheets) {
    const name = stockName(s.stock);
    if (s.sheet === undefined) {
      notes.push({
        stock: s.stock,
        message: `${name} has no sheet size: set one in the Stock panel`,
      });
      continue;
    }
    sheets.push({
      stock: s.stock,
      name,
      thickness: s.thickness,
      input: {
        parts: s.parts.map((p) => ({ ...p })),
        stock: [
          {
            id: s.stock,
            length: s.sheet.length,
            width: s.sheet.width,
            grain: s.grain ? 'length' : 'none',
          },
        ],
        settings: sheetSettings(settings),
      },
    });
  }
  const sticks: StickJob[] = [];
  for (const l of list.lumber) {
    const name = stockName(l.stock);
    if (l.lengths.length === 0) {
      notes.push({
        stock: l.stock,
        message: `${name} is sold in random lengths: no lumber plan`,
      });
      continue;
    }
    const width = resolveStock(l.stock, stock)?.width;
    const parts = l.parts.filter((p) => {
      if (width === undefined || p.width <= width + WIDTH_EPS) return true;
      notes.push({
        stock: l.stock,
        row: p.id,
        message: `${p.quantity} ${p.quantity === 1 ? 'blank is' : 'blanks are'} wider than ${name}: glue up from several pieces (not in the lumber plan)`,
      });
      return false;
    });
    if (parts.length === 0) continue;
    sticks.push({
      stock: l.stock,
      name,
      input: {
        parts: parts.map((p) => ({ id: p.id, length: p.length, quantity: p.quantity })),
        stock: l.lengths.map((length) => ({ id: `${l.stock}@${length}`, length })),
        settings: stickSettings(settings),
      },
    });
  }
  return { sheets, sticks, notes };
}

/** One line of stock to buy: sheets of a sheet stock, or sticks of one length of a lumber stock. */
export interface Purchase {
  stock: string;
  kind: 'sheet' | 'stick';
  count: number;
  /** The stick length, mm (sticks). */
  length?: number;
}

/** How many sheets and sticks to buy, per stock (and per length for lumber), from the layouts. */
export function purchase(result: NestingResult): Purchase[] {
  const out: Purchase[] = [];
  for (const s of result.sheets) {
    out.push({ stock: s.stock, kind: 'sheet', count: s.result.totals.sheets });
  }
  for (const s of result.sticks) {
    for (const u of s.result.stock) {
      const length = Number(u.stockId.slice(u.stockId.lastIndexOf('@') + 1));
      out.push({ stock: s.stock, kind: 'stick', count: u.count, length });
    }
  }
  return out;
}
