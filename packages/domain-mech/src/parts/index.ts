// Purchased parts with ratings (ADR 0017 decision 7, task T9.2a): the family field schemas, the
// built-in catalog and how a reference resolves, typing values in, the CSV import, the placeholder
// feature, placing a part, the BOM lines and the tables agents read. See ../../README.md.

export {
  BUILTIN_ENTRIES,
  builtinRef,
  copyBuiltin,
  findBuiltin,
  latestBuiltin,
  latestBuiltins,
  refText,
  resolveEntry,
  type BuiltinEntry,
  type ResolvedEntry,
} from './catalog';
export {
  DIMENSION_NAMES,
  FAMILY_SCHEMAS,
  entryProblems,
  familySchema,
  hasBidiControl,
  migrateEntry,
  ratingField,
  type CatalogFamily,
  type DimensionField,
  type DimensionName,
  type FamilySchema,
  type FieldProblem,
  type RatingComparison,
  type RatingField,
  type RatingKind,
} from './families';
export {
  MAX_RATING_TEXT,
  bareLengthUnit,
  bareUnit,
  readDimension,
  readMass,
  readPhysical,
  readRating,
  type ReadValue,
} from './input';
export {
  ENTRY_FIELDS,
  columnProblem,
  entryFields,
  readEntryFields,
  type EntryField,
  type EntryProblem,
  type ReadEntryFields,
} from './entry';
export {
  CsvError,
  MAX_CSV_CHARS,
  MAX_CSV_COLUMNS,
  MAX_CSV_FIELD,
  MAX_CSV_PROBLEMS,
  MAX_CSV_ROWS,
  importCatalogCsv,
  nextEntryIds,
  parseCsv,
  problemText,
  type CsvImport,
  type CsvImportOptions,
  type CsvLimits,
  type CsvProblem,
  type CsvRecord,
} from './csv';
export {
  MAX_PLACEHOLDER_SIZE,
  PLACEHOLDER_EXPRESSIONS,
  PLACEHOLDER_SCHEMA_VERSION,
  PLACEHOLDER_SIZES,
  PLACEHOLDER_TYPE,
  entryShape,
  entrySizes,
  placeholderDrift,
  placeholderFeature,
  placeholderInput,
  placeholderType,
  readPlaceholderParams,
  type PlaceholderAxis,
  type PlaceholderKind,
  type PlaceholderMetadata,
  type PlaceholderParams,
} from './placeholder';
export {
  nextUseId,
  placePurchasedPart,
  stepBytes,
  uniqueName,
  type PlaceOptions,
  type Placed,
} from './place';
export {
  BOM_COLUMNS,
  PURCHASED_CATEGORY,
  PURCHASED_FLAGS,
  bomRatings,
  entryItem,
  purchasedBom,
  purchasedBomCsv,
  purchasedCsvLines,
  withPurchasedRows,
  type PurchasedBom,
  type PurchasedBomOptions,
} from './bom';
export { partsTables } from './tables';
