// A construction drawing set (M6 plan T6.4b; shared since #1219): the sheets of a building's
// drawing set, made in one command in a drawing. A plan of each level with walls (three
// dimension strings outside each wall), the four building elevations (ordinary part views of the
// layer bodies), a framing elevation of every wall segment (a sheet per wall) and a roof framing
// plan per roof, each at the largest architectural scale (or metric scale, for a metric
// document) that fits its place on the sheet, unless the caller picked one. With `wall`, only
// that wall's framing elevation sheet (or, with `segment` too, one segment's view).
//
// The app's "New construction set" button and the session's `addConstructionSet` helper both
// make their commands here, so a set made by an agent is the set the button makes.
//
// Nothing is drawn here. Views are placed from the walls' stored coordinates, evaluated with the
// document's variables, so making a set for a large house costs no regen work: each sheet is drawn
// when it is shown or exported (M4 decision 8), as any sheet is. A wall whose coordinates do not
// evaluate is left out of the extents (its views are still made, at the other walls' scale).
//
// Bounds: a set has at most `MAX_SET_SHEETS` sheets and `MAX_SET_VIEWS` views, checked before
// anything is built; every loop is over the part's features or a wall's points (at most 64).

import {
  SHEET_COUNTER,
  SHEET_SIZE_MM,
  STANDARD_VIEWS,
  VIEW_COUNTER,
  measurementLookup,
  previewIds,
  storedExpression,
  variableOrder,
  type Command,
  type DisplayUnits,
  type Drawing,
  type DrawingView,
  type ExtensionFeature,
  type Feature,
  type ManufaktureDocument,
  type Measurement,
  type Sheet,
  type SheetSize,
  type StandardViewName,
  type StoredExpression,
  type TitleBlock,
  type ViewDirection,
  type ViewScale,
} from '@manufakture/core';
import { evaluate, evaluateQuantity, type Quantity } from '@manufakture/units';
import { CONSTRUCTION_NAMESPACE, documentConstruction } from '../data';
import { MAX_WALL_POINTS, WALL_TYPE } from '../features/common';
import { ROOF_TYPE } from '../features/roof';
import { readWallParams } from '../features/wall';
import { VIEW_PARAMS_VERSION } from './params';

export const MAX_SET_SHEETS = 200;
export const MAX_SET_VIEWS = 1_000;
/** The longest sheet name or view label the set writes (core allows more). */
export const MAX_SET_NAME = 100;
/** The title block a set's sheets get when there is no sheet to copy one from: the app's. */
export const SET_TITLE_FIELDS = ['Title', 'Drawn by', 'Date', 'Material'] as const;

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

/** The document's variables by name, evaluated (those that do not evaluate are left out). */
export type SetVariables = Readonly<Record<string, Quantity>>;

/** An architectural scale: inches on paper per foot, as typed (`1/4" = 1'`). */
export const IMPERIAL_SET_SCALES = [
  `1/2" = 1'`,
  `3/8" = 1'`,
  `1/4" = 1'`,
  `3/16" = 1'`,
  `1/8" = 1'`,
  `3/32" = 1'`,
  `1/16" = 1'`,
] as const;
export const METRIC_SET_SCALES = ['1:20', '1:25', '1:50', '1:100', '1:200', '1:500'] as const;

/** Paper mm per model mm of a scale as the set writes it. */
export function setScaleFactor(text: string): number {
  const imperial = /^(\d+)\/(\d+)" = 1'$/.exec(text);
  if (imperial) return Number(imperial[1]) / Number(imperial[2]) / 12;
  const metric = /^1:(\d+)$/.exec(text);
  if (metric) return 1 / Number(metric[1]);
  return NaN;
}

/** The scales offered for a document: architectural for imperial units, else metric. */
export function setScales(units: DisplayUnits): readonly string[] {
  const u = units.length.unit;
  return u === 'ft-in' || u === 'in-fraction' || u === 'in' || u === 'ft'
    ? IMPERIAL_SET_SCALES
    : METRIC_SET_SCALES;
}

