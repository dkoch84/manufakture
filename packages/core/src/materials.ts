/**
 * The built-in materials: what a body is made of, for its mass. A part stores the id of one of
 * these (`Part.material`); nothing else about a material is stored, so the table can gain
 * materials without a file format change, but an id must never be removed or change meaning.
 *
 * Densities are TYPICAL values, not specifications. Real stock varies: wood with species, growth
 * and moisture (the wood values are at about 12% moisture content), panels by maker and
 * thickness, filament by brand and additives. A printed part is lighter again than its solid
 * volume says, by its infill and walls. Each entry cites where its value comes from.
 */

export type MaterialCategory = 'plastic' | 'wood' | 'metal';

export interface Material {
  readonly id: string;
  /** Display name. */
  readonly name: string;
  readonly category: MaterialCategory;
  /** Typical density in kg/m3. */
  readonly density: number;
  /** The range stock is usually found in, kg/m3, when it varies notably. */
  readonly range?: readonly [number, number];
  /** Where the value comes from. */
  readonly source: string;
}

/** Every built-in material, in display order. Ids are permanent (they are stored in documents). */
export const MATERIALS = [
  {
    id: 'pla',
    name: 'PLA',
    category: 'plastic',
    density: 1240,
    source: 'NatureWorks Ingeo 4043D technical data sheet: specific gravity 1.24',
  },
  {
    id: 'petg',
    name: 'PETG',
    category: 'plastic',
    density: 1270,
    source: 'Eastman Eastar copolyester 6763 data sheet: density 1.27 g/cm3',
  },
  {
    id: 'abs',
    name: 'ABS',
    category: 'plastic',
    density: 1040,
    range: [1030, 1070],
    source: 'INEOS Styrolution Terluran GP-22 data sheet: density 1040 kg/m3',
  },
  {
    id: 'pine',
    name: 'Pine (eastern white)',
    category: 'wood',
    density: 400,
    range: [350, 450],
    source:
      'The Wood Database, Eastern White Pine: average dried weight 400 kg/m3 (25 lb/ft3) at 12% MC',
  },
  {
    id: 'oak',
    name: 'Oak (red)',
    category: 'wood',
    density: 700,
    range: [630, 770],
    source: 'The Wood Database, Red Oak: average dried weight 700 kg/m3 (44 lb/ft3) at 12% MC',
  },
  {
    id: 'plywood',
    name: 'Plywood (birch)',
    category: 'wood',
    density: 680,
    range: [450, 760],
    source:
      'Birch plywood maker data, about 650 to 700 kg/m3; softwood plywood is lighter, 450 to 550 kg/m3',
  },
  {
    id: 'mdf',
    name: 'MDF',
    category: 'wood',
    density: 750,
    range: [600, 800],
    source: 'European Panel Federation, medium density fibreboard: 600 to 800 kg/m3',
  },
  {
    id: 'aluminium-6061',
    name: 'Aluminium 6061',
    category: 'metal',
    density: 2700,
    source: 'ASM Aerospace Specification Metals, aluminum 6061-T6 data sheet: 2.70 g/cm3',
  },
  {
    id: 'steel',
    name: 'Steel (carbon)',
    category: 'metal',
    density: 7850,
    source: 'EN 1993-1-1 (Eurocode 3), 3.2.6: unit mass of structural steel 7850 kg/m3',
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
