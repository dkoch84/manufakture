import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MATERIALS,
  MATERIAL_PROPERTIES,
  PRINTED_KNOCKDOWN_START,
  USER_MATERIAL_ID_PATTERN,
  findMaterial,
  massGrams,
  type Material,
  type MaterialDef,
  type MaterialPropertyKey,
  type Property,
} from './materials';

const all = MATERIALS as readonly Material[];

/** Sane bounds for each property, in SI: anything outside is a unit slip (MPa for Pa, C for K). */
const BOUNDS: Record<MaterialPropertyKey, readonly [number, number]> = {
  elasticModulus: [0.5e9, 250e9],
  poissonRatio: [0.2, 0.5],
  yieldStrength: [5e6, 2e9],
  ultimateStrength: [5e6, 2.5e9],
  yieldStrengthZ: [1e6, 2e9],
  ultimateStrengthZ: [1e6, 2.5e9],
  enduranceLimit: [5e6, 1.5e9],
  elongation: [0.001, 1],
  thermalConductivity: [0.05, 500],
  specificHeat: [100, 3000],
  thermalExpansion: [1e-6, 3e-4],
  maxServiceTemperature: [300, 1500],
};

const KEYS = MATERIAL_PROPERTIES.map((p) => p.key);
const META = new Set(['id', 'name', 'category', 'form', 'density', 'range', 'source', 'fatigue']);

const properties = (m: Material): [MaterialPropertyKey, Property][] =>
  KEYS.flatMap((k) => (m[k] === undefined ? [] : [[k, m[k]] as [MaterialPropertyKey, Property]]));

