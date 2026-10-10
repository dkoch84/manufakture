// Built-in timing belt and pulley entries (T9.2d; ADR 0017 decision 7; T9.0c's field list for belts
// and pulleys). Typical published values, every one `verified: false`. Belt ratings are from Gates'
// Light Power and Precision Drive Design Manual, table 6 (long-length belting), as T9.0c read and
// converted them from pounds (`docs/research/electromechanical.md`, section 2.5): the rated working
// tension at the fewest grooves the table lists and at its largest pulley, 45 grooves, so a check
// can interpolate. The drive efficiency is not in the table; the value given is typical of
// synchronous belt drives, estimated. T9.2a's sample `belt/gates-5mgt-15` stays in
// `../parts/catalog.ts`. Pulleys are a Gates 5MGT pair from a distributor's copy of Gates' sprocket
// tables (a 4.5:1 reduction) and a small GT2 pulley as sold for printers and robots. Ratings are SI
// (N, kg/m, m/s), dimensions millimetres, mass kilograms. Nothing here says a drive is fit for a
// design: the checks state margins.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const kn = (v: number) => v * 1000;

const GATES_MANUAL = {
  title:
    'Gates, Light Power and Precision Drive Design Manual, table 6 (as read and converted from pounds in T9.0c)',
  url: 'https://www.gates.com/content/dam/documents-library/catalogs/light-power-and-precision-manual.pdf',
  read: READ,
};

const GATES_SPROCKETS = {
  title:
    "Gates synchronous pulleys, PowerGrip 5MGT and Poly Chain 5MGT sprockets, pages 129 and 130 (a distributor's copy of the Gates catalogue section)",
  url: 'https://www.statewidebearings.com.au/uploads/2018/06/Gates-synchronous-pulleys-1.pdf',
  read: READ,
};

/** Typical synchronous belt drive efficiency, not from the maker: estimated. */
const EFFICIENCY = { value: 0.97, estimated: true } as const;

const BELT_NOTE =
  "Rate drives with at least 6 teeth in mesh, and take 20 % off the rating for each tooth fewer (to a minimum of 2); give each loaded pulley at least 60 degrees of wrap. The efficiency is typical of synchronous belt drives in general literature (about 95 to 98 %), not from Gates, estimated. Belt mass and tensile stiffness were not read. Fibreglass tensile cords are Gates' general description of these belts, not a table value.";

