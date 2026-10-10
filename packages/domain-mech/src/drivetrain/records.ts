// The calc records of a drivetrain (ADR 0017 decision 9, M9 plan decision 4): the overall ratio,
// the overall efficiency, and the inertia reflected to the motor and to the output, each with every
// input and where it came from. A record whose inputs are missing is `unknown` and names them; one
// that counts an element as zero because nothing gives its inertia says so in its assumptions.
// These are values, not checks: no factor, no limit, nothing called safe.

import type { CalcInput, CalcSource, CalcValue } from '@manufakture/calc';
import type { SubjectRef } from '@manufakture/core';
import type { InputRef, MechRecord } from '../checks/types';
import type { DrivetrainChain, InertiaElement } from './chain';

export const DRIVETRAIN_RATIO = 'drivetrain.ratio';
export const DRIVETRAIN_EFFICIENCY = 'drivetrain.efficiency';
export const DRIVETRAIN_INERTIA = 'drivetrain.inertia';
export const DRIVETRAIN_INERTIA_OUTPUT = 'drivetrain.inertia-output';

/** The unit of a moment of inertia in records. */
export const INERTIA_UNIT = 'kg·m^2';

/** Where the train value comes from (the same edition `@manufakture/calc` cites). */
const GEAR_TRAINS: CalcSource = {
  title: "Budynas and Nisbett, Shigley's Mechanical Engineering Design, 10th ed. (2015)",
  locator: 'Sec. 13-13, gear trains: the train value is the product of the stage ratios',
};

const RIGID =
  'The chain is rigid: no belt stretch, shaft wind-up or backlash, so every element turns at its fixed fraction of the motor speed.';
const EFFICIENCY =
  'Each reduction has one efficiency, applied by the direction of power flow (divided when the motor drives, multiplied when it is back-driven); it does not change with load or speed here.';

function base(
  chain: DrivetrainChain,
  check: string,
  title: string,
): Pick<MechRecord, 'id' | 'title' | 'check' | 'subject'> {
  const subject: SubjectRef[] = [{ kind: 'drivetrain', drivetrain: chain.id }];
  return { id: `${check}@${chain.id}`, title: `${title}, ${chain.name}`, check, subject };
}

/** A missing input: its name, and why it is missing. */
interface Missing {
  name: string;
  why: string;
}

/** What a linear output leaves out of every record, stated in each. */
function outputAssumptions(chain: DrivetrainChain): string[] {
  return chain.output.kind === 'linear'
    ? [
        'The output is a screw: these numbers stop at the screw shaft. Its lead and efficiency turn torque into force and are not applied here, and the screw’s inertia and the mass it carries are not counted.',
      ]
    : [];
}

/** The ratios of the reductions as inputs `i_1`, `i_2`, ..., with their refs. */

function ratioInputs(chain: DrivetrainChain): {
  inputs: CalcInput[];
  refs: Record<string, InputRef>;
  missing: Missing[];
} {
  const inputs: CalcInput[] = [];
  const refs: Record<string, InputRef> = {};
  const missing: Missing[] = [];
  let k = 0;
  for (const s of chain.stages) {
    if (s.ratioText === undefined) continue;
    k++;
    const symbol = `i_${k}`;
    const name = `Ratio of ${s.name}`;
    inputs.push({
      name,
      symbol,
      value: s.ratio ?? null,
      unit: '1',
      source: `typed: ${s.ratioText}`,
    });
    refs[symbol] = { kind: 'given' };
    if (s.ratio === undefined) missing.push({ name, why: 'it does not read' });
  }
  return { inputs, refs, missing };
}

function unknown(missing: Missing[]): Pick<MechRecord, 'result' | 'status' | 'missing' | 'note'> {
  return {
    result: null,
    status: 'unknown',
    missing: missing.map((m) => m.name),
    note: `Missing: ${missing.map((m) => `${m.name} (${m.why})`).join('; ')}`,
  };
}

