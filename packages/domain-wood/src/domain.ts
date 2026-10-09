// The woodworking domain as regen registers it (ADR 0013 decisions 1 and 5): namespace `wood`,
// its extension types (`wood.board`, `wood.joint`, `wood.slide`), and the reader of the document
// data it owns (`wood`, its settings). It reads `stock` (stock overrides), which the shared
// `@manufakture/stock` owns since T6.1a (ADR 0015 decision 1). The app's regen worker entry calls
// `registerWood(registry)` at start-up; regen imports no domain package.

import type { ExtensionDomain, ExtensionRegistry, ExtensionType } from '@manufakture/regen';
import { STOCK_NAMESPACE, registerStock } from '@manufakture/stock';
import { BOARD_TYPE, boardType } from './board';
import { JOINT_TYPE, jointType } from './joints';
import type { Json } from './migrations';
import { SLIDE_TYPE, slideType } from './slides';
import { WOOD_DATA_VERSION, WOOD_NAMESPACE, readWoodData } from './wood-data';

/**
 * Bump with any change that can alter what a translator returns (a board's inputs or frame), so
 * results built by older domain code are never served from regen's cache (ADR 0004 decision 8).
 * 2: joints set `keySplits`, so board faces they split are named after the joint's faces (#1207).
 */
export const WOOD_IMPLEMENTATION = 2;

/** The domain definition: what `registerWood` registers. */
export const woodDomain: ExtensionDomain = {
  namespace: WOOD_NAMESPACE,
  implementation: WOOD_IMPLEMENTATION,
  // Boards read stock overrides, owned by `@manufakture/stock`. The settings (`wood`) are the
  // domain's own namespace.
  reads: [STOCK_NAMESPACE],
  data: {
    [WOOD_NAMESPACE]: {
      schemaVersion: WOOD_DATA_VERSION,
      read: (data, schemaVersion) => readWoodData(data as Json, schemaVersion),
    },
  },
  types: {
    [BOARD_TYPE]: boardType as ExtensionType,
    [JOINT_TYPE]: jointType as ExtensionType,
    [SLIDE_TYPE]: slideType as ExtensionType,
  },
};

/**
 * Register the woodworking domain on a regen registry, and the shared stock reader unless it is
 * already there (`registerStock`). Returns a function that unregisters the woodworking domain; the
 * stock reader stays, since other domains may read `stock` too.
 */
export function registerWood(
  registry: Pick<ExtensionRegistry, 'registerDomain' | 'reader'>,
): () => void {
  registerStock(registry);
  return registry.registerDomain(woodDomain);
}
