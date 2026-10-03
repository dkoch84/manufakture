// The drawing workspace's logic, free of React (M4 plan, T4.4g): the commands that make drawings,
// sheets, views, dimensions and notes; paper and view coordinates; where a dimension goes when it
// is placed or dragged (core's `offset` and `at` rules); and what a click on the sheet hits.
//
// Coordinates: paper millimetres from the sheet's bottom-left corner, y up (the display list's);
// view coordinates are model millimetres in the view's frame (regen's `projectPoint`). A view is
// anchored at its model origin, so `paper = view.position + s * v`, `s` paper mm per model mm.

import {
  DIMENSION_COUNTER,
  DRAWING_COUNTER,
  NOTE_COUNTER,
  SHEET_COUNTER,
  SHEET_SIZE_MM,
  SHEET_SIZES,
  STANDARD_VIEWS,
  STANDARD_VIEW_NAMES,
  VIEW_COUNTER,
  previewIds,
  storedExpression,
  type Command,
  type Dimension,
  type DimensionKind,
  type DimensionRef,
  type DisplayUnits,
  type Drawing,
  type DrawingView,
  type ManufaktureDocument,
  type Note,
  type Sheet,
  type SheetSize,
  type StandardViewName,
  type TitleBlock,
  type ViewDirection,
  type ViewScale,
  type ViewSource,
} from '@manufakture/core';
import type { DisplayItem, DisplayList } from '@manufakture/drawing';
import type {
  DimensionResult,
  DrawingSheetResult,
  DrawingViewResult,
  PickItem,
  PickKind,
} from '@manufakture/regen';

export type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

// Small vector helpers -------------------------------------------------------------------------

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
const unit2 = (a: Vec2): Vec2 => {
  const n = len2(a);
  return n > 0 ? mul2(a, 1 / n) : a;
};
const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
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

/** Distance from `p` to the segment `a`-`b`. */
function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub2(b, a);
  const l = dot2(ab, ab);
  const t = l > 0 ? Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / l)) : 0;
  return len2(sub2(p, add2(a, mul2(ab, t))));
}

// Names and labels ----------------------------------------------------------------------------

export const DIMENSION_KIND_LABELS: Record<DimensionKind, string> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  aligned: 'Aligned',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

export const VIEW_DIRECTION_LABELS: Record<StandardViewName, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
  isometric: 'Isometric',
};

export const SHEET_SIZE_LABELS: Record<(typeof SHEET_SIZES)[number], string> = {
  A4: 'A4',
  A3: 'A3',
  A2: 'A2',
  A1: 'A1',
  A0: 'A0',
  letter: 'Letter',
  tabloid: 'Tabloid',
};

/** The title block fields a new sheet gets, in this order; empty ones keep their cell blank. */
export const TITLE_FIELDS = ['Title', 'Drawn by', 'Date', 'Material'] as const;

/** How many model references a dimension of `kind` measures. */
export function refsNeeded(kind: DimensionKind): number {
  return kind === 'radius' || kind === 'diameter' ? 1 : 2;
}

/** What a dimension of `kind` may pick: radius and diameter rounds; angles lines; linear anything. */
export function pickKinds(kind: DimensionKind): PickKind[] {
  if (kind === 'radius' || kind === 'diameter') return ['edge', 'face'];
  if (kind === 'angle') return ['edge'];
  return ['vertex', 'edge', 'face'];
}

/** What the dimension tool asks for next. */
export function pickPrompt(kind: DimensionKind, picked: number): string {
  const needed = refsNeeded(kind);
  if (picked >= needed) return 'Click where the dimension goes.';
  if (kind === 'radius' || kind === 'diameter') return 'Pick a circular edge or a cylinder.';
  if (kind === 'angle') return picked === 0 ? 'Pick the first line.' : 'Pick the second line.';
  return picked === 0 ? 'Pick the first edge or vertex.' : 'Pick the second edge or vertex.';
}

/** A view source in words: `Bracket`, `Shelf (2 bodies)`, `Assembly 1, exploded`. */
export function sourceLabel(doc: ManufaktureDocument, source: ViewSource): string {
  if ('part' in source) {
    const name = doc.parts.find((p) => p.id === source.part)?.name ?? source.part;
    if ('domain' in source) return `${name} (${source.domain} view)`;
    return source.bodies ? `${name} (${source.bodies.length} of its bodies)` : name;
  }
  const assembly = doc.assemblies.find((a) => a.id === source.assembly);
  const name = assembly?.name ?? source.assembly;
  if (source.explodedView === undefined) return name;
  const view = assembly?.explodedViews?.find((v) => v.id === source.explodedView);
  return `${name}, ${view?.name ?? source.explodedView}`;
}

