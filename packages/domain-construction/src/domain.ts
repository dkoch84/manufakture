// The construction domain as regen registers it (ADR 0013 decisions 1 and 5, ADR 0015 decision 1):
// namespace `construction`, the reader of the document data it owns (`domains.construction`), and
// `reads: ['stock']` for the shared stock overrides. Data only for now: the wall, opening, floor
// and roof types (T6.1b, T6.1c) and the member stage add themselves here. The app's regen worker
// entry calls `registerConstruction(registry)` at start-up; regen imports no domain package.

import type { ExtensionDomain, ExtensionRegistry } from '@manufakture/regen';
import { STOCK_NAMESPACE, registerStock, type Json } from '@manufakture/stock';
import { CONSTRUCTION_DATA_VERSION, CONSTRUCTION_NAMESPACE, readConstructionData } from './data';

/**
 * Bump with any change that can alter what a translator or the member stage returns, so results
 * built by older domain code are never served from regen's cache (ADR 0004 decision 8).
 */
export const CONSTRUCTION_IMPLEMENTATION = 1;

/** The domain definition: what `registerConstruction` registers. `types` is optional in regen. */
export const constructionDomain: ExtensionDomain = {
  namespace: CONSTRUCTION_NAMESPACE,
  implementation: CONSTRUCTION_IMPLEMENTATION,
  reads: [STOCK_NAMESPACE],
  data: {
    [CONSTRUCTION_NAMESPACE]: {
      schemaVersion: CONSTRUCTION_DATA_VERSION,
      read: (data, schemaVersion) => readConstructionData(data as Json, schemaVersion),
    },
  },
};

/**
 * Register the construction domain on a regen registry, and the shared stock reader unless it is
 * already there. Returns a function that unregisters the construction domain; the stock reader
 * stays, since other domains may read `stock` too.
 */
export function registerConstruction(
  registry: Pick<ExtensionRegistry, 'registerDomain' | 'reader'>,
): () => void {
  registerStock(registry);
  return registry.registerDomain(constructionDomain);
}
