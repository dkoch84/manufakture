// Sheet faces: building them from walls, floors and roofs, and laying full sheets on them.
//
// A face is laid from one corner (its start or end, at its bottom) in a grid of whole sheets.
// Each grid cell becomes one piece: the bounding rectangle of the part of the cell that is inside
// the face's outline and outside its holes. A piece the size of a whole sheet is a whole sheet;
// a smaller one (along the face's far edges, around a roof's slopes) is cut from offcuts or new
// sheets by the 2D packer (`sheets.ts`). A hole that falls inside a piece is cut out of it, and
// that cut-out is an offcut (a door's rough opening cut from a sheet of wall sheathing).
//
// Pieces are rectangles because sheets are cut straight; the triangles a convex outline leaves
// beside a piece (a gable's slope) count as waste.

import type { Vec2 } from '../geom';
import type { SubfloorReport } from '../framing/floor';
import { resolveRoofSettings, type FrameRoofInput } from '../framing/roof';
import type { FaceLayout, FacePiece, FaceRect, SheetFace, SheetLayerKind } from './types';

/** Lengths closer than this are equal, mm. */
const EPS = 1e-6;
/** A piece or cut-out narrower than this is nothing, mm. */
const SLIVER = 0.01;

/** The sheet size laid on a face: `length` by `width`, mm. */
export interface SheetSize {
  readonly length: number;
  readonly width: number;
}

/** The orientation a face's sheets are laid in, with the layer's default. */
export function faceOrientation(face: SheetFace): 'horizontal' | 'vertical' {
  if (face.orientation !== undefined) return face.orientation;
  return face.layer === 'sheathing' || face.layer === 'siding' ? 'vertical' : 'horizontal';
}

/** The face's area: its outline (or box) less its holes inside it, mm². */
export function faceArea(face: SheetFace): number {
  const box: FaceRect = { x: 0, y: 0, width: face.width, height: face.height };
  return regionOf(face, box).area;
}

/**
 * Whole sheets laid on a face from its starting corner, and the cut-outs of its holes. Pieces
 * are all `from: 'sheet'` when full and `from: 'new'` otherwise; the sheet producer decides
 * which partial pieces come from offcuts.
 */
export function layoutFace(face: SheetFace, sheet: SheetSize): FaceLayout {
  if (!(face.width > 0 && face.height > 0)) {
    throw new RangeError(`face ${face.id}: width and height must be above 0`);
  }
  const vertical = faceOrientation(face) === 'vertical';
  const tile = vertical
    ? { width: sheet.width, height: sheet.length }
    : { width: sheet.length, height: sheet.width };
  const cols = Math.ceil(face.width / tile.width - EPS);
  const rows = Math.ceil(face.height / tile.height - EPS);
  const pieces: FacePiece[] = [];
  const cutouts: FaceRect[] = [];
  let area = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = face.from === 'end' ? face.width - (i + 1) * tile.width : i * tile.width;
      const cell = clipBox(
        { x: x0, y: j * tile.height, width: tile.width, height: tile.height },
        face,
      );
      if (cell === undefined) continue;
      const region = regionOf(face, cell);
      if (region.bbox === undefined) continue;
      area += region.area;
      const b = region.bbox;
      const full =
        Math.abs(b.width - tile.width) < EPS * 1e3 && Math.abs(b.height - tile.height) < EPS * 1e3;
      pieces.push({ ...b, id: `${face.id}@${i + 1}.${j + 1}`, full, from: full ? 'sheet' : 'new' });
      for (const h of face.holes ?? []) {
        const c = intersect(h, b);
        if (c !== undefined) cutouts.push(c);
      }
    }
  }
  return { face: face.id, stock: face.stock, tile, pieces, cutouts, area };
}

// Geometry -------------------------------------------------------------------------------------

function intersect(a: FaceRect, b: FaceRect): FaceRect | undefined {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 - x0 < SLIVER || y1 - y0 < SLIVER) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function clipBox(r: FaceRect, face: SheetFace): FaceRect | undefined {
  return intersect(r, { x: 0, y: 0, width: face.width, height: face.height });
}

