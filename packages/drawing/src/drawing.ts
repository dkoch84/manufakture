// A sheet from its inputs: the frame, the title block, each view's edges (hidden lines dashed
// and trimmed where visible lines cover them, centre marks, section hatching), the dimensions
// and the notes, as one display list in paper millimetres.

import {
  DEFAULT_DIMENSION_STYLE,
  arrowhead,
  estimateTextWidth,
  layoutDimension,
  type DimensionInput,
  type DimensionStyle,
} from './dimension';
import {
  DEFAULT_LAYERS,
  stroke,
  type DisplayItem,
  type DisplayList,
  type DrawingWarning,
  type LayerName,
  type LayerStyle,
  type TextAnchor,
} from './display';
import type { ValueFormat } from './format';
import {
  TAU,
  applyPoint,
  distance,
  normalize,
  sub,
  sweep,
  transformCurve,
  type Vec2,
} from './geometry';
import { removeHiddenUnderVisible, type ViewEdge } from './hidden';
import { FULL_SIZE, formatScale, scaleFactor, type Scale } from './scale';
import { sheetGeometry, type SheetInput } from './sheet';
import { layoutTitleBlock, type TitleBlockInput } from './title-block';
import { placeViews, type PlacedView, type ViewInput } from './view';

export interface NoteInput {
  /** `'note#1'`. */
  readonly id: string;
  /** Lines separated by `\n`. */
  readonly text: string;
  /** Paper position of the first line's baseline anchor. */
  readonly at: Vec2;
  /** Default 3.5 mm. */
  readonly height?: number;
  /** Default `'start'`. */
  readonly anchor?: TextAnchor;
  /**
   * A leader to a point: on paper, or in a view's coordinates (`view` set). Drawn from the
   * nearer end of the note's first line, with an arrowhead at the point.
   */
  readonly leader?: { readonly to: Vec2; readonly view?: string };
}

export interface DrawingStyle {
  readonly layers: Readonly<Record<LayerName, LayerStyle>>;
  readonly dimension: DimensionStyle;
  /** Overshoot of centre marks past their circle, paper mm. Default 2, our choice. */
  readonly centreMarkOvershoot: number;
  /** Cap height of view labels and notes, paper mm. Default 3.5. */
  readonly labelHeight: number;
  /** Tolerance for hidden lines under visible ones, view units (model mm). Default 0.01. */
  readonly hiddenTolerance: number;
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  layers: DEFAULT_LAYERS,
  dimension: DEFAULT_DIMENSION_STYLE,
  centreMarkOvershoot: 2,
  labelHeight: 3.5,
  hiddenTolerance: 0.01,
};

export interface DrawingInput {
  readonly sheet: SheetInput;
  /** The scale of views that name none. Default 1:1. */
  readonly scale?: Scale;
  /** Default `'third'`: where aligned views go by default, and the title block's projection. */
  readonly projection?: 'first' | 'third';
  readonly views: readonly ViewInput[];
  readonly dimensions?: readonly DimensionInput[];
  readonly notes?: readonly NoteInput[];
  /** The title block's fields; `false` for none. Default: an empty title block. */
  readonly titleBlock?: TitleBlockInput | false;
  /** Display units of the values (the document's, ADR 0005). Default millimetres. */
  readonly format?: ValueFormat;
  readonly style?: {
    readonly layers?: Partial<Record<LayerName, LayerStyle>>;
    readonly dimension?: Partial<DimensionStyle>;
    readonly centreMarkOvershoot?: number;
    readonly labelHeight?: number;
    readonly hiddenTolerance?: number;
  };
}

/** The layer a projected edge goes on, or none when the view leaves it out. */
function edgeLayer(e: ViewEdge, view: ViewInput): LayerName | undefined {
  const d = view.display ?? {};
  if (!e.visible && d.hidden === false) return undefined;
  switch (e.cls) {
    case 'sharp':
    case 'outline':
      return e.visible ? 'visible' : 'hidden';
    case 'smooth':
      return e.visible && d.smooth !== 'omit' ? 'smooth' : undefined;
    case 'sewn':
      return e.visible && d.sewn ? 'sewn' : undefined;
  }
}