export interface SetOptions {
  part: string;
  size: SheetSize;
  orientation: Sheet['orientation'];
  /** A scale from `setScales`, or `auto`: the largest that fits. Plans and building elevations. */
  planScale: string;
  /** The same for framing elevations and roof framing plans. */
  framingScale: string;
  /** Only this wall's framing elevation sheet: no plans, building elevations or roof plans. */
  wall?: string;
  /** With `wall`: only this segment's view (1-based). */
  segment?: number;
}

/** How a caller fills in what the set does not decide itself. */
export interface SetContext {
  /** The document's variables (default: `setVariables(doc)`, with no measurements). */
  variables?: SetVariables;
  /** Ids for `n` new sheets and views of the drawing (default: the drawing's next ids). */
  ids?: { sheets: (n: number) => string[]; views: (n: number) => string[] };
  /** The labels of a title block made from scratch (default `SET_TITLE_FIELDS`). */
  titleFields?: readonly string[];
  /**
   * The most commands the set may become (its sheets, views and a `deleteSheet`), checked as soon
   * as its sheets are planned, before any sheet or view is built: past it the answer is
   * `tooMany`. Absent: no budget beyond `MAX_SET_SHEETS` and `MAX_SET_VIEWS`.
   */
  budget?: number;
  /** The part's building, already read (`buildingOf` with the same variables), to read it once. */
  building?: ReturnType<typeof buildingOf>;
}

/** A wall as the set lays it out: its plan points (null where they do not evaluate). */
export interface SetWall {
  id: string;
  name: string;
  level: string;
  points: Vec2[] | null;
  segments: number;
  base: number;
  top: number;
}

export interface Building {
  walls: SetWall[];
  /** Each roof, with its pitch in radians when it evaluates. */
  roofs: { id: string; name: string; pitch: number | null }[];
  levels: { id: string; name: string; elevation: number; height: number }[];
  /**
   * Worked out once when the building is read, so a set of one wall costs only that wall: the
   * walls by id, the box of the walls raised by the roofs (`all`) and without them (`flat`), and
   * what the roofs add above the walls (`rise`, for the gable studs a framing elevation shows).
   */
  byId: ReadonlyMap<string, SetWall>;
  all: Box | null;
  flat: Box | null;
  rise: number;
}

/**
 * `s` cut to `MAX_SET_NAME` code points (never inside a surrogate pair), with `...` when cut.
 * Names come from the document, whose names core bounds, so the scan is short.
 */
export function clipSetName(s: string): string {
  const points = Array.from(s);
  return points.length > MAX_SET_NAME ? `${points.slice(0, MAX_SET_NAME - 3).join('')}...` : s;
}
const clip = clipSetName;

// The literal extension types keep a false check from narrowing other extensions away.
type WallFeature = ExtensionFeature & { extension: typeof WALL_TYPE };
type RoofFeature = ExtensionFeature & { extension: typeof ROOF_TYPE };
const isWall = (f: Feature): f is WallFeature =>
  f.kind === 'extension' && f.extension === WALL_TYPE;
const isRoof = (f: Feature): f is RoofFeature =>
  f.kind === 'extension' && f.extension === ROOF_TYPE;

/** Whether the document has a part studio a construction set can draw. */
export function canMakeSet(doc: ManufaktureDocument): boolean {
  return doc.parts.some((p) => p.features.some(isWall));
}

/**
 * The document's variables, evaluated in dependency order. A variable that fails to evaluate is
 * left out; one that measures the model reads `measurements` (a regen's).
 */
