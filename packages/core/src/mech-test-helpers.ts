// A mechanical document for the tests (ADR 0017, format version 19): one item of every
// collection of `mech`, a user material, display units per kind, and the commands that build
// them on the bracket. Expressions are written as a user would type them, physical ones with
// compound units (`2 m/s`) that only the physical parse mode reads without a variable `s`.

import type { Command } from './commands';
import type {
  CatalogEntry,
  CheckOverride,
  Drivetrain,
  Electrical,
  Hazard,
  LoadCase,
  ManufaktureDocument,
  MaterialDefData,
  PurchasedUse,
  Requirement,
  Schematic,
  SpecNote,
  StoredExpression,
  Study,
  SymbolDef,
  TestBand,
} from './schema';
import { applyCommand } from './commands';
import { PART, bracket, unwrap } from './test-helpers';

/** An expression typed in a document whose display units are millimetres and degrees. */
export function x(source: string): StoredExpression {
  return { source, lengthUnit: 'mm', angleUnit: 'deg' };
}

export const requirements = (): Requirement[] => [
  {
    id: 'req#1',
    name: 'Peak pull',
    quantity: 'maxForce',
    comparison: '>=',
    value: x('#pull'),
    loadCase: 'lc#1',
    drivetrain: 'drive#1',
  },
  {
    id: 'req#2',
    name: 'Cable speed',
    quantity: 'peakCableSpeed',
    comparison: '>=',
    value: x('2 m/s'),
    tolerance: x('0.1 m/s'),
  },
  {
    id: 'req#3',
    name: 'Fits a bag',
    quantity: 'envelope',
    comparison: 'within',
    value: [x('300'), x('200'), x('150')],
  },
  {
    id: 'req#4',
    name: 'Winding',
    quantity: { series: 'motor.winding', statistic: 'peak' },
    comparison: '<=',
    value: x('120degC'),
  },
];

export const loadCase = (): LoadCase => ({
  id: 'lc#1',
  name: 'Max set',
  drivetrain: 'drive#1',
  dynamic: {
    mode: { kind: 'eccentric', factor: x('1.2') },
    force: x('#pull'),
    motion: {
      kind: 'half-cosine',
      stroke: x('0.6 m'),
      pullSpeed: x('1.5 m/s'),
      returnSpeed: x('1 m/s'),
      pause: x('0.5 s'),
    },
    reps: x('10'),
    sets: x('3'),
    rest: x('90 s'),
    ambient: x('25degC'),
  },
  static: [
    { kind: 'cable', name: 'Side pull', force: x('#pull'), angle: x('45deg') },
    {
      kind: 'point',
      name: 'Handle',
      force: x('300 N'),
      direction: [0, 0, -1],
      at: { kind: 'instance', assembly: 'assembly#1', instance: 'inst#1' },
    },
    { kind: 'acceleration', name: 'Drop', acceleration: x('5 gn'), direction: [0, 0, -1] },
  ],
});

export const drivetrain = (): Drivetrain => ({
  id: 'drive#1',
  name: 'Main',
  assembly: 'assembly#1',
  stages: [
    { id: 'stage#1', kind: 'motor', use: 'pp#1', instance: 'inst#2', mate: 'mate#1' },
    {
      id: 'stage#2',
      kind: 'belt',
      ratio: { driver: x('20'), driven: x('60') },
      efficiency: x('0.95'),
    },
    { id: 'stage#3', kind: 'shaft', instance: 'inst#3', bearings: [{ use: 'pp#2' }] },
  ],
  output: {
    kind: 'spool',
    instance: 'inst#1',
    body: 'extrude#1',
    cable: 'pp#3',
    length: x('2.5 m'),
    core: x('#spoolCore'),
    fairlead: { bendDiameter: x('20') },
  },
});

export const purchased = (): PurchasedUse => ({
  id: 'pp#1',
  entry: { source: 'builtin', id: 'motor/odrive-d6374-150kv', version: 1 },
  part: PART,
  alternates: [{ source: 'document', id: 'entry#1' }],
  name: 'Drive motor',
});

