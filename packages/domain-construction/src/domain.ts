// The construction domain as regen registers it (ADR 0013 decisions 1 and 5, ADR 0015 decision 1):
// namespace `construction`, the reader of the document data it owns (`domains.construction`), and
// `reads: ['stock']` for the shared stock overrides, the wall and opening types (T6.1b) and the
// member stage that frames each wall with its openings (ADR 0015 decision 5). The floor and roof
// types (T6.1c) add themselves here. The app's regen worker entry calls
// `registerConstruction(registry)` at start-up; regen imports no domain package.

import type { ExtensionDomain, ExtensionRegistry, ExtensionType } from '@manufakture/regen';
import { STOCK_NAMESPACE, registerStock, type Json } from '@manufakture/stock';
import { CONSTRUCTION_DATA_VERSION, CONSTRUCTION_NAMESPACE, readConstructionData } from './data';
import { OPENING_TYPE, openingType } from './features/opening';
import { constructionMemberStage } from './features/stage';
import { WALL_TYPE, wallType } from './features/wall';

/**
 * Bump with any change that can alter what a translator or the member stage returns, so results
 * built by older domain code are never served from regen's cache (ADR 0004 decision 8).
 */
export const CONSTRUCTION_IMPLEMENTATION = 1;

/** The domain definition: what `registerConstruction` registers. */
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
  types: {
    [WALL_TYPE]: wallType as ExtensionType,
    [OPENING_TYPE]: openingType as ExtensionType,
  },
  members: constructionMemberStage,
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
