// The electrical system model (T9.7a): terminals by role, catalog and override; references,
// dangling terminals and mismatched kinds; harness lengths typed and measured between instances;
// and the acceptance, the cable trainer's system with a current on every connection once the
// simulation supplies its series.

import {
  applyCommand,
  createDocument,
  type Command,
  type Electrical,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import { simulationFrom } from '../../checks/simulation';
import { builtinRef } from '../../parts/catalog';
import { templateCommand } from '../../requirements/templates';
import { SIGNAL_ASSUMPTION, connectionCurrents } from './currents';
import { ROLE_DEFS, electricalSeries } from './roles';
import { analyseElectrical, electricalWarnings, type ElectricalAnalysis } from './system';
import { electricalTemplateCommand } from './template';

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

const ref = (id: string) => {
  const r = builtinRef(id);
  if (r === undefined) throw new Error(`no built-in ${id}`);
  return r;
};

/** Purchased parts (a fuse, an XT60, a wire, a motor) and an assembly with two instances. */
function design(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    ...(
      [
        ['pp#1', 'fuse/littelfuse-tac-ato-58v-30a'],
        ['pp#2', 'connector/amass-xt60'],
        ['pp#3', 'wire/bntechgo-silicone-12awg'],
        ['pp#4', 'motor/odrive-d5065-270kv'],
      ] as const
    ).map(([id, entry]): Command => ({
      type: 'setPurchasedUse',
      use: { id, entry: ref(entry), alternates: [] },
    })),
    { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Trainer' },
    ...(
      [
        ['inst#1', 'Battery tray', [0, 0, 0]],
        ['inst#2', 'Controller mount', [300, 400, 0]],
      ] as const
    ).map(([id, name, t]): Command => ({
      type: 'addInstance',
      assemblyId: 'assembly#1',
      instance: {
        id,
        name,
        source: { part: 'part#1' },
        fixed: true,
        suppressed: false,
        pose: { translation: [...t], rotation: [0, 0, 0, 1] },
      },
    })),
  );
}

const withElectrical = (doc: ManufaktureDocument, electrical: Electrical) =>
  apply(doc, { type: 'setElectrical', electrical });

const analyse = (doc: ManufaktureDocument) =>
  analyseElectrical({ document: doc, variables: NO_VARIABLES });

const problemsOf = (a: ElectricalAnalysis, kind: string) =>
  a.problems.filter((p) => p.kind === kind).map((p) => p.message);

describe('terminals', () => {
  it('come from the role, the connector entry’s poles, or the component’s own list', () => {
    const doc = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Pack', role: 'pack' },
        { id: 'el#2', name: 'Controller', role: 'controller' },
        { id: 'el#3', name: 'XT60', role: 'connector', use: 'pp#2' },
        {
          id: 'el#4',
          name: 'Board',
          role: 'board',
          terminals: [
            { id: 'v5', name: '5 V', kind: 'power' },
            { id: 'v5', name: 'again', kind: 'power' },
          ],
        },
      ],
      connections: [],
      harness: [],
    });
    const a = analyse(doc);
    expect(a.components[0]!.terminals.map((t) => t.id)).toEqual(['+', '-']);
    expect(a.components[0]!.terminalsFrom).toBe('role');
    expect(a.components[1]!.terminals.map((t) => t.id)).toEqual([
      'bus+',
      'bus-',
      'a',
      'b',
      'c',
      'brake+',
      'brake-',
      'signal',
    ]);
    expect(a.components[2]!.terminals.map((t) => t.id)).toEqual(['1', '2']);
    expect(a.components[2]!.terminalsFrom).toBe('catalog');
    expect(a.components[2]!.entry?.family).toBe('connector');
    expect(a.components[3]!.terminalsFrom).toBe('typed');
    expect(problemsOf(a, 'structure')).toEqual(['terminal v5 is listed twice']);
  });

  it('are stable: every default id is one core accepts, and none repeats within a role', () => {
    // Schematic ports name these ids (T9.7d), so this list is a published contract.
    const ids = Object.fromEntries(
      Object.entries(ROLE_DEFS).map(([role, d]) => [role, d.terminals.map((t) => t.id)]),
    );
    expect(ids).toEqual({
      pack: ['+', '-'],
      bms: ['b+', 'b-', 'p+', 'p-', 'signal'],
      fuse: ['1', '2'],
      switch: ['1', '2'],
      precharge: ['1', '2'],
      controller: ['bus+', 'bus-', 'a', 'b', 'c', 'brake+', 'brake-', 'signal'],
      'brake-resistor': ['1', '2'],
      chopper: ['bus+', 'bus-', 'r+', 'r-', 'signal'],
      motor: ['a', 'b', 'c'],
      'charger-input': ['+', '-'],
      dcdc: ['in+', 'in-', 'out+', 'out-'],
      board: ['vin', 'gnd', 'signal'],
      encoder: ['vcc', 'gnd', 'signal'],
      'load-cell': ['exc+', 'exc-', 'sig+', 'sig-'],
      display: ['vcc', 'gnd', 'signal'],
      connector: ['1', '2'],
      other: [],
    });
    for (const list of Object.values(ids)) expect(new Set(list).size).toBe(list.length);
  });
});

