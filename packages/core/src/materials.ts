/**
 * The built-in materials: what a body is made of, for its mass and, from M9, for the mechanical
 * checks (ADR 0017 decision 4). A part stores the id of one of these (`Part.material`); nothing
 * else about a material is stored, so the table can gain materials without a file format change,
 * but an id must never be removed or change meaning, and a density must not change (mass results
 * would).
 *
 * Every value is TYPICAL unless its `typical` flag says otherwise, never a specification minimum.
 * Real stock varies: wood with species, growth and moisture (the wood values are at about 12%
 * moisture content), panels by maker and thickness, filament by brand and additives, metal with
 * temper and size. A printed part is lighter again than its solid volume says, by its infill and
 * walls, and its strength depends on the direction it is loaded in. Each value cites where it
 * comes from; a property that no source here gives is left out, so a check that needs it reports
 * `unknown` instead of using a guess.
 *
 * Values are in coherent SI: Pa, W/(m·K), J/(kg·K), 1/K, K; ratios as fractions.
 */

import type { StoredExpression } from '@manufakture/sketch/model';

export type MaterialCategory = 'plastic' | 'wood' | 'metal';

/** How the material was made into stock, which decides how a check treats it. */
export type MaterialForm = 'wrought' | 'cast' | 'printed' | 'moulded' | 'wood' | 'panel';

/** One property value with where it comes from. */
export interface Property {
  /** In SI. */
  readonly value: number;
  /** The data sheet, handbook or standard, and the table or row in it. */
  readonly source: string;
  /** True: a typical published value. False: a specification minimum (a nominal value). */
  readonly typical: boolean;
  /** Condition, temper, direction, temperature range or test standard. */
  readonly note?: string;
}

/** One point of an S-N curve: the stress amplitude (Pa) a specimen survives for `cycles`. */
export interface FatiguePoint {
  readonly cycles: number;
  readonly stress: number;
}

/** An S-N curve, with its source like any other property. */
export interface FatigueCurve {
  readonly points: readonly FatiguePoint[];
  readonly source: string;
  readonly typical: boolean;
  /** Stress ratio, specimen and test, at least. */
  readonly note?: string;
}

/**
 * The mechanical and thermal property set of ADR 0017 decision 4. Every property but `density`
 * and `form` is optional: absent means no source here gives it.
 */
export interface MaterialProperties {
  /** kg/m3, as before M9. */
  readonly density: number;
  /** Pa; for a printed material, in the XY plane (the note says). */
  readonly elasticModulus?: Property;
  readonly poissonRatio?: Property;
  /** Pa, 0.2% offset unless the note says otherwise; printed: XY. */
  readonly yieldStrength?: Property;
  /** Pa; printed: XY. */
  readonly ultimateStrength?: Property;
  /** Pa, printed only: across the layers (Z), where published. */
  readonly yieldStrengthZ?: Property;
  /** Pa, printed only: across the layers (Z), where published. */
  readonly ultimateStrengthZ?: Property;
  /** Pa, fully reversed; the cycles are stated in the note. */
  readonly enduranceLimit?: Property;
  /** S-N points, where published. */
  readonly fatigue?: FatigueCurve;
  /** Fraction at break. */
  readonly elongation?: Property;
  /** W/(m·K). */
  readonly thermalConductivity?: Property;
  /** J/(kg·K). */
  readonly specificHeat?: Property;
  /** 1/K, linear. */
  readonly thermalExpansion?: Property;
  /** K. */
  readonly maxServiceTemperature?: Property;
  readonly form: MaterialForm;
}

/** The keys of `MaterialProperties` that hold a `Property`. */
export type MaterialPropertyKey =
  | 'elasticModulus'
  | 'poissonRatio'
  | 'yieldStrength'
  | 'ultimateStrength'
  | 'yieldStrengthZ'
  | 'ultimateStrengthZ'
  | 'enduranceLimit'
  | 'elongation'
  | 'thermalConductivity'
  | 'specificHeat'
  | 'thermalExpansion'
  | 'maxServiceTemperature';

