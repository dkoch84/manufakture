// A TypeScript drop-cutter for flat, ball and V cutters against a triangle mesh, with a uniform
// XY grid index. The candidate for T5.5a's parallel finish if it holds up against OpenCAMLib.
//
// Conventions follow OCL: a cutter location (CL) is the tool tip, the axis is +Z, and dropping
// a cutter at (x, y) finds the lowest tip Z at which the tool does not cut into any triangle,
// starting from `minZ`. A cutter is a solid of revolution described by its profile: the height
// f(r) of its surface above the tip at radius r, for 0 <= r <= R.
//
//   flat  f(r) = 0
//   ball  f(r) = R - sqrt(R^2 - r^2)
//   vbit  f(r) = r / tan(a), a the half angle (a cone up to the full diameter, a shaft above it)
//
// Each triangle constrains the tip by three tests, and the answer is the highest constraint:
//
//   vertex  tip <= v.z - f(|v - c|) for a corner within R (in XY) of the axis c;
//   facet   the tool touches the triangle's plane at one known point of its surface (it depends on
//           the plane's normal only); if that contact lies inside the triangle, it is the bound;
//   edge    in the vertical plane through an edge, at distance d from the axis, the tool's
//           section is z = f(sqrt(d^2 + s^2)); the edge is a line z = z0 + m s. The bound
//           z0 + m s - f(sqrt(d^2 + s^2)) is concave in s for all three profiles, so its maximum
//           over the part of the edge under the tool is the free maximum clamped to that interval,
//           which has a closed form per profile.

import type { Mesh } from './geometry.ts';

export type Cutter =
  | { kind: 'flat'; diameter: number }
  | { kind: 'ball'; diameter: number }
  /** `angle` is the included angle in degrees (a 60 degree V-bit has a 30 degree half angle). */
  | { kind: 'vbit'; diameter: number; angle: number };

export interface DropCutterOptions {
  /** Grid cell size in mm; default the cutter radius, at least 0.5 mm. */
  cellSize?: number;
}

const EPS = 1e-12;
/** Barycentric slack for "inside the triangle", so a contact on a shared edge is never missed. */
const INSIDE_EPS = 1e-9;

export class DropCutter {
  readonly cutter: Cutter;
  readonly triangles: number;
  private readonly R: number;
  /** cot of the V-bit half angle (dz / dr of its cone); 0 for the other cutters. */
  private readonly cot: number;
  private readonly profile: 0 | 1 | 2;
  /** Nine coordinates per triangle. */
  private readonly t: Float64Array;
  /** Per triangle: nx, ny, nz, d of its plane (unit normal, nz >= 0 only kept for facets). */
  private readonly plane: Float64Array;
  /** Per triangle: xmin, ymin, xmax, ymax. */
  private readonly box: Float64Array;
  private readonly cell: number;
  private readonly gx0: number;
  private readonly gy0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cellStart: Uint32Array;
  private readonly cellItems: Uint32Array;
  private readonly stamp: Uint32Array;
  private mark = 0;
  /** Triangles tested by the last call, for the report. */
  tested = 0;

