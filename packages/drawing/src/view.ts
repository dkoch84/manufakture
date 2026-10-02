// Views on a sheet: their scale, where they sit, and alignment of projected views with their
// parent. A view's geometry is in view coordinates (model millimetres, x right and y up on
// paper, the frame of T4.4a's `views.ts`); placing it gives the transform to paper millimetres.

import type { DrawingWarning } from './display';
import {
  applyPoint,
  curveBounds,
  isEmptyBounds,
  unionBounds,
  type Bounds,
  type Curve2,
  type Transform2,
  type Vec2,
} from './geometry';
import type { ViewEdge } from './hidden';
import { FULL_SIZE, scaleFactor, type Scale } from './scale';

export interface ViewSection {
  /** Index of the projected item the loops belong to. */
  readonly item: number;
  /** Closed loops of the item's section faces, outer first, view coordinates. */
  readonly loops: readonly (readonly Curve2[])[];
}

export interface ViewAlignment {
  /** The parent view's id. */
  readonly parent: string;
  /**
   * `'horizontal'`: on the parent's row (left and right views share its paper y);
   * `'vertical'`: in its column (top and bottom views share its paper x). Alignment assumes the
   * two views' frames share the origin's projection along that axis, which the standard views
   * of one model do.
   */
  readonly direction: 'horizontal' | 'vertical';
  /**
   * Which side of the parent a view without a position goes, named for third angle projection:
   * `'after'` (default) right of the parent (horizontal) or above it (vertical), for a right or
   * top view; `'before'` left of or below it, for a left or bottom view. First angle projection
   * flips both, so the same `side` names the same view in either: a left view is `'before'`,
   * and lands right of its parent in first angle. Ignored when the view has a position.
   */
  readonly side?: 'after' | 'before';
}

export interface ViewDisplay {
  /** Draw hidden edges. Default true. */
  readonly hidden?: boolean;
  /** Tangent edges: `'thin'` on the `smooth` layer (default) or `'omit'`. Hidden ones are never drawn. */
  readonly smooth?: 'thin' | 'omit';
  /** Seams on the `sewn` layer. Default false. */
  readonly sewn?: boolean;
  /** Centre marks on full circles. Default true. */
  readonly centreMarks?: boolean;
  /** Section hatch angle (radians, default pi / 4) and spacing (paper mm, default 3). */
  readonly hatchAngle?: number;
  readonly hatchSpacing?: number;
}

export interface ViewInput {
  /** `'view#1'`; dimensions name their view by it. */
  readonly id: string;
  /** Shown under the view (`SECTION A-A`, `DETAIL B`); none by default. */
  readonly label?: string;
  /** The projected edges (T4.4b's `edges`). */
  readonly edges: readonly ViewEdge[];
  /** The view's 2D bounds (T4.4b's `bounds`); computed from the edges when absent. */
  readonly bounds?: Bounds;
  /** Default: the parent's scale for aligned views, else the drawing's scale. */
  readonly scale?: Scale;
  /**
   * Paper position of the centre of the view's bounds. For an aligned view only the coordinate
   * along the alignment is used (x for a horizontal alignment, y for a vertical one). Default:
   * the frame's centre, or next to the parent for an aligned view.
   */
  readonly position?: Vec2;
  readonly align?: ViewAlignment;
  /** T4.4b's `sections`, for hatching. */
  readonly sections?: readonly ViewSection[];
  readonly display?: ViewDisplay;
}

export interface PlacedView {
  readonly id: string;
  readonly scale: Scale;
  /** View coordinates to paper millimetres. */
  readonly transform: Transform2;
  /** The view's bounds on paper. */
  readonly paperBounds: Bounds;
}

export interface PlacementOptions {
  /** Scale for views that name none. Default 1:1. */
  readonly scale?: Scale;
  /** The frame, for default positions. */
  readonly frame: Bounds;
  /**
   * Where an aligned view without a position goes. Default `'third'`: its alignment's `side` as
   * named; `'first'` flips it (a right view left of the parent, a top view below).
   */
  readonly projection?: 'first' | 'third';
  /** Paper gap between an aligned view placed by default and its parent. Default 20 mm, our choice. */
  readonly gap?: number;
}

/** A view's bounds in view coordinates, from its input or its edges. */
export function viewBounds(view: ViewInput): Bounds {
  if (view.bounds) return view.bounds;
  if (view.edges.length === 0) return { min: [0, 0], max: [0, 0] };
  return unionBounds(view.edges.map((e) => curveBounds(e.curve)));
}

const centreOf = (b: Bounds): Vec2 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];