/** A convex polygon clipped to an axis-aligned rectangle (Sutherland and Hodgman). */
function clipPolygon(poly: readonly Vec2[], r: FaceRect): Vec2[] {
  const edges: Array<(p: Vec2) => number> = [
    (p) => p[0] - r.x,
    (p) => r.x + r.width - p[0],
    (p) => p[1] - r.y,
    (p) => r.y + r.height - p[1],
  ];
  let out: Vec2[] = [...poly];
  for (const inside of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!;
      const b = input[(i + 1) % input.length]!;
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    if (out.length === 0) break;
  }
  return out;
}

function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * The part of the face inside `r`: its area, and the bounding rectangle of it. `r` is split at
 * the holes' edges; every sub-rectangle outside the holes is clipped to the outline.
 */
function regionOf(face: SheetFace, r: FaceRect): { area: number; bbox?: FaceRect } {
  const holes = (face.holes ?? []).filter((h) => intersect(h, r) !== undefined);
  const xs = new Set([r.x, r.x + r.width]);
  const ys = new Set([r.y, r.y + r.height]);
  for (const h of holes) {
    for (const x of [h.x, h.x + h.width]) if (x > r.x && x < r.x + r.width) xs.add(x);
    for (const y of [h.y, h.y + h.height]) if (y > r.y && y < r.y + r.height) ys.add(y);
  }
  const sx = [...xs].sort((a, b) => a - b);
  const sy = [...ys].sort((a, b) => a - b);
  let area = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < sx.length; i++) {
    for (let j = 0; j + 1 < sy.length; j++) {
      const cell = {
        x: sx[i]!,
        y: sy[j]!,
        width: sx[i + 1]! - sx[i]!,
        height: sy[j + 1]! - sy[j]!,
      };
      if (cell.width < SLIVER || cell.height < SLIVER) continue;
      const cx = cell.x + cell.width / 2;
      const cy = cell.y + cell.height / 2;
      const inHole = holes.some(
        (h) => cx > h.x && cx < h.x + h.width && cy > h.y && cy < h.y + h.height,
      );
      if (inHole) continue;
      const poly =
        face.outline === undefined
          ? [
              [cell.x, cell.y] as Vec2,
              [cell.x + cell.width, cell.y] as Vec2,
              [cell.x + cell.width, cell.y + cell.height] as Vec2,
              [cell.x, cell.y + cell.height] as Vec2,
            ]
          : clipPolygon(face.outline, cell);
      const a = poly.length >= 3 ? polygonArea(poly) : 0;
      if (a < SLIVER * SLIVER) continue;
      area += a;
      for (const p of poly) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    }
  }
  if (x1 - x0 < SLIVER || y1 - y0 < SLIVER) return { area };
  return { area, bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

// Faces from the model -------------------------------------------------------------------------

/** A door or window in a wall face, by rough opening (as `WallOpening`). */
export interface FaceOpening {
  /** Centre of the rough opening along the face, from its start. */
  readonly position: number;
  readonly width: number;
  readonly height: number;
  /** Height of the rough opening's bottom above the face's bottom. */
  readonly sill: number;
}

export interface WallFaceInput {
  readonly id: string;
  readonly owner: string;
  readonly layer: SheetLayerKind;
  readonly stock: string;
  /** Along the wall: the face's length (the outside face for sheathing, the inside for drywall). */
  readonly length: number;
  readonly height: number;
  readonly openings?: readonly FaceOpening[];
  /**
   * A gable triangle on top: its apex `gableRise` above the face's top at mid-length (a gable
   * end's sheathing up to the roof).
   */
  readonly gableRise?: number;
  readonly orientation?: 'horizontal' | 'vertical';
  readonly from?: 'start' | 'end';
}

/** A wall's sheet face: its length by its height, less its rough openings, with an optional gable. */
export function wallFace(input: WallFaceInput): SheetFace {
  const rise = input.gableRise ?? 0;
  const L = input.length;
  const H = input.height;
  const face: SheetFace = {
    id: input.id,
    owner: input.owner,
    layer: input.layer,
    stock: input.stock,
    width: L,
    height: H + rise,
    holes: (input.openings ?? []).map((o) => ({
      x: o.position - o.width / 2,
      y: o.sill,
      width: o.width,
      height: o.height,
    })),
    ...(rise > 0
      ? {
          outline: [
            [0, 0],
            [L, 0],
            [L, H],
            [L / 2, H + rise],
            [0, H],
          ] as Vec2[],
        }
      : {}),
    ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
    ...(input.from === undefined ? {} : { from: input.from }),
  };
  return face;
}

/**
 * A floor's subfloor as a face (T6.2b's `SubfloorReport`). The face's `x` runs across the joists
 * (`direction` is the joists' span), so horizontal sheets lie across them. A rectilinear outline
 * that is not a rectangle becomes its bounding box with the missing parts as holes.
 */
export function subfloorFace(
  floor: string,
  report: SubfloorReport,
  direction: Vec2,
  options: { readonly from?: 'start' | 'end'; readonly id?: string } = {},
): SheetFace {
  const n = Math.hypot(direction[0], direction[1]);
  if (!(n > 0)) throw new RangeError('the joist direction must not be zero');
  const d: Vec2 = [direction[0] / n, direction[1] / n];
  const across: Vec2 = [-d[1], d[0]];
  const pts = report.outline.map((p): Vec2 => [
    p[0] * across[0] + p[1] * across[1],
    p[0] * d[0] + p[1] * d[1],
  ]);
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const local = pts.map((p): Vec2 => [p[0] - minX, p[1] - minY]);
  const width = Math.max(...local.map((p) => p[0]));
  const height = Math.max(...local.map((p) => p[1]));
  const xs = [...new Set(local.map((p) => round(p[0])))].sort((a, b) => a - b);
  const ys = [...new Set(local.map((p) => round(p[1])))].sort((a, b) => a - b);
  const holes: FaceRect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const c: Vec2 = [(xs[i]! + xs[i + 1]!) / 2, (ys[j]! + ys[j + 1]!) / 2];
      if (!insidePolygon(local, c)) {
        holes.push({
          x: xs[i]!,
          y: ys[j]!,
          width: xs[i + 1]! - xs[i]!,
          height: ys[j + 1]! - ys[j]!,
        });
      }
    }
  }
  return {
    id: options.id ?? `${floor}:subfloor`,
    owner: floor,
    layer: 'subfloor',
    stock: report.stock.id,
    width,
    height,
    ...(holes.length > 0 ? { holes } : {}),
    ...(options.from === undefined ? {} : { from: options.from }),
  };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function insidePolygon(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A roof's sheathing faces, one per roof plane, from the same input as `frameRoof`. Each face is
 * the plane flattened: `x` along its eave line (the overhang's outer line in plan), `y` up the
 * slope to the ridge line. The slope is `(overhang + width / 2) x the common factor`: to the
 * ridge's centre line, with the rafters' heel height and the fascia left out. A gable's planes
 * are rectangles as long as the footprint plus both rake overhangs; a hip roof's eave planes are
 * trapezoids up to the ridge, its end planes triangles.
 */
export function roofSheathingFaces(input: FrameRoofInput, stock: string): SheetFace[] {
  const s = resolveRoofSettings(input.settings);
  const { length: L, width: W } = input.footprint;
  const factor = 1 / Math.cos(input.pitch);
  const slope = (s.overhang + W / 2) * factor;
  const face = (edge: number, width: number, outline?: Vec2[]): SheetFace => ({
    id: `${input.roof}:sheathing:e${edge}`,
    owner: input.roof,
    layer: 'roof-sheathing',
    stock,
    width,
    height: slope,
    ...(outline === undefined ? {} : { outline }),
  });
  if (input.kind === 'gable') {
    const run = L + 2 * s.rakeOverhang;
    return [face(1, run), face(3, run)];
  }
  const eave = L + 2 * s.overhang;
  const ridge = L - W;
  const end = W + 2 * s.overhang;
  const trapezoid: Vec2[] = [
    [0, 0],
    [eave, 0],
    [(eave + ridge) / 2, slope],
    [(eave - ridge) / 2, slope],
  ];
  const triangle: Vec2[] = [
    [0, 0],
    [end, 0],
    [end / 2, slope],
  ];
  return [
    face(1, eave, trapezoid),
    face(2, end, triangle),
    face(3, eave, trapezoid),
    face(4, end, triangle),
  ];
}
