// The `stock` namespace as regen registers it (ADR 0015 decision 1): a data-only domain, with the
// reader of `domains.stock` and no extension types. Every domain that reads stock (`wood`,
// `construction`) declares `reads: ['stock']`; regen reads the namespace through this owner.
//
// `registerStock` is idempotent: the app's regen worker entry calls it next to the domains, and a
// domain's own `register...` calls it too, so a registry that has a domain reading `stock` always
// has its reader, whatever the order.

import type { ExtensionDomain, ExtensionRegistry } from '@manufakture/regen';
import type { Json } from './migrations';
import { STOCK_DATA_VERSION, STOCK_NAMESPACE, readStockData } from './stock-data';

/**
 * Bump with any change that can alter what the reader returns for the same stored data. Stock has
 * no translators, so this keys nothing yet; regen requires one per domain.
 */
export const STOCK_IMPLEMENTATION = 1;

/** The data-only domain that owns `domains.stock`. */
export const stockDomain: ExtensionDomain = {
  namespace: STOCK_NAMESPACE,
  implementation: STOCK_IMPLEMENTATION,
  data: {
    [STOCK_NAMESPACE]: {
      schemaVersion: STOCK_DATA_VERSION,
      read: (data, schemaVersion) => readStockData(data as Json, schemaVersion),
    },
  },
};

/**
 * Register the stock reader on a regen registry unless some domain already owns `stock`. Returns
 * a function that unregisters it, or does nothing when it was already there.
 */
export function registerStock(
  registry: Pick<ExtensionRegistry, 'registerDomain' | 'reader'>,
): () => void {
  if (registry.reader(STOCK_NAMESPACE) !== undefined) return () => {};
  return registry.registerDomain(stockDomain);
}
