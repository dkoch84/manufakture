// The drop-cutter (M5 plan T5.5a; ADR 0014 decision 13): the lowest tool tip height at an XY
// position at which a tool does not cut into a triangle mesh. Moved here from the T5.0b spike
// (`spikes/opencamlib/src/dropcutter.ts`, where it agreed with OpenCAMLib to 2.3e-12 mm for flat
// and ball cutters and did not gouge where OCL's cone cutter does), with bull-nose cutters, V-bits
// with a flat tip, the skip for triangles wholly below the current height, and cutters grown by a
// stock-to-leave added.
//
// Conventions follow OpenCAMLib: a cutter location is the tool tip, the axis is +Z, and dropping
// a cutter at (x, y) finds the lowest tip Z at which the tool clears every triangle, starting
// from `floor`. A cutter is a solid of revolution described by its profile: the height f(r) of
// its surface above the tip at radius r, for 0 <= r <= R (a straight shank of radius R above).
//
//   flat  f(r) = 0
//   ball  f(r) = R - sqrt(R^2 - r^2)
//   bull  f(r) = 0 for r <= R1, else c - sqrt(c^2 - (r - R1)^2)   (c the corner radius, R1 = R - c)
//   vbit  f(r) = 0 for r <= t, else (r - t) / tan(a)                (a the half angle, t the tip radius)
//
// Each triangle bounds the tip three ways, and the answer is the highest bound:
//
//   vertex  tip <= v.z - f(|v - c|) for a corner within R (in XY) of the axis c;
//   facet   the tool touches the triangle's plane at one known point of its surface, fixed by the
//           plane's normal; if that contact lies inside the triangle, it is the bound;
//   edge    in the vertical plane through an edge, at distance d from the axis, the tool's section
//           is z = f(sqrt(d^2 + s^2)) and the edge is a line z = z0 + m s. Every profile above is
//           convex and non-decreasing in r, so z0 + m s - f(sqrt(d^2 + s^2)) is concave in s, and
//           its maximum over the part of the edge under the tool is the free maximum clamped to that
//           interval: a closed form for flat, ball and sharp V cutters, a bisection on the
//           derivative (which is monotonic) for bull and flat-tipped V cutters.
//
// The index is a uniform XY grid in a compressed layout (one prefix-sum array, one item array).
// No dependencies; plain typed arrays, so the memory is about 150 bytes per triangle.

import { err, ok, type CamResult, type Mesh, type Tool } from '../types';

/** A cutter's shape for dropping, mm and radians. */
export type CutterShape =
  | { readonly kind: 'flat'; readonly radius: number }
  | { readonly kind: 'ball'; readonly radius: number }
  /** A bull nose (torus) cutter; `corner` in (0, radius]. A `corner` equal to the radius is a ball. */
  | { readonly kind: 'bull'; readonly radius: number; readonly corner: number }
  /** A V-bit: `halfAngle` in (0, pi / 2), a flat tip of `tipRadius` (0 for a sharp point). */
  | {
      readonly kind: 'vbit';
      readonly radius: number;
      readonly halfAngle: number;
      readonly tipRadius: number;
    };

/**
 * Anything that answers "how low may the tool tip go here": the drop-cutter below, or a later
 * engine (ADR 0014 decision 13 keeps surfacing behind one interface).
 */
export interface SurfaceSampler {
  /** The lowest tip Z at (x, y) that clears the mesh, or `floor` if nothing lower bounds it. */
  drop(x: number, y: number, floor: number): number;
}

