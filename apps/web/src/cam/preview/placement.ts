// Where the preview goes (M5 plan, T5.3b): the WCS frame that puts machine coordinates on the
// part, and the stock box in machine coordinates, from the last generation or, before one, from
// the setup's resolved geometry.

import {
  wcsFrame,
  wcsOriginInSetup,
  type Box3,
  type Stock,
  type Wcs,
  type WcsFrame,
} from '@manufakture/cam';
import type { CamGeometryResult } from '@manufakture/regen';
import { stockOf } from '@manufakture/cam/export';
import type { GeneratedToolpaths } from './job';

/** A stock box (setup frame) in machine coordinates: less the WCS origin. */
export function stockInMachine(stock: Stock, wcs: Pick<Wcs, 'origin'>): Box3 {
  const o = wcsOriginInSetup(stock, wcs.origin);
  return {
    min: [stock.min[0] - o[0], stock.min[1] - o[1], stock.min[2] - o[2]],
    max: [stock.max[0] - o[0], stock.max[1] - o[1], stock.max[2] - o[2]],
  };
}

/** The frame and machine stock the preview places, from a generation or else the geometry. */
export function previewPlacement(
  data: GeneratedToolpaths | null,
  geometry: CamGeometryResult | null,
): { frame: WcsFrame; stock: Box3 } | null {
  if (data) {
    return { frame: data.setup.frame, stock: stockInMachine(data.setup.stock, data.setup.wcs) };
  }
  if (!geometry || geometry.status !== 'ok' || !geometry.setup) return null;
  const stock = stockOf(geometry);
  if (!stock.ok) return null;
  const wcs = { up: geometry.setup.wcs.up, origin: geometry.setup.wcs.origin };
  const frame = wcsFrame(wcs, stock.stock);
  if (!frame.ok) return null;
  return { frame: frame.value, stock: stockInMachine(stock.stock, wcs) };
}