export function setVariables(
  doc: ManufaktureDocument,
  measurements: readonly Measurement[] = [],
): SetVariables {
  const out: Record<string, Quantity> = {};
  const order = variableOrder(doc.variables);
  if (!order.ok) return out;
  const measure = measurementLookup(measurements);
  const byName = new Map(doc.variables.map((v) => [v.name, v]));
  for (const name of order.value) {
    const v = byName.get(name);
    if (!v) continue;
    const r = evaluateQuantity(v.expression.source, {
      lengthUnit: v.expression.lengthUnit,
      angleUnit: v.expression.angleUnit,
      variables: (n) => out[n],
      measure,
    });
    if (r.ok) out[name] = r.value;
  }
  return out;
}

function lengthOf(e: StoredExpression | undefined, variables: SetVariables): number | null {
  if (e === undefined) return null;
  const r = evaluate(e.source, {
    expected: 'length',
    lengthUnit: e.lengthUnit,
    angleUnit: e.angleUnit,
    variables: (n) => variables[n],
  });
  return r.ok ? r.value : null;
}

/**
 * What `buildingOf` reads from the whole document, read once (`setReads`) when a caller builds
 * several sets from one document: the construction settings (which may be large: every level's
 * expressions are evaluated) and the part studios by id.
 */
export interface SetReads {
  construction: ReturnType<typeof documentConstruction>;
  parts: ReadonlyMap<string, ManufaktureDocument['parts'][number]>;
}

/** The document's reads for `buildingOf`, done once. */
export function setReads(doc: ManufaktureDocument): SetReads {
  return {
    construction: documentConstruction(doc),
    parts: new Map(doc.parts.map((p) => [p.id, p])),
  };
}

/** The part's walls and roofs, as stored, with their coordinates evaluated. */
export function buildingOf(
  doc: ManufaktureDocument,
  partId: string,
  variables: SetVariables = setVariables(doc),
  reads?: SetReads,
): { ok: true; building: Building } | { ok: false; message: string } {
  const part = reads ? reads.parts.get(partId) : doc.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, message: `There is no part studio ${partId}.` };
  const data = reads ? reads.construction : documentConstruction(doc);
  if (!data.ok)
    return { ok: false, message: `The construction settings cannot be read: ${data.message}` };
  const levels = (data.data?.settings.levels ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    elevation: l.elevation,
    height: l.height,
  }));
  const walls: SetWall[] = [];
  const roofs: Building['roofs'] = [];
  for (const f of part.features) {
    if (f.suppressed) continue;
    if (isRoof(f)) {
      const e = f.expressions.pitch;
      const r =
        e === undefined
          ? null
          : evaluate(e.source, {
              expected: 'angle',
              slope: true,
              lengthUnit: e.lengthUnit,
              angleUnit: e.angleUnit,
              variables: (n) => variables[n],
            });
      const pitch = r?.ok && r.value > 0 && r.value < Math.PI / 2 ? r.value : null;
      roofs.push({ id: f.id, name: f.name, pitch });
      continue;
    }
    if (!isWall(f)) continue;
    const params = readWallParams(f.params as never, f.schemaVersion);
    if (!params.ok) continue;
    const p = params.value;
    const level = levels.find((l) => l.id === p.level);
    const n = Math.min(p.points, MAX_WALL_POINTS);
    const length = (key: string) => lengthOf(f.expressions[key], variables);
    let points: Vec2[] | null = [];
    for (let i = 1; i <= n && points; i++) {
      const x = length(`x${i}`);
      const y = length(`y${i}`);
      points = x === null || y === null ? null : [...points, [x, y]];
    }
    const base = level?.elevation ?? 0;
    const height = length('height') ?? level?.height ?? 0;
    walls.push({
      id: f.id,
      name: f.name,
      level: p.level,
      points,
      segments: Math.max(1, p.closed ? n : n - 1),
      base,
      top: base + height,
    });
  }
  if (walls.length === 0) {
    return { ok: false, message: 'This part studio has no walls to draw.' };
  }
  const all = buildingBox(walls, roofs);
  const flat = buildingBox(walls, []);
  const rise = all && flat ? all.max[2] - flat.max[2] : 0;
  const byId = new Map(walls.map((w) => [w.id, w]));
  return { ok: true, building: { walls, roofs, levels, byId, all, flat, rise } };
}