describe('what is wrong', () => {
  it('reports missing parts, instances, components, terminals and connections as references', () => {
    const doc = withElectrical(design(), {
      assembly: 'assembly#1',
      components: [
        { id: 'el#1', name: 'Pack', role: 'pack', use: 'pp#9', instance: 'inst#9' },
        { id: 'el#2', name: 'Fuse', role: 'fuse', use: 'pp#1' },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: '+' },
          to: { component: 'el#2', terminal: '3' },
        },
        {
          id: 'conn#2',
          from: { component: 'el#7', terminal: '+' },
          to: { component: 'el#2', terminal: '1' },
        },
      ],
      harness: [
        {
          id: 'seg#1',
          from: { component: 'el#1' },
          to: { instance: 'inst#8' },
          length: x('300'),
          connections: ['conn#1', 'conn#9'],
        },
      ],
    });
    const a = analyse(doc);
    expect(problemsOf(a, 'reference')).toEqual([
      'names purchased part pp#9, which the design does not have',
      'names instance inst#9, which Trainer does not have',
      'names terminal 3 of Fuse (el#2), which it does not have',
      'names component el#7, which the system does not have',
      'names instance inst#8, which Trainer does not have',
      'names connection conn#9, which the system does not have',
    ]);
    const warnings = electricalWarnings(a);
    expect(
      warnings.map((w) =>
        w.code === 'mech-reference' ? [w.code, w.objectId, w.target] : [w.code],
      ),
    ).toEqual([
      ['mech-reference', 'el#1', 'pp#9'],
      ['mech-reference', 'el#1', 'inst#9'],
      ['mech-reference', 'conn#1', 'el#2/3'],
      ['mech-reference', 'conn#2', 'el#7'],
      ['mech-reference', 'seg#1', 'inst#8'],
      ['mech-reference', 'seg#1', 'conn#9'],
    ]);
    expect(warnings[0]!.message).toBe(
      'Electrical system, el#1: components.0.use: names purchased part pp#9, which the design does not have',
    );
  });

  it('reports a missing assembly, and instances named without one', () => {
    const doc = withElectrical(design(), {
      assembly: 'assembly#5',
      components: [{ id: 'el#1', name: 'Pack', role: 'pack', instance: 'inst#1' }],
      connections: [],
      harness: [],
    });
    // Reported on the component that names an instance in it.
    const a = analyse(doc);
    expect(problemsOf(a, 'reference')).toEqual([
      'names instance inst#1 of assembly assembly#5, which is not there',
    ]);
    expect(
      electricalWarnings(a).map((w) => (w.code === 'mech-reference' ? [w.objectId, w.target] : [])),
    ).toEqual([['el#1', 'assembly#5']]);
    // With nothing placed, once on the system.
    const unplaced = withElectrical(design(), {
      assembly: 'assembly#5',
      components: [{ id: 'el#1', name: 'Pack', role: 'pack' }],
      connections: [],
      harness: [],
    });
    expect(problemsOf(analyse(unplaced), 'reference')).toEqual(['there is no assembly assembly#5']);
    const loose = withElectrical(design(), {
      components: [{ id: 'el#1', name: 'Pack', role: 'pack', instance: 'inst#1' }],
      connections: [],
      harness: [],
    });
    expect(problemsOf(analyse(loose), 'reference')).toEqual([
      'names instance inst#1, but the electrical system names no assembly',
    ]);
  });

  it('reports terminals nothing connects to', () => {
    const doc = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Pack', role: 'pack' },
        { id: 'el#2', name: 'Fuse', role: 'fuse' },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: '+' },
          to: { component: 'el#2', terminal: '1' },
        },
      ],
      harness: [],
    });
    const a = analyse(doc);
    expect(problemsOf(a, 'dangling')).toEqual([
      'terminal - (-) of Pack (el#1) is not connected',
      'terminal 2 (2) of Fuse (el#2) is not connected',
    ]);
    const first = a.problems.find((p) => p.kind === 'dangling')!;
    expect(first.target).toBe('el#1/-');
    // The path uses the terminal's index in the component's terminals.
    expect(first.path).toEqual(['components', 0, 'terminals', 1]);
    // Dangling terminals are not references: no mech-reference warning for them.
    expect(electricalWarnings(a)).toEqual([]);
  });

  it('reports a part of the wrong family, a wire that is not one, and mismatched terminals', () => {
    const doc = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Fuse', role: 'fuse', use: 'pp#4' },
        { id: 'el#2', name: 'Controller', role: 'controller' },
        { id: 'el#3', name: 'Motor', role: 'motor' },
        { id: 'el#4', name: 'XT60', role: 'connector', use: 'pp#2' },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#2', terminal: 'bus+' },
          to: { component: 'el#2', terminal: 'signal' },
          wire: 'pp#1',
        },
        {
          id: 'conn#2',
          from: { component: 'el#2', terminal: 'a' },
          to: { component: 'el#4', terminal: '1' },
        },
        {
          id: 'conn#3',
          from: { component: 'el#4', terminal: '2' },
          to: { component: 'el#3', terminal: 'a' },
        },
        {
          id: 'conn#4',
          from: { component: 'el#2', terminal: 'b' },
          to: { component: 'el#3', terminal: 'b' },
          wire: 'pp#3',
        },
      ],
      harness: [],
    });
    const a = analyse(doc);
    expect(problemsOf(a, 'structure')).toEqual([
      'pp#4 is a motor, which a fuse does not use',
      'joins a power terminal (Controller (el#2) bus+) to a signal one (Controller (el#2) signal)',
      'pp#1 is a fuse, not a wire',
    ]);
    expect(a.connections[3]!.wire?.item).toMatch(/^Wire /);
  });

  it('reports a wire whose catalog entry does not resolve as a reference', () => {
    const doc = apply(design(), {
      type: 'setPurchasedUse',
      use: { id: 'pp#5', entry: { source: 'document', id: 'entry#9' }, alternates: [] },
    });
    const a = analyse(
      withElectrical(doc, {
        components: [{ id: 'el#1', name: 'Fuse', role: 'fuse' }],
        connections: [
          {
            id: 'conn#1',
            from: { component: 'el#1', terminal: '1' },
            to: { component: 'el#1', terminal: '2' },
            wire: 'pp#5',
          },
        ],
        harness: [],
      }),
    );
    expect(problemsOf(a, 'reference')).toEqual([
      'pp#5 (entry#9): the document has no catalog entry entry#9',
    ]);
    expect(electricalWarnings(a)[0]).toMatchObject({ objectId: 'conn#1', target: 'entry#9' });
  });

  it('reports values that do not read', () => {
    const doc = withElectrical(design(), {
      components: [{ id: 'el#1', name: 'Board', role: 'board', load: { current: x('5 V') } }],
      connections: [],
      harness: [
        {
          id: 'seg#1',
          from: { component: 'el#1' },
          to: { component: 'el#1' },
          length: x('-3'),
          connections: [],
        },
      ],
    });
    const a = analyse(doc);
    expect(problemsOf(a, 'value')).toHaveLength(2);
    expect(a.harness[0]!.length).toBeUndefined();
  });
});

