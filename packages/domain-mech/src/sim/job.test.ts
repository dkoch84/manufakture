// A load case of a document as a simulation job (T9.4b): the cable trainer templates (T9.4a's
// load cases, T9.7a's electrical system) with a motor, a pack, a controller and a resistor chosen,
// read into the simulation's numbers, with what it assumes and what it lacks named.

import {
  applyCommand,
  createDocument,
  type CatalogEntry,
  type Command,
  type Drivetrain,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { electricalTemplateCommand } from '../electrical/model/template';
import { builtinRef } from '../parts/catalog';
import { templateCommand } from '../requirements/templates';
import { NO_VARIABLES } from '../requirements/values';
import { simulate } from './engine';
import { simulationJob, type JobOptions } from './job';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const rel = (a: number, b: number) => Math.abs(a / b - 1);

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const entry = (
  id: string,
  family: CatalogEntry['family'],
  ratings: CatalogEntry['ratings'],
): Command => ({
  type: 'setCatalogEntry',
  entry: {
    id,
    version: 1,
    family,
    fieldsVersion: 2,
    maker: 'Test',
    partNumber: id,
    description: '',
    ratings,
    sources: [],
    verified: false,
  },
});

const use = (
  id: string,
  ref: NonNullable<ReturnType<typeof builtinRef>>,
  name: string,
): Command => ({
  type: 'setPurchasedUse',
  use: { id, entry: ref, alternates: [], name },
});

/** The spike's direct-drive motor as a datasheet would list it. */
const SPIKE_MOTOR: CatalogEntry['ratings'] = {
  kt: { value: 0.5, convention: 'phase amplitude' },
  kv: { value: Math.sqrt(3) / 2 / 0.5, convention: 'line-to-line amplitude' },
  resistance: { value: 0.08, convention: 'line-to-line' },
  inductance: { value: 0.2e-3, convention: 'line-to-line' },
  polePairs: { value: 14 },
  rotorInertia: { value: 3e-3 },
  // The spike's friction and iron loss, as the two loss torques a datasheet gives.
  dragTorque: { value: 0.09 },
  viscousDrag: { value: 9e-4 },
  windingHousingResistance: { value: 0.3 },
  thermalResistance: { value: 1.3 },
  thermalTimeConstant: { value: 60 },
  housingTimeConstant: { value: 1000 },
};

/**
 * The templates, with a direct drive onto a spool of one layer at 25 mm (3 mm cable on a 47 mm
 * core, 60 mm wide), the spike's motor, a 16S pack, an ODrive Pro and a TE 6.8 ohm resistor.
 */
function design(motor = SPIKE_MOTOR): { doc: ManufaktureDocument; loadCases: string[] } {
  let doc = apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    entry('entry#1', 'motor', motor),
    entry('entry#2', 'pack', {
      series: { value: 16 },
      parallel: { value: 1 },
      nominalVoltage: { value: 57.6 },
      fullVoltage: { value: 67.2 },
      emptyVoltage: { value: 44.8 },
      capacity: { value: 1.7 * 3600 },
      resistance: { value: 0.42 },
      maxChargeCurrent: { value: 3.4 },
      cell: { text: 'cell/molicel-inr-21700-p45b v1' },
    }),
    use('pp#1', { source: 'document', id: 'entry#1' }, 'Motor'),
    use('pp#2', builtinRef('rope/samson-amsteel-blue-3mm')!, 'Cable'),
    use('pp#3', { source: 'document', id: 'entry#2' }, 'Pack'),
    use('pp#4', builtinRef('controller/odrive-pro')!, 'Controller'),
    use('pp#5', builtinRef('resistor/te-hch165-6r8')!, 'Resistor'),
  );
  const drive: Drivetrain = {
    id: 'drive#1',
    name: 'Direct drive',
    stages: [{ id: 'stage#1', kind: 'motor', use: 'pp#1' }],
    output: {
      kind: 'spool',
      cable: 'pp#2',
      length: x('2.85 m'),
      core: x('47 mm'),
      width: x('60 mm'),
      flange: x('80 mm'),
      inertia: x('2e-4 kg*m^2'),
    },
  };
  doc = apply(doc, { type: 'setDrivetrain', drivetrain: drive });
  const lc = templateCommand(doc, 'cable-trainer');
  if (!lc.ok) throw new Error(lc.message);
  doc = apply(doc, lc.command);
  const el = electricalTemplateCommand(doc);
  if (!el.ok) throw new Error(el.message);
  doc = apply(doc, el.command);
  const e = doc.mech!.electrical!;
  const uses: Record<string, string> = {
    pack: 'pp#3',
    controller: 'pp#4',
    'brake-resistor': 'pp#5',
  };
  doc = apply(doc, {
    type: 'setElectrical',
    electrical: {
      ...e,
      components: e.components.map((c) => (uses[c.role] ? { ...c, use: uses[c.role]! } : c)),
    },
  });
  return { doc, loadCases: lc.loadCaseIds };
}

