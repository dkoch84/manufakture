// The torque the motor needs for a torque and an acceleration at the output (ADR 0017 decision 9,
// T9.3a), through the drivetrain's ratios, efficiencies and inertias. A record, with the working:
// the load reflected through the chain and each element's share of the acceleration torque.
//
// Signs: the output turns in the direction of motion; `T_out` is the load's torque at the output,
// and a positive `α_out` speeds the motion up in that direction (a slowing motion is negative).
// The power flows one way through the whole chain for one query:
//
// - `driving`: the motor turns the output against the load (winding in under load, lifting).
//   `T_motor` is the motor's torque in the direction of motion. Every torque the motor supplies
//   crosses the reductions between the motor and where it is used, so each efficiency divides:
//
//     T_motor = T_out / (i η) + Σ J_k α_motor / (n_k² η_k)
//
// - `back-driven`: the load turns the motor (a user pulling the cable out while the motor
//   resists, generating). `T_motor` is the motor's torque against the motion. The user's torque
//   crosses the chain toward the motor, each element on the way takes what its own acceleration
//   needs, and what is left crosses the reductions between that element and the motor, each
//   multiplying by its efficiency; so the inertia terms are subtracted, times η_k:
//
//     T_motor = T_out η / i - Σ J_k α_motor η_k / n_k²
//
// With ω_k = ω_motor / n_k and α_motor = i α_out; η is the overall efficiency and η_k the product
// of the efficiencies between the motor and element k (1 for the rotor itself).

import type { CalcInput, CalcValue } from '@manufakture/calc';
import type { InputRef, MechRecord } from '../checks/types';
import type { DrivetrainChain } from './chain';
import { DRIVETRAIN_EFFICIENCY, DRIVETRAIN_RATIO, INERTIA_UNIT } from './records';

export const DRIVETRAIN_TORQUE = 'drivetrain.torque';

export type PowerFlow = 'driving' | 'back-driven';

export interface TorqueQuery {
  /** N·m at the output shaft (the spool, the screw, the rotary output). */
  outputTorque: number;
  /**
   * rad/s² at the output, positive when the motion speeds up in its own direction; default 0
   * (steady speed: the inertias are not needed).
   */
  outputAcceleration?: number;
  flow: PowerFlow;
}

