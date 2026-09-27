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
  checkDocument,
  expressionReferences,
  expressionVariableNames,
  validateDocument,
  variableOrder,
} from './validate';
export {
  CommandSchema,
  MAX_DOCUMENT_NAME,
  SimpleCommandSchema,
  applyCommand,
  variableUsers,
  type Applied,
  type BatchCommand,
  type Command,
  type CommandType,
  type SimpleCommand,
} from './commands';
export {
  inlineVariable,
  renameVariable,
  rewriteReferences,
  variableUses,
  type VariableUse,
} from './variables';
export { diffDocuments, type DocumentChange, type PartChange } from './changes';
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