function ratioRecord(chain: DrivetrainChain): MechRecord {
  const { inputs, refs, missing } = ratioInputs(chain);
  const direct = inputs.length === 0;
  const record: MechRecord = {
    ...base(chain, DRIVETRAIN_RATIO, 'Overall ratio'),
    method: direct
      ? 'No reductions: the output turns with the motor (direct drive)'
      : 'The product of the reductions’ ratios, each the input speed over the output speed (tooth counts: driven over driver)',
    formula: direct ? 'i = 1' : `i = ${inputs.map((i) => i.symbol).join(' · ')}`,
    inputs,
    result: chain.ratio ?? null,
    unit: '1',
    derived: [],
    assumptions: [RIGID, ...outputAssumptions(chain)],
    sources: [GEAR_TRAINS],
    status: 'ok',
    inputRefs: refs,
  };
  return missing.length > 0 ? { ...record, ...unknown(missing) } : record;
}

function efficiencyRecord(chain: DrivetrainChain): MechRecord {
  const inputs: CalcInput[] = [];
  const refs: Record<string, InputRef> = {};
  const missing: Missing[] = [];
  let k = 0;
  for (const s of chain.stages) {
    if (s.ratioText === undefined) continue;
    k++;
    const symbol = `η_${k}`;
    const name = `Efficiency of ${s.name}`;
    inputs.push({
      name,
      symbol,
      value: s.efficiency ?? null,
      unit: '1',
      source: 'typed on the stage',
    });
    refs[symbol] = { kind: 'given' };
    if (s.efficiency === undefined) missing.push({ name, why: 'it does not read' });
  }
  const record: MechRecord = {
    ...base(chain, DRIVETRAIN_EFFICIENCY, 'Overall efficiency'),
    method:
      inputs.length === 0
        ? 'No reductions: no losses between the motor and the output are modelled'
        : 'The product of the reductions’ efficiencies',
    formula: inputs.length === 0 ? 'η = 1' : `η = ${inputs.map((i) => i.symbol).join(' · ')}`,
    inputs,
    result: chain.efficiency ?? null,
    unit: '1',
    derived: [],
    assumptions: [
      EFFICIENCY,
      'Bearing, seal and coupling losses are not modelled unless folded into a reduction’s efficiency.',
      ...outputAssumptions(chain),
    ],
    sources: [],
    status: 'ok',
    inputRefs: refs,
  };
  return missing.length > 0 ? { ...record, ...unknown(missing) } : record;
}

/** The inertia inputs `J_1`, `J_2`, ...: an element with no source is zero, stated. */
function inertiaInputs(chain: DrivetrainChain): {
  inputs: CalcInput[];
  refs: Record<string, InputRef>;
  missing: Missing[];
  assumptions: string[];
  terms: { element: InertiaElement; symbol: string }[];
} {
  const inputs: CalcInput[] = [];
  const refs: Record<string, InputRef> = {};
  const missing: Missing[] = [];
  const assumptions: string[] = [];
  const terms: { element: InertiaElement; symbol: string }[] = [];
  chain.elements.forEach((e, k) => {
    const symbol = `J_${k + 1}`;
    const none = e.source === 'none';
    inputs.push({
      name: e.name,
      symbol,
      value: none ? 0 : (e.value ?? null),
      unit: INERTIA_UNIT,
      source: e.from,
    });
    refs[symbol] = e.ref;
    if (none) assumptions.push(`${e.name}: ${e.from}.`);
    else if (e.value === undefined) missing.push({ name: e.name, why: e.missing ?? 'not given' });
    if (e.assumption !== undefined) assumptions.push(`${e.assumption}.`);
    terms.push({ element: e, symbol });
  });
  return { inputs, refs, missing, assumptions, terms };
}