describe('material properties', () => {
  it('lists every property key once, each with an SI unit', () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    expect([...KEYS].sort()).toEqual(Object.keys(BOUNDS).sort());
    for (const p of MATERIAL_PROPERTIES) expect(p.name.length, p.key).toBeGreaterThan(0);
  });

  it('holds only known fields, so a misspelt property cannot hide', () => {
    for (const m of all) {
      for (const key of Object.keys(m)) {
        expect(META.has(key) || (KEYS as string[]).includes(key), `${m.id}.${key}`).toBe(true);
      }
    }
  });

  it('gives every property of every material a value, a source and a typical marking', () => {
    for (const m of all) {
      for (const [key, p] of properties(m)) {
        const at = `${m.id}.${key}`;
        expect(Number.isFinite(p.value), at).toBe(true);
        expect(p.source.length, at).toBeGreaterThan(10);
        expect(typeof p.typical, at).toBe('boolean');
        if (p.note !== undefined) expect(p.note.length, at).toBeGreaterThan(0);
      }
      if (m.fatigue !== undefined) {
        expect(m.fatigue.source.length, m.id).toBeGreaterThan(10);
        expect(typeof m.fatigue.typical, m.id).toBe('boolean');
      }
    }
  });

  it('keeps every value in a sane range for its SI unit', () => {
    for (const m of all) {
      for (const [key, p] of properties(m)) {
        const [lo, hi] = BOUNDS[key];
        expect(p.value, `${m.id}.${key}`).toBeGreaterThanOrEqual(lo);
        expect(p.value, `${m.id}.${key}`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('is consistent: yield below ultimate, layers no stronger than the plane, fatigue below ultimate', () => {
    for (const m of all) {
      if (m.yieldStrength && m.ultimateStrength) {
        expect(m.yieldStrength.value, m.id).toBeLessThan(m.ultimateStrength.value);
      }
      if (m.ultimateStrengthZ) {
        expect(m.ultimateStrength, m.id).toBeDefined();
        expect(m.ultimateStrengthZ.value, m.id).toBeLessThanOrEqual(m.ultimateStrength!.value);
      }
      if (m.yieldStrengthZ) {
        expect(m.yieldStrengthZ.value, m.id).toBeLessThanOrEqual(m.yieldStrength!.value);
      }
      if (m.enduranceLimit) {
        expect(m.enduranceLimit.value, m.id).toBeLessThan(m.ultimateStrength!.value);
        expect(m.enduranceLimit.note, m.id).toMatch(/cycles/);
      }
      for (const [, curve] of m.fatigue ? [[m.id, m.fatigue] as const] : []) {
        for (let i = 1; i < curve.points.length; i++) {
          expect(curve.points[i]!.cycles).toBeGreaterThan(curve.points[i - 1]!.cycles);
          expect(curve.points[i]!.stress).toBeLessThanOrEqual(curve.points[i - 1]!.stress);
        }
      }
    }
  });

  it('gives each category a form that fits it', () => {
    const forms = {
      plastic: ['printed', 'moulded'],
      wood: ['wood', 'panel'],
      metal: ['wrought', 'cast'],
    };
    for (const m of all) expect(forms[m.category], m.id).toContain(m.form);
  });

  it('states printed strengths in XY and across the layers, and only for printed materials', () => {
    const printed = all.filter((m) => m.form === 'printed');
    expect(printed.map((m) => m.id)).toEqual(['pla', 'petg', 'abs', 'pc', 'pa12', 'pa-cf']);
    for (const m of all) {
      if (m.form === 'printed') {
        expect(m.ultimateStrength?.note, m.id).toMatch(/X/);
        expect(m.ultimateStrengthZ?.note, m.id).toMatch(/Z/);
      } else {
        expect(m.ultimateStrengthZ, m.id).toBeUndefined();
        expect(m.yieldStrengthZ, m.id).toBeUndefined();
      }
    }
  });

  it('gives every metal the stiffness and strengths a check needs', () => {
    for (const m of all.filter((x) => x.category === 'metal')) {
      expect(m.elasticModulus, m.id).toBeDefined();
      expect(m.yieldStrength, m.id).toBeDefined();
      expect(m.ultimateStrength, m.id).toBeDefined();
      expect(m.elongation, m.id).toBeDefined();
    }
  });

  it('has the values it cites for a few spot checks (SI)', () => {
    expect(findMaterial('aluminium-6061')?.yieldStrength?.value).toBe(276e6);
    expect(findMaterial('aluminium-6061')?.elasticModulus?.value).toBeCloseTo(68.9e9, 0);
    expect(findMaterial('aluminium-7075')?.ultimateStrength?.value).toBe(572e6);
    expect(findMaterial('steel')?.elasticModulus?.value).toBe(210e9);
    // A nominal (specification) value is marked as not typical.
    expect(findMaterial('steel')?.yieldStrength?.typical).toBe(false);
    expect(findMaterial('pla')?.ultimateStrengthZ?.value).toBe(31e6);
    expect(findMaterial('pom')?.maxServiceTemperature?.value).toBeCloseTo(373.15, 9);
  });

  it('documents a printed-part knockdown starting value, with its source', () => {
    expect(PRINTED_KNOCKDOWN_START.value).toBe(0.5);
    expect(PRINTED_KNOCKDOWN_START.source).toMatch(/Ahn/);
    // It is about the lowest Z/XY ratio of the built-in printed materials.
    const ratios = all
      .filter((m) => m.ultimateStrengthZ)
      .map((m) => m.ultimateStrengthZ!.value / m.ultimateStrength!.value);
    expect(Math.min(...ratios)).toBeCloseTo(0.47, 2);
    expect(Math.abs(Math.min(...ratios) - PRINTED_KNOCKDOWN_START.value)).toBeLessThan(0.05);
  });
});

describe('user materials (the shape T9.1e stores)', () => {
  it('has ids material#n, from 1', () => {
    expect(USER_MATERIAL_ID_PATTERN.test('material#1')).toBe(true);
    expect(USER_MATERIAL_ID_PATTERN.test('material#12')).toBe(true);
    for (const bad of ['material#0', 'material#01', 'material#', 'pla', 'material#1x']) {
      expect(USER_MATERIAL_ID_PATTERN.test(bad), bad).toBe(false);
    }
    for (const m of all) expect(USER_MATERIAL_ID_PATTERN.test(m.id), m.id).toBe(false);
  });

  it('types a material definition with sourced constant expressions', () => {
    const expr = (source: string) => ({
      source,
      lengthUnit: 'mm' as const,
      angleUnit: 'deg' as const,
    });
    const def: MaterialDef = {
      id: 'material#1',
      name: 'Shop 6082-T6',
      category: 'metal',
      form: 'wrought',
      density: { value: expr('2700 kg/m^3'), source: 'EN 755-2', typical: true },
      properties: {
        yieldStrength: { value: expr('250 MPa'), source: 'EN 755-2', typical: false },
      },
    };
    expect(def.properties?.yieldStrength?.typical).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Existing documents' mass results.

const json = (dir: URL) => {
  const path = fileURLToPath(dir);
  return readdirSync(path)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(path + f, 'utf8')) as unknown] as const);
};

/** Every object in `value` (depth first). */
function* objects(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) for (const v of value) yield* objects(v);
  else if (value !== null && typeof value === 'object') {
    yield value as Record<string, unknown>;
    for (const v of Object.values(value)) yield* objects(v);
  }
}

describe("existing documents' mass results", () => {
  it('reproduces every material mass in the review goldens exactly', () => {
    const goldens = json(new URL('../../review/src/test/goldens/', import.meta.url));
    let checked = 0;
    for (const [file, golden] of goldens) {
      for (const o of objects(golden)) {
        if (typeof o.mass !== 'number' || typeof o.volume !== 'number') continue;
        if (typeof o.material !== 'string') continue;
        const m = findMaterial(o.material);
        expect(m, `${file}: ${o.material}`).toBeDefined();
        expect(massGrams(o.volume, m!.density), file).toBeCloseTo(o.mass, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('resolves every material of the core fixtures to its original density', () => {
    const original: Record<string, number> = {
      pla: 1240,
      petg: 1270,
      abs: 1040,
      pine: 400,
      oak: 700,
      plywood: 680,
      mdf: 750,
      'aluminium-6061': 2700,
      steel: 7850,
    };
    const used = new Set<string>();
    for (const dir of ['./fixtures/', './fixtures/logs/']) {
      for (const [, doc] of json(new URL(dir, import.meta.url))) {
        for (const o of objects(doc)) if (typeof o.material === 'string') used.add(o.material);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const id of used) expect(findMaterial(id)?.density, id).toBe(original[id]);
  });
});