// Sheets and drawings -------------------------------------------------------------------------

/** The paper size: the laid out sheet's when there is one, else the standard size's. */
export function sheetPaperSize(
  sheet: Pick<Sheet, 'size' | 'orientation'>,
  display?: Pick<DisplayList, 'width' | 'height'> | null,
): { width: number; height: number } {
  if (display) return { width: display.width, height: display.height };
  // A custom size is unknown until regen evaluates it: A4 stands in.
  const [short, long] = typeof sheet.size === 'string' ? SHEET_SIZE_MM[sheet.size] : [210, 297];
  return sheet.orientation === 'landscape'
    ? { width: long, height: short }
    : { width: short, height: long };
}

export interface SheetSettings {
  name: string;
  size: SheetSize;
  orientation: Sheet['orientation'];
  /** Title block values by label (`TITLE_FIELDS`); none: no title block. */
  title: Readonly<Record<string, string>> | null;
}

function titleBlockOf(title: Readonly<Record<string, string>>): TitleBlock {
  const labels = [
    ...TITLE_FIELDS,
    ...Object.keys(title).filter((k) => !TITLE_FIELDS.includes(k as never)),
  ];
  return { fields: labels.map((label) => ({ label, value: title[label] ?? '' })) };
}

/** A title block's values by label. */
export function titleValues(block: TitleBlock | undefined): Record<string, string> {
  return Object.fromEntries((block?.fields ?? []).map((f) => [f.label, f.value]));
}

function sheetOf(id: string, settings: SheetSettings): Sheet {
  return {
    id,
    name: settings.name,
    size: settings.size,
    orientation: settings.orientation,
    ...(settings.title ? { titleBlock: titleBlockOf(settings.title) } : {}),
    views: [],
    dimensions: [],
    notes: [],
  };
}

/** A new drawing with one sheet; one command. */
export function newDrawingCommand(
  doc: ManufaktureDocument,
  name: string,
  sheet: Omit<SheetSettings, 'name'>,
): { command: Command; label: string; drawingId: string; sheetId: string } {
  const [drawingId] = previewIds(doc.nextIds, DRAWING_COUNTER);
  const sheetId = 'sheet#1';
  const drawing: Drawing = {
    id: drawingId!,
    name: name.trim() || drawingId!,
    sheets: [sheetOf(sheetId, { ...sheet, name: 'Sheet 1' })],
    nextIds: { [SHEET_COUNTER]: 2 },
  };
  return {
    command: { type: 'addDrawing', drawing },
    label: `Add ${drawing.name}`,
    drawingId: drawing.id,
    sheetId,
  };
}

/** The name `+ Drawing` suggests: `Drawing n`, the first n not taken. */
export function newDrawingName(doc: ManufaktureDocument): string {
  const taken = new Set((doc.drawings ?? []).map((d) => d.name));
  for (let n = 1; ; n++) if (!taken.has(`Drawing ${n}`)) return `Drawing ${n}`;
}

/** Another sheet like `like` (size, orientation, title block), with no views. */
export function addSheetCommand(
  drawing: Drawing,
  like: Sheet | undefined,
): { command: Command; label: string; sheetId: string } {
  const [sheetId] = previewIds(drawing.nextIds, SHEET_COUNTER);
  const name = `Sheet ${drawing.sheets.length + 1}`;
  const sheet = sheetOf(sheetId!, {
    name,
    size: like?.size ?? 'A3',
    orientation: like?.orientation ?? 'landscape',
    title: like?.titleBlock ? titleValues(like.titleBlock) : null,
  });
  return {
    command: { type: 'addSheet', drawingId: drawing.id, sheet },
    label: `Add ${name} to ${drawing.name}`,
    sheetId: sheetId!,
  };
}

// Scales --------------------------------------------------------------------------------------

/**
 * A scale typed as `1:5`, `2:1`, `1 = 5` or `1-1/2" = 1'`: two length expressions, paper side
 * first, in the document's units when bare.
 */
