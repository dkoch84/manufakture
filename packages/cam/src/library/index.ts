// The tool library, feed presets and machine profiles (T5.1d). Also `@manufakture/cam/library`, so
// the app's library store loads this data without the rest of the package.

export {
  TOOL_LIBRARY_FORMAT,
  TOOL_LIBRARY_VERSION,
  type FeedCategory,
  type LibraryPreset,
  type LibraryTool,
  type LibraryUnit,
  type MachineFirmware,
  type MachineProfile,
  type PresetVerified,
  type Sourced,
  type SpindleKind,
  type SpindleProfile,
  type ToolLibraryFile,
  type ToolVendor,
} from './types';
export {
  FEED_CATEGORIES,
  MATERIAL_FEED_CATEGORY,
  chipLoadFromFeed,
  feedCategoryOf,
  feedFromChipLoad,
  findFeedCategory,
  findPresetFor,
  resolvePreset,
  toMm,
  unitScale,
  type ResolvedPreset,
} from './feeds';
export {
  BUILTIN_LIBRARY_ID,
  BUILTIN_TOOLS,
  CHART_URL,
  findBuiltinTool,
  unverifiedToolFields,
} from './tools';
export {
  COMPACT_ROUTER_DIAL,
  DEFAULT_MACHINE_ID,
  MACHINES,
  SPINDLES,
  defaultPost,
  findMachine,
  findSpindle,
  machineDial,
  unverifiedMachineFields,
} from './machines';
export {
  LIBRARY_ID_PATTERN,
  LIBRARY_LIMITS,
  LIBRARY_MINIMUMS,
  parseToolLibrary,
  serializeToolLibrary,
  validateLibraryTool,
  validateMachine,
  validateToolLibraryFile,
} from './validate';
export {
  libraryToolToCamTool,
  libraryToolToTool,
  type CamFeedPresetData,
  type CamToolData,
  type ToolExpression,
} from './convert';