function paperBoundsOf(b: Bounds, t: Transform2): Bounds {
  return { min: applyPoint(t, b.min), max: applyPoint(t, b.max) };
}

/**
 * Places every view: its scale and the transform from view to paper coordinates. Parents are
 * placed before the views aligned to them; an unknown parent or a cycle places the view on its
 * own, with a warning. Of views sharing an id, only the first is placed; the others get a
 * warning each.
 */
export function placeViews(
  views: readonly ViewInput[],
  options: PlacementOptions,
): { placed: Map<string, PlacedView>; warnings: DrawingWarning[] } {
  const byId = new Map<string, ViewInput>();
  const warnings: DrawingWarning[] = [];
  for (const v of views) {
    if (!byId.has(v.id)) byId.set(v.id, v);
    else
      warnings.push({
        code: 'duplicate-view',
        subject: v.id,
        message: `${v.id} is on the sheet more than once; only the first is placed`,
      });
  }
  const placed = new Map<string, PlacedView>();
  const visiting = new Set<string>();
  const gap = options.gap ?? 20;
  const third = (options.projection ?? 'third') === 'third';

  const free = (view: ViewInput, scale: Scale): PlacedView => {
    const f = scaleFactor(scale);
    const b = viewBounds(view);
    const at = view.position ?? centreOf(options.frame);
    const c = centreOf(b);
    const transform = { scale: f, offset: [at[0] - f * c[0], at[1] - f * c[1]] as Vec2 };
    return { id: view.id, scale, transform, paperBounds: paperBoundsOf(b, transform) };
  };

  const place = (view: ViewInput): PlacedView => {
    const done = placed.get(view.id);
    if (done) return done;
    let result: PlacedView;
    const align = view.align;
    const parentInput = align ? byId.get(align.parent) : undefined;
    if (!align) {
      result = free(view, view.scale ?? options.scale ?? FULL_SIZE);
    } else if (!parentInput) {
      warnings.push({
        code: 'unknown-parent',
        subject: view.id,
        message: `${view.id} is aligned to ${align.parent}, which is not on the sheet`,
      });
      result = free(view, view.scale ?? options.scale ?? FULL_SIZE);
    } else if (visiting.has(view.id)) {
      warnings.push({
        code: 'alignment-cycle',
        subject: view.id,
        message: `${view.id} is aligned in a cycle; placed on its own`,
      });
      result = free(view, view.scale ?? options.scale ?? FULL_SIZE);
    } else {
      visiting.add(view.id);
      const parent = place(parentInput);
      visiting.delete(view.id);
      if (placed.has(view.id)) return placed.get(view.id)!;
      let scale = parent.scale;
      if (view.scale && scaleFactor(view.scale) !== scaleFactor(parent.scale))
        warnings.push({
          code: 'alignment-scale',
          subject: view.id,
          message: `${view.id} is aligned to ${parent.id} and takes its scale`,
        });
      else if (view.scale) scale = view.scale;
      const f = scaleFactor(scale);
      const b = viewBounds(view);
      const c = centreOf(b);
      const pb = parent.paperBounds;
      const horizontal = align.direction === 'horizontal';
      // The free coordinate: from the position, or beside the parent.
      let along: number;
      if (view.position) along = view.position[horizontal ? 0 : 1];
      else {
        const half = (f * (horizontal ? b.max[0] - b.min[0] : b.max[1] - b.min[1])) / 2;
        // Third angle: right view to the right, top view above, left and bottom views the other
        // way; first angle the opposite of each.
        const after = (align.side ?? 'after') === 'after';
        along =
          after === third
            ? (horizontal ? pb.max[0] : pb.max[1]) + gap + half
            : (horizontal ? pb.min[0] : pb.min[1]) - gap - half;
      }
      const offset: Vec2 = horizontal
        ? [along - f * c[0], parent.transform.offset[1]]
        : [parent.transform.offset[0], along - f * c[1]];
      const transform = { scale: f, offset };
      result = { id: view.id, scale, transform, paperBounds: paperBoundsOf(b, transform) };
    }
    placed.set(view.id, result);
    return result;
  };

  for (const v of byId.values()) place(v);
  for (const v of byId.values()) {
    const p = placed.get(v.id)!;
    const f = options.frame;
    if (
      !isEmptyBounds(p.paperBounds) &&
      (p.paperBounds.min[0] < f.min[0] ||
        p.paperBounds.min[1] < f.min[1] ||
        p.paperBounds.max[0] > f.max[0] ||
        p.paperBounds.max[1] > f.max[1])
    )
      warnings.push({
        code: 'outside-frame',
        subject: v.id,
        message: `${v.id} reaches outside the frame`,
      });
  }
  return { placed, warnings };
}