/** A box in model space, mm. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

function boxOf(points: readonly Vec3[]): Box | null {
  if (points.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

/** A roof's stack above the plate the set allows for (rafter depth, ridge, sheathing), mm. */
const ROOF_STACK = 300;

/**
 * The walls' box, raised by the roofs' height: a gable over the narrower plan side at the
 * steepest roof's pitch (12/12 when a pitch does not evaluate), plus `ROOF_STACK`.
 */
function buildingBox(
  walls: readonly SetWall[],
  roofs: readonly Building['roofs'][number][],
): Box | null {
  const pts: Vec3[] = [];
  for (const w of walls)
    for (const p of w.points ?? []) pts.push([p[0], p[1], w.base], [p[0], p[1], w.top]);
  const box = boxOf(pts);
  if (!box || roofs.length === 0) return box;
  const slope = Math.max(...roofs.map((r) => (r.pitch === null ? 1 : Math.tan(r.pitch))));
  const rise =
    (Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2) * slope + ROOF_STACK;
  return { min: box.min, max: [box.max[0], box.max[1], box.max[2] + rise] };
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit3 = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : a;
};

/** The view's frame, as regen's `viewFrame` makes it: x right, y up on paper, z to the viewer. */
function frameOf(direction: ViewDirection): { x: Vec3; y: Vec3; z: Vec3 } {
  const v = typeof direction === 'string' ? STANDARD_VIEWS[direction] : direction;
  const z = unit3(sub3([0, 0, 0], v.direction));
  const x = unit3(cross3(unit3(v.up), z));
  return { x, y: cross3(z, x), z };
}

/** The extent of a box seen in a view, in view coordinates. */
function viewExtent(box: Box, direction: ViewDirection): { min: Vec2; max: Vec2 } {
  const f = frameOf(direction);
  let lo: [number, number] = [Infinity, Infinity];
  let hi: [number, number] = [-Infinity, -Infinity];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const u = x * f.x[0] + y * f.x[1] + z * f.x[2];
        const v = x * f.y[0] + y * f.y[1] + z * f.y[2];
        lo = [Math.min(lo[0], u), Math.min(lo[1], v)];
        hi = [Math.max(hi[0], u), Math.max(hi[1], v)];
      }
  return { min: lo, max: hi };
}

/** A sheet's paper size and the region views go in: clear of the frame and the title block. */
export function sheetRegion(
  size: SheetSize,
  orientation: Sheet['orientation'],
): { width: number; height: number; region: { min: Vec2; max: Vec2 } } {
  const [short, long] = typeof size === 'string' ? SHEET_SIZE_MM[size] : [279.4, 431.8];
  const width = orientation === 'landscape' ? long : short;
  const height = orientation === 'landscape' ? short : long;
  // The title block (about 50 mm tall with the disclaimer) sits along the bottom.
  return { width, height, region: { min: [15, 65], max: [width - 15, height - 15] } };
}

/** Paper mm each view keeps clear round its model extent: strings, labels. */
const MARGIN = { plan: 52, elevation: 12, framing: 28, roof: 24 } as const;

/** The largest scale of `scales` at which `extent` plus `margin` fits a `slot`; else the smallest. */
export function fitScale(
  extent: { min: Vec2; max: Vec2 },
  slot: { width: number; height: number },
  margin: number,
  scales: readonly string[],
): string {
  const w = extent.max[0] - extent.min[0];
  const h = extent.max[1] - extent.min[1];
  for (const s of scales) {
    const f = setScaleFactor(s);
    if (w * f + 2 * margin <= slot.width && h * f + 2 * margin <= slot.height) return s;
  }
  return scales[scales.length - 1]!;
}

/** A view of a set, before it is placed on paper. */
export interface PlannedView {
  direction: ViewDirection;
  source: DrawingView['source'];
  /**
   * A caption under the view. Construction views have none: the sheet's name says what each is
   * (a wall's segments in order, row by row), and a caption under a view would sit on its strings.
   */
  label?: string;
  extent: { min: Vec2; max: Vec2 } | null;
  margin: number;
}