describe('harness lengths', () => {
  it('measures between instances’ origins plus slack, or takes the typed length', () => {
    const doc = withElectrical(design(), {
      assembly: 'assembly#1',
      components: [
        { id: 'el#1', name: 'Pack', role: 'pack', instance: 'inst#1' },
        { id: 'el#2', name: 'Controller', role: 'controller' },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: '+' },
          to: { component: 'el#2', terminal: 'bus+' },
        },
      ],
      harness: [
        {
          id: 'seg#1',
          from: { component: 'el#1' },
          to: { instance: 'inst#2' },
          length: { measured: true, slack: x('50 mm') },
          connections: ['conn#1'],
        },
        {
          id: 'seg#2',
          from: { component: 'el#1' },
          to: { component: 'el#2' },
          length: x('1.2 m'),
          connections: [],
        },
        {
          id: 'seg#3',
          from: { component: 'el#1' },
          to: { component: 'el#2' },
          length: { measured: true, slack: x('0') },
          connections: [],
        },
      ],
    });
    const [measured, typed, unplaced] = analyse(doc).harness;
    // (0,0,0) to (300,400,0) mm is 500 mm in a straight line, plus 50 mm of slack.
    expect(measured!.measured!.straight).toBeCloseTo(0.5, 12);
    expect(measured!.measured!.slack).toBeCloseTo(0.05, 12);
    expect(measured!.length).toBeCloseTo(0.55, 12);
    expect(measured!.fromText).toBe('Pack (el#1)');
    expect(measured!.toText).toBe('Controller mount (inst#2)');
    expect(typed!.length).toBeCloseTo(1.2, 12);
    expect(unplaced!.length).toBeUndefined();
    expect(unplaced!.missing).toBe(
      'Controller (el#2) is not placed in the assembly: give it an instance',
    );
    expect(analyse(doc).connections[0]!.segments).toEqual(['seg#1']);
  });
});

