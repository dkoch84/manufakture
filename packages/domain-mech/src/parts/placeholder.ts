// The placeholder feature, `mech.placeholder` (ADR 0017 decision 7): a generic solid standing in
// for a purchased part that has no STEP file, so it shows in renders, measures and interference
// checks and can be placed in an assembly. A cylinder (a motor, a cell, a rope's section), a ring
// (a bearing, a pulley, a gear) or a box (a controller, a connector, a belt's section), built in
// the part's frame:
//
// - cylinder: `diameter`, extruded `length` along the axis from the origin, centred on the axis;
// - ring: `outerDiameter` with an `innerDiameter` bore, extruded `width` along the axis;
// - box: `length` along the first axis across, `width` along the second, extruded `height` along
//   the axis, centred on the axis (axis z: length along x, width along y).
//
// The params hold the `CatalogRef` and the shape; the sizes are the feature's length expressions,
// filled from the entry's dimensions when the part is placed (`placeholderFeature`). A translator
// reads its feature, the domain data and the part, never the document's `mech.catalog`, so the
// sizes travel with the feature; `placeholderDrift` says when they no longer match the entry.
// Params are versioned by the domain (ADR 0013 decision 4), so they need no format bump.

import {
  CatalogRefSchema,
  lengthFormat,
  type CatalogEntry,
  type CatalogRef,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
  type Rated,
  type StoredExpression,
} from '@manufakture/core';
import type { ExtrudeInput, ProfileEntity, Vec3 } from '@manufakture/kernel';
import type {
  ExpressionKind,
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
  JsonValue,
  ReadResult,
} from '@manufakture/regen';
import { evaluate, formatLength } from '@manufakture/units';
import { refText, resolveEntry, type BuiltinEntry } from './catalog';
import { familySchema } from './families';

export const PLACEHOLDER_TYPE = 'mech.placeholder';
/** The params' version; raise it with a migration in `readPlaceholderParams`. */
export const PLACEHOLDER_SCHEMA_VERSION = 1;

export type PlaceholderKind = 'cylinder' | 'ring' | 'box';
export type PlaceholderAxis = 'x' | 'y' | 'z';

export interface PlaceholderParams {
  entry: CatalogRef;
  shape: PlaceholderKind;
  axis: PlaceholderAxis;
}

/** The sizes each shape reads, all lengths. */
export const PLACEHOLDER_SIZES: Readonly<Record<PlaceholderKind, readonly string[]>> = {
  cylinder: ['diameter', 'length'],
  ring: ['outerDiameter', 'innerDiameter', 'width'],
  box: ['length', 'width', 'height'],
};

/** The kind of every expression a placeholder may have. */
export const PLACEHOLDER_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = {
  diameter: 'length',
  length: 'length',
  outerDiameter: 'length',
  innerDiameter: 'length',
  width: 'length',
  height: 'length',
};

/** The largest size a placeholder builds, mm (10 m): a crafted entry cannot ask for more. */
export const MAX_PLACEHOLDER_SIZE = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A placeholder's params stored at `schemaVersion`, validated: regen's params check. */
export function readPlaceholderParams(
  params: Readonly<Record<string, JsonValue>>,
  schemaVersion: number,
): ReadResult<PlaceholderParams> {
  if (schemaVersion > PLACEHOLDER_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `"${PLACEHOLDER_TYPE}" params of version ${schemaVersion}; this build reads up to ${PLACEHOLDER_SCHEMA_VERSION}`,
    };
  }
  if (!isObject(params)) return { ok: false, message: 'expected the placeholder params object' };
  for (const key of Object.keys(params)) {
    if (!['entry', 'shape', 'axis'].includes(key)) {
      return { ok: false, message: `unknown field "${key.slice(0, 64)}"`, field: [key] };
    }
  }
  const entry = CatalogRefSchema.safeParse(params.entry);
  if (!entry.success) {
    return { ok: false, message: 'expected a catalog reference', field: ['entry'] };
  }
  const shape = params.shape;
  if (shape !== 'cylinder' && shape !== 'ring' && shape !== 'box') {
    return { ok: false, message: 'expected "cylinder", "ring" or "box"', field: ['shape'] };
  }
  const axis = params.axis ?? 'z';
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
    return { ok: false, message: 'expected "x", "y" or "z"', field: ['axis'] };
  }
  return { ok: true, value: { entry: entry.data, shape, axis } };
}

