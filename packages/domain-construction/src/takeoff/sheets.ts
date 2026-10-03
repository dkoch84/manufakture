// The sheet producer: sheathing, drywall, subfloor and roof sheathing as sheets (ADR 0015
// decision 10).
//
// Per stock:
// 1. Every face is laid with whole sheets from its starting corner (`layoutFace`). A piece that
//    is a whole sheet is one sheet. A hole inside a piece is cut out of it; the cut-out is an
//    offcut when it is at least the minimum offcut size.
// 2. Same face: the face's partial pieces are packed onto its own cut-outs (the 2D packer, with
//    kerf, offcuts only).
// 3. Across faces: the partial pieces still left, from every face of the stock, and the members
//    cut from that stock (a header's plywood spacer), are packed onto the offcuts left on every
//    face, then onto new sheets. Offcuts cost nothing and a new sheet one unit, so the packer
//    uses offcuts before it opens a sheet.
// The sheets to buy are the whole sheets plus the new ones, plus the waste percentage, rounded
// up. Sheets have no grain here: OSB's strength axis and plywood's face grain are laid by the
// face's orientation, and partial pieces may turn.

import { findStock, resolveStock, type StockData } from '@manufakture/stock';
import {
  layoutSheets,
  type SheetLayoutResult,
  type SheetPart,
  type SheetStock,
} from '@manufakture/nesting';
import { memberFullId } from '../member-ids';
import { faceArea, layoutFace } from './faces';
import type {
  ConstructionRow,
  FaceLayout,
  FacePiece,
  FaceRect,
  SheetFace,
  SheetLayerKind,
  SheetStockLayout,
  TakeoffMember,
} from './types';

export interface SheetContext {
  readonly stock: StockData;
  readonly kerf: number;
  readonly wastePercent: number;
  readonly minOffcut: { readonly length: number; readonly width: number };
}

export interface SheetResult {
  /** One row per face, as laid (merge them for display). */
  laid: ConstructionRow[];
  /** What to buy, one row per stock. */
  bought: ConstructionRow[];
  faces: FaceLayout[];
  sheets: SheetStockLayout[];
}

/** How a layer is named in a row's `item`. */
export const LAYER_LABELS: Readonly<Record<SheetLayerKind, string>> = {
  siding: 'Siding',
  sheathing: 'Wall sheathing',
  drywall: 'Drywall',
  subfloor: 'Subfloor',
  'roof-sheathing': 'Roof sheathing',
};

const NEW = 'new';

const isOffcut = (r: { width: number; height: number }, min: SheetContext['minOffcut']) =>
  Math.max(r.width, r.height) >= min.length && Math.min(r.width, r.height) >= min.width;

const partOf = (id: string, r: { width: number; height: number }): SheetPart => ({
  id,
  length: Math.max(r.width, r.height),
  width: Math.min(r.width, r.height),
  quantity: 1,
  grainLocked: false,
});

const offcutStock = (id: string, r: { width: number; height: number }): SheetStock => ({
  id,
  length: Math.max(r.width, r.height),
  width: Math.min(r.width, r.height),
  quantity: 1,
  grain: 'none',
  cost: 0,
});

/** What is left of offcut stock after a packer run: unused ones and the used ones' leftovers. */
function leftovers(
  stock: readonly SheetStock[],
  result: SheetLayoutResult | null,
  min: SheetContext['minOffcut'],
): FaceRect[] {
  const used = new Set(result?.sheets.map((s) => s.stockId) ?? []);
  const out: FaceRect[] = [];
  for (const s of stock) {
    if (s.id !== NEW && !used.has(s.id)) out.push({ x: 0, y: 0, width: s.length, height: s.width });
  }
  for (const sheet of result?.sheets ?? []) {
    if (sheet.stockId === NEW) continue;
    for (const o of sheet.offcuts) {
      const r = { x: 0, y: 0, width: o.sizeX, height: o.sizeY };
      if (isOffcut(r, min)) out.push(r);
    }
  }
  return out;
}