function inertiaRecord(chain: DrivetrainChain): MechRecord {
  const { inputs, refs, missing, assumptions, terms } = inertiaInputs(chain);
  const ratios = ratioInputs(chain);
  for (const m of ratios.missing) missing.push(m);
  const derived: CalcValue[] = [];
  let total = 0;
  for (const { element: e, symbol } of terms) {
    if (e.n === undefined) continue;
    const j = e.source === 'none' ? 0 : e.value;
    if (j === undefined) continue;
    const term = j / e.n ** 2;
    total += term;
    derived.push({
      name: `${e.name}, at the motor (speed ratio ${Number(e.n.toPrecision(6))})`,
      symbol: `${symbol}/n²`,
      value: term,
      unit: INERTIA_UNIT,
    });
  }
  if (terms.length === 0) missing.push({ name: 'A turning element', why: 'the chain has none' });
  const record: MechRecord = {
    ...base(chain, DRIVETRAIN_INERTIA, 'Inertia reflected to the motor'),
    method:
      'Equal kinetic energy: each element’s ½ J ω², with its speed ω = ω_motor / n, summed and written as ½ J_motor ω_motor², where n is the product of the ratios between the motor and the element',
    formula: 'J_motor = Σ J_k / n_k²',
    inputs: [...inputs, ...ratios.inputs],
    result: total,
    unit: INERTIA_UNIT,
    derived,
    assumptions: [
      RIGID,
      'A reduction’s typed inertia is referred to its input, as gearbox datasheets give it; a gear or planetary stage’s first instance turns at its input speed and the others at its output speed.',
      'Anything not named by a stage (bearings, keys, fasteners, the cable) is not counted.',
      ...(chain.stages.some((st) => st.kind === 'planetary')
        ? [
            'A planetary stage’s members after the first are counted at its output speed; a member fixed in the assembly (a held ring) is not counted, and members that turn at other speeds (planets, a turning ring) need the stage’s inertia typed instead.',
          ]
        : []),
      ...outputAssumptions(chain),
      ...assumptions,
    ],
    sources: [],
    status: 'ok',
    inputRefs: { ...refs, ...ratios.refs },
  };
  return missing.length > 0 ? { ...record, ...unknown(missing), derived } : record;
}

function outputInertiaRecord(chain: DrivetrainChain, atMotor: MechRecord): MechRecord {
  const ratio = chain.ratio;
  const jm = atMotor.result;
  const missing: Missing[] = [];
  if (jm === null) {
    missing.push({
      name: 'Inertia reflected to the motor',
      why: `calc record ${atMotor.id} is unknown`,
    });
  }
  if (ratio === undefined) {
    missing.push({ name: 'Overall ratio', why: 'a reduction’s ratio does not read' });
  }
  const record: MechRecord = {
    ...base(chain, DRIVETRAIN_INERTIA_OUTPUT, 'Inertia reflected to the output'),
    method: 'The inertia at the motor seen from the output: the overall ratio squared times it',
    formula: 'J_output = J_motor · i²',
    inputs: [
      {
        name: 'Inertia reflected to the motor',
        symbol: 'J_motor',
        value: jm,
        unit: INERTIA_UNIT,
        source: `calc record ${atMotor.id}`,
      },
      {
        name: 'Overall ratio',
        symbol: 'i',
        value: ratio ?? null,
        unit: '1',
        source: `calc record ${DRIVETRAIN_RATIO}@${chain.id}`,
      },
    ],
    result: jm !== null && ratio !== undefined ? jm * ratio ** 2 : null,
    unit: INERTIA_UNIT,
    derived: [],
    assumptions: [RIGID, ...outputAssumptions(chain)],
    sources: [],
    status: 'ok',
    inputRefs: {
      J_motor: { kind: 'record', id: atMotor.id },
      i: { kind: 'record', id: `${DRIVETRAIN_RATIO}@${chain.id}` },
    },
  };
  return missing.length > 0 ? { ...record, ...unknown(missing) } : record;
}

/** The drivetrain's records, in order: ratio, efficiency, inertia at the motor and at the output. */
export function drivetrainRecords(chain: DrivetrainChain): MechRecord[] {
  const atMotor = inertiaRecord(chain);
  return [
    ratioRecord(chain),
    efficiencyRecord(chain),
    atMotor,
    outputInertiaRecord(chain, atMotor),
  ];
}
