// An independent check of a sheet layout: it trusts nothing the packer computed except what it
// re-derives from the input. Used by the property tests, and by later acceptance tests (the
// bookshelf, T4.6) to prove a layout places every part with kerf gaps and can be cut.

import { EPS } from './common';
import {
  orientations,
  resolveMaxStages,
  resolveTrims,
  stageOf,
  usableRect,
  type Axis,
  type CutTree,
  type Rect,
  type SheetInput,
  type SheetLayout,
  type SheetLayoutResult,
} from './sheet';

const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
const rectNear = (a: Rect, b: Rect) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.sizeX, b.sizeX) && near(a.sizeY, b.sizeY);
const show = (r: Rect) => `(${r.x}, ${r.y}) ${r.sizeX} x ${r.sizeY}`;

/**
 * Checks a sheet layout against its input. Returns the problems found, empty when the layout
 * is valid:
 *
 * - every sheet's size and usable area match its stock and the trims, and no stock is used
 *   more often than its quantity allows;
 * - every placement has its part's size in an allowed orientation (grain-locked parts are not
 *   rotated off a grained sheet's grain) and lies inside the usable area;
 * - no two placements are closer than the kerf (they do not overlap, kerf included);
 * - the cut tree replays: each cut runs across its whole piece, its children are exactly the
 *   two sides of the kerf, its stage follows from its parent and is within the stage limit,
 *   and every placement is exactly one leaf of the tree;
 * - placed plus unplaced copies of each part equal its quantity.
 */
export function checkSheetLayout(input: SheetInput, result: SheetLayoutResult): string[] {
  const problems: string[] = [];
  const kerf = input.settings.kerf;
  const trims = resolveTrims(input.settings.trims);
  const maxStages = resolveMaxStages(input.settings.maxStages);
  const parts = new Map(input.parts.map((p) => [p.id, p]));
  const stock = new Map(input.stock.map((s) => [s.id, s]));
  const placedCopies = new Map<string, Set<number>>();
  const stockCount = new Map<string, number>();

  for (const sheet of result.sheets) {
    const where = `sheet ${sheet.index}`;
    const s = stock.get(sheet.stockId);
    if (!s) {
      problems.push(`${where}: unknown stock ${sheet.stockId}`);
      continue;
    }
    stockCount.set(s.id, (stockCount.get(s.id) ?? 0) + 1);
    if (!near(sheet.length, s.length) || !near(sheet.width, s.width)) {
      problems.push(`${where}: size differs from stock ${s.id}`);
    }
    const usable = usableRect(s, trims);
    if (!rectNear(sheet.usable, usable)) {
      problems.push(`${where}: usable area ${show(sheet.usable)}, expected ${show(usable)}`);
    }

    sheet.placements.forEach((p, i) => {
      const part = parts.get(p.partId);
      if (!part) {
        problems.push(`${where}: placement ${i} has unknown part ${p.partId}`);
        return;
      }
      const copies = placedCopies.get(p.partId) ?? new Set<number>();
      if (copies.has(p.copy)) problems.push(`${where}: ${p.partId} copy ${p.copy} placed twice`);
      copies.add(p.copy);
      placedCopies.set(p.partId, copies);
      if (!(Number.isInteger(p.copy) && p.copy >= 1 && p.copy <= part.quantity)) {
        problems.push(`${where}: ${p.partId} has copy ${p.copy} of ${part.quantity}`);
      }
      const allowed = orientations(part, s.grain).some(
        (o) => o.rotated === p.rotated && near(o.sizeX, p.sizeX) && near(o.sizeY, p.sizeY),
      );
      if (!allowed) {
        problems.push(
          `${where}: ${p.partId} placed ${p.sizeX} x ${p.sizeY}` +
            `${p.rotated ? ' rotated' : ''}, not an allowed orientation on ${s.grain} grain`,
        );
      }
      if (
        p.x < usable.x - EPS ||
        p.y < usable.y - EPS ||
        p.x + p.sizeX > usable.x + usable.sizeX + EPS ||
        p.y + p.sizeY > usable.y + usable.sizeY + EPS
      ) {
        problems.push(`${where}: ${p.partId} ${show(p)} is outside the usable area`);
      }
    });

    checkGaps(sheet, kerf, problems);
    checkTree(sheet, usable, kerf, maxStages, problems);
  }

  for (const [id, count] of stockCount) {
    const q = stock.get(id)?.quantity;
    if (q !== undefined && count > q) problems.push(`stock ${id}: ${count} sheets used of ${q}`);
  }

  const unplaced = new Map<string, number>();
  for (const u of result.unplaced) {
    unplaced.set(u.partId, (unplaced.get(u.partId) ?? 0) + u.quantity);
  }
  for (const part of input.parts) {
    const placed = placedCopies.get(part.id)?.size ?? 0;
    const missing = unplaced.get(part.id) ?? 0;
    if (placed + missing !== part.quantity) {
      problems.push(
        `part ${part.id}: ${placed} placed + ${missing} unplaced, quantity ${part.quantity}`,
      );
    }
  }
  return problems;
}

