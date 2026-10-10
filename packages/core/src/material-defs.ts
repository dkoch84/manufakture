// User materials (ADR 0017 decision 4, since version 19): what each property of a `MaterialDef`
// must evaluate to, the evaluation of a definition to a `Material` like the built-in ones, and the
// lookup of a material id in a document. A user material's values are constants typed through
// `packages/units`: a variable is refused (a material is a library entry; a design variable
// belongs in the feature or the check that uses it).

import {
  evaluate,
  evaluateQuantity,
  dimensionsEqual,
  makeDimension,
  quantityToSI,
  type Dimension,
  type QuantityKind,
} from '@manufakture/units';
import {
  findMaterial,
  type FatigueCurve,
  type Material,
  type MaterialDef,
  type MaterialDefProperty,
  type MaterialPropertyKey,
  type Property,
} from './materials';
import type { ManufaktureDocument } from './schema';
import { expressionReferences } from './validate';

/**
 * What a user material's value must be: a `packages/units` kind, or a dimension for the
 * properties whose unit has no kind of its own (density, conductivity, specific heat, expansion),
 * evaluated in the physical mode and converted to SI.
 */
export type MaterialValueKind =
  { readonly kind: QuantityKind } | { readonly dimension: Dimension; readonly unit: string };

const DENSITY: MaterialValueKind = {
  dimension: makeDimension({ mass: 1, length: -3 }),
  unit: 'kg/m^3',
};

/** The kind each property of a user material is typed in. */
export const MATERIAL_VALUE_KINDS: { readonly [K in MaterialPropertyKey]: MaterialValueKind } = {
  elasticModulus: { kind: 'pressure' },
  poissonRatio: { kind: 'number' },
  yieldStrength: { kind: 'pressure' },
  ultimateStrength: { kind: 'pressure' },
  yieldStrengthZ: { kind: 'pressure' },
  ultimateStrengthZ: { kind: 'pressure' },
  enduranceLimit: { kind: 'pressure' },
  elongation: { kind: 'number' },
  thermalConductivity: {
    dimension: makeDimension({ mass: 1, length: 1, time: -3, temperature: -1 }),
    unit: 'W/(m*K)',
  },
  specificHeat: {
    dimension: makeDimension({ length: 2, time: -2, temperature: -1 }),
    unit: 'J/(kg*K)',
  },
  thermalExpansion: { dimension: makeDimension({ temperature: -1 }), unit: '1/K' },
  maxServiceTemperature: { kind: 'temperature' },
};

/** The SI value of one user material value, or why it has none. */
export function materialValue(
  source: string,
  kind: MaterialValueKind,
): { ok: true; value: number } | { ok: false; message: string } {
  const refs = expressionReferences(source, { physical: true });
  if (!refs.ok) return { ok: false, message: refs.error.message };
  if (refs.value.length > 0) {
    return {
      ok: false,
      message: `a material value is a constant, but "${source}" uses variable "${refs.value[0]!.name}"`,
    };
  }
  if ('kind' in kind) {
    const r = evaluate(source, { expected: kind.kind });
    return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error.message };
  }
  const q = evaluateQuantity(source, { physical: true });
  if (!q.ok) return { ok: false, message: q.error.message };
  if (!dimensionsEqual(q.value.dimension, kind.dimension)) {
    return { ok: false, message: `"${source}" is not in ${kind.unit} or a unit like it` };
  }
  return { ok: true, value: quantityToSI(q.value) };
}

/** A problem with one value of a user material, with its path from the definition. */
export interface MaterialDefProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Every value of a definition that does not evaluate as its property needs. */
export function materialDefProblems(def: MaterialDef): MaterialDefProblem[] {
  const out: MaterialDefProblem[] = [];
  const check = (path: readonly (string | number)[], value: string, kind: MaterialValueKind) => {
    const r = materialValue(value, kind);
    if (!r.ok) out.push({ path, message: r.message });
    return r;
  };
  const density = check(['density', 'value'], def.density.value.source, DENSITY);
  if (density.ok && !(density.value > 0)) {
    out.push({ path: ['density', 'value'], message: 'a density must be more than zero' });
  }
  for (const [key, p] of Object.entries(def.properties ?? {}) as [
    MaterialPropertyKey,
    MaterialDefProperty | undefined,
  ][]) {
    if (p !== undefined)
      check(['properties', key, 'value'], p.value.source, MATERIAL_VALUE_KINDS[key]);
  }
  def.fatigue?.points.forEach((pt, i) =>
    check(['fatigue', 'points', i, 'stress'], pt.stress.source, { kind: 'pressure' }),
  );
  return out;
}

function property(p: MaterialDefProperty, value: number): Property {
  return p.note === undefined
    ? { value, source: p.source, typical: p.typical }
    : { value, source: p.source, typical: p.typical, note: p.note };
}

/**
 * A user material as a `Material`, with its values in SI; a value that does not evaluate is left
 * out, so a check needing it reports it missing. Undefined when the density does not evaluate.
 */
export function evaluateMaterialDef(def: MaterialDef): Material | undefined {
  const density = materialValue(def.density.value.source, DENSITY);
  if (!density.ok) return undefined;
  const out: Record<string, unknown> = {
    id: def.id,
    name: def.name,
    category: def.category,
    form: def.form,
    density: density.value,
    source: def.density.source,
  };
  for (const [key, p] of Object.entries(def.properties ?? {}) as [
    MaterialPropertyKey,
    MaterialDefProperty | undefined,
  ][]) {
    if (p === undefined) continue;
    const r = materialValue(p.value.source, MATERIAL_VALUE_KINDS[key]);
    if (r.ok) out[key] = property(p, r.value);
  }
  if (def.fatigue !== undefined) {
    const points = def.fatigue.points.map((pt) => ({
      cycles: pt.cycles,
      stress: materialValue(pt.stress.source, { kind: 'pressure' }),
    }));
    if (points.every((pt) => pt.stress.ok)) {
      const curve: FatigueCurve = {
        points: points.map((pt) => ({
          cycles: pt.cycles,
          stress: (pt.stress as { value: number }).value,
        })),
        source: def.fatigue.source,
        typical: def.fatigue.typical,
        ...(def.fatigue.note !== undefined && { note: def.fatigue.note }),
      };
      out.fatigue = curve;
    }
  }
  return out as unknown as Material;
}

/**
 * The material with this id in a document: a built-in one, or a user material of `materials`
 * evaluated to SI. Undefined for an unknown id.
 */
export function documentMaterial(doc: ManufaktureDocument, id: string): Material | undefined {
  return materialIn(doc.materials, id);
}

/** `documentMaterial` given only the document's `materials` (absent: none). */
export function materialIn(
  materials: ManufaktureDocument['materials'],
  id: string,
): Material | undefined {
  const builtin = findMaterial(id);
  if (builtin !== undefined) return builtin;
  const def = materials?.find((m) => m.id === id);
  return def === undefined ? undefined : evaluateMaterialDef(def);
}

/**
 * The parts and bodies that use material `id`, as part ids and `<part id>/<body id>`, in document
 * order: what blocks deleting a user material.
 */
export function materialUsers(doc: ManufaktureDocument, id: string): string[] {
  const out: string[] = [];
  for (const part of doc.parts) {
    if (part.material === id) out.push(part.id);
    for (const body of part.bodies) if (body.material === id) out.push(`${part.id}/${body.id}`);
  }
  return out;
}