export interface MaterialPropertyInfo {
  readonly key: MaterialPropertyKey;
  /** Display name. */
  readonly name: string;
  /** The SI unit the value is in, written in `packages/units` syntax; '' for a ratio. */
  readonly unit: string;
}

/** Every `Property` of the set, in display order, with the SI unit its value is in. */
export const MATERIAL_PROPERTIES: readonly MaterialPropertyInfo[] = [
  { key: 'elasticModulus', name: 'Elastic modulus', unit: 'Pa' },
  { key: 'poissonRatio', name: "Poisson's ratio", unit: '' },
  { key: 'yieldStrength', name: 'Yield strength', unit: 'Pa' },
  { key: 'ultimateStrength', name: 'Ultimate strength', unit: 'Pa' },
  { key: 'yieldStrengthZ', name: 'Yield strength across layers (Z)', unit: 'Pa' },
  { key: 'ultimateStrengthZ', name: 'Ultimate strength across layers (Z)', unit: 'Pa' },
  { key: 'enduranceLimit', name: 'Endurance limit', unit: 'Pa' },
  { key: 'elongation', name: 'Elongation at break', unit: '' },
  { key: 'thermalConductivity', name: 'Thermal conductivity', unit: 'W/(m*K)' },
  { key: 'specificHeat', name: 'Specific heat', unit: 'J/(kg*K)' },
  { key: 'thermalExpansion', name: 'Thermal expansion', unit: '1/K' },
  { key: 'maxServiceTemperature', name: 'Maximum service temperature', unit: 'K' },
];

export interface Material extends MaterialProperties {
  readonly id: string;
  /** Display name. */
  readonly name: string;
  readonly category: MaterialCategory;
  /** The range stock is usually found in, kg/m3, when it varies notably. */
  readonly range?: readonly [number, number];
  /** Where the density comes from. */
  readonly source: string;
}

/**
 * The starting value for the printed-part knockdown (`domains.mech.printedKnockdown`, ADR 0017
 * decision 4): the factor an XY strength is multiplied by when a printed material publishes no Z
 * strength. 0.5 is about the lowest Z/XY tensile ratio among the built-in printed materials (0.47
 * for PA6-CF; the others run 0.69 to 0.90) and inside the range Ahn et al. measured for printed
 * ABS. It is the user's to change; it does not model layer adhesion, infill or orientation, it
 * only stands in for them.
 */
export const PRINTED_KNOCKDOWN_START: Property = {
  value: 0.5,
  typical: true,
  source:
    'Bambu Lab technical data sheets (PLA Basic V3.0, PETG Basic V3.0, ABS V3.0, PC V2.0, PA6-CF V3.0): Z/XY tensile strength 0.47 to 0.90; Ahn, Montero, Odell, Roundy and Wright, "Anisotropic material properties of fused deposition modeling ABS", Rapid Prototyping Journal 8(4), 2002, pp. 248-257: printed ABS failed at 10% to 73% of moulded strength by raster orientation',
  note: 'a starting value, not a measured property of any one print',
};

// ---------------------------------------------------------------------------------------------
// Sources, shared by the entries below.

const MPA = 1e6;
const GPA = 1e9;
/** Kelvin from degrees Celsius. */
const K = (c: number) => c + 273.15;

const p = (value: number, source: string, note?: string, typical = true): Property =>
  note === undefined ? { value, source, typical } : { value, source, typical, note };

const BAMBU = (sheet: string) =>
  `Bambu Lab ${sheet} technical data sheet (ISO 527 for tensile values, ISO 75 for heat deflection)`;
const PRINTED_XY = 'printed, XY, 100% infill, as the data sheet tests it';
const PRINTED_Z = 'printed, Z (across the layers), 100% infill';
/** Heat deflection temperature, as a ceiling for use under load. */
const HDT =
  'heat deflection temperature at 1.8 MPa (ISO 75): a short-term softening point under load, not a rated continuous temperature';