/**
 * Centre marks: a cross through the centre of every full circle among the view's edges (one per
 * centre, sized by the largest circle there), running past it by `overshoot` paper mm. Hidden
 * circles count only when the view draws hidden edges.
 */
function centreMarks(
  edges: readonly ViewEdge[],
  placed: PlacedView,
  overshoot: number,
  owner: string,
  hidden: boolean,
): DisplayItem[] {
  const marks: { center: Vec2; radius: number }[] = [];
  for (const e of edges) {
    const c = e.curve;
    if (c.kind !== 'arc' || sweep(c.start, c.end) !== TAU || e.cls === 'sewn') continue;
    if (!e.visible && !hidden) continue;
    const same = marks.find((m) => distance(m.center, c.center) <= 1e-6);
    if (same) same.radius = Math.max(same.radius, c.radius);
    else marks.push({ center: c.center, radius: c.radius });
  }
  const items: DisplayItem[] = [];
  for (const m of marks) {
    const c = applyPoint(placed.transform, m.center);
    const r = m.radius * placed.transform.scale + overshoot;
    items.push({ kind: 'line', layer: 'centre', a: [c[0] - r, c[1]], b: [c[0] + r, c[1]], owner });
    items.push({ kind: 'line', layer: 'centre', a: [c[0], c[1] - r], b: [c[0], c[1] + r], owner });
  }
  return items;
}

function viewItems(view: ViewInput, placed: PlacedView, style: DrawingStyle): DisplayItem[] {
  const owner = view.id;
  const items: DisplayItem[] = [];
  // Only edges the view draws may cover hidden ones: a hidden line under an omitted smooth edge,
  // an undrawn seam or an undrawn hidden edge stays.
  const edges = removeHiddenUnderVisible(
    view.edges.filter((e) => edgeLayer(e, view) !== undefined),
    style.hiddenTolerance,
  );
  // Hidden first, so visible lines draw over them where a writer keeps the order.
  for (const pass of [false, true])
    for (const e of edges) {
      if (e.visible !== pass) continue;
      const layer = edgeLayer(e, view)!;
      items.push(stroke(transformCurve(placed.transform, e.curve), layer, { owner, item: e.item }));
    }
  if (view.display?.centreMarks !== false)
    items.push(
      ...centreMarks(
        view.edges,
        placed,
        style.centreMarkOvershoot,
        owner,
        view.display?.hidden !== false,
      ),
    );
  for (const section of view.sections ?? [])
    items.push({
      kind: 'hatch',
      layer: 'hatch',
      loops: section.loops.map((loop) => loop.map((c) => transformCurve(placed.transform, c))),
      angle: view.display?.hatchAngle ?? Math.PI / 4,
      spacing: view.display?.hatchSpacing ?? 3,
      owner,
      item: section.item,
    });
  if (view.label) {
    const b = placed.paperBounds;
    items.push({
      kind: 'text',
      layer: 'text',
      at: [(b.min[0] + b.max[0]) / 2, b.min[1] - 2 * style.labelHeight],
      text: view.label,
      height: style.labelHeight,
      rotation: 0,
      anchor: 'middle',
      baseline: 'top',
      owner,
    });
  }
  return items;
}

