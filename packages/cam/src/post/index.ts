// The post-processor engine (M5 plan, T5.4a; ADR 0014 decision 10): dialect records as data,
// number and comment formatting, Grbl's arc checks, and the modal G-code writer; and the posts
// built on it (T5.4b: Grbl 1.1).

export {
  DEFAULT_MAX_TOOL_NUMBER,
  HEADER_ONLY_G_CODES,
  MAX_G64_P,
  MODAL_GROUPS,
  REQUIRED_G_CODES,
  TEMPLATE_G_CODES,
  TEMPLATE_M_CODES,
  TEMPLATE_SECTIONS,
  TEMPLATE_VARIABLES,
  TOOL_CHANGE_STYLES,
  compileDialect,
  isCompiledDialect,
  normalizeCode,
} from './dialect';
export type {
  CompiledDialect,
  Dialect,
  DialectDecimals,
  DialectTemplates,
  PostUnits,
  TemplateSection,
  ToolChangeStyle,
  UnitDecimals,
  VariableKind,
} from './dialect';
export {
  MAX_DECIMALS,
  MAX_NUMBER_DIGITS,
  commentLines,
  formatNumber,
  isCommentCommand,
  grblReadFloat,
  sanitizeComment,
} from './format';
// Grbl's own constants stay in `grbl-arc.ts`: the offset engine exports constants of the same
// names (`offset/tolerances.ts`), and `grblRadiusAllowance` states the rule.
export {
  GRBL_CHECK_OFFSETS,
  RADIUS_MARGIN,
  TRAVEL_TOLERANCE,
  grblArcCheck,
  grblRadiusAllowance,
} from './grbl-arc';
export type { GrblArcCheck, GrblArcInput } from './grbl-arc';
export {
  DEFAULT_POST_TOLERANCE,
  LINE_SAGITTA_FRACTION,
  MAX_ARC_SEGMENTS,
  MIN_ARC_CHORD_STEPS,
  MIN_ARC_RADIUS_STEPS,
  dialComment,
  postProcess,
  sagitta,
} from './writer';
export type { DialSetting, PostFile, PostJob, PostOptions, PostOutput, PostStats } from './writer';
export { GRBL, GRBL_DIALECT, postGrbl } from './grbl';
export type { GrblMultiTool, GrblOptions } from './grbl';
export { FALLBACK_FILE_STEM, GCODE_FILE_EXTENSION, postFileStem } from './naming';