const ASM_6061 = 'ASM Aerospace Specification Metals, aluminum 6061-T6 data sheet (asm.matweb.com)';
const ASM_7075 = 'ASM Aerospace Specification Metals, aluminum 7075-T6 data sheet (asm.matweb.com)';
const MATWEB_1018 = 'MatWeb, "AISI 1018 Steel, cold drawn" data sheet';
const AZOM_4140 = 'AZoM, "AISI 4140 Alloy Steel (UNS G41400)", article 6769, annealed (197 HB)';
const AZOM_304 = 'AZoM, "Stainless Steel: Grade 304 (UNS S30400)", article 2867';
const CDA_C36000 = 'Copper Development Association, C36000 free-cutting brass data sheet';
const EC3 = 'EN 1993-1-1 (Eurocode 3)';
const EC3_FIRE = 'EN 1993-1-2 (Eurocode 3, fire design)';
const SHIGLEY =
  "Budynas and Nisbett, Shigley's Mechanical Engineering Design, eq. 6-8: S'e = 0.5 Sut for steels with Sut up to 1400 MPa";
const SHIGLEY_NOTE =
  'estimate from the ultimate strength: a polished rotating-beam specimen, about 1e6 cycles and beyond, before any Marin factor';
const WOOD_DB = (wood: string) => `The Wood Database, ${wood}`;
const ENSINGER_POM =
  'Ensinger TECAFORM AH natural (POM-C) stock shapes data sheet, version AA, 2017';
const EOS_PA2200 = 'EOS material data sheet PA 2200 Balance (ISO 527-1/-2, ISO 75-1/-2)';

