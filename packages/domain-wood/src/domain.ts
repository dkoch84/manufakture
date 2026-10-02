// The woodworking domain as regen registers it (ADR 0013 decisions 1 and 5): namespace `wood`,
// its extension types, and the readers of the two namespaces of document data it owns in M4
// (`wood` for settings, `stock` for stock overrides). The app's regen worker entry calls
// `registerWood(registry)` at start-up; regen imports no domain package.

import type { ExtensionDomain, ExtensionRegistry, ExtensionType } from '@manufakture/regen';
import { BOARD_TYPE, boardType } from './board';
import type { Json } from './migrations';
import { STOCK_DATA_VERSION, STOCK_NAMESPACE, readStockData } from './stock-data';
import { WOOD_DATA_VERSION, WOOD_NAMESPACE, readWoodData } from './wood-data';

/**
 * Bump with any change that can alter what a translator returns (a board's inputs or frame), so
 * results built by older domain code are never served from regen's cache (ADR 0004 decision 8).
 */
export const WOOD_IMPLEMENTATION = 1;

/** The domain definition: what `registerWood` registers. */
export const woodDomain: ExtensionDomain = {
  namespace: WOOD_NAMESPACE,
  implementation: WOOD_IMPLEMENTATION,
  // Boards read stock overrides. The settings (`wood`) are the domain's own namespace.
  reads: [STOCK_NAMESPACE],
  data: {
    [WOOD_NAMESPACE]: {
      schemaVersion: WOOD_DATA_VERSION,
      read: (data, schemaVersion) => readWoodData(data as Json, schemaVersion),
    },
    [STOCK_NAMESPACE]: {
      schemaVersion: STOCK_DATA_VERSION,
      read: (data, schemaVersion) => readStockData(data as Json, schemaVersion),
    },
  },
  types: { [BOARD_TYPE]: boardType as ExtensionType },
};

/** Register the woodworking domain on a regen registry. Returns a function that unregisters it. */
export function registerWood(registry: Pick<ExtensionRegistry, 'registerDomain'>): () => void {
  return registry.registerDomain(woodDomain);
}
