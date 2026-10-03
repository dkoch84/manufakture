// The Roof tool's logic, free of React: a gable or hip roof (`construction.roof`, M6 T6.1c) that
// bears on the walls it names in `dependsOn` (their framing must close a rectangle) or on a level
// (a rectangle typed by its corner, length, width and rotation). Its pitch is a slope field
// (`pitch.ts`); its overhangs and spacing override its roof type's; its rafter, ridge and hip stock
// come from a roof type in `domains.construction`, chosen or made here. Adding a roof (with a new
// roof type, or the hip stock a hip roof needs) is one undo step.
//
// Also the pitch preview: the roof's eave rectangle, ridge and hips or gable ends drawn at the
// plates' top, from the walls' regen metadata or the typed rectangle, and the pitch shown at the
// ridge as `p/12` and degrees.
//
// Every size is the user's (ADR 0015 decision 7): rafter, ridge and hip stock start unchosen.

import {
  previewIds,
  type Command,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import {
  MAX_FLOOR_WALLS,
  MAX_OVERHANG,
  MAX_TIE_EVERY,
  MAX_TYPES,
  MIN_SPACING,
  ROOF_SCHEMA_VERSION,
  ROOF_TYPE,
  readRoofParams,
  type RoofType,
  type WallMetadata,
} from '@manufakture/domain-construction';
import type { Variables } from '../../sketcher/values';
import { isRoof, isWall } from '../kinds';
import { makesBodies, settingsCommand, storedOrDefault, wallTypeId } from '../settings';
import {
  countOf,
  defaultWalls,
  isStock,
  keptOverrides,
  optionalAngle,
  optionalLength,
} from '../tools';
import { newFeatureName } from '../walls';
import { checkPitch } from './pitch';

export type StoredRoofType = RoofType<StoredExpression>;
export type RoofKind = 'gable' | 'hip';
export type TiesKind = 'none' | 'ceiling-joists' | 'rafter-ties';

/** A new roof type, made with the roof. */
export interface RoofTypeInput {
  name: string;
  rafterStock: string;
  ridgeStock: string;
  /** Hip rafters; a hip roof needs them. */
  hipStock: string | null;
  sheathing: string | null;
}

export interface RoofForm {
  bearing: 'walls' | 'level';
  walls: string[];
  level: string;
  /** The rectangle on a level: a corner, the sides, a rotation in plan, the plates' height. */
  x: string;
  y: string;
  length: string;
  width: string;
  rotation: string;
  plate: string;
  wallThickness: string;
  /** A roof type's id; '' makes `newType`. */
  roofType: string;
  newType: RoofTypeInput;
  /** The hip stock to give a chosen roof type that has none, for a hip roof. */
  hipStock: string;
  kind: RoofKind;
  ridge: 'long' | 'short';
  pitch: string;
  overhang: string;
  rakeOverhang: string;
  spacing: string;
  ties: TiesKind;
  tieStock: string;
  tieEvery: string;
  tieHeight: string;
  gableStuds: boolean;
}

/** A new roof on `level`: on its walls when it has any, with the first roof type. */
export function newRoofForm(
  doc: ManufaktureDocument,
  partId: string,
  level: string,
  units: DisplayUnits,
): RoofForm {
  const part = doc.parts.find((p) => p.id === partId);
  const s = storedOrDefault(doc);
  const types = s.ok ? s.stored.roofTypes : [];
  const walls = defaultWalls(part, level);
  const us = units.length.unit === 'ft-in' || units.length.unit === 'in-fraction';
  return {
    bearing: walls.length > 0 ? 'walls' : 'level',
    walls,
    level,
    x: '0',
    y: '0',
    length: '',
    width: '',
    rotation: '',
    plate: '',
    wallThickness: '',
    roofType: types[0]?.id ?? '',
    newType: {
      name: 'Roof',
      rafterStock: '',
      ridgeStock: '',
      hipStock: null,
      sheathing: us ? 'us-osb-7-16' : 'mm-ply-18',
    },
    hipStock: '',
    kind: 'gable',
    ridge: 'long',
    pitch: '',
    overhang: '',
    rakeOverhang: '',
    spacing: '',
    ties: 'none',
    tieStock: '',
    tieEvery: '1',
    tieHeight: '',
    gableStuds: true,
  };
}

/** The form of an existing roof. */
export function roofFormOf(
  doc: ManufaktureDocument,
  partId: string,
  roof: ExtensionFeature,
  units: DisplayUnits,
): RoofForm {
  const p = roof.params as Record<string, unknown>;
  const e = roof.expressions;
  const src = (k: string) => e[k]?.source ?? '';
  const part = doc.parts.find((x) => x.id === partId);
  const walls = roof.dependsOn.filter((d) => part?.features.some((f) => f.id === d && isWall(f)));
  const level =
    typeof p.level === 'string'
      ? p.level
      : String(part?.features.filter(isWall).find((f) => f.id === walls[0])?.params.level ?? '');
  const ties = (p.ties ?? { kind: 'none' }) as { kind: TiesKind; stock?: string; every?: number };
  return {
    ...newRoofForm(doc, partId, level, units),
    bearing: walls.length > 0 ? 'walls' : 'level',
    walls,
    level,
    x: src('x') || '0',
    y: src('y') || '0',
    length: src('length'),
    width: src('width'),
    rotation: src('rotation'),
    plate: src('plate'),
    wallThickness: src('wallThickness'),
    roofType: typeof p.roofType === 'string' ? p.roofType : '',
    kind: p.kind === 'hip' ? 'hip' : 'gable',
    ridge: p.ridge === 'short' ? 'short' : 'long',
    pitch: src('pitch'),
    overhang: src('overhang'),
    rakeOverhang: src('rakeOverhang'),
    spacing: src('spacing'),
    ties: ties.kind,
    tieStock: ties.stock ?? '',
    tieEvery: String(ties.every ?? 1),
    tieHeight: src('tieHeight'),
    gableStuds: p.gableStuds !== false,
  };
}

export type RoofBuild =
  | { ok: true; feature: ExtensionFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

/** Check a new roof type's fields; the type, or the errors. */
function newRoofType(
  input: RoofTypeInput,
  kind: RoofKind,
  taken: ReadonlySet<string>,
  errors: Record<string, string>,
): StoredRoofType | undefined {
  const name = input.name.trim();
  if (name === '' || name.length > 200)
    errors.typeName = 'A roof type name has 1 to 200 characters.';
  if (!isStock(input.rafterStock, 'lumber')) errors.rafterStock = 'Choose the rafter stock.';
  if (!isStock(input.ridgeStock, 'lumber')) errors.ridgeStock = 'Choose the ridge stock.';
  if (input.hipStock !== null && !isStock(input.hipStock, 'lumber')) {
    errors.hipStock = 'Choose the hip rafter stock.';
  }
  if (kind === 'hip' && input.hipStock === null) {
    errors.hipStock = 'A hip roof needs hip rafters: choose their stock.';
  }
  if (input.sheathing !== null && !isStock(input.sheathing, 'sheet')) {
    errors.sheathing = 'Choose the roof sheathing.';
  }
  if (taken.size >= MAX_TYPES) errors.roofType = `A document has at most ${MAX_TYPES} roof types.`;
  if (errors.typeName || errors.rafterStock || errors.ridgeStock || errors.hipStock)
    return undefined;
  if (errors.sheathing || errors.roofType) return undefined;
  return {
    id: wallTypeId(name, taken),
    name,
    rafterStock: input.rafterStock,
    ridgeStock: input.ridgeStock,
    ...(input.hipStock !== null ? { hipStock: input.hipStock } : {}),
    ...(input.sheathing !== null ? { sheathing: input.sheathing } : {}),
  };
}

/** A new roof, or the edit of `existing`, from the form: one command (one undo step). */
export function buildRoof(
  form: RoofForm,
  ctx: {
    doc: ManufaktureDocument;
    partId: string;
    variables: Variables;
    existing?: ExtensionFeature | undefined;
  },
): RoofBuild {
  const { doc, partId, variables } = ctx;
  const units = doc.units;
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, errors: { form: 'The part studio is gone.' } };
  const s = storedOrDefault(doc);
  if (!s.ok) return { ok: false, errors: { form: s.message } };
  const stored = s.stored;
  const errors: Record<string, string> = {};
  const expressions: Record<string, StoredExpression> = {};
  const field = { units, variables, out: expressions, errors };

  // The roof type: chosen, or made here; a hip roof's type needs hip stock.
  let type = stored.roofTypes.find((t) => t.id === form.roofType);
  let typeChanged = false;
  if (form.roofType === '') {
    type = newRoofType(form.newType, form.kind, new Set(stored.roofTypes.map((t) => t.id)), errors);
    typeChanged = type !== undefined;
  } else if (!type) {
    errors.roofType = 'Choose a roof type.';
  } else if (form.kind === 'hip' && type.hipStock === undefined) {
    if (!isStock(form.hipStock, 'lumber')) {
      errors.hipStock = `The ${type.name} roof type has no hip rafters: choose their stock.`;
    } else {
      type = { ...type, hipStock: form.hipStock };
      typeChanged = true;
    }
  }

  const pitch = checkPitch(form.pitch, units, variables);
  if (!pitch.ok) errors.pitch = pitch.message;
  else expressions.pitch = pitch.expression;
  const overhangMax = { value: MAX_OVERHANG, text: `${MAX_OVERHANG / 1000} m` };
  optionalLength(form.overhang, 'overhang', field, { sign: 'non-negative', max: overhangMax });
  if (form.kind === 'gable') {
    optionalLength(form.rakeOverhang, 'rakeOverhang', field, {
      sign: 'non-negative',
      max: overhangMax,
    });
  }
  optionalLength(form.spacing, 'spacing', field, {
    min: { value: MIN_SPACING, text: `${MIN_SPACING} mm` },
  });

  // Ties.
  let ties: Record<string, unknown> | undefined;
  if (form.ties !== 'none') {
    if (!isStock(form.tieStock, 'lumber')) errors.tieStock = 'Choose the tie stock.';
    const every = countOf(form.tieEvery, 1, MAX_TIE_EVERY);
    if (every === undefined) errors.tieEvery = `Every 1 to ${MAX_TIE_EVERY} rafter pairs.`;
    ties = { kind: form.ties, stock: form.tieStock, every: every ?? 1 };
    if (form.ties === 'rafter-ties') {
      if (form.tieHeight.trim() === '')
        errors.tieHeight = 'Rafter ties need a height above the plates.';
      else optionalLength(form.tieHeight, 'tieHeight', field, { sign: 'non-negative' });
    }
  }

  // Bearing: walls, or a rectangle on a level.
  let level = form.level;
  let dependsOn: string[] = [];
  let wallsMakeBodies = false;
  if (form.bearing === 'walls') {
    const walls = form.walls
      .map((id) => part.features.find((f) => f.id === id))
      .filter((f) => f !== undefined && isWall(f));
    if (walls.length === 0) errors.walls = 'Pick the walls the roof bears on.';
    else if (walls.length > MAX_FLOOR_WALLS) {
      errors.walls = `A roof bears on at most ${MAX_FLOOR_WALLS} walls.`;
    } else {
      const levels = new Set(walls.map((w) => String(w!.params.level)));
      if (levels.size > 1) errors.walls = 'The walls under a roof stand on one level.';
      level = String(walls[0]!.params.level);
      // In feature order, as regen reads them.
      const picked = new Set(walls.map((w) => w!.id));
      dependsOn = part.features.filter((f) => picked.has(f.id)).map((f) => f.id);
      wallsMakeBodies = walls.some((w) => {
        const wt = stored.wallTypes.find((t) => t.id === w!.params.wallType);
        return wt !== undefined && makesBodies(wt);
      });
    }
  } else {
    if (!stored.levels.some((l) => l.id === level)) errors.level = 'Choose a level.';
    for (const [key, text] of [
      ['x', form.x],
      ['y', form.y],
    ] as const) {
      if (text.trim() === '') errors[key] = 'Enter a coordinate.';
      else optionalLength(text, key, field, { sign: 'any' });
    }
    for (const [key, text] of [
      ['length', form.length],
      ['width', form.width],
    ] as const) {
      if (text.trim() === '') errors[key] = `Enter the roof's ${key} at the wall line.`;
      else optionalLength(text, key, field);
    }
    optionalAngle(form.rotation, 'rotation', field);
    optionalLength(form.plate, 'plate', field, { sign: 'non-negative' });
    optionalLength(form.wallThickness, 'wallThickness', field, { sign: 'non-negative' });
  }

  const kept = keptOverrides(ctx.existing);
  const params: Record<string, unknown> = {
    level,
    roofType: type?.id ?? form.roofType,
    kind: form.kind,
    ...(form.kind === 'gable' && form.ridge === 'short' ? { ridge: 'short' } : {}),
    ...(ties ? { ties } : {}),
    ...(form.kind === 'gable' && !form.gableStuds ? { gableStuds: false } : {}),
    ...kept.params,
  };
  Object.assign(expressions, kept.expressions);
  if (Object.keys(errors).length === 0) {
    const r = readRoofParams(params as never, ROOF_SCHEMA_VERSION);
    if (!r.ok) errors.form = r.message;
  }
  if (Object.keys(errors).length > 0 || !type) return { ok: false, errors };

  const id = ctx.existing?.id ?? previewIds(part.nextIds, 'extension')[0]!;
  const name = ctx.existing?.name ?? newFeatureName(part, 'Roof', isRoof);
  const makes = type.sheathing !== undefined || (form.kind === 'gable' && wallsMakeBodies);
  const feature: ExtensionFeature = {
    id,
    kind: 'extension',
    name,
    suppressed: ctx.existing?.suppressed ?? false,
    extension: ROOF_TYPE,
    schemaVersion: ROOF_SCHEMA_VERSION,
    dependsOn,
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    ...(makes ? { operation: 'new' as const } : {}),
  };
  const featureCommand: Command = ctx.existing
    ? { type: 'editFeature', partId, feature }
    : { type: 'addFeature', partId, feature };
  const label = `${ctx.existing ? 'Edit' : 'Add'} ${name}`;
  if (!typeChanged) return { ok: true, feature, command: featureCommand, label };
  const roofTypes = stored.roofTypes.some((t) => t.id === type.id)
    ? stored.roofTypes.map((t) => (t.id === type.id ? type : t))
    : [...stored.roofTypes, type];
  const r = settingsCommand(doc, { ...stored, roofTypes }, label, [featureCommand]);
  if (!r.ok) return { ok: false, errors: { form: r.message } };
  return { ok: true, feature, command: r.command ?? featureCommand, label };
}

// Pitch preview ------------------------------------------------------------------------------------

type P2 = readonly [number, number];
export type V3 = [number, number, number];

/** A roof's rectangle in plan at the plates' top: a corner, the length axis, the sides. */
export interface PreviewFootprint {
  origin: P2;
  /** Unit vector along the length (e1). */
  u: P2;
  length: number;
  width: number;
  plate: number;
}

/**
 * The rectangle the walls' paths (their framing's outside faces) enclose, along their longest
 * segment, and the highest plate top among them; null without a path. Linear in the points.
 */
export function wallsFootprint(metas: readonly WallMetadata[]): PreviewFootprint | null {
  let best: { u: P2; len: number } | null = null;
  let plate = -Infinity;
  for (const m of metas) {
    plate = Math.max(plate, m.base + m.height);
    const n = m.closed ? m.points.length : m.points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = m.points[i]!;
      const b = m.points[(i + 1) % m.points.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 0 && (!best || len > best.len)) {
        best = { u: [(b[0] - a[0]) / len, (b[1] - a[1]) / len], len };
      }
    }
  }
  if (!best || !Number.isFinite(plate)) return null;
  const u = best.u;
  const v: P2 = [-u[1], u[0]];
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const m of metas) {
    for (const p of m.points) {
      const pu = p[0] * u[0] + p[1] * u[1];
      const pv = p[0] * v[0] + p[1] * v[1];
      u0 = Math.min(u0, pu);
      u1 = Math.max(u1, pu);
      v0 = Math.min(v0, pv);
      v1 = Math.max(v1, pv);
    }
  }
  if (!(u1 - u0 > 0 && v1 - v0 > 0)) return null;
  return {
    origin: [u[0] * u0 + v[0] * v0, u[1] * u0 + v[1] * v0],
    u,
    length: u1 - u0,
    width: v1 - v0,
    plate,
  };
}

