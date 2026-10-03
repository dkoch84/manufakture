// The simulation's heightmap as a displaced grid for the view (M5 plan, T5.3c). Pure: no three.js.
//
// One vertex per cell centre, at the material top, in machine coordinates; two triangles per
// square of four neighbouring centres. A heightmap with more cells than `SIM_VIEW_MAX_VERTICES`
// is shown coarser: each vertex stands for a block of `stride` by `stride` cells and takes the
// block's lowest height (so a slot narrower than a block still shows) and its most important
// class (a gouge over leftover material over anything else), so a gouge is never hidden by the
// display's own resolution.

import { SIM_CLASS, type Heightmap } from '@manufakture/cam';

/** The most vertices the displayed grid has: about 260,000 (a 512 x 512 grid). */
export const SIM_VIEW_MAX_VERTICES = 512 * 512;

/** Colours as sRGB hex; the vertex colours hold them as linear RGB, as three.js expects. */
export const SIM_COLORS = {
  /** Material not touched yet. */
  stock: '#c8a46e',
  /** Material a tool has cut. */
  cut: '#e8d7b4',
  gouge: '#d62828',
  leftover: '#e0a100',
} as const;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  // sRGB to linear, as three.js expects vertex colours.
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
}

const STOCK = rgb(SIM_COLORS.stock);
const CUT = rgb(SIM_COLORS.cut);
const GOUGE = rgb(SIM_COLORS.gouge);
const LEFTOVER = rgb(SIM_COLORS.leftover);

export interface SimGridData {
  /** Vertices along X and Y. */
  readonly nx: number;
  readonly ny: number;
  /** Cells per vertex along each axis. */
  readonly stride: number;
  /** xyz per vertex, machine coordinates. */
  readonly positions: Float32Array;
  /** rgb per vertex, linear. */
  readonly colors: Float32Array;
  /** Vertices in gouged cells. */
  readonly gougeVertices: number;
}

/** The cells per displayed vertex for a heightmap. */
export function simStride(nx: number, ny: number, maxVertices = SIM_VIEW_MAX_VERTICES): number {
  let s = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / maxVertices)));
  while (Math.ceil(nx / s) * Math.ceil(ny / s) > maxVertices) s++;
  return s;
}

/**
 * The displayed grid of a heightmap. `stockTop` tells cut cells from untouched ones; `classes`
 * (`SIM_CLASS` per cell) colours gouges and leftovers when given. Pass `into` (from an earlier call
 * on a heightmap of the same size) to write into its arrays instead of new ones.
 */
export function simGridData(
  heightmap: Heightmap,
  stockTop: number,
  classes?: Uint8Array,
  into?: SimGridData,
  maxVertices = SIM_VIEW_MAX_VERTICES,
): SimGridData {
  const { nx: cx, ny: cy, cell, origin, heights } = heightmap;
  const stride = simStride(cx, cy, maxVertices);
  const nx = Math.ceil(cx / stride);
  const ny = Math.ceil(cy / stride);
  const reuse = into && into.nx === nx && into.ny === ny && into.stride === stride;
  const positions = reuse ? into.positions : new Float32Array(nx * ny * 3);
  const colors = reuse ? into.colors : new Float32Array(nx * ny * 3);
  let gougeVertices = 0;
  for (let b = 0; b < ny; b++) {
    for (let a = 0; a < nx; a++) {
      let low = Infinity;
      let cls: number = SIM_CLASS.none;
      const i1 = Math.min(cx, (a + 1) * stride);
      const j1 = Math.min(cy, (b + 1) * stride);
      for (let j = b * stride; j < j1; j++) {
        for (let i = a * stride; i < i1; i++) {
          const k = j * cx + i;
          const h = heights[k]!;
          if (h < low) low = h;
          const c = classes ? classes[k]! : SIM_CLASS.none;
          if (c === SIM_CLASS.gouge) cls = c;
          else if (c === SIM_CLASS.leftover && cls !== SIM_CLASS.gouge) cls = c;
        }
      }
      const v = (b * nx + a) * 3;
      // The block's centre.
      positions[v] = origin[0] + ((a * stride + i1) / 2) * cell;
      positions[v + 1] = origin[1] + ((b * stride + j1) / 2) * cell;
      positions[v + 2] = low;
      const color =
        cls === SIM_CLASS.gouge
          ? GOUGE
          : cls === SIM_CLASS.leftover
            ? LEFTOVER
            : low < stockTop - 1e-4
              ? CUT
              : STOCK;
      if (cls === SIM_CLASS.gouge) gougeVertices++;
      colors[v] = color[0];
      colors[v + 1] = color[1];
      colors[v + 2] = color[2];
    }
  }
  return { nx, ny, stride, positions, colors, gougeVertices };
}

/** Triangle indices of an `nx` by `ny` vertex grid, counter-clockwise seen from +Z. */
export function simGridIndices(nx: number, ny: number): Uint32Array {
  const out = new Uint32Array(Math.max(0, nx - 1) * Math.max(0, ny - 1) * 6);
  let t = 0;
  for (let b = 0; b + 1 < ny; b++) {
    for (let a = 0; a + 1 < nx; a++) {
      const v = b * nx + a;
      out[t++] = v;
      out[t++] = v + 1;
      out[t++] = v + nx + 1;
      out[t++] = v;
      out[t++] = v + nx + 1;
      out[t++] = v + nx;
    }
  }
  return out;
}