export interface DropCutterOptions {
  /** Grid cell size, mm; default the cutter radius, at least 0.5 mm. */
  readonly cellSize?: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The cutter shape of a tool, grown by `allowance` (the Minkowski sum with a ball of that radius:
 * a flat end mill becomes a bull nose, a ball a larger ball, a bull a larger bull), and how far
 * below the real tool's tip the grown cutter's tip sits (`allowance`). Dropping the grown cutter
 * and adding `allowance` gives a tip height that keeps the real tool at least `allowance` from
 * the mesh. V-bits are only allowed with no allowance (a grown cone is not one of these shapes);
 * drills and engravers are refused.
 */
export function cutterForTool(
  tool: Pick<Tool, 'kind' | 'diameter' | 'cornerRadius' | 'angle' | 'tipDiameter'>,
  allowance = 0,
): CamResult<CutterShape> {
  const R = tool.diameter / 2;
  if (!(finite(R) && R > 0)) return err('invalid-input', 'The tool diameter must be positive.');
  if (!(finite(allowance) && allowance >= 0)) {
    return err('invalid-input', 'The stock to leave must be zero or more.');
  }
  const a = allowance;
  switch (tool.kind) {
    case 'flat':
      return ok(a > 0 ? { kind: 'bull', radius: R + a, corner: a } : { kind: 'flat', radius: R });
    case 'ball':
      return ok({ kind: 'ball', radius: R + a });
    case 'bull': {
      const c = tool.cornerRadius;
      if (!(finite(c) && c >= 0 && c <= R)) {
        return err('invalid-input', 'A bull nose tool needs a corner radius from 0 to its radius.');
      }
      if (c + a === 0) return ok({ kind: 'flat', radius: R });
      return ok({ kind: 'bull', radius: R + a, corner: c + a });
    }
    case 'vbit': {
      const angle = tool.angle;
      if (!(finite(angle) && angle > 0 && angle < Math.PI)) {
        return err('invalid-input', 'A V-bit needs an included angle between 0 and 180 degrees.');
      }
      const t = (tool.tipDiameter ?? 0) / 2;
      if (!(finite(t) && t >= 0 && t < R)) {
        return err('invalid-input', 'A V-bit tip must be at least 0 and narrower than the bit.');
      }
      if (a > 0) {
        return err(
          'invalid-input',
          'A V-bit cannot leave stock on a 3D surface; use a stock to leave of 0, or a ball or flat end mill.',
        );
      }
      return ok({ kind: 'vbit', radius: R, halfAngle: angle / 2, tipRadius: t });
    }
    default:
      return err('invalid-input', `A ${tool.kind} cannot machine a 3D surface.`);
  }
}

/** Barycentric slack for "inside the triangle", so a contact on a shared edge is never missed. */
const INSIDE_EPS = 1e-9;
const EPS = 1e-12;
/** Bisection steps for the bull and flat-tipped V edge test: well below 1e-12 mm on any edge. */
const BISECTIONS = 60;

/** Profile codes: closed forms for 0 to 2, bisection on the edge for 3 and 4. */
const FLAT = 0;
const BALL = 1;
const VBIT = 2;
const BULL = 3;
const VTIP = 4;

export class DropCutter implements SurfaceSampler {
  readonly shape: CutterShape;
  readonly triangles: number;
  /** Triangles tested by `drop` since the last `resetCount`. */
  tested = 0;
  private readonly R: number;
  /** Flat radius: of a bull's flat bottom, a V-bit's tip; 0 for the others. */
  private readonly R1: number;
  /** A bull's corner radius. */
  private readonly rc: number;
  /** Cotangent of a V-bit's half angle (dz / dr of its cone). */
  private readonly cot: number;
  private readonly profile: number;
  /** Nine coordinates per triangle. */
  private readonly t: Float64Array;
  /** Per triangle: nx, ny, nz, d of its plane (unit normal, turned to face up). */
  private readonly plane: Float64Array;
  /** Per triangle: xmin, ymin, xmax, ymax. */
  private readonly box: Float64Array;
  /** Per triangle: its highest Z. */
  private readonly top: Float64Array;
  private readonly cell: number;
  private readonly gx0: number;
  private readonly gy0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cellStart: Uint32Array;
  private readonly cellItems: Uint32Array;
  private readonly stamp: Uint32Array;
  private mark = 0;