export function parseScaleText(
  text: string,
  units: DisplayUnits,
): { ok: true; scale: ViewScale } | { ok: false; message: string } {
  const parts = text.includes('=') ? text.split('=') : text.split(':');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) {
    return { ok: false, message: 'Write a scale as 1:5, 2:1 or 1-1/2" = 1\'.' };
  }
  return {
    ok: true,
    scale: {
      paper: storedExpression(parts[0]!.trim(), units),
      model: storedExpression(parts[1]!.trim(), units),
    },
  };
}

/** A stored scale as it is typed: `1:5`, or `1-1/2" = 1'` when either side has a unit sign. */
export function scaleText(scale: ViewScale): string {
  const p = scale.paper.source;
  const m = scale.model.source;
  return /^[0-9.]+$/.test(p) && /^[0-9.]+$/.test(m) ? `${p}:${m}` : `${p} = ${m}`;
}

/** Paper mm per model mm of a regen view result, or null when its scale did not evaluate. */
export function scaleFactorOf(result: Pick<DrawingViewResult, 'scale'> | undefined): number | null {
  const s = result?.scale;
  return s ? s.paper / s.model : null;
}

// Views ---------------------------------------------------------------------------------------

/** A view direction's vectors (core's `STANDARD_VIEWS` for a named one). */
export function directionVectors(direction: ViewDirection): { direction: Vec3; up: Vec3 } {
  return typeof direction === 'string' ? STANDARD_VIEWS[direction] : direction;
}

/** The view's frame, as regen's `viewFrame` makes it: x right, y up on paper, z to the viewer. */
export function frameOf(direction: ViewDirection): { x: Vec3; y: Vec3; z: Vec3 } {
  const v = directionVectors(direction);
  const z = unit3(mul3(v.direction, -1));
  const x = unit3(cross3(unit3(v.up), z));
  return { x, y: cross3(z, x), z };
}

const same3 = (a: Vec3, b: Vec3) => norm3(sub3(unit3(a), unit3(b))) < 1e-9;

/** A direction as a standard view's name when it is one, else as vectors. */
export function namedDirection(direction: Vec3, up: Vec3): ViewDirection {
  for (const name of STANDARD_VIEW_NAMES) {
    const s = STANDARD_VIEWS[name];
    if (same3(s.direction, direction) && same3(s.up, up)) return name;
  }
  return {
    direction: [...direction] as [number, number, number],
    up: [...up] as [number, number, number],
  };
}

export type ProjectionSide = 'right' | 'left' | 'top' | 'bottom';

/**
 * The view projected from `parent` to the given side, third angle: the right view looks at the
 * parent's right side, and so on; front's right is `right`, its top is `top`.
 */
export function projectedDirection(parent: ViewDirection, side: ProjectionSide): ViewDirection {
  const f = frameOf(parent);
  switch (side) {
    case 'right':
      return namedDirection(mul3(f.x, -1), f.y);
    case 'left':
      return namedDirection(f.x, f.y);
    case 'top':
      return namedDirection(mul3(f.y, -1), mul3(f.z, -1));
    case 'bottom':
      return namedDirection(f.y, f.z);
  }
}

/** The gap between a parent view and a view projected from it, paper mm (our choice). */
export const PROJECTION_GAP = 25;

/**
 * Where a view projected from `parent` goes: on the parent's row (right, left) or column (top,
 * bottom), so the two stay aligned, clear of the parent by its size and `PROJECTION_GAP`.
 */
export function projectedPosition(
  parent: DrawingView,
  parentResult: DrawingViewResult | undefined,
  side: ProjectionSide,
): Vec2 {
  const s = scaleFactorOf(parentResult) ?? 1;
  const b = parentResult?.bounds;
  const w = b ? s * (b.max[0] - b.min[0]) : 50;
  const h = b ? s * (b.max[1] - b.min[1]) : 50;
  const [x, y] = parent.position;
  switch (side) {
    case 'right':
      return [x + w + PROJECTION_GAP, y];
    case 'left':
      return [x - w - PROJECTION_GAP, y];
    case 'top':
      return [x, y + h + PROJECTION_GAP];
    case 'bottom':
      return [x, y - h - PROJECTION_GAP];
  }
}