const ctx = (doc: ManufaktureDocument) => ({ document: doc, variables: NO_VARIABLES });

describe('a load case as a job', () => {
  const { doc, loadCases } = design();
  const fullForce = loadCases[0]!;

  it('reads the motor, the drivetrain, the pack, the controller, the resistor and the loads', () => {
    const r = simulationJob(ctx(doc), fullForce);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    const m = r.job.machine;
    // Kt as given; R and L line to line halved to the phase.
    expect(m.motor.kt).toBe(0.5);
    expect(m.motor.resistance).toBeCloseTo(0.04, 15);
    expect(m.motor.inductance).toBeCloseTo(1e-4, 15);
    expect(m.motor.frictionCoulomb).toBe(0.09);
    // C = τ / R: 60 s / 0.3 K/W and 1000 s / 1.0 K/W.
    expect(m.motorThermal!.windingCapacity).toBeCloseTo(200, 9);
    expect(m.motorThermal!.housingCapacity).toBeCloseTo(1000, 9);
    expect(m.motorThermal!.housingToAmbient).toBeCloseTo(1, 12);
    // Rotor and spool: 3e-3 + 2e-4.
    expect(m.transmission.inertia).toBeCloseTo(3.2e-3, 12);
    expect(m.transmission.ratio).toBe(1);
    expect(m.transmission.radius).toEqual({
      kind: 'steps',
      steps: [{ from: 0, to: 2.85, radius: expect.closeTo(0.025, 12) }],
    });
    // The pack: its named cell's (generic layered-oxide) curve times 16.
    expect(m.pack.capacity).toBe(1.7 * 3600);
    expect(m.pack.ocv.at(-1)!.voltage).toBeCloseTo(16 * 4.19, 9);
    expect(m.pack.chargeLimit).toBe(3.4);
    expect(m.pack.cutoff).toBe(44.8);
    // ODrive Pro: 100 A peak; no loss data, so none counted, and said so.
    expect(m.controller.currentLimit).toBe(100);
    expect(m.controller.fixedLoss).toBe(0);
    expect(r.assumptions.join('\n')).toMatch(/controller gives no fixed loss/);
    expect(m.brake!.resistance).toBe(6.8);
    // DC-DC 25 mA at the pack's 57.6 V; board, encoder, load cell, display at 5 V.
    expect(m.aux).toBeCloseTo(0.025 * 57.6 + (0.08 + 0.02 + 0.015 + 0.06) * 5, 12);
    expect(r.job.components).toEqual({ controller: 'el#6', resistor: 'el#7' });
    expect(r.job.start.soc).toBe(1);
    expect(r.job.options!.dt).toBe(1e-3);
    expect(r.job.options!.budgetMs).toBe(2000);
    expect(r.warnings).toEqual([]);
  });

  it('runs to the spike’s motor numbers: current, copper and winding temperature per rep', () => {
    const options: JobOptions = { cableEfficiency: 0.97, controller: { currentLimit: 60 } };
    const r = simulationJob(ctx(doc), fullForce, options);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    const res = simulate(r.job);
    expect(res.status).toBe('done');
    expect(res.ledger.residualRelative).toBeLessThan(1e-6);
    // The template's rep returns at 1.5 m/s, not the spike's 1.0 s return; the pull is the
    // spike's, so the pull's user work and the peak torque (on the return) are comparable.
    expect(rel(res.phases.pull!.userWork / 9, 533.8)).toBeLessThan(1e-3);
    expect(res.envelopes['motor/current']!.peak).toBeGreaterThan(44.48);
    expect(res.envelopes['motor/current']!.peak).toBeLessThan(60);
    // The 6.8 ohm resistor cannot take the pull's surplus at this bus voltage, which it says.
    expect(res.warnings.map((w) => w.code)).toContain('brake-overload');
    expect(res.envelopes['electrical/el#7/resistor-current']!.peak).toBeGreaterThan(5);
  });

  it('a hold load case reproduces the spike’s hold through the document', () => {
    const hold = loadCases[2]!; // isometric 200 lbf for 30 s at 40 °C
    const r = simulationJob(ctx(doc), hold);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    expect(r.job.machine.ambient).toBeCloseTo(313.15, 9);
    const res = simulate(r.job);
    // The spike's 30 s hold rose 14.60 K from 25 °C. At 40 °C the copper starts 15 K above the
    // catalog's 25 °C (5.9 % more resistance) and Kt is 1.8 % lower (3.6 % more copper loss for
    // the same torque): about 10 % more heat, so about 10 % more rise.
    const rise = res.envelopes['motor/winding-temperature']!.max - r.job.machine.ambient;
    expect(rise / 14.6).toBeGreaterThan(1.08);
    expect(rise / 14.6).toBeLessThan(1.12);
  });

  it('a session per charge, cooled between sessions', () => {
    const r = simulationJob(ctx(doc), loadCases[3]!);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    expect(r.job.start.soc).toBe(1);
    const res = simulate(r.job);
    expect(res.status).toBe('done');
    expect(res.envelopes['pack/state-of-charge']!.final).toBeLessThan(1);
  });
});

