// The shapes of the checks framework (ADR 0017 decisions 5, 6 and 15; task T9.5a). A check
// gathers its inputs from the model (requirements, load cases, catalog entries, materials,
// overrides), from the simulation's envelopes and from measured geometry, hands them to a formula
// of `@manufakture/calc`, and gets a calc record back, which the framework wraps with where each
// input came from. Records are derived, recomputed from the document and never stored.

import type { CalcRecord, Given, RecordOptions } from '@manufakture/calc';
import type { CatalogRef, ManufaktureDocument, SubjectRef } from '@manufakture/core';
import type { PhysicalKind, Quantity } from '@manufakture/units';
import type { MechSettings } from '../settings';
import type { MeasuredGeometry } from './measured';
import type { SimulationEnvelopes, SimulationStatistic } from './simulation';

/** Where one input of a record came from (ADR 0017 decision 5). */
export type InputRef =
  | { kind: 'requirement'; id: string }
  | { kind: 'catalog'; entry: CatalogRef; field: string; derivation?: string }
  | { kind: 'material'; id: string; property: string }
  | {
      kind: 'measured';
      what: 'mass' | 'inertia' | 'area' | 'distance' | 'section';
      subject: SubjectRef;
    }
  | { kind: 'simulation'; loadCase: string; series: string; statistic: SimulationStatistic }
  | { kind: 'setting'; key: string }
  | { kind: 'override'; id: string }
  | { kind: 'record'; id: string }
  | { kind: 'given' };

/**
 * A calc record with the domain's provenance: which check made it, what it is about, the load
 * case that governs, and where each input came from, by the input's symbol. Its id is
 * `<check>@<location>`, stable across regens while the subject exists.
 */
export interface MechRecord extends CalcRecord {
  check: string;
  subject: SubjectRef[];
  loadCase?: string;
  inputRefs: Record<string, InputRef>;
}

/** Which of the user's factors a check compares with. */
export type CheckFactorKind = 'strength' | 'fatigue';

/** One input a check gathered, before overrides. */
export interface CheckInput {
  /** For people, as a missing input is named: "Peak cable tension". */
  name: string;
  /** SI; undefined when the model does not give it (then `missing` says why). */
  value: number | undefined;
  /** Where it came from, in words. */
  source: string;
  ref: InputRef;
  /** How an override's expression for this input is read. */
  kind: PhysicalKind | 'number';
  /** Why there is no value, naming what would give one: "no simulation of lc#1 has run". */
  missing?: string;
  /** The record can be computed without it (a refinement); a missing one is not reported. */
  optional?: boolean;
}

/** One record a check will make: its subject and its gathered inputs. */
export interface CheckSubject {
  /** After the `@` of the record id: `pp#3/lc#1`. */
  location: string;
  /** For people: "Cable tension, Dyneema 3 mm in Rep". */
  title: string;
  subject: SubjectRef[];
  /** The load case this record is for, when one governs. */
  loadCase?: string;
  /** By symbol; the keys are what overrides name in `CheckOverride.inputs`. */
  inputs: Record<string, CheckInput>;
}

/** Everything a check reads. Plain data plus the two lookups. */
export interface CheckModel {
  document: ManufaktureDocument;
  settings: MechSettings;
  /** The document's variables, in internal units. */
  variables: ReadonlyMap<string, Quantity>;
  /** The simulation's envelopes (T9.4b); until it runs, every lookup is empty. */
  simulation: SimulationEnvelopes;
  /** What regen measured for the checks' `measures`. */
  measured: MeasuredGeometry;
}

/** A body a check needs measured. */
export interface BodyNeed {
  part: string;
  body: string;
}

/** What a check's compute function is given. */
export interface CheckCompute {
  /** Every input by symbol, overrides applied, with its source; a missing one has no value. */
  inputs: Readonly<Record<string, Given>>;
  /** The user's factor for this check, when one applies. */
  factor: Given | undefined;
  /** Text inputs from overrides by symbol: a fit class, `thread-locker`. */
  texts: Readonly<Record<string, string>>;
  /** The record's id and title, to pass to the calc function. */
  options: Required<RecordOptions>;
}

/**
 * One check. Pure: the same model gives the same records. `version` keys its cached records, so
 * bump it whenever what `subjects` or `compute` gives can change.
 */
export interface CheckDefinition {
  /** Stable: `cable.tension`, `shaft.fatigue`; its family is the part before the last dot. */
  id: string;
  title: string;
  version: number;
  /** The user's factor it compares with; absent: it states a value with no factor. */
  factor?: CheckFactorKind;
  /** Bodies it needs measured (volume, area, centre of mass, inertia). */
  measures?(model: CheckModel): readonly BodyNeed[];
  /** The records it makes in this model, each with its gathered inputs. */
  subjects(model: CheckModel): readonly CheckSubject[];
  /** One record from the inputs, through a `@manufakture/calc` function. */
  compute(given: CheckCompute): CalcRecord;
}
