// The cut list and bill of materials (M4 plan T4.3a): the woodworking producer of the generic
// takeoff (`@manufakture/takeoff`, ADR 0013 decision 8).
//
// Every board is listed by its blank: the stock size before joinery, from the board's frame (a
// tenon's length is part of its board, since the tenon is cut from it). Rows group pieces of one
// stock, one material and one blank size. Sheet goods count area, lumber board feet (by the
// stock's basis, `board-feet.ts`) and length. A body that is not a board but is made of a wood
// material is listed by its oriented box (`estimated`), or by its volume alone (`size-unknown`)
// when the input has no box for it. Joints' dowels and screws, and slides from the hardware
// catalog (`wood.slide`, #1200), are the hardware lines; a slide's two member bodies are that line,
// never pieces or excluded bodies.
//
// Counting: a part studio list counts every body once and every joint once. Through an assembly,
// each instance that is not suppressed counts the bodies it shows; a joint counts as often as both
// of its boards are shown (the smaller of the two counts), so an assembly of per-board instances
// (one instance per board, M4 decision 5) gives exactly the part studio's list. A slide counts as
// often as either of its members is shown (the larger count), so a drawer instance showing the
// drawer member and a cabinet instance showing the cabinet member count it once.

import { findMaterial } from '@manufakture/core';
import {
  compareIds,
  mergeRows,
  sizeKey,
  totals,
  type TakeoffRow,
  type TakeoffTotal,
} from '@manufakture/takeoff';
import { readBoardMetadata, type BoardMetadata } from '../board';
import { STOCK, findStock } from '../catalog';
import { readJointMetadata, type JointMetadata } from '../joints';
import { findSlideFamily, readSlideMetadata, type SlideMetadata } from '../slides';
import { EMPTY_STOCK_DATA, resolveStock } from '../stock-data';
import { blankBoardFeet } from './board-feet';
import type { CutListBody, CutListInput, CutListPart } from './input';

/**
 * Flags a cut list row may carry:
 * - `estimated`: not a board; sized by its oriented box, so the size is the shape's, not a blank's.
 * - `size-unknown`: not a board, and no oriented box was given; listed with its volume only.
 * - `actual-width`: lumber counted on the blank's own width, not the stock's nominal width (a
 *   ripped stick, a glued-up panel).
 * - `stock-unknown`: the board names a stock this build's catalog does not have.
 */
export type CutListFlag = 'estimated' | 'size-unknown' | 'actual-width' | 'stock-unknown';

/** A cut list row: a takeoff row with whether the pieces have a grain (for sheet layouts). */
export interface CutListRow extends TakeoffRow {
  /** `board`: from a `wood.board`; `shape`: another body of a wood material; `hardware`. */
  kind: 'board' | 'shape' | 'hardware';
  /** Whether the pieces have a grain their length runs along. */
  grain: boolean;
}

/** One rectangular part for a sheet layout (`@manufakture/nesting`'s `SheetPart`). */
export interface SheetLayoutPart {
  /** The cut list row's key. */
  id: string;
  length: number;
  width: number;
  quantity: number;
  grainLocked: boolean;
}

/** The parts cut from one sheet stock, and its sheet size (with the document's override). */
export interface SheetLayoutInput {
  stock: string;
  thickness: number;
  /** The sheet size in stock, mm; undefined when the catalog gives none. */
  sheet: { length: number; width: number } | undefined;
  /** Whether the sheet has a grain direction (along its length). */
  grain: boolean;
  parts: SheetLayoutPart[];
}

/** The lengths cut from one lumber stock (`@manufakture/nesting`'s stick parts). */
export interface LumberLayoutInput {
  stock: string;
  /** The lengths it is sold in, mm (empty for random-length hardwood). */
  lengths: number[];
  parts: { id: string; length: number; width: number; quantity: number }[];
}

/** Why a body is not in the list. */
export interface ExcludedBody {
  part: string;
  bodyId: string;
  /** `not-wood`: its material is not a wood; `no-material`: neither it nor its part has one. */
  reason: 'not-wood' | 'no-material';
}

