// The board tool's logic, free of React (M4 plan T4.1d): the form the Board dialog edits, where a
// new board starts, how a stored board fills it, and how a filled form becomes one core command.
// A board is a `wood.board` extension feature (ADR 0013 decision 2) whose params and expressions
// `@manufakture/domain-wood` validates; this module only gathers them, checks them with the
// domain's own reader, and adds the body's material from the stock.
//
// Stock labels show nominal and actual sizes in the document's display units. The picker opens on
// the region the display units suggest (inch and foot documents US stock, the rest metric); the
// other region is one click away, and nothing about the choice is stored.

import {
  findPart,
  isFeatureActive,
  previewIds,
  type BodyProps,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type Part,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import {
  BOARD_SCHEMA_VERSION,
  BOARD_TYPE,
  defaultRegion,
  findStock,
  readBoardParams,
  STOCK_NAMESPACE,
  translateBoard,
  type BoardMetadata,
  type BoardParams,
  type Json,
  type Justify,
  type StockData,
  type StockRegion,
} from '@manufakture/domain-wood';
import type { ProfileEntity, SketchProfile, Vec3 } from '@manufakture/kernel';
import type { ExtensionContext, JsonValue } from '@manufakture/regen';
import { checkExpression } from '../features/forms';
import { evaluateVariables, lengthFormat } from '../sketcher/values';
import { defaultStock } from './catalog';

export { BOARD_TYPE };
export { boardStockName, extensionLabel, isBoard } from './kinds';
export {
  REGION_LABELS,
  actualText,
  defaultStock,
  documentRegion,
  documentStock,
  sizeText,
  stockGroups,
  stockLabel,
} from './catalog';

// The form --------------------------------------------------------------------------------------

export type GrainChoice = 'longest' | 'line' | 'angle';

export interface BoardForm {
  form: BoardParams['form'];
  stock: string;
  sketch: string;
  /** Panel: the entities bounding the region; absent: the sketch's only region. */
  entities?: string[];
  grain: GrainChoice;
  /** Panel, grain along a line: the line's id. */
  grainLine: string;
  /** Panel, grain at an angle: the angle from the sketch's x axis, as typed. */
  grainAngle: string;
  flip: boolean;
  /** Stick: the line it runs along. */
  line: string;
  /** Stick, as typed; empty: none (or the line's length, the stock's width). */
  rotation: string;
  length: string;
  width: string;
  justifyThickness: Justify;
  justifyWidth: Justify;
}

/** Sketches a board at `before` may use: active sketches before it. */
export function boardSketches(part: Part, before: number): SketchFeature[] {
  return part.features
    .slice(0, before)
    .filter((f, i): f is SketchFeature => f.kind === 'sketch' && isFeatureActive(part, i));
}

/** The lines of a sketch, as a picker lists them (construction lines included). */
export function sketchLines(sketch: SketchFeature | undefined): { id: string; label: string }[] {
  return (sketch?.entities ?? [])
    .filter((e) => e.kind === 'line')
    .map((e) => ({ id: e.id, label: `Line ${e.id}${e.construction ? ' (construction)' : ''}` }));
}

/** Whether a sketch looks like a region (a panel) rather than a line (a stick). */
function looksLikeRegion(sketch: SketchFeature | undefined): boolean {
  const curves = (sketch?.entities ?? []).filter(
    (e) => !e.construction && e.kind !== 'point' && e.kind !== 'outline',
  );
  return curves.some((e) => e.kind === 'circle') || curves.length >= 3;
}

const barOf = (part: Part) => part.rollbackIndex ?? part.features.length;

/**
 * A new board's form: the last sketch before the rollback bar (or the one selected), a panel when
 * it looks like a region and a stick when it looks like a line, from the default stock of the
 * region the document's units suggest.
 */
export function newBoardForm(
  doc: ManufaktureDocument,
  partId: string,
  selectedFeatures: readonly string[] = [],
): BoardForm {
  const part = findPart(doc, partId)!;
  const sketches = boardSketches(part, barOf(part));
  const sketch =
    sketches.find((s) => selectedFeatures.includes(s.id)) ?? sketches[sketches.length - 1];
  const form: BoardParams['form'] = looksLikeRegion(sketch) || !sketch ? 'panel' : 'stick';
  return {
    form,
    stock: defaultStock(defaultRegion(lengthFormat(doc.units)), form),
    sketch: sketch?.id ?? '',
    grain: 'longest',
    grainLine: sketchLines(sketch)[0]?.id ?? '',
    grainAngle: '0',
    flip: false,
    line: sketchLines(sketch)[0]?.id ?? '',
    rotation: '',
    length: '',
    width: '',
    justifyThickness: 'centre',
    justifyWidth: 'centre',
  };
}

const text = (e: StoredExpression | undefined) => e?.source ?? '';

/**
 * The form of a stored board, or the domain's message when its params cannot be read (a newer
 * schema version, or params this build refuses): such a board has no edit dialog (ADR 0013
 * decision 4).
 */
export function boardFormOf(
  feature: ExtensionFeature,
): { ok: true; form: BoardForm } | { ok: false; message: string } {
  const r = readBoardParams(feature.params as Json, feature.schemaVersion);
  if (!r.ok) return { ok: false, message: r.message };
  const p = r.value;
  const x = feature.expressions;
  const base = {
    stock: p.stock,
    sketch: p.sketch,
    grain: 'longest' as GrainChoice,
    grainLine: '',
    grainAngle: '0',
    flip: false,
    line: '',
    rotation: '',
    length: '',
    width: '',
    justifyThickness: 'centre' as Justify,
    justifyWidth: 'centre' as Justify,
  };
  if (p.form === 'panel') {
    return {
      ok: true,
      form: {
        ...base,
        form: 'panel',
        ...(p.entities ? { entities: [...p.entities] } : {}),
        grain: p.grain.type,
        grainLine: p.grain.type === 'line' ? p.grain.entity : '',
        grainAngle: text(x.grainAngle) || '0',
        flip: p.flip,
      },
    };
  }
  return {
    ok: true,
    form: {
      ...base,
      form: 'stick',
      line: p.line,
      rotation: text(x.rotation),
      length: text(x.length),
      width: text(x.width),
      justifyThickness: p.justify.thickness,
      justifyWidth: p.justify.width,
    },
  };
}

/** The form after choosing another form (panel or stick): the stock follows when it must. */
export function withForm(f: BoardForm, form: BoardParams['form'], region: StockRegion): BoardForm {
  const entry = findStock(f.stock);
  const fits = form === 'panel' || entry?.kind === 'lumber';
  return {
    ...f,
    form,
    stock: fits ? f.stock : defaultStock(entry?.region ?? region, form),
  };
}

export type BoardBuild =
  | { ok: true; feature: ExtensionFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

/** The form field a domain error path points at. */
function fieldOf(path: readonly (string | number)[] | undefined): string {
  if (!path || path.length === 0) return 'form';
  const [a, b] = path[0] === 'params' || path[0] === 'expressions' ? path.slice(1) : path;
  if (a === 'grain') return b === 'entity' ? 'grainLine' : 'grain';
  if (a === 'justify') return b === 'width' ? 'justifyWidth' : 'justifyThickness';
  return typeof a === 'string' ? a : 'form';
}

/**
 * Turn a filled form into the board and the command that adds it at the rollback bar (with the
 * body's material from the stock) or replaces `existing` (the material follows a new stock unless
 * the user set another).
 */
export function buildBoard(
  form: BoardForm,
  ctx: { doc: ManufaktureDocument; partId: string; existing?: ExtensionFeature },
): BoardBuild {
  const part = findPart(ctx.doc, ctx.partId);
  if (!part) return { ok: false, errors: { form: `There is no part ${ctx.partId}.` } };
  const units = ctx.doc.units;
  const variables = evaluateVariables(ctx.doc);
  const errors: Record<string, string> = {};
  const expressions: Record<string, StoredExpression> = {};
  const expr = (
    field: string,
    source: string,
    kind: 'length' | 'angle',
    options: { positive?: boolean } = {},
  ) => {
    const r = checkExpression(source, kind, units, variables, options);
    if (r.ok) expressions[field] = r.expression;
    else errors[field] = r.message;
  };

  const existing = ctx.existing;
  const id = existing?.id ?? previewIds(part.nextIds, 'extension')[0]!;
  const name = existing?.name ?? `Board ${id.slice(id.indexOf('#') + 1)}`;
  const index = existing ? part.features.findIndex((f) => f.id === existing.id) : barOf(part);
  const sketch = boardSketches(part, index).find((s) => s.id === form.sketch);
  if (!sketch) {
    const later = part.features.find((f) => f.id === form.sketch);
    errors.sketch = later ? `${later.name} comes after this board.` : 'Choose a sketch.';
  }
  const entry = findStock(form.stock);
  if (!entry) errors.stock = 'Choose a stock.';
  else if (form.form === 'stick' && entry.kind === 'sheet') {
    errors.stock = `${entry.name} is sheet stock: a stick is cut from lumber.`;
  }
  const lines = new Set(sketchLines(sketch).map((l) => l.id));

  let params: Record<string, JsonValue>;
  if (form.form === 'panel') {
    params = { form: 'panel', stock: form.stock, sketch: form.sketch };
    if (form.entities && form.entities.length > 0) params.entities = [...form.entities];
    if (form.grain === 'line') {
      if (sketch && !lines.has(form.grainLine)) errors.grainLine = 'Choose a line of the sketch.';
      params.grain = { type: 'line', entity: form.grainLine };
    } else if (form.grain === 'angle') {
      params.grain = { type: 'angle' };
      expr('grainAngle', form.grainAngle, 'angle');
    }
    if (form.flip) params.flip = true;
  } else {
    if (sketch && !lines.has(form.line)) {
      errors.line =
        lines.size > 0 ? 'Choose a line of the sketch.' : `${sketch.name} has no lines.`;
    }
    params = { form: 'stick', stock: form.stock, sketch: form.sketch, line: form.line };
    if (form.justifyThickness !== 'centre' || form.justifyWidth !== 'centre') {
      params.justify = { thickness: form.justifyThickness, width: form.justifyWidth };
    }
    if (form.rotation.trim() !== '') expr('rotation', form.rotation, 'angle');
    if (form.length.trim() !== '') expr('length', form.length, 'length', { positive: true });
    if (form.width.trim() !== '') expr('width', form.width, 'length', { positive: true });
    else if (entry && entry.kind === 'lumber' && entry.actual.width === undefined) {
      errors.width = `${entry.name} is sold in random widths: give the board a width.`;
    }
  }
  if (Object.keys(errors).length === 0) {
    // The domain's own check, so the dialog refuses exactly what regen would.
    const r = readBoardParams(params as Json, BOARD_SCHEMA_VERSION);
    if (!r.ok) errors[fieldOf(r.field)] = r.message;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const feature: ExtensionFeature = {
    id,
    kind: 'extension',
    name,
    suppressed: existing?.suppressed ?? false,
    extension: BOARD_TYPE,
    schemaVersion: BOARD_SCHEMA_VERSION,
    operation: 'new',
    dependsOn: [form.sketch],
    references: [],
    expressions,
    params,
  };
  const material = materialCommand(part, ctx.partId, feature, existing);
  const main: Command = existing
    ? { type: 'editFeature', partId: ctx.partId, feature }
    : { type: 'addFeature', partId: ctx.partId, feature };
  return {
    ok: true,
    feature,
    command: material ? { type: 'batch', commands: [main, material] } : main,
    label: `${existing ? 'Edit' : 'Add'} ${name}`,
  };
}

/**
 * The `setBodyProps` that gives a board's body its stock's material: always for a new board; for
 * an edited one only when the stock changed and the body is still made of the old stock's
 * material (or of nothing), so a material the user chose is kept.
 */
function materialCommand(
  part: Part,
  partId: string,
  feature: ExtensionFeature,
  existing: ExtensionFeature | undefined,
): Command | null {
  const stock = findStock(String(feature.params.stock));
  if (!stock) return null;
  const props: BodyProps | undefined = part.bodies.find((b) => b.id === feature.id);
  if (existing) {
    const before = findStock(String(existing.params.stock));
    if (before?.id === stock.id) return null;
    if (props?.material !== undefined && props.material !== before?.material) return null;
  }
  if (props?.material === stock.material) return null;
  const { id: _id, ...fields } = props ?? { id: feature.id };
  void _id;
  return {
    type: 'setBodyProps',
    partId,
    bodyId: feature.id,
    props: { ...fields, material: stock.material },
  };
}

// The preview ------------------------------------------------------------------------------------

/** A sketch's placement, as regen solved it (`FeatureResult.placement`). */
export interface Placement {
  origin: Vec3;
  normal: Vec3;
  xDir: Vec3;
}

/**
 * The board frame the form would build, computed on the main thread with the domain's own
 * translator from the sketch as stored and the placement regen last solved it at: what the dialog
 * draws while it is open, before anything is applied. Null when the form cannot be built yet.
 * A panel's region is taken as every curve it names (or every curve of the sketch), which is
 * the region regen finds for a sketch of one region; regen remains the judge of the rest.
 */
export function previewFrame(
  form: BoardForm,
  ctx: {
    doc: ManufaktureDocument;
    partId: string;
    placement: Placement | undefined;
    stock?: StockData | undefined;
  },
): BoardMetadata['frame'] | null {
  if (!ctx.placement) return null;
  const sketch = findPart(ctx.doc, ctx.partId)?.features.find(
    (f): f is SketchFeature => f.id === form.sketch && f.kind === 'sketch',
  );
  if (!sketch) return null;
  const built = buildBoard(form, { doc: ctx.doc, partId: ctx.partId });
  // A preview of an edited board is built as a new one; only the frame matters here.
  if (!built.ok) return null;
  const units = ctx.doc.units;
  const variables = evaluateVariables(ctx.doc);
  const values: Record<string, number> = {};
  for (const [k, e] of Object.entries(built.feature.expressions)) {
    const kind = k === 'length' || k === 'width' ? 'length' : 'angle';
    const r = checkExpression(e.source, kind, units, variables);
    if (!r.ok) return null;
    values[k] = r.value;
  }
  const params = readBoardParams(built.feature.params as Json, BOARD_SCHEMA_VERSION);
  if (!params.ok) return null;
  const curves = sketch.entities.flatMap((e): ProfileEntity[] => {
    if (e.construction || (form.entities && !form.entities.includes(e.id))) return [];
    if (e.kind === 'line') return [{ id: e.id, kind: 'line', start: e.start, end: e.end }];
    if (e.kind === 'circle') {
      return [{ id: e.id, kind: 'circle', center: e.center, radius: e.radius }];
    }
    if (e.kind === 'arc') {
      return [{ id: e.id, kind: 'arc', center: e.center, start: e.start, end: e.end }];
    }
    return [];
  });
  const profile: SketchProfile = { frame: ctx.placement, loops: [{ entities: curves }] };
  const context = {
    feature: built.feature,
    params: params.value,
    values,
    references: {},
    data: ctx.stock ? { [STOCK_NAMESPACE]: ctx.stock } : {},
    sketches: new Map([[sketch.id, { placement: ctx.placement, entities: sketch.entities }]]),
    upstream: new Map(),
    bodies: [],
    profile: () =>
      curves.length > 0 ? { ok: true, value: profile } : { ok: false, message: 'no region' },
  } as unknown as ExtensionContext<BoardParams>;
  try {
    const out = translateBoard(context);
    if ('error' in out) return null;
    return (out.metadata as unknown as BoardMetadata).frame;
  } catch {
    return null;
  }
}

// Lines to draw -----------------------------------------------------------------------------------

const add = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[0]! + b[0]!,
  a[1]! + b[1]!,
  a[2]! + b[2]!,
];
const scale = (a: readonly number[], s: number): Vec3 => [a[0]! * s, a[1]! * s, a[2]! * s];

/** A point of a frame's blank at fractions (length, width, thickness) of its size. */
function at(frame: BoardMetadata['frame'], l: number, w: number, t: number, lift = 0): Vec3 {
  const { origin, axes, size } = frame;
  return add(
    origin,
    add(
      scale(axes.length, l * size.length),
      add(scale(axes.width, w * size.width), scale(axes.thickness, t * size.thickness + lift)),
    ),
  );
}

/** How far a grain arrow stands off its face, mm, so the face's facets never hide it. */
const STANDOFF = 0.05;

/**
 * The grain arrow of a board, on both of its broad faces: a line along the grain over the middle
 * of the board's length, with a head at its far end, each a polyline in world coordinates.
 */
export function grainArrows(frame: BoardMetadata['frame']): Vec3[][] {
  const { size } = frame;
  if (!(size.length > 0) || !(size.width > 0)) return [];
  // The head's size: a fifth of the board's width, at most a tenth of its length.
  const head = Math.min(0.2 * size.width, 0.1 * size.length);
  const hl = head / size.length;
  const hw = head / size.width / 2;
  const out: Vec3[][] = [];
  for (const [t, lift] of [
    [0, -STANDOFF],
    [1, STANDOFF],
  ] as const) {
    out.push([at(frame, 0.2, 0.5, t, lift), at(frame, 0.8, 0.5, t, lift)]);
    out.push([
      at(frame, 0.8 - hl, 0.5 - hw, t, lift),
      at(frame, 0.8, 0.5, t, lift),
      at(frame, 0.8 - hl, 0.5 + hw, t, lift),
    ]);
  }
  return out;
}

/** The twelve edges of a frame's blank, as polylines: the dialog's preview of the board. */
export function blankEdges(frame: BoardMetadata['frame']): Vec3[][] {
  const c = (l: number, w: number, t: number) => at(frame, l, w, t);
  const ring = (t: number) => [c(0, 0, t), c(1, 0, t), c(1, 1, t), c(0, 1, t), c(0, 0, t)];
  return [
    ring(0),
    ring(1),
    [c(0, 0, 0), c(0, 0, 1)],
    [c(1, 0, 0), c(1, 0, 1)],
    [c(1, 1, 0), c(1, 1, 1)],
    [c(0, 1, 0), c(0, 1, 1)],
  ];
}
