// The drawing stage (M4 plan T4.4e, decisions 7 and 8): core's drawings meet the kernel's `project`
// op and `packages/drawing` here, and nowhere else.
//
// A view is computed on request only (`RegenEngine.drawingView` and `drawingSheet`), never as part
// of a regen. Its bodies come from the parts and assemblies the engine builds through its cache
// (so after a regen they are all hits), placed at their poses (assembly instances at their solved
// poses). Every body of a view goes into ONE `project` op: the T4.4a spike measured that
// projecting bodies alone and merging draws up to 72 % of a cabinet run's visible length wrong.
// Its result is cached by the bodies' keys, their poses, the view's direction and options and the
// stage's version, as plain data, so an unchanged view sends no kernel op at all.
//
// Dimensions store model references (a vertex, an edge or a face of a body, with an instance path
// in assembly views). Each is resolved on the current body like a feature's reference (`resolve`
// for edges and faces, the `connector` op's vertex rule for vertices), its exact geometry read with
// `measure`, placed at the body's pose and projected in TypeScript with the view's frame (the
// kernel's `viewFrame`, which HLR matches to 1e-9 mm). What it resolved to is cached by body key
// and reference. The outcome is reported in regen's vocabulary: `reference-lost` and
// `reference-ambiguous` errors, `reference` warnings for weaker resolutions.
//
// Picking (on request, `pick: true`): per body, its named edges as 3D polylines (the mesh's edge
// polylines), its vertices and its cylindrical faces, each with the reference a dimension stores,
// placed at the body's pose. They stay in 3D because the pick needs depth: in a principal view a
// front and a back edge project onto the same line, and only "nearest the viewer among the edges
// within 0.15 mm of the nearest" picks the right one (T4.4a: 99.99 % of 25,102 clicks, against
// 78.3 % for the nearest edge alone). `pickInView` is that rule.

import {
  STANDARD_VIEWS,
  isDomainViewSource,
  type Dimension,
  type DomainViewSource,
  type DimensionRef,
  type Drawing,
  type DrawingView,
  type ManufaktureDocument,
  type Note,
  type Pose,
  type Sheet,
  type StoredExpression,
  type TitleBlock,
  type ViewSource,
} from '@manufakture/core';
import {
  layoutSheet,
  type ChainDimensionInput,
  type Curve2,
  type DimensionInput,
  type DisplayList,
  type DrawingInput,
  type NoteInput,
  type PitchSymbolInput,
  type Scale,
  type SheetInput,
  type TitleBlockInput,
  type ValueFormat,
  type ViewInput,
  type ViewOverlayItem,
} from '@manufakture/drawing';
import {
  projectPoint,
  refName,
  viewFrame,
  type Bounds2,
  type ConnectorReport,
  type Deflection,
  type EdgeRef,
  type FaceRef,
  type ItemSection,
  type KernelOp,
  type MeasureResult,
  type MeasuredEdge,
  type MeshData,
  type OpResult,
  type ProjectResult,
  type ProjectedEdge,
  type ReferenceReport,
  type ShapeId,
  type Topology,
  type TopoRef,
  type Vec2,
  type Vec3,
  type VertexRef,
  type ViewFrame,
} from '@manufakture/kernel';
import type { LengthFormat } from '@manufakture/units';
import { REGEN_IMPLEMENTATION_VERSION, type KeyVersions } from './cache';
import type { DomainArc, DomainViewOutput } from './domain-views';
import { hashValue } from './hash';
import type { FieldPath, ReferenceResolution, RegenError, RegenWarning } from './types';
import { evaluateField, type VariableValues } from './values';

/** Bump when anything the stage computes changes for the same inputs: it is in every cache key. */
export const DRAWING_STAGE_VERSION = 1;

/**
 * The depth tie-break of `pickInView`, view millimetres: among candidates within this of the
 * nearest, the one nearest the viewer wins (T4.4a's measured rule).
 */
export const PICK_TIE_TOLERANCE = 0.15;

/** How many projected views, resolved references and bodies' pick data the stage keeps. */
const MAX_VIEWS = 128;
const MAX_REFS = 4096;
const MAX_PICKS = 256;

/** Directions within this (1 - |cos|) of each other are parallel; a sine below it is square. */
const ALIGNED = 1e-9;

// Results ------------------------------------------------------------------------------------

/**
 * Something about a view or a sheet (dimensions report their own, `DimensionResult`):
 *
 * - `unknown-source`: the view's part or assembly is not in the document (core refuses that, so
 *   only a hand-made document has it); the view is empty.
 * - `missing-body`: bodies the view lists that the part no longer has (`missing`).
 * - `source-errors`: features of the view's part, or instances of its assembly, failed
 *   (`failed`): the view shows what was built without them.
 * - `exploded-view`: the view shows an exploded view that its assembly does not have (drawn
 *   assembled), or steps of it that did not resolve in full (drawn without what failed; T4.5a).
 * - `empty-view`: nothing to project.
 * - `expression`: a scale, section offset or custom sheet size that does not evaluate (`field`).
 * - `sheet-size`: a custom sheet size that is not a positive length; the sheet is not laid out.
 * - `title-field`: title block fields with labels the title block has no cell for (`labels`).
 * - `kernel`: the `project` op failed.
 * - `domain-view`: a domain view (format v15) that this build cannot draw (no such domain, a newer
 *   version of its params, domain data that does not read, or the domain failing), an error and
 *   an empty view; or what the domain could not draw as asked, a warning.
 */
export interface DrawingDiagnostic {
  code:
    | 'unknown-source'
    | 'missing-body'
    | 'source-errors'
    | 'exploded-view'
    | 'empty-view'
    | 'expression'
    | 'sheet-size'
    | 'title-field'
    | 'kernel'
    | 'domain-view';
  severity: 'error' | 'warning';
  /** The view, sheet or drawing it is about. */
  subject: string;
  message: string;
  field?: FieldPath;
  missing?: string[];
  failed?: string[];
  labels?: string[];
}

/** One body of a view, as projected: `item` is the index HLR edges carry. */
export interface DrawingItem {
  item: number;
  /** The `project` op's key: the body id, or `<instance id>/<body id>` in an assembly view. */
  key: string;
  body: string;
  /** Assembly views: the instance showing the body. */
  instance?: string;
  /** Where the body sits in the view's model space (identity in a part view). */
  pose: Pose;
  bodyKey: string;
}

/**
 * Warnings of a dimension besides `reference`: `foreshortened` when the value is not a true size
 * in this view (an aligned dimension across depth, a circle or cylinder oblique to the view, an
 * angle between lines not in the view plane); `not-parallel` when two planar faces of a linear
 * dimension are not parallel (measured along the first one's normal); `silhouette` when a
 * diameter is taken across a cylindrical face that covers only part of the round, so at least one
 * of the two silhouettes it is drawn between is not on the face (a fillet's quarter round).
 */
export type DimensionWarning =
  | RegenWarning
  | { code: 'foreshortened'; message: string }
  | { code: 'not-parallel'; message: string }
  | { code: 'silhouette'; message: string };

/**
 * One dimension of a view: `exact` (every reference resolved by name), `warning` (resolved, with
 * warnings), `lost` or `ambiguous` (a reference did; `errors` say which and the candidates, for
 * the re-pick prompt), or `error` (the geometry cannot be dimensioned so: a radius of a straight
 * edge, an angle between parallel lines, ...). Lost and ambiguous dimensions are not drawn.
 */
export interface DimensionResult {
  dimensionId: string;
  viewId: string;
  kind: Dimension['kind'];
  outcome: 'exact' | 'warning' | 'lost' | 'ambiguous' | 'error';
  /** How each reference that resolved did, `referenceId` `refs.0`, `refs.1`. */
  references: ReferenceResolution[];
  errors: RegenError[];
  warnings: DimensionWarning[];
  /** Model millimetres (radians for angles); null when not drawn. */
  value: number | null;
  /** What `packages/drawing` lays out; null when not drawn. */
  input: DimensionInput | null;
}

/** A named edge as a 3D polyline (the mesh's), placed at the body's pose. */
export interface PickEdge {
  ref: EdgeRef;
  points: Vec3[];
}

export interface PickVertex {
  ref: VertexRef;
  point: Vec3;
}

/** A cylindrical face: its axis from `start` along unit `axis` for `length`, and its radius. */
export interface PickCylinder {
  ref: FaceRef;
  start: Vec3;
  axis: Vec3;
  length: number;
  radius: number;
  /**
   * The part of the round the face covers: from the unit direction `from` (square to the axis),
   * `sweep` radians counter-clockwise about `axis` (2 pi for a whole cylinder). A silhouette
   * outside it is not on the face (a fillet's quarter round has one silhouette at most).
   */
  from: Vec3;
  sweep: number;
}

export interface PickItem {
  item: number;
  body: string;
  instance?: string;
  edges: PickEdge[];
  vertices: PickVertex[];
  cylinders: PickCylinder[];
}

/** What the app picks with in a view (`pickInView`): 3D, so the pick has depth. */
export interface ViewPickData {
  frame: ViewFrame;
  items: PickItem[];
}