/** Rows and layouts for the sheet faces and the members cut from sheet stock. */
export function sheetTakeoff(
  faces: readonly SheetFace[],
  members: readonly TakeoffMember[],
  ctx: SheetContext,
): SheetResult {
  const laid: ConstructionRow[] = [];
  const bought: ConstructionRow[] = [];
  const layouts: FaceLayout[] = [];
  const sheets: SheetStockLayout[] = [];

  const stockIds = [...new Set([...faces.map((f) => f.stock), ...members.map((m) => m.stock.id)])];
  for (const stockId of stockIds) {
    const stockFaces = faces.filter((f) => f.stock === stockId);
    const stockMembers = members.filter((m) => m.stock.id === stockId);
    const entry = findStock(stockId);
    const resolved = resolveStock(stockId, ctx.stock);
    const sheet = entry?.kind === 'sheet' ? resolved?.sheet : undefined;
    const thickness = resolved?.thickness;

    if (sheet === undefined) {
      // Not a sheet this build knows: the faces as laid, flagged, and nothing to buy.
      for (const f of stockFaces) {
        laid.push({
          key: `faces|${stockId}|${f.layer}`,
          item: LAYER_LABELS[f.layer],
          category: 'faces',
          stock: stockId,
          quantity: 0,
          unit: 'area',
          extended: faceArea(f),
          measures: [],
          sources: [{ id: f.id, quantity: 0 }],
          flags: ['stock-unknown'],
        });
      }
      continue;
    }

    // 1. Whole sheets on every face.
    const faceLayouts = stockFaces.map((f) => layoutFace(f, sheet));
    const pieceById = new Map<string, FacePiece>();
    for (const l of faceLayouts) for (const p of l.pieces) pieceById.set(p.id, p);
    const setFrom = (id: string, from: FacePiece['from']) => {
      const p = pieceById.get(id);
      if (p) pieceById.set(id, { ...p, from });
    };

    // 2. Each face's partial pieces onto its own cut-outs.
    const pending: SheetPart[] = [];
    const spare: FaceRect[] = [];
    for (const l of faceLayouts) {
      const partial = l.pieces.filter((p) => !p.full).map((p) => partOf(p.id, p));
      const cuts = l.cutouts
        .filter((c) => isOffcut(c, ctx.minOffcut))
        .map((c, i) => offcutStock(`${l.face}#cut${i + 1}`, c));
      let result: SheetLayoutResult | null = null;
      if (partial.length > 0 && cuts.length > 0) {
        result = layoutSheets({
          parts: partial,
          stock: cuts,
          settings: { kerf: ctx.kerf, minOffcut: ctx.minOffcut },
        });
        for (const s of result.sheets) for (const pl of s.placements) setFrom(pl.partId, 'offcut');
        const left = new Set(result.unplaced.map((u) => u.partId));
        pending.push(...partial.filter((p) => left.has(p.id)));
      } else {
        pending.push(...partial);
      }
      spare.push(...leftovers(cuts, result, ctx.minOffcut));
    }

    // 3. Across faces: what is left, and members cut from this stock, onto offcuts, then new sheets.
    for (const m of stockMembers)
      pending.push(partOf(memberFullId(m), { width: m.length, height: m.stock.depth }));
    let result: SheetLayoutResult | null = null;
    let packed = 0;
    const unplacedMembers = new Set<string>();
    if (pending.length > 0) {
      const stock: SheetStock[] = [
        ...spare.map((r, i) => offcutStock(`offcut${i + 1}`, r)),
        { id: NEW, length: sheet.length, width: sheet.width, grain: 'none', cost: 1 },
      ];
      result = layoutSheets({
        parts: pending,
        stock,
        settings: { kerf: ctx.kerf, minOffcut: ctx.minOffcut },
      });
      for (const s of result.sheets) {
        if (s.stockId === NEW) packed++;
        for (const pl of s.placements) setFrom(pl.partId, s.stockId === NEW ? 'new' : 'offcut');
      }
      for (const u of result.unplaced) unplacedMembers.add(u.partId);
    }

    const full = faceLayouts.reduce((a, l) => a + l.pieces.filter((p) => p.full).length, 0);
    const count = full + packed;
    const buy = Math.ceil(count * (1 + ctx.wastePercent / 100) - 1e-9);
    sheets.push({ stock: stockId, full, packed, sheets: count, bought: buy, result });

    for (let i = 0; i < faceLayouts.length; i++) {
      const l = faceLayouts[i]!;
      const f = stockFaces[i]!;
      const done: FaceLayout = { ...l, pieces: l.pieces.map((p) => pieceById.get(p.id)!) };
      layouts.push(done);
      laid.push({
        key: `faces|${stockId}|${f.layer}`,
        item: LAYER_LABELS[f.layer],
        category: 'faces',
        stock: stockId,
        ...(thickness === undefined ? {} : { size: { thickness } }),
        quantity: l.pieces.length,
        unit: 'area',
        extended: l.area,
        measures: [],
        sources: [{ id: f.id, quantity: l.pieces.length }],
        flags: [],
      });
    }

    const flags: string[] = [];
    if (ctx.wastePercent > 0) flags.push('waste-added');
    if (unplacedMembers.size > 0) flags.push('longer-than-stock');
    bought.push({
      key: `sheet|${stockId}`,
      item: entry!.name,
      category: 'sheet',
      stock: stockId,
      size: {
        length: sheet.length,
        width: sheet.width,
        ...(thickness === undefined ? {} : { thickness }),
      },
      quantity: buy,
      unit: 'sheet',
      extended: buy,
      measures: [{ unit: 'area', value: buy * sheet.length * sheet.width }],
      sources: [
        ...faceLayouts.map((l) => ({ id: l.face, quantity: l.pieces.length })),
        ...stockMembers.map((m) => ({ id: memberFullId(m), quantity: 1 })),
      ],
      flags,
    });
  }
  return { laid, bought, faces: layouts, sheets };
}