/** Where the first view of a sheet goes: left of the middle, a little above it. */
export function defaultViewPosition(paper: { width: number; height: number }, count: number): Vec2 {
  const step = 15 * count;
  return [paper.width * 0.25 + step, paper.height * 0.45 + step];
}

export interface NewView {
  source: ViewSource;
  direction: ViewDirection;
  scale: ViewScale;
  position: Vec2;
  hidden: boolean;
  smooth: boolean;
}

export function insertViewCommand(
  drawing: Drawing,
  sheet: Sheet,
  view: NewView,
): { command: Command; label: string; viewId: string } {
  const [viewId] = previewIds(drawing.nextIds, VIEW_COUNTER);
  const stored: DrawingView = {
    id: viewId!,
    source: view.source,
    direction: view.direction,
    scale: view.scale,
    position: [view.position[0], view.position[1]],
    options: { hidden: view.hidden, smooth: view.smooth },
  };
  return {
    command: { type: 'addView', drawingId: drawing.id, sheetId: sheet.id, view: stored },
    label: `Insert ${viewId} on ${sheet.name}`,
    viewId: viewId!,
  };
}

/** View coordinates (model mm) of a paper point. */
export function paperToView(view: Pick<DrawingView, 'position'>, s: number, p: Vec2): Vec2 {
  return [(p[0] - view.position[0]) / s, (p[1] - view.position[1]) / s];
}

/** The paper point of view coordinates. */
export function viewToPaper(view: Pick<DrawingView, 'position'>, s: number, v: Vec2): Vec2 {
  return [view.position[0] + s * v[0], view.position[1] + s * v[1]];
}

export interface PaperRect {
  min: Vec2;
  max: Vec2;
}

/** A view's projected bounds on paper, or null before it has any. */
export function viewPaperRect(
  view: Pick<DrawingView, 'position'>,
  result: Pick<DrawingViewResult, 'bounds' | 'scale'> | undefined,
): PaperRect | null {
  const s = scaleFactorOf(result);
  if (s === null || !result?.bounds) return null;
  return {
    min: viewToPaper(view, s, result.bounds.min),
    max: viewToPaper(view, s, result.bounds.max),
  };
}

const inside = (r: PaperRect, p: Vec2, margin: number) =>
  p[0] >= r.min[0] - margin &&
  p[0] <= r.max[0] + margin &&
  p[1] >= r.min[1] - margin &&
  p[1] <= r.max[1] + margin;

/** The view of the sheet whose bounds hold `p` (with `margin` paper mm round them), the nearest. */
export function viewAt(
  sheet: Sheet,
  result: DrawingSheetResult | null,
  p: Vec2,
  margin = 8,
): DrawingView | null {
  let best: { view: DrawingView; d: number } | null = null;
  for (const view of sheet.views) {
    const r = viewPaperRect(
      view,
      result?.views.find((v) => v.viewId === view.id),
    );
    if (!r || !inside(r, p, margin)) continue;
    const c: Vec2 = [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2];
    const d = len2(sub2(p, c));
    if (!best || d < best.d) best = { view, d };
  }
  return best?.view ?? null;
}

// Dimensions ----------------------------------------------------------------------------------

/** A pick made for a dimension: its reference, its view, and its anchor in view coordinates. */
export interface Picked {
  ref: DimensionRef;
  viewId: string;
  /** Where the dimension measures from, approximately, view coordinates (see `pickAnchor`). */
  anchor: Vec2;
  /** For angles: the picked edge as a line in view coordinates. */
  line?: readonly [Vec2, Vec2];
  /** Where it was clicked, paper mm (for the marker). */
  at: Vec2;
}

const project = (f: { x: Vec3; y: Vec3 }, p: Vec3): Vec2 => [dot3(p, f.x), dot3(p, f.y)];

/** The centre of the circle through three points, or null when they are on a line. */
function circumcentre(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const n = cross3(ab, ac);
  const nn = dot3(n, n);
  if (nn < 1e-12 * Math.max(1, dot3(ab, ab) * dot3(ac, ac))) return null;
  const t = add3(mul3(cross3(n, ab), dot3(ac, ac)), mul3(cross3(ac, n), dot3(ab, ab)));
  return add3(a, mul3(t, 1 / (2 * nn)));
}

/**
 * Where a picked reference anchors, in 3D, as regen anchors it: a vertex itself; a straight edge's
 * midpoint; a round edge's centre (through three of its points); a cylinder's axis midpoint. Only
 * placement uses it (the value comes from regen), so the mesh's polyline is close enough.
 */