/** The frame of a profile across `axis`: x then y across, the normal along it. */
function frameOf(axis: PlaceholderAxis): { origin: Vec3; xDir: Vec3; normal: Vec3 } {
  switch (axis) {
    case 'x':
      return { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };
    case 'y':
      return { origin: [0, 0, 0], xDir: [0, 0, 1], normal: [0, 1, 0] };
    case 'z':
      return { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  }
}

type Failure = Extract<ExtensionOutput, { error: string }>;
const fail = (error: string, field?: (string | number)[]): Failure =>
  field === undefined ? { error } : { error, field };

/** The kernel input of a placeholder from its params and sizes (mm), or why not. Pure. */
export function placeholderInput(
  id: string,
  params: PlaceholderParams,
  sizes: Readonly<Record<string, number>>,
): ExtrudeInput | Failure {
  const need = PLACEHOLDER_SIZES[params.shape];
  for (const name of need) {
    const v = sizes[name];
    if (v === undefined) return fail(`a ${params.shape} needs its ${name}`, ['expressions']);
    if (!(v > 0) || !Number.isFinite(v)) {
      return fail(`the ${name} must be above zero`, ['expressions', name]);
    }
    if (v > MAX_PLACEHOLDER_SIZE) {
      return fail(`the ${name} is over ${MAX_PLACEHOLDER_SIZE} mm`, ['expressions', name]);
    }
  }
  let loops: { entities: ProfileEntity[] }[];
  let distance: number;
  if (params.shape === 'cylinder') {
    loops = [
      { entities: [{ kind: 'circle', id: 'outer', center: [0, 0], radius: sizes.diameter! / 2 }] },
    ];
    distance = sizes.length!;
  } else if (params.shape === 'ring') {
    const outer = sizes.outerDiameter!;
    const inner = sizes.innerDiameter!;
    if (!(inner < outer)) {
      return fail('the inner diameter must be less than the outer', [
        'expressions',
        'innerDiameter',
      ]);
    }
    loops = [
      { entities: [{ kind: 'circle', id: 'outer', center: [0, 0], radius: outer / 2 }] },
      { entities: [{ kind: 'circle', id: 'inner', center: [0, 0], radius: inner / 2 }] },
    ];
    distance = sizes.width!;
  } else {
    const u = sizes.length! / 2;
    const v = sizes.width! / 2;
    const line = (lid: string, start: [number, number], end: [number, number]): ProfileEntity => ({
      kind: 'line',
      id: lid,
      start,
      end,
    });
    loops = [
      {
        entities: [
          line('front', [-u, -v], [u, -v]),
          line('right', [u, -v], [u, v]),
          line('back', [u, v], [-u, v]),
          line('left', [-u, v], [-u, -v]),
        ],
      },
    ];
    distance = sizes.height!;
  }
  return {
    kind: 'extrude',
    id,
    profile: { frame: frameOf(params.axis), loops },
    extent: { type: 'blind', distance },
    mode: 'new',
  };
}

/** What a placeholder reports in its feature result. */
export interface PlaceholderMetadata {
  kind: 'placeholder';
  entry: CatalogRef;
  shape: PlaceholderKind;
  axis: PlaceholderAxis;
  /** The sizes it was built with, mm. */
  sizes: Record<string, number>;
}

function translate(ctx: ExtensionContext<PlaceholderParams>): ExtensionOutput {
  const f = ctx.feature;
  if (f.operation !== 'new') {
    return fail('a placeholder makes a body of its own: its operation must be "new"', [
      'operation',
    ]);
  }
  if (f.scope !== undefined) return fail('a placeholder cuts nothing: it has no scope', ['scope']);
  if (f.references.length > 0 || f.dependsOn.length > 0) {
    return fail('a placeholder needs no references and depends on nothing', ['references']);
  }
  const need = PLACEHOLDER_SIZES[ctx.params.shape];
  for (const name of Object.keys(f.expressions).sort()) {
    if (!need.includes(name)) {
      return fail(`a ${ctx.params.shape} has no "${name}" size (it reads ${need.join(', ')})`, [
        'expressions',
        name,
      ]);
    }
  }
  const sizes: Record<string, number> = {};
  for (const name of need) {
    const v = ctx.values[name];
    if (v !== undefined) sizes[name] = v;
  }
  const input = placeholderInput(f.id, ctx.params, sizes);
  if ('error' in input) return input;
  const metadata: PlaceholderMetadata = {
    kind: 'placeholder',
    entry: ctx.params.entry,
    shape: ctx.params.shape,
    axis: ctx.params.axis,
    sizes,
  };
  return { inputs: [input], metadata: metadata as unknown as JsonValue };
}

/** The `mech.placeholder` extension type, as the domain registers it. */
export const placeholderType: ExtensionType<PlaceholderParams> = {
  schemaVersion: PLACEHOLDER_SCHEMA_VERSION,
  expressions: PLACEHOLDER_EXPRESSIONS,
  params: readPlaceholderParams,
  translate,
};

/** How an entry's dimensions fill a placeholder's sizes (the family's names map one to one). */
function dimensionValue(entry: CatalogEntry | BuiltinEntry, name: string): number | undefined {
  const d: Rated | undefined = entry.dimensions?.[name];
  return d !== undefined && 'value' in d ? d.value : undefined;
}

/** The shape an entry is placed as: the one it names, else its family's. */
export function entryShape(entry: CatalogEntry | BuiltinEntry): {
  kind: PlaceholderKind;
  axis: PlaceholderAxis;
} {
  if (entry.geometry?.kind === 'placeholder') {
    return { kind: entry.geometry.shape.kind, axis: entry.geometry.shape.axis ?? 'z' };
  }
  return { kind: familySchema(entry.family).placeholder, axis: 'z' };
}

/** The sizes of an entry's placeholder, mm, or the names of the dimensions it lacks. */
export function entrySizes(
  entry: CatalogEntry | BuiltinEntry,
): { ok: true; sizes: Record<string, number> } | { ok: false; missing: string[] } {
  const { kind } = entryShape(entry);
  const sizes: Record<string, number> = {};
  const missing: string[] = [];
  for (const name of PLACEHOLDER_SIZES[kind]) {
    const v = dimensionValue(entry, name);
    if (v === undefined) missing.push(name);
    else sizes[name] = v;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, sizes };
}

/** A length as a stored expression in millimetres, to 12 significant digits. */
function mmExpression(mm: number): StoredExpression {
  return { source: `${Number(mm.toPrecision(12))} mm`, lengthUnit: 'mm', angleUnit: 'deg' };
}

/**
 * The placeholder feature of an entry, with the sizes from its dimensions; or the dimensions it
 * lacks. `id` is the fresh `extension#n` of the part it goes in.
 */
export function placeholderFeature(
  id: string,
  ref: CatalogRef,
  entry: CatalogEntry | BuiltinEntry,
  name: string,
): { ok: true; feature: ExtensionFeature } | { ok: false; message: string } {
  const { kind, axis } = entryShape(entry);
  const sizes = entrySizes(entry);
  if (!sizes.ok) {
    return {
      ok: false,
      message: `${entry.maker} ${entry.partNumber} has no ${sizes.missing.join(', ')}: a ${kind} placeholder is built from them`,
    };
  }
  const expressions: Record<string, StoredExpression> = {};
  for (const [k, v] of Object.entries(sizes.sizes)) expressions[k] = mmExpression(v);
  return {
    ok: true,
    feature: {
      id,
      kind: 'extension',
      name: name.slice(0, 200),
      suppressed: false,
      extension: PLACEHOLDER_TYPE,
      schemaVersion: PLACEHOLDER_SCHEMA_VERSION,
      dependsOn: [],
      references: [],
      expressions,
      params: { entry: { ...ref }, shape: kind, axis },
      operation: 'new',
    },
  };
}

/**
 * How a placeholder feature's sizes differ from its entry's dimensions now (the user edited the
 * entry or the feature): one line per size, empty when they match or the entry cannot be read.
 * Sizes are evaluated without variables; one that uses a variable is not compared.
 */
export function placeholderDrift(
  doc: ManufaktureDocument,
  feature: ExtensionFeature,
  units: DisplayUnits = doc.units,
): string[] {
  if (feature.extension !== PLACEHOLDER_TYPE) return [];
  const params = readPlaceholderParams(feature.params, feature.schemaVersion);
  if (!params.ok) return [];
  const resolved = resolveEntry(doc, params.value.entry);
  if (!resolved.ok) return [];
  const want = entrySizes(resolved.entry);
  if (!want.ok) return [];
  const out: string[] = [];
  const fmt = (mm: number) => formatLength(mm, lengthFormat(units));
  for (const [name, expected] of Object.entries(want.sizes)) {
    const e = feature.expressions[name];
    if (e === undefined) {
      out.push(`${name}: not set; ${refText(params.value.entry)} gives ${fmt(expected)}`);
      continue;
    }
    const r = evaluate(e.source, { expected: 'length', lengthUnit: e.lengthUnit });
    if (!r.ok) continue;
    if (Math.abs(r.value - expected) > 1e-6) {
      out.push(`${name}: ${fmt(r.value)}; ${refText(params.value.entry)} gives ${fmt(expected)}`);
    }
  }
  return out;
}
