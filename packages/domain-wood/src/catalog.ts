// The stock catalog moved to the shared `@manufakture/stock` (ADR 0015 decision 1, T6.1a). This
// module re-exports it so `domain-wood`'s modules and its users keep their imports.

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
} from '@manufakture/stock';
