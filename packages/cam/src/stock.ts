// Stock boxes in the setup frame (M5 plan, T5.1c): from the body's bounds plus margins, or an
// explicit size placed around the body.

import { err, ok } from './types';
import type { Box3, CamResult, Stock, StockMargins, Vec3 } from './types';
import { isFiniteVec } from './vec';

/** The same margin on every side, and separate ones above and below. */
export function uniformMargins(side: number, top = side, bottom = 0): StockMargins {
  return { xMin: side, xMax: side, yMin: side, yMax: side, top, bottom };
}

/**
 * Stock from the body's bounds in the setup frame (`boundsInSetup`) grown by the margins. Every
 * margin must be finite and zero or more.
 */
export function stockFromBounds(
  body: Box3,
  margins: StockMargins,
  material?: string,
): CamResult<Stock> {
  const bad = checkBox(body);
  if (bad) return bad;
  for (const [name, v] of Object.entries(margins)) {
    if (!Number.isFinite(v) || v < 0) {
      return err('invalid-input', `The stock margin ${name} must be zero or more.`);
    }
  }
  return ok({
    min: [body.min[0] - margins.xMin, body.min[1] - margins.yMin, body.min[2] - margins.bottom],
    max: [body.max[0] + margins.xMax, body.max[1] + margins.yMax, body.max[2] + margins.top],
    ...(material !== undefined ? { material } : {}),
  });
}

/**
 * Stock of an explicit size, placed so the body's bounds' minimum corner sits `offset` in from
 * the stock's minimum corner (front, left, bottom in the setup frame). The stock must contain the
 * body (within 1e-9 mm), or the result is a `stock-too-small` error naming the axis.
 */
export function stockFromSize(
  body: Box3,
  size: Vec3,
  offset: Vec3,
  material?: string,
): CamResult<Stock> {
  const bad = checkBox(body);
  if (bad) return bad;
  if (!isFiniteVec(size) || size.some((v) => !(v > 0))) {
    return err('invalid-input', 'The stock size must be greater than zero on every axis.');
  }
  if (!isFiniteVec(offset)) return err('invalid-input', 'The stock offset must be finite.');
  const min: Vec3 = [body.min[0] - offset[0], body.min[1] - offset[1], body.min[2] - offset[2]];
  const max: Vec3 = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
  const eps = 1e-9;
  for (let i = 0; i < 3; i++) {
    if (min[i]! > body.min[i]! + eps || max[i]! < body.max[i]! - eps) {
      return err('stock-too-small', `The stock does not contain the body along ${'XYZ'[i]}.`);
    }
  }
  return ok({ min, max, ...(material !== undefined ? { material } : {}) });
}

/** The stock's size along X, Y and Z. */
export function stockSize(stock: Stock): Vec3 {
  return [stock.max[0] - stock.min[0], stock.max[1] - stock.min[1], stock.max[2] - stock.min[2]];
}

function checkBox(box: Box3): CamResult<never> | undefined {
  if (!isFiniteVec(box.min) || !isFiniteVec(box.max)) {
    return err('invalid-input', 'The body bounds must be finite.');
  }
  if (box.min.some((v, i) => v > box.max[i]!)) {
    return err('invalid-input', 'The body bounds are inverted.');
  }
  return undefined;
}