/** Something an assembly names that the input does not have. */
export interface MissingItem {
  instance: string;
  part: string;
  /** Absent: the whole part build is missing. */
  bodyId?: string;
}

export interface CutList {
  /**
   * Boards and wood shapes: sheets first, then lumber, then shapes; by stock in catalog order,
   * then material, then thickest, longest and widest first.
   */
  rows: CutListRow[];
  /** Hardware from joints (dowels, pocket screws) and slides, as bill of materials lines. */
  hardware: CutListRow[];
  /** Totals per category (`sheet`, `lumber`, `part`, `hardware`) and unit. */
  totals: TakeoffTotal[];
  /** Totals per stock id (boards only) and unit. */
  stockTotals: TakeoffTotal[];
  /** The sheet parts per sheet stock, for `@manufakture/nesting`'s sheet layouts. */
  sheets: SheetLayoutInput[];
  /** The lumber parts per lumber stock, for stick layouts. */
  lumber: LumberLayoutInput[];
  excluded: ExcludedBody[];
  missing: MissingItem[];
  /** The configuration row in force, as given. */
  configuration?: { id: string; name: string };
}

/** The display name of a stock id: the catalog's name, or the id when it is unknown. */
export function stockName(id: string): string {
  return findStock(id)?.name ?? id;
}

const CATEGORY_ORDER = ['sheet', 'lumber', 'part', 'hardware'];
const STOCK_ORDER: ReadonlyMap<string, number> = new Map(STOCK.map((e, i) => [e.id, i]));

function compareRows(a: CutListRow, b: CutListRow): number {
  const so = (r: CutListRow) =>
    r.stock === undefined ? Infinity : (STOCK_ORDER.get(r.stock) ?? STOCK.length);
  const size = (r: CutListRow, k: 'length' | 'width' | 'thickness' | 'diameter') =>
    r.size?.[k] ?? 0;
  return (
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
    so(a) - so(b) ||
    compareIds(a.stock ?? '', b.stock ?? '') ||
    compareIds(a.material ?? '', b.material ?? '') ||
    size(b, 'diameter') - size(a, 'diameter') ||
    size(b, 'thickness') - size(a, 'thickness') ||
    size(b, 'length') - size(a, 'length') ||
    size(b, 'width') - size(a, 'width') ||
    compareIds(a.item, b.item) ||
    compareIds(a.key, b.key)
  );
}

interface Counted {
  part: string;
  instance?: string;
}

/** One piece of a board, as a row of quantity 1. */
function boardRow(
  input: CutListInput,
  body: CutListBody,
  meta: BoardMetadata,
  item: string,
  source: Counted,
): CutListRow {
  const { length, width, thickness } = meta.frame.size;
  const size = { length, width, thickness };
  const material = body.material ?? meta.material;
  const sources = [{ id: body.bodyId, ...source, quantity: 1 }];
  const key = `board|${meta.stock}|${material}|${sizeKey(size)}`;
  const resolved = resolveStock(meta.stock, input.stock ?? EMPTY_STOCK_DATA);
  const base = { key, item, stock: meta.stock, material, size, quantity: 1, sources };
  if (resolved === undefined) {
    return {
      ...base,
      kind: 'board',
      category: 'part',
      unit: 'each',
      extended: 1,
      measures: [],
      flags: ['stock-unknown'],
      grain: meta.grain,
    };
  }
  const bf = blankBoardFeet(resolved.entry, size, resolved.width);
  if (resolved.entry.kind === 'sheet' || bf === undefined) {
    return {
      ...base,
      kind: 'board',
      category: 'sheet',
      unit: 'area',
      extended: length * width,
      measures: [],
      flags: [],
      grain: meta.grain,
    };
  }
  return {
    ...base,
    kind: 'board',
    category: 'lumber',
    unit: 'board-foot',
    extended: bf.value,
    measures: [{ unit: 'length', value: length }],
    flags:
      bf.width === 'actual' && resolved.entry.boardFeetBasis === 'nominal' ? ['actual-width'] : [],
    grain: meta.grain,
  };
}

