// The drivetrain model (T9.3a). The acceptance: direct drive and a 5:1 belt drive of the same
// spool give the reflected inertia and the motor torque that a hand calculation gives, written out
// below with every step. The spool's inertia is "measured": a fake measurement of a steel disc, as
// regen would report it, so the hand calculation is the disc formula J = m R² / 2.

import {
  applyCommand,
  createDocument,
  type Command,
  type Drivetrain,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import type { MeasuredGeometry } from '../checks/measured';
import { analyseDrivetrain, analyseDrivetrains, drivetrainWarnings } from './analysis';
import { drivetrainChain, drivetrainNeeds } from './chain';
import { combineBodies, principalMoments, spinMoment } from './inertia';
import { motorTorque } from './torque';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const NO_VARIABLES: VariableLookup = () => undefined;

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

// The spool: a steel disc, radius 50 mm, 20 mm thick, about its own centre of mass, its axis
// along z. Volume V = π R² L; at unit density the moment about z is V R² / 2 and about x and y
// V (3 R² + L²) / 12 (in m⁵, as regen reports a body).
const R = 0.05;
const L = 0.02;
const V = Math.PI * R ** 2 * L;
const DISC: MeasuredGeometry = {
  body: (part, body) =>
    part === 'part#1' && body === 'extrude#1'
      ? {
          volume: V,
          area: 2 * Math.PI * R ** 2 + 2 * Math.PI * R * L,
          centerOfMass: [0, 0, 0.01],
          volumeInertia: [
            [(V * (3 * R ** 2 + L ** 2)) / 12, 0, 0],
            [0, (V * (3 * R ** 2 + L ** 2)) / 12, 0],
            [0, 0, (V * R ** 2) / 2],
          ],
        }
      : undefined,
  problem: () => 'not measured',
};
const BODIES = (part: string) => (part === 'part#1' ? ['extrude#1'] : undefined);

/** A motor with a rotor inertia of 3.0e-4 kg·m², a steel spool part in an assembly. */
function design(): ManufaktureDocument {
  let doc = apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    {
      type: 'setCatalogEntry',
      entry: {
        id: 'entry#1',
        version: 1,
        family: 'motor',
        fieldsVersion: 1,
        maker: 'Acme',
        partNumber: 'BLDC 80',
        description: '',
        ratings: { rotorInertia: { value: 3.0e-4 } },
        sources: [],
        verified: false,
      },
    },
    {
      type: 'setPurchasedUse',
      use: {
        id: 'pp#2',
        entry: { source: 'document', id: 'entry#1' },
        alternates: [],
        name: 'Drive motor',
      },
    },
    { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Trainer' },
    {
      type: 'addInstance',
      assemblyId: 'assembly#1',
      instance: {
        id: 'inst#1',
        name: 'Spool',
        source: { part: 'part#1' },
        fixed: true,
        suppressed: false,
        pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      },
    },
  );
  doc = { ...doc, parts: doc.parts.map((p) => ({ ...p, material: 'steel' })) };
  return doc;
}

const directDrive = (): Drivetrain => ({
  id: 'drive#3',
  name: 'Direct',
  assembly: 'assembly#1',
  stages: [{ id: 'stage#4', kind: 'motor', use: 'pp#2' }],
  output: { kind: 'spool', instance: 'inst#1', cable: 'pp#2', length: x('2.5 m') },
});

const beltDrive = (): Drivetrain => ({
  id: 'drive#5',
  name: 'Belt 5:1',
  assembly: 'assembly#1',
  stages: [
    { id: 'stage#6', kind: 'motor', use: 'pp#2' },
    {
      id: 'stage#7',
      kind: 'belt',
      ratio: { driver: x('15'), driven: x('75') },
      efficiency: x('0.95'),
      // Both pulleys and the belt, referred to the motor pulley's shaft (the stage's input).
      inertia: x('4e-5 kg*m^2'),
    },
  ],
  output: { kind: 'spool', instance: 'inst#1', cable: 'pp#2', length: x('2.5 m') },
});

function analyse(doc: ManufaktureDocument, d: Drivetrain) {
  return analyseDrivetrain(
    { document: doc, variables: NO_VARIABLES, measured: DISC, partBodies: BODIES },
    d,
  );
}

// The load: 200 lbf, taken as 890 N, on a 25 mm effective spool radius: T_out = 890 × 0.025 =
// 22.25 N·m. An acceleration of the spool of 40 rad/s² (1 m/s² of cable at 25 mm).
const T_OUT = 22.25;
const ALPHA_OUT = 40;

describe('the drivetrain against a hand calculation', () => {
  // The spool: m = ρ π R² L = 7850 × π × 0.05² × 0.02 = 1.233075 kg;
  // J_spool = m R² / 2 = 1.233075 × 0.0025 / 2 = 1.541344e-3 kg·m².
  const J_SPOOL = 1.541344e-3;
  const J_ROTOR = 3.0e-4;

  it('direct drive: the spool and the rotor add, the torque is the output torque', () => {
    const a = analyse(design(), directDrive());
    expect(a.problems).toEqual([]);
    expect(a.ratio).toBe(1);
    expect(a.efficiency).toBe(1);
    expect(a.elements.map((e) => [e.source, e.n])).toEqual([
      ['catalog', 1],
      ['measured', 1],
    ]);
    expect(a.elements[1]!.value).toBeCloseTo(J_SPOOL, 9);
    // J_motor = J_rotor + J_spool = 3.0e-4 + 1.541344e-3 = 1.841344e-3 kg·m², the same at the
    // output (i = 1).
    expect(a.inertiaAtMotor).toBeCloseTo(1.841344e-3, 9);
    expect(a.inertiaAtOutput).toBeCloseTo(1.841344e-3, 9);
    expect(a.records.map((r) => [r.id, r.status])).toEqual([
      ['drivetrain.ratio@drive#3', 'ok'],
      ['drivetrain.efficiency@drive#3', 'ok'],
      ['drivetrain.inertia@drive#3', 'ok'],
      ['drivetrain.inertia-output@drive#3', 'ok'],
    ]);
    // Steady speed: T_motor = T_out = 22.25 N·m.
    const steady = motorTorque(a, { outputTorque: T_OUT, flow: 'driving' });
    expect(steady.result).toBeCloseTo(22.25, 9);
    // Accelerating: T_motor = 22.25 + 1.841344e-3 × 40 = 22.25 + 0.073654 = 22.323654 N·m.
    const accel = motorTorque(a, {
      outputTorque: T_OUT,
      outputAcceleration: ALPHA_OUT,
      flow: 'driving',
    });
    expect(accel.result).toBeCloseTo(22.323654, 6);
  });

  it('a 5:1 belt: the spool is reflected by 1/25, the torque by 1/(5 × 0.95)', () => {
    const a = analyse(design(), beltDrive());
    expect(a.problems).toEqual([]);
    // i = 75 / 15 = 5; η = 0.95.
    expect(a.ratio).toBe(5);
    expect(a.efficiency).toBe(0.95);
    expect(a.stages.map((s) => [s.id, s.nIn, s.nOut])).toEqual([
      ['stage#6', 1, 1],
      ['stage#7', 1, 5],
    ]);
    // J_motor = J_rotor + J_belt + J_spool / 5² = 3.0e-4 + 4.0e-5 + 1.541344e-3 / 25
    //         = 3.0e-4 + 4.0e-5 + 6.165375e-5 = 4.016538e-4 kg·m².
    expect(a.inertiaAtMotor).toBeCloseTo(4.016538e-4, 10);
    // J_output = J_motor × 5² = 1.004134e-2 kg·m².
    expect(a.inertiaAtOutput).toBeCloseTo(1.004134e-2, 8);
    const inertia = a.records.find((r) => r.check === 'drivetrain.inertia')!;
    expect(inertia.derived.map((d) => d.value)).toEqual([
      expect.closeTo(3.0e-4, 12),
      expect.closeTo(4.0e-5, 12),
      expect.closeTo(6.165375e-5, 10),
    ]);
    expect(inertia.inputs.find((i) => i.symbol === 'J_1')!.source).toMatch(
      /catalog entry#1 Acme BLDC 80, rotor inertia \(catalog data, unverified\)/,
    );
    expect(inertia.inputs.find((i) => i.symbol === 'J_2')!.source).toBe('typed: 4e-5 kg*m^2');
    expect(inertia.assumptions.join(' ')).toMatch(/axis of symmetry/);

    // Steady speed, driving: T_motor = 22.25 / (5 × 0.95) = 22.25 / 4.75 = 4.684211 N·m.
    expect(motorTorque(a, { outputTorque: T_OUT, flow: 'driving' }).result).toBeCloseTo(
      4.684211,
      6,
    );
    // Back-driven (the user pulls the cable out): T_motor = 22.25 × 0.95 / 5 = 4.2275 N·m.
    expect(motorTorque(a, { outputTorque: T_OUT, flow: 'back-driven' }).result).toBeCloseTo(
      4.2275,
      9,
    );
    // Accelerating, driving: α_motor = 5 × 40 = 200 rad/s².
    //   load:   4.684211
    //   rotor:  3.0e-4 × 200                 = 0.060000
    //   belt:   4.0e-5 × 200                 = 0.008000
    //   spool:  6.165375e-5 × 200 / 0.95     = 0.012980
    //   total:                                 4.765190 N·m
    const accel = motorTorque(a, {
      outputTorque: T_OUT,
      outputAcceleration: ALPHA_OUT,
      flow: 'driving',
    });
    expect(accel.status).toBe('ok');
    expect(accel.result).toBeCloseTo(4.76519, 5);
    expect(accel.derived.find((d) => d.symbol === 'α_motor')!.value).toBe(200);
    // Accelerating, back-driven: the user pulls the cable out and the pull speeds up at
    // 40 rad/s² (positive: speeding up in the direction of motion). The user's torque reaches the
    // motor through the belt (times 0.95, over 5); on the way, each element takes what its own
    // acceleration needs, and what the spool takes never crosses the belt, so its share is times
    // 0.95 too. The motor resists with what is left:
    //   load:   22.25 × 0.95 / 5               = 4.227500
    //   rotor:  3.0e-4 × 200                   = 0.060000
    //   belt:   4.0e-5 × 200                   = 0.008000
    //   spool:  6.165375e-5 × 200 × 0.95       = 0.011714
    //   total:  4.227500 - 0.079714            = 4.147786 N·m against the motion
    const pulled = motorTorque(a, {
      outputTorque: T_OUT,
      outputAcceleration: ALPHA_OUT,
      flow: 'back-driven',
    });
    expect(pulled.status).toBe('ok');
    expect(pulled.result).toBeCloseTo(4.147786, 5);
    expect(pulled.formula).toBe('T_motor = T_out η / i - Σ J_k α_motor η_k / n_k²');
    expect(pulled.assumptions.join(' ')).toMatch(/speeds the motion up in its own direction/);
    expect(pulled.assumptions.join(' ')).toMatch(/against the motion/);
    // Slowing down (negative): the elements give their energy back and the motor resists more.
    expect(
      motorTorque(a, { outputTorque: T_OUT, outputAcceleration: -ALPHA_OUT, flow: 'back-driven' })
        .result,
    ).toBeCloseTo(4.2275 + 0.079714, 5);
  });

  it('gives the same inertia at the output for both, less the reduction’s own', () => {
    // Seen from the spool, the belt drive's rotor and pulleys weigh 25 times as much.
    const direct = analyse(design(), directDrive());
    const belt = analyse(design(), beltDrive());
    expect(belt.inertiaAtOutput! - direct.inertiaAtOutput!).toBeCloseTo(
      (J_ROTOR + 4e-5) * 25 - J_ROTOR,
      10,
    );
  });
});

describe('the chain', () => {
  it('reads a ratio typed as a number, measures gear members on their own sides', () => {
    // inst#2: a second, free-turning copy of the disc; inst#1 is fixed in the assembly.
    const doc = apply(design(), {
      type: 'addInstance',
      assemblyId: 'assembly#1',
      instance: {
        id: 'inst#2',
        name: 'Gear',
        source: { part: 'part#1' },
        fixed: false,
        suppressed: false,
        pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      },
    });
    const d: Drivetrain = {
      id: 'drive#1',
      name: 'Gear',
      assembly: 'assembly#1',
      stages: [
        { id: 'stage#1', kind: 'motor', use: 'pp#2', inertia: x('1e-4 kg*m^2') },
        {
          id: 'stage#2',
          kind: 'gear',
          ratio: x('4'),
          efficiency: x('0.9'),
          instances: ['inst#2', 'inst#2'],
        },
        { id: 'stage#3', kind: 'shaft', bearings: [] },
      ],
      output: { kind: 'rotary' },
    };
    const a = analyse(doc, d);
    expect(a.elements.map((e) => [e.at, e.source, e.n, e.efficiencyBefore])).toEqual([
      ['stage#1', 'typed', 1, 1],
      ['stage#2', 'measured', 1, 1],
      ['stage#2', 'measured', 4, 0.9],
      ['stage#3', 'none', 4, 0.9],
      ['output', 'none', 4, 0.9],
    ]);
    // 1e-4 + J_disc + J_disc / 16.
    const j = 1.5413439e-3;
    expect(a.inertiaAtMotor).toBeCloseTo(1e-4 + j + j / 16, 9);
    const inertia = a.records.find((r) => r.check === 'drivetrain.inertia')!;
    expect(inertia.assumptions.filter((s) => s.includes('counted as zero'))).toHaveLength(2);

    // A planetary whose ring (inst#1) is fixed in the assembly: the ring does not turn.
    const planetary = analyse(doc, {
      ...d,
      stages: [
        d.stages[0]!,
        { ...d.stages[1]!, kind: 'planetary', instances: ['inst#2', 'inst#2', 'inst#1'] },
        d.stages[2]!,
      ] as Drivetrain['stages'],
    });
    expect(planetary.elements[3]).toMatchObject({ source: 'none', n: 4 });
    expect(planetary.elements[3]!.from).toMatch(/inst#1 is fixed in the assembly/);
    expect(planetary.inertiaAtMotor).toBeCloseTo(1e-4 + j + j / 16, 9);
    const p = planetary.records.find((r) => r.check === 'drivetrain.inertia')!;
    expect(p.assumptions.join(' ')).toMatch(/A planetary stage’s members after the first/);
  });

  it('discloses what a linear output leaves out', () => {
    const a = analyse(design(), {
      ...directDrive(),
      output: { kind: 'linear', lead: x('5'), efficiency: x('0.9') },
    });
    expect(a.elements.at(-1)).toMatchObject({ at: 'output', source: 'none', n: 1 });
    expect(a.elements.at(-1)!.from).toMatch(/screw’s inertia and the mass it carries/);
    for (const r of a.records) {
      expect(r.assumptions.join(' ')).toMatch(/The output is a screw/);
    }
    const t = motorTorque(a, { outputTorque: 1, flow: 'driving' });
    expect(t.assumptions.join(' ')).toMatch(/The output is a screw/);
  });

  it('says when a measured part has no clear axis of symmetry', () => {
    // A block 100 x 60 x 20 mm: principal moments far apart.
    const [a, b, c] = [0.1, 0.06, 0.02];
    const vol = a * b * c;
    const block: MeasuredGeometry = {
      body: () => ({
        volume: vol,
        area: 0,
        centerOfMass: [0, 0, 0],
        volumeInertia: [
          [(vol * (b ** 2 + c ** 2)) / 12, 0, 0],
          [0, (vol * (a ** 2 + c ** 2)) / 12, 0],
          [0, 0, (vol * (a ** 2 + b ** 2)) / 12],
        ],
      }),
      problem: () => 'not measured',
    };
    const chain = drivetrainChain(
      { document: design(), variables: NO_VARIABLES, measured: block, partBodies: BODIES },
      directDrive(),
    );
    expect(chain.elements[1]!.assumption).toMatch(/no clear axis of symmetry/);
    const disc = analyse(design(), directDrive());
    expect(disc.elements[1]!.assumption).not.toMatch(/no clear axis/);
  });

  it('reports values that do not read, and makes the records that need them unknown', () => {
    const d = beltDrive();
    const bad: Drivetrain = {
      ...d,
      stages: [
        d.stages[0]!,
        { ...d.stages[1]!, ratio: { driver: x('15.5'), driven: x('75') }, efficiency: x('1.2') },
      ] as Drivetrain['stages'],
    };
    const a = analyse(design(), bad);
    expect(a.problems.map((p) => [p.path.join('.'), p.kind])).toEqual([
      ['stages.1.ratio.driver', 'value'],
      ['stages.1.efficiency', 'value'],
    ]);
    expect(a.ratio).toBeUndefined();
    const status = Object.fromEntries(a.records.map((r) => [r.check, r.status]));
    expect(status).toEqual({
      'drivetrain.ratio': 'unknown',
      'drivetrain.efficiency': 'unknown',
      'drivetrain.inertia': 'unknown',
      'drivetrain.inertia-output': 'unknown',
    });
    expect(motorTorque(a, { outputTorque: 1, flow: 'driving' }).status).toBe('unknown');
    // A wrong kind for a typed inertia.
    const speed = analyse(design(), {
      ...d,
      output: { ...d.output, inertia: x('2 m/s') } as Drivetrain['output'],
    });
    expect(speed.problems.map((p) => p.path.join('.'))).toEqual(['output.inertia']);
    expect(speed.inertiaAtMotor).toBeUndefined();
  });

  it('needs no inertias for a steady torque, and names a missing rotor inertia otherwise', () => {
    let doc = design();
    doc = apply(doc, {
      type: 'setCatalogEntry',
      entry: { ...doc.mech!.catalog![0]!, ratings: { rotorInertia: { unknown: true } } },
    });
    const a = analyse(doc, beltDrive());
    expect(a.inertiaAtMotor).toBeUndefined();
    const inertia = a.records.find((r) => r.check === 'drivetrain.inertia')!;
    expect(inertia.status).toBe('unknown');
    expect(inertia.note).toMatch(/gives no rotor inertia/);
    expect(motorTorque(a, { outputTorque: T_OUT, flow: 'driving' }).status).toBe('ok');
    const accel = motorTorque(a, { outputTorque: T_OUT, outputAcceleration: 1, flow: 'driving' });
    expect(accel.status).toBe('unknown');
    expect(accel.missing).toEqual(['Rotor of Drive motor (stage#6)']);
  });

  it('asks regen to measure only what has no typed or catalog value', () => {
    let doc = apply(design(), { type: 'setDrivetrain', drivetrain: beltDrive() });
    expect(drivetrainNeeds(doc, BODIES)).toEqual([{ part: 'part#1', body: 'extrude#1' }]);
    const typed = beltDrive();
    doc = apply(doc, {
      type: 'setDrivetrain',
      drivetrain: {
        ...typed,
        output: { ...typed.output, inertia: x('1 kg*m^2') } as Drivetrain['output'],
      },
    });
    expect(drivetrainNeeds(doc, BODIES)).toEqual([]);
    // Outside regen nothing is measured: the record says what is missing.
    const outside = drivetrainChain({ document: doc, variables: NO_VARIABLES }, directDrive());
    expect(outside.elements[1]!.missing).toMatch(
      /not known: it has not regenerated, or it did not build/,
    );
  });
});

describe('references', () => {
  it('warns on the drivetrain for an instance, mate, use or body that is not there', () => {
    let doc = design();
    doc = apply(doc, {
      type: 'setDrivetrain',
      drivetrain: {
        id: 'drive#1',
        name: 'Main',
        assembly: 'assembly#1',
        stages: [
          { id: 'stage#1', kind: 'motor', use: 'pp#2', instance: 'inst#9', mate: 'mate#4' },
          { id: 'stage#2', kind: 'shaft', instance: 'inst#8', bearings: [{ use: 'pp#7' }] },
        ],
        output: {
          kind: 'spool',
          instance: 'inst#1',
          body: 'extrude#4',
          cable: 'pp#2',
          length: x('2 m'),
        },
      },
    });
    const analyses = analyseDrivetrains({
      document: doc,
      variables: NO_VARIABLES,
      measured: DISC,
      partBodies: BODIES,
    });
    expect(drivetrainWarnings(analyses)).toEqual([
      {
        code: 'mech-reference',
        message:
          'Drivetrain Main (drive#1): stages.0.instance: names instance inst#9, which Trainer does not have',
        objectId: 'drive#1',
        target: 'inst#9',
      },
      {
        code: 'mech-reference',
        message:
          'Drivetrain Main (drive#1): stages.0.mate: names mate mate#4, which Trainer does not have',
        objectId: 'drive#1',
        target: 'mate#4',
      },
      {
        code: 'mech-reference',
        message:
          'Drivetrain Main (drive#1): stages.1.instance: names instance inst#8, which Trainer does not have',
        objectId: 'drive#1',
        target: 'inst#8',
      },
      {
        code: 'mech-reference',
        message:
          'Drivetrain Main (drive#1): stages.1.bearings.0.use: names purchased part pp#7, which the design does not have',
        objectId: 'drive#1',
        target: 'pp#7',
      },
      {
        code: 'mech-reference',
        message:
          'Drivetrain Main (drive#1): output.body: names body extrude#4, which part#1 does not have',
        objectId: 'drive#1',
        target: 'extrude#4',
      },
    ]);
    // The records that need the missing ones are unknown and name them.
    const inertia = analyses[0]!.records.find((r) => r.check === 'drivetrain.inertia')!;
    expect(inertia.status).toBe('unknown');
    expect(inertia.note).toMatch(/assembly#1 has no instance inst#8/);
  });

  it('wants the motor first, a motor entry and a revolute mate', () => {
    // A fastened mate, as far as the chain reads it (its connectors are not looked at).
    const base = design();
    const doc: ManufaktureDocument = {
      ...base,
      assemblies: base.assemblies!.map((a) => ({
        ...a,
        mates: [{ id: 'mate#1', name: 'Fastened 1', kind: 'fastened' } as (typeof a.mates)[number]],
      })),
    };
    const d: Drivetrain = {
      id: 'drive#1',
      name: 'Odd',
      assembly: 'assembly#1',
      stages: [
        { id: 'stage#1', kind: 'shaft', bearings: [] },
        { id: 'stage#2', kind: 'motor', use: 'pp#2', mate: 'mate#1' },
      ],
      output: { kind: 'rotary' },
    };
    const a = analyse(doc, d);
    expect(a.problems.map((p) => [p.path.join('.'), p.kind])).toEqual([
      ['stages.0', 'structure'],
      ['stages.1', 'structure'],
      ['stages.1.mate', 'structure'],
    ]);
    expect(drivetrainWarnings([a])).toEqual([]);
  });
});

describe('inertia from measured bodies', () => {
  it('finds the spin axis of a disc and of a shaft, and adds offset bodies', () => {
    // Disc: moments (1, 1, 2): the distinct one is the largest. Shaft: (1, 10, 10): the smallest.
    expect(spinMoment([1, 1, 2])).toBe(2);
    expect(spinMoment([1, 10, 10])).toBe(1);
    // A rotated tensor keeps its principal moments.
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const d = [1, 2, 5];
    const rot = [
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ];
    const m = rot.map((ri) =>
      rot.map((rj) => ri.reduce((sum, _, k) => sum + ri[k]! * d[k]! * rj[k]!, 0)),
    ) as unknown as Parameters<typeof principalMoments>[0];
    const p = principalMoments(m);
    expect(p[0]).toBeCloseTo(1, 12);
    expect(p[1]).toBeCloseTo(2, 12);
    expect(p[2]).toBeCloseTo(5, 12);
    // Two point masses of 1 kg at x = ±1 m: about z, 2 kg·m²; about x, 0.
    const point = (cx: number) => ({
      mass: 1,
      centerOfMass: [cx, 0, 0] as const,
      inertia: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ] as unknown as Parameters<typeof principalMoments>[0],
    });
    const both = combineBodies([point(1), point(-1)])!;
    expect(both.mass).toBe(2);
    expect(both.inertia[2]![2]).toBe(2);
    expect(both.inertia[0]![0]).toBe(0);
  });
});