/** A sheet of a set, before it is placed on paper. */
export interface PlannedSheet {
  name: string;
  views: PlannedView[];
  /** The scale chosen for this kind of sheet, or `auto`. */
  scale: string;
}

const domainSource = (part: string, params: Record<string, unknown>): DrawingView['source'] => ({
  domain: CONSTRUCTION_NAMESPACE,
  part,
  schemaVersion: VIEW_PARAMS_VERSION,
  params: params as Record<string, never>,
});

/**
 * The framing elevation views of a wall: one per segment (or only `segment`), each seen from
 * outside (looking along the interior normal, left of the path), its extent the segment from
 * the wall's base to its top plus `rise` (what a roof adds above the walls, for gable studs).
 * The view params are `{ kind: 'elevation', wall, segment }`: whatever else an elevation shows
 * is a param of the view, added here for every view of the set.
 */
export function framingElevationViews(
  part: string,
  wall: SetWall,
  rise: number,
  segment?: number,
): PlannedView[] {
  const views: PlannedView[] = [];
  for (let s = 1; s <= Math.min(wall.segments, MAX_WALL_POINTS); s++) {
    if (segment !== undefined && s !== segment) continue;
    const pts = wall.points;
    const a = pts?.[s - 1];
    const c = pts?.[s % pts.length];
    let direction: ViewDirection = 'front';
    let extent: PlannedView['extent'] = null;
    if (a && c) {
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len > 0) {
        const d = [(c[0] - a[0]) / len, (c[1] - a[1]) / len] as const;
        direction = { direction: [-d[1], d[0], 0], up: [0, 0, 1] };
        const box = boxOf([
          [a[0], a[1], wall.base],
          [c[0], c[1], wall.top + rise],
        ]);
        extent = box ? viewExtent(box, direction) : null;
      }
    }
    views.push({
      direction,
      source: domainSource(part, { kind: 'elevation', wall: wall.id, segment: s }),
      extent,
      margin: MARGIN.framing,
    });
  }
  return views;
}

/** The framing elevation sheet of a wall: its views (`framingElevationViews`) on one sheet. */
function framingSheet(
  part: string,
  wall: SetWall,
  rise: number,
  scale: string,
  segment?: number,
): PlannedSheet {
  return {
    name: clip(`Framing: ${wall.name}`),
    scale,
    views: framingElevationViews(part, wall, rise, segment),
  };
}

/** The sheets of a set, before they are placed on paper. */
export function planSheets(b: Building, options: SetOptions): PlannedSheet[] {
  const sheets: PlannedSheet[] = [];
  const { all, flat, rise } = b;
  if (options.wall !== undefined) {
    const w = b.byId.get(options.wall);
    return w ? [framingSheet(options.part, w, rise, options.framingScale, options.segment)] : [];
  }
  const TOP: ViewDirection = 'top';
  // A plan of each level with walls, in the settings' order.
  for (const level of b.levels) {
    const on = b.walls.filter((w) => w.level === level.id);
    if (on.length === 0) continue;
    const box = buildingBox(on, []);
    sheets.push({
      name: clip(`Plan: ${level.name}`),
      scale: options.planScale,
      views: [
        {
          direction: TOP,
          source: domainSource(options.part, {
            kind: 'plan',
            level: level.id,
            strings: 'architectural',
          }),
          extent: box ? viewExtent(box, TOP) : null,
          margin: MARGIN.plan,
        },
      ],
    });
  }
  // The four building elevations: hidden-line drawings of the layer bodies.
  const sides: [StandardViewName, string][] = [
    ['front', 'Front elevation'],
    ['right', 'Right elevation'],
    ['back', 'Back elevation'],
    ['left', 'Left elevation'],
  ];
  sheets.push({
    name: 'Elevations',
    scale: options.planScale,
    views: sides.map(([direction, label]) => ({
      direction,
      source: { part: options.part },
      label,
      extent: all ? viewExtent(all, direction) : null,
      margin: MARGIN.elevation,
    })),
  });
  // A framing elevation of each wall segment, seen from outside: a sheet per wall.
  for (const w of b.walls) sheets.push(framingSheet(options.part, w, rise, options.framingScale));
  // A roof framing plan per roof, over the building and its overhangs.
  // Overhangs: two feet each way covers the usual ones.
  const OVER = 610;
  const grown: Box | null = flat
    ? {
        min: [flat.min[0] - OVER, flat.min[1] - OVER, flat.min[2]],
        max: [flat.max[0] + OVER, flat.max[1] + OVER, flat.max[2]],
      }
    : null;
  for (const r of b.roofs) {
    sheets.push({
      name: clip(`Roof framing: ${r.name}`),
      scale: options.framingScale,
      views: [
        {
          direction: TOP,
          source: domainSource(options.part, { kind: 'roof-plan', roof: r.id }),
          extent: grown ? viewExtent(grown, TOP) : null,
          margin: MARGIN.roof,
        },
      ],
    });
  }
  return sheets;
}