export const catalogEntry = (): CatalogEntry => ({
  id: 'entry#1',
  version: 1,
  family: 'bearing',
  fieldsVersion: 1,
  maker: 'SKF',
  partNumber: '6001-2RSH',
  description: 'Deep groove ball bearing, sealed',
  ratings: {
    dynamicLoad: { value: 5400, basis: 'ISO 281' },
    staticLoad: { value: 2360 },
    sealing: { text: '2RSH' },
    limitingSpeed: { unknown: true },
  },
  dimensions: { bore: { value: 12 }, outside: { value: 28 }, width: { value: 8 } },
  mass: { value: 0.022 },
  geometry: { kind: 'placeholder', shape: { kind: 'ring', axis: 'z' } },
  sources: [
    { title: 'SKF 6001-2RSH product page', url: 'https://www.skf.com/', read: '2026-10-10' },
  ],
  verified: false,
});

export const electrical = (): Electrical => ({
  assembly: 'assembly#1',
  components: [
    { id: 'el#1', name: 'Pack', role: 'pack', use: 'pp#1', layout: { block: [2, -1] } },
    {
      id: 'el#2',
      name: 'Board',
      role: 'board',
      instance: 'inst#2',
      terminals: [
        { id: 'vin', name: 'VIN', kind: 'power' },
        { id: 'gnd', name: 'GND', kind: 'ground' },
      ],
      load: { current: x('80 mA'), voltage: x('5 V') },
    },
  ],
  connections: [
    {
      id: 'conn#1',
      from: { component: 'el#1', terminal: '+' },
      to: { component: 'el#2', terminal: 'vin' },
      colour: 'red',
      number: '1',
    },
  ],
  harness: [
    {
      id: 'seg#1',
      from: { component: 'el#1' },
      to: { instance: 'inst#2' },
      length: { measured: true, slack: x('50') },
      connections: ['conn#1'],
    },
  ],
});

export const schematic = (): Schematic => ({
  id: 'sch#1',
  name: 'Interface board',
  details: 'el#2',
  sheets: [
    {
      id: 'sheet#1',
      name: 'Power',
      size: 'A4',
      symbols: [
        {
          id: 'us#1',
          designator: 'R1',
          symbol: { source: 'builtin', id: 'resistor', version: 1 },
          at: [10, 10],
          rotation: 90,
          mirror: false,
          value: '10k',
          footprint: 'Resistor_SMD:R_0603_1608Metric',
          fields: { tolerance: '1%' },
        },
        {
          id: 'us#2',
          designator: 'U1',
          symbol: { source: 'document', id: 'sym#1' },
          at: [20, 10],
          rotation: 0,
          mirror: false,
        },
      ],
      wires: [
        {
          id: 'wire#1',
          points: [
            [12, 10],
            [18, 10],
          ],
        },
      ],
      junctions: [[15, 10]],
      labels: [{ id: 'label#1', name: 'VIN', at: [15, 10], scope: 'global' }],
      ports: [{ id: 'port#1', at: [5, 10], terminal: 'vin' }],
      noConnects: [[25, 12]],
      notes: [{ id: 'text#1', at: [5, 20], text: 'Keep the trace short' }],
    },
  ],
});

export const symbol = (): SymbolDef => ({
  id: 'sym#1',
  name: 'Load cell amplifier',
  body: [
    { kind: 'rect', from: [-2, -2], to: [2, 2], fill: false },
    { kind: 'text', at: [0, 0], text: 'HX711', rotation: 0 },
    { kind: 'arc', center: [0, 0], radius: 0.5, start: 0, end: 180 },
  ],
  pins: [
    { number: '1', name: 'VCC', at: [-4, 1], orientation: 'right', length: 2, type: 'power-in' },
    { number: '2', name: 'DOUT', at: [4, 0], orientation: 'left', length: 2, type: 'output' },
  ],
});