export interface DrawingViewResult {
  generation: number;
  drawingId: string;
  sheetId: string;
  viewId: string;
  /** The view's frame: view coordinates are (dot(p - origin, x), dot(p - origin, y)). */
  frame: ViewFrame;
  /** Paper mm per model mm as `packages/drawing` takes it; null when the scale does not evaluate. */
  scale: Scale | null;
  items: DrawingItem[];
  /** HLR's classified edges, view coordinates (model mm). */
  edges: ProjectedEdge[];
  bounds: Bounds2 | null;
  sections?: ItemSection[];
  diagnostics: DrawingDiagnostic[];
  /** The sheet's dimensions in this view, in sheet order. */
  dimensions: DimensionResult[];
  /** The view for `layoutSheet`; null when it cannot be placed (its scale does not evaluate). */
  input: ViewInput | null;
  /** With `pick: true`. */
  pick: ViewPickData | null;
  /** The projection came from the stage's cache: no `project` op was sent. */
  cached: boolean;
  /** A domain view's chained dimension strings, for `layoutSheet`; absent for other views. */
  chains?: ChainDimensionInput[];
  /** A domain view's roof pitch symbols, for `layoutSheet`; absent for other views. */
  symbols?: PitchSymbolInput[];
  /** A domain view's note for the title block (the construction disclaimer); absent when none. */
  titleNote?: string;
}

export interface DrawingSheetResult {
  generation: number;
  drawingId: string;
  sheetId: string;
  /** In the sheet's order. */
  views: DrawingViewResult[];
  diagnostics: DrawingDiagnostic[];
  /** What was laid out; null when the sheet's size is not usable. */
  input: DrawingInput | null;
  display: DisplayList | null;
}

export interface DrawingRequestOptions {
  /** The client's current generation (never a new one, M5 T5.1f's rule). Default: the newest seen. */
  generation?: number;
  /** As for `RegenOptions.stored`. */
  stored?: ManufaktureDocument;
  /** Also send picking data per view (default false). */
  pick?: boolean;
}

// What the engine gives the stage ----------------------------------------------------------

/** A live body of a view, from the engine's build. */
export interface DrawingBody {
  key: string;
  body: string;
  instance?: string;
  pose: Pose;
  shape: ShapeId;
  bodyKey: string;
  /** The kernel instance `shape` lives in. */
  kernelInstance: number | null;
}

/** The engine's side of a request: its build of the document, and its kernel. */
export interface DrawingHost {
  readonly generation: number;
  readonly variables: VariableValues;
  readonly versions: KeyVersions;
  readonly deflection: Partial<Deflection> | undefined;
  /** The bodies a view shows at their poses, built through the cache (memoised per request). */
  bodies(source: ViewSource): Promise<{ bodies: DrawingBody[]; diagnostics: DrawingDiagnostic[] }>;
  /**
   * A domain view (format v15): what the domain draws (null when it cannot), and the bodies of
   * the part it asks to project, at their poses.
   */
  domainView(source: DomainViewSource): Promise<{
    output: DomainViewOutput | null;
    bodies: DrawingBody[];
    diagnostics: DrawingDiagnostic[];
  }>;
  /**
   * The registered domains' title notes for a sheet showing these sources (their domain views'
   * namespaces, and those of the extension features of every part shown), each once.
   */
  titleNotes(sources: readonly ViewSource[]): string[];
  /** One batch on these bodies' shapes; throws when superseded or the shapes are stale. */
  run(ops: KernelOp[], bodies: readonly DrawingBody[]): Promise<readonly OpResult[]>;
}

/** Counters, for tests and the stats. */
export interface DrawingStats {
  projectOps: number;
  projectHits: number;
  resolveOps: number;
  pickOps: number;
}

// Small vector helpers -----------------------------------------------------------------------

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a: Vec3): Vec3 => {
  const n = norm3(a);
  return n > 0 ? mul3(a, 1 / n) : a;
};
const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
const unit2 = (a: Vec2): Vec2 => {
  const n = len2(a);
  return n > 0 ? mul2(a, 1 / n) : a;
};
/** A quarter turn counter-clockwise. */
const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];

export const IDENTITY_POSE: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** `v` turned by the unit quaternion `q` (normalised first, as the kernel does). */
function rotate(q: Pose['rotation'], v: Vec3): Vec3 {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const u: Vec3 = [q[0] / n, q[1] / n, q[2] / n];
  const w = q[3] / n;
  const t = mul3(cross3(u, v), 2);
  return add3(add3(v, mul3(t, w)), cross3(u, t));
}

/** A point of a body placed at `pose`. */
export function placePoint(pose: Pose, p: Vec3): Vec3 {
  return add3(rotate(pose.rotation, p), pose.translation);
}

/** A direction of a body turned by `pose`. */
export function placeDirection(pose: Pose, d: Vec3): Vec3 {
  return rotate(pose.rotation, d);
}

/** Depth along the frame's z (toward the viewer): larger is nearer. */
const depthOf = (frame: ViewFrame, p: Vec3): number => dot3(sub3(p, frame.origin), frame.z);

class Lru<V> {
  readonly #map = new Map<string, V>();
  constructor(readonly limit: number) {}
  get(key: string): V | undefined {
    const v = this.#map.get(key);
    if (v !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value!);
  }
}

// Mapping core onto packages/drawing ---------------------------------------------------------

/** A view's direction and up, from a standard name or a custom pair. */
export function viewDirection(view: DrawingView): { direction: Vec3; up: Vec3 } {
  return typeof view.direction === 'string' ? STANDARD_VIEWS[view.direction] : view.direction;
}

