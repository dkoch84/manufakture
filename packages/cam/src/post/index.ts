// The post-processor engine (M5 plan, T5.4a; ADR 0014 decision 10): dialect records as data,
// number and comment formatting, Grbl's arc checks, and the modal G-code writer.

export {
  HEADER_ONLY_G_CODES,
  MAX_G64_P,
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
  postProcess,
  sagitta,
} from './writer';
export type { PostFile, PostJob, PostOptions, PostOutput, PostStats } from './writer';
