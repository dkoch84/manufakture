// Built-in connector entries (T9.2e; ADR 0017 decision 7; T9.0c's field list for connectors).
// The battery and power connectors of hobby and light-vehicle builds (Amass XT30, XT60 and the
// anti-spark XT90-S, Anderson SB50) and the JST XH a balance lead uses, every one `verified: false`.
// Amass publishes little in English, so its ratings are read through distributors and Holybro's
// reproduction of Amass's table, whose continuous rating is 4 h and burst 1 min, each with under
// 60 °C rise. The number in an XT name is roughly its burst rating, not its continuous one, and
// sellers often quote the name. Ratings are SI (A, V, ohm, K). Nothing here says a connector suits
// a circuit: the electrical check (T9.5f) compares its continuous current with the wire's.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

const HOLYBRO = {
  title:
    'Holybro, connector and wire rating (genuine Amass ratings: continuous 4 h, burst 1 min, temperature rise under 60 °C)',
  url: 'https://docs.holybro.com/power-module-and-pdb/power-module/connector-and-wire-rating',
  read: READ,
};
const AMASS_CONTINUOUS = '4 h with under 60 °C rise (Amass, as Holybro reproduces it)';
const AMASS_BURST = '1 min with under 60 °C rise (Amass, as Holybro reproduces it)';