/** Whether an expression is written in inches or feet (a quote, or an imperial unit word). */
function imperialSource(e: StoredExpression): boolean {
  if (/["']/.test(e.source)) return true;
  const words = e.source.match(/[a-z]+/gi) ?? [];
  return words.some((w) => /^(in|inch|inches|ft|foot|feet)$/i.test(w));
}

/**
 * A view's scale from its two length expressions: a ratio with its smaller side 1 (`1:5` whatever
 * unit both sides were typed in), or, when both sides are written in inches and feet, the
 * architectural form `1-1/2" = 1'` that `packages/drawing` writes back as typed.
 */
export function evaluateScale(
  scale: DrawingView['scale'],
  variables: VariableValues,
): { ok: true; scale: Scale } | { ok: false; field: FieldPath; message: string } {
  const paper = evaluateField(scale.paper, 'length', ['scale', 'paper'], variables);
  if (!paper.ok) return { ok: false, field: ['scale', 'paper'], message: paper.error.message };
  const model = evaluateField(scale.model, 'length', ['scale', 'model'], variables);
  if (!model.ok) return { ok: false, field: ['scale', 'model'], message: model.error.message };
  for (const [side, v] of [
    ['paper', paper.value],
    ['model', model.value],
  ] as const) {
    if (!(v > 0) || !Number.isFinite(v)) {
      return {
        ok: false,
        field: ['scale', side],
        message: `the scale's ${side} side must be positive`,
      };
    }
  }
  if (imperialSource(scale.paper) && imperialSource(scale.model)) {
    return { ok: true, scale: { paper: paper.value, model: model.value, notation: 'imperial' } };
  }
  const p = paper.value;
  const m = model.value;
  return { ok: true, scale: p <= m ? { paper: 1, model: m / p } : { paper: p / m, model: 1 } };
}

/** A sheet's size for `packages/drawing`; a custom size that is not a positive length is a diagnostic. */
export function sheetInput(
  sheet: Sheet,
  variables: VariableValues,
): { ok: true; sheet: SheetInput } | { ok: false; diagnostic: DrawingDiagnostic } {
  const size = sheet.size;
  if (typeof size === 'string') {
    return { ok: true, sheet: { size, orientation: sheet.orientation } };
  }
  const sides: number[] = [];
  for (const side of ['width', 'height'] as const) {
    const r = evaluateField(size[side], 'length', ['size', side], variables);
    if (!r.ok) {
      return {
        ok: false,
        diagnostic: {
          code: 'expression',
          severity: 'error',
          subject: sheet.id,
          field: ['size', side],
          message: `The sheet's ${side} does not evaluate: ${r.error.message}`,
        },
      };
    }
    if (!(r.value > 0) || !Number.isFinite(r.value)) {
      return {
        ok: false,
        diagnostic: {
          code: 'sheet-size',
          severity: 'error',
          subject: sheet.id,
          field: ['size', side],
          message: `The sheet's ${side} must be a positive length`,
        },
      };
    }
    sides.push(r.value);
  }
  return {
    ok: true,
    sheet: { size: { width: sides[0]!, height: sides[1]! }, orientation: sheet.orientation },
  };
}

/** Title block labels, normalised (lower case, letters only), to `packages/drawing`'s cells. */
const TITLE_KEYS: Readonly<Record<string, keyof TitleBlockInput>> = {
  title: 'title',
  name: 'title',
  drawingnumber: 'drawingNumber',
  drawingno: 'drawingNumber',
  dwgno: 'drawingNumber',
  number: 'drawingNumber',
  revision: 'revision',
  rev: 'revision',
  sheet: 'sheet',
  scale: 'scale',
  company: 'company',
  drawnby: 'drawnBy',
  author: 'drawnBy',
  date: 'date',
  material: 'material',
  units: 'units',
  projection: 'projection',
};

/**
 * Core's title block (label and value pairs) as `packages/drawing`'s cells, by label: `Title`,
 * `Drawing number`, `Revision`, `Sheet`, `Scale`, `Company`, `Drawn by`, `Date`, `Material`,
 * `Units`, `Projection` (case, spaces and punctuation ignored). Labels with no cell are returned
 * apart; an empty value leaves the cell to its default.
 */
export function titleBlockInput(block: TitleBlock): {
  input: TitleBlockInput;
  unknown: string[];
} {
  const input: { -readonly [K in keyof TitleBlockInput]: string } = {};
  const unknown: string[] = [];
  for (const { label, value } of block.fields) {
    const key = TITLE_KEYS[label.toLowerCase().replace(/[^a-z]/g, '')];
    if (key === undefined) unknown.push(label);
    else if (value !== '') input[key] = value;
  }
  return { input, unknown };
}

/** The document's display units as `packages/drawing`'s value format, with a dimension's own. */
export function valueFormat(
  units: ManufaktureDocument['units'],
  dim?: Pick<Dimension, 'decimals' | 'denominator'>,
): ValueFormat {
  const l = units.length;
  let length: LengthFormat;
  if (l.unit === 'ft-in' || l.unit === 'in-fraction') {
    const denominator = dim?.denominator ?? l.denominator;
    length = denominator === undefined ? { unit: l.unit } : { unit: l.unit, denominator };
  } else {
    const decimals = dim?.decimals ?? ('decimals' in l ? l.decimals : undefined);
    length = decimals === undefined ? { unit: l.unit } : { unit: l.unit, decimals };
  }
  const angleDecimals = dim?.decimals ?? units.angle.decimals;
  const angle =
    angleDecimals === undefined
      ? { unit: units.angle.unit }
      : { unit: units.angle.unit, decimals: angleDecimals };
  return { length, angle };
}

// Reference geometry --------------------------------------------------------------------------

/** What a resolved reference is, for dimensioning: in the body's coordinates, or placed. */
export type RefGeometry =
  | { kind: 'point'; point: Vec3 }
  | { kind: 'line'; a: Vec3; b: Vec3 }
  | { kind: 'circle'; center: Vec3; radius: number; axis: Vec3 }
  /** Any other edge: its midpoint. */
  | { kind: 'curve'; point: Vec3 }
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  /**
   * `origin` is on the axis in the middle of the face's axial extent `length`. `arc`, when known,
   * is the part of the round the face covers (as `PickCylinder`'s `from` and `sweep`); absent, the
   * face is taken to be whole.
   */
  | {
      kind: 'cylinder';
      origin: Vec3;
      axis: Vec3;
      radius: number;
      length: number;
      arc?: { from: Vec3; sweep: number };
    }
  /** Any other face: its centroid. */
  | { kind: 'surface'; point: Vec3 };

export function placeGeometry(pose: Pose, g: RefGeometry): RefGeometry {
  const p = (x: Vec3) => placePoint(pose, x);
  const d = (x: Vec3) => placeDirection(pose, x);
  switch (g.kind) {
    case 'point':
    case 'curve':
    case 'surface':
      return { ...g, point: p(g.point) };
    case 'line':
      return { kind: 'line', a: p(g.a), b: p(g.b) };
    case 'circle':
      return { ...g, center: p(g.center), axis: d(g.axis) };
    case 'plane':
      return { kind: 'plane', point: p(g.point), normal: d(g.normal) };
    case 'cylinder':
      return {
        ...g,
        origin: p(g.origin),
        axis: d(g.axis),
        ...(g.arc === undefined ? {} : { arc: { from: d(g.arc.from), sweep: g.arc.sweep } }),
      };
  }
}

/** The geometry `measure` gives for one target. */
function measuredGeometry(m: MeasureResult): RefGeometry | null {
  const item = m.items[0];
  if (item === undefined || !item.ok) return null;
  if (item.kind === 'vertex') return { kind: 'point', point: item.point };
  if (item.kind === 'edge') {
    if (item.circle !== null) {
      return {
        kind: 'circle',
        center: item.circle.center,
        radius: item.circle.radius,
        axis: item.circle.axis,
      };
    }
    if (item.curve === 'line' && item.start !== null && item.end !== null) {
      return { kind: 'line', a: item.start, b: item.end };
    }
    return { kind: 'curve', point: item.midpoint };
  }
  if (item.surface === 'plane' && item.normal !== null) {
    return { kind: 'plane', point: item.centroid, normal: item.normal };
  }
  if (item.surface === 'cylinder' && item.axis !== null && item.radius !== null) {
    const a = unit3(item.axis.direction);
    const o = item.axis.origin;
    const origin = add3(o, mul3(a, dot3(sub3(item.centroid, o), a)));
    // Exact for a whole cylinder (a hole, a pin); an estimate for a part of one, which the stage
    // replaces with the extent of the face's edges (`cylinderExtent`).
    const length = item.radius > 0 ? item.area / (2 * Math.PI * item.radius) : 0;
    return { kind: 'cylinder', origin, axis: a, radius: item.radius, length };
  }
  return { kind: 'surface', point: item.centroid };
}

/** `v` turned by `angle` counter-clockwise about unit `k`. */
function turn(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  return add3(add3(mul3(v, c), mul3(cross3(k, v), Math.sin(angle))), mul3(k, dot3(k, v) * (1 - c)));
}

/**
 * Points along a measured edge, enough to find a face's extent and arc from its edges: an arc
 * sampled every 1/16 turn (the way it runs found by its midpoint), any other edge its ends and
 * midpoint.
 */
export function edgeSamples(e: MeasuredEdge): Vec3[] {
  const ends = [e.start, e.end, e.midpoint].filter((q): q is Vec3 => q !== null);
  if (e.circle === null || e.start === null || !(e.circle.sweep > 0)) return ends;
  const { center, axis, sweep } = e.circle;
  const k = unit3(axis);
  const r0 = sub3(e.start, center);
  const at = (sign: number, t: number) => add3(center, turn(r0, k, sign * t));
  const miss = (sign: number) => norm3(sub3(at(sign, sweep / 2), e.midpoint));
  const sign = miss(1) <= miss(-1) ? 1 : -1;
  const n = Math.max(2, Math.ceil(sweep / (Math.PI / 8)));
  return Array.from({ length: n + 1 }, (_, i) => at(sign, (sweep * i) / n));
}

/**
 * A cylindrical face's axial extent and arc from points of its boundary edges: `origin` moved to
 * the middle of the extent along `axis`. Null when there are no points off the axis.
 */
export function cylinderExtent(
  origin: Vec3,
  axis: Vec3,
  points: readonly Vec3[],
  seam: boolean,
): { origin: Vec3; length: number; arc: { from: Vec3; sweep: number } } | null {
  let lo = Infinity;
  let hi = -Infinity;
  const radial: Vec3[] = [];
  for (const q of points) {
    const t = dot3(sub3(q, origin), axis);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    const r = sub3(sub3(q, origin), mul3(axis, t));
    if (norm3(r) > 1e-9) radial.push(unit3(r));
  }
  if (!(hi >= lo) || radial.length === 0) return null;
  return {
    origin: add3(origin, mul3(axis, (lo + hi) / 2)),
    length: hi - lo,
    arc: arcOf(axis, radial, seam),
  };
}

/** Whether unit `dir` (square to `axis`) lies within an arc that starts at `from`. */
const withinArc = (axis: Vec3, arc: { from: Vec3; sweep: number }, dir: Vec3): boolean => {
  const a = angleAbout(axis, arc.from, dir);
  return a <= arc.sweep + 1e-6 || a >= 2 * Math.PI - 1e-6;
};

// Dimensions --------------------------------------------------------------------------------

/** The name of a reference for messages and `ReferenceResolution.target`. */
export function refTarget(ref: DimensionRef): string {
  if ('vertex' in ref) return ref.vertex.faces.join('&');
  return refName('edge' in ref ? (ref.edge as TopoRef) : (ref.face as TopoRef));
}

/**
 * The text a diameter dimension shows by default when it measures the wall of a hole made for a
 * heat-set insert (`standard.purpose`, core format 18), so the drawing says what the hole is for:
 * `<> for M3 heat-set insert` (`<>` is the value, `⌀4`). Null for anything else, and for a
 * dimension with a text of its own. `partId` is the part the view shows (null for an assembly
 * view, whose instances' features are not looked up here).
 */
export function insertCallout(
  document: ManufaktureDocument,
  partId: string | null,
  dim: Dimension,
): string | null {
  if (dim.kind !== 'diameter' || dim.text !== undefined || partId === null) return null;
  const ref = dim.refs[0];
  const names = 'edge' in ref ? ref.edge.faces : 'face' in ref ? [ref.face.face] : [];
  const part = document.parts.find((p) => p.id === partId);
  for (const name of names) {
    const m = /^(hole#[1-9][0-9]*):wall:/.exec(name);
    if (m === null) continue;
    const f = part?.features.find((x) => x.id === m[1]);
    if (f?.kind === 'hole' && f.standard?.purpose === 'heat-set-insert') {
      return `<> for ${f.standard.size} heat-set insert`;
    }
  }
  return null;
}

/** Where a reference anchors a linear dimension: a point, or a plane. */
type Anchor = { plane: false; point: Vec3 } | { plane: true; point: Vec3; normal: Vec3 };

function anchorOf(g: RefGeometry): Anchor {
  switch (g.kind) {
    case 'point':
    case 'curve':
    case 'surface':
      return { plane: false, point: g.point };
    case 'line':
      return { plane: false, point: mul3(add3(g.a, g.b), 0.5) };
    case 'circle':
      return { plane: false, point: g.center };
    case 'cylinder':
      return { plane: false, point: g.origin };
    case 'plane':
      return { plane: true, point: g.point, normal: unit3(g.normal) };
  }
}

/** The foot of `p` on the plane through `o` with unit normal `n`. */
const foot = (p: Vec3, o: Vec3, n: Vec3): Vec3 => sub3(p, mul3(n, dot3(sub3(p, o), n)));

/**
 * A linear dimension's offset for `packages/drawing` (which measures from the anchor nearest the
 * dimension line, positive up, right or left of the first point to the second) from core's
 * (from the first anchor, along the measuring direction turned a quarter turn counter-clockwise:
 * up for horizontal, left for vertical). Both in paper mm; `s` is paper mm per model mm.
 */
export function drawingOffset(
  kind: 'horizontal' | 'vertical' | 'aligned',
  a: Vec2,
  b: Vec2,
  offset: number,
  s: number,
): number {
  const dir: Vec2 =
    kind === 'horizontal' ? [1, 0] : kind === 'vertical' ? [0, 1] : unit2(sub2(b, a));
  const nCore = perp2(dir);
  // packages/drawing measures vertical dimensions to the right, the others like core.
  const nDraw: Vec2 = kind === 'vertical' ? [1, 0] : nCore;
  const sign = dot2(nCore, nDraw);
  const h1 = s * dot2(a, nDraw);
  const h2 = s * dot2(b, nDraw);
  const level = h1 + sign * offset;
  const hi = Math.max(h1, h2);
  const lo = Math.min(h1, h2);
  if (level >= hi) return level - hi;
  if (level <= lo) return level - lo;
  // Between the anchors, which packages/drawing cannot place: the nearer side, at no offset.
  return level - lo < hi - level ? -1e-9 : 0;
}

/** Up along a line, or right when it is horizontal (as `packages/drawing` orders silhouettes). */
const upRight = (d: Vec2): Vec2 =>
  d[1] < -1e-12 || (Math.abs(d[1]) <= 1e-12 && d[0] < 0) ? mul2(d, -1) : d;

/**
 * A dimension's input for `packages/drawing` from its references' placed geometry (core's
 * `Dimension` rules), with the value in model mm (radians for angles) and warnings; or why it
 * cannot be drawn so. `s` is the view's paper mm per model mm.
 */
export function dimensionInput(
  dim: Dimension,
  geometry: readonly RefGeometry[],
  frame: ViewFrame,
  s: number,
  format: ValueFormat,
):
  | { ok: true; input: DimensionInput; value: number; warnings: DimensionWarning[] }
  | { ok: false; message: string } {
  const P = (p: Vec3) => projectPoint(frame, p);
  const along = (d: Vec3) => Math.abs(dot3(unit3(d), frame.z));
  const warnings: DimensionWarning[] = [];
  const base = {
    id: dim.id,
    view: dim.view,
    format,
    ...(dim.text === undefined ? {} : { text: dim.text }),
  };
  const foreshortened = (what: string) =>
    warnings.push({
      code: 'foreshortened',
      message: `${dim.id}: ${what} is not parallel to the view, so the value is foreshortened`,
    });

  if (dim.kind === 'horizontal' || dim.kind === 'vertical' || dim.kind === 'aligned') {
    const [g1, g2] = geometry as [RefGeometry, RefGeometry];
    const A = anchorOf(g1);
    const B = anchorOf(g2);
    let p1 = A.point;
    let p2 = B.point;
    if (A.plane && B.plane) {
      const c = dot3(A.normal, B.normal);
      if (Math.abs(c) < ALIGNED)
        return { ok: false, message: `${dim.id}: the two planes are square to each other` };
      if (1 - Math.abs(c) > ALIGNED) {
        warnings.push({
          code: 'not-parallel',
          message: `${dim.id}: the two planes are not parallel; measured along the first one's normal`,
        });
      }
      // From the first plane's centroid along its normal to the second plane.
      const t = dot3(sub3(B.point, A.point), B.normal) / c;
      p2 = add3(A.point, mul3(A.normal, t));
    } else if (A.plane) {
      p1 = foot(B.point, A.point, A.normal);
    } else if (B.plane) {
      p2 = foot(A.point, B.point, B.normal);
    }
    const a = P(p1);
    const b = P(p2);
    const value =
      dim.kind === 'horizontal'
        ? Math.abs(b[0] - a[0])
        : dim.kind === 'vertical'
          ? Math.abs(b[1] - a[1])
          : len2(sub2(b, a));
    if (dim.kind === 'aligned') {
      const depth = Math.abs(depthOf(frame, p2) - depthOf(frame, p1));
      if (depth > 1e-6 * Math.max(1, norm3(sub3(p2, p1)))) foreshortened('the distance');
    }
    if (!(value > 0))
      return { ok: false, message: `${dim.id}: the two anchors coincide in this view` };
    return {
      ok: true,
      value,
      warnings,
      input: {
        ...base,
        kind: dim.kind,
        points: [a, b],
        offset: drawingOffset(dim.kind, a, b, dim.offset, s),
      },
    };
  }

  if (dim.kind === 'radius' || dim.kind === 'diameter') {
    const g = geometry[0]!;
    const at: Vec2 = [dim.at[0], dim.at[1]];
    const angle = len2(at) > 0 ? Math.atan2(at[1], at[0]) : Math.PI / 4;
    if (g.kind === 'circle' || (g.kind === 'cylinder' && along(g.axis) > ALIGNED)) {
      const center = g.kind === 'circle' ? g.center : g.origin;
      const axis = g.axis;
      if (1 - along(axis) > ALIGNED) foreshortened('the circle');
      const value = dim.kind === 'radius' ? g.radius : 2 * g.radius;
      return {
        ok: true,
        value,
        warnings,
        input: {
          ...base,
          kind: dim.kind,
          circle: { center: P(center), radius: g.radius },
          angle,
          value,
        },
      };
    }
    if (g.kind === 'cylinder') {
      // Seen across: the two silhouettes, a radius either side of the axis in the view plane.
      if (dim.kind === 'radius') {
        return {
          ok: false,
          message: `${dim.id}: a radius of a cylinder seen across its axis: dimension its diameter, or a circular edge`,
        };
      }
      const w = unit3(cross3(g.axis, frame.z));
      const arc = g.arc;
      if (arc !== undefined && ![1, -1].every((side) => withinArc(g.axis, arc, mul3(w, side)))) {
        warnings.push({
          code: 'silhouette',
          message: `${dim.id}: the face covers only part of the round, so one of the two silhouettes is not on it`,
        });
      }
      const half = mul3(g.axis, g.length / 2);
      const line = (side: number): [Vec2, Vec2] => {
        const o = add3(g.origin, mul3(w, side * g.radius));
        return [P(sub3(o, half)), P(add3(o, half))];
      };
      const l1 = line(1);
      const l2 = line(-1);
      const dir = upRight(unit2(sub2(l1[1], l1[0])));
      return {
        ok: true,
        value: 2 * g.radius,
        warnings,
        input: {
          ...base,
          kind: 'diameter',
          lines: [l1, l2],
          offset: dot2(at, dir),
          value: 2 * g.radius,
        },
      };
    }
    return {
      ok: false,
      message: `${dim.id}: a ${dim.kind} needs a circular edge or a cylindrical face`,
    };
  }

  // Angle: two lines in the view, from line edges or planar faces seen edge on.
  const legs: { point: Vec2; dir: Vec2; ends: Vec2[] }[] = [];
  for (const g of geometry) {
    if (g.kind === 'line') {
      const d = sub3(g.b, g.a);
      if (along(d) > ALIGNED) foreshortened('a line');
      const a = P(g.a);
      const b = P(g.b);
      if (!(len2(sub2(b, a)) > 0))
        return { ok: false, message: `${dim.id}: a line is seen end on` };
      legs.push({ point: a, dir: unit2(sub2(b, a)), ends: [a, b] });
    } else if (g.kind === 'plane') {
      const n = unit3(g.normal);
      if (along(n) > 1e-6) return { ok: false, message: `${dim.id}: a plane is not seen edge on` };
      const n2: Vec2 = [dot3(n, frame.x), dot3(n, frame.y)];
      legs.push({ point: P(g.point), dir: unit2(perp2(n2)), ends: [] });
    } else {
      return { ok: false, message: `${dim.id}: an angle needs line edges or planar faces` };
    }
  }
  const [l1, l2] = legs as [(typeof legs)[0], (typeof legs)[0]];
  const det = l1.dir[0] * l2.dir[1] - l1.dir[1] * l2.dir[0];
  if (Math.abs(det) < 1e-9) return { ok: false, message: `${dim.id}: the two lines are parallel` };
  // l1.point + t d1 = l2.point + u d2.
  const r = sub2(l2.point, l1.point);
  const t = (r[0] * l2.dir[1] - r[1] * l2.dir[0]) / det;
  const vertex = add2(l1.point, mul2(l1.dir, t));
  if (dim.kind !== 'angle') return { ok: false, message: `${dim.id}: unknown kind` };
  const at: Vec2 = [dim.at[0], dim.at[1]];
  const radius = len2(at) > 0 ? len2(at) : 10;
  const want = len2(at) > 0 ? unit2(at) : unit2(add2(l1.dir, l2.dir));
  // The quadrant holding `at`: want = alpha s1 d1 + beta s2 d2 with alpha, beta >= 0.
  const alpha = (want[0] * l2.dir[1] - want[1] * l2.dir[0]) / det;
  const beta = (l1.dir[0] * want[1] - l1.dir[1] * want[0]) / det;
  const d1 = mul2(l1.dir, alpha >= 0 ? 1 : -1);
  const d2 = mul2(l2.dir, beta >= 0 ? 1 : -1);
  const reach = (leg: (typeof legs)[0], d: Vec2) => {
    const far = Math.max(0, ...leg.ends.map((e) => dot2(sub2(e, vertex), d)));
    return far > 1e-9 ? far : radius / s;
  };
  const value = Math.acos(Math.max(-1, Math.min(1, dot2(d1, d2))));
  return {
    ok: true,
    value,
    warnings,
    input: {
      ...base,
      kind: 'angle',
      vertex,
      points: [add2(vertex, mul2(d1, reach(l1, d1))), add2(vertex, mul2(d2, reach(l2, d2)))],
      radius,
    },
  };
}

// Picking -----------------------------------------------------------------------------------

export type PickKind = 'vertex' | 'edge' | 'face';

export interface PickOptions {
  /** How far from the click a candidate may be, view mm (the app turns paper mm by the scale). */
  radius: number;
  /** The depth tie-break window, view mm. Default `PICK_TIE_TOLERANCE`. */
  tie?: number;
  /** A vertex within this wins over edges and faces. Default half of `radius`. */
  vertexRadius?: number;
  /** What may be picked. Default all. */
  kinds?: readonly PickKind[];
}

export interface PickHit {
  kind: PickKind;
  item: number;
  /** The reference a dimension stores. */
  ref: DimensionRef;
  /** From the click, view mm. */
  distance: number;
  /** Along the frame's z: larger is nearer the viewer. */
  depth: number;
}

interface Candidate {
  hit: Omit<PickHit, 'distance' | 'depth'>;
  distance: number;
  depth: number;
}

/** The angle of unit `v` from unit `from`, counter-clockwise about `axis`, in [0, 2 pi). */
function angleAbout(axis: Vec3, from: Vec3, v: Vec3): number {
  const a = Math.atan2(dot3(cross3(from, v), axis), dot3(from, v));
  return a < 0 ? a + 2 * Math.PI : a;
}

/**
 * The arc a cylindrical face covers, from the directions of its boundary points about the axis:
 * whole when it has a seam, else everything but the largest gap between those directions.
 */
function arcOf(axis: Vec3, radial: readonly Vec3[], seam: boolean): { from: Vec3; sweep: number } {
  const ref = radial[0]!;
  if (seam) return { from: ref, sweep: 2 * Math.PI };
  const angles = radial.map((r) => angleAbout(axis, ref, r)).sort((a, b) => a - b);
  let gap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
  let start = angles[0]!;
  for (let i = 1; i < angles.length; i++) {
    const g = angles[i]! - angles[i - 1]!;
    if (g > gap) {
      gap = g;
      start = angles[i]!;
    }
  }
  const from = add3(mul3(ref, Math.cos(start)), mul3(cross3(axis, ref), Math.sin(start)));
  return { from: unit3(from), sweep: 2 * Math.PI - gap };
}

/** Nearest point of a projected segment, with its depth. */
function segmentDistance(frame: ViewFrame, at: Vec2, p: Vec3, q: Vec3): { d: number; z: number } {
  const a = projectPoint(frame, p);
  const b = projectPoint(frame, q);
  const ab = sub2(b, a);
  const l = dot2(ab, ab);
  const t = l > 0 ? Math.max(0, Math.min(1, dot2(sub2(at, a), ab) / l)) : 0;
  const c = add2(a, mul2(ab, t));
  const za = depthOf(frame, p);
  const zb = depthOf(frame, q);
  return { d: len2(sub2(at, c)), z: za + (zb - za) * t };
}

/** Among candidates within `radius`, the nearest; ties within `tie` go to the one nearest the viewer. */
function choose(cands: readonly Candidate[], radius: number, tie: number): Candidate | null {
  const near = cands.filter((c) => c.distance <= radius);
  if (near.length === 0) return null;
  const best = Math.min(...near.map((c) => c.distance));
  let pick: Candidate | null = null;
  for (const c of near) {
    if (c.distance > best + tie) continue;
    if (pick === null || c.depth > pick.depth + 1e-9) pick = c;
  }
  return pick;
}

/**
 * What a click at `at` (view coordinates) picks in a view: a vertex within `vertexRadius`, else an
 * edge or the silhouette of a cylindrical face within `radius`, the nearest, with ties within
 * `tie` going to the one nearest the viewer (T4.4a's rule). Null when nothing is near.
 */
export function pickInView(data: ViewPickData, at: Vec2, options: PickOptions): PickHit | null {
  const frame = data.frame;
  const kinds = new Set(options.kinds ?? ['vertex', 'edge', 'face']);
  const tie = options.tie ?? PICK_TIE_TOLERANCE;
  const vertexRadius = options.vertexRadius ?? options.radius / 2;
  const vertices: Candidate[] = [];
  const lines: Candidate[] = [];
  for (const item of data.items) {
    const target = {
      body: item.body,
      ...(item.instance === undefined ? {} : { instance: [item.instance] }),
    };
    if (kinds.has('vertex')) {
      for (const v of item.vertices) {
        const d = len2(sub2(projectPoint(frame, v.point), at));
        vertices.push({
          hit: { kind: 'vertex', item: item.item, ref: { vertex: v.ref, ...target } },
          distance: d,
          depth: depthOf(frame, v.point),
        });
      }
    }
    if (kinds.has('edge')) {
      for (const e of item.edges) {
        let best = { d: Infinity, z: -Infinity };
        for (let i = 0; i + 1 < e.points.length; i++) {
          const r = segmentDistance(frame, at, e.points[i]!, e.points[i + 1]!);
          if (r.d < best.d - 1e-12 || (Math.abs(r.d - best.d) <= 1e-12 && r.z > best.z)) best = r;
        }
        if (e.points.length === 1) best = segmentDistance(frame, at, e.points[0]!, e.points[0]!);
        if (best.d < Infinity) {
          lines.push({
            hit: { kind: 'edge', item: item.item, ref: { edge: e.ref, ...target } },
            distance: best.d,
            depth: best.z,
          });
        }
      }
    }
    if (kinds.has('face')) {
      for (const c of item.cylinders) {
        // Seen face on, a cylinder is its circular edges; across or oblique, its silhouettes.
        if (1 - Math.abs(dot3(c.axis, frame.z)) <= 1e-6) continue;
        const w = unit3(cross3(c.axis, frame.z));
        const end = add3(c.start, mul3(c.axis, c.length));
        for (const side of [1, -1]) {
          // Only a silhouette on the face: its direction within the face's arc.
          if (!withinArc(c.axis, c, mul3(w, side))) continue;
          const off = mul3(w, side * c.radius);
          const r = segmentDistance(frame, at, add3(c.start, off), add3(end, off));
          lines.push({
            hit: { kind: 'face', item: item.item, ref: { face: c.ref, ...target } },
            distance: r.d,
            depth: r.z,
          });
        }
      }
    }
  }
  const pick = choose(vertices, vertexRadius, tie) ?? choose(lines, options.radius, tie);
  return pick === null ? null : { ...pick.hit, distance: pick.distance, depth: pick.depth };
}

// The stage ---------------------------------------------------------------------------------

/** What a reference resolved to on one body (cached by body key and reference). */
type RefEntry =
  | { ok: true; via: ReferenceResolution['via']; fragile: boolean; geometry: RefGeometry }
  | { ok: false; status: 'lost'; missing: string[]; message: string }
  | { ok: false; status: 'ambiguous'; candidates: string[]; message: string }
  | { ok: false; status: 'invalid'; message: string };

/** A body's pick data in its own coordinates (cached by body key). */
interface BodyPick {
  edges: PickEdge[];
  vertices: PickVertex[];
  cylinders: PickCylinder[];
}

const refKey = (bodyKey: string, ref: DimensionRef): string => {
  // The body key stands for the body; only the name part of the reference matters on it.
  const named =
    'vertex' in ref
      ? { vertex: ref.vertex }
      : 'edge' in ref
        ? { edge: ref.edge }
        : { face: ref.face };
  return hashValue({ bodyKey, named });
};

// Domain views --------------------------------------------------------------------------------

/** Segments a domain arc that the view does not see face on is drawn with. */
const ARC_SEGMENTS = 24;

function unionBounds2(a: Bounds2 | null, b: Bounds2 | null): Bounds2 | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])],
  };
}

