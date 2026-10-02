// The 2D display list: what a sheet draws, in paper millimetres with the origin at the paper's
// bottom left and y up. The SVG, DXF and PDF writers (T4.4f) and the app's drawing canvas
// consume it; they map each layer to a stroke style, a DXF layer and linetype, and so on.

import type { Curve2, Vec2 } from './geometry';

/**
 * Layers, one per kind of line. `visible` and `hidden` carry the model's edges (silhouettes
 * included), `smooth` tangent edges drawn thin, `sewn` seams (only when asked for).
 */
export type LayerName =
  | 'visible'
  | 'hidden'
  | 'smooth'
  | 'sewn'
  | 'centre'
  | 'dimension'
  | 'section'
  | 'hatch'
  | 'text'
  | 'border'
  | 'titleBlock';

export const LAYER_NAMES: readonly LayerName[] = [
  'visible',
  'hidden',
  'smooth',
  'sewn',
  'centre',
  'dimension',
  'section',
  'hatch',
  'text',
  'border',
  'titleBlock',
];

/** `dashed`: hidden lines; `chain`: long dash, short dash (centre lines, cutting planes). */
export type LineType = 'continuous' | 'dashed' | 'chain';

export interface LayerStyle {
  readonly lineType: LineType;
  /** Stroke width, paper millimetres. */
  readonly weight: number;
  /** Dash pattern in paper millimetres, alternating dash and gap (SVG `stroke-dasharray`); empty when continuous. */
  readonly dash: readonly number[];
}

/**
 * Default layer styles. Two weights in the ratio 2:1 (0.5 and 0.25 mm), wide for visible edges and
 * the frame, narrow for everything else, as ISO 128 line groups are usually quoted; hidden lines
 * a little heavier (0.35) so they survive printing. Dash lengths are our choice, in the
 * proportions ISO 128-2 is usually quoted with (dash about 12 line widths, gap about 3 for
 * hidden lines; long dash about 24, gap 3, short dash 0.5 for chain lines), scaled up for
 * legibility at these weights. Neither standard was read; unverified.
 */
export const DEFAULT_LAYERS: Readonly<Record<LayerName, LayerStyle>> = {
  visible: { lineType: 'continuous', weight: 0.5, dash: [] },
  hidden: { lineType: 'dashed', weight: 0.35, dash: [3, 1.5] },
  smooth: { lineType: 'continuous', weight: 0.25, dash: [] },
  sewn: { lineType: 'continuous', weight: 0.18, dash: [] },
  centre: { lineType: 'chain', weight: 0.25, dash: [8, 1.5, 1.5, 1.5] },
  dimension: { lineType: 'continuous', weight: 0.25, dash: [] },
  section: { lineType: 'chain', weight: 0.5, dash: [12, 2, 2, 2] },
  hatch: { lineType: 'continuous', weight: 0.18, dash: [] },
  text: { lineType: 'continuous', weight: 0.25, dash: [] },
  border: { lineType: 'continuous', weight: 0.7, dash: [] },
  titleBlock: { lineType: 'continuous', weight: 0.35, dash: [] },
};

/** What a primitive belongs to, for picking and highlighting in the app. */
export interface Owner {
  /** `'view#1'`, `'dim#3'`, `'note#2'`, `'titleBlock'` or `'border'`. */
  readonly owner?: string;
  /** For a view's edges: the index of the projected item (body) it came from. */
  readonly item?: number;
}

export type TextAnchor = 'start' | 'middle' | 'end';
export type TextBaseline = 'bottom' | 'middle' | 'top';

export interface TextItem extends Owner {
  readonly kind: 'text';
  readonly layer: LayerName;
  readonly at: Vec2;
  readonly text: string;
  /** Cap height, paper millimetres. */
  readonly height: number;
  /** Counter-clockwise, radians; 0 reads left to right. */
  readonly rotation: number;
  readonly anchor: TextAnchor;
  readonly baseline: TextBaseline;
}

export interface HatchItem extends Owner {
  readonly kind: 'hatch';
  readonly layer: LayerName;
  /**
   * Closed loops in paper millimetres; filled even-odd (an outer loop and its holes). A loop's
   * curves follow one another around it, but arcs and ellipse arcs always run counter-clockwise,
   * so one may run against its loop: its `end` point, not its `start`, meets the previous curve.
   * A writer that builds a connected path must check for that and reverse such a curve.
   */
  readonly loops: readonly (readonly Curve2[])[];
  /** Direction of the hatch lines, radians. */
  readonly angle: number;
  /** Distance between hatch lines, paper millimetres. */
  readonly spacing: number;
}

type Stroked<C> = C & Owner & { readonly layer: LayerName };

export type DisplayItem =
  | Stroked<Extract<Curve2, { kind: 'line' }>>
  | Stroked<Extract<Curve2, { kind: 'arc' }>>
  | Stroked<Extract<Curve2, { kind: 'ellipseArc' }>>
  | Stroked<{
      readonly kind: 'polyline';
      readonly points: readonly Vec2[];
      readonly closed?: boolean;
      /** Filled with the layer's colour (arrowheads). */
      readonly fill?: boolean;
    }>
  | TextItem
  | HatchItem;

export interface DrawingWarning {
  readonly code:
    | 'unknown-view'
    | 'duplicate-view'
    | 'unknown-parent'
    | 'alignment-cycle'
    | 'alignment-scale'
    | 'degenerate-dimension'
    | 'outside-frame';
  /** The view, dimension or note the warning is about. */
  readonly subject: string;
  readonly message: string;
}

export interface DisplayList {
  /** Paper size, millimetres. */
  readonly width: number;
  readonly height: number;
  readonly layers: Readonly<Record<LayerName, LayerStyle>>;
  readonly items: readonly DisplayItem[];
  readonly warnings: readonly DrawingWarning[];
}

/** A curve as a display item on a layer. */
export function stroke(curve: Curve2, layer: LayerName, owner?: Owner): DisplayItem {
  return { ...curve, layer, ...owner } as DisplayItem;
}