export const study = (): Study => ({
  id: 'study#1',
  name: 'Bracket under pull',
  part: PART,
  bodies: ['extrude#1'],
  fixtures: [{ kind: 'bolted', faces: [{ id: 'r1', ref: { face: 'extrude#2:side:e5' } }] }],
  loads: [
    {
      kind: 'force',
      faces: [{ id: 'r2', ref: { face: 'extrude#1:top' } }],
      force: x('#pull'),
      direction: [0, 0, -1],
    },
  ],
  mesh: { size: x('2'), refine: [{ id: 'r3', ref: { face: 'fillet#1:face:e1' } }] },
  loadCase: 'lc#1',
});

export const checkOverride = (): CheckOverride => ({
  id: 'chk#1',
  check: 'bolt.preload',
  subject: { kind: 'stage', drivetrain: 'drive#1', stage: 'stage#3', at: 'seat-A' },
  factor: x('2'),
  inputs: { preload: x('4 kN'), locker: 'thread-locker' },
});

export const specNote = (): SpecNote => ({
  id: 'note#1',
  spec: 'mechanical',
  subject: { kind: 'part', part: PART },
  field: 'finish',
  text: 'Anodise clear',
});

export const hazard = (): Hazard => ({
  id: 'hz#1',
  name: 'Cable snaps',
  cause: 'Worn cable under peak load',
  mitigation: 'Cable rated well above the peak pull',
  records: ['cable.tension@drive#1'],
});

export const testBand = (): TestBand => ({
  id: 'vt#1',
  test: 'proof-load@drive#1',
  low: x('#pull * 1.5'),
});

export const materialDef = (): MaterialDefData => ({
  id: 'material#1',
  name: 'My PETG',
  category: 'plastic',
  form: 'printed',
  density: { value: x('1270 kg/m^3'), source: 'spool label', typical: true },
  properties: {
    yieldStrength: { value: x('45 MPa'), source: 'data sheet', typical: true, note: 'XY' },
    poissonRatio: { value: x('0.38'), source: 'handbook', typical: true },
    thermalConductivity: { value: x('0.2 W/(m*K)'), source: 'handbook', typical: true },
    maxServiceTemperature: { value: x('70degC'), source: 'data sheet', typical: true },
  },
  fatigue: {
    points: [
      { cycles: 1e4, stress: x('30 MPa') },
      { cycles: 1e6, stress: x('18 MPa') },
    ],
    source: 'paper',
    typical: true,
  },
});

/** The commands that add the variables, the material and every mechanical item to the bracket. */
export function mechCommands(): Command[] {
  return [
    { type: 'setVariable', name: 'pull', expression: x('200 lbf') },
    { type: 'setVariable', name: 'spoolCore', expression: x('30') },
    {
      type: 'setDisplayUnits',
      units: {
        length: { unit: 'mm' },
        angle: { unit: 'deg' },
        quantities: { force: 'lbf', torque: 'N·m' },
      },
    },
    { type: 'setMaterialDef', material: materialDef() },
    { type: 'setMaterial', partId: PART, material: 'material#1' },
    { type: 'setMechRequirements', requirements: requirements() },
    { type: 'setMechLoadCase', loadCase: loadCase() },
    { type: 'setDrivetrain', drivetrain: drivetrain() },
    { type: 'setPurchasedUse', use: purchased() },
    { type: 'setCatalogEntry', entry: catalogEntry() },
    { type: 'setElectrical', electrical: electrical() },
    { type: 'setSymbol', symbol: symbol() },
    { type: 'setSchematic', schematic: schematic() },
    { type: 'setStudy', study: study() },
    { type: 'setCheckOverride', override: checkOverride() },
    { type: 'setSpecNote', note: specNote() },
    { type: 'setHazard', hazard: hazard() },
    { type: 'setTestBand', band: testBand() },
  ];
}

/** The bracket with every mechanical shape in it. */
export function mechDocument(): ManufaktureDocument {
  let doc = bracket();
  for (const c of mechCommands()) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}
