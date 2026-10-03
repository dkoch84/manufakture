// The Floor tool's logic, free of React: a floor (`construction.floor`, M6 T6.1c) under a level,
// its outline from the walls on the level (their framing's outside line, which must close a
// ring), from typed points, or from a sketch's outer loop. Joists span the outline's short or
// long side, or run at a typed angle; their spacing overrides the floor type's; skids go under
// them. The joist and rim stock and the subfloor come from a floor type in
// `domains.construction`, chosen or made here. Adding a floor (with a new floor type) is one undo
// step.
//
// Every size is the user's (ADR 0015 decision 7): joist and skid stock start unchosen.

import {
  previewIds,
  type Command,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from '@manufakture/core';
import {
  FLOOR_SCHEMA_VERSION,
  FLOOR_TYPE,
  MAX_FLOOR_WALLS,
  MAX_OUTLINE_POINTS,
  MAX_SKIDS,
  MAX_TYPES,
  MIN_SPACING,
  readFloorParams,
  type FloorType,
} from '@manufakture/domain-construction';
import type { Variables } from '../../sketcher/values';
import { isFloor, isWall } from '../kinds';
import { settingsCommand, storedOrDefault, wallTypeId } from '../settings';
import {
  countOf,
  defaultWalls,
  isStock,
  keptOverrides,
  optionalAngle,
  optionalLength,
} from '../tools';
import { newFeatureName } from '../walls';

export type StoredFloorType = FloorType<StoredExpression>;
export type OutlineSource = 'walls' | 'points' | 'sketch';

/** A new floor type, made with the floor. */
export interface FloorTypeInput {
  name: string;
  joistStock: string;
  /** Rim joists; the joist stock when null. */
  rimStock: string | null;
  subfloor: string | null;
}

export interface FloorForm {
  level: string;
  outline: OutlineSource;
  walls: string[];
  points: { x: string; y: string }[];
  sketch: string;
  /** A floor type's id; '' makes `newType`. */
  floorType: string;
  newType: FloorTypeInput;
  /** `short` or `long` side, or `angle` (the direction field). */
  joists: 'short' | 'long' | 'angle';
  direction: string;
  spacing: string;
  blocking: 'none' | 'mid-span';
  skids: boolean;
  skidStock: string;
  skidCount: string;
  skidOverhang: string;
}

/** The sketches of a part studio, in feature order (outline sources). */
export function sketchesOf(part: Part | undefined): { id: string; name: string }[] {
  return (part?.features ?? [])
    .filter((f) => f.kind === 'sketch')
    .map((f) => ({ id: f.id, name: f.name }));
}

/** A new floor on `level`: under its walls when it has any, with the first floor type. */
export function newFloorForm(
  doc: ManufaktureDocument,
  partId: string,
  level: string,
  units: DisplayUnits,
): FloorForm {
  const part = doc.parts.find((p) => p.id === partId);
  const s = storedOrDefault(doc);
  const types = s.ok ? s.stored.floorTypes : [];
  const walls = defaultWalls(part, level);
  const us = units.length.unit === 'ft-in' || units.length.unit === 'in-fraction';
  const sketches = sketchesOf(part);
  return {
    level,
    outline: walls.length > 0 ? 'walls' : 'points',
    walls,
    points: [
      { x: '0', y: '0' },
      { x: '', y: '0' },
      { x: '', y: '' },
      { x: '0', y: '' },
    ],
    sketch: sketches[0]?.id ?? '',
    floorType: types[0]?.id ?? '',
    newType: {
      name: 'Floor',
      joistStock: '',
      rimStock: null,
      subfloor: us ? 'us-osb-23-32' : 'mm-ply-18',
    },
    joists: 'short',
    direction: '',
    spacing: '',
    blocking: 'none',
    skids: false,
    skidStock: '',
    skidCount: '3',
    skidOverhang: '',
  };
}

/** The form of an existing floor. */
export function floorFormOf(
  doc: ManufaktureDocument,
  partId: string,
  floor: ExtensionFeature,
  units: DisplayUnits,
): FloorForm {
  const p = floor.params as Record<string, unknown>;
  const e = floor.expressions;
  const src = (k: string) => e[k]?.source ?? '';
  const level = typeof p.level === 'string' ? p.level : '';
  const part = doc.parts.find((x) => x.id === partId);
  const outline: OutlineSource =
    p.outline === 'points' ? 'points' : p.outline === 'sketch' ? 'sketch' : 'walls';
  const n = typeof p.points === 'number' ? Math.min(p.points, MAX_OUTLINE_POINTS) : 0;
  const skids = p.skids as { stock: string; count: number } | undefined;
  const base = newFloorForm(doc, partId, level, units);
  return {
    ...base,
    outline,
    walls: floor.dependsOn.filter((d) => part?.features.some((f) => f.id === d && isWall(f))),
    points:
      outline === 'points'
        ? Array.from({ length: n }, (_, i) => ({ x: src(`x${i + 1}`), y: src(`y${i + 1}`) }))
        : base.points,
    sketch:
      outline === 'sketch'
        ? (floor.dependsOn.find((d) =>
            part?.features.some((f) => f.id === d && f.kind === 'sketch'),
          ) ?? '')
        : base.sketch,
    floorType: typeof p.floorType === 'string' ? p.floorType : '',
    joists: e.direction ? 'angle' : p.joists === 'long' ? 'long' : 'short',
    direction: src('direction'),
    spacing: src('spacing'),
    blocking: p.blocking === 'mid-span' ? 'mid-span' : 'none',
    skids: skids !== undefined,
    skidStock: skids?.stock ?? '',
    skidCount: String(skids?.count ?? 3),
    skidOverhang: src('skidOverhang'),
  };
}

export type FloorBuild =
  | { ok: true; feature: ExtensionFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

function newFloorType(
  input: FloorTypeInput,
  taken: ReadonlySet<string>,
  errors: Record<string, string>,
): StoredFloorType | undefined {
  const name = input.name.trim();
  if (name === '' || name.length > 200) {
    errors.typeName = 'A floor type name has 1 to 200 characters.';
  }
  if (!isStock(input.joistStock, 'lumber')) errors.joistStock = 'Choose the joist stock.';
  if (input.rimStock !== null && !isStock(input.rimStock, 'lumber')) {
    errors.rimStock = 'Choose the rim joist stock.';
  }
  if (input.subfloor !== null && !isStock(input.subfloor, 'sheet')) {
    errors.subfloor = 'Choose the subfloor sheets.';
  }
  if (taken.size >= MAX_TYPES)
    errors.floorType = `A document has at most ${MAX_TYPES} floor types.`;
  if (errors.typeName || errors.joistStock || errors.rimStock || errors.subfloor) return undefined;
  if (errors.floorType) return undefined;
  return {
    id: wallTypeId(name, taken),
    name,
    joistStock: input.joistStock,
    ...(input.rimStock !== null ? { rimStock: input.rimStock } : {}),
    ...(input.subfloor !== null ? { subfloor: input.subfloor } : {}),
  };
}

/** A new floor, or the edit of `existing`, from the form: one command (one undo step). */
export function buildFloor(
  form: FloorForm,
  ctx: {
    doc: ManufaktureDocument;
    partId: string;
    variables: Variables;
    existing?: ExtensionFeature | undefined;
  },
): FloorBuild {
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

  let type = stored.floorTypes.find((t) => t.id === form.floorType);
  let newType = false;
  if (form.floorType === '') {
    type = newFloorType(form.newType, new Set(stored.floorTypes.map((t) => t.id)), errors);
    newType = type !== undefined;
  } else if (!type) {
    errors.floorType = 'Choose a floor type.';
  }
  if (!stored.levels.some((l) => l.id === form.level)) errors.level = 'Choose a level.';

  // The outline.
  let dependsOn: string[] = [];
  let points: number | undefined;
  if (form.outline === 'walls') {
    const picked = new Set(form.walls);
    const walls = part.features.filter(isWall).filter((f) => picked.has(f.id));
    if (walls.length === 0) errors.walls = 'Pick the walls the floor goes under.';
    else if (walls.length > MAX_FLOOR_WALLS) {
      errors.walls = `A floor follows at most ${MAX_FLOOR_WALLS} walls.`;
    } else if (walls.some((w) => w.params.level !== form.level)) {
      errors.walls = "Pick walls on the floor's level.";
    }
    dependsOn = walls.map((w) => w.id);
  } else if (form.outline === 'points') {
    if (form.points.length < 4 || form.points.length > MAX_OUTLINE_POINTS) {
      errors.points = `An outline has 4 to ${MAX_OUTLINE_POINTS} points.`;
    } else {
      form.points.forEach((p, i) => {
        for (const [axis, text] of [
          ['x', p.x],
          ['y', p.y],
        ] as const) {
          const key = `${axis}${i + 1}`;
          if (text.trim() === '') errors[key] = 'Enter a coordinate.';
          else optionalLength(text, key, field, { sign: 'any' });
        }
      });
      points = form.points.length;
    }
    // Walls standing on the floor (kept from an edit) double the joists under them.
    if (ctx.existing)
      dependsOn = ctx.existing.dependsOn.filter((d) =>
        part.features.some((f) => f.id === d && isWall(f)),
      );
  } else {
    const sketch = part.features.find((f) => f.id === form.sketch && f.kind === 'sketch');
    if (!sketch) errors.sketch = 'Choose the sketch of the outline.';
    else dependsOn = [sketch.id];
  }

  if (form.joists === 'angle') {
    if (form.direction.trim() === '') errors.direction = "Enter the joists' direction in plan.";
    else optionalAngle(form.direction, 'direction', field);
  }
  optionalLength(form.spacing, 'spacing', field, {
    min: { value: MIN_SPACING, text: `${MIN_SPACING} mm` },
  });
  let skids: { stock: string; count: number } | undefined;
  if (form.skids) {
    if (!isStock(form.skidStock, 'lumber')) errors.skidStock = 'Choose the skid stock.';
    const count = countOf(form.skidCount, 1, MAX_SKIDS);
    if (count === undefined) errors.skidCount = `1 to ${MAX_SKIDS} skids.`;
    skids = { stock: form.skidStock, count: count ?? 1 };
    optionalLength(form.skidOverhang, 'skidOverhang', field, { sign: 'non-negative' });
  }

  const kept = keptOverrides(ctx.existing);
  const before = (ctx.existing?.params ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = {
    level: form.level,
    floorType: type?.id ?? form.floorType,
    outline: form.outline,
    ...(points !== undefined ? { points } : {}),
    ...(form.joists === 'long' ? { joists: 'long' } : {}),
    ...(form.blocking === 'mid-span' ? { blocking: 'mid-span' } : {}),
    ...(skids ? { skids } : {}),
    ...(before.doubleUnderWalls === false ? { doubleUnderWalls: false } : {}),
    ...kept.params,
  };
  Object.assign(expressions, kept.expressions);
  if (Object.keys(errors).length === 0) {
    const r = readFloorParams(params as never, FLOOR_SCHEMA_VERSION);
    if (!r.ok) errors.form = r.message;
  }
  if (Object.keys(errors).length > 0 || !type) return { ok: false, errors };

  const id = ctx.existing?.id ?? previewIds(part.nextIds, 'extension')[0]!;
  const name = ctx.existing?.name ?? newFeatureName(part, 'Floor', isFloor);
  const feature: ExtensionFeature = {
    id,
    kind: 'extension',
    name,
    suppressed: ctx.existing?.suppressed ?? false,
    extension: FLOOR_TYPE,
    schemaVersion: FLOOR_SCHEMA_VERSION,
    dependsOn,
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    // The subfloor is the floor's one layer body.
    ...(type.subfloor !== undefined ? { operation: 'new' as const } : {}),
  };
  const featureCommand: Command = ctx.existing
    ? { type: 'editFeature', partId, feature }
    : { type: 'addFeature', partId, feature };
  const label = `${ctx.existing ? 'Edit' : 'Add'} ${name}`;
  if (!newType) return { ok: true, feature, command: featureCommand, label };
  const r = settingsCommand(doc, { ...stored, floorTypes: [...stored.floorTypes, type] }, label, [
    featureCommand,
  ]);
  if (!r.ok) return { ok: false, errors: { form: r.message } };
  return { ok: true, feature, command: r.command ?? featureCommand, label };
}