  constructor(mesh: Mesh, cutter: Cutter, options: DropCutterOptions = {}) {
    if (!(cutter.diameter > 0)) throw new RangeError('cutter diameter must be positive');
    this.cutter = cutter;
    this.R = cutter.diameter / 2;
    this.profile = cutter.kind === 'flat' ? 0 : cutter.kind === 'ball' ? 1 : 2;
    if (cutter.kind === 'vbit') {
      if (!(cutter.angle > 0 && cutter.angle < 180)) {
        throw new RangeError('V-bit angle must be between 0 and 180 degrees');
      }
      this.cot = 1 / Math.tan(((cutter.angle / 2) * Math.PI) / 180);
    } else {
      this.cot = 0;
    }

    const { positions: p, indices: ix } = mesh;
    const n = ix.length / 3;
    this.triangles = n;
    this.t = new Float64Array(n * 9);
    this.plane = new Float64Array(n * 4);
    this.box = new Float64Array(n * 4);
    let gx0 = Infinity,
      gy0 = Infinity,
      gx1 = -Infinity,
      gy1 = -Infinity;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = ix[i * 3 + c]! * 3;
        this.t[i * 9 + c * 3] = p[v]!;
        this.t[i * 9 + c * 3 + 1] = p[v + 1]!;
        this.t[i * 9 + c * 3 + 2] = p[v + 2]!;
      }
      const o = i * 9;
      const ax = this.t[o]!,
        ay = this.t[o + 1]!,
        az = this.t[o + 2]!;
      const ux = this.t[o + 3]! - ax,
        uy = this.t[o + 4]! - ay,
        uz = this.t[o + 5]! - az;
      const vx = this.t[o + 6]! - ax,
        vy = this.t[o + 7]! - ay,
        vz = this.t[o + 8]! - az;
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > EPS) {
        nx /= len;
        ny /= len;
        nz /= len;
      }
      // Drop-cutter only meets a plane from above, so flip a downward normal; the facet test
      // skips vertical planes (nz near 0), whose contacts are on their edges.
      if (nz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      this.plane[i * 4] = nx;
      this.plane[i * 4 + 1] = ny;
      this.plane[i * 4 + 2] = nz;
      this.plane[i * 4 + 3] = -(nx * ax + ny * ay + nz * az);
      const xmin = Math.min(ax, this.t[o + 3]!, this.t[o + 6]!);
      const xmax = Math.max(ax, this.t[o + 3]!, this.t[o + 6]!);
      const ymin = Math.min(ay, this.t[o + 4]!, this.t[o + 7]!);
      const ymax = Math.max(ay, this.t[o + 4]!, this.t[o + 7]!);
      this.box[i * 4] = xmin;
      this.box[i * 4 + 1] = ymin;
      this.box[i * 4 + 2] = xmax;
      this.box[i * 4 + 3] = ymax;
      if (xmin < gx0) gx0 = xmin;
      if (ymin < gy0) gy0 = ymin;
      if (xmax > gx1) gx1 = xmax;
      if (ymax > gy1) gy1 = ymax;
    }
    if (n === 0) gx0 = gy0 = gx1 = gy1 = 0;

    // Uniform grid, CSR layout: count, prefix sum, fill.
    let cell = options.cellSize ?? Math.max(this.R, 0.5);
    const span = Math.max(gx1 - gx0, gy1 - gy0, cell);
    // Keep the grid under about 4M cells.
    if ((span / cell) ** 2 > 4e6) cell = span / 2000;
    this.cell = cell;
    this.gx0 = gx0;
    this.gy0 = gy0;
    this.nx = Math.max(1, Math.ceil((gx1 - gx0) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((gy1 - gy0) / cell) + 1);
    const counts = new Uint32Array(this.nx * this.ny + 1);
    const range = (i: number): [number, number, number, number] => [
      Math.floor((this.box[i * 4]! - gx0) / cell),
      Math.floor((this.box[i * 4 + 1]! - gy0) / cell),
      Math.floor((this.box[i * 4 + 2]! - gx0) / cell),
      Math.floor((this.box[i * 4 + 3]! - gy0) / cell),
    ];
    for (let i = 0; i < n; i++) {
      const [cx0, cy0, cx1, cy1] = range(i);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) counts[cy * this.nx + cx + 1]!++;
    }
    for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!;
    this.cellStart = counts;
    this.cellItems = new Uint32Array(counts[counts.length - 1]!);
    const fill = counts.slice(0, counts.length - 1);
    for (let i = 0; i < n; i++) {
      const [cx0, cy0, cx1, cy1] = range(i);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) this.cellItems[fill[cy * this.nx + cx]!++] = i;
    }
    this.stamp = new Uint32Array(n);
  }

  /** f(r): the cutter surface's height above its tip at radius r <= R. */
  private f(r: number): number {
    switch (this.profile) {
      case 0:
        return 0;
      case 1: {
        const R = this.R;
        return R - Math.sqrt(Math.max(0, R * R - r * r));
      }
      default:
        return r * this.cot;
    }
  }

  /** The lowest tip Z at (x, y) that clears the mesh, or `minZ` if nothing is under the tool. */
  drop(x: number, y: number, minZ: number): number {
    const R = this.R;
    const R2 = R * R;
    let z = minZ;
    const cell = this.cell;
    const cx0 = Math.max(0, Math.floor((x - R - this.gx0) / cell));
    const cy0 = Math.max(0, Math.floor((y - R - this.gy0) / cell));
    const cx1 = Math.min(this.nx - 1, Math.floor((x + R - this.gx0) / cell));
    const cy1 = Math.min(this.ny - 1, Math.floor((y + R - this.gy0) / cell));
    if (cx0 > cx1 || cy0 > cy1) return z;
    if (++this.mark === 0xffffffff) {
      this.stamp.fill(0);
      this.mark = 1;
    }
    const mark = this.mark;
    const t = this.t;
    const box = this.box;
    const plane = this.plane;
    const prof = this.profile;
    const cot = this.cot;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.nx;
      for (let cx = cx0; cx <= cx1; cx++) {
        const end = this.cellStart[row + cx + 1]!;
        for (let k = this.cellStart[row + cx]!; k < end; k++) {
          const i = this.cellItems[k]!;
          if (this.stamp[i] === mark) continue;
          this.stamp[i] = mark;
          // Quick reject: the triangle's XY box against the tool's disc (as a box).
          const b = i * 4;
          if (box[b]! > x + R || box[b + 2]! < x - R || box[b + 1]! > y + R || box[b + 3]! < y - R)
            continue;
          this.tested++;
          const o = i * 9;

          // Vertices.
          for (let c = 0; c < 9; c += 3) {
            const dx = t[o + c]! - x,
              dy = t[o + c + 1]! - y;
            const r2 = dx * dx + dy * dy;
            if (r2 <= R2) {
              const h = t[o + c + 2]! - this.f(Math.sqrt(r2));
              if (h > z) z = h;
            }
          }

          // Facet.
          const nx = plane[b]!,
            ny = plane[b + 1]!,
            nz = plane[b + 2]!;
          if (nz > 1e-9) {
            let ccx = x,
              ccy = y,
              lift = 0;
            const nh = Math.sqrt(nx * nx + ny * ny);
            if (prof === 1) {
              ccx = x - R * nx;
              ccy = y - R * ny;
              lift = R * (1 - nz);
            } else if (nh > 1e-12 && (prof === 0 || nh / nz > cot)) {
              // Flat: the rim, uphill side. V-bit on a plane steeper than its cone: the rim too.
              ccx = x - (R * nx) / nh;
              ccy = y - (R * ny) / nh;
              lift = prof === 2 ? R * cot : 0;
            }
            if (insideXY(t, o, ccx, ccy)) {
              const h = -(nx * ccx + ny * ccy + plane[b + 3]!) / nz - lift;
              if (h > z) z = h;
            }
          }

          // Edges.
          for (let e = 0; e < 3; e++) {
            const a = o + e * 3;
            const c = o + ((e + 1) % 3) * 3;
            const ax = t[a]!,
              ay = t[a + 1]!,
              az = t[a + 2]!;
            const ex = t[c]! - ax,
              ey = t[c + 1]! - ay;
            const len = Math.sqrt(ex * ex + ey * ey);
            if (len < 1e-12) continue; // vertical edge: its ends are the vertex tests
            const ux = ex / len,
              uy = ey / len;
            const px = x - ax,
              py = y - ay;
            const d = Math.abs(px * uy - py * ux);
            if (d > R) continue;
            const t0 = px * ux + py * uy; // foot of the axis along the edge
            const w = Math.sqrt(Math.max(0, R2 - d * d));
            const lo = Math.max(-w, -t0);
            const hi = Math.min(w, len - t0);
            if (lo > hi) continue;
            const m = (t[c + 2]! - az) / len;
            let s: number;
            if (prof === 0) {
              s = m > 0 ? hi : m < 0 ? lo : lo;
            } else if (prof === 1) {
              s = (m * w) / Math.sqrt(1 + m * m);
            } else {
              const q = m / cot; // m * tan(half angle)
              s = Math.abs(q) < 1 ? (d * q) / Math.sqrt(1 - q * q) : q > 0 ? w : -w;
            }
            if (s < lo) s = lo;
            else if (s > hi) s = hi;
            const r = Math.min(R, Math.sqrt(d * d + s * s));
            const h = az + m * (t0 + s) - this.f(r);
            if (h > z) z = h;
          }
        }
      }
    }
    return z;
  }

  /** Drop at every (x, y) pair; returns one Z per pair. */
  dropPoints(xy: Float64Array, minZ: number): Float64Array {
    this.tested = 0;
    const out = new Float64Array(xy.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = this.drop(xy[i * 2]!, xy[i * 2 + 1]!, minZ);
    return out;
  }
}

/** Is (x, y) inside the XY projection of triangle o, with a little slack on the edges? */
function insideXY(t: Float64Array, o: number, x: number, y: number): boolean {
  const ax = t[o]!,
    ay = t[o + 1]!;
  const v0x = t[o + 3]! - ax,
    v0y = t[o + 4]! - ay;
  const v1x = t[o + 6]! - ax,
    v1y = t[o + 7]! - ay;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-18) return false;
  const px = x - ax,
    py = y - ay;
  const u = (px * v1y - v1x * py) / den;
  const v = (v0x * py - px * v0y) / den;
  return u >= -INSIDE_EPS && v >= -INSIDE_EPS && u + v <= 1 + INSIDE_EPS;
}