/** A domain arc in view coordinates: an arc seen face on, a polyline otherwise. */
function arcCurve(arc: DomainArc, frame: ViewFrame): Curve2 {
  const n = unit3([...arc.normal] as Vec3);
  const c = [...arc.center] as Vec3;
  const u = sub3([...arc.from] as Vec3, c);
  const v = sub3([...arc.to] as Vec3, c);
  const radius = norm3(u);
  // The sweep counter-clockwise about n from u to v, in (0, 2 pi].
  let sweep = Math.atan2(dot3(cross3(u, v), n), dot3(u, v));
  if (sweep <= 1e-12) sweep += 2 * Math.PI;
  const facing = dot3(n, frame.z);
  if (Math.abs(facing) > 1 - ALIGNED && radius > 0) {
    const centre = projectPoint(frame, c);
    const a = projectPoint(frame, arc.from as Vec3);
    const b = projectPoint(frame, arc.to as Vec3);
    const angle = (p: Vec2) => Math.atan2(p[1] - centre[1], p[0] - centre[0]);
    // Seen from behind its normal, the arc runs clockwise on paper: from `to` back to `from`.
    const start = facing > 0 ? angle(a) : angle(b);
    return { kind: 'arc', center: centre, radius, start, end: start + sweep };
  }
  const w = cross3(n, u);
  const points: Vec2[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = (sweep * i) / ARC_SEGMENTS;
    points.push(projectPoint(frame, add3(c, add3(mul3(u, Math.cos(t)), mul3(w, Math.sin(t))))));
  }
  return { kind: 'polyline', points };
}

