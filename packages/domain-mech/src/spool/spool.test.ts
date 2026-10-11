// The spool and cable (T9.3b). The acceptance: layer count and effective radius against a hand
// calculation for a 2.85 m, 3 mm cable on a 40 mm core, written out below with every step.

import {
  applyCommand,
  createDocument,
  type Command,
  type Drivetrain,
  type ManufaktureDocument,
  type Requirement,
  type StoredExpression,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import { measuredFrom, type MeasuredGeometry } from '../checks/measured';
import type { MechRecord } from '../checks/types';
import { analyseDrivetrain } from '../drivetrain/analysis';
import { drivetrainNeeds } from '../drivetrain/chain';
import { builtinRef } from '../parts/catalog';
import { analyseSpool } from './analysis';
import {
  FLANGE_CLEARANCE_GUIDE,
  SPOOL_BEND_RATIO,
  SPOOL_FAIRLEAD_BEND_RATIO,
  SPOOL_FLANGE_CLEARANCE,
  SPOOL_LAYERS,
  SPOOL_RADIUS_OUT,
  SPOOL_RADIUS_WOUND,
  SPOOL_STRETCH,
  SPOOL_TRAVEL,
} from './records';
import {
  MAX_LAYERS,
  bendRatio,
  effectiveRadius,
  layersWound,
  radiusSteps,
  spoolAt,
  turnsPerLayer,
  wind,
} from './winding';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const NO_VARIABLES: VariableLookup = () => undefined;
const TAU = 2 * Math.PI;

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/** The 3 mm AmSteel-Blue from the built-in catalog as `pp#2`, a spool instance, requirements. */
function design(requirements: Requirement[] = []): ManufaktureDocument {
  const rope = builtinRef('rope/samson-amsteel-blue-3mm')!;
  return apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    { type: 'setPurchasedUse', use: { id: 'pp#2', entry: rope, alternates: [], name: 'Cable' } },
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
    ...(requirements.length > 0 ? [{ type: 'setMechRequirements', requirements } as Command] : []),
  );
}

const REQUIREMENTS: Requirement[] = [
  {
    id: 'req#1',
    name: 'R4 Cable travel',
    quantity: 'travel',
    comparison: '>=',
    value: x('2.85 m'),
  },
  {
    id: 'req#2',
    name: 'R1 Maximum force',
    quantity: 'maxForce',
    comparison: '>=',
    value: x('890 N'),
  },
  {
    id: 'req#3',
    name: 'R3 Peak cable speed',
    quantity: 'peakCableSpeed',
    comparison: '>=',
    value: x('2 m/s'),
  },
];

type Spool = Extract<Drivetrain['output'], { kind: 'spool' }>;

/** The example spool, with `output` over it and the `without` dimensions left untyped. */
const drivetrain = (
  output: Partial<Spool> = {},
  without: readonly ('core' | 'flange' | 'width')[] = [],
): Drivetrain => {
  const o: Spool = {
    kind: 'spool',
    instance: 'inst#1',
    cable: 'pp#2',
    length: x('2.85 m'),
    core: x('40 mm'),
    width: x('20 mm'),
    flange: x('80 mm'),
    inertia: x('1e-4 kg*m^2'),
    ...output,
  };
  for (const k of without) delete o[k];
  return { id: 'drive#3', name: 'Direct', assembly: 'assembly#1', stages: [], output: o };
};

function analyse(doc: ManufaktureDocument, d: Drivetrain, measured?: MeasuredGeometry) {
  const a = analyseSpool(
    {
      document: doc,
      variables: NO_VARIABLES,
      ...(measured !== undefined ? { measured } : {}),
      partBodies: (p) => (p === 'part#1' ? ['revolve#1'] : undefined),
    },
    d,
  );
  if (a === undefined) throw new Error('no spool');
  return a;
}

const record = (a: { records: MechRecord[] }, check: string): MechRecord => {
  const r = a.records.find((x) => x.check === check);
  if (r === undefined) throw new Error(`no ${check}`);
  return r;
};