/** Slots for `n` views in a region: a grid as square as the count allows, row by row from the top. */
function slots(
  n: number,
  region: { min: Vec2; max: Vec2 },
): { centre: Vec2; width: number; height: number }[] {
  const cols = n <= 1 ? 1 : n <= 2 ? 1 : n <= 4 ? 2 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const width = (region.max[0] - region.min[0]) / cols;
  const height = (region.max[1] - region.min[1]) / rows;
  const out: { centre: Vec2; width: number; height: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({
      centre: [region.min[0] + width * (c + 0.5), region.max[1] - height * (r + 0.5)],
      width,
      height,
    });
  }
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;

export interface SetCommand {
  command: Command;
  label: string;
  /** The new sheets' ids, in order. */
  sheetIds: string[];
}

/** Why `options.wall` and `options.segment` do not name a wall's segment of the building, or null. */
function wallProblem(b: Building, options: SetOptions): string | null {
  if (options.wall === undefined) {
    return options.segment === undefined ? null : 'A segment is given with its wall.';
  }
  const w = b.byId.get(options.wall);
  if (!w) return `There is no wall ${options.wall} in part studio ${options.part}.`;
  const s = options.segment;
  if (s !== undefined && (!Number.isInteger(s) || s < 1 || s > w.segments)) {
    return `${w.name} has segments 1 to ${w.segments}; there is no segment ${s}.`;
  }
  return null;
}

/**
 * The command that adds a construction set's sheets to `drawing` (one undo step), or with
 * `options.wall` one wall's framing elevation sheet. The drawing's only sheet, when it is still
 * empty (a drawing just made), gives way to the set. `like` gives the sheets' title block.
 */
export function constructionSetCommand(
  doc: ManufaktureDocument,
  drawing: Drawing,
  like: Sheet | undefined,
  options: SetOptions,
  context: SetContext = {},
): ({ ok: true } & SetCommand) | { ok: false; message: string; tooMany?: true } {
  const b = context.building ?? buildingOf(doc, options.part, context.variables);
  if (!b.ok) return b;
  const problem = wallProblem(b.building, options);
  if (problem !== null) return { ok: false, message: problem };
  const planned = planSheets(b.building, options);
  const views = planned.reduce((n, s) => n + s.views.length, 0);
  // The drawing's only sheet gives way to the set when it is still empty (a drawing just made).
  const only = drawing.sheets.length === 1 ? drawing.sheets[0]! : undefined;
  const replacesOnly =
    only !== undefined &&
    only.views.length === 0 &&
    only.dimensions.length === 0 &&
    only.notes.length === 0;
  // Its commands: a sheet and its views each, and the empty sheet's removal when there is one.
  const commandCount = planned.length + views + (replacesOnly ? 1 : 0);
  if (context.budget !== undefined && commandCount > context.budget) {
    return {
      ok: false,
      tooMany: true,
      message: `This set makes ${planned.length} sheets and ${views} views, more commands than the ${Math.max(0, context.budget)} left in the batch.`,
    };
  }
  if (planned.length > MAX_SET_SHEETS || views > MAX_SET_VIEWS) {
    return {
      ok: false,
      message: `A construction set makes at most ${MAX_SET_SHEETS} sheets and ${MAX_SET_VIEWS} views; this building needs ${planned.length} and ${views}.`,
    };
  }
  const scales = setScales(doc.units);
  for (const s of [options.planScale, options.framingScale])
    if (s !== 'auto' && !scales.includes(s))
      return { ok: false, message: `${s} is not one of the scales offered.` };
  const sheetIds =
    context.ids?.sheets(planned.length) ??
    previewIds(drawing.nextIds, SHEET_COUNTER, planned.length);
  const viewIds = context.ids?.views(views) ?? previewIds(drawing.nextIds, VIEW_COUNTER, views);
  const { region } = sheetRegion(options.size, options.orientation);
  const title: TitleBlock = like?.titleBlock ?? {
    fields: (context.titleFields ?? SET_TITLE_FIELDS).map((label) => ({
      label,
      value: label === 'Title' ? clip(doc.name) : '',
    })),
  };
  const commands: Command[] = [];
  let v = 0;
  planned.forEach((p, i) => {
    const sheetId = sheetIds[i]!;
    const sheet: Sheet = {
      id: sheetId,
      name: p.name,
      size: options.size,
      orientation: options.orientation,
      titleBlock: title,
      views: [],
      dimensions: [],
      notes: [],
    };
    commands.push({ type: 'addSheet', drawingId: drawing.id, sheet });
    const places = slots(p.views.length, region);
    // One scale per sheet: the largest every view's slot takes.
    let scaleText = p.scale;
    if (scaleText === 'auto') {
      let best = 0;
      scaleText = scales[0]!;
      for (const [k, view] of p.views.entries()) {
        if (!view.extent) continue;
        const s = fitScale(view.extent, places[k]!, view.margin, scales);
        const f = setScaleFactor(s);
        if (best === 0 || f < best) {
          best = f;
          scaleText = s;
        }
      }
    }
    // Every offered scale is two lengths around `=` or `:`.
    const [paper, model] = scaleText.split(scaleText.includes('=') ? '=' : ':');
    const scale: ViewScale = {
      paper: storedExpression(paper!.trim(), doc.units),
      model: storedExpression(model!.trim(), doc.units),
    };
    const f = setScaleFactor(scaleText);
    p.views.forEach((view, k) => {
      const slot = places[k]!;
      const e = view.extent;
      // The view's model origin, so its extent's centre lands on the slot's centre.
      const position: [number, number] = e
        ? [
            round(slot.centre[0] - (f * (e.min[0] + e.max[0])) / 2),
            round(slot.centre[1] - (f * (e.min[1] + e.max[1])) / 2),
          ]
        : [round(slot.centre[0]), round(slot.centre[1])];
      const stored: DrawingView = {
        id: viewIds[v++]!,
        ...(view.label === undefined ? {} : { label: view.label }),
        source: view.source,
        direction: view.direction,
        scale,
        position,
        options: { hidden: false, smooth: false },
      };
      commands.push({ type: 'addView', drawingId: drawing.id, sheetId, view: stored });
    });
  });
  if (replacesOnly && only)
    commands.push({ type: 'deleteSheet', drawingId: drawing.id, sheetId: only.id });
  const wall = options.wall === undefined ? undefined : b.building.byId.get(options.wall);
  return {
    ok: true,
    command: { type: 'batch', commands },
    label: wall
      ? `New framing elevation of ${wall.name} in ${drawing.name}`
      : `New construction set in ${drawing.name}`,
    sheetIds,
  };
}
