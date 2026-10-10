// Built-in rope and cable entries (T9.2d; ADR 0017 decision 7; T9.0c's field list for rope and
// cable). Typical published values, every one `verified: false`. Two HMPE braids from Samson's
// AmSteel-Blue data sheet (a distributor's copy; the 3 mm size is the spool example of T9.3b, a
// 2.85 m, 3 mm cable on a 40 mm core) and two galvanised 7x19 steel cables from a distributor, to
// show why a portable trainer uses fibre: steel wants a drum 34 to 51 times its diameter. The bend
// ratios and the HMPE design factor are general guidance from the sources named, not the maker's
// figure for each line. Ratings are SI (N, kg/m), the diameter millimetres. Nothing here says a
// rope is fit for a design: the checks state margins.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
/** Kilograms-force (Samson's metric strength columns) to newtons. */
const kgf = (v: number) => v * 9.80665;
/** Pounds-force to newtons. */
const lbf = (v: number) => v * 4.4482216152605;
/** Pounds per foot to kilograms per metre. */
const lbPerFt = (v: number) => (v * 0.45359237) / 0.3048;

const SAMSON = {
  title: "Samson Rope, AmSteel-Blue technical data sheet (product code 872), a distributor's copy",
  url: 'https://trotac.ca/content/pdf/Samson/amsteel-blue-tech-info-2023.pdf',
  revision: '2023',
  read: READ,
};
const MARLOW = {
  title: 'Marlow Ropes, HMPE tech talk 5: working loads, D:d ratios, inspection and shelf life',
  url: 'https://www.marlowropes.com/news/hmpe-tech-talk-5-working-loads-dd-rations-inspection-shelf-life/',
  read: READ,
};
const WIRE_RATIOS = {
  title: 'Industrial Wire Rope Supply, sheave and drum ratios (7x19: suggested 51, minimum 34)',
  url: 'https://industrialrope.com/wire-rope/sheave-and-drum-ratios/',
  read: READ,
};

const HMPE_FATIGUE = 'flex fatigue and wear resistance described as superior; no cycle data';
const HMPE_CREEP = 'HMPE creeps under sustained load; the data sheet does not quantify it';
const HMPE_NOTE =
  "Samson's strengths are for spliced rope (the ISO 2307 figure is unspliced), so a spliced eye is already counted and a knot is not. Specific gravity 0.98. Bend ratios 8 minimum and 10 suggested, and the design factor of 7, are Marlow's general guidance for braided HMPE (the factor Marlow attributes to EN and ISO synthetic rope standards), not Samson's figure for this line.";

const STEEL_FATIGUE = 'bending fatigue governs life on small sheaves; keep to the suggested D/d';
const STEEL_NOTE =
  "Right hand regular lay, improved plow steel, drawn galvanised (the seller says this keeps full strength). The breaking strength is the cable's own: a swaged or clipped termination lowers it, by an amount the termination's maker states. The seller states no working load or design factor, and no elongation. The bend ratios are a wire rope supplier's general figures for 7x19.";

