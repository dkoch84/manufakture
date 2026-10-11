// Built-in wire entries (T9.2e; ADR 0017 decision 7; T9.0c's field list for wire). Six sizes of
// the fine-stranded silicone wire hobby and light-vehicle packs use, 10 to 22 AWG, from one seller's
// listings (BNTECHGO: strand count and diameter, outer diameter, 600 V, -60 to 200 °C), every one
// `verified: false`. The seller states no resistance, ampacity or mass, so:
//
// - The conductor area is the stated stranding's (strands x pi d² / 4); the 16, 18 and 22 AWG
//   sizes come out 3 to 8 % under the nominal AWG area, which is common in fine-stranded wire.
// - The resistance is annealed copper's resistivity at 20 °C (1.7241e-8 Ω*m, IACS) over that area,
//   marked estimated: tinning and the strands' lay add a little.
// - The mass is copper (8890 kg/m³, plus 2 % for the lay) and silicone (about 1200 kg/m³) between
//   the outer diameter and the strand bundle, marked estimated.
// - Ampacity is a published table's, never the seller's, with its basis: for 10 to 14 AWG the NEC
//   tables for 200 °C conductors (types FEP, PFA and SA, SA being silicone) at 40 °C ambient, free
//   air (310.15(B)(19)) and not more than three current-carrying conductors in a raceway or cable
//   (310.15(B)(18)), read from a wire maker's reproduction of NEC 2011; the NEC does not list the
//   smaller sizes in those tables, so 16 to 22 AWG carry PowerStream's chassis wiring figure (one
//   wire in air, not bundled, with no temperature or ambient stated) and no bundled figure.
//
// A wire run at a 200 °C ampacity is at about 200 °C, which no connector, solder joint or nearby
// printed part in a hobby build tolerates; the electrical check (T9.5f) compares against the
// lowest-rated part at each end, as the NEC's termination rule does. Nothing here says a wire suits
// a circuit.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

/** Annealed copper at 20 °C (IACS 100 %), in Ω*m. */
const COPPER_RESISTIVITY = 1.7241e-8;
/** Cross-section of `strands` round strands of `d` millimetres, in mm². */
const strandedArea = (strands: number, d: number) => (strands * Math.PI * d * d) / 4;
/** Ω/m of copper of `area` mm² at 20 °C. */
const copperResistance = (area: number) => COPPER_RESISTIVITY / (area * 1e-6);
/**
 * kg/m of a stranded copper wire of `area` mm² with silicone insulation to `outer` mm: copper with
 * 2 % for the lay, and silicone between the outer diameter and the strand bundle (packed to 78 %).
 */
const massPerLength = (area: number, outer: number) => {
  const bundle = Math.sqrt((4 * area) / (Math.PI * 0.78));
  const insulation = (Math.PI / 4) * (outer * outer - bundle * bundle);
  return (area * 8890 * 1.02 + insulation * 1200) * 1e-6;
};
/** Four significant figures, so stored numbers read cleanly. */
const sig = (v: number) => Number(v.toPrecision(4));

const SELLER = 'BNTECHGO';
const STRAND = 0.08;

const NEC = {
  title:
    'Houston Wire & Cable, 2012 catalogue technical reference, NEC article 310 tables 310.15(B)(3)(a), (B)(17), (B)(18) and (B)(19) (a reproduction of NEC 2011)',
  url: 'https://www.houwire.com/pdf/Article_310-Conductors_for_General_Wiring.pdf',
  revision: '2012',
  read: READ,
};
const POWERSTREAM = {
  title:
    'PowerStream, wire gauge and current limits including skin depth and strength (chassis wiring column: wire in air, not in a bundle)',
  url: 'https://www.powerstream.com/Wire_Size.htm',
  read: READ,
};
const AWG = {
  title: 'Wikipedia, American wire gauge (nominal areas and solid copper resistance at 20 °C)',
  url: 'https://en.wikipedia.org/wiki/American_wire_gauge',
  read: READ,
};

const SILICONE_NOTE =
  'Seller figures: tinned copper strands of 0.08 mm, silicone rubber insulation, 600 V, -60 to 200 °C. The conductor area is the stated stranding, the resistance copper over that area (estimated), the mass copper plus silicone (estimated); the seller states neither.';
const NEC_NOTE =
  'Ampacities are the NEC 200 °C column (types FEP, PFA, SA) at 40 °C ambient: free air from table 310.15(B)(19), not more than three current-carrying conductors in a raceway or cable from table 310.15(B)(18). For 4 to 6 conductors the NEC adjustment table 310.15(B)(3)(a) applies 80 % to the raceway figure, 70 % for 7 to 9 and 50 % for 10 to 20. Hobby silicone wire is not a listed type SA conductor, and its ends rarely tolerate 200 °C: the check uses the lowest-rated termination.';
const CHASSIS_NOTE =
  "Ampacity is PowerStream's chassis wiring figure, one wire in air and not in a bundle, which the page calls conservative and states no temperature or ambient for; the NEC's 200 °C tables do not list this size. No bundled figure is given: the check derates the free-air one.";

interface Size {
  awg: number;
  strands: number;
  /** Outer diameter in mm, when the seller states it. */
  outer?: number;
  /** Published free-air ampacity, A. */
  free: number;
  /** NEC raceway figure for at most three conductors, A, for 10 to 14 AWG. */
  bundled?: number;
  url: string;
  /** Nominal AWG area and solid copper resistance (Wikipedia), for the notes. */
  nominal: [area: number, mohmPerM: number];
}