  constructor(mesh: Mesh, shape: CutterShape, options: DropCutterOptions = {}) {
    if (!(finite(shape.radius) && shape.radius > 0)) {
      throw new RangeError('cutter radius must be positive');
    }
    this.shape = shape;
    this.R = shape.radius;
    this.R1 = 0;
    this.rc = 0;
    this.cot = 0;
    switch (shape.kind) {
      case 'flat':
        this.profile = FLAT;
        break;
      case 'ball':
        this.profile = BALL;
        break;
      case 'bull':
        if (!(shape.corner > 0 && shape.corner <= shape.radius)) {
          throw new RangeError('bull corner radius must be in (0, radius]');
        }
        this.profile = shape.corner === shape.radius ? BALL : BULL;
        this.rc = shape.corner;
        this.R1 = shape.radius - shape.corner;
        break;
      case 'vbit':
        if (!(shape.halfAngle > 0 && shape.halfAngle < Math.PI / 2)) {
          throw new RangeError('V-bit half angle must be in (0, pi / 2)');
        }
        if (!(shape.tipRadius >= 0 && shape.tipRadius < shape.radius)) {
          throw new RangeError('V-bit tip radius must be in [0, radius)');
        }
        this.cot = 1 / Math.tan(shape.halfAngle);
        this.R1 = shape.tipRadius;
        this.profile = shape.tipRadius > 0 ? VTIP : VBIT;
        break;
    }

    const { positions: p, indices: ix } = mesh;
    const n = Math.floor(ix.length / 3);
    this.triangles = n;
    this.t = new Float64Array(n * 9);
    this.plane = new Float64Array(n * 4);
    this.box = new Float64Array(n * 4);
    this.top = new Float64Array(n);
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    const t = this.t;
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      for (let c = 0; c < 3; c++) {
        const v = ix[i * 3 + c]! * 3;
        t[o + c * 3] = p[v]!;
        t[o + c * 3 + 1] = p[v + 1]!;
        t[o + c * 3 + 2] = p[v + 2]!;
      }
      const ax = t[o]!;
      const ay = t[o + 1]!;
      const az = t[o + 2]!;
      const ux = t[o + 3]! - ax;
      const uy = t[o + 4]! - ay;
      const uz = t[o + 5]! - az;
      const vx = t[o + 6]! - ax;
      const vy = t[o + 7]! - ay;
      const vz = t[o + 8]! - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > EPS) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = ny = nz = 0;
      }
      // A cutter only meets a plane from above, so a downward normal is flipped; the facet test
      // skips vertical (and degenerate) planes, whose contacts are on their edges and corners.
      if (nz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const b = i * 4;
      this.plane[b] = nx;
      this.plane[b + 1] = ny;
      this.plane[b + 2] = nz;
      this.plane[b + 3] = -(nx * ax + ny * ay + nz * az);
      const xmin = Math.min(ax, t[o + 3]!, t[o + 6]!);
      const xmax = Math.max(ax, t[o + 3]!, t[o + 6]!);
      const ymin = Math.min(ay, t[o + 4]!, t[o + 7]!);
      const ymax = Math.max(ay, t[o + 4]!, t[o + 7]!);
      this.box[b] = xmin;
      this.box[b + 1] = ymin;
      this.box[b + 2] = xmax;
      this.box[b + 3] = ymax;
      this.top[i] = Math.max(az, t[o + 5]!, t[o + 8]!);
      if (xmin < gx0) gx0 = xmin;
      if (ymin < gy0) gy0 = ymin;
      if (xmax > gx1) gx1 = xmax;
      if (ymax > gy1) gy1 = ymax;
    }
    if (n === 0) gx0 = gy0 = gx1 = gy1 = 0;