/** The motor torque for `query` through `chain`, as a record. */
export function motorTorque(chain: DrivetrainChain, query: TorqueQuery): MechRecord {
  const alphaOut = query.outputAcceleration ?? 0;
  const driving = query.flow === 'driving';
  const i = chain.ratio;
  const eta = chain.efficiency;
  const inputs: CalcInput[] = [
    {
      name: 'Torque at the output',
      symbol: 'T_out',
      value: query.outputTorque,
      unit: 'N·m',
      source: 'given',
    },
    {
      name: 'Angular acceleration at the output',
      symbol: 'α_out',
      value: alphaOut,
      unit: 'rad/s^2',
      source: query.outputAcceleration === undefined ? 'default: steady speed' : 'given',
    },
    {
      name: 'Overall ratio',
      symbol: 'i',
      value: i ?? null,
      unit: '1',
      source: `calc record ${DRIVETRAIN_RATIO}@${chain.id}`,
    },
    {
      name: 'Overall efficiency',
      symbol: 'η',
      value: eta ?? null,
      unit: '1',
      source: `calc record ${DRIVETRAIN_EFFICIENCY}@${chain.id}`,
    },
  ];
  const refs: Record<string, InputRef> = {
    T_out: { kind: 'given' },
    α_out: { kind: 'given' },
    i: { kind: 'record', id: `${DRIVETRAIN_RATIO}@${chain.id}` },
    η: { kind: 'record', id: `${DRIVETRAIN_EFFICIENCY}@${chain.id}` },
  };
  const missing: { name: string; why: string }[] = [];
  if (i === undefined)
    missing.push({ name: 'Overall ratio', why: 'a reduction’s ratio does not read' });
  if (eta === undefined) {
    missing.push({ name: 'Overall efficiency', why: 'a reduction’s efficiency does not read' });
  }
  const assumptions: string[] = [
    'The chain is rigid: no belt stretch, shaft wind-up or backlash.',
    driving
      ? 'The motor drives the output: every efficiency divides on the way back to the motor, and the motor torque is in the direction of motion.'
      : 'The output back-drives the motor: every efficiency multiplies on the way to the motor, and the motor torque is against the motion (it resists).',
    'A positive acceleration speeds the motion up in its own direction; a slowing motion is a negative acceleration.',
    ...(chain.output.kind === 'linear'
      ? [
          'The output is a screw: the output torque and acceleration are at the screw shaft; its lead and efficiency, its inertia and the mass it carries are not in this record.',
        ]
      : []),
  ];
  const derived: CalcValue[] = [];
  let total: number | undefined;
  if (i !== undefined && eta !== undefined) {
    const load = driving ? query.outputTorque / (i * eta) : (query.outputTorque * eta) / i;
    derived.push({
      name: 'Output torque at the motor',
      symbol: 'T_load',
      value: load,
      unit: 'N·m',
    });
    total = load;
    if (alphaOut !== 0) {
      const alphaM = alphaOut * i;
      derived.push({
        name: 'Angular acceleration of the motor',
        symbol: 'α_motor',
        value: alphaM,
        unit: 'rad/s^2',
      });
      chain.elements.forEach((e, k) => {
        const symbol = `J_${k + 1}`;
        const none = e.source === 'none';
        const j = none ? 0 : e.value;
        inputs.push({ name: e.name, symbol, value: j ?? null, unit: INERTIA_UNIT, source: e.from });
        refs[symbol] = e.ref;
        if (none) assumptions.push(`${e.name}: ${e.from}.`);
        if (e.assumption !== undefined) assumptions.push(`${e.assumption}.`);
        if (j === undefined || e.n === undefined || e.efficiencyBefore === undefined) {
          if (j === undefined) missing.push({ name: e.name, why: e.missing ?? 'not given' });
          return;
        }
        const reflected = j / e.n ** 2;
        // Driving: the motor supplies it through the reductions before the element. Back-driven:
        // the element takes it from the user's torque before the rest reaches the motor.
        const term = driving
          ? (reflected * alphaM) / e.efficiencyBefore
          : -reflected * alphaM * e.efficiencyBefore;
        derived.push({
          name: `${e.name}, accelerating`,
          symbol: `T_${symbol}`,
          value: term,
          unit: 'N·m',
        });
        total! += term;
      });
    }
  }
  const record: MechRecord = {
    id: `${DRIVETRAIN_TORQUE}@${chain.id}`,
    title: `Motor torque, ${chain.name}`,
    check: DRIVETRAIN_TORQUE,
    subject: [{ kind: 'drivetrain', drivetrain: chain.id }],
    method: driving
      ? 'The motor’s torque in the direction of motion: the output torque divided by the ratio and the efficiencies, plus what each element’s acceleration takes, reflected to the motor through the efficiencies before it'
      : 'The motor’s torque against the motion: the output torque times the efficiencies divided by the ratio, less what each element’s acceleration takes from it on the way, reflected to the motor through the efficiencies before it',
    formula: driving
      ? 'T_motor = T_out / (i η) + Σ J_k α_motor / (n_k² η_k)'
      : 'T_motor = T_out η / i - Σ J_k α_motor η_k / n_k²',
    inputs,
    result: missing.length > 0 || total === undefined ? null : total,
    unit: 'N·m',
    derived,
    assumptions,
    sources: [],
    status: missing.length > 0 ? 'unknown' : 'ok',
    inputRefs: refs,
  };
  if (missing.length > 0) {
    record.missing = missing.map((m) => m.name);
    record.note = `Missing: ${missing.map((m) => `${m.name} (${m.why})`).join('; ')}`;
  }
  return record;
}
