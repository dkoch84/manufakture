// Built-in battery management system entries (T9.2c; ADR 0017 decision 7). T9.0c researched no
// BMS boards, so these are common hobby and light-vehicle boards read through distributor pages
// and search summaries, every one `verified: false`, with the protection thresholds the board is
// sold set to (most are configurable). Ratings are SI (A, V, s, K), dimensions millimetres, mass
// kilograms. A BMS's current ratings are its MOSFETs' and are compared with the pack's own
// limits by the checks; nothing here says a board protects a pack adequately.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

/** The built-in BMS boards, every version. */
export const BMS_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'bms/daly-smart-16s-liion-30a',
    version: 1,
    family: 'bms',
    fieldsVersion: 2,
    maker: 'Daly',
    partNumber: 'Smart BMS Li-ion 16S 60V 30A',
    description: 'Protection board with passive balancing and UART/Bluetooth, 16S lithium-ion',
    ratings: {
      minCells: { value: 16 },
      maxCells: { value: 16 },
      chemistry: { text: 'NMC' },
      continuousDischarge: { value: 30 },
      continuousCharge: { unknown: true },
      peakDischarge: { unknown: true },
      balancing: { text: 'passive' },
      balanceCurrent: { value: 0.035 },
      standbyCurrent: { value: 100e-6 },
      overchargeVoltage: { value: 4.25 },
      overdischargeVoltage: { value: 2.7 },
      shortCircuitDelay: { unknown: true },
      protections: {
        text: 'cell overcharge and overdischarge, overcurrent, short circuit, temperature',
      },
      communication: { text: 'UART, Bluetooth module' },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Cell Supply, Daly 16S 60V 30A Smart BMS (a distributor, read through a search summary)',
        url: 'https://www.cellsupply.co.uk/daly-16s-60v-30a-smart-bms',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'Sold set for 3.7 V class lithium-ion cells (NMC or NCA; stored as NMC): overcharge 4.25 V (release 4.19 V) and overdischarge 2.7 V cut-off; the same listing also quotes 2.8 V as the overdischarge detection voltage, so check which the board is set to. Balancing 35 mA, starting at 4.18 V. Standby is the 100 uA working current; it sleeps at about 20 uA. The charge current limit and short-circuit timing were not in the summary. The class of board a 16S lithium-ion pack (67.2 V full) needs.',
  },
  {
    id: 'bms/daly-16s-lfp-40a',
    version: 1,
    family: 'bms',
    fieldsVersion: 2,
    maker: 'Daly',
    partNumber: 'LiFePO4 16S 48V 40A, common port',
    description: 'Protection board with passive balancing, 16S LFP',
    ratings: {
      minCells: { value: 16 },
      maxCells: { value: 16 },
      chemistry: { text: 'LFP' },
      continuousDischarge: { value: 40 },
      continuousCharge: { value: 20 },
      peakDischarge: { value: 120, basis: 'peak, 120 plus or minus 20 A; duration not stated' },
      balancing: { text: 'passive' },
      balanceCurrent: { value: 0.03 },
      standbyCurrent: { unknown: true },
      overchargeVoltage: { value: 3.75 },
      overdischargeVoltage: { value: 2.2 },
      shortCircuitDelay: { unknown: true },
      protections: {
        text: 'cell overcharge and overdischarge, overcurrent, short circuit, temperature',
      },
      communication: { text: 'none' },
      minOperatingTemperature: { value: degC(-20) },
      maxOperatingTemperature: { value: degC(70) },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Quartz Components, DALY LiFePO4 16S 48V 40A waterproof BMS (a distributor, read through a search summary)',
        url: 'https://quartzcomponents.com/products/daly-lifepo4-16s-48v-40a-waterproof-battery-management-system-bms-protection-board',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'Overcharge 3.75 V per cell with a 1 s delay; the charge voltage the listing names is 58.4 V (16 x 3.65 V). Balancing 30 plus or minus 5 mA. The same board sold for lithium-ion cells protects at 4.25 V.',
  },
  {
    id: 'bms/overkill-solar-16s-100a-lfp',
    version: 1,
    family: 'bms',
    fieldsVersion: 2,
    maker: 'Overkill Solar (made by JBD)',
    partNumber: '16s BMS 100a for LifePo4',
    description: 'Smart protection board with passive balancing and Bluetooth, 16S LFP',
    ratings: {
      minCells: { value: 16 },
      maxCells: { value: 16 },
      chemistry: { text: 'LFP' },
      continuousDischarge: { value: 100 },
      continuousCharge: { value: 100 },
      peakDischarge: { unknown: true },
      balancing: { text: 'passive' },
      balanceCurrent: { value: 0.02 },
      standbyCurrent: { unknown: true },
      overchargeVoltage: { value: 3.65 },
      overdischargeVoltage: { value: 2.5 },
      shortCircuitDelay: { unknown: true },
      protections: {
        text: 'cell overvoltage and undervoltage (2 s delay), overcurrent, short circuit, temperature',
      },
      communication: { text: 'Bluetooth, UART' },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'Overkill Solar, 16s BMS 100a for LifePo4 product page',
        url: 'https://overkillsolar.com/product/bms-100a-16s-lifepo4-12/',
        read: READ,
      },
      {
        title: 'Overkill Solar BMS instruction manual (a copy, read through a search summary)',
        url: 'https://offgridcabin.wordpress.com/wp-content/uploads/2021/11/overkill_solar_bms_instruction_manual.pdf',
        revision: '0.2.5',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Balancing is 20 to 40 mA; the low end is stored. The thresholds are the manual's recommended settings (overvoltage 3650 mV, release 3500 mV; undervoltage 2500 mV, release 3000 mV), all configurable over Bluetooth. Standby current and short-circuit timing were not in the summary.",
  },
];
