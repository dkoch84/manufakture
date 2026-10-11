// Built-in braking resistor entries (T9.2e; ADR 0017 decision 7; T9.0c's field list for braking
// resistors). Aluminium-housed wirewound resistors of the size a cable trainer's chopper needs:
// TE's HCH braking resistors, which publish pulse loads for 1, 5 and 40 s in a 120 s cycle, an Arcol
// HS100, which publishes its heat-sink and free-air ratings and thermal rise but no pulse figure, and
// the ODrive 2 ohm 50 W part T9.0c found, of which only the two headline numbers are known. Every
// one is `verified: false`. Ratings are SI (ohm, W, J, s, V, K/W, K); tolerance a fraction.
//
// The cable trainer's numbers (docs/plans/m9.md): each 200 lbf pull returns about 530 J to the bus,
// at up to about 1.1 kW. A resistor of R ohms on a chopper at bus voltage V takes at most V² / R, so
// 1.1 kW at 67.2 V (16S full) needs R at most 4.1 ohm, and the pulse energy and continuous power
// both bound it: a 1 s pulse rating covers one pull, the continuous rating the average over a set
// (530 J every 4 s is about 130 W). Nothing here says a resistor suffices: the checks state margins.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

const TE_HCH = {
  title:
    "TE Connectivity, aluminium housed braking resistor, type HCH series, 1773309-4 rev. A (Farnell's copy)",
  url: 'https://www.farnell.com/datasheets/3195275.pdf',
  revision: '1773309-4 rev. A, 02/2021',
  read: READ,
};
const TE_NOTE =
  'TE tested each overload for 1, 5 or 40 s within a 120 s cycle (duty 0.83, 4.16 and 33.3 %), 10,000 times, with under 5 % change in resistance; the 1 s figure is stored as the pulse energy. The rated continuous working voltage is the square root of power times resistance, so above it the resistor runs only in pulses, as on a chopper. The sheet does not state the mounting behind the continuous rating, a thermal time constant or the cross-section. Flying leads 300 mm, PTFE, 200 °C; IP54.';

