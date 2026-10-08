// @manufakture/stock: the shared stock catalog and the `stock` namespace (ADR 0013 decisions 1
// and 3, ADR 0015 decision 1). The catalog (`STOCK`, `findStock`), the document's stock overrides
// (`domains.stock`: schema, migrations, reader, writer, `resolveStock`), its data-only regen
// registration, and the small readers every domain uses for its versioned JSON. See README.md.

export const packageName = '@manufakture/stock';

export {
  PS20_BOARD_THICKNESS,
  PS20_BOARD_WIDTH,
  PS20_DIMENSION_THICKNESS,
  PS20_DIMENSION_WIDTH,
  STOCK,
  defaultRegion,
  findStock,
  inchLabel,
  inches,
  stockByRegion,
  type BoardFeetBasis,
  type StockCategory,
  type StockEntry,
  type StockKind,
  type StockRegion,
  type StockSize,
} from './catalog';
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
} from './stock-data';
export { STOCK_IMPLEMENTATION, registerStock, stockDomain } from './domain';
export { currentVersion, migrate, type Json, type Migration, type Versioned } from './migrations';
export {
  constantLength,
  fail,
  isObject,
  ok,
  onlyKeys,
  own,
  readConstantLength,
  readEnum,
  readId,
  readStoredExpression,
  type LengthOptions,
  type Path,
  type Read,
} from './read';
