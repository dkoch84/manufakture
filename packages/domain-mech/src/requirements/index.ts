// Requirements, load cases and resistance modes (ADR 0017 decision 10, task T9.4a). Core stores
// them (`mech.requirements`, `mech.loadCases`); this module gives them meaning: the resistance
// laws in SI and their force against position and speed, the motion as segments and the duty
// cycle (sets, reps, rests), the problems with a requirement or a load case by field, the line
// that states a requirement, and the templates (cable trainer, winch, linear axis).

export {
  DAMPER_DIMENSION,
  RESISTANCE_MODES,
  RESISTANCE_MODE_TEXT,
  ROWING_DIMENSION,
  forceAt,
  forceCurves,
  interpolate,
  limitSpeed,
  resolveForceLaw,
  type CurvePoint,
  type CurveRange,
  type ForceCurves,
  type ForceLaw,
  type ResistanceModeKind,
} from './laws';
export {
  MAX_REPS,
  MAX_SESSION_SEGMENTS,
  MAX_SETS,
  dutyCycle,
  repSegments,
  resolveDynamic,
  segmentKinematics,
  sessionSegments,
  stateAt,
  type DutyCycle,
  type RepMotion,
  type ResolvedDynamic,
  type Segment,
  type SegmentPhase,
} from './motion';
export {
  REQUIREMENT_QUANTITY_TEXT,
  comparisonWords,
  itemProblemText,
  loadCaseProblems,
  quantityText,
  requirementProblems,
  requirementText,
} from './requirement';
export {
  MECH_TEMPLATES,
  mechTemplate,
  templateCommand,
  type MechTemplate,
  type MechTemplateId,
  type TemplateCommandResult,
} from './templates';
export { FieldReader, NO_VARIABLES, siValue, type ItemProblem, type SiResult } from './values';