/**
 * The preview's lines (the eave rectangle at the wall line, the ridge, and the gable ends or the
 * hips) and the point at the middle of the ridge, where the pitch is shown.
 */
export function roofPreviewLines(
  fp: PreviewFootprint,
  kind: RoofKind,
  ridge: 'long' | 'short',
  pitch: number,
): { lines: V3[][]; apex: V3 } {
  // The ridge runs along the longer side (or the shorter, for a gable asked to).
  let u = fp.u;
  let L = fp.length;
  let W = fp.width;
  let o = fp.origin;
  const wantLong = kind === 'hip' || ridge === 'long';
  if (wantLong ? W > L : W < L) {
    // Turn the rectangle a quarter: the old v is the new u, from the corner that keeps it CCW.
    const v: P2 = [-u[1], u[0]];
    o = [o[0] + u[0] * L, o[1] + u[1] * L];
    u = v;
    [L, W] = [W, L];
  }
  const v: P2 = [-u[1], u[0]];
  const z = fp.plate;
  const rise = (W / 2) * Math.tan(pitch);
  const at = (a: number, b: number, h: number): V3 => [
    o[0] + u[0] * a + v[0] * b,
    o[1] + u[1] * a + v[1] * b,
    h,
  ];
  const c0 = at(0, 0, z);
  const c1 = at(L, 0, z);
  const c2 = at(L, W, z);
  const c3 = at(0, W, z);
  const lines: V3[][] = [[c0, c1, c2, c3, c0]];
  if (kind === 'gable') {
    const r0 = at(0, W / 2, z + rise);
    const r1 = at(L, W / 2, z + rise);
    lines.push([c0, r0, c3], [c1, r1, c2], [r0, r1]);
    return { lines, apex: at(L / 2, W / 2, z + rise) };
  }
  const a = Math.min(W / 2, L / 2);
  const r0 = at(a, W / 2, z + rise);
  const r1 = at(L - a, W / 2, z + rise);
  lines.push([c0, r0, c3], [c1, r1, c2], [r0, r1]);
  return { lines, apex: at(L / 2, W / 2, z + rise) };
}

/** The footprint typed for a roof on a level, in mm, or null while a field is not a value. */
export function levelFootprint(
  values: {
    x: number | undefined;
    y: number | undefined;
    length: number | undefined;
    width: number | undefined;
    rotation?: number | undefined;
  },
  plate: number,
): PreviewFootprint | null {
  const { x, y, length, width } = values;
  if (x === undefined || y === undefined || !(length! > 0) || !(width! > 0)) return null;
  const r = values.rotation ?? 0;
  return { origin: [x, y], u: [Math.cos(r), Math.sin(r)], length: length!, width: width!, plate };
}