// The hand calculation. Cable d = 3 mm, core D_core = 40 mm (r_core = 20 mm), width between the
// flanges w = 20 mm, flange D_f = 80 mm, cable length L = 2.85 m. Simple stacked winding.
//
//   Turns per layer   N = floor(w / d) = floor(20 / 3) = floor(6.67) = 6
//   Pitch radii       r_n = r_core + d/2 + (n - 1) d
//                     r_1 = 20 + 1.5         = 21.5 mm
//                     r_2 = 20 + 1.5 + 3     = 24.5 mm
//                     r_3 = 20 + 1.5 + 6     = 27.5 mm
//                     r_4 = 20 + 1.5 + 9     = 30.5 mm
//   Cable per layer   L_n = N · 2π r_n
//                     L_1 = 6 · 2π · 0.0215 = 0.81053 m   (through layer 1: 0.81053 m)
//                     L_2 = 6 · 2π · 0.0245 = 0.92363 m   (through layer 2: 1.73416 m)
//                     L_3 = 6 · 2π · 0.0275 = 1.03673 m   (through layer 3: 2.77088 m)
//                     2.85 - 2.77088 = 0.07912 m left for layer 4,
//                     0.07912 / (2π · 0.0305) = 0.413 turns
//   Layers wound      4 (the fourth partial)
//   Effective radius  at zero extension (full wind): r_4 = 30.5 mm
//                     at full payout:                r_1 = 21.5 mm
//                     at 1.0 m out: 1.85 m still wound, between 1.73416 and 2.77088: layer 3,
//                     r_3 = 27.5 mm
//   Torque at 890 N   wound: 890 · 0.0305 = 27.145 N·m; out: 890 · 0.0215 = 19.135 N·m
//   Spool speed at    wound: 2 / 0.0305 = 65.57 rad/s; out: 2 / 0.0215 = 93.02 rad/s
//   2 m/s
//   Flange clearance  c = D_f/2 - (r_core + n d) = 40 - (20 + 4 · 3) = 8 mm, against
//                     2 d = 6 mm: margin (8 - 6) / 6 = 0.333
//   Bend ratio        D/d = 40 / 3 = 13.33 against the rope's minimum 8: margin 0.667
//   Stretch           ε = 0.007 · 890 / (0.2 · 1000 kgf · 9.80665) = 0.0031765;
//                     ΔL = 0.0031765 · 2.85 = 9.053 mm
const r1 = 0.0215;
const r3 = 0.0275;
const r4 = 0.0305;
const L1 = 6 * TAU * r1;
const L2 = 6 * TAU * 0.0245;
const L3 = 6 * TAU * r3;

describe('the winding, by hand (the acceptance)', () => {
  it('gives 4 layers, 30.5 mm at full wind and 21.5 mm at full payout', () => {
    expect(L1).toBeCloseTo(0.81053, 5);
    expect(L1 + L2).toBeCloseTo(1.73416, 5);
    expect(L1 + L2 + L3).toBeCloseTo(2.77088, 5);
    const w = wind({ core: 0.04, width: 0.02 }, 0.003, 2.85);
    expect(turnsPerLayer(0.02, 0.003)).toBe(6);
    expect(w.turnsPerLayer).toBe(6);
    expect(w.layers.map((l) => l.n)).toEqual([1, 2, 3, 4]);
    expect(w.layers.map((l) => l.radius * 1000)).toEqual([
      expect.closeTo(21.5, 9),
      expect.closeTo(24.5, 9),
      expect.closeTo(27.5, 9),
      expect.closeTo(30.5, 9),
    ]);
    expect(w.layers[3]!.length).toBeCloseTo(2.85 - 2.77088, 4);
    expect(w.layers[3]!.turns).toBeCloseTo(0.413, 3);
    expect(effectiveRadius(w, 0)).toBeCloseTo(r4, 12);
    expect(effectiveRadius(w, 2.85)).toBeCloseTo(r1, 12);
    expect(effectiveRadius(w, 1.0)).toBeCloseTo(r3, 12);
  });

  it('pays out from the outermost layer first, a layer at a time', () => {
    const w = wind({ core: 0.04, width: 0.02 }, 0.003, 2.85);
    const outer = 2.85 - (L1 + L2 + L3); // the partial fourth layer
    expect(layersWound(w, 0)).toBe(4);
    expect(layersWound(w, outer - 1e-6)).toBe(4);
    expect(layersWound(w, outer + 1e-6)).toBe(3);
    expect(layersWound(w, outer + L3 + 1e-6)).toBe(2);
    expect(layersWound(w, 2.85 - L1 + 1e-6)).toBe(1);
    expect(layersWound(w, 2.85)).toBe(0);
    // Past the ends: clamped.
    expect(layersWound(w, -1)).toBe(4);
    expect(effectiveRadius(w, 10)).toBeCloseTo(r1, 12);
    const steps = radiusSteps(w);
    expect(steps.map((s) => s.layer)).toEqual([4, 3, 2, 1]);
    expect(steps[0]!.from).toBeCloseTo(0, 12);
    expect(steps[0]!.to).toBeCloseTo(outer, 9);
    expect(steps[3]!.to).toBeCloseTo(2.85, 9);
    const at = spoolAt(w, 1.0)!;
    expect(at.layer).toBe(3);
    expect(at.speedPerCableSpeed).toBeCloseTo(1 / r3, 9);
    expect(bendRatio(0.04, 0.003)).toBeCloseTo(13.333, 3);
  });

  it('fits no turn when the cable is wider than the space', () => {
    const w = wind({ core: 0.04, width: 0.002 }, 0.003, 1);
    expect(w.turnsPerLayer).toBe(0);
    expect(w.layers).toEqual([]);
    expect(effectiveRadius(w, 0)).toBeUndefined();
    // An exact fit is not lost to rounding.
    expect(turnsPerLayer(0.02, 0.002)).toBe(10);
  });
});

