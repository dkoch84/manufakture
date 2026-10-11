// Built-in switch and contactor entries (T9.2e; ADR 0017 decision 7; T9.0c's field list for
// switches and contactors). A sealed DC contactor (TE KILOVAC EV200), a marine battery switch (Blue
// Sea Systems m-Series) and a panel rocker (Carling Technologies V-Series), every one
// `verified: false`. Together they show T9.0c's warning: a switch's DC breaking rating is stated
// at a voltage and is far below its carrying rating, and the battery switch states none at all, so
// it isolates a pack but must not open under load. Neither the battery switch (48 V) nor the rocker
// (12 V) may switch a 16S pack's 67.2 V bus; the contactor (12 to 900 V) may. Ratings are SI (A, V,
// W, ohm, K). Nothing here says a switch suits a circuit.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

/** The built-in switches and contactors, every version. */
export const SWITCH_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'switch/te-kilovac-ev200aaana',
    version: 1,
    family: 'switch',
    fieldsVersion: 2,
    maker: 'TE Connectivity (KILOVAC)',
    partNumber: 'EV200AAANA',
    description:
      'Sealed DC contactor, 1 form X (SPST-NO), 500 A carry, 12 to 900 V DC, 9 to 36 V coil with economizer',
    ratings: {
      kind: { text: 'contactor' },
      continuousCurrent: { value: 500, basis: 'typical, at 85 °C with 400 kcmil conductors' },
      shortTimeCurrent: { unknown: true },
      breakingCurrent: {
        value: 2000,
        basis:
          'once (1 cycle); the contactor then no longer meets its dielectric and insulation figures',
      },
      breakingVoltage: { value: 320 },
      makingCurrent: { unknown: true },
      voltageRating: { value: 900 },
      electricalLife: { unknown: true },
      mechanicalLife: { value: 1_000_000 },
      contactResistance: { value: 0.2e-3, basis: 'typical, at 200 A' },
      coilVoltage: { value: 12 },
      coilHoldPower: { value: 1.7, basis: 'at 12 V DC, with the built-in economizer' },
      coilInrushCurrent: { value: 3.8 },
      auxiliaryContacts: { text: 'none (H and G versions have one, 2 A at 30 V DC)' },
      minOperatingTemperature: { value: degC(-40) },
      maxOperatingTemperature: { value: degC(85) },
    },
    mass: { value: 0.43 },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          "TE Connectivity, KILOVAC EV200 series contactor catalogue page 35 (Digi-Key's copy)",
        url: 'https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/5986/EV200_Series.pdf',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'Rated operating voltage 12 to 900 V DC. Make and break current at other voltages, and the load life, are graphs on the next page, not read, so electrical life is unknown. Coil A operates from 9 to 36 V DC: pickup 9 V maximum, dropout 6 V minimum, inrush 3.8 A for up to 130 ms, then 0.13 A at 12 V. Close 15 ms typical, release up to 12 ms at 2000 A. Far larger than a 1.7 Ah trainer pack needs; the class of sealed contactor a pack disconnect uses, and the one listed here whose DC rating covers a 16S bus.',
  },
  {
    id: 'switch/blue-sea-6006',
    version: 1,
    family: 'switch',
    fieldsVersion: 2,
    maker: 'Blue Sea Systems',
    partNumber: '6006 (m-Series mini battery switch, on-off)',
    description: 'Single circuit on-off battery switch with knob, 3/8 in (M10) studs',
    ratings: {
      kind: { text: 'rotary' },
      continuousCurrent: { value: 300, basis: 'continuous rating; ambient not stated' },
      shortTimeCurrent: { value: 500, basis: 'intermittent, 5 min' },
      breakingCurrent: { unknown: true },
      breakingVoltage: { unknown: true },
      makingCurrent: { unknown: true },
      voltageRating: { value: 48 },
      electricalLife: { unknown: true },
      mechanicalLife: { unknown: true },
      contactResistance: { unknown: true },
      auxiliaryContacts: { text: 'none' },
    },
    mass: { value: 0.29 },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Marine Electricals, Blue Sea Systems 6006 m-Series mini on-off battery switch (distributor: 300 A continuous, 500 A for 5 min, 900 A cranking for 30 s, 48 V DC, 0.29 kg)',
        url: 'https://www.marine-electricals.co.uk/product/blue-sea-systems-6006-m-series-mini-on-off-battery-switch-with-knob-red/',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Cranking 900 A for 30 s (another seller, read through a search summary, gives 1500 A for 10 s and 775 A for 1 min). No DC breaking rating is stated, so it is unknown: a battery switch isolates a pack at rest and should not be opened under load. Ignition protected, tinned copper studs. Rated 48 V DC: not for a 16S pack's 67.2 V.",
  },
  {
    id: 'switch/carling-v-series-vld1',
    version: 1,
    family: 'switch',
    fieldsVersion: 2,
    maker: 'Carling Technologies',
    partNumber: 'VLD1S00B-AZC00-000 (V-Series)',
    description: 'Sealed panel rocker switch, DPDT, 20 A at 12 V DC, quick-connect terminals',
    ratings: {
      kind: { text: 'rocker' },
      continuousCurrent: { value: 20, basis: 'at 12 V DC, as the listing states it' },
      shortTimeCurrent: { unknown: true },
      breakingCurrent: { value: 20, basis: 'the switching rating, at 12 V DC' },
      breakingVoltage: { value: 12 },
      makingCurrent: { unknown: true },
      voltageRating: { value: 12 },
      electricalLife: { value: 100_000 },
      mechanicalLife: { value: 100_000 },
      contactResistance: { unknown: true },
      auxiliaryContacts: { text: 'none' },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Digi-Key, Carling Technologies VLD1S00B-AZC00-000 (distributor listing, read through a search summary: 20 A at 12 V DC, 100,000 cycles electrical and mechanical)',
        url: 'https://www.digikey.com/en/products/detail/carling-technologies/VLD1S00B-AZC00-000/16474862',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Distributor listings give the actuation as momentary on, none, momentary on in one place and on-off-on in another; check the code against Carling's catalogue before buying. A 12 V DC rocker: switching a 67.2 V bus with it would draw an arc its contacts are not rated to break. In a 16S build such a switch belongs in the low-current coil or enable circuit of a contactor, not in the power path.",
  },
];