/** One piece of a body that is not a board, or why it is not listed. */
function shapeRow(
  part: CutListPart,
  body: CutListBody,
  item: string,
  source: Counted,
): CutListRow | ExcludedBody['reason'] {
  const material = body.material ?? part.material;
  if (material === undefined) return 'no-material';
  if (findMaterial(material)?.category !== 'wood') return 'not-wood';
  const sources = [{ id: body.bodyId, ...source, quantity: 1 }];
  const oriented = part.orientedSizes?.find((o) => o.bodyId === body.bodyId);
  const measures =
    body.volume === undefined ? [] : [{ unit: 'volume' as const, value: body.volume }];
  const base = {
    kind: 'shape' as const,
    item,
    material,
    category: 'part',
    quantity: 1,
    unit: 'each' as const,
    extended: 1,
    measures,
    sources,
    grain: false,
  };
  if (oriented === undefined) {
    return {
      ...base,
      key: `shape|${part.id}|${body.bodyId}`,
      flags: ['size-unknown'],
    };
  }
  const [length, width, thickness] = [...oriented.sizes].sort((a, b) => b - a) as [
    number,
    number,
    number,
  ];
  const size = { length, width, thickness };
  return { ...base, key: `shape|${material}|${sizeKey(size)}`, size, flags: ['estimated'] };
}

/** The hardware lines of one joint, counted `times`. */
function hardwareRows(
  part: CutListPart,
  featureId: string,
  joint: JointMetadata,
  times: number,
): CutListRow[] {
  return joint.hardware.map((h) => {
    const size =
      h.item === 'dowel' ? { diameter: h.diameter, length: h.length } : { length: h.length };
    const quantity = h.quantity * times;
    return {
      key: `hardware|${h.item}|${sizeKey(size)}`,
      kind: 'hardware',
      item: h.item === 'dowel' ? 'Dowel' : 'Pocket screw',
      category: 'hardware',
      size,
      quantity,
      unit: 'each',
      extended: quantity,
      measures: [],
      sources: [{ id: featureId, part: part.id, quantity }],
      flags: [],
      grain: false,
    };
  });
}

/** The hardware line of one slide, counted `times`: the family's item, by nominal length. */
function slideRow(
  part: CutListPart,
  featureId: string,
  slide: SlideMetadata,
  times: number,
): CutListRow {
  const size = { length: slide.nominal };
  return {
    key: `hardware|slide|${slide.family}|${slide.size}`,
    kind: 'hardware',
    item: findSlideFamily(slide.family)?.item ?? slide.item,
    category: 'hardware',
    size,
    quantity: times,
    unit: 'each',
    extended: times,
    measures: [],
    sources: [{ id: featureId, part: part.id, quantity: times }],
    flags: [],
    grain: false,
  };
}

/**
 * The cut list and bill of materials of `input`. Pure: the same input gives the same list, in
 * the same order.
 */
