// What the feature tree and the toolbar need to know about woodworking features, apart from the
// board tool's logic (boards.ts), which loads with its dialog: whether a feature is a board, the
// domain's label for it and the stock it is cut from.

import type { ExtensionFeature, Feature } from '@manufakture/core';
import { BOARD_TYPE, findStock } from '@manufakture/domain-wood';

/** Whether a feature is a board (`wood.board`). */
export function isBoard(feature: Feature): feature is ExtensionFeature {
  return feature.kind === 'extension' && feature.extension === BOARD_TYPE;
}

/** The domain's name for an extension feature's type ("Board"), or null for an unknown type. */
export function extensionLabel(feature: Feature): string | null {
  return isBoard(feature) ? 'Board' : null;
}

/** The stock a board is cut from, as the tree shows it (`2x4`), or null. */
export function boardStockName(feature: Feature): string | null {
  if (!isBoard(feature)) return null;
  const stock = feature.params.stock;
  if (typeof stock !== 'string') return null;
  return findStock(stock)?.name ?? stock;
}