describe('connection currents', () => {
  /** The cable trainer: requirements and load cases, then its electrical system. */
  function trainer(): ManufaktureDocument {
    let doc = createDocument({ id: 'd', name: 'Trainer' });
    const req = templateCommand(doc, 'cable-trainer');
    if (!req.ok) throw new Error(req.message);
    doc = apply(doc, req.command);
    const el = electricalTemplateCommand(doc);
    if (!el.ok) throw new Error(el.message);
    return apply(doc, el.command);
  }

  it('enters the cable trainer’s system with nothing missing and nothing dangling', () => {
    const doc = trainer();
    const a = analyse(doc);
    expect(a.components).toHaveLength(14);
    expect(a.connections).toHaveLength(31);
    expect(a.problems).toEqual([]);
  });

  it('gives every connection a path and leaves the simulated parts unknown until it runs', () => {
    const doc = trainer();
    const currents = connectionCurrents({ document: doc, variables: NO_VARIABLES });
    expect(currents).toHaveLength(31);
    for (const c of currents) expect(c.unresolved).toBeUndefined();
    const id = (n: number) => `conn#${n}`;
    const byId = new Map(currents.map((c) => [c.connection, c]));
    // Pack + to the BMS: the controller's bus current, the charge current and the converter.
    const main = byId.get(id(1))!;
    expect(main.path).toBe('power');
    expect(main.sources).toEqual(['el#1']);
    expect(main.contributions).toEqual([
      {
        kind: 'load',
        component: 'el#10',
        value: expect.closeTo(0.025, 12) as number,
      },
      {
        kind: 'simulated',
        component: 'el#6',
        quantity: 'bus-current',
        series: 'electrical/el#6/bus-current',
        mode: 'use',
      },
      {
        kind: 'simulated',
        component: 'el#9',
        quantity: 'charge-current',
        series: 'electrical/el#9/charge-current',
        mode: 'charge',
      },
    ]);
    expect(main.cases[0]!.peak).toBeUndefined();
    expect(main.cases[0]!.missing).toContain(
      `electrical/el#6/bus-current: no simulation of ${main.cases[0]!.loadCase} has run`,
    );
    // Phases carry the controller's phase current; the brake output the resistor's.
    expect(byId.get(id(9))!.path).toBe('phase');
    expect(byId.get(id(9))!.contributions[0]).toMatchObject({
      series: 'electrical/el#6/phase-current',
    });
    expect(byId.get(id(12))!.contributions[0]).toMatchObject({
      series: 'electrical/el#7/resistor-current',
    });
    // The precharge path, the charger input.
    expect(byId.get(id(7))!.path).toBe('precharge');
    expect(byId.get(id(14))!.contributions.map((c) => c.component)).toEqual(['el#9']);
    // The board's supply is a typed load, known now; a signal line is negligible.
    expect(byId.get(id(18))!.steady).toBeCloseTo(0.08, 12);
    expect(byId.get(id(18))!.cases.every((c) => c.peak === byId.get(id(18))!.steady)).toBe(true);
    expect(byId.get(id(26))!).toMatchObject({ path: 'signal', steady: 0 });
    expect(byId.get(id(26))!.assumptions).toEqual([SIGNAL_ASSUMPTION]);
  });

  it('carries a simulated current on every connection once the series are supplied', () => {
    const doc = trainer();
    const loadCases = doc.mech!.loadCases!.map((lc) => lc.id);
    // A stand-in for T9.4b: each series' peak and RMS in each load case.
    const values: Record<string, number> = {};
    const peaks: Record<string, [number, number]> = {
      'el#6/bus-current': [24, 9],
      'el#6/phase-current': [45, 20],
      'el#7/resistor-current': [12, 4],
      'el#9/charge-current': [3, 3],
      'el#5/precharge-current': [2, 0.1],
    };
    for (const [k, [peak, rms]] of Object.entries(peaks)) {
      const [component, quantity] = k.split('/') as [string, 'bus-current'];
      values[`${electricalSeries(component, quantity)}:peak`] = peak;
      values[`${electricalSeries(component, quantity)}:rms`] = rms;
    }
    const simulation = simulationFrom(Object.fromEntries(loadCases.map((lc) => [lc, values])));
    const currents = connectionCurrents({ document: doc, variables: NO_VARIABLES }, simulation);
    for (const c of currents) {
      expect(c.cases).toHaveLength(loadCases.length);
      for (const k of c.cases) {
        expect(k.missing).toEqual([]);
        expect(k.peak).toBeGreaterThanOrEqual(0);
        expect(k.rms).toBeGreaterThanOrEqual(0);
      }
    }
    const main = currents[0]!.cases[0]!;
    // Running (24 A) and charging (3 A) are taken one at a time; the converter's 25 mA always.
    expect(main.peak).toBeCloseTo(24.025, 12);
    expect(main.rms).toBeCloseTo(9.025, 12);
    expect(currents[0]!.assumptions).toHaveLength(2);
    expect(currents[8]!.cases[0]!.peak).toBe(45);
  });

  it('leaves a loop, a line fed from both ends or fed from neither unresolved, saying why', () => {
    const doc = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Pack', role: 'pack' },
        { id: 'el#2', name: 'Pack 2', role: 'pack' },
        { id: 'el#3', name: 'Fuse', role: 'fuse' },
        { id: 'el#4', name: 'Fuse 2', role: 'fuse' },
      ],
      connections: [
        // Two fuses in parallel from Pack +.
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: '+' },
          to: { component: 'el#3', terminal: '1' },
        },
        {
          id: 'conn#2',
          from: { component: 'el#1', terminal: '+' },
          to: { component: 'el#4', terminal: '1' },
        },
        {
          id: 'conn#3',
          from: { component: 'el#3', terminal: '2' },
          to: { component: 'el#4', terminal: '2' },
        },
        // Pack - to Pack 2 -: fed from both ends.
        {
          id: 'conn#4',
          from: { component: 'el#1', terminal: '-' },
          to: { component: 'el#2', terminal: '-' },
        },
      ],
      harness: [],
    });
    const c = connectionCurrents({ document: doc, variables: NO_VARIABLES });
    expect(c[0]!.unresolved).toMatch(/loop of parallel paths/);
    expect(c[3]!.unresolved).toBe('it is fed from both ends (el#1 and el#2)');
    const lone = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Fuse', role: 'fuse' },
        { id: 'el#2', name: 'Board', role: 'board', load: { current: x('50 mA') } },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: '2' },
          to: { component: 'el#2', terminal: 'vin' },
        },
      ],
      harness: [],
    });
    expect(connectionCurrents({ document: lone, variables: NO_VARIABLES })[0]!.unresolved).toBe(
      'nothing feeds it: no pack, converter output or brake output on either side',
    );
  });

  it('follows a phase line through connector pins to its controller, and names a missing load', () => {
    const doc = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Controller', role: 'controller' },
        { id: 'el#2', name: 'XT60', role: 'connector', use: 'pp#2' },
        { id: 'el#3', name: 'Motor', role: 'motor' },
        { id: 'el#4', name: 'Pack', role: 'pack' },
        { id: 'el#5', name: 'Display', role: 'display' },
      ],
      connections: [
        // A pin is one node: the wires on both halves of the connector meet at it.
        {
          id: 'conn#1',
          from: { component: 'el#3', terminal: 'a' },
          to: { component: 'el#2', terminal: '1' },
        },
        {
          id: 'conn#2',
          from: { component: 'el#2', terminal: '1' },
          to: { component: 'el#1', terminal: 'a' },
        },
        {
          id: 'conn#3',
          from: { component: 'el#4', terminal: '+' },
          to: { component: 'el#5', terminal: 'vcc' },
        },
      ],
      harness: [],
    });
    const c = connectionCurrents({ document: doc, variables: NO_VARIABLES });
    expect(c[0]!.contributions).toMatchObject([{ component: 'el#1', quantity: 'phase-current' }]);
    expect(c[2]!.contributions).toEqual([
      { kind: 'load', component: 'el#5', missing: 'no load current of Display (el#5): type it' },
    ]);
    expect(c[2]!.steady).toBeUndefined();
  });

  /** A controller and a motor (or a board and an encoder) through two connectors in series. */
  function throughTwoConnectors(
    a: [string, 'controller' | 'board', string],
    b: [string, 'motor' | 'encoder', string],
  ): ManufaktureDocument {
    return withElectrical(design(), {
      components: [
        { id: 'el#1', name: a[0], role: a[1] },
        { id: 'el#2', name: 'J1', role: 'connector', use: 'pp#2' },
        { id: 'el#3', name: 'J2', role: 'connector', use: 'pp#2' },
        { id: 'el#4', name: b[0], role: b[1] },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: a[2] },
          to: { component: 'el#2', terminal: '1' },
        },
        {
          id: 'conn#2',
          from: { component: 'el#2', terminal: '1' },
          to: { component: 'el#3', terminal: '1' },
        },
        {
          id: 'conn#3',
          from: { component: 'el#3', terminal: '1' },
          to: { component: 'el#4', terminal: b[2] },
        },
      ],
      harness: [],
    });
  }

  it('carries a phase line through two connectors in series', () => {
    const doc = throughTwoConnectors(['Controller', 'controller', 'a'], ['Motor', 'motor', 'a']);
    const a = analyse(doc);
    expect(problemsOf(a, 'structure')).toEqual([]);
    expect(a.connections[1]!.from.effectiveKind).toBe('phase');
    const c = connectionCurrents({ document: doc, variables: NO_VARIABLES }, undefined, a);
    for (const k of c) {
      expect(k.unresolved).toBeUndefined();
      expect(k.path).toBe('phase');
      expect(k.contributions).toMatchObject([{ component: 'el#1', quantity: 'phase-current' }]);
    }
  });

  it('carries a signal line through two connectors in series', () => {
    const doc = throughTwoConnectors(
      ['Board', 'board', 'signal'],
      ['Encoder', 'encoder', 'signal'],
    );
    const a = analyse(doc);
    expect(problemsOf(a, 'structure')).toEqual([]);
    const c = connectionCurrents({ document: doc, variables: NO_VARIABLES }, undefined, a);
    expect(c.map((k) => [k.path, k.steady, k.unresolved])).toEqual([
      ['signal', 0, undefined],
      ['signal', 0, undefined],
      ['signal', 0, undefined],
    ]);
  });

  it('flags a connector net that joins a phase to a power terminal', () => {
    const doc = withElectrical(design(), {
      components: [
        { id: 'el#1', name: 'Controller', role: 'controller' },
        { id: 'el#2', name: 'J1', role: 'connector', use: 'pp#2' },
        { id: 'el#3', name: 'Pack', role: 'pack' },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: 'a' },
          to: { component: 'el#2', terminal: '1' },
        },
        {
          id: 'conn#2',
          from: { component: 'el#2', terminal: '1' },
          to: { component: 'el#3', terminal: '+' },
        },
      ],
      harness: [],
    });
    expect(problemsOf(analyse(doc), 'structure')).toEqual([
      'joins a phase terminal (J1 (el#2) 1) to a power one (Pack (el#3) +)',
    ]);
  });

  it('is empty for a document with no electrical system', () => {
    const doc = createDocument({ id: 'd', name: 'Empty' });
    expect(connectionCurrents({ document: doc, variables: NO_VARIABLES })).toEqual([]);
    expect(analyse(doc).problems).toEqual([]);
  });
});
