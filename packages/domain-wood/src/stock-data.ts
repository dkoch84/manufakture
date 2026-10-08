// `domains.stock` moved to the shared `@manufakture/stock`, which now owns the namespace (ADR 0015
// decision 1, T6.1a). This module re-exports it so `domain-wood`'s modules and its users keep
// their imports.

export {
  EMPTY_STOCK_DATA,
  MAX_STOCK_OVERRIDES,
  PRICE_UNITS,
  STOCK_DATA,
  STOCK_DATA_VERSION,
  STOCK_NAMESPACE,
  documentStock,
  readStockData,
  resolveStock,
  writeStockData,
  type Price,
  type PriceUnit,
  type ResolvedStock,
  type StockData,
  type StockOverride,
  type StoredStockOverride,
} from '@manufakture/stock';