/**
 * What a domain view draws besides its projected bodies, in view coordinates: the overlay (lines
 * and arcs on their layers), the chained strings (their sides turned into `packages/drawing`'s
 * signed offsets) and the pitch symbols, with the bounds of all of it. Linear in the output.
 */
export function domainParts(
  domain: DomainViewOutput,
  frame: ViewFrame,
  viewId: string,
): {
  overlay: ViewOverlayItem[];
  chains: ChainDimensionInput[];
  symbols: PitchSymbolInput[];
  bounds: Bounds2 | null;
} {
  const overlay: ViewOverlayItem[] = [];
  let lo: [number, number] = [Infinity, Infinity];
  let hi: [number, number] = [-Infinity, -Infinity];
  const grow = (p: Vec2) => {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  };
  const P = (p: readonly [number, number, number]) => projectPoint(frame, p as Vec3);
  for (const l of domain.lines ?? []) {
    const a = P(l.a);
    const b = P(l.b);
    grow(a);
    grow(b);
    overlay.push({ curve: { kind: 'line', a, b }, layer: l.layer ?? 'visible' });
  }
  for (const arc of domain.arcs ?? []) {
    const curve = arcCurve(arc, frame);
    if (curve.kind === 'arc') {
      grow([curve.center[0] - curve.radius, curve.center[1] - curve.radius]);
      grow([curve.center[0] + curve.radius, curve.center[1] + curve.radius]);
    } else if (curve.kind === 'polyline') curve.points.forEach(grow);
    overlay.push({ curve, layer: arc.layer ?? 'visible' });
  }
  const chains: ChainDimensionInput[] = [];
  for (const c of domain.chains ?? []) {
    const points = c.points.map(P);
    if (points.length < 2) continue;
    const side = [dot3([...c.side] as Vec3, frame.x), dot3([...c.side] as Vec3, frame.y)] as const;
    let positive: boolean;
    if (c.kind === 'horizontal') positive = side[1] >= 0;
    else if (c.kind === 'vertical') positive = side[0] >= 0;
    else {
      const d = sub2(points[points.length - 1]!, points[0]!);
      positive = dot2(side, perp2(d)) >= 0;
    }
    chains.push({
      id: `${viewId}/${c.id}`,
      view: viewId,
      kind: c.kind,
      points,
      offset: positive ? Math.abs(c.offset) : -Math.abs(c.offset),
      ...(c.overall === undefined ? {} : { overall: c.overall }),
      ...(c.marks === undefined ? {} : { marks: c.marks.map(P) }),
    });
  }
  const symbols: PitchSymbolInput[] = (domain.pitches ?? []).map((p) => ({
    id: `${viewId}/${p.id}`,
    view: viewId,
    at: P(p.at),
    pitch: p.pitch,
    rises: dot3([...p.rises] as Vec3, frame.x) >= 0 ? 'right' : 'left',
  }));
  const bounds: Bounds2 | null = lo[0] <= hi[0] ? { min: lo, max: hi } : null;
  return { overlay, chains, symbols, bounds };
}