/** The built-in belts, every version. */
export const BELT_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'belt/gates-2mgt-6',
    version: 1,
    family: 'belt',
    fieldsVersion: 2,
    maker: 'Gates',
    partNumber: '2MGT, 6 mm wide (long-length belting)',
    description: 'PowerGrip GT3 timing belt, 2 mm pitch, 6 mm wide',
    ratings: {
      profile: { text: 'GT2' },
      ratedWorkingTension: { value: 169, basis: '12 grooves on the smaller pulley; table 6' },
      ratedWorkingTensionLarge: { value: 173, basis: '45 grooves on the smaller pulley; table 6' },
      largePulleyGrooves: { value: 45 },
      breakingStrength: { value: 556 },
      minimumPulleyGrooves: { value: 12 },
      minimumTeethInMesh: { value: 6 },
      cord: { text: 'fibreglass' },
      efficiency: EFFICIENCY,
      tensileStiffness: { unknown: true },
      massPerLength: { unknown: true },
    },
    dimensions: { pitch: { value: 2 }, width: { value: 6 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [GATES_MANUAL],
    verified: false,
    notes: `Gates names this pitch 2MGT; it runs on GT2 pulleys, so the profile is GT2. ${BELT_NOTE}`,
  },
  {
    id: 'belt/gates-3mgt-15',
    version: 1,
    family: 'belt',
    fieldsVersion: 2,
    maker: 'Gates',
    partNumber: '3MGT, 15 mm wide (long-length belting)',
    description: 'PowerGrip GT3 timing belt, 3 mm pitch, 15 mm wide',
    ratings: {
      profile: { text: '3MGT' },
      ratedWorkingTension: { value: 627, basis: '16 grooves on the smaller pulley; table 6' },
      ratedWorkingTensionLarge: { value: 734, basis: '45 grooves on the smaller pulley; table 6' },
      largePulleyGrooves: { value: 45 },
      breakingStrength: { value: kn(2.85) },
      minimumPulleyGrooves: { value: 16 },
      minimumTeethInMesh: { value: 6 },
      cord: { text: 'fibreglass' },
      efficiency: EFFICIENCY,
      tensileStiffness: { unknown: true },
      massPerLength: { unknown: true },
    },
    dimensions: { pitch: { value: 3 }, width: { value: 15 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [GATES_MANUAL],
    verified: false,
    notes: BELT_NOTE,
  },
  {
    id: 'belt/gates-htd-5m-15',
    version: 1,
    family: 'belt',
    fieldsVersion: 2,
    maker: 'Gates',
    partNumber: 'HTD 5M, 15 mm wide (long-length belting)',
    description: 'PowerGrip HTD timing belt, 5 mm pitch, 15 mm wide',
    ratings: {
      profile: { text: 'HTD 5M' },
      ratedWorkingTension: { value: 365, basis: '14 grooves on the smaller pulley; table 6' },
      ratedWorkingTensionLarge: { value: 516, basis: '45 grooves on the smaller pulley; table 6' },
      largePulleyGrooves: { value: 45 },
      breakingStrength: { value: kn(5.85) },
      minimumPulleyGrooves: { value: 14 },
      minimumTeethInMesh: { value: 6 },
      cord: { text: 'fibreglass' },
      efficiency: EFFICIENCY,
      tensileStiffness: { unknown: true },
      massPerLength: { unknown: true },
    },
    dimensions: { pitch: { value: 5 }, width: { value: 15 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [GATES_MANUAL],
    verified: false,
    notes: `Same pitch and breaking strength as the 15 mm 5MGT belt, but rated well below it (365 N against 614 N at the fewest grooves): the GT tooth profile carries more. ${BELT_NOTE}`,
  },
  {
    id: 'belt/gates-htd-5m-25',
    version: 1,
    family: 'belt',
    fieldsVersion: 2,
    maker: 'Gates',
    partNumber: 'HTD 5M, 25 mm wide (long-length belting)',
    description: 'PowerGrip HTD timing belt, 5 mm pitch, 25 mm wide',
    ratings: {
      profile: { text: 'HTD 5M' },
      ratedWorkingTension: { value: 649, basis: '14 grooves on the smaller pulley; table 6' },
      ratedWorkingTensionLarge: { value: 921, basis: '45 grooves on the smaller pulley; table 6' },
      largePulleyGrooves: { value: 45 },
      breakingStrength: { value: kn(9.74) },
      minimumPulleyGrooves: { value: 14 },
      minimumTeethInMesh: { value: 6 },
      cord: { text: 'fibreglass' },
      efficiency: EFFICIENCY,
      tensileStiffness: { unknown: true },
      massPerLength: { unknown: true },
    },
    dimensions: { pitch: { value: 5 }, width: { value: 25 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [GATES_MANUAL],
    verified: false,
    notes: BELT_NOTE,
  },
];

/** The built-in pulleys, every version. */
export const PULLEY_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'pulley/adafruit-gt2-20t-5mm',
    version: 1,
    family: 'pulley',
    fieldsVersion: 2,
    maker: 'Adafruit (reseller; maker not named)',
    partNumber: '1251',
    description: 'Aluminium GT2 timing pulley, 20 teeth, 5 mm bore, for 6 mm belts, two set screws',
    ratings: {
      grooves: { value: 20 },
      profile: { text: 'GT2' },
      material: { text: 'aluminium' },
      mounting: { text: 'two set screws on a 5 mm bore' },
    },
    dimensions: {
      outerDiameter: { value: 12.2 },
      innerDiameter: { value: 5 },
      width: { value: 16 },
      pitch: { value: 2 },
    },
    mass: { value: 0.006 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title:
          'Adafruit, Aluminum GT2 Timing Pulley, 6mm Belt, 20 Tooth, 5mm Bore (product 1251; read through a search summary)',
        url: 'https://www.adafruit.com/product/1251',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "The outside diameter is measured tip to tip of the teeth (0.48 in); the width is the whole pulley with its hub (16 mm), and the hub is 16 mm across. The pitch diameter is 20 x 2 / pi = 12.73 mm. Unbranded pulleys of this kind vary from seller to seller; measure the one bought. 20 grooves is above Gates' fewest for a 2 mm belt (12), where the 6 mm belt is rated about 170 N.",
  },
  {
    id: 'pulley/gates-p20-5mgt-15',
    version: 1,
    family: 'pulley',
    fieldsVersion: 2,
    maker: 'Gates',
    partNumber: 'P20-5MGT-15',
    description: 'PowerGrip 5MGT sprocket, 20 grooves, for 9 and 15 mm belts, pilot bore',
    ratings: {
      grooves: { value: 20 },
      profile: { text: '5MGT' },
      material: { text: "grey iron, ductile iron, sintered steel or steel, at Gates' choice" },
      mounting: { text: 'pilot bore, bored to suit' },
      maxRimSpeed: { value: 40, basis: 'consult Gates above this rim speed' },
    },
    dimensions: {
      outerDiameter: { value: 30.68 },
      innerDiameter: { unknown: true },
      pitch: { value: 5 },
    },
    mass: { value: 0.15 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [GATES_SPROCKETS],
    verified: false,
    notes:
      'Pitch diameter 31.83 mm, flange diameter 38.35 mm. A pilot bore is machined to the shaft by the buyer, so the bore is not given, and neither is the width. With P90-5MGT-15 it makes a 4.5:1 reduction.',
  },
  {
    id: 'pulley/gates-p90-5mgt-15',
    version: 1,
    family: 'pulley',
    fieldsVersion: 2,
    maker: 'Gates',
    partNumber: 'P90-5MGT-15',
    description: 'PowerGrip 5MGT sprocket, 90 grooves, for 9 and 15 mm belts, 1610 taper bush',
    ratings: {
      grooves: { value: 90 },
      profile: { text: '5MGT' },
      material: { text: "grey iron, ductile iron, sintered steel or steel, at Gates' choice" },
      flanges: { text: 'none' },
      mounting: { text: 'taper bush 1610' },
      maxRimSpeed: { value: 40, basis: 'consult Gates above this rim speed' },
    },
    dimensions: {
      outerDiameter: { value: 142.09 },
      innerDiameter: { unknown: true },
      pitch: { value: 5 },
    },
    mass: { value: 2.1 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [GATES_SPROCKETS],
    verified: false,
    notes:
      "Pitch diameter 143.24 mm; the table lists no flange for this size. The bore is set by the 1610 taper bush chosen, so it is not given, and neither is the width. At 142 mm across it is wider than the 139 mm box of the Voltra-class trainer, the finding T9.0c expected for a single-stage 5:1 drive. Its mass is the sprocket's; the bush adds to it.",
  },
];