/** Every built-in material, in display order. Ids are permanent (they are stored in documents). */
export const MATERIALS = [
  {
    id: 'pla',
    name: 'PLA',
    category: 'plastic',
    form: 'printed',
    density: 1240,
    source: 'NatureWorks Ingeo 4043D technical data sheet: specific gravity 1.24',
    elasticModulus: p(2.58 * GPA, BAMBU('PLA Basic V3.0'), `${PRINTED_XY}; Z: 2.06 GPa`),
    ultimateStrength: p(35 * MPA, BAMBU('PLA Basic V3.0'), PRINTED_XY),
    ultimateStrengthZ: p(31 * MPA, BAMBU('PLA Basic V3.0'), PRINTED_Z),
    elongation: p(0.122, BAMBU('PLA Basic V3.0'), `${PRINTED_XY}; Z: 0.075`),
    maxServiceTemperature: p(K(54), BAMBU('PLA Basic V3.0'), HDT),
  },
  {
    id: 'petg',
    name: 'PETG',
    category: 'plastic',
    form: 'printed',
    density: 1270,
    source: 'Eastman Eastar copolyester 6763 data sheet: density 1.27 g/cm3',
    elasticModulus: p(2.78 * GPA, BAMBU('PETG Basic V3.0'), `${PRINTED_XY}; Z: 2.55 GPa`),
    ultimateStrength: p(51 * MPA, BAMBU('PETG Basic V3.0'), PRINTED_XY),
    ultimateStrengthZ: p(35 * MPA, BAMBU('PETG Basic V3.0'), PRINTED_Z),
    elongation: p(0.095, BAMBU('PETG Basic V3.0'), `${PRINTED_XY}; Z: 0.052`),
    maxServiceTemperature: p(K(68), BAMBU('PETG Basic V3.0'), HDT),
  },
  {
    id: 'abs',
    name: 'ABS',
    category: 'plastic',
    form: 'printed',
    density: 1040,
    range: [1030, 1070],
    source: 'INEOS Styrolution Terluran GP-22 data sheet: density 1040 kg/m3',
    elasticModulus: p(2.2 * GPA, BAMBU('ABS V3.0'), `${PRINTED_XY}; Z: 1.96 GPa`),
    ultimateStrength: p(33 * MPA, BAMBU('ABS V3.0'), PRINTED_XY),
    ultimateStrengthZ: p(28 * MPA, BAMBU('ABS V3.0'), PRINTED_Z),
    elongation: p(0.105, BAMBU('ABS V3.0'), `${PRINTED_XY}; Z: 0.047`),
    maxServiceTemperature: p(K(84), BAMBU('ABS V3.0'), HDT),
  },
  {
    id: 'pc',
    name: 'PC (polycarbonate)',
    category: 'plastic',
    form: 'printed',
    density: 1200,
    source: 'Bambu Lab PC technical data sheet V2.0: density 1.20 g/cm3 (ISO 1183)',
    elasticModulus: p(2.11 * GPA, BAMBU('PC V2.0'), `${PRINTED_XY}, dry; Z: 1.45 GPa`),
    ultimateStrength: p(62 * MPA, BAMBU('PC V2.0'), `${PRINTED_XY}, dry`),
    ultimateStrengthZ: p(56 * MPA, BAMBU('PC V2.0'), `${PRINTED_Z}, dry`),
    elongation: p(0.038, BAMBU('PC V2.0'), `${PRINTED_XY}, dry; Z: 0.021`),
    maxServiceTemperature: p(
      K(117),
      BAMBU('PC V2.0'),
      `${HDT}. The sheet gives 112 C at 0.45 MPa, below its 1.8 MPa value, which is unusual (a lighter load normally deflects at a higher temperature): treat both with care`,
    ),
  },
  {
    id: 'pa12',
    name: 'PA12 (SLS)',
    category: 'plastic',
    form: 'printed',
    density: 930,
    source: 'EOS material data sheet PA 2200 Balance: density of laser-sintered part 0.93 g/cm3',
    elasticModulus: p(1.65 * GPA, EOS_PA2200, 'laser sintered; the same in X, Y and Z'),
    ultimateStrength: p(48 * MPA, EOS_PA2200, 'laser sintered, X and Y'),
    ultimateStrengthZ: p(42 * MPA, EOS_PA2200, 'laser sintered, Z (across the layers)'),
    elongation: p(0.18, EOS_PA2200, 'laser sintered, X and Y; Z: 0.04'),
    maxServiceTemperature: p(
      K(57),
      EOS_PA2200,
      'heat deflection temperature at 1.80 MPa, Z (X: 64 C): a short-term softening point under load, not a rated continuous temperature',
    ),
  },
  {
    id: 'pa-cf',
    name: 'PA-CF (carbon-filled nylon)',
    category: 'plastic',
    form: 'printed',
    density: 1090,
    source: 'Bambu Lab PA6-CF technical data sheet V3.0: density 1.09 g/cm3 (ISO 1183)',
    elasticModulus: p(4.43 * GPA, BAMBU('PA6-CF V3.0'), `${PRINTED_XY}; Z: 2.17 GPa`),
    ultimateStrength: p(102 * MPA, BAMBU('PA6-CF V3.0'), PRINTED_XY),
    ultimateStrengthZ: p(48 * MPA, BAMBU('PA6-CF V3.0'), PRINTED_Z),
    elongation: p(0.058, BAMBU('PA6-CF V3.0'), `${PRINTED_XY}; Z: 0.037`),
    maxServiceTemperature: p(K(164), BAMBU('PA6-CF V3.0'), HDT),
  },
  {
    id: 'pom',
    name: 'POM (acetal)',
    category: 'plastic',
    form: 'moulded',
    density: 1410,
    source: 'Ensinger TECAFORM AH natural (POM-C) data sheet: density 1.41 g/cm3',
    elasticModulus: p(3.1 * GPA, ENSINGER_POM, 'extruded stock, tensile test, ASTM D 638'),
    ultimateStrength: p(64 * MPA, ENSINGER_POM, 'extruded stock, tensile strength, ASTM D 638'),
    elongation: p(0.3, ENSINGER_POM, 'extruded stock, ASTM D 638'),
    thermalConductivity: p(0.39, ENSINGER_POM, 'ISO 22007-4'),
    specificHeat: p(1400, ENSINGER_POM, 'ISO 22007-4'),
    thermalExpansion: p(1.36e-4, ENSINGER_POM, '23 to 100 C, longitudinal'),
    maxServiceTemperature: p(K(100), ENSINGER_POM, 'service temperature, long term'),
  },
  {
    id: 'pine',
    name: 'Pine (eastern white)',
    category: 'wood',
    form: 'wood',
    density: 400,
    range: [350, 450],
    source:
      'The Wood Database, Eastern White Pine: average dried weight 400 kg/m3 (25 lb/ft3) at 12% MC',
    elasticModulus: p(
      8.55 * GPA,
      WOOD_DB('Eastern White Pine'),
      'along the grain, from bending tests, 12% moisture content',
    ),
  },
  {
    id: 'oak',
    name: 'Oak (red)',
    category: 'wood',
    form: 'wood',
    density: 700,
    range: [630, 770],
    source: 'The Wood Database, Red Oak: average dried weight 700 kg/m3 (44 lb/ft3) at 12% MC',
    elasticModulus: p(
      12.14 * GPA,
      WOOD_DB('Red Oak'),
      'along the grain, from bending tests, 12% moisture content',
    ),
  },
  {
    id: 'plywood',
    name: 'Plywood (birch)',
    category: 'wood',
    form: 'panel',
    density: 680,
    range: [450, 760],
    source:
      'Birch plywood maker data, about 650 to 700 kg/m3; softwood plywood is lighter, 450 to 550 kg/m3',
  },
  {
    id: 'mdf',
    name: 'MDF',
    category: 'wood',
    form: 'panel',
    density: 750,
    range: [600, 800],
    source: 'European Panel Federation, medium density fibreboard: 600 to 800 kg/m3',
  },
  {
    id: 'aluminium-6061',
    name: 'Aluminium 6061',
    category: 'metal',
    form: 'wrought',
    density: 2700,
    source: 'ASM Aerospace Specification Metals, aluminum 6061-T6 data sheet: 2.70 g/cm3',
    elasticModulus: p(68.9 * GPA, ASM_6061, 'in tension'),
    poissonRatio: p(0.33, ASM_6061),
    yieldStrength: p(276 * MPA, ASM_6061, 'T6'),
    ultimateStrength: p(310 * MPA, ASM_6061, 'T6'),
    enduranceLimit: p(
      96.5 * MPA,
      ASM_6061,
      'fatigue strength at 5e8 cycles, completely reversed, R.R. Moore test; aluminium has no true endurance limit',
    ),
    elongation: p(0.12, ASM_6061, 'T6, 1.6 mm thick specimen'),
    thermalConductivity: p(167, ASM_6061, 'at 25 C'),
    specificHeat: p(896, ASM_6061),
    thermalExpansion: p(23.6e-6, ASM_6061, '20 to 100 C'),
  },
  {
    id: 'aluminium-7075',
    name: 'Aluminium 7075',
    category: 'metal',
    form: 'wrought',
    density: 2810,
    source: 'ASM Aerospace Specification Metals, aluminum 7075-T6 data sheet: 2.81 g/cm3',
    elasticModulus: p(71.7 * GPA, ASM_7075, 'in tension'),
    poissonRatio: p(0.33, ASM_7075),
    yieldStrength: p(503 * MPA, ASM_7075, 'T6'),
    ultimateStrength: p(572 * MPA, ASM_7075, 'T6'),
    enduranceLimit: p(
      159 * MPA,
      ASM_7075,
      'fatigue strength at 5e8 cycles, completely reversed, R.R. Moore test; aluminium has no true endurance limit',
    ),
    elongation: p(0.11, ASM_7075, 'T6, 1.6 mm thick specimen'),
    thermalConductivity: p(130, ASM_7075),
    specificHeat: p(960, ASM_7075),
    thermalExpansion: p(23.4e-6, ASM_7075, '20 to 100 C'),
  },
  {
    id: 'steel',
    name: 'Steel (carbon)',
    category: 'metal',
    form: 'wrought',
    density: 7850,
    source: 'EN 1993-1-1 (Eurocode 3), 3.2.6: unit mass of structural steel 7850 kg/m3',
    elasticModulus: p(210 * GPA, `${EC3}, 3.2.6`, 'structural steel, design value'),
    poissonRatio: p(0.3, `${EC3}, 3.2.6`, 'structural steel, design value'),
    yieldStrength: p(
      235 * MPA,
      `${EC3}, table 3.1`,
      'nominal value for S235 (EN 10025-2), up to 40 mm thick: a specification minimum; stronger grades are user materials',
      false,
    ),
    ultimateStrength: p(
      360 * MPA,
      `${EC3}, table 3.1`,
      'nominal value for S235 (EN 10025-2), up to 40 mm thick',
      false,
    ),
    elongation: p(
      0.15,
      `${EC3}, 3.2.2`,
      'the minimum elongation at failure the code requires of structural steel',
      false,
    ),
    thermalConductivity: p(45, `${EC3_FIRE}, 3.4.1.3`, 'the simplified constant value'),
    specificHeat: p(600, `${EC3_FIRE}, 3.4.1.2`, 'the simplified constant value'),
    thermalExpansion: p(12e-6, `${EC3}, 3.2.6`, 'for temperatures up to 100 C'),
  },
  {
    id: 'steel-1018',
    name: 'Steel 1018 (cold drawn)',
    category: 'metal',
    form: 'wrought',
    density: 7870,
    source: 'MatWeb, "AISI 1018 Steel, cold drawn" data sheet: 7.87 g/cm3',
    elasticModulus: p(200 * GPA, MATWEB_1018),
    poissonRatio: p(0.29, MATWEB_1018, 'the data sheet says: typical for steel'),
    yieldStrength: p(370 * MPA, MATWEB_1018, 'cold drawn'),
    ultimateStrength: p(440 * MPA, MATWEB_1018, 'cold drawn'),
    enduranceLimit: p(220 * MPA, SHIGLEY, SHIGLEY_NOTE),
    elongation: p(0.15, MATWEB_1018, 'in 50 mm'),
    thermalConductivity: p(
      51.9,
      MATWEB_1018,
      'the data sheet says: estimated based on similar materials',
    ),
    specificHeat: p(486, MATWEB_1018, 'annealed, at 100 C and above'),
  },
  {
    id: 'steel-4140',
    name: 'Steel 4140 (annealed)',
    category: 'metal',
    form: 'wrought',
    density: 7850,
    source: 'AZoM, "AISI 4140 Alloy Steel (UNS G41400)": 7.85 g/cm3',
    elasticModulus: p(200 * GPA, AZOM_4140, 'the article gives 190 to 210 GPa'),
    poissonRatio: p(0.29, AZOM_4140, 'the article gives 0.27 to 0.30'),
    yieldStrength: p(
      415 * MPA,
      AZOM_4140,
      'annealed; quenched and tempered stock is much stronger',
    ),
    ultimateStrength: p(655 * MPA, AZOM_4140, 'annealed'),
    enduranceLimit: p(327.5 * MPA, SHIGLEY, SHIGLEY_NOTE),
    elongation: p(0.257, AZOM_4140, 'in 50 mm'),
    thermalConductivity: p(42.6, AZOM_4140, 'at 100 C'),
    thermalExpansion: p(12.2e-6, AZOM_4140, '0 to 100 C'),
  },
  {
    id: 'steel-304',
    name: 'Stainless steel 304',
    category: 'metal',
    form: 'wrought',
    density: 8000,
    source: 'AZoM, "Stainless Steel: Grade 304 (UNS S30400)", physical properties: 8.00 g/cm3',
    elasticModulus: p(193 * GPA, AZOM_304, 'annealed'),
    yieldStrength: p(
      190 * MPA,
      AZOM_304,
      'bar and section, 0.2% proof stress: a specification minimum',
      false,
    ),
    ultimateStrength: p(
      500 * MPA,
      AZOM_304,
      'bar and section: the bottom of the specified 500 to 700 MPa',
      false,
    ),
    elongation: p(0.45, AZOM_304, 'bar and section, A50mm: a specification minimum', false),
    thermalConductivity: p(16.2, AZOM_304, 'at 100 C'),
    thermalExpansion: p(17.2e-6, AZOM_304, '0 to 100 C'),
  },
  {
    id: 'brass',
    name: 'Brass (C36000)',
    category: 'metal',
    form: 'wrought',
    density: 8500,
    source: 'Copper Development Association, C36000 data sheet: 0.307 lb/in3 (8.50 g/cm3)',
    elasticModulus: p(97 * GPA, CDA_C36000, '14,000 ksi, in tension'),
    yieldStrength: p(
      310 * MPA,
      CDA_C36000,
      'H02 (half hard) rod up to 25 mm, 45 ksi at 0.5% extension under load',
    ),
    ultimateStrength: p(400 * MPA, CDA_C36000, 'H02 (half hard) rod up to 25 mm, 58 ksi'),
    elongation: p(0.25, CDA_C36000, 'H02 (half hard) rod up to 25 mm'),
    thermalConductivity: p(115, CDA_C36000, '67 Btu/(ft h F) at 20 C'),
    specificHeat: p(380, CDA_C36000, '0.09 Btu/(lb F) at 20 C'),
    thermalExpansion: p(20.5e-6, CDA_C36000, '11.4e-6 per F, 20 to 300 C'),
  },
] as const satisfies readonly Material[];