/**
 * The drawing stage of one engine: its caches (plain data, valid for as long as the body keys
 * are, whatever the kernel instance) and the requests. The engine gives it a `DrawingHost` per
 * request.
 */
export class DrawingStage {
  readonly #views: Lru<ProjectResult>;
  readonly #refs: Lru<RefEntry>;
  readonly #picks: Lru<BodyPick>;
  readonly stats: DrawingStats = { projectOps: 0, projectHits: 0, resolveOps: 0, pickOps: 0 };

  /**
   * The caches' sizes (tests make them small). They are only caches: a request reads what it
   * needs from its own results, so one that needs more entries than a cache keeps still works.
   */
  constructor(limits: { views?: number; refs?: number; picks?: number } = {}) {
    this.#views = new Lru(limits.views ?? MAX_VIEWS);
    this.#refs = new Lru(limits.refs ?? MAX_REFS);
    this.#picks = new Lru(limits.picks ?? MAX_PICKS);
  }

  /** One view of a sheet, its dimensions, and its picking data when asked for. */
  async view(
    host: DrawingHost,
    document: ManufaktureDocument,
    drawing: Drawing,
    sheet: Sheet,
    view: DrawingView,
    options: { pick?: boolean } = {},
  ): Promise<DrawingViewResult> {
    const diagnostics: DrawingDiagnostic[] = [];
    // A domain view's frame, section and bodies come from its domain (format v15).
    let domain: DomainViewOutput | null = null;
    let source: { bodies: DrawingBody[]; diagnostics: DrawingDiagnostic[] };
    const isDomain = isDomainViewSource(view.source);
    if (isDomainViewSource(view.source)) {
      const got = await host.domainView(view.source);
      domain = got.output;
      source = { bodies: got.bodies, diagnostics: got.diagnostics };
    } else {
      source = await host.bodies(view.source);
    }
    const { direction, up } =
      domain === null
        ? viewDirection(view)
        : {
            direction: [...domain.direction] as Vec3,
            up: [...domain.up] as Vec3,
          };
    const frame = viewFrame({ direction, up });
    const scale = evaluateScale(view.scale, host.variables);
    if (!scale.ok) {
      diagnostics.push({
        code: 'expression',
        severity: 'error',
        subject: view.id,
        field: scale.field,
        message: `The scale of ${view.id} does not evaluate: ${scale.message}`,
      });
    }
    let section: { origin: Vec3; normal: Vec3 } | undefined;
    let sectionFailed = false;
    if (domain?.section !== undefined) {
      // Core's convention (the normal points into the removed side); the kernel keeps its side.
      section = {
        origin: [...domain.section.origin] as Vec3,
        normal: mul3(unit3([...domain.section.normal] as Vec3), -1),
      };
    } else if (!isDomain && view.options.section !== undefined) {
      const r = evaluateField(
        view.options.section.offset,
        'length',
        ['options', 'section', 'offset'],
        host.variables,
      );
      if (r.ok) {
        const n = unit3(view.options.section.normal);
        // Core removes the side the normal points to; the kernel keeps the side its normal does.
        section = { origin: mul3(n, r.value), normal: mul3(n, -1) };
      } else {
        sectionFailed = true;
        diagnostics.push({
          code: 'expression',
          severity: 'error',
          subject: view.id,
          field: ['options', 'section', 'offset'],
          message: `The section offset of ${view.id} does not evaluate: ${r.error.message}`,
        });
      }
    }

    diagnostics.push(...source.diagnostics.map((d) => ({ ...d, subject: view.id })));
    const bodies = source.bodies;
    const items: DrawingItem[] = bodies.map((b, item) => ({
      item,
      key: b.key,
      body: b.body,
      ...(b.instance === undefined ? {} : { instance: b.instance }),
      pose: b.pose,
      bodyKey: b.bodyKey,
    }));

    let projected: ProjectResult = { keys: [], edges: [], bounds: null };
    let cached = false;
    if (bodies.length === 0 && isDomain) {
      // A domain view of analytic parts only (a framing elevation), or one its domain could not
      // draw (reported already): nothing to project.
    } else if (bodies.length === 0) {
      diagnostics.push({
        code: 'empty-view',
        severity: 'warning',
        subject: view.id,
        message: `${view.id} shows no bodies`,
      });
    } else if (!sectionFailed) {
      const key = hashValue({
        stage: DRAWING_STAGE_VERSION,
        versions: host.versions,
        implementation: REGEN_IMPLEMENTATION_VERSION,
        items: bodies.map((b) => [b.key, b.bodyKey, b.pose]),
        direction,
        up,
        hidden: view.options.hidden,
        smooth: view.options.smooth,
        section: section ?? null,
      });
      const hit = this.#views.get(key);
      if (hit !== undefined) {
        projected = hit;
        cached = true;
        this.stats.projectHits++;
      } else {
        const op: KernelOp = {
          op: 'project',
          items: bodies.map((b) => ({ shape: b.shape, transform: b.pose, key: b.key })),
          view: { direction, up },
          hidden: view.options.hidden,
          smooth: view.options.smooth,
          ...(section === undefined ? {} : { section }),
        };
        this.stats.projectOps++;
        const [r] = await host.run([op], bodies);
        if (r!.ok) {
          projected = r!.value as ProjectResult;
          this.#views.set(key, projected);
        } else {
          diagnostics.push({
            code: 'kernel',
            severity: 'error',
            subject: view.id,
            message: `${view.id} could not be projected: ${r!.error.message}`,
          });
        }
      }
    }

    const dims = sheet.dimensions.filter((d) => d.view === view.id);
    const shownPart = 'part' in view.source ? view.source.part : null;
    const dimensions = await this.#dimensions(
      host,
      document,
      dims.map((d) => {
        const text = insertCallout(document, shownPart, d);
        return text === null ? d : { ...d, text };
      }),
      bodies,
      frame,
      scale.ok ? scale.scale : null,
    );
    const pick = options.pick ? await this.#pick(host, bodies, frame) : null;

    const drawn = domain === null ? null : domainParts(domain, frame, view.id);
    if (drawn !== null && drawn.overlay.length === 0 && bodies.length === 0) {
      diagnostics.push({
        code: 'empty-view',
        severity: 'warning',
        subject: view.id,
        message: `${view.id} shows nothing`,
      });
    }

    let input: ViewInput | null = null;
    if (scale.ok) {
      const s = scale.scale.paper / scale.scale.model;
      const b = unionBounds2(projected.bounds, drawn?.bounds ?? null) ?? {
        min: [0, 0] as Vec2,
        max: [0, 0] as Vec2,
      };
      const centre: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
      const sections = projected.sections?.map((x) => ({
        item: x.item,
        loops: x.faces.flatMap((f) => [f.outer, ...f.holes]),
      }));
      input = {
        id: view.id,
        ...(view.label === undefined ? {} : { label: view.label }),
        edges: projected.edges,
        bounds: b,
        scale: scale.scale,
        // Core anchors a view at its model origin; packages/drawing at the centre of its bounds.
        position: [view.position[0] + s * centre[0], view.position[1] + s * centre[1]],
        ...(sections === undefined ? {} : { sections }),
        ...(drawn === null || drawn.overlay.length === 0 ? {} : { overlay: drawn.overlay }),
        display: { hidden: view.options.hidden, smooth: view.options.smooth ? 'thin' : 'omit' },
      };
    }