export function pickAnchor(
  item: PickItem,
  ref: DimensionRef,
): { point: Vec3; line?: readonly [Vec3, Vec3] } | null {
  if ('vertex' in ref) {
    const v = item.vertices.find((x) => sameRef(x.ref, ref.vertex));
    return v ? { point: v.point } : null;
  }
  if ('edge' in ref) {
    const e = item.edges.find((x) => sameRef(x.ref, ref.edge));
    if (!e || e.points.length === 0) return null;
    const pts = e.points;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const closed = pts.length > 3 && norm3(sub3(first, last)) < 1e-6;
    const n = closed ? pts.length - 1 : pts.length;
    const mid = pts[Math.floor(n / 2)]!;
    const c = closed
      ? circumcentre(first, pts[Math.floor(n / 3)]!, pts[Math.floor((2 * n) / 3)]!)
      : pts.length > 2
        ? circumcentre(first, mid, last)
        : null;
    if (c) return { point: c };
    return { point: mul3(add3(first, last), 0.5), line: [first, last] };
  }
  const cyl = item.cylinders.find((x) => sameRef(x.ref, ref.face));
  if (!cyl) return null;
  return { point: add3(cyl.start, mul3(cyl.axis, cyl.length / 2)) };
}

function sameRef(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A pick as `Picked`: its anchor (and line) projected into the view. */
export function pickedOf(
  view: DrawingViewResult,
  hit: { item: number; ref: DimensionRef },
  at: Vec2,
): Picked | null {
  const item = view.pick?.items.find((x) => x.item === hit.item);
  if (!item || !view.pick) return null;
  const a = pickAnchor(item, hit.ref);
  if (!a) return null;
  const f = view.pick.frame;
  const o = f.origin;
  const P = (p: Vec3) => project(f, sub3(p, o));
  return {
    ref: hit.ref,
    viewId: view.viewId,
    anchor: P(a.point),
    ...(a.line ? { line: [P(a.line[0]), P(a.line[1])] as const } : {}),
    at,
  };
}

/** Core's linear `offset`: from the first anchor, along the measuring direction turned left. */
export function linearOffset(
  kind: 'horizontal' | 'vertical' | 'aligned',
  first: Vec2,
  second: Vec2,
  pointer: Vec2,
): number {
  const dir: Vec2 =
    kind === 'horizontal' ? [1, 0] : kind === 'vertical' ? [0, 1] : unit2(sub2(second, first));
  return round(dot2(sub2(pointer, first), perp2(dir)));
}

/** Two lines' meeting point, or null when parallel. */
function meet(l1: readonly [Vec2, Vec2], l2: readonly [Vec2, Vec2]): Vec2 | null {
  const d1 = sub2(l1[1], l1[0]);
  const d2 = sub2(l2[1], l2[0]);
  const det = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(det) < 1e-12 * len2(d1) * len2(d2)) return null;
  const r = sub2(l2[0], l1[0]);
  const t = (r[0] * d2[1] - r[1] * d2[0]) / det;
  return add2(l1[0], mul2(d1, t));
}

const round = (v: number) => Math.round(v * 100) / 100;
const roundPoint = (p: Vec2): [number, number] => [round(p[0]), round(p[1])];

/**
 * The new dimension for `picks` (all in one view), placed where the pointer is. Null, with why,
 * when it cannot be: an angle between parallel lines.
 */
export function newDimension(
  id: string,
  kind: DimensionKind,
  picks: readonly Picked[],
  view: Pick<DrawingView, 'id' | 'position'>,
  s: number,
  pointer: Vec2,
): { ok: true; dimension: Dimension } | { ok: false; message: string } {
  const paper = (v: Vec2) => viewToPaper(view, s, v);
  if (kind === 'radius' || kind === 'diameter') {
    const c = paper(picks[0]!.anchor);
    return {
      ok: true,
      dimension: {
        id,
        view: view.id,
        kind,
        refs: [picks[0]!.ref as never],
        at: roundPoint(sub2(pointer, c)),
      },
    };
  }
  if (kind === 'angle') {
    const [a, b] = picks as [Picked, Picked];
    const vertex = a.line && b.line ? meet(a.line, b.line) : null;
    if (!vertex)
      return { ok: false, message: 'An angle needs two straight edges that are not parallel.' };
    return {
      ok: true,
      dimension: {
        id,
        view: view.id,
        kind,
        refs: [a.ref as never, b.ref as never],
        at: roundPoint(sub2(pointer, paper(vertex))),
      },
    };
  }
  const [a, b] = picks as [Picked, Picked];
  return {
    ok: true,
    dimension: {
      id,
      view: view.id,
      kind,
      refs: [a.ref, b.ref],
      offset: linearOffset(kind, paper(a.anchor), paper(b.anchor), pointer),
    },
  };
}