export type MaterialId = (typeof MATERIALS)[number]['id'];

/** Every material id, in display order: the values `Part.material` accepts. */
export const MATERIAL_IDS = MATERIALS.map((m) => m.id) as unknown as readonly [
  MaterialId,
  ...MaterialId[],
];

/** The material with this id, or undefined for an unknown one. */
export function findMaterial(id: string): Material | undefined {
  return (MATERIALS as readonly Material[]).find((m) => m.id === id);
}

/** Mass in grams of `volume` mm3 of material with `density` kg/m3. */
export function massGrams(volume: number, density: number): number {
  // 1 mm3 = 1e-9 m3 and 1 kg = 1000 g, so g = mm3 * kg/m3 * 1e-6.
  return volume * density * 1e-6;
}

// ---------------------------------------------------------------------------------------------
// User materials (ADR 0017 decision 4). The shape only: the document schema, its validation and
// the `setMaterialDef` / `deleteMaterialDef` / `restoreMaterialDef` commands arrive with the
// format bump (T9.1e), which stores these in a top-level `materials` array.

/** The id pattern of a user material: `material#n`, from `nextIds.material`, never reused. */
export const USER_MATERIAL_ID_PATTERN = /^material#[1-9][0-9]*$/;

/**
 * A user material's property: a constant expression typed through `packages/units` (a variable
 * is refused), with its source and typical marking, as a built-in `Property`.
 */
export interface MaterialDefProperty {
  /** The value as typed (`70 GPa`); constant, in the property's kind. */
  readonly value: StoredExpression;
  /** Where the value comes from. */
  readonly source: string;
  readonly typical: boolean;
  readonly note?: string;
}

/** A user material, as T9.1e stores it in the document's `materials` array. */
export interface MaterialDef {
  /** `material#n`. */
  readonly id: string;
  readonly name: string;
  readonly category: MaterialCategory;
  readonly form: MaterialForm;
  /** Required: every mass result needs it. */
  readonly density: MaterialDefProperty;
  readonly properties?: { readonly [K in MaterialPropertyKey]?: MaterialDefProperty };
  readonly fatigue?: {
    /** Stress amplitudes, each a constant pressure expression. */
    readonly points: readonly { readonly cycles: number; readonly stress: StoredExpression }[];
    readonly source: string;
    readonly typical: boolean;
    readonly note?: string;
  };
}
