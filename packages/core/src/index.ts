export const packageName = '@manufakture/core';

export * from './schema';
export * from './result';
export * from './ids';
export * from './features';
export * from './document';
export {
  MATERIALS,
  MATERIAL_IDS,
  findMaterial,
  massGrams,
  type Material,
  type MaterialCategory,
  type MaterialId,
} from './materials';
export {
  bodyCreationProblem,
  checkDocument,
  expressionReferences,
  expressionVariableNames,
  validateDocument,
  variableOrder,
} from './validate';
export {
  CommandSchema,
  MAX_ASSEMBLY_NAME,
  MAX_DOCUMENT_NAME,
  MAX_DRAWING_NAME,
  MAX_PART_NAME,
  MAX_PRINT_SETUP_NAME,
  PART_ID_PATTERN,
  SimpleCommandSchema,
  applyCommand,
  assemblyViews,
  explodedViewViews,
  fontUsers,
  instanceDimensions,
  partInstances,
  partParameters,
  partPrintItems,
  partViews,
  restoredDocument,
  rowInstances,
  variableDrawings,
  variableExplodedViews,
  variableMates,
  variableParameters,
  variablePrintSetups,
  variableUsers,
  type Applied,
  type BatchCommand,
  type Command,
  type CommandType,
  type SimpleCommand,
} from './commands';
export {
  drawingVariableUses,
  inlineVariable,
  renameVariable,
  rewriteReferences,
  variableUses,
  type DrawingVariableUse,
  type VariableUse,
} from './variables';
export {
  applyConfigurationRow,
  configurationRow,
  configured,
  configuredVariables,
  emptyConfigurations,
} from './configurations';
export {
  diffDocuments,
  type AssemblyChange,
  type DocumentChange,
  type DrawingsChange,
  type ItemChanges,
  type PartChange,
  type PrintChange,
} from './changes';
export {
  DocumentStore,
  type ChangeCause,
  type ChangeEvent,
  type ChangeListener,
  type HistoryEntry,
  type StoreOptions,
} from './store';
export {
  FORMAT_MIGRATIONS,
  NAMING_MIGRATIONS,
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateV8ToV9,
  migrateV9ToV10,
  migrateV10ToV11,
  migrateV11ToV12,
  type JsonObject,
  type Migration,
} from './migrations';
export {
  deserialize,
  migrateJson,
  parseDocument,
  serialize,
  type Loaded,
  type MigrationOptions,
} from './format';