export function addDimensionCommand(
  drawing: Drawing,
  sheet: Sheet,
  dimension: Dimension,
): { command: Command; label: string } {
  return {
    command: { type: 'addDimension', drawingId: drawing.id, sheetId: sheet.id, dimension },
    label: `Add ${DIMENSION_KIND_LABELS[dimension.kind].toLowerCase()} dimension ${dimension.id}`,
  };
}

/** The next dimension id of a drawing. */
export function nextDimensionId(drawing: Drawing): string {
  return previewIds(drawing.nextIds, DIMENSION_COUNTER)[0]!;
}

/** `dimension` with new references (a re-pick), its placement kept. */
export function repicked(dimension: Dimension, refs: readonly DimensionRef[]): Dimension {
  return { ...dimension, refs: refs as never } as Dimension;
}

/**
 * `dimension` placed at `pointer` (a drag), from where regen drew it: the anchors of its last
 * result. Null when it was not drawn (lost, or no result yet).
 */
export function draggedDimension(
  dimension: Dimension,
  result: DimensionResult | undefined,
  view: Pick<DrawingView, 'position'>,
  s: number,
  pointer: Vec2,
): Dimension | null {
  const input = result?.input;
  if (!input) return null;
  const paper = (v: Vec2) => viewToPaper(view, s, v);
  if (
    dimension.kind === 'horizontal' ||
    dimension.kind === 'vertical' ||
    dimension.kind === 'aligned'
  ) {
    if (!('points' in input) || input.kind === 'angle') return null;
    const [a, b] = input.points as unknown as [Vec2, Vec2];
    return { ...dimension, offset: linearOffset(dimension.kind, paper(a), paper(b), pointer) };
  }
  if (dimension.kind === 'radius' || dimension.kind === 'diameter') {
    let centre: Vec2 | null = null;
    if ('circle' in input) centre = input.circle.center;
    else if ('lines' in input) {
      const ends = input.lines.flat();
      centre = mul2(
        ends.reduce<Vec2>((acc, p) => add2(acc, p), [0, 0]),
        1 / ends.length,
      );
    }
    if (!centre) return null;
    return { ...dimension, at: roundPoint(sub2(pointer, paper(centre))) };
  }
  if (dimension.kind !== 'angle' || !('vertex' in input)) return null;
  return { ...dimension, at: roundPoint(sub2(pointer, paper(input.vertex))) };
}

// Notes ---------------------------------------------------------------------------------------

/** A note at `p`: in `view` (it moves with the view) when given, else on the sheet. */
export function addNoteCommand(
  drawing: Drawing,
  sheet: Sheet,
  text: string,
  p: Vec2,
  view: DrawingView | null,
): { command: Command; label: string; noteId: string } {
  const [noteId] = previewIds(drawing.nextIds, NOTE_COUNTER);
  const note: Note = {
    id: noteId!,
    ...(view ? { view: view.id } : {}),
    position: roundPoint(view ? sub2(p, view.position) : p),
    text,
  };
  return {
    command: { type: 'addNote', drawingId: drawing.id, sheetId: sheet.id, note },
    label: `Add ${noteId}`,
    noteId: noteId!,
  };
}

/** Where a note is on paper. */
export function notePaper(sheet: Sheet, note: Note): Vec2 {
  const view = note.view === undefined ? undefined : sheet.views.find((v) => v.id === note.view);
  return view ? add2(view.position, note.position) : note.position;
}

// Moving and deleting -------------------------------------------------------------------------

export type Owner =
  { kind: 'view'; id: string } | { kind: 'dimension'; id: string } | { kind: 'note'; id: string };

export function ownerOf(id: string): Owner | null {
  if (id.startsWith('view#')) return { kind: 'view', id };
  if (id.startsWith('dim#')) return { kind: 'dimension', id };
  if (id.startsWith('note#')) return { kind: 'note', id };
  return null;
}