describe('a geared actuator', () => {
  // 9:1, gear efficiency 0.9, no loss torques: friction from 1 A of no-load current at
  // 10 rad/s, which the catalog gives at the output.
  const geared = (kt: CatalogEntry['ratings'][string]): CatalogEntry['ratings'] => {
    const r: CatalogEntry['ratings'] = {
      ...SPIKE_MOTOR,
      kt,
      ratio: { value: 9 },
      gearEfficiency: { value: 0.9 },
    };
    delete r.kv;
    delete r.dragTorque;
    delete r.viscousDrag;
    r.noLoadCurrent = { value: 1 };
    r.noLoadSpeed = { value: 10 };
    return r;
  };

  it('puts an output-side no-load torque and the output no-load speed on the rotor', () => {
    const { doc, loadCases } = design(
      geared({ value: 0.9, convention: 'phase amplitude, output side' }),
    );
    const r = simulationJob(ctx(doc), loadCases[0]!);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    const m = r.job.machine;
    expect(m.motor.kt).toBeCloseTo(0.1, 12);
    expect(m.transmission.ratio).toBe(9);
    expect(m.transmission.efficiency).toBeCloseTo(0.9, 12);
    // Kt x I0 at the output is 0.9 N*m, so 0.1 N*m at the rotor; the rotor turns at 90 rad/s.
    expect(m.motor.frictionCoulomb).toBeCloseTo(0.05, 12);
    expect(m.motor.frictionViscous).toBeCloseTo(0.05 / 90, 12);
    // The loss at the rotor's no-load speed is the no-load torque times that speed.
    const w = 90;
    expect(m.motor.frictionCoulomb * w + m.motor.frictionViscous * w * w).toBeCloseTo(0.1 * w, 9);
  });

  it('keeps a motor-side no-load torque as it is, the speed still times the ratio', () => {
    const { doc, loadCases } = design(geared({ value: 0.1, convention: 'phase amplitude' }));
    const r = simulationJob(ctx(doc), loadCases[0]!);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    expect(r.job.machine.motor.frictionCoulomb).toBeCloseTo(0.05, 12);
    expect(r.job.machine.motor.frictionViscous).toBeCloseTo(0.05 / 90, 12);
    expect(r.assumptions.join('\n')).toMatch(
      /no-load speed taken at the output, times the gear ratio/,
    );
  });
});

