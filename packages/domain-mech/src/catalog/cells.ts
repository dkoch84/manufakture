// Built-in cell entries (T9.2c; ADR 0017 decision 7; T9.0c's representative cells, plus a small
// high-rate 18650 and an LFP cell). Typical published values, every one `verified: false`: none has
// been checked against the maker's current datasheet, and several come from distributors or search
// summaries, which each source title says. Values the source does not give, and values filled from
// general knowledge of the cell, are `unknown` or marked `estimated`. No maker here publishes an
// open-circuit voltage table, so the OCV fields are left out and `cellOcvCurve` falls back to the
// generic curve of the chemistry, marked as such. Specific heat capacity is never on a cell
// datasheet; the values given are typical of the chemistry in calorimetry literature, estimated.
// Ratings are SI (A, V, ohm, C for capacity, J for energy, K), dimensions millimetres, mass
// kilograms. Nothing here says a cell is fit for a design: the checks state margins, not approval.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
/** Ampere-hours to coulombs. */
const ah = (v: number) => v * 3600;
/** Watt-hours to joules. */
const wh = (v: number) => v * 3600;
const degC = (v: number) => v + 273.15;

/** Typical specific heat of a cylindrical NMC or NCA cell, J/(kg*K), estimated. */
const SPECIFIC_HEAT_LAYERED = { value: 900, estimated: true } as const;
/** Typical specific heat of a cylindrical LFP cell, J/(kg*K), estimated. */
const SPECIFIC_HEAT_LFP = { value: 1000, estimated: true } as const;

const HEAT_NOTE =
  'Specific heat capacity is not on the datasheet; the value is typical of the chemistry in calorimetry literature (about 0.8 to 1.1 kJ/(kg*K) for cylindrical cells), estimated.';
const OCV_NOTE =
  'No open-circuit voltage table is published, so the generic curve of the chemistry applies, marked as generic.';

