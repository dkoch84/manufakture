import {
  applyCommand,
  createDocument,
  parseDocument,
  serialize,
  storedExpression,
  type Command,
  type Drivetrain,
  type ManufaktureDocument,
  type Requirement,
} from '@manufakture/core';
import { DISCLAIMER_SHORT, builtinRef, createMechEvaluation } from '@manufakture/domain-mech';
import type { DomainEvaluationResult } from '@manufakture/regen';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../../model/model';
import { createDocumentStore } from '../../state/document';
import { DrivetrainPanel, MechDrivetrainButton } from './DrivetrainPanel';

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** A motor (rotor 3.0e-4 kg·m²) and a steel spool part shown by inst#1 in an assembly. */
function design(): ManufaktureDocument {
  const doc = apply(
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
  return { ...doc, parts: doc.parts.map((p) => ({ ...p, material: 'steel' })) };
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

function setup(doc = design()) {
  const documents = createDocumentStore(doc);
  const model = createModelStore();
  render(<DrivetrainPanel documents={documents} model={model} onClose={() => {}} />);
  return { documents, model };
}

const u = (source: string) => storedExpression(source, design().units);

/**
 * The design with the 3 mm AmSteel-Blue as pp#3 and a spool drivetrain on inst#1: 2.85 m on a
 * 40 mm core, 20 mm wide, 80 mm flanges, with `output` over it and `without` left untyped.
 */
function spoolDesign(
  output: Record<string, unknown> = {},
  requirements: Requirement[] = [],
  without: readonly string[] = [],
): ManufaktureDocument {
  const o: Record<string, unknown> = {
    kind: 'spool',
    instance: 'inst#1',
    cable: 'pp#3',
    length: u('2.85 m'),
    core: u('40 mm'),
    width: u('20 mm'),
    flange: u('80 mm'),
    inertia: u('1e-4 kg*m^2'),
    ...output,
  };
  for (const k of without) delete o[k];
  return apply(
    design(),
    {
      type: 'setPurchasedUse',
      use: {
        id: 'pp#3',
        entry: builtinRef('rope/samson-amsteel-blue-3mm')!,
        alternates: [],
        name: 'Cable',
      },
    },
    {
      type: 'setDrivetrain',
      drivetrain: {
        id: 'drive#4',
        name: 'Main',
        assembly: 'assembly#1',
        stages: [{ id: 'stage#5', kind: 'motor', use: 'pp#2' }],
        output: o as Drivetrain['output'],
      },
    },
    ...(requirements.length > 0 ? [{ type: 'setMechRequirements', requirements } as Command] : []),
  );
}

const WORDS = /\b(safe|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*)\b/i;

describe('the drivetrain panel', () => {
  it('opens from the toolbar with the notice', () => {
    const documents = createDocumentStore(design());
    render(
      <MechDrivetrainButton documents={documents} model={createModelStore()} disabled={false} />,
    );
    fireEvent.click(screen.getByTestId('dt-open'));
    expect(screen.getByTestId('dt-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    fireEvent.click(screen.getByTestId('dt-close'));
    expect(screen.queryByTestId('dt-panel')).toBeNull();
  });

  it('builds a direct drive, then a 5:1 belt drive, with the reflected inertia and torque', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('dt-new'));
    type('dt-name', 'Main');
    type('dt-assembly', 'assembly#1');
    type('dt-stage-use-0', 'pp#2');
    // The spool's inertia typed (the steel disc of the domain's hand calculation).
    type('dt-output-instance', 'inst#1');
    type('dt-output-inertia', '1.541344e-3 kg*m^2');
    fireEvent.click(screen.getByTestId('dt-save'));
    expect(screen.getByTestId('dt-message').textContent).toBe('Saved drivetrain Main.');
    const saved = documents.getState().document.mech!.drivetrains![0]!;
    expect(saved).toMatchObject({
      id: 'drive#1',
      name: 'Main',
      assembly: 'assembly#1',
      stages: [{ id: 'stage#1', kind: 'motor', use: 'pp#2' }],
      output: { kind: 'rotary', instance: 'inst#1' },
    });
    // Direct drive: 3.0e-4 + 1.541344e-3 = 1.841344e-3 kg·m², at the motor and the output.
    expect(screen.getByTestId('dt-ratio').textContent).toBe('1 : 1');
    expect(screen.getByTestId('dt-inertia-motor').textContent).toBe('0.001841 kg·m^2');
    expect(screen.getByTestId('dt-inertia-output').textContent).toBe('0.001841 kg·m^2');
    type('dt-torque-out', '22.25 N*m');
    expect(screen.getByTestId('dt-torque-result').textContent).toMatch(/22\.25 N·m/);

    // A 5:1 belt, 15 to 75 teeth, 0.95, its pulleys 4e-5 kg·m² at the motor pulley.
    type('dt-add-kind', 'belt');
    fireEvent.click(screen.getByTestId('dt-add-stage'));
    type('dt-stage-ratioBy-1', 'teeth');
    type('dt-stage-driver-1', '15');
    type('dt-stage-driven-1', '75');
    type('dt-stage-efficiency-1', '0.95');
    type('dt-stage-inertia-1', '4e-5 kg*m^2');
    fireEvent.click(screen.getByTestId('dt-save'));
    expect(documents.getState().document.mech!.drivetrains![0]!.stages[1]).toMatchObject({
      id: 'stage#2',
      kind: 'belt',
      ratio: { driver: { source: '15' }, driven: { source: '75' } },
    });
    // 3.0e-4 + 4e-5 + 1.541344e-3 / 25 = 4.016538e-4 kg·m²; times 25 at the output.
    expect(screen.getByTestId('dt-ratio').textContent).toBe('5 : 1');
    expect(screen.getByTestId('dt-efficiency').textContent).toBe('0.95');
    expect(screen.getByTestId('dt-inertia-motor').textContent).toBe('0.000402 kg·m^2');
    expect(screen.getByTestId('dt-inertia-output').textContent).toBe('0.010041 kg·m^2');
    // 22.25 / (5 x 0.95) = 4.684 N·m driving; 22.25 x 0.95 / 5 = 4.2275 back-driven.
    type('dt-torque-out', '22.25 N*m');
    expect(screen.getByTestId('dt-torque-result').textContent).toMatch(/4\.68 N·m/);
    type('dt-torque-flow', 'back-driven');
    expect(screen.getByTestId('dt-torque-result').textContent).toMatch(/4\.23 N·m/);
    type('dt-torque-flow', 'driving');
    type('dt-torque-accel', '40 rad/s^2');
    expect(screen.getByTestId('dt-torque-result').textContent).toMatch(/4\.77 N·m/);
    // Back-driven, speeding up: 4.2275 - 0.0797 = 4.15 N·m against the motion.
    type('dt-torque-flow', 'back-driven');
    expect(screen.getByTestId('dt-torque-result').textContent).toMatch(/4\.15 N·m/);
    expect(screen.getByTestId('dt-torque-signs').textContent).toMatch(/speeds the motion up/);
    expect(screen.getByTestId('dt-results').textContent).not.toMatch(WORDS);

    // Saved to a file and loaded back.
    const doc = documents.getState().document;
    const loaded = parseDocument(JSON.parse(serialize(doc)));
    expect(loaded.ok && loaded.value.document.mech).toEqual(doc.mech);
  });

  it('refuses a value that does not read and a chain without its motor first', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('dt-new'));
    type('dt-stage-use-0', 'pp#2');
    fireEvent.click(screen.getByTestId('dt-add-stage'));
    type('dt-stage-ratio-1', '3');
    type('dt-stage-efficiency-1', '1.2');
    fireEvent.click(screen.getByTestId('dt-save'));
    expect(screen.getByTestId('dt-problems').textContent).toMatch(
      /stages\.1\.efficiency: the efficiency must be at most 1/,
    );
    type('dt-stage-efficiency-1', '0.9');
    fireEvent.click(screen.getByTestId('dt-stage-down-0'));
    fireEvent.click(screen.getByTestId('dt-save'));
    expect(screen.getByTestId('dt-problems').textContent).toMatch(/the chain starts at a motor/);
    expect(documents.getState().document.mech?.drivetrains).toBeUndefined();
    fireEvent.click(screen.getByTestId('dt-stage-up-1'));
    fireEvent.click(screen.getByTestId('dt-save'));
    expect(documents.getState().document.mech!.drivetrains).toHaveLength(1);
  });

  it('shows regen’s measured inertia, and the stages that name something missing', () => {
    let doc = design();
    doc = apply(doc, {
      type: 'setDrivetrain',
      drivetrain: {
        id: 'drive#1',
        name: 'Main',
        assembly: 'assembly#1',
        stages: [
          { id: 'stage#1', kind: 'motor', use: 'pp#2' },
          { id: 'stage#2', kind: 'shaft', instance: 'inst#7', bearings: [] },
        ],
        output: { kind: 'rotary', instance: 'inst#1' },
      },
    });
    // What regen gives: the spool measured as a steel disc, R 50 mm, 20 mm thick (mm, mm⁵).
    const V = Math.PI * 50 ** 2 * 20;
    const out = createMechEvaluation({ implementation: 1 }).evaluate(
      {
        document: doc,
        data: {},
        variables: new Map(),
        parts: [{ partId: 'part#1', built: true, bodies: ['extrude#1'] }],
        assemblies: [],
      },
      [
        {
          type: 'body',
          part: 'part#1',
          body: 'extrude#1',
          measure: {
            volume: V,
            area: 0,
            centerOfMass: [0, 0, 10],
            volumeInertia: [
              [(V * (3 * 50 ** 2 + 20 ** 2)) / 12, 0, 0],
              [0, (V * (3 * 50 ** 2 + 20 ** 2)) / 12, 0],
              [0, 0, (V * 50 ** 2) / 2],
            ],
            boundingBox: null,
          },
        },
      ],
    );
    const evaluation: DomainEvaluationResult = {
      namespace: 'mech',
      ...(out.data === undefined ? {} : { data: out.data }),
      warnings: [...(out.warnings ?? [])],
      ms: 1,
    };
    // Regen's evaluations of an older document (a regen that failed since) are not shown.
    const model = createModelStore();
    model.setState({ evaluations: [evaluation], document: design() });
    const stale = createDocumentStore(doc);
    const { unmount } = render(
      <DrivetrainPanel documents={stale} model={model} onClose={() => {}} />,
    );
    expect(screen.getByTestId('dt-not-measured')).toBeTruthy();
    unmount();
    model.setState({ document: doc });
    const documents = createDocumentStore(doc);
    render(<MechDrivetrainButton documents={documents} model={model} disabled={false} />);
    expect(screen.getByTestId('dt-open').textContent).toBe('Drivetrain (1)');
    fireEvent.click(screen.getByTestId('dt-open'));
    expect(screen.queryByTestId('dt-not-measured')).toBeNull();
    expect(screen.getByTestId('dt-warnings').textContent).toBe(
      'stages.1.instance: names instance inst#7, which Trainer does not have',
    );
    expect(screen.getByTestId('dt-element-2').textContent).toMatch(/0\.001541 kg·m\^2/);
    expect(screen.getByTestId('dt-element-2').textContent).toMatch(/measured: extrude#1 of part#1/);
    expect(screen.getByTestId('dt-inertia-motor').textContent).toBe('not known');
    fireEvent.click(screen.getByTestId('dt-working-toggle'));
    expect(screen.getByTestId('dt-working').textContent).toMatch(
      /Missing: Shaft \(stage#2\) \(assembly#1 has no instance inst#7\)/,
    );
  });

  it('shows the spool and cable: layers, effective radius, torque, speed and margins', () => {
    // The domain's hand calculation: 2.85 m of 3 mm AmSteel-Blue on a 40 mm core, 20 mm wide,
    // 80 mm flanges: 4 layers, 30.5 mm at full wind, 21.5 mm at full payout. At 890 N:
    // 890 x 0.0305 = 27.1 N·m and 890 x 0.0215 = 19.1 N·m; at 2 m/s: 2 / 0.0305 = 65.6 rad/s
    // (626.2 rpm) and 2 / 0.0215 = 93.0 rad/s (888.3 rpm).
    setup(
      spoolDesign({}, [
        { id: 'req#1', name: 'Force', quantity: 'maxForce', comparison: '>=', value: u('890 N') },
        {
          id: 'req#2',
          name: 'Speed',
          quantity: 'peakCableSpeed',
          comparison: '>=',
          value: u('2 m/s'),
        },
      ]),
    );
    expect(screen.getByTestId('dt-spool-spool.layers').textContent).toMatch(/^Layers wound4ok/);
    expect(screen.getByTestId('dt-spool-spool.radius-wound').textContent).toMatch(/30\.5 mm/);
    expect(screen.getByTestId('dt-spool-spool.radius-out').textContent).toMatch(/21\.5 mm/);
    expect(screen.getByTestId('dt-spool-at-spool.radius-wound').textContent).toMatch(
      /27\.1 N·m at 890 N; 65\.6 rad\/s \(626\.\d+ rpm\) at 2\.00 m\/s/,
    );
    expect(screen.getByTestId('dt-spool-at-spool.radius-out').textContent).toMatch(
      /19\.1 N·m at 890 N; 93\.0 rad\/s \(888\.\d+ rpm\) at 2\.00 m\/s/,
    );
    const clearance = screen.getByTestId('dt-spool-spool.flange-clearance');
    expect(clearance.textContent).toMatch(/8 mm.*against 6 mm, margin 33\.333 %/);
    expect(clearance.getAttribute('data-status')).toBe('ok');
    expect(screen.getByTestId('dt-spool-spool.travel').textContent).toMatch(
      /No travel requirement/,
    );
    expect(screen.getByTestId('dt-spool-steps').textContent).toMatch(/layer 4, 30\.5 mm/);
    expect(screen.getByTestId('dt-results').textContent).not.toMatch(WORDS);
  });

  it('shows no torque or speed on the radius rows without those requirements', () => {
    setup(spoolDesign());
    expect(screen.queryByTestId('dt-spool-at-spool.radius-wound')).toBeNull();
  });

  it('lists a width longer than the spool body regen measured, and counts it', () => {
    // No flange typed: regen measures the body, 80 mm across and 26 mm along y; 30 mm typed.
    const doc = spoolDesign({ width: u('30 mm') }, [], ['flange']);
    const out = createMechEvaluation({ implementation: 1 }).evaluate(
      {
        document: doc,
        data: {},
        variables: new Map(),
        parts: [{ partId: 'part#1', built: true, bodies: ['extrude#1'] }],
        assemblies: [],
      },
      [
        {
          type: 'body',
          part: 'part#1',
          body: 'extrude#1',
          measure: {
            volume: 1,
            area: 1,
            centerOfMass: null,
            volumeInertia: null,
            boundingBox: { min: [-40, 0, -40], max: [40, 26, 40] },
          },
        },
      ],
    );
    const model = createModelStore();
    model.setState({
      evaluations: [
        {
          namespace: 'mech',
          ...(out.data === undefined ? {} : { data: out.data }),
          warnings: [...(out.warnings ?? [])],
          ms: 1,
        },
      ],
      document: doc,
    });
    const documents = createDocumentStore(doc);
    render(<MechDrivetrainButton documents={documents} model={model} disabled={false} />);
    expect(screen.getByTestId('dt-open').textContent).toBe('Drivetrain (1)');
    fireEvent.click(screen.getByTestId('dt-open'));
    expect(screen.getByTestId('dt-warnings').textContent).toBe(
      'output.width: the width between the flanges is longer than the spool body (26 mm along its axis)',
    );
    // The flange read from the body (80 mm): 30 / 3 = 10 turns a layer, 2 layers for 2.85 m
    // (1.351 m, then 1.539 m), so 40 - (20 + 2 x 3) = 14 mm over the top layer.
    expect(screen.getByTestId('dt-spool-spool.flange-clearance').textContent).toMatch(
      /^Flange clearance over the top layer14 mm/,
    );
  });

  it('refuses to save a spool whose cable length is not above zero', () => {
    const { documents } = setup(spoolDesign());
    type('dt-output-length', '0 m');
    fireEvent.click(screen.getByTestId('dt-save'));
    expect(screen.getByTestId('dt-problems').textContent).toBe(
      'output.length: the cable length must be above zero',
    );
    const stored = documents.getState().document.mech!.drivetrains![0]!.output;
    expect(stored.kind === 'spool' && stored.length.source).toBe('2.85 m');
  });
});