/** The built-in braking resistors, every version. */
export const RESISTOR_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'resistor/te-hch165-6r8',
    version: 1,
    family: 'resistor',
    fieldsVersion: 2,
    maker: 'TE Connectivity',
    partNumber: 'HCH165 6R8 J',
    description: 'Aluminium housed wirewound braking resistor, 6.8 ohm, 200 W, 165 mm',
    ratings: {
      resistance: { value: 6.8 },
      tolerance: { value: 0.05 },
      continuousPower: { value: 200, basis: 'at 40 °C ambient; mounting not stated' },
      freeAirPower: { unknown: true },
      pulseEnergy: { value: 7000, basis: '7000 W for 1 s once in a 120 s cycle, 40 °C' },
      pulseDuration: { value: 1 },
      pulsePeriod: { value: 120 },
      thermalTimeConstant: { unknown: true },
      thermalResistance: { unknown: true },
      voltageRating: { value: 1100 },
      maxSurfaceTemperature: { value: degC(320) },
    },
    dimensions: { length: { value: 165 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [TE_HCH],
    verified: false,
    notes: `Pulse loads at 6.8 ohm: 7000 W for 1 s, 2200 W for 5 s (11 kJ), 450 W for 40 s (18 kJ). Maximum temperature 320 °C. At 67.2 V it takes at most 664 W, so a 530 J pull lasts about 0.8 s, inside the 1 s rating; but 664 W is short of the plan's 1.1 kW peak, and two in parallel (3.4 ohm, 1.33 kW) would cover it. Rated continuous working voltage 36.9 V. ${TE_NOTE}`,
  },
  {
    id: 'resistor/te-hch215-6r8',
    version: 1,
    family: 'resistor',
    fieldsVersion: 2,
    maker: 'TE Connectivity',
    partNumber: 'HCH215 6R8 J',
    description: 'Aluminium housed wirewound braking resistor, 6.8 ohm, 300 W, 215 mm',
    ratings: {
      resistance: { value: 6.8 },
      tolerance: { value: 0.05 },
      continuousPower: { value: 300, basis: 'at 40 °C ambient; mounting not stated' },
      freeAirPower: { unknown: true },
      pulseEnergy: { value: 12000, basis: '12000 W for 1 s once in a 120 s cycle, 40 °C' },
      pulseDuration: { value: 1 },
      pulsePeriod: { value: 120 },
      thermalTimeConstant: { unknown: true },
      thermalResistance: { unknown: true },
      voltageRating: { value: 1100 },
      maxSurfaceTemperature: { value: degC(330) },
    },
    dimensions: { length: { value: 215 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [TE_HCH],
    verified: false,
    notes: `Pulse loads at 6.8 ohm: 12000 W for 1 s, 4600 W for 5 s (23 kJ), 675 W for 40 s (27 kJ). Maximum temperature 330 °C. Same 664 W ceiling at 67.2 V as the HCH165: the extra rating buys continuous power and pulse margin, not peak power, which only a lower resistance gives. At 215 mm long it does not fit a 323 mm by 139 mm by 100 mm trainer housing easily. Rated continuous working voltage 45.2 V. ${TE_NOTE}`,
  },
  {
    id: 'resistor/arcol-hs100-3r3',
    version: 1,
    family: 'resistor',
    fieldsVersion: 2,
    maker: 'Arcol (Ohmite)',
    partNumber: 'HS100 3R3 J',
    description: 'Aluminium housed wirewound resistor, 3.3 ohm, 100 W on a heat sink',
    ratings: {
      resistance: { value: 3.3 },
      tolerance: { value: 0.05 },
      continuousPower: {
        value: 100,
        basis:
          'at 25 °C on the standard heat sink, 995 cm² of 3 mm aluminium, with heat sink compound',
      },
      freeAirPower: { value: 30, basis: 'at 25 °C, no heat sink' },
      pulseEnergy: { unknown: true },
      thermalTimeConstant: { unknown: true },
      thermalResistance: {
        value: 1.0,
        basis: 'typical surface temperature rise per watt, mounted on the standard heat sink',
      },
      voltageRating: { value: 1900 },
      maxSurfaceTemperature: { value: degC(200) },
    },
    mass: { value: 0.115 },
    dimensions: { length: { value: 88 }, width: { value: 47.5 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          "Arcol, HS aluminium housed resistors datasheet, 12/14.08 (Digi-Key's copy; HS10 to HS300 ratings, heat sinks and dimensions)",
        url: 'https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/9026/HS%20Aluminium%20Housed%20Resistors.pdf',
        revision: '12/14.08',
        read: READ,
      },
      {
        title: 'Ohmite, Arcol aluminium housed HS series (the line under its current owner)',
        url: 'https://www.ohmite.com/arcolresistors/hs-aluminum-housed/',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'The 200 °C is the maximum hot spot temperature, which the sheet says must not be exceeded; dissipation derates linearly to zero at 200 °C ambient. Voltage is the limiting element voltage. The sheet calls the series wound for high pulse capability but gives no pulse figure, so the pulse energy is unknown and a check must not assume one. At 67.2 V, 3.3 ohm takes up to 1.37 kW, enough for the 1.1 kW peak, but 100 W needs the full heat sink: an average of 130 W over a set is beyond it. Tolerance J is 5 %. Length and width are the maximum body dimensions; the height was not read.',
  },
  {
    id: 'resistor/odrive-2r-50w',
    version: 1,
    family: 'resistor',
    fieldsVersion: 2,
    maker: 'ODrive Robotics',
    partNumber: 'ACC-0006 (brake resistor, 2 ohm 50 W, set of 8)',
    description: 'Brake resistor for ODrive controllers, 2 ohm, 50 W',
    ratings: {
      resistance: { value: 2 },
      tolerance: { unknown: true },
      continuousPower: {
        value: 50,
        basis: 'seller figure; conditions not stated (community notes say some moving air)',
      },
      freeAirPower: { unknown: true },
      pulseEnergy: { unknown: true },
      thermalTimeConstant: { unknown: true },
      thermalResistance: { unknown: true },
      voltageRating: { unknown: true },
      maxSurfaceTemperature: { unknown: true },
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'ODrive Robotics shop, set of 8 brake resistors (2 ohm, 50 W; the part supplied may vary)',
        url: 'https://shop.odriverobotics.com/products/set-of-8-brake-resistors',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'The shop says the resistor supplied may differ from the one pictured but will match in size and rating, so no maker is named and only resistance and power are known. T9.0c: at 58 V it takes up to 1.7 kW, but 50 W continuous is well under the 130 W a set of 200 lbf pulls averages, so pulse energy and the thermal time constant are needed before it can be judged.',
  },
];