function noteItems(
  note: NoteInput,
  placed: ReadonlyMap<string, PlacedView>,
  style: DrawingStyle,
  warnings: DrawingWarning[],
): DisplayItem[] {
  const height = note.height ?? style.labelHeight;
  const anchor = note.anchor ?? 'start';
  const lines = note.text.split('\n');
  const items: DisplayItem[] = lines.map((text, i) => ({
    kind: 'text',
    layer: 'text',
    at: [note.at[0], note.at[1] - i * height * 1.6],
    text,
    height,
    rotation: 0,
    anchor,
    baseline: 'bottom',
    owner: note.id,
  }));
  if (note.leader) {
    let to = note.leader.to;
    if (note.leader.view !== undefined) {
      const view = placed.get(note.leader.view);
      if (!view) {
        warnings.push({
          code: 'unknown-view',
          subject: note.id,
          message: `${note.id}'s leader points into ${note.leader.view}, which is not on the sheet`,
        });
        return items;
      }
      to = applyPoint(view.transform, to);
    }
    // From the end of the first line nearer the point, at mid cap height.
    const width = estimateTextWidth(lines[0] ?? '', height);
    const left =
      anchor === 'start'
        ? note.at[0]
        : anchor === 'middle'
          ? note.at[0] - width / 2
          : note.at[0] - width;
    const y = note.at[1] + height / 2;
    const from: Vec2 =
      Math.abs(to[0] - left) < Math.abs(to[0] - (left + width))
        ? [left - 1, y]
        : [left + width + 1, y];
    const dir = normalize(sub(to, from));
    if (distance(from, to) > 0) {
      items.push({ kind: 'line', layer: 'dimension', a: from, b: to, owner: note.id });
      items.push(arrowhead(to, dir, style.dimension, note.id));
    }
  }
  return items;
}

/** The scale text for the title block: the views' shared scale, or `AS SHOWN`. */
export function sheetScaleText(placed: Iterable<PlacedView>, fallback: Scale = FULL_SIZE): string {
  const scales = [...placed].map((p) => p.scale);
  if (scales.length === 0) return formatScale(fallback);
  const first = scales[0]!;
  return scales.every((s) => scaleFactor(s) === scaleFactor(first))
    ? formatScale(first)
    : 'AS SHOWN';
}

/** Lays out a whole sheet. */
export function layoutSheet(input: DrawingInput): DisplayList {
  const style: DrawingStyle = {
    ...DEFAULT_DRAWING_STYLE,
    ...(input.style?.centreMarkOvershoot !== undefined && {
      centreMarkOvershoot: input.style.centreMarkOvershoot,
    }),
    ...(input.style?.labelHeight !== undefined && { labelHeight: input.style.labelHeight }),
    ...(input.style?.hiddenTolerance !== undefined && {
      hiddenTolerance: input.style.hiddenTolerance,
    }),
    layers: { ...DEFAULT_LAYERS, ...input.style?.layers },
    dimension: { ...DEFAULT_DIMENSION_STYLE, ...input.style?.dimension },
  };
  const geometry = sheetGeometry(input.sheet);
  const frame = geometry.frame;
  const projection = input.projection ?? 'third';
  const { placed, warnings } = placeViews(input.views, {
    frame,
    projection,
    ...(input.scale && { scale: input.scale }),
  });
  const items: DisplayItem[] = [];

  // The frame.
  const [x0, y0] = frame.min;
  const [x1, y1] = frame.max;
  items.push({
    kind: 'polyline',
    layer: 'border',
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    closed: true,
    owner: 'border',
  });

  if (input.titleBlock !== false)
    items.push(
      ...layoutTitleBlock(
        {
          sheet: '1 / 1',
          scale: sheetScaleText(placed.values(), input.scale),
          projection: projection === 'third' ? 'THIRD ANGLE' : 'FIRST ANGLE',
          ...input.titleBlock,
        },
        frame,
      ),
    );

  // Only the first of views sharing an id is placed and drawn (placeViews warns about the rest).
  const drawn = new Set<string>();
  for (const view of input.views) {
    if (drawn.has(view.id)) continue;
    drawn.add(view.id);
    items.push(...viewItems(view, placed.get(view.id)!, style));
  }

  for (const dim of input.dimensions ?? []) {
    const view = placed.get(dim.view);
    if (!view) {
      warnings.push({
        code: 'unknown-view',
        subject: dim.id,
        message: `${dim.id} is in ${dim.view}, which is not on the sheet`,
      });
      continue;
    }
    const { items: dimItems, warning } = layoutDimension(
      dim,
      view.transform,
      input.format,
      style.dimension,
    );
    if (warning) warnings.push(warning);
    items.push(...dimItems);
  }

  for (const note of input.notes ?? []) items.push(...noteItems(note, placed, style, warnings));

  return { width: geometry.width, height: geometry.height, layers: style.layers, items, warnings };
}
