// The build plate an export writes (M3 plan, T3.3b): every copy of every item packed in rows
// inside the printer's usable area, clear of its excluded areas (the X1 Carbon's corner at the bed
// origin, 0 to 18 by 0 to 28 mm). Not the workspace's preview row (`resolve.ts`), which is one
// line across the bed and may run off it by design.
//
// Shelf packing, in the order the items are listed and copies within them: a row starts at the
// front left of the usable area, each copy goes right of the one before with `COPY_GAP` between
// them, a copy that would overlap an excluded area moves right to its edge, and a copy that no
// longer fits the row starts the next one behind it, as deep as the row's deepest copy plus the
// gap (a row with nothing in it yet moves back past the excluded area that blocked it).
// Copies keep `gap` clear of the excluded areas too when they can, since slicers flag parts very
// close to an excluded area (OrcaSlicer's CLI refuses geometry on or over one as "too close to
// exclusion area", spike T3.0a). When that leaves a copy unplaced the plate is packed again with
// no clearance from the excluded areas (copies still `gap` apart), so a part that fits the bed
// only close to an excluded area (a 236 x 226 mm part on an X1 Carbon) still exports;
// `nearExcluded` then names the copies that sit that close.
// When the copies do not all fit, the rest overflow: the export writes one plate (3MF as
// written here has no plates, io README) and refuses rather than put copies off the bed. Then
// the packed block is moved to the middle of the area when every copy still fits there, so the
// file opens in a sane place; the slicer arranges the plate for real anyway.
//
// Copies are never turned on the bed to fit better: each keeps its item's orientation.

import { checkBedFit, usableRegion, type Printer } from '@manufakture/print';
import type { BoundingBox } from '@manufakture/kernel';
import { COPY_GAP } from './resolve';

/** One copy to place: its footprint (x and y size, mm) and the nozzles it is printed with. */
export interface PlateCopy {
  width: number;
  depth: number;
  /** Two-nozzle printers: the nozzles (indices) it needs; absent: the whole printable area. */
  nozzles?: readonly number[];
}

export interface PackedPlate {
  /** Front left corner (bed x, y) of each copy that fits, by index in the input; null: overflow. */
  spots: ([number, number] | null)[];
  /** How many copies did not fit. */
  overflow: number;
  /**
   * The placed copies (indices) closer than `gap` to an excluded area, when the plate had to be
   * packed with no clearance from them; empty otherwise.
   */
  nearExcluded: number[];
}

/** The least step right when an excluded area blocks a spot, mm. */
const STEP = 1e-6;
/** Rounding allowed at the area's edges, mm (well inside the bed-fit tolerance). */
const EDGE = 1e-9;

/**
 * Pack `copies` onto `printer`'s plate, `gap` mm apart and `gap` clear of the excluded areas; when
 * that leaves a copy unplaced, packed again with no clearance from the excluded areas, and the
 * packing that places more copies is kept.
 */
export function packPlate(
  printer: Printer,
  copies: readonly PlateCopy[],
  gap: number = COPY_GAP,
): PackedPlate {
  const clear = pack(printer, copies, gap, gap);
  if (clear.overflow === 0 || printer.excluded.length === 0) return clear;
  const tight = pack(printer, copies, gap, 0);
  return tight.overflow < clear.overflow ? tight : clear;
}

