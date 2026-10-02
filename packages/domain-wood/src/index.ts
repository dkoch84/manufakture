// @manufakture/domain-wood: the woodworking domain (ADR 0013). The stock catalog, the board
// feature (`wood.board`) and its translator, and the document data the domain owns
// (`domains.wood`, `domains.stock`). See README.md.

export const packageName = '@manufakture/domain-wood';

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
  BOARD_EXPRESSIONS,
  BOARD_PARAMS,
  BOARD_SCHEMA_VERSION,
  BOARD_TYPE,
  JUSTIFY,
  MAX_REGION_ENTITIES,
  boardType,
  readBoardMetadata,
  readBoardParams,
  translateBoard,
  type BoardFrame,
  type BoardMetadata,
  type BoardParams,
  type GrainSpec,
  type Justify,
  type PanelParams,
  type StickParams,
} from './board';
export {
  EMPTY_STOCK_DATA,
  MAX_STOCK_OVERRIDES,
  PRICE_UNITS,
  STOCK_DATA,
  STOCK_DATA_VERSION,
  STOCK_NAMESPACE,
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
export {
  DEFAULT_WOOD_SETTINGS,
  MAX_STAGES,
  WOOD_DATA,
  WOOD_DATA_VERSION,
  WOOD_NAMESPACE,
  readWoodData,
  woodSettings,
  writeWoodData,
  type GrainRule,
  type SheetTrimSettings,
  type StoredWoodSettings,
  type WoodData,
  type WoodSettings,
} from './wood-data';
export { WOOD_IMPLEMENTATION, registerWood, woodDomain } from './domain';
export { currentVersion, migrate, type Json, type Migration, type Versioned } from './migrations';
export { constantLength, type Path, type Read } from './read';