/** The built-in ropes and cables, every version. */
export const ROPE_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'rope/samson-amsteel-blue-2-5mm',
    version: 1,
    family: 'rope',
    fieldsVersion: 2,
    maker: 'Samson Rope',
    partNumber: 'AmSteel-Blue 7/64 in (2.5 mm), product code 872',
    description: 'HMPE single braid, 8-strand at this size, 2.5 mm',
    ratings: {
      material: { text: 'HMPE' },
      construction: { text: '8-strand single braid (12-strand from 1/8 in up)' },
      minimumBreakingLoad: { value: kgf(650) },
      averageBreakingLoad: { value: kgf(730) },
      strengthBasis: { text: 'spliced' },
      massPerLength: { value: 0.0045 },
      minimumBendRatio: { value: 8 },
      suggestedBendRatio: { value: 10 },
      elasticElongation: { value: 0.007, estimated: true },
      elongationLoad: { value: 0.2 },
      designFactor: { value: 7 },
      cycleRating: { unknown: true },
      creepNote: { text: HMPE_CREEP },
      fatigueNote: { text: HMPE_FATIGUE },
    },
    dimensions: { diameter: { value: 2.5 } },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      SAMSON,
      MARLOW,
      {
        title:
          'Rigging Warehouse, Samson AmSteel-Blue 7/64 in x 280 ft (distributor; 1,400 lb minimum, 1,600 lb average)',
        url: 'https://www.riggingwarehouse.com/502-872007532830-samson-amsteel-blue-rigging-rope-7-64-x-280-green.html',
        read: READ,
      },
    ],
    verified: false,
    notes: `Values are Samson's metric columns (650 kg minimum, 730 kg average, 0.45 kg per 100 m); the inch columns give 1,400 and 1,600 lb (6.2 and 7.1 kN) and 0.30 lb per 100 ft. T9.0c listed this size as 2.8 mm (7/64 in exactly); Samson's metric size is 2.5 mm. Samson's elongation table (0.70 % at 20 % of break) is for its 12-strand ropes, so it is marked estimated for this 8-strand size. 6.37 kN / 7 = 910 N, just over 200 lbf. ${HMPE_NOTE}`,
  },
  {
    id: 'rope/samson-amsteel-blue-3mm',
    version: 1,
    family: 'rope',
    fieldsVersion: 2,
    maker: 'Samson Rope',
    partNumber: 'AmSteel-Blue 1/8 in (3 mm), product code 872',
    description: 'HMPE 12-strand single braid, 3 mm',
    ratings: {
      material: { text: 'HMPE' },
      construction: { text: '12-strand single braid, torque-free' },
      minimumBreakingLoad: { value: kgf(1000) },
      averageBreakingLoad: { value: kgf(1100) },
      strengthBasis: { text: 'spliced' },
      massPerLength: { value: 0.0074 },
      minimumBendRatio: { value: 8 },
      suggestedBendRatio: { value: 10 },
      elasticElongation: { value: 0.007 },
      elongationLoad: { value: 0.2 },
      designFactor: { value: 7 },
      cycleRating: { unknown: true },
      creepNote: { text: HMPE_CREEP },
      fatigueNote: { text: HMPE_FATIGUE },
    },
    dimensions: { diameter: { value: 3 } },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [SAMSON, MARLOW],
    verified: false,
    notes: `The size of the Voltra-class trainer's 3 mm line. Values are Samson's metric columns (1,000 kg minimum, 1,100 kg average, 0.74 kg per 100 m); the inch columns give 2,300 and 2,500 lb (10.2 and 11.1 kN) and 0.50 lb per 100 ft. Elastic elongation 0.46 %, 0.70 % and 0.96 % at 10, 20 and 30 % of break; 20 % is stored. 9.81 kN / 7 = 1.40 kN, about 315 lbf. At 8:1 it needs a 24 mm spool, 30 mm at 10:1; a 40 mm core is about 13:1. ${HMPE_NOTE}`,
  },
  {
    id: 'rope/steel-7x19-galvanised-2-4mm',
    version: 1,
    family: 'rope',
    fieldsVersion: 2,
    maker: 'US Cargo Control (seller)',
    partNumber: '3/32 in 7x19 galvanized aircraft cable, by the foot',
    description: 'Galvanised steel wire rope, 7x19, 3/32 in (2.4 mm)',
    ratings: {
      material: { text: 'steel 7x19' },
      construction: { text: '7x19, right hand regular lay, IPS, drawn galvanised' },
      minimumBreakingLoad: { value: lbf(1050) },
      strengthBasis: { text: 'unterminated' },
      massPerLength: { value: lbPerFt(0.02) },
      minimumBendRatio: { value: 34 },
      suggestedBendRatio: { value: 51 },
      elasticElongation: { unknown: true },
      designFactor: { unknown: true },
      cycleRating: { unknown: true },
      fatigueNote: { text: STEEL_FATIGUE },
    },
    dimensions: { diameter: { value: 2.381 } },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title:
          'US Cargo Control, 3/32 in 7x19 galvanized aircraft cable by the linear foot (seller)',
        url: 'https://www.uscargocontrol.com/products/3-32-7x19-galvanized-wire-by-linear-foot',
        read: READ,
      },
      WIRE_RATIOS,
    ],
    verified: false,
    notes: `Meets RR-W-410 and ASTM A1023, the seller says. Breaking strength 1,050 lb is stored as the minimum; the seller does not say minimum or average. Mass 0.02 lb per foot, rounded by the seller. At 34:1 it needs an 81 mm drum, 121 mm at 51:1. ${STEEL_NOTE}`,
  },
  {
    id: 'rope/steel-7x19-galvanised-3-2mm',
    version: 1,
    family: 'rope',
    fieldsVersion: 2,
    maker: 'US Cargo Control (seller)',
    partNumber: '1/8 in 7x19 galvanized aircraft cable, by the foot',
    description: 'Galvanised steel wire rope, 7x19, 1/8 in (3.2 mm)',
    ratings: {
      material: { text: 'steel 7x19' },
      construction: { text: '7x19, right hand regular lay, IPS, drawn galvanised' },
      minimumBreakingLoad: { value: lbf(2000) },
      strengthBasis: { text: 'unterminated' },
      massPerLength: { value: lbPerFt(0.03) },
      minimumBendRatio: { value: 34 },
      suggestedBendRatio: { value: 51 },
      elasticElongation: { unknown: true },
      designFactor: { unknown: true },
      cycleRating: { unknown: true },
      fatigueNote: { text: STEEL_FATIGUE },
    },
    dimensions: { diameter: { value: 3.175 } },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title:
          'US Cargo Control, 1/8 in 7x19 galvanized aircraft cable by the linear foot (seller)',
        url: 'https://www.uscargocontrol.com/products/1-8-7x19-galvanized-wire-by-linear-foot',
        read: READ,
      },
      WIRE_RATIOS,
    ],
    verified: false,
    notes: `Meets RR-W-410 and ASTM A1023, the seller says. Breaking strength 2,000 lb (1 ton) is stored as the minimum; the seller does not say minimum or average. Mass 0.03 lb per foot, rounded by the seller. At 34:1 it needs a 108 mm drum, 162 mm at 51:1, which no 100 mm tall box holds. ${STEEL_NOTE}`,
  },
];