/** One packing, `gap` mm between copies and `clearance` mm clear of the excluded areas. */
function pack(
  printer: Printer,
  copies: readonly PlateCopy[],
  gap: number,
  clearance: number,
): PackedPlate {
  // One region for every copy: the area the nozzles of all of them share (the whole printable
  // area on a single-nozzle printer), so the rows have straight edges. Deliberately conservative
  // on a two-nozzle printer: a one-colour copy could use more of the bed than the shared area.
  const nozzles = [...new Set(copies.flatMap((c) => c.nozzles ?? []))];
  const region = usableRegion(printer, nozzles.length > 0 ? nozzles : undefined);
  const spots: ([number, number] | null)[] = copies.map(() => null);
  if (region.area.length === 0) return { spots, overflow: copies.length, nearExcluded: [] };
  const xs = region.area.map((p) => p[0]);
  const ys = region.area.map((p) => p[1]);
  const lo: [number, number] = [Math.min(...xs), Math.min(...ys)];
  const hi: [number, number] = [Math.max(...xs), Math.max(...ys)];
  const withNozzles = nozzles.length > 0 ? { nozzles } : {};
  // The excluded areas the box grown by `by` overlaps.
  const near = (c: PlateCopy, x: number, y: number, by: number) => {
    const grown = box(x - by, y - by, { width: c.width + 2 * by, depth: c.depth + 2 * by });
    return checkBedFit(printer, { box: grown, ...withNozzles }).exclusions;
  };
  // In the region, and `clearance` clear of every excluded area.
  const fits = (c: PlateCopy, x: number, y: number) => {
    const fit = checkBedFit(printer, { box: box(x, y, c), ...withNozzles });
    const exclusions = clearance > 0 ? near(c, x, y, clearance) : fit.exclusions;
    return { fits: fit.fits && exclusions.length === 0, exclusions };
  };

  let x = lo[0];
  let y = lo[1];
  let rowDepth = 0;
  // The nearest back edge of an excluded area that blocked a copy in this row.
  let blockedTo = Infinity;
  let full = false;
  let overflow = 0;
  const nextRow = () => {
    // Behind the row's deepest copy; an empty row moves the gap past what blocked it.
    y = rowDepth > 0 ? y + rowDepth + gap : Number.isFinite(blockedTo) ? blockedTo : hi[1] + 1;
    x = lo[0];
    rowDepth = 0;
    blockedTo = Infinity;
  };
  for (const [i, c] of copies.entries()) {
    if (full) {
      overflow++;
      continue;
    }
    for (;;) {
      if (y + c.depth > hi[1] + EDGE) {
        full = true;
        break;
      }
      if (x + c.width > hi[0] + EDGE) {
        if (x === lo[0]) break; // wider than the area: it fits nowhere
        nextRow();
        continue;
      }
      const fit = fits(c, x, y);
      if (fit.fits) {
        spots[i] = [x, y];
        x += c.width + gap;
        rowDepth = Math.max(rowDepth, c.depth);
        break;
      }
      if (fit.exclusions.length === 0) {
        // Outside the region some other way (a corner of a non-rectangular area): next row.
        x = hi[0] + 1;
        continue;
      }
      // Overlapping an excluded area, or closer to it than the clearance: that far past its right.
      for (const e of fit.exclusions) {
        blockedTo = Math.min(blockedTo, Math.max(...e.polygon.map((p) => p[1])) + clearance);
      }
      const past = fit.exclusions.map((e) => Math.max(...e.polygon.map((p) => p[0])) + clearance);
      x = Math.max(x + STEP, ...past);
    }
    if (spots[i] === null) overflow++;
  }
  centre(spots, copies, lo, hi, fits);
  const nearExcluded = spots.flatMap((s, i) =>
    s !== null && near(copies[i]!, s[0], s[1], gap).length > 0 ? [i] : [],
  );
  return { spots, overflow, nearExcluded };
}

function box(x: number, y: number, c: PlateCopy): BoundingBox {
  return { min: [x, y, 0], max: [x + c.width, y + c.depth, 0] };
}

/** Move every placed copy so the block is in the middle, when they all still fit there. */
function centre(
  spots: ([number, number] | null)[],
  copies: readonly PlateCopy[],
  lo: [number, number],
  hi: [number, number],
  fits: (c: PlateCopy, x: number, y: number) => { fits: boolean },
): void {
  const placed = spots.flatMap((s, i) => (s ? [{ s, c: copies[i]! }] : []));
  if (placed.length === 0) return;
  const minX = Math.min(...placed.map((p) => p.s[0]));
  const minY = Math.min(...placed.map((p) => p.s[1]));
  const maxX = Math.max(...placed.map((p) => p.s[0] + p.c.width));
  const maxY = Math.max(...placed.map((p) => p.s[1] + p.c.depth));
  const dx = (lo[0] + hi[0] - (minX + maxX)) / 2;
  const dy = (lo[1] + hi[1] - (minY + maxY)) / 2;
  // Both ways, then only one way, then not at all.
  for (const [mx, my] of [
    [dx, dy],
    [dx, 0],
    [0, dy],
  ] as const) {
    if (placed.every((p) => fits(p.c, p.s[0] + mx, p.s[1] + my).fits)) {
      for (const p of placed) {
        p.s[0] += mx;
        p.s[1] += my;
      }
      return;
    }
  }
}