/** The built-in cells, every version. */
export const CELL_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'cell/a123-anr26650m1-b',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'A123 Systems',
    partNumber: 'ANR26650M1-B',
    description: 'LFP (Nanophosphate) high-power cylindrical cell, 26650, 2.5 Ah',
    ratings: {
      chemistry: { text: 'LFP' },
      format: { text: '26650' },
      capacity: { value: ah(2.5), basis: 'nominal, at 0.5 C' },
      minimumCapacity: { value: ah(2.4) },
      nominalVoltage: { value: 3.3 },
      chargeVoltage: { value: 3.6 },
      cutoffVoltage: { value: 2.0, estimated: true },
      standardChargeCurrent: { value: 2.5 },
      maxChargeCurrent: {
        value: 10,
        basis: 'fast charge, 10 A constant current to 3.6 V (80 % state of charge in 12 min)',
      },
      continuousDischarge: { value: 50, basis: 'maximum continuous; cooling not stated' },
      peakDischarge: { value: 120, basis: '10 s pulse' },
      impedanceAC: { value: 0.006, basis: '1 kHz AC' },
      resistanceDC: { unknown: true },
      minChargeTemperature: { unknown: true },
      maxChargeTemperature: { unknown: true },
      minDischargeTemperature: { value: degC(-30) },
      maxDischargeTemperature: { value: degC(55) },
      cycleLife: { value: 1000 },
      specificHeatCapacity: SPECIFIC_HEAT_LFP,
    },
    dimensions: {
      diameter: { value: 26, estimated: true },
      length: { value: 65, estimated: true },
    },
    mass: { value: 0.076 },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title:
          'A123 Systems, Nanophosphate high power lithium ion cell ANR26650M1-B datasheet (a distributor copy, read through a search summary)',
        url: 'https://www.batteryspace.com/prod-specs/6610.pdf',
        read: READ,
      },
    ],
    verified: false,
    notes: `Cycle life is over 1000 cycles at 20 A discharge and 100 % depth of discharge; some datasheet revisions state it at 10 C (25 A) instead. The dimensions are the nominal 26650 size, estimated; the cell is about 25.85 x 65.15 mm. The datasheet gives an operating range of -30 to 55 degC, stored as the discharge window; it states no separate charge window, so those are unknown. The 2.0 V cutoff is the common figure for this cell, estimated. ${OCV_NOTE} ${HEAT_NOTE}`,
  },
  {
    id: 'cell/molicel-inr-21700-p42a',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'Molicel',
    partNumber: 'INR-21700-P42A',
    description: 'High-power cylindrical cell, 21700, 4.2 Ah',
    ratings: {
      chemistry: { text: 'NMC' },
      format: { text: '21700' },
      capacity: { value: ah(4.2) },
      nominalVoltage: { value: 3.6 },
      chargeVoltage: { value: 4.2, estimated: true },
      cutoffVoltage: { value: 2.5, estimated: true },
      standardChargeCurrent: { value: 4.2 },
      maxChargeCurrent: { unknown: true },
      continuousDischarge: { value: 45, basis: 'temperature cutoff not stated on the page' },
      resistanceDC: { unknown: true },
      specificHeatCapacity: SPECIFIC_HEAT_LAYERED,
    },
    dimensions: {
      diameter: { value: 21.7, estimated: true },
      length: { value: 70, estimated: true },
    },
    mass: { value: 0.07 },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title: 'Molicel, INR-21700-P42A product page',
        url: 'https://www.molicel.com/product/inr-21700-p42a/',
        read: READ,
      },
    ],
    verified: false,
    notes: `The product page gives capacity, nominal voltage, a 4.2 A charge current, 45 A continuous discharge and a 70 g maximum mass; the charge and cutoff voltages are the family's (as the P45B's), estimated, and the dimensions are the nominal 21700 size, estimated. Chemistry from the IEC 61960 designation INR (nickel-manganese). ${OCV_NOTE} ${HEAT_NOTE}`,
  },
  {
    id: 'cell/molicel-inr-21700-p45b',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'Molicel',
    partNumber: 'INR-21700-P45B',
    description: 'High-power cylindrical cell, 21700, 4.5 Ah',
    ratings: {
      chemistry: { text: 'NMC' },
      format: { text: '21700' },
      capacity: { value: ah(4.5) },
      minimumCapacity: { value: ah(4.3) },
      energy: { value: wh(16.2) },
      nominalVoltage: { value: 3.6 },
      chargeVoltage: { value: 4.2 },
      cutoffVoltage: { value: 2.5 },
      standardChargeCurrent: { value: 4.5 },
      maxChargeCurrent: { value: 13.5, basis: 'with a 70 degC cell temperature cutoff' },
      continuousDischarge: { value: 45, basis: 'with an 80 degC cell temperature cutoff' },
      impedanceAC: { value: 0.007, basis: '1 kHz AC at 30 % state of charge' },
      resistanceDC: {
        value: 0.015,
        basis: 'DC at 50 % state of charge; pulse length not recorded in T9.0c',
      },
      minChargeTemperature: { value: degC(0) },
      maxChargeTemperature: { value: degC(60) },
      minDischargeTemperature: { value: degC(-40) },
      maxDischargeTemperature: { value: degC(60) },
      specificHeatCapacity: SPECIFIC_HEAT_LAYERED,
    },
    dimensions: {
      diameter: { value: 21.7, estimated: true },
      length: { value: 70, estimated: true },
    },
    mass: { value: 0.07 },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title: 'Molicel, INR-21700-P45B product data sheet',
        url: 'https://www.molicel.com/wp-content/uploads/INR21700P45B_1.2_Product-Data-Sheet-of-INR-21700-P45B-80109.pdf',
        revision: '1.2',
        read: READ,
      },
    ],
    verified: false,
    notes: `Mass is the datasheet maximum. Dimensions are the nominal 21700 size, estimated. Peak (pulse) discharge was not recorded. Chemistry from the IEC 61960 designation INR (nickel-manganese). ${OCV_NOTE} ${HEAT_NOTE}`,
  },
  {
    id: 'cell/murata-us18650vtc3',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'Murata (formerly Sony)',
    partNumber: 'US18650VTC3',
    description: 'Small high-rate cylindrical cell, 18650, 1.6 Ah',
    ratings: {
      chemistry: { text: 'NMC' },
      format: { text: '18650' },
      capacity: { value: ah(1.6) },
      nominalVoltage: { value: 3.6 },
      chargeVoltage: { value: 4.2, estimated: true },
      cutoffVoltage: { value: 2.5, estimated: true },
      maxChargeCurrent: { unknown: true },
      continuousDischarge: { value: 30, basis: 'seller figure; temperature cutoff not stated' },
      resistanceDC: { unknown: true },
      specificHeatCapacity: SPECIFIC_HEAT_LAYERED,
    },
    dimensions: { diameter: { value: 18.35 }, length: { value: 65.1 } },
    mass: { value: 0.0451, estimated: true },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title:
          'e-foton, Sony VTC3 US18650VTC3 1600 mAh / 30 A (a distributor, read through a search summary)',
        url: 'https://e-foton.eu/en_US/p/Sony-VTC3-US18650VTC3-1600mAh-30A/179',
        read: READ,
      },
    ],
    verified: false,
    notes: `The small high-rate cell T9.0c asked for: sixteen in series hold 16 x 3.6 V x 1.6 Ah = 92.2 Wh, under the 100 Wh line, the class of a Voltra-like 16S pack. From a distributor; the charge and cutoff voltages are typical of the series, estimated, and the mass is the seller's approximate figure. The cell is old and may no longer be made. ${OCV_NOTE} ${HEAT_NOTE}`,
  },
  {
    id: 'cell/murata-us18650vtc6',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'Murata (formerly Sony)',
    partNumber: 'US18650VTC6',
    description: 'High-rate cylindrical cell, 18650, 3.0 Ah',
    ratings: {
      chemistry: { text: 'NMC' },
      format: { text: '18650' },
      capacity: { value: ah(3.12) },
      minimumCapacity: { value: ah(3.0) },
      nominalVoltage: { value: 3.6 },
      chargeVoltage: { value: 4.2 },
      cutoffVoltage: { value: 2.0 },
      standardChargeCurrent: { value: 3.0 },
      maxChargeCurrent: { value: 5, estimated: true, basis: 'commonly cited; not confirmed' },
      continuousDischarge: {
        value: 15,
        basis: 'continuous; 30 A is the thermal cutoff test point',
      },
      resistanceDC: { unknown: true },
      specificHeatCapacity: SPECIFIC_HEAT_LAYERED,
    },
    dimensions: {
      diameter: { value: 18.4, estimated: true },
      length: { value: 65, estimated: true },
    },
    mass: { value: 0.0466 },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title: 'Murata, US18650VTC6 product datasheet (read through a search summary)',
        url: 'https://www.murata.com/-/media/webrenewal/products/batteries/cylindrical/datasheet/us18650vtc6-product-datasheet.ashx',
        read: READ,
      },
    ],
    verified: false,
    notes: `Capacity is the nominal 3120 mAh; 3000 mAh is the rated minimum. The 2.0 V cutoff is the capacity rating's. Dimensions are the nominal 18650 size, estimated. ${OCV_NOTE} ${HEAT_NOTE}`,
  },
  {
    id: 'cell/samsung-inr18650-30q',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'Samsung SDI',
    partNumber: 'INR18650-30Q',
    description: 'High-rate cylindrical cell, 18650, 3.0 Ah',
    ratings: {
      chemistry: { text: 'NMC' },
      format: { text: '18650' },
      capacity: { value: ah(3.0) },
      minimumCapacity: { value: ah(2.95) },
      nominalVoltage: { value: 3.6 },
      chargeVoltage: { value: 4.2 },
      cutoffVoltage: { value: 2.5 },
      standardChargeCurrent: { value: 1.5 },
      maxChargeCurrent: { value: 4, basis: 'maximum charge current; conditions not recorded' },
      continuousDischarge: { value: 15, basis: 'maximum continuous; conditions not recorded' },
      impedanceAC: { value: 0.026, basis: 'maximum initial impedance, 1 kHz AC' },
      resistanceDC: { unknown: true },
      minChargeTemperature: { value: degC(0), estimated: true },
      maxChargeTemperature: { value: degC(50), estimated: true },
      minDischargeTemperature: { value: degC(-20), estimated: true },
      maxDischargeTemperature: { value: degC(75), estimated: true },
      specificHeatCapacity: SPECIFIC_HEAT_LAYERED,
    },
    dimensions: {
      diameter: { value: 18.4, estimated: true },
      length: { value: 65, estimated: true },
    },
    mass: { value: 0.048 },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title:
          'Samsung SDI, INR18650-30Q specification (a distributor copy, read through a search summary)',
        url: 'https://files.batteryjunction.com/frontend/files/samsung/datasheet/SAMSUNG-30Q-18650-3000-FLAT-Datasheet.pdf',
        read: READ,
      },
    ],
    verified: false,
    notes: `Mass is the specification's maximum. The temperature windows are the ones usually quoted for Samsung's 18650 cells, not confirmed for this one, estimated. ${OCV_NOTE} ${HEAT_NOTE}`,
  },
  {
    id: 'cell/samsung-inr21700-40t',
    version: 1,
    family: 'cell',
    fieldsVersion: 2,
    maker: 'Samsung SDI',
    partNumber: 'INR21700-40T',
    description: 'High-power cylindrical cell, 21700, 4.0 Ah',
    ratings: {
      chemistry: { text: 'NMC' },
      format: { text: '21700' },
      capacity: { value: ah(4.0) },
      minimumCapacity: { value: ah(3.9) },
      nominalVoltage: { value: 3.6 },
      chargeVoltage: { value: 4.2 },
      cutoffVoltage: { value: 2.5 },
      standardChargeCurrent: { value: 2 },
      maxChargeCurrent: { value: 6, basis: 'maximum charge current; conditions not recorded' },
      continuousDischarge: {
        value: 35,
        basis: 'continuous; 45 A with an 80 degC cell temperature cutoff',
      },
      resistanceDC: { unknown: true },
      specificHeatCapacity: SPECIFIC_HEAT_LAYERED,
    },
    dimensions: {
      diameter: { value: 21.7, estimated: true },
      length: { value: 70, estimated: true },
    },
    mass: { value: 0.067 },
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title:
          'NKON, Samsung INR21700-40T (a distributor summary of the datasheet, read through a search summary)',
        url: 'https://www.nkon.nl/en/samsung-inr21700-40t5-4000mah-35a.html',
        read: READ,
      },
    ],
    verified: false,
    notes: `From a distributor. Dimensions are the nominal 21700 size, estimated. ${OCV_NOTE} ${HEAT_NOTE}`,
  },
];
