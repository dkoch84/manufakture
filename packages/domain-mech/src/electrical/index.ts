// The electrical system model (ADR 0017 decision 11, task T9.7a): core stores `mech.electrical`;
// `./model` reads it (each component's terminals, catalog part and instance, each connection's ends
// and wire, each harness segment's length, typed or measured between instances plus slack), lists
// what is wrong with it, and lays the path of the current each connection carries, which the
// simulation (T9.4b) fills and the electrical checks (T9.5f) and the power budget (T9.7c) read.
// Terminal ids are stable: schematic ports (T9.7d) link to them.

export {
  ROLE_DEFS,
  TERMINAL_KIND_TEXT,
  electricalSeries,
  roleTakesFamily,
  roleText,
  type CurrentMode,
  type DrawCurrent,
  type RoleDef,
  type SimulatedQuantity,
  type TerminalDef,
  type TerminalKind,
  type TerminalPart,
} from './model/roles';
export {
  MEASURED_LENGTH_ASSUMPTION,
  analyseElectrical,
  componentTerminals,
  electricalProblemText,
  electricalWarnings,
  type ComponentResult,
  type ConnectionResult,
  type ElectricalAnalysis,
  type ElectricalContext,
  type ElectricalProblem,
  type EndResult,
  type SegmentResult,
  type TerminalSource,
} from './model/system';
export {
  SIGNAL_ASSUMPTION,
  connectionCurrents,
  type CaseCurrent,
  type ConnectionCurrent,
  type CurrentContribution,
  type CurrentPath,
} from './model/currents';
export { electricalTemplateCommand, type ElectricalTemplateResult } from './model/template';