    return {
      generation: host.generation,
      drawingId: drawing.id,
      sheetId: sheet.id,
      viewId: view.id,
      frame,
      scale: scale.ok ? scale.scale : null,
      items,
      edges: projected.edges,
      bounds: projected.bounds,
      ...(projected.sections === undefined ? {} : { sections: projected.sections }),
      diagnostics,
      dimensions,
      input,
      pick,
      cached,
      ...(drawn === null ? {} : { chains: drawn.chains, symbols: drawn.symbols }),
      ...(domain?.titleNote === undefined ? {} : { titleNote: domain.titleNote }),
    };
  }

  /** Every view of a sheet, then the sheet laid out by `packages/drawing`. */
  async sheet(
    host: DrawingHost,
    document: ManufaktureDocument,
    drawing: Drawing,
    sheet: Sheet,
    options: { pick?: boolean } = {},
  ): Promise<DrawingSheetResult> {
    const views: DrawingViewResult[] = [];
    for (const view of sheet.views)
      views.push(await this.view(host, document, drawing, sheet, view, options));
    const diagnostics: DrawingDiagnostic[] = [];
    const size = sheetInput(sheet, host.variables);
    let titleBlock: TitleBlockInput | false = false;
    if (sheet.titleBlock !== undefined) {
      const t = titleBlockInput(sheet.titleBlock);
      // The sheet's place in its drawing ("2 / 4"), unless the title block gives its own.
      const index = drawing.sheets.findIndex((s) => s.id === sheet.id);
      titleBlock =
        t.input.sheet === undefined && index >= 0
          ? { ...t.input, sheet: `${index + 1} / ${drawing.sheets.length}` }
          : t.input;
      if (t.unknown.length > 0) {
        diagnostics.push({
          code: 'title-field',
          severity: 'warning',
          subject: sheet.id,
          labels: t.unknown,
          message: `The title block has no cell for ${t.unknown.join(', ')}`,
        });
      }
    }
    if (!size.ok) {
      diagnostics.push(size.diagnostic);
      return {
        generation: host.generation,
        drawingId: drawing.id,
        sheetId: sheet.id,
        views,
        diagnostics,
        input: null,
        display: null,
      };
    }
    const placed = new Map(sheet.views.map((v) => [v.id, v.position]));
    const notes: NoteInput[] = sheet.notes.map((n: Note) => {
      const origin = n.view === undefined ? undefined : placed.get(n.view);
      const at: Vec2 =
        origin === undefined
          ? [n.position[0], n.position[1]]
          : [origin[0] + n.position[0], origin[1] + n.position[1]];
      return { id: n.id, text: n.text, at };
    });
    // Title block notes (the construction disclaimer), each once: the domains the sheet shows,
    // whether or not their views drew, and any a drawn domain view added.
    const titleNotes = [
      ...new Set([
        ...host.titleNotes(sheet.views.map((v) => v.source)),
        ...views.flatMap((v) => (v.titleNote === undefined ? [] : [v.titleNote])),
      ]),
    ];
    const placedViews = views.filter((v) => v.input !== null);
    const input: DrawingInput = {
      sheet: size.sheet,
      projection: 'third',
      views: placedViews.map((v) => v.input!),
      dimensions: views.flatMap((v) =>
        v.dimensions.flatMap((d) => (d.input === null ? [] : [d.input])),
      ),
      chains: placedViews.flatMap((v) => v.chains ?? []),
      symbols: placedViews.flatMap((v) => v.symbols ?? []),
      notes,
      titleBlock,
      ...(titleNotes.length === 0 ? {} : { disclaimer: titleNotes.join(' ') }),
      format: valueFormat(document.units),
    };
    return {
      generation: host.generation,
      drawingId: drawing.id,
      sheetId: sheet.id,
      views,
      diagnostics,
      input,
      display: layoutSheet(input),
    };
  }

  async #dimensions(
    host: DrawingHost,
    document: ManufaktureDocument,
    dims: readonly Dimension[],
    bodies: readonly DrawingBody[],
    frame: ViewFrame,
    scale: Scale | null,
  ): Promise<DimensionResult[]> {
    const bodyOf = (ref: DimensionRef): DrawingBody | undefined =>
      bodies.find((b) => b.body === ref.body && b.instance === ref.instance?.[0]);

    // What is not cached: resolve (edges, faces) or find (vertices) first, then measure. This
    // request reads its own entries from `entries`, never back from the cache, which may have
    // evicted some of them already.
    const entries = new Map<string, RefEntry>();
    const wanted = new Map<string, { body: DrawingBody; ref: DimensionRef }>();
    for (const d of dims) {
      for (const ref of d.refs) {
        const body = bodyOf(ref);
        if (body === undefined) continue;
        const key = refKey(body.bodyKey, ref);
        if (entries.has(key) || wanted.has(key)) continue;
        const hit = this.#refs.get(key);
        if (hit === undefined) wanted.set(key, { body, ref });
        else entries.set(key, hit);
      }
    }
    if (wanted.size > 0) {
      for (const [key, entry] of await this.#resolve(host, wanted)) {
        entries.set(key, entry);
        this.#refs.set(key, entry);
      }
    }

    return dims.map((dim): DimensionResult => {
      const result: DimensionResult = {
        dimensionId: dim.id,
        viewId: dim.view,
        kind: dim.kind,
        outcome: 'exact',
        references: [],
        errors: [],
        warnings: [],
        value: null,
        input: null,
      };
      const geometry: RefGeometry[] = [];
      dim.refs.forEach((ref: DimensionRef, i: number) => {
        const referenceId = `refs.${i}`;
        const target = refTarget(ref);
        const body = bodyOf(ref);
        if (body === undefined) {
          const where =
            ref.instance === undefined ? ref.body : `${ref.instance.join('/')}/${ref.body}`;
          result.errors.push({
            code: 'reference-lost',
            referenceId,
            target,
            missing: [where],
            message: `${dim.id}: body ${where} is not in ${dim.view}: re-pick it`,
          });
          return;
        }
        const entry = entries.get(refKey(body.bodyKey, ref))!;
        if (!entry.ok) {
          if (entry.status === 'lost') {
            result.errors.push({
              code: 'reference-lost',
              referenceId,
              target,
              missing: entry.missing,
              message: entry.message,
            });
          } else if (entry.status === 'ambiguous') {
            result.errors.push({
              code: 'reference-ambiguous',
              referenceId,
              target,
              candidates: entry.candidates,
              message: entry.message,
            });
          } else {
            result.errors.push({
              code: 'invalid',
              referenceId,
              message: `${dim.id}: ${entry.message}`,
            });
          }
          return;
        }
        result.references.push({ referenceId, target, via: entry.via, fragile: entry.fragile });
        if (entry.via !== 'exact' || entry.fragile) {
          result.warnings.push({
            code: 'reference',
            referenceId,
            target,
            via: entry.via,
            fragile: entry.fragile,
            message: entry.fragile
              ? `${target} rests on a positional name and may move after an edit`
              : `${target} resolved by ${entry.via}`,
          });
        }
        geometry.push(placeGeometry(body.pose, entry.geometry));
      });
      if (result.errors.length > 0) {
        result.outcome = result.errors.some((e) => e.code === 'reference-ambiguous')
          ? 'ambiguous'
          : result.errors.some((e) => e.code === 'reference-lost')
            ? 'lost'
            : 'error';
        return result;
      }
      if (scale === null) {
        result.outcome = 'error';
        result.errors.push({
          code: 'invalid',
          message: `${dim.id}: its view's scale does not evaluate`,
        });
        return result;
      }
      const s = scale.paper / scale.model;
      const built = dimensionInput(dim, geometry, frame, s, valueFormat(document.units, dim));
      if (!built.ok) {
        result.outcome = 'error';
        result.errors.push({ code: 'invalid', message: built.message });
        return result;
      }
      result.warnings.push(...built.warnings);
      result.value = built.value;
      result.input = built.input;
      result.outcome = result.warnings.length > 0 ? 'warning' : 'exact';
      return result;
    });
  }

  /** Resolve references on their bodies, then measure what resolved: every outcome, by key. */
  async #resolve(
    host: DrawingHost,
    wanted: Map<string, { body: DrawingBody; ref: DimensionRef }>,
  ): Promise<Map<string, RefEntry>> {
    const out = new Map<string, RefEntry>();
    const list = [...wanted];
    const bodies = list.map(([, w]) => w.body);
    const ops: KernelOp[] = list.map(([, { body, ref }]): KernelOp =>
      'vertex' in ref
        ? {
            op: 'connector',
            shape: body.shape,
            connectors: [
              {
                origin:
                  ref.vertex.ordinal === undefined
                    ? { faces: ref.vertex.faces }
                    : { faces: ref.vertex.faces, ordinal: ref.vertex.ordinal },
                inference: 'vertex',
              },
            ],
          }
        : {
            op: 'resolve',
            shape: body.shape,
            refs: ['edge' in ref ? (ref.edge as TopoRef) : (ref.face as TopoRef)],
          },
    );
    this.stats.resolveOps += ops.length;
    const replies = await host.run(ops, bodies);
    const measure: {
      key: string;
      body: DrawingBody;
      kind: 'edge' | 'face';
      index: number;
      via: ReferenceResolution['via'];
      fragile: boolean;
    }[] = [];
    list.forEach(([key, { body, ref }], j) => {
      const r = replies[j]!;
      const target = refTarget(ref);
      if (!r.ok) {
        out.set(key, { ok: false, status: 'invalid', message: r.error.message });
        return;
      }
      if ('vertex' in ref) {
        const report = (r.value as { results: ConnectorReport[] }).results[0]!;
        if (report.ok) {
          out.set(key, {
            ok: true,
            via: report.via,
            fragile: report.fragile,
            geometry: { kind: 'point', point: report.frame.origin },
          });
        } else if (report.status === 'lost') {
          out.set(key, {
            ok: false,
            status: 'lost',
            missing: [...report.missing],
            message: `${target} is lost: re-pick it`,
          });
        } else if (report.status === 'ambiguous') {
          out.set(key, {
            ok: false,
            status: 'ambiguous',
            candidates: [...report.candidates],
            message: `${target} is ambiguous: re-pick it`,
          });
        } else {
          out.set(key, { ok: false, status: 'invalid', message: report.message });
        }
        return;
      }
      const report = (r.value as { results: ReferenceReport[] }).results[0]!;
      if (report.ok) {
        measure.push({
          key,
          body,
          kind: 'edge' in ref ? 'edge' : 'face',
          index: report.index,
          via: report.via,
          fragile: report.fragile,
        });
      } else if (report.status === 'lost') {
        out.set(key, {
          ok: false,
          status: 'lost',
          missing: [...report.missing],
          message: `${target} is lost: re-pick it`,
        });
      } else if (report.status === 'ambiguous') {
        out.set(key, {
          ok: false,
          status: 'ambiguous',
          candidates: [...report.candidates],
          message: `${target} is ambiguous: re-pick it`,
        });
      } else {
        out.set(key, { ok: false, status: 'invalid', message: report.message });
      }
    });
    if (measure.length === 0) return out;
    this.stats.resolveOps += measure.length;
    const measured = await host.run(
      measure.map((m): KernelOp => ({
        op: 'measure',
        shape: m.body.shape,
        targets: [{ kind: m.kind, index: m.index }],
      })),
      measure.map((m) => m.body),
    );
    const geometries = measure.map((m, j) => {
      const r = measured[j]!;
      return r.ok ? measuredGeometry(r.value as MeasureResult) : null;
    });
    await this.#cylinderExtents(host, measure, geometries);
    measure.forEach((m, j) => {
      const r = measured[j]!;
      const geometry = geometries[j]!;
      out.set(
        m.key,
        geometry === null
          ? {
              ok: false,
              status: 'invalid',
              message: r.ok ? 'it could not be measured' : r.error.message,
            }
          : { ok: true, via: m.via, fragile: m.fragile, geometry },
      );
    });
    return out;
  }

  /**
   * A cylindrical face's axial extent and arc from its boundary edges (as picking finds them),
   * in place of the area estimate `measuredGeometry` gives, which is exact only for a whole
   * cylinder. Where the topology or the edges cannot be measured the estimate stays.
   */
  async #cylinderExtents(
    host: DrawingHost,
    measure: readonly { body: DrawingBody; kind: 'edge' | 'face'; index: number }[],
    geometries: (RefGeometry | null)[],
  ): Promise<void> {
    const faces = measure.flatMap((m, j) => {
      const g = geometries[j];
      return m.kind === 'face' && g?.kind === 'cylinder'
        ? [{ j, body: m.body, index: m.index }]
        : [];
    });
    if (faces.length === 0) return;
    const bodies = [...new Map(faces.map((f) => [f.body.shape, f.body])).values()];
    this.stats.resolveOps += bodies.length;
    const topologies = await host.run(
      bodies.map((b): KernelOp => ({ op: 'topology', shape: b.shape })),
      bodies,
    );
    const topologyOf = new Map(
      bodies.map((b, i) => {
        const r = topologies[i]!;
        return [b.shape, r.ok ? (r.value as Topology) : null] as const;
      }),
    );
    const wanted = faces.flatMap((f) => {
      const topology = topologyOf.get(f.body.shape) ?? null;
      const edges = topology?.edges.filter((e) => e.faces.includes(f.index)) ?? [];
      return edges.length === 0 ? [] : [{ ...f, seam: edges.some((e) => e.seam), edges }];
    });
    if (wanted.length === 0) return;
    this.stats.resolveOps += wanted.length;
    const measured = await host.run(
      wanted.map((w): KernelOp => ({
        op: 'measure',
        shape: w.body.shape,
        targets: w.edges.map((e) => ({ kind: 'edge' as const, index: e.index })),
      })),
      wanted.map((w) => w.body),
    );
    wanted.forEach((w, i) => {
      const r = measured[i]!;
      const g = geometries[w.j]!;
      if (!r.ok || g.kind !== 'cylinder') return;
      const points = (r.value as MeasureResult).items.flatMap((item) =>
        item.ok && item.kind === 'edge' ? edgeSamples(item) : [],
      );
      const extent = cylinderExtent(g.origin, g.axis, points, w.seam);
      if (extent !== null) geometries[w.j] = { ...g, ...extent };
    });
  }

  /** Every body's pick data (cached by body key), placed at its pose. */
  async #pick(
    host: DrawingHost,
    bodies: readonly DrawingBody[],
    frame: ViewFrame,
  ): Promise<ViewPickData> {
    // This request reads its bodies' data from `known`, never back from the cache, which may
    // have evicted some of them already (a view of more bodies than it keeps).
    const known = new Map<string, BodyPick>();
    const wanted = new Map<string, DrawingBody>();
    for (const b of bodies) {
      if (known.has(b.bodyKey) || wanted.has(b.bodyKey)) continue;
      const hit = this.#picks.get(b.bodyKey);
      if (hit === undefined) wanted.set(b.bodyKey, b);
      else known.set(b.bodyKey, hit);
    }
    const missing = [...wanted.values()];
    if (missing.length > 0) {
      const ops: KernelOp[] = missing.flatMap((b): KernelOp[] => [
        host.deflection === undefined
          ? { op: 'tessellate', shape: b.shape }
          : { op: 'tessellate', shape: b.shape, deflection: host.deflection },
        { op: 'topology', shape: b.shape },
      ]);
      this.stats.pickOps += ops.length;
      const replies = await host.run(ops, missing);
      const meshes = missing.map((b, i) => {
        const mesh = replies[2 * i]!;
        const topo = replies[2 * i + 1]!;
        if (!mesh.ok) throw new Error(`picking data of ${b.key} failed: ${mesh.error.message}`);
        if (!topo.ok) throw new Error(`picking data of ${b.key} failed: ${topo.error.message}`);
        return { mesh: mesh.value as MeshData, topology: topo.value as Topology };
      });
      // The references a click on each edge, vertex and cylindrical face stores.
      const picks: { body: number; kind: 'edge' | 'vertex' | 'face'; index: number }[] = [];
      meshes.forEach(({ topology }, body) => {
        for (const e of topology.edges) picks.push({ body, kind: 'edge', index: e.index });
        for (const v of topology.vertices) picks.push({ body, kind: 'vertex', index: v.index });
        for (const f of topology.faces)
          if (f.surface === 'cylinder') picks.push({ body, kind: 'face', index: f.index });
      });
      this.stats.pickOps += picks.length;
      const refs = await host.run(
        picks.map((p): KernelOp => ({
          op: 'pick',
          shape: missing[p.body]!.shape,
          kind: p.kind,
          index: p.index,
        })),
        missing,
      );
      const data: BodyPick[] = missing.map(() => ({ edges: [], vertices: [], cylinders: [] }));
      const edgePoints = (mesh: MeshData, index: number): Vec3[] => {
        const first = mesh.edgeRanges[2 * (index - 1)] ?? 0;
        const count = mesh.edgeRanges[2 * (index - 1) + 1] ?? 0;
        const out: Vec3[] = [];
        for (let k = first; k < first + count; k++) {
          out.push([
            mesh.edgePositions[3 * k]!,
            mesh.edgePositions[3 * k + 1]!,
            mesh.edgePositions[3 * k + 2]!,
          ]);
        }
        return out;
      };
      picks.forEach((p, j) => {
        const r = refs[j]!;
        const ref = r.ok ? (r.value as { ref: unknown }).ref : null;
        if (ref === null) return;
        const { mesh, topology } = meshes[p.body]!;
        const out = data[p.body]!;
        if (p.kind === 'edge') {
          const points = edgePoints(mesh, p.index);
          if (points.length > 0) out.edges.push({ ref: ref as EdgeRef, points });
        } else if (p.kind === 'vertex') {
          out.vertices.push({
            ref: ref as VertexRef,
            point: topology.vertices[p.index - 1]!.point,
          });
        } else {
          const f = topology.faces[p.index - 1]!;
          const axis = unit3(f.axis!);
          const o = f.axisOrigin ?? f.centroid;
          // The axial extent and the angular range: the face's edges' points about the axis.
          const edges = topology.edges.filter((e) => e.faces.includes(f.index));
          const points = edges.flatMap((e) => edgePoints(mesh, e.index));
          const extent = cylinderExtent(
            o,
            axis,
            points,
            edges.some((e) => e.seam),
          );
          if (extent === null) return;
          out.cylinders.push({
            ref: ref as FaceRef,
            start: sub3(extent.origin, mul3(axis, extent.length / 2)),
            axis,
            length: extent.length,
            radius: f.radius!,
            ...extent.arc,
          });
        }
      });
      missing.forEach((b, i) => {
        known.set(b.bodyKey, data[i]!);
        this.#picks.set(b.bodyKey, data[i]!);
      });
    }
    const items = bodies.map((b, item): PickItem => {
      const data = known.get(b.bodyKey)!;
      const p = (x: Vec3) => placePoint(b.pose, x);
      return {
        item,
        body: b.body,
        ...(b.instance === undefined ? {} : { instance: b.instance }),
        edges: data.edges.map((e) => ({ ref: e.ref, points: e.points.map(p) })),
        vertices: data.vertices.map((v) => ({ ref: v.ref, point: p(v.point) })),
        cylinders: data.cylinders.map((c) => ({
          ref: c.ref,
          start: p(c.start),
          axis: placeDirection(b.pose, c.axis),
          length: c.length,
          radius: c.radius,
          from: placeDirection(b.pose, c.from),
          sweep: c.sweep,
        })),
      };
    });
    return { frame, items };
  }
}

/** The view and its sheet in a drawing, or null. */
export function findView(
  drawing: Drawing,
  viewId: string,
): { sheet: Sheet; view: DrawingView } | null {
  for (const sheet of drawing.sheets) {
    const view = sheet.views.find((v) => v.id === viewId);
    if (view) return { sheet, view };
  }
  return null;
}