/** The command that drags `owner` from `from` to `to` (paper mm), or null when nothing moves. */
export function dragCommand(
  drawing: Drawing,
  sheet: Sheet,
  result: DrawingSheetResult | null,
  owner: Owner,
  from: Vec2,
  to: Vec2,
): { command: Command; label: string } | null {
  const delta = sub2(to, from);
  if (len2(delta) < 0.25) return null;
  const base = { drawingId: drawing.id, sheetId: sheet.id };
  if (owner.kind === 'view') {
    const view = sheet.views.find((v) => v.id === owner.id);
    if (!view) return null;
    return {
      command: {
        type: 'moveView',
        ...base,
        viewId: view.id,
        position: roundPoint(add2(view.position, delta)),
      },
      label: `Move ${view.id}`,
    };
  }
  if (owner.kind === 'note') {
    const note = sheet.notes.find((n) => n.id === owner.id);
    if (!note) return null;
    return {
      command: {
        type: 'editNote',
        ...base,
        note: { ...note, position: roundPoint(add2(note.position, delta)) },
      },
      label: `Move ${note.id}`,
    };
  }
  const dim = sheet.dimensions.find((d) => d.id === owner.id);
  const view = dim && sheet.views.find((v) => v.id === dim.view);
  const viewResult = result?.views.find((v) => v.viewId === dim?.view);
  const s = scaleFactorOf(viewResult);
  if (!dim || !view || s === null) return null;
  const moved = draggedDimension(
    dim,
    viewResult?.dimensions.find((d) => d.dimensionId === dim.id),
    view,
    s,
    to,
  );
  if (!moved) return null;
  return { command: { type: 'editDimension', ...base, dimension: moved }, label: `Move ${dim.id}` };
}

/** The command that deletes `owner`, with what goes with it (a view takes its dimensions and notes). */
export function deleteCommand(
  drawing: Drawing,
  sheet: Sheet,
  owner: Owner,
): { command: Command; label: string } | null {
  const base = { drawingId: drawing.id, sheetId: sheet.id };
  if (owner.kind === 'dimension') {
    return {
      command: { type: 'deleteDimension', ...base, dimensionId: owner.id },
      label: `Delete ${owner.id}`,
    };
  }
  if (owner.kind === 'note') {
    return {
      command: { type: 'deleteNote', ...base, noteId: owner.id },
      label: `Delete ${owner.id}`,
    };
  }
  if (!sheet.views.some((v) => v.id === owner.id)) return null;
  // Core refuses a view that dimensions or notes are in: they go in the same batch, first.
  const commands: Command[] = [
    ...sheet.dimensions
      .filter((d) => d.view === owner.id)
      .map((d): Command => ({ type: 'deleteDimension', ...base, dimensionId: d.id })),
    ...sheet.notes
      .filter((n) => n.view === owner.id)
      .map((n): Command => ({ type: 'deleteNote', ...base, noteId: n.id })),
    { type: 'deleteView', ...base, viewId: owner.id },
  ];
  return {
    command: commands.length === 1 ? commands[0]! : { type: 'batch', commands },
    label: `Delete ${owner.id}`,
  };
}

// Hits ----------------------------------------------------------------------------------------

/** How near, paper mm, a click must be to a dimension's or note's lines or text to grab it. */
export const HIT_TOLERANCE = 2;