const SIZES: readonly Size[] = [
  {
    awg: 10,
    strands: 1050,
    outer: 5.5,
    free: 90,
    bundled: 60,
    url: 'https://bntechgo.com/bntechgo-10-gauge-silicone-wire-spool-red-20-feet-ultra-flexible-high-temp-200-c-600v-10-awg-silicone-rubber-wire-with-1050-strands-of-tinned-copper-wire-stranded-wire-for-model-battery/',
    nominal: [5.26, 3.277],
  },
  {
    awg: 12,
    strands: 680,
    outer: 4.5,
    free: 68,
    bundled: 45,
    url: 'https://bntechgo.com/bntechgo-12-gauge-silicone-wire-spool-yellow-100-feet-ultra-flexible-high-temp-200-c-600v-12-awg-silicone-rubber-wire-with-680-strands-of-tinned-copper-wire-stranded-wire-for-model-battery/',
    nominal: [3.31, 5.211],
  },
  {
    awg: 14,
    strands: 400,
    outer: 3.5,
    free: 54,
    bundled: 36,
    url: 'https://bntechgo.com/bntechgo-14-gauge-silicone-wire-kit-ultra-flexible-20-ft-black-and-red-each-color-10-ft-high-temp-200-c-600v-14-awg-silicone-wire-400-strands-of-tinned-copper-wire-stranded-wire-stranded-wire-for-model-battery/',
    nominal: [2.08, 8.286],
  },
  {
    awg: 16,
    strands: 252,
    free: 22,
    url: 'https://bntechgo.com/bntechgo-16-gauge-silicone-wire-spool-red-25-feet-ultra-flexible-high-temp-200-c-600v-16-awg-silicone-rubber-wire-with-252-strands-of-tinned-copper-wire-stranded-wire-for-model-battery/',
    nominal: [1.31, 13.17],
  },
  {
    awg: 18,
    strands: 150,
    outer: 2.3,
    free: 16,
    url: 'https://bntechgo.com/bntechgo-18-gauge-silicone-wire-kit-ultra-flexible-100-ft-black-and-red-each-color-50-ft-high-temp-200-c-600v-18-awg-silicone-wire-150-strands-of-tinned-copper-wire-stranded-wire-stranded-wire-for-model-battery/',
    nominal: [0.823, 20.95],
  },
  {
    awg: 22,
    strands: 60,
    outer: 1.7,
    free: 7,
    url: 'https://bntechgo.com/bntechgo-22-gauge-silicone-wire-kit-ultra-flexible-20-feet-red-and-black-each-color-10-ft-high-temp-200-c-600v-22-awg-silicone-wire-with-60-strands-of-tinned-copper-wire-stranded-wire-for-model-battery/',
    nominal: [0.326, 52.96],
  },
];

function silicone(size: Size): BuiltinEntry {
  const area = strandedArea(size.strands, STRAND);
  const nec = size.bundled !== undefined;
  const [nominalArea, nominalR] = size.nominal;
  return {
    id: `wire/bntechgo-silicone-${size.awg}awg`,
    version: 1,
    family: 'wire',
    fieldsVersion: 2,
    maker: SELLER,
    partNumber: `${size.awg} AWG silicone wire, ${size.strands} strands`,
    description: `Fine-stranded tinned copper wire, silicone insulated, ${size.awg} AWG, 200 °C, 600 V`,
    ratings: {
      gauge: { text: `${size.awg} AWG` },
      conductor: { text: 'tinned copper' },
      strands: { value: size.strands },
      strandDiameter: { value: STRAND },
      conductorArea: { value: sig(area) },
      resistancePerLength: { value: sig(copperResistance(area)), estimated: true },
      insulation: { text: 'silicone' },
      voltageRating: { value: 600 },
      temperatureRating: { value: degC(200) },
      minTemperature: { value: degC(-60) },
      ampacity: nec
        ? {
            value: size.free,
            basis: 'NEC table 310.15(B)(19), 200 °C conductor, single in free air, 40 °C ambient',
          }
        : {
            value: size.free,
            basis: 'PowerStream chassis wiring: one wire in air, not bundled; ambient not stated',
          },
      ampacityBundled: nec
        ? {
            value: size.bundled!,
            basis:
              'NEC table 310.15(B)(18), 200 °C conductor, at most 3 current-carrying conductors in a raceway or cable, 40 °C ambient',
          }
        : { unknown: true },
      ...(nec
        ? { bundledConductors: { value: 3 }, ampacityAmbient: { value: degC(40) } }
        : { ampacityAmbient: { unknown: true } }),
      massPerLength:
        size.outer !== undefined
          ? { value: sig(massPerLength(area, size.outer)), estimated: true }
          : { unknown: true },
    },
    ...(size.outer !== undefined ? { dimensions: { diameter: { value: size.outer } } } : {}),
    geometry: { kind: 'placeholder', shape: { kind: 'cylinder' } },
    sources: [
      {
        title: `${SELLER}, ${size.awg} AWG silicone wire listing (seller; stranding, outer diameter, voltage and temperature)`,
        url: size.url,
        read: READ,
      },
      nec ? NEC : POWERSTREAM,
      AWG,
    ],
    verified: false,
    notes: `${SILICONE_NOTE} The nominal ${size.awg} AWG area is ${nominalArea} mm² and solid copper ${nominalR} mΩ/m (Wikipedia); this stranding gives ${sig(area)} mm².${size.outer === undefined ? ' The seller states no outer diameter for this size, so the mass is unknown.' : ''} ${nec ? NEC_NOTE : CHASSIS_NOTE}`,
  };
}

/** The built-in wires, every version. */
export const WIRE_ENTRIES: readonly BuiltinEntry[] = SIZES.map(silicone);