describe('the spool output, read from the document', () => {
  it('states the hand calculation as records, from the rope’s catalog entry', () => {
    const a = analyse(design(REQUIREMENTS), drivetrain());
    expect(a.problems).toEqual([]);
    expect(a.cable.diameter.value).toBeCloseTo(0.003, 12);
    expect(a.layers).toBe(4);
    expect(a.radiusWound).toBeCloseTo(r4, 12);
    expect(a.radiusOut).toBeCloseTo(r1, 12);
    expect(a.flangeClearance).toBeCloseTo(0.008, 12);

    const layers = record(a, SPOOL_LAYERS);
    expect(layers.status).toBe('ok');
    expect(layers.derived.find((v) => v.symbol === 'N')?.value).toBe(6);
    expect(layers.derived.find((v) => v.symbol === 'm_cable')?.value).toBeCloseTo(0.0074 * 2.85, 9);
    expect(layers.inputRefs.d).toMatchObject({ kind: 'catalog', field: 'diameter' });

    const wound = record(a, SPOOL_RADIUS_WOUND);
    expect(wound.result).toBeCloseTo(r4, 12);
    expect(wound.derived.find((v) => v.symbol === 'T')?.value).toBeCloseTo(27.145, 9);
    expect(wound.derived.find((v) => v.symbol === 'ω')?.value).toBeCloseTo(65.574, 3);
    expect(wound.inputRefs.F).toEqual({ kind: 'requirement', id: 'req#2' });
    const out = record(a, SPOOL_RADIUS_OUT);
    expect(out.result).toBeCloseTo(r1, 12);
    expect(out.derived.find((v) => v.symbol === 'T')?.value).toBeCloseTo(19.135, 9);
    expect(out.derived.find((v) => v.symbol === 'ω')?.value).toBeCloseTo(93.023, 3);

    const clearance = record(a, SPOOL_FLANGE_CLEARANCE);
    expect(clearance.limit).toBeCloseTo(FLANGE_CLEARANCE_GUIDE * 0.003, 12);
    expect(clearance.margin).toBeCloseTo(1 / 3, 9);
    expect(clearance.status).toBe('ok');

    const bend = record(a, SPOOL_BEND_RATIO);
    expect(bend.result).toBeCloseTo(40 / 3, 9);
    expect(bend.limit).toBe(8);
    expect(bend.margin).toBeCloseTo(40 / 3 / 8 - 1, 9);
    expect(bend.status).toBe('ok');

    const travel = record(a, SPOOL_TRAVEL);
    expect(travel.result).toBeCloseTo(2.85, 12);
    expect(travel.limit).toBeCloseTo(2.85, 12);
    expect(travel.status).toBe('ok');

    const stretch = record(a, SPOOL_STRETCH);
    expect(stretch.result).toBeCloseTo(((0.007 * 890) / (0.2 * 1000 * 9.80665)) * 2.85, 12);
    expect(stretch.result! * 1000).toBeCloseTo(9.053, 3);
    expect(a.records.some((r) => r.check === SPOOL_FAIRLEAD_BEND_RATIO)).toBe(false);
    // Nothing is called safe: statuses only.
    for (const r of a.records) expect(['ok', 'warning', 'unknown']).toContain(r.status);
    expect(JSON.stringify(a.records)).not.toMatch(/\bsafe\b|certif|complian/i);
  });

  it('warns on a fairlead bend below the rope’s minimum, a cable over the flange and a short cable', () => {
    const doc = design([
      { id: 'req#1', name: 'Travel', quantity: 'travel', comparison: '>=', value: x('3 m') },
    ]);
    const a = analyse(
      doc,
      drivetrain({ flange: x('60 mm'), fairlead: { bendDiameter: x('20 mm') } }),
    );
    const fair = record(a, SPOOL_FAIRLEAD_BEND_RATIO);
    expect(fair.result).toBeCloseTo(20 / 3, 9);
    expect(fair.status).toBe('warning');
    expect(fair.note).toMatch(/suggested ratio of 10/);
    // 30 - (20 + 12) = -2 mm: the top layer stands above the flange.
    const clearance = record(a, SPOOL_FLANGE_CLEARANCE);
    expect(clearance.result).toBeCloseTo(-0.002, 12);
    expect(clearance.status).toBe('warning');
    const travel = record(a, SPOOL_TRAVEL);
    expect(travel.status).toBe('warning');
    expect(travel.margin).toBeCloseTo(2.85 / 3 - 1, 9);
  });

  it('shows the length with no verdict when no travel requirement applies', () => {
    const a = analyse(design(), drivetrain());
    const travel = record(a, SPOOL_TRAVEL);
    expect(travel.status).toBe('ok');
    expect(travel.limit).toBeUndefined();
    expect(travel.note).toMatch(/No travel requirement/);
    // The stretch needs a force.
    const stretch = record(a, SPOOL_STRETCH);
    expect(stretch.status).toBe('unknown');
    expect(stretch.missing).toEqual(['Maximum force']);
  });

  it('reads the flange from the body’s bounding box and names what must be typed', () => {
    // A spool turning about the part's y axis: 80 mm across, 26 mm long (20 mm between two 3 mm
    // flanges). Regen reports millimetres; measuredFrom turns them into metres.
    const measured = measuredFrom([
      {
        type: 'body',
        part: 'part#1',
        body: 'revolve#1',
        measure: {
          volume: 1,
          area: 1,
          centerOfMass: [0, 13, 0],
          volumeInertia: [
            [1, 0, 0],
            [0, 2, 0],
            [0, 0, 1],
          ],
          boundingBox: { min: [-40, 0, -40], max: [40, 26, 40] },
        },
      },
    ]);
    const doc = design();
    const typed = drivetrain({}, ['flange', 'core']);
    const a = analyse(doc, typed, measured);
    expect(a.box).toMatchObject({ axis: 'y' });
    expect(a.box!.outerDiameter).toBeCloseTo(0.08, 12);
    expect(a.box!.overallLength).toBeCloseTo(0.026, 12);
    expect(a.flange).toMatchObject({ source: 'measured' });
    expect(a.flange.value).toBeCloseTo(0.08, 12);
    expect(a.core.missing).toMatch(
      /type the core diameter: the body's bounding box gives only its outside diameter \(80 mm\) and overall length \(26 mm\)/,
    );
    const layers = record(a, SPOOL_LAYERS);
    expect(layers.status).toBe('unknown');
    expect(layers.missing).toEqual(['Core diameter']);
    expect(record(a, SPOOL_FLANGE_CLEARANCE).assumptions.join(' ')).toMatch(/bounding box/);
    // The body is asked for: the flange comes from it.
    const withDrive = apply(doc, { type: 'setDrivetrain', drivetrain: typed });
    expect(drivetrainNeeds(withDrive, (p) => (p === 'part#1' ? ['revolve#1'] : undefined))).toEqual(
      [{ part: 'part#1', body: 'revolve#1' }],
    );

    // A width longer than the body is reported; a box with no round section is refused.
    const long = analyse(doc, drivetrain({ width: x('30 mm') }, ['flange']), measured);
    expect(long.problems.map((p) => p.message).join()).toMatch(
      /longer than the spool body \(26 mm/,
    );
    const cube = measuredFrom([
      {
        type: 'body',
        part: 'part#1',
        body: 'revolve#1',
        measure: {
          volume: 1,
          area: 1,
          centerOfMass: null,
          volumeInertia: null,
          boundingBox: { min: [0, 0, 0], max: [50, 50, 50] },
        },
      },
    ]);
    const c = analyse(doc, typed, cube);
    expect(c.flange.value).toBeUndefined();
    expect(c.flange.missing).toMatch(/50 mm x 50 mm x 50 mm.*type the flange diameter/);
  });

  it('refuses a cable that is not a rope, and leaves other outputs alone', () => {
    let doc = design();
    doc = apply(doc, {
      type: 'setPurchasedUse',
      use: { id: 'pp#9', entry: builtinRef('bearing/skf-6005-2rsh')!, alternates: [] },
    });
    const a = analyse(doc, drivetrain({ cable: 'pp#9' }));
    expect(a.problems).toEqual([
      {
        path: ['output', 'cable'],
        message: 'pp#9 is a bearing, not a rope or cable',
        kind: 'structure',
      },
    ]);
    expect(record(a, SPOOL_LAYERS).status).toBe('unknown');
    const rotary: Drivetrain = { ...drivetrain(), output: { kind: 'rotary' } };
    expect(analyseSpool({ document: doc, variables: NO_VARIABLES }, rotary)).toBeUndefined();
  });

  it('refuses a winding of more than MAX_LAYERS layers instead of stalling', () => {
    // A typo: 100 km of 3 mm cable on a 40 mm core, 20 mm wide. n layers hold about
    // 6 · 2π (0.0215 n + 0.0015 n²) m, so 100 km needs about 1,330 layers.
    const w = wind({ core: 0.04, width: 0.02 }, 0.003, 100_000);
    expect(w.tooManyLayers).toBe(true);
    expect(w.layers).toEqual([]);
    expect(MAX_LAYERS).toBe(1000);
    const a = analyse(design(), drivetrain({ length: x('100 km') }));
    const layers = record(a, SPOOL_LAYERS);
    expect(layers.status).toBe('unknown');
    expect(layers.note).toMatch(/more than 1000 layers/);
    expect(record(a, SPOOL_RADIUS_WOUND).status).toBe('unknown');
  });

  it('says a typed length must be above zero, and the drivetrain lists the spool’s problems', () => {
    const d = drivetrain({ length: x('0 m') });
    const a = analyse(design(), d);
    expect(a.problems).toEqual([
      { path: ['output', 'length'], message: 'the cable length must be above zero', kind: 'value' },
    ]);
    expect(record(a, SPOOL_LAYERS).note).toMatch(
      /Cable length on the spool \(the typed cable length "0 m" must be above zero\)/,
    );
    const whole = analyseDrivetrain({ document: design(), variables: NO_VARIABLES }, d);
    expect(whole.problems).toContainEqual({
      path: ['output', 'length'],
      message: 'the cable length must be above zero',
      kind: 'value',
    });
  });

  it('rides on the drivetrain analysis', () => {
    const doc = design(REQUIREMENTS);
    const a = analyseDrivetrain({ document: doc, variables: NO_VARIABLES }, drivetrain());
    expect(a.spool?.layers).toBe(4);
    expect(a.spool?.steps?.[0]?.radius).toBeCloseTo(r4, 12);
    // Every flange typed and no width to compare: the body is not asked for.
    const typedOnly = drivetrain({}, ['width']);
    expect(
      drivetrainNeeds(apply(doc, { type: 'setDrivetrain', drivetrain: typedOnly }), () => [
        'revolve#1',
      ]),
    ).toEqual([]);
  });
});
