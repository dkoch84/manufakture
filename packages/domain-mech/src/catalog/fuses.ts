// Built-in fuse entries (T9.2e; ADR 0017 decision 7; T9.0c's field list for fuses). Three
// automotive-style fuses at three DC voltage classes, every one `verified: false`: an ordinary ATO
// blade (32 V), Littelfuse's TAC ATO-style blade rated 58 V (for 48 V systems) and its MIDI High
// Performance bolt-down fuse rated 70 V. The voltage class is the point: a 16S lithium-ion pack is
// 67.2 V full, above both blades, so only the 70 V part may protect it (T9.0c R17). The blade
// figures are from Littelfuse catalogue pages (distributors' copies); the MIDI's from a search
// summary, since Littelfuse's own pages refuse automated reads. Ratings are SI (A, V, s, ohm, K);
// I²t is a plain number in A²s. Nothing here says a fuse protects a circuit: the electrical check
// (T9.5f) compares its interrupting rating with the pack's short-circuit current and its opening
// times with the wire's.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

/** The built-in fuses, every version. */
export const FUSE_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'fuse/littelfuse-ato-32v-20a',
    version: 1,
    family: 'fuse',
    fieldsVersion: 2,
    maker: 'Littelfuse',
    partNumber: '0257020 (ATO, 20 A)',
    description: 'ATO blade fuse, 20 A, 32 V DC',
    ratings: {
      rating: { value: 20 },
      voltageRating: { value: 32 },
      interruptingRating: { value: 1000, basis: 'at 32 V DC' },
      interruptingVoltage: { value: 32 },
      format: { text: 'ATO' },
      timeCurrentClass: {
        text: 'ISO 8820-3 blade: 110 % holds 100 h; 135 % opens in 0.75 to 600 s; 200 % in 0.15 to 5 s; 350 % in 0.08 to 0.5 s',
      },
      maxOpeningTime135: { value: 600 },
      maxOpeningTime200: { value: 5 },
      i2t: { value: 520 },
      coldResistance: { value: 3.38e-3 },
      voltageDrop: { value: 0.098, basis: 'typical, at rated current' },
      continuousFraction: { unknown: true },
      minOperatingTemperature: { value: degC(-40) },
      maxOperatingTemperature: { value: degC(105) },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          "Littelfuse, ATO blade fuse rated 32 V, 257 series, transportation products catalogue (Digi-Key's copy)",
        url: 'https://media.digikey.com/pdf/Data%20Sheets/Littelfuse%20PDFs/257%20Series.pdf',
        revision: '2010',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'Opening times are for 3 to 40 A ratings. The sheet gives a temperature rerating curve but no fixed continuous fraction, so it is unknown here; the 58 V version below states 0.75 at 23 °C. Rated 32 V: not for a 48 V or 16S bus, whatever its current.',
  },
  {
    id: 'fuse/littelfuse-tac-ato-58v-30a',
    version: 1,
    family: 'fuse',
    fieldsVersion: 2,
    maker: 'Littelfuse',
    partNumber: '142.6185.530 (TAC ATO style, 30 A, 58 V)',
    description: 'ATO-style blade fuse rated 58 V DC, 30 A, transparent cover',
    ratings: {
      rating: { value: 30 },
      voltageRating: { value: 58 },
      interruptingRating: { value: 1000, basis: 'at 58 V DC' },
      interruptingVoltage: { value: 58 },
      format: { text: 'ATO' },
      timeCurrentClass: {
        text: 'ISO 8820-3 blade: 110 % holds 100 h; 135 % opens in 0.75 to 1800 s; 200 % in 0.15 to 5 s; 350 % in 0.04 to 0.5 s',
      },
      maxOpeningTime135: { value: 1800 },
      maxOpeningTime200: { value: 5 },
      i2t: { value: 1070 },
      coldResistance: { value: 1.9e-3 },
      voltageDrop: { value: 0.08, basis: 'typical, at rated current' },
      continuousFraction: { value: 0.75 },
      minOperatingTemperature: { unknown: true },
      maxOperatingTemperature: { unknown: true },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          "Littelfuse, TAC ATO style blade fuse rated 58 V, transportation products catalogue (Farnell's copy)",
        url: 'https://www.farnell.com/datasheets/2000040.pdf',
        revision: '2012',
        read: READ,
      },
      {
        title:
          'Littelfuse, TAC ATO style blade fuse rated 58 V (named in T9.0c; the distributor refuses automated reads)',
        url: 'https://www.mouser.com/datasheet/2/240/Littelfuse-Automotive-Blade-Fuse-TAC-ATO-58V-23798.pdf',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "FI = 1.33: the largest continuous current is 0.75 x the rating at 23 °C, so 22.5 A here, less when hot. The cold resistance is the maker's maximum. Complies with ISO 8820-3 and UL 248 special purpose fuses. Rated 58 V: right for a 48 V (13S or 14S) bus, but below a 16S pack's 67.2 V full charge.",
  },
  {
    id: 'fuse/littelfuse-midi-hp-70v-30a',
    version: 1,
    family: 'fuse',
    fieldsVersion: 2,
    maker: 'Littelfuse',
    partNumber: '4998030 (MIDI High Performance 70 V, 30 A)',
    description: 'MIDI bolt-down fuse rated 70 V DC, 30 A, time delay, M6 studs',
    ratings: {
      rating: { value: 30 },
      voltageRating: { value: 70 },
      interruptingRating: { value: 2500, basis: 'at 70 V DC' },
      interruptingVoltage: { value: 70 },
      format: { text: 'MIDI' },
      timeCurrentClass: { text: 'time delay (diffusion pill); opening times not read' },
      maxOpeningTime135: { unknown: true },
      maxOpeningTime200: { unknown: true },
      i2t: { value: 3200 },
      coldResistance: { unknown: true },
      voltageDrop: { unknown: true },
      continuousFraction: { unknown: true },
      minOperatingTemperature: { value: degC(-40) },
      maxOperatingTemperature: { value: degC(125) },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Littelfuse, MIDI High Performance 70 V fuse datasheet (4998 series), read through a search summary (70 V DC, 2500 A at 70 V DC, I²t 3200 A²s typical for 30 A, -40 to 125 °C)',
        url: 'https://www.littelfuse.com/assetdocs/littelfuse-datasheet-4998-midihp70v?assetguid=b72fcd7a-c66d-4916-844c-ac55ebed196c',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Littelfuse's pages refuse automated reads, so every value is from a search summary of the datasheet and the product pages; the I²t is the typical one. The time-current table, cold resistance and voltage drop are in the datasheet but were not read. Bolt-down on M6 studs, 9 N*m. Rated 70 V: the class a 16S pack (67.2 V full) needs; 2500 A interrupting is well above such a pack's estimated short-circuit current of a few hundred amperes.",
  },
];
