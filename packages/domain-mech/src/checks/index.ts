// The checks framework (ADR 0017 decisions 5, 6 and 15; task T9.5a): the check registry and its
// runner, check overrides, measured geometry and the simulation's envelopes as inputs, the
// wording of a record, the regen evaluation stage, and the sample check `cable.tension`.

export { CABLE_TENSION_CHECK, CABLE_TENSION_SERIES, cableTension } from './cable';
export {
  MECH_EVALUATION_VERSION,
  builtinChecks,
  checkModel,
  createMechEvaluation,
  mechEvaluationOf,
  type MechEvaluation,
  type MechEvaluationOptions,
} from './evaluation';
export { stableKey } from './key';
export {
  NOTHING_MEASURED,
  measuredFrom,
  measuredMassInput,
  type MeasuredBody,
  type MeasuredGeometry,
} from './measured';
export {
  applyInputOverrides,
  overrideCovers,
  overridesFor,
  resolveFactor,
  sameSubject,
  type ResolvedFactor,
} from './overrides';
export {
  CHECK_ID,
  CheckRegistry,
  RecordCache,
  recordId,
  runChecks,
  type CheckEntry,
  type CheckRun,
} from './registry';
export {
  NO_SIMULATION,
  simulationFrom,
  simulationInput,
  type SimulationEnvelopes,
  type SimulationState,
  type SimulationStatistic,
} from './simulation';
export type {
  BodyNeed,
  CheckCompute,
  CheckDefinition,
  CheckFactorKind,
  CheckInput,
  CheckModel,
  CheckSubject,
  InputRef,
  MechRecord,
} from './types';
export { comparisonText, formatSI, inputsText, recordText, statusLabel } from './wording';