/** Distance from `p` to a display item, paper mm (text: to a box round it, roughly). */
export function itemDistance(item: DisplayItem, p: Vec2): number {
  switch (item.kind) {
    case 'line':
      return segmentDistance(p, item.a, item.b);
    case 'polyline': {
      let d = Infinity;
      const pts = item.points;
      for (let i = 0; i + 1 < pts.length; i++)
        d = Math.min(d, segmentDistance(p, pts[i]!, pts[i + 1]!));
      if (item.closed && pts.length > 2)
        d = Math.min(d, segmentDistance(p, pts[pts.length - 1]!, pts[0]!));
      return pts.length === 1 ? len2(sub2(p, pts[0]!)) : d;
    }
    case 'arc':
      return Math.abs(len2(sub2(p, item.center)) - item.radius);
    case 'ellipseArc':
      return Math.max(0, len2(sub2(p, item.center)) - item.major);
    case 'text': {
      // Helvetica's average advance is about half the font size; the cap height is ~0.72 of it.
      const w = 0.7 * item.height * item.text.length;
      const dir: Vec2 = [Math.cos(item.rotation), Math.sin(item.rotation)];
      const up = perp2(dir);
      const along = item.anchor === 'start' ? w / 2 : item.anchor === 'end' ? -w / 2 : 0;
      const lift =
        item.baseline === 'bottom'
          ? item.height / 2
          : item.baseline === 'top'
            ? -item.height / 2
            : 0;
      const c = add2(add2(item.at, mul2(dir, along)), mul2(up, lift));
      const local = sub2(p, c);
      const dx = Math.max(0, Math.abs(dot2(local, dir)) - w / 2);
      const dy = Math.max(0, Math.abs(dot2(local, up)) - item.height / 2);
      return Math.hypot(dx, dy);
    }
    case 'hatch':
      return Infinity;
  }
}

/**
 * What a click at `p` grabs: the nearest dimension or note within `HIT_TOLERANCE`, else the view
 * whose bounds hold it.
 */
export function hitTest(
  display: DisplayList | null,
  sheet: Sheet,
  result: DrawingSheetResult | null,
  p: Vec2,
): Owner | null {
  let best: { owner: string; d: number } | null = null;
  for (const item of display?.items ?? []) {
    const owner = item.owner;
    if (!owner || !(owner.startsWith('dim#') || owner.startsWith('note#'))) continue;
    const d = itemDistance(item, p);
    if (d <= HIT_TOLERANCE && (!best || d < best.d)) best = { owner, d };
  }
  if (best) return ownerOf(best.owner);
  const view = viewAt(sheet, result, p, 2);
  return view ? { kind: 'view', id: view.id } : null;
}

// What the panels list -----------------------------------------------------------------------

/** Every view source the document offers, with a label and a key for a `<select>`. */
export function viewSources(
  doc: ManufaktureDocument,
): { key: string; label: string; source: ViewSource }[] {
  const out: { key: string; label: string; source: ViewSource }[] = [];
  for (const p of doc.parts)
    out.push({ key: `part:${p.id}`, label: `Part studio: ${p.name}`, source: { part: p.id } });
  for (const a of doc.assemblies) {
    out.push({ key: `assembly:${a.id}`, label: `Assembly: ${a.name}`, source: { assembly: a.id } });
    for (const v of a.explodedViews ?? []) {
      out.push({
        key: `explode:${a.id}:${v.id}`,
        label: `Exploded: ${a.name}, ${v.name}`,
        source: { assembly: a.id, explodedView: v.id },
      });
    }
  }
  return out;
}

/** The text a dimension shows on the sheet (what regen and the layout made of it). */
export function dimensionText(display: DisplayList | null, id: string): string | null {
  const texts = (display?.items ?? []).filter((i) => i.kind === 'text' && i.owner === id);
  return texts.length ? texts.map((t) => (t.kind === 'text' ? t.text : '')).join(' ') : null;
}

/** What regen and the layout said of the sheet and its views, errors first. */
export function sheetMessages(
  result: DrawingSheetResult | null,
): { severity: 'error' | 'warning'; text: string }[] {
  if (!result) return [];
  const diags = [...result.diagnostics, ...result.views.flatMap((v) => v.diagnostics)];
  const out = diags.map((d) => ({ severity: d.severity, text: d.message }));
  for (const w of result.display?.warnings ?? [])
    out.push({ severity: 'warning', text: w.message });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/**
 * Why deleting an instance needs a second click: the drawing dimensions that measure it
 * (`instanceDimensions` paths, `<drawing>/<sheet>/<dimension>`) will be lost.
 */
export function dimensionWarning(
  doc: { drawings?: readonly { id: string; name: string }[] },
  name: string,
  paths: readonly string[],
): string {
  const named = paths.map((path) => {
    const [drawingId, , dimId] = path.split('/');
    const drawing = doc.drawings?.find((d) => d.id === drawingId);
    return `${drawing?.name ?? drawingId} ${dimId}`;
  });
  const n = paths.length;
  return `${name} is measured by ${n} drawing ${n === 1 ? 'dimension' : 'dimensions'} (${named.join(', ')}). Deleting it leaves ${n === 1 ? 'that dimension' : 'them'} lost, to re-pick.`;
}