describe('wording', () => {
  it('states numbers and assumptions and never calls anything safe or passing', () => {
    const { doc, loadCases } = design({
      ...SPIKE_MOTOR,
      kv: { value: 3, convention: 'line-to-line amplitude' },
    });
    const forbidden =
      /\b(safe|safety|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*|ok)\b/i;
    for (const id of loadCases) {
      const r = simulationJob(ctx(doc), id);
      if (!r.ok) throw new Error(JSON.stringify(r.missing));
      const res = simulate({ ...r.job, machine: { ...r.job.machine, brake: undefined } as never });
      for (const line of [...r.assumptions, ...r.warnings, ...res.warnings.map((w) => w.message)]) {
        expect(line).not.toMatch(forbidden);
        expect(line).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});

describe('what a job lacks', () => {
  it('names the drivetrain, the pack and the controller when the design has none', () => {
    let doc = createDocument({ id: 'd', name: 'Trainer' });
    const lc = templateCommand(doc, 'cable-trainer');
    if (!lc.ok) throw new Error(lc.message);
    doc = apply(doc, lc.command);
    const r = simulationJob(ctx(doc), lc.loadCaseIds[0]!);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.map((m) => m.input)).toEqual(['drivetrain', 'pack', 'controller']);
  });

  it('names the parts the electrical template leaves generic', () => {
    const { doc, loadCases } = design();
    const e = doc.mech!.electrical!;
    const bare = apply(doc, {
      type: 'setElectrical',
      electrical: {
        ...e,
        components: e.components.map((c) => {
          const bare = { ...c };
          delete bare.use;
          return bare;
        }),
      },
    });
    const r = simulationJob(ctx(bare), loadCases[0]!);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual([
      { input: 'pack', message: 'Pack (el#1) has no purchased part' },
      { input: 'controller', message: 'Motor controller (el#6) has no purchased part' },
      { input: 'braking resistor', message: 'Braking resistor (el#7) has no purchased part' },
    ]);
  });

  it('names a load case with no motion, and one that is not there', () => {
    const { doc } = design();
    expect(simulationJob(ctx(doc), 'lc#99')).toMatchObject({
      ok: false,
      missing: [{ input: 'load case' }],
    });
    const still = apply(doc, {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#6',
        name: 'Side pull',
        static: [{ kind: 'cable', name: 'Pull', force: x('400 N'), angle: x('30 deg') }],
      },
    });
    expect(simulationJob(ctx(still), 'lc#6')).toEqual({
      ok: false,
      missing: [
        { input: 'motion', message: 'Side pull (lc#6) has no force law and motion to simulate' },
      ],
      warnings: [],
    });
  });

  it('warns when the motor’s Kt and Kv disagree', () => {
    const { doc, loadCases } = design({
      ...SPIKE_MOTOR,
      kv: { value: (2 * Math.sqrt(3)) / 2 / 0.5, convention: 'line-to-line amplitude' },
    });
    const r = simulationJob(ctx(doc), loadCases[0]!);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /Kt \(0\.5 N\*m\/A\) and Kv .* disagree by 100 %: Kt should be about 8\.27 \/ Kv = 0\.25 N\*m\/A/,
    );
  });
});