export function cutList(input: CutListInput): CutList {
  const parts = new Map(input.parts.map((p) => [p.id, p]));
  const pieces: CutListRow[] = [];
  const excluded = new Map<string, ExcludedBody>();
  const missing: MissingItem[] = [];
  /** Per part build: how many times each body is counted. */
  const shown = new Map<string, Map<string, number>>();

  const count = (part: CutListPart, body: CutListBody, source: Counted) => {
    let byBody = shown.get(part.id);
    if (byBody === undefined) shown.set(part.id, (byBody = new Map()));
    byBody.set(body.bodyId, (byBody.get(body.bodyId) ?? 0) + 1);
    const creator = part.features.find((f) => f.featureId === body.creator);
    // A slide's members are a hardware line (counted below), not pieces.
    if (readSlideMetadata(creator?.metadata) !== undefined) return;
    const item = body.name ?? creator?.name ?? body.bodyId;
    const board = readBoardMetadata(creator?.metadata);
    if (board !== undefined) {
      pieces.push(boardRow(input, body, board, item, source));
      return;
    }
    const row = shapeRow(part, body, item, source);
    if (typeof row === 'string') {
      excluded.set(JSON.stringify([part.id, body.bodyId]), {
        part: part.id,
        bodyId: body.bodyId,
        reason: row,
      });
    } else {
      pieces.push(row);
    }
  };

  if (input.assembly === undefined) {
    for (const part of input.parts) {
      for (const body of part.bodies) count(part, body, { part: part.id });
    }
  } else {
    for (const instance of input.assembly.instances) {
      if (instance.suppressed === true) continue;
      const part = parts.get(instance.part);
      if (part === undefined) {
        missing.push({ instance: instance.id, part: instance.part });
        continue;
      }
      const bodies = new Map(part.bodies.map((b) => [b.bodyId, b]));
      for (const id of instance.bodies ?? part.bodies.map((b) => b.bodyId)) {
        const body = bodies.get(id);
        if (body === undefined) {
          missing.push({ instance: instance.id, part: part.id, bodyId: id });
          continue;
        }
        count(part, body, { part: part.id, instance: instance.id });
      }
    }
  }

  const hardware: CutListRow[] = [];
  for (const part of input.parts) {
    const byBody = shown.get(part.id);
    if (byBody === undefined) continue;
    for (const f of part.features) {
      const slide = readSlideMetadata(f.metadata);
      if (slide !== undefined) {
        const times = Math.max(
          byBody.get(slide.bodies.cabinet) ?? 0,
          byBody.get(slide.bodies.drawer) ?? 0,
        );
        if (times > 0) hardware.push(slideRow(part, f.featureId, slide, times));
        continue;
      }
      const joint = readJointMetadata(f.metadata);
      if (joint === undefined) continue;
      const times = Math.min(byBody.get(joint.a) ?? 0, byBody.get(joint.b) ?? 0);
      if (times > 0) hardware.push(...hardwareRows(part, f.featureId, joint, times));
    }
  }

  const rows = (mergeRows(pieces) as CutListRow[]).sort(compareRows);
  const hardwareRowsMerged = (mergeRows(hardware) as CutListRow[]).sort(compareRows);
  const boards = rows.filter((r) => r.kind === 'board' && r.stock !== undefined);

  const sheets = new Map<string, SheetLayoutInput>();
  const lumber = new Map<string, LumberLayoutInput>();
  const grainRule = input.settings?.grain ?? 'respect';
  for (const row of boards) {
    const resolved = resolveStock(row.stock!, input.stock ?? EMPTY_STOCK_DATA);
    if (resolved === undefined || row.size === undefined) continue;
    const { length = 0, width = 0 } = row.size;
    if (row.category === 'sheet') {
      let s = sheets.get(row.stock!);
      if (s === undefined) {
        sheets.set(
          row.stock!,
          (s = {
            stock: row.stock!,
            thickness: resolved.thickness,
            sheet: resolved.sheet,
            grain: resolved.entry.grain,
            parts: [],
          }),
        );
      }
      s.parts.push({
        id: row.key,
        length,
        width,
        quantity: row.quantity,
        grainLocked: row.grain && grainRule === 'respect',
      });
    } else if (row.category === 'lumber') {
      let l = lumber.get(row.stock!);
      if (l === undefined) {
        lumber.set(
          row.stock!,
          (l = { stock: row.stock!, lengths: [...(resolved.entry.lengths ?? [])], parts: [] }),
        );
      }
      l.parts.push({ id: row.key, length, width, quantity: row.quantity });
    }
  }

  const all = [...rows, ...hardwareRowsMerged];
  const list: CutList = {
    rows,
    hardware: hardwareRowsMerged,
    totals: totals(all, (r) => r.category),
    stockTotals: totals(boards, (r) => r.stock!),
    sheets: [...sheets.values()],
    lumber: [...lumber.values()],
    excluded: [...excluded.values()].sort(
      (a, b) => compareIds(a.part, b.part) || compareIds(a.bodyId, b.bodyId),
    ),
    missing,
  };
  if (input.configuration !== undefined) list.configuration = { ...input.configuration };
  return list;
}
