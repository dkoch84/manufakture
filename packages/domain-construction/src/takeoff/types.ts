// The construction takeoff's input and output (M6 plan T6.3a, ADR 0015 decision 10). Everything
// is plain data, so the producers run in Node tests with no kernel: framing members as the
// generators return them, and sheet layers as faces (a rectangle or convex outline with
// rectangular holes) that the feature layer, or the helpers in `faces.ts`, describe.
//
// Lengths are millimetres, areas square millimetres (ADR 0005).

import type { Price, StockData } from '@manufakture/stock';
import type { SheetLayoutResult, StickLayoutResult } from '@manufakture/nesting';
import type { TakeoffRow, TakeoffTotal } from '@manufakture/takeoff';
import type { Vec2 } from '../geom';
import type { Member } from '../members';

/** What the takeoff reads of a member: who owns it, what it is, its stock and blank length. */
export type TakeoffMember = Pick<Member, 'id' | 'owner' | 'role' | 'length'> & {
  readonly stock: Pick<Member['stock'], 'id' | 'name' | 'width' | 'depth'>;
};

/** The sheet layer a face belongs to. */
export type SheetLayerKind = 'siding' | 'sheathing' | 'drywall' | 'subfloor' | 'roof-sheathing';

/** A rectangle in a face's own coordinates: `x` along the face, `y` up it, from its corner. */
export interface FaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One face of a sheet layer, flattened into its own plane: `x` runs along the face (a wall's
 * length, a roof's eave), `y` up it (from the wall's base, from the eave). The face fills
 * `[0, width] x [0, height]`, or only the convex `outline` inside that box (a gable end, a hip
 * roof's triangle), less its `holes` (rough openings).
 */
export interface SheetFace {
  /** The layer body or face this is (`extension#3:sheathing`): the source of its rows. */
  readonly id: string;
  /** The feature that owns the layer: a wall, a floor or a roof. */
  readonly owner: string;
  readonly layer: SheetLayerKind;
  /** The catalog id of the sheet stock (`us-osb-7-16`). */
  readonly stock: string;
  readonly width: number;
  readonly height: number;
  /** A convex polygon inside the box, either winding; the whole box when absent. */
  readonly outline?: readonly Vec2[];
  readonly holes?: readonly FaceRect[];
  /**
   * How full sheets are laid: `vertical` with their length up the face (wall sheathing),
   * `horizontal` with their length along it (drywall, subfloor and roof sheathing, across the
   * joists or rafters). Default by layer: `vertical` for sheathing and siding, `horizontal` for
   * the rest.
   */
  readonly orientation?: 'horizontal' | 'vertical';
  /** The corner full sheets start from: the face's start (x = 0) or its end. Default `start`. */
  readonly from?: 'start' | 'end';
}

export interface ConstructionTakeoffSettings {
  /** Match studs, kings and corner studs to precut stud stock by length. Default true. */
  readonly precuts?: boolean;
  /** Saw kerf for the 1D lumber layout and the sheet layout, mm. Default 1/8". */
  readonly kerf?: number;
  /** Lumber end trims for the 1D layout, mm. Default 0. */
  readonly trims?: number;
  /**
   * Lengths the yard sells, mm, by lumber stock id; the catalog's lengths for stock not listed.
   * An empty list means the stock is bought at each member's own length.
   */
  readonly lengths?: Readonly<Record<string, readonly number[]>>;
  /** Added to the sheets the layout needs, then rounded up per stock, percent. Default 0. */
  readonly wastePercent?: number;
  /**
   * A sheet leftover is kept for reuse when its longer side is at least `length` and its shorter
   * side at least `width`. Default 12" x 3".
   */
  readonly minOffcut?: { readonly length: number; readonly width: number };
  /** The currency the cost is in; prices that state another one are left out (flagged). */
  readonly currency?: string;
}

export interface ConstructionTakeoffInput {
  readonly members: readonly TakeoffMember[];
  readonly faces?: readonly SheetFace[];
  /** The level each feature is on, by feature id, for the per-level subtotals. */
  readonly levels?: Readonly<Record<string, string>>;
  /** The document's stock overrides: actual sizes and prices (`domains.stock`). */
  readonly stock?: StockData;
  readonly settings?: ConstructionTakeoffSettings;
}

/**
 * The categories of rows, in display order:
 * - `framing`: members as framed, by stock and blank length (one row per length).
 * - `linear`: plates, blocking and fascia as linear length, by stock.
 * - `faces`: sheet layers as laid, by stock and layer: area and pieces.
 * - `lumber`: what to buy: precut studs and lengths sold, from the 1D layout.
 * - `sheet`: what to buy: sheets, from the per-face layout and the 2D packer.
 */
export type ConstructionCategory = 'framing' | 'linear' | 'faces' | 'lumber' | 'sheet';

export const CONSTRUCTION_CATEGORIES: readonly ConstructionCategory[] = [
  'framing',
  'linear',
  'faces',
  'lumber',
  'sheet',
];

/**
 * Flags a construction row may carry:
 * - `precut`: precut stud stock, matched by length.
 * - `spliced`: a plate, rim, ridge or fascia longer than every length sold, bought in pieces that
 *   the framing does not show spliced.
 * - `longer-than-stock`: a member longer than every length sold, listed at its own length.
 * - `no-stock-lengths`: the stock has no lengths sold; bought at each member's length.
 * - `stock-unknown`: a stock id this build's catalog does not have; not bought.
 * - `no-price`: no price in the stock overrides; left out of the cost.
 * - `price-unit`: the price is per a unit that does not fit the stock (per sheet on lumber).
 * - `other-currency`: the price states a currency other than the takeoff's; left out of the cost.
 * - `waste-added`: the sheet count includes the waste percentage.
 */
export type ConstructionFlag =
  | 'precut'
  | 'spliced'
  | 'longer-than-stock'
  | 'no-stock-lengths'
  | 'stock-unknown'
  | 'no-price'
  | 'price-unit'
  | 'other-currency'
  | 'waste-added';

/** A takeoff row with what one unit costs and the row's cost (bought rows only). */
export interface ConstructionRow extends TakeoffRow {
  category: ConstructionCategory;
  price?: Price;
  /** Quantity times the price, in the takeoff's currency; absent when not priced. */
  cost?: number;
}

/** A piece of a face's layout: a rectangle of sheet, in the face's coordinates. */
export interface FacePiece extends FaceRect {
  /** `<face id>@<column>.<row>`, both from 1, counted from the face's starting corner. */
  readonly id: string;
  /** A whole sheet, laid as is. */
  readonly full: boolean;
  /** Where the piece came from: `sheet` (a whole sheet), `offcut` or `new` (packed). */
  readonly from: 'sheet' | 'offcut' | 'new';
}

/** A face's sheet layout. */
export interface FaceLayout {
  readonly face: string;
  readonly stock: string;
  readonly tile: { readonly width: number; readonly height: number };
  readonly pieces: FacePiece[];
  /** Sheet cut out of the pieces for the face's holes, kept or reused as offcuts. */
  readonly cutouts: FaceRect[];
  /** Area covered, mm². */
  readonly area: number;
}

/** One sheet stock's layout: whole sheets, and the 2D packer's run for the partial pieces. */
export interface SheetStockLayout {
  readonly stock: string;
  /** Whole sheets laid as they are. */
  readonly full: number;
  /** New sheets the packer opened for partial pieces. */
  readonly packed: number;
  /** `full + packed`, before waste. */
  readonly sheets: number;
  /** With the waste percentage, rounded up. */
  readonly bought: number;
  /** The cross-face run (offcuts first, then new sheets); null when nothing needed packing. */
  readonly result: SheetLayoutResult | null;
}

/** One lumber stock's 1D layout. */
export interface LumberStockLayout {
  readonly stock: string;
  readonly lengths: readonly number[];
  readonly result: StickLayoutResult;
}

export interface CostSummary {
  readonly currency?: string;
  /** Sum of the priced rows' costs. */
  readonly total: number;
  /**
   * Keys of the rows left out of the total: bought rows with no price, a wrong unit or another
   * currency, then the rows of a stock the catalog lacks (`stock-unknown`), which nothing buys.
   */
  readonly unpriced: string[];
}

/** Totals of the as-framed and as-laid rows of one level or feature. */
export interface TakeoffSubtotal {
  readonly kind: 'level' | 'feature';
  /** The level or feature id; `''` for features with no level. */
  readonly id: string;
  readonly totals: TakeoffTotal[];
}

export interface ConstructionTakeoff {
  rows: ConstructionRow[];
  /** Per category and unit. */
  totals: TakeoffTotal[];
  cost: CostSummary;
  subtotals: TakeoffSubtotal[];
  faces: FaceLayout[];
  sheets: SheetStockLayout[];
  lumber: LumberStockLayout[];
  /** The short "not an engineering tool" text every export carries (ADR 0015 decision 8). */
  disclaimer: string;
}