    // Uniform grid, compressed: count, prefix sum, fill.
    let cell = options.cellSize ?? Math.max(this.R, 0.5);
    if (!(finite(cell) && cell > 0)) throw new RangeError('cell size must be positive');
    const span = Math.max(gx1 - gx0, gy1 - gy0, cell);
    // At most about 4M cells.
    if ((span / cell) ** 2 > 4e6) cell = span / 2000;
    this.cell = cell;
    this.gx0 = gx0;
    this.gy0 = gy0;
    this.nx = Math.max(1, Math.ceil((gx1 - gx0) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((gy1 - gy0) / cell) + 1);
    const counts = new Uint32Array(this.nx * this.ny + 1);
    const box = this.box;
    for (let i = 0; i < n; i++) {
      const cx0 = Math.floor((box[i * 4]! - gx0) / cell);
      const cy0 = Math.floor((box[i * 4 + 1]! - gy0) / cell);
      const cx1 = Math.floor((box[i * 4 + 2]! - gx0) / cell);
      const cy1 = Math.floor((box[i * 4 + 3]! - gy0) / cell);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) counts[cy * this.nx + cx + 1]!++;
    }
    for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!;
    this.cellStart = counts;
    this.cellItems = new Uint32Array(counts[counts.length - 1]!);
    const fill = counts.slice(0, counts.length - 1);
    for (let i = 0; i < n; i++) {
      const cx0 = Math.floor((box[i * 4]! - gx0) / cell);
      const cy0 = Math.floor((box[i * 4 + 1]! - gy0) / cell);
      const cx1 = Math.floor((box[i * 4 + 2]! - gx0) / cell);
      const cy1 = Math.floor((box[i * 4 + 3]! - gy0) / cell);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) this.cellItems[fill[cy * this.nx + cx]!++] = i;
    }
    this.stamp = new Uint32Array(n);
  }

  /** f(r): the cutter surface's height above its tip at radius r <= R. */
  private f(r: number): number {
    switch (this.profile) {
      case FLAT:
        return 0;
      case BALL: {
        const R = this.R;
        return R - Math.sqrt(Math.max(0, R * R - r * r));
      }
      case VBIT:
        return r * this.cot;
      case BULL: {
        const u = r - this.R1;
        if (u <= 0) return 0;
        const c = this.rc;
        return c - Math.sqrt(Math.max(0, c * c - u * u));
      }
      default:
        return r <= this.R1 ? 0 : (r - this.R1) * this.cot;
    }
  }

  /** f'(r), for the bisection profiles (bull and flat-tipped V). */
  private df(r: number): number {
    if (r <= this.R1) return 0;
    if (this.profile === VTIP) return this.cot;
    const u = r - this.R1;
    const den = this.rc * this.rc - u * u;
    return den <= 0 ? Infinity : u / Math.sqrt(den);
  }

  /** The lowest tip Z at (x, y) that clears the mesh, or `floor` if nothing is under the tool. */
  drop(x: number, y: number, floor: number): number {
    const R = this.R;
    const R2 = R * R;
    let z = floor;
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
    const top = this.top;
    const prof = this.profile;
    const cot = this.cot;
    const R1 = this.R1;
    const rc = this.rc;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.nx;
      for (let cx = cx0; cx <= cx1; cx++) {
        const end = this.cellStart[row + cx + 1]!;
        for (let k = this.cellStart[row + cx]!; k < end; k++) {
          const i = this.cellItems[k]!;
          if (this.stamp[i] === mark) continue;
          this.stamp[i] = mark;
          // Every bound a triangle gives is at most its highest corner.
          if (top[i]! <= z) continue;
          const b = i * 4;
          if (box[b]! > x + R || box[b + 2]! < x - R || box[b + 1]! > y + R || box[b + 3]! < y - R)
            continue;
          this.tested++;
          const o = i * 9;

          // Vertices.
          for (let c = 0; c < 9; c += 3) {
            const dx = t[o + c]! - x;
            const dy = t[o + c + 1]! - y;
            const r2 = dx * dx + dy * dy;
            if (r2 <= R2) {
              const h = t[o + c + 2]! - this.f(Math.sqrt(r2));
              if (h > z) z = h;
            }
          }

          // Facet.
          const nx = plane[b]!;
          const ny = plane[b + 1]!;
          const nz = plane[b + 2]!;
          if (nz > 1e-9) {
            const nh = Math.sqrt(nx * nx + ny * ny);
            const ux = nh > 1e-12 ? nx / nh : 0;
            const uy = nh > 1e-12 ? ny / nh : 0;
            let ccx: number;
            let ccy: number;
            let lift = 0;
            if (prof === BALL) {
              ccx = x - R * nx;
              ccy = y - R * ny;
              lift = R * (1 - nz);
            } else if (prof === FLAT) {
              // The rim, uphill side.
              ccx = x - R * ux;
              ccy = y - R * uy;
            } else if (prof === BULL) {
              // The torus: its tube circle's point furthest down the plane, then down the normal.
              ccx = x - R1 * ux - rc * nx;
              ccy = y - R1 * uy - rc * ny;
              lift = rc * (1 - nz);
            } else if (nh / nz > cot) {
              // A V-bit on a plane steeper than its cone: the rim.
              ccx = x - R * ux;
              ccy = y - R * uy;
              lift = (R - R1) * cot;
            } else {
              // Otherwise the tip (the rim of a flat tip, uphill).
              ccx = x - R1 * ux;
              ccy = y - R1 * uy;
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
            const az = t[a + 2]!;
            const cz = t[c + 2]!;
            if (az <= z && cz <= z) continue;
            const ax = t[a]!;
            const ay = t[a + 1]!;
            const ex = t[c]! - ax;
            const ey = t[c + 1]! - ay;
            const len = Math.sqrt(ex * ex + ey * ey);
            if (len < 1e-12) continue; // a vertical edge: its ends are the vertex tests
            const ux = ex / len;
            const uy = ey / len;
            const px = x - ax;
            const py = y - ay;
            const d = Math.abs(px * uy - py * ux);
            if (d > R) continue;
            const t0 = px * ux + py * uy; // the axis's foot along the edge
            const w = Math.sqrt(Math.max(0, R2 - d * d));
            const lo = Math.max(-w, -t0);
            const hi = Math.min(w, len - t0);
            if (lo > hi) continue;
            const m = (cz - az) / len;
            let s: number;
            if (prof === FLAT) {
              s = m > 0 ? hi : lo;
            } else if (prof === BALL) {
              s = (m * w) / Math.sqrt(1 + m * m);
            } else if (prof === VBIT) {
              const q = m / cot; // m * tan(half angle)
              s = Math.abs(q) < 1 ? (d * q) / Math.sqrt(1 - q * q) : q > 0 ? w : -w;
            } else {
              s = this.edgeMax(m, d, lo, hi);
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

  /** Where m s - f(sqrt(d^2 + s^2)) peaks on [lo, hi]: bisection on its decreasing derivative. */
  private edgeMax(m: number, d: number, lo: number, hi: number): number {
    const slope = (s: number): number => {
      const r = Math.sqrt(d * d + s * s);
      if (r < 1e-15) return m;
      const g = this.df(r);
      return g === Infinity ? (s > 0 ? -Infinity : s < 0 ? Infinity : m) : m - (g * s) / r;
    };
    if (slope(lo) <= 0) return lo;
    if (slope(hi) >= 0) return hi;
    let a = lo;
    let b = hi;
    for (let k = 0; k < BISECTIONS && b - a > 1e-13; k++) {
      const mid = (a + b) / 2;
      if (slope(mid) > 0) a = mid;
      else b = mid;
    }
    return (a + b) / 2;
  }

  /** Drop at every (x, y) pair; one Z per pair. */
  dropPoints(xy: Float64Array, floor: number): Float64Array {
    const out = new Float64Array(xy.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = this.drop(xy[i * 2]!, xy[i * 2 + 1]!, floor);
    return out;
  }
}

/** Is (x, y) inside the XY projection of triangle o, with a little slack on the edges? */
function insideXY(t: Float64Array, o: number, x: number, y: number): boolean {
  const ax = t[o]!;
  const ay = t[o + 1]!;
  const v0x = t[o + 3]! - ax;
  const v0y = t[o + 4]! - ay;
  const v1x = t[o + 6]! - ax;
  const v1y = t[o + 7]! - ay;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-18) return false;
  const px = x - ax;
  const py = y - ay;
  const u = (px * v1y - v1x * py) / den;
  const v = (v0x * py - px * v0y) / den;
  return u >= -INSIDE_EPS && v >= -INSIDE_EPS && u + v <= 1 + INSIDE_EPS;
}

/** The axis-aligned bounds of a mesh's vertices that triangles use; undefined for no triangles. */
export function meshBounds(
  mesh: Mesh,
): { min: [number, number, number]; max: [number, number, number] } | undefined {
  const { positions: p, indices: ix } = mesh;
  if (ix.length < 3) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < ix.length; k++) {
    const v = ix[k]! * 3;
    for (let a = 0; a < 3; a++) {
      const c = p[v + a]!;
      if (c < min[a]!) min[a] = c;
      if (c > max[a]!) max[a] = c;
    }
  }
  return { min, max };
}