/** The built-in connectors, every version. */
export const CONNECTOR_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'connector/amass-xt30u',
    version: 1,
    family: 'connector',
    fieldsVersion: 2,
    maker: 'Amass',
    partNumber: 'XT30U-M / XT30U-F',
    description: 'Two-pole DC power connector, solder cup, 2 mm gold-plated contacts',
    ratings: {
      poles: { value: 2 },
      continuousCurrent: { value: 15, basis: 'seller figure; test conditions not stated' },
      burstCurrent: { value: 30, basis: 'seller figure (peak); duration not stated' },
      voltageRating: { value: 500, estimated: true },
      contactResistance: { value: 0.7e-3, estimated: true },
      matingCycles: { value: 1000, estimated: true },
      wireRange: { unknown: true },
      antiSpark: { text: 'no' },
      minOperatingTemperature: { value: degC(-20), estimated: true },
      maxOperatingTemperature: { value: degC(120), estimated: true },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'mjbots, Amass XT30U-M (seller; continuous and peak current 15 and 30 A)',
        url: 'https://mjbots.com/products/xt30u-m',
        read: READ,
      },
      {
        title:
          'Amass XT30U datasheet, read through a search summary of distributor listings (500 V DC, 0.7 mOhm, 1000 cycles, -20 to 120 °C)',
        url: 'https://www.lcsc.com/product-detail/plug_Changzhou-Amass-Elec-XT30U-F_C99102.html',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "The current ratings are the seller's; the voltage, contact resistance, mating cycles and temperature window came from a search summary of distributor listings and are marked estimated until read from an Amass sheet. Holybro's table of Amass ratings does not list the XT30. For the logic and accessory side of a pack, not the motor bus.",
  },
  {
    id: 'connector/amass-xt60',
    version: 1,
    family: 'connector',
    fieldsVersion: 2,
    maker: 'Amass',
    partNumber: 'XT60-M / XT60-F',
    description: 'Two-pole DC power connector, solder cup, 3.5 mm gold flash brass contacts',
    ratings: {
      poles: { value: 2 },
      continuousCurrent: { value: 30, basis: AMASS_CONTINUOUS },
      burstCurrent: { value: 60, basis: AMASS_BURST },
      voltageRating: { value: 500 },
      contactResistance: { unknown: true },
      matingCycles: { value: 1000 },
      wireRange: { text: '12 AWG' },
      antiSpark: { text: 'no' },
      minOperatingTemperature: { value: degC(-20) },
      maxOperatingTemperature: { value: degC(120) },
    },
    mass: { value: 0.003 },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      HOLYBRO,
      {
        title:
          "berrybase, AMASS XT60 male datasheet (a distributor's sheet: 500 V, 1000 cycles, -20 to 120 °C, UL94 V-0 polyamide)",
        url: 'https://www.berrybase.de/en/product-datasheet/0192afa30c5f70b7a5796f0d1be4af74/create',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Mass is the male half, as the distributor gives it. The distributor's figures are not checked against an Amass document. The 60 in the name is the burst rating; 30 A is continuous, with 12 AWG wire.",
  },
  {
    id: 'connector/amass-xt90-s',
    version: 1,
    family: 'connector',
    fieldsVersion: 2,
    maker: 'Amass',
    partNumber: 'XT90-S (anti-spark)',
    description:
      'Two-pole DC power connector with an anti-spark pre-charge contact, 4.5 mm gold-plated contacts',
    ratings: {
      poles: { value: 2 },
      continuousCurrent: {
        value: 40,
        basis: 'seller figure (nominal current); conditions not stated',
      },
      burstCurrent: { value: 90, basis: AMASS_BURST },
      voltageRating: { value: 500 },
      contactResistance: { value: 1.0e-3, estimated: true },
      matingCycles: { value: 1000, estimated: true },
      wireRange: { text: '10 AWG' },
      antiSpark: { text: 'yes' },
      minOperatingTemperature: { value: degC(-20) },
      maxOperatingTemperature: { value: degC(120) },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Aerobotic Shop, AMASS XT90-S anti-spark connector (seller: 40 A nominal, 90 A maximum, 500 V DC, 10 AWG, -20 to 120 °C)',
        url: 'https://aeroboticshop.com/products/amass-xt90-s',
        read: READ,
      },
      HOLYBRO,
    ],
    verified: false,
    notes:
      "Holybro's table of Amass ratings gives the plain XT90 45 A continuous and 90 A burst; this seller gives the anti-spark version 40 A nominal, which is stored. The anti-spark contact meets first through a resistor so a controller's bus capacitors charge slowly; it is not rated to break load. Contact resistance (1 mOhm per contact) and 1000 mating cycles come from other sellers' listings, read through a search summary, and are marked estimated. The class of connector for a 16S pack's main lead.",
  },
  {
    id: 'connector/anderson-sb50',
    version: 1,
    family: 'connector',
    fieldsVersion: 2,
    maker: 'Anderson Power Products',
    partNumber: 'SB50 housing (992 series) with silver-plated wire contacts',
    description: 'Genderless two-pole DC power connector, hot-plug rated',
    ratings: {
      poles: { value: 2 },
      continuousCurrent: {
        value: 50,
        basis:
          "UL rating as a summary of the maker's sheet gives it; up to 120 A with 6 AWG contacts",
      },
      burstCurrent: { unknown: true },
      voltageRating: { value: 600 },
      contactResistance: { value: 200e-6, basis: 'average' },
      matingCycles: { value: 10000 },
      wireRange: {
        text: '16 to 6 AWG (1.5 to 13.3 mm²), by contact; 12 to 10 AWG for contact 5915',
      },
      antiSpark: { text: 'no' },
      minOperatingTemperature: { value: degC(-20) },
      maxOperatingTemperature: { value: degC(105) },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          "Anderson Power Products, SB50 connectors catalogue pages (a distributor's copy: housings, silver contacts to 10,000 cycles, UL hot plugging to 50 A)",
        url: 'https://powerwerx.azureedge.net/productattachments/ds-sb50.pdf',
        read: READ,
      },
      {
        title:
          'Anderson Power Products, SB50 standard housings, black (product page: -20 to 105 °C, 10,000 cycles)',
        url: 'https://www.andersonpower.com/product/sb50-standard-housings-black/',
        read: READ,
      },
      {
        title:
          'Anderson Power Products SB50 datasheet, read through a search summary (UL 50 A, 600 V, 200 microohm average, 250 hot plug cycles at 120 V 50 A)',
        url: 'https://www.alldatasheet.com/datasheet-pdf/pdf/1577520/APP/SB50.html',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'The continuous current depends on the contact and wire: the catalogue allows UL ratings to 120 A, and 50 A is the figure stored. The voltage rating, contact resistance and hot-plug life (250 cycles at 120 V and 50 A) came from a search summary of the datasheet. Hot plugging is the one rated way to break load with a connector here; the others are not.',
  },
  {
    id: 'connector/jst-xh-17',
    version: 1,
    family: 'connector',
    fieldsVersion: 2,
    maker: 'JST',
    partNumber: 'XHP-17 housing, XH series',
    description: 'XH 2.5 mm pitch wire-to-board connector, 17 positions (a 16S balance lead)',
    ratings: {
      poles: { value: 17 },
      continuousCurrent: { value: 3, basis: 'per contact with AWG 22 wire, AC or DC' },
      burstCurrent: { unknown: true },
      voltageRating: { value: 250 },
      contactResistance: {
        value: 10e-3,
        basis: 'initial, maximum; 20 mOhm after environmental tests',
      },
      matingCycles: { unknown: true },
      wireRange: { text: '30 to 22 AWG (0.05 to 0.33 mm²), insulation 0.9 to 1.9 mm' },
      antiSpark: { text: 'no' },
      minOperatingTemperature: { value: degC(-25) },
      maxOperatingTemperature: { value: degC(85) },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'JST, XH connector product page (3 A with AWG 22, 250 V, -25 to 85 °C, wire range)',
        url: 'https://www.jst-mfg.com/product/detail_e.php?series=277',
        read: READ,
      },
      {
        title:
          "JST, XH connector catalogue page eXH (Pololu's copy; contact resistance 10 and 20 mOhm max)",
        url: 'https://www.pololu.com/file/0J372/JST_eXH.pdf',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "The temperature window includes the contacts' own rise under current. JST states no mating cycle figure on these pages. A balance lead carries the BMS's balancing and sense currents (tens of milliamperes), far below 3 A; the rating matters only if a fault drives pack current through a sense wire, which the lead's fuse or the BMS's own protection must stop. The housing part number follows JST's XHP-n naming for n positions; it was not read from a datasheet.",
  },
];