function checkGaps(sheet: SheetLayout, kerf: number, problems: string[]): void {
  const ps = sheet.placements;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i]!;
      const b = ps[j]!;
      const apart =
        a.x + a.sizeX + kerf <= b.x + EPS ||
        b.x + b.sizeX + kerf <= a.x + EPS ||
        a.y + a.sizeY + kerf <= b.y + EPS ||
        b.y + b.sizeY + kerf <= a.y + EPS;
      if (!apart) {
        problems.push(
          `sheet ${sheet.index}: ${a.partId}#${a.copy} ${show(a)} and ` +
            `${b.partId}#${b.copy} ${show(b)} are closer than the kerf ${kerf}`,
        );
      }
    }
  }
}

function checkTree(
  sheet: SheetLayout,
  usable: Rect,
  kerf: number,
  maxStages: number,
  problems: string[],
): void {
  const where = `sheet ${sheet.index}`;
  const seen = new Array<number>(sheet.placements.length).fill(0);
  const walk = (
    node: CutTree,
    expected: Rect,
    parentAxis: Axis | null,
    parentStage: number,
  ): void => {
    if (!rectNear(node.rect, expected)) {
      problems.push(`${where}: tree piece ${show(node.rect)}, expected ${show(expected)}`);
      return;
    }
    if (node.kind === 'part') {
      const p = sheet.placements[node.placement];
      if (!p) {
        problems.push(`${where}: tree names placement ${node.placement}, which does not exist`);
        return;
      }
      seen[node.placement]!++;
      if (!rectNear(p, expected)) {
        problems.push(`${where}: ${p.partId} ${show(p)} is not its tree piece ${show(expected)}`);
      }
      return;
    }
    if (node.kind !== 'cut') return;
    const stage = stageOf(node.axis, parentAxis, parentStage);
    if (node.stage !== stage) {
      problems.push(
        `${where}: cut at ${node.axis} = ${node.at} has stage ${node.stage}, not ${stage}`,
      );
    }
    if (stage > maxStages) {
      problems.push(`${where}: cut at ${node.axis} = ${node.at} is stage ${stage} of ${maxStages}`);
    }
    const r = expected;
    const start = node.axis === 'x' ? r.x : r.y;
    const end = node.axis === 'x' ? r.x + r.sizeX : r.y + r.sizeY;
    if (!(node.at > start + EPS && node.at < end - EPS)) {
      problems.push(`${where}: cut at ${node.axis} = ${node.at} is not inside ${show(r)}`);
      return;
    }
    const first: Rect =
      node.axis === 'x'
        ? { x: r.x, y: r.y, sizeX: node.at - r.x, sizeY: r.sizeY }
        : { x: r.x, y: r.y, sizeX: r.sizeX, sizeY: node.at - r.y };
    const rest = end - (node.at + kerf);
    walk(node.first, first, node.axis, stage);
    if (rest > EPS) {
      if (!node.second) {
        problems.push(`${where}: cut at ${node.axis} = ${node.at} lost its second piece`);
        return;
      }
      const second: Rect =
        node.axis === 'x'
          ? { x: node.at + kerf, y: r.y, sizeX: rest, sizeY: r.sizeY }
          : { x: r.x, y: node.at + kerf, sizeX: r.sizeX, sizeY: rest };
      walk(node.second, second, node.axis, stage);
    } else if (node.second) {
      problems.push(`${where}: cut at ${node.axis} = ${node.at} has a second piece past the edge`);
    }
  };
  walk(sheet.cutTree, usable, null, 0);
  seen.forEach((n, i) => {
    if (n !== 1) problems.push(`${where}: placement ${i} appears ${n} times in the cut tree`);
  });
}
