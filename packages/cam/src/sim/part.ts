// The part's own heightmap for the gouge check (M5 plan, T5.3c): its mesh rastered top-down on the
// simulation's grid, in machine coordinates. A cell's part height is the highest point of the mesh
// over the cell's centre, or -Infinity where the part is not under it (the waste around a profile,
// a through hole). Rastering top-down is exact for a 3-axis job: a heightfield cannot hold an
// undercut, and neither can the material the tool leaves.

import type { Mesh, Vec3, WcsFrame } from '../types';
import { toMachine } from '../wcs';
import { cellX, cellY, type SimGrid } from './heightfield';

/** A mesh's positions in machine coordinates (a copy; indices are shared). */
export function meshToMachine(mesh: Mesh, frame: WcsFrame): Mesh {
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i + 2 < p.length; i += 3) {
    const q = toMachine(frame, [p[i]!, p[i + 1]!, p[i + 2]!] as Vec3);
    out[i] = q[0];
    out[i + 1] = q[1];
    out[i + 2] = q[2];
  }
  return { positions: out, indices: mesh.indices };
}

/** The highest Z of the mesh over each cell centre; -Infinity where there is none. */
export function rasterPart(mesh: Mesh, g: SimGrid): Float32Array {
  const out = new Float32Array(g.nx * g.ny).fill(-Infinity);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    const ax = p[a]!;
    const ay = p[a + 1]!;
    const az = p[a + 2]!;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const bz = p[b + 2]!;
    const cx = p[c]!;
    const cy = p[c + 1]!;
    const cz = p[c + 2]!;
    // Twice the signed area in XY; a wall seen edge-on covers nothing.
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - g.x0) / g.cell - 0.5));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx, cx) - g.x0) / g.cell - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - g.y0) / g.cell - 0.5));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(ay, by, cy) - g.y0) / g.cell - 0.5));
    // Barycentric weights, with a little slack so that a centre on a shared edge is covered.
    const eps = -1e-9 * Math.abs(area);
    for (let j = j0; j <= j1; j++) {
      const y = cellY(g, j);
      for (let i = i0; i <= i1; i++) {
        const x = cellX(g, i);
        const w0 = (bx - x) * (cy - y) - (by - y) * (cx - x);
        const w1 = (cx - x) * (ay - y) - (cy - y) * (ax - x);
        const w2 = (ax - x) * (by - y) - (ay - y) * (bx - x);
        const inside =
          area > 0 ? w0 >= eps && w1 >= eps && w2 >= eps : w0 <= -eps && w1 <= -eps && w2 <= -eps;
        if (!inside) continue;
        const z = (w0 * az + w1 * bz + w2 * cz) / area;
        const k = j * g.nx + i;
        if (z > out[k]!) out[k] = z;
      }
    }
  }
  return out;
}

/**
 * The part's heights widened by a sideways allowance `side` (mm) for the comparison: per cell, `low`
 * is the lowest the part's surface gets within `side` of the cell's centre in XY and `high` the
 * highest; -Infinity in both where the part is not under the centre (those cells are not compared).
 * A cut is a gouge only below `low`, and material is left over only above `high`, so a cell centre
 * within `side` of a wall (the tool's edge is on it when the offset is right, give or take the
 * mesh's and the toolpath's chord deflection) is never a gouge, while one further in is checked
 * however close to where the part ends. The allowance is a distance, not a number of cells.
 *
 * Only what can be seen from above counts: triangles facing up (by the mesh's winding, outward as
 * the kernel tessellates; `upSign` reads it from the mesh) and walls (triangles seen edge-on), never
 * the part's underside. Each triangle's contribution is bounded by its plane: over the disc of
 * radius `side` about the centre, a plane of slope G ranges over its value at the centre plus or
 * minus G times `side`, clamped to the triangle's own Z range. A wall contributes its Z range.
 */
export function partBands(
  mesh: Mesh,
  g: SimGrid,
  part: Float32Array,
  side: number,
): { low: Float32Array; high: Float32Array } {
  const low = part.slice();
  const high = part.slice();
  const s = Math.max(0, side);
  const s2 = s * s;
  const p = mesh.positions;
  const idx = mesh.indices;
  const up = upSign(mesh);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    const ax = p[a]!;
    const ay = p[a + 1]!;
    const az = p[a + 2]!;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const bz = p[b + 2]!;
    const cx = p[c]!;
    const cy = p[c + 1]!;
    const cz = p[c + 2]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const planar = Math.abs(area) >= 1e-12;
    if (planar && area * up < 0) continue; // facing down: under the part, not seen from above
    const zMin = Math.min(az, bz, cz);
    const zMax = Math.max(az, bz, cz);
    // The plane z = az + ga (x - ax) + gb (y - ay), and its slope.
    const ga = planar ? ((bz - az) * (cy - ay) - (cz - az) * (by - ay)) / area : 0;
    const gb = planar ? ((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / area : 0;
    const slack = Math.hypot(ga, gb) * s;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - s - g.x0) / g.cell - 0.5));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx, cx) + s - g.x0) / g.cell - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - s - g.y0) / g.cell - 0.5));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(ay, by, cy) + s - g.y0) / g.cell - 0.5));
    for (let j = j0; j <= j1; j++) {
      const y = cellY(g, j);
      for (let i = i0; i <= i1; i++) {
        const k = j * g.nx + i;
        if (part[k]! === -Infinity) continue;
        const x = cellX(g, i);
        let inside = false;
        if (planar) {
          const w0 = (bx - x) * (cy - y) - (by - y) * (cx - x);
          const w1 = (cx - x) * (ay - y) - (cy - y) * (ax - x);
          const w2 = (ax - x) * (by - y) - (ay - y) * (bx - x);
          inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
        }
        if (
          !inside &&
          segment2(x, y, ax, ay, bx, by) > s2 &&
          segment2(x, y, bx, by, cx, cy) > s2 &&
          segment2(x, y, cx, cy, ax, ay) > s2
        ) {
          continue;
        }
        let lo = zMin;
        let hi = zMax;
        if (planar) {
          const z = az + ga * (x - ax) + gb * (y - ay);
          lo = Math.max(lo, z - slack);
          hi = Math.min(hi, z + slack);
        }
        if (lo < low[k]!) low[k] = lo;
        if (hi > high[k]!) high[k] = hi;
      }
    }
  }
  return { low, high };
}

/**
 * +1 when the mesh's triangles wind counter-clockwise seen from outside (a triangle facing up has a
 * positive XY area), -1 when the other way (a mirrored frame, an inside-out mesh): the sign of the
 * enclosed volume, or for an open mesh of the projected area (a sheet is taken to face up).
 */
export function upSign(mesh: Mesh): 1 | -1 {
  const p = mesh.positions;
  const idx = mesh.indices;
  let volume = 0;
  let projected = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    const ax = p[a]!;
    const ay = p[a + 1]!;
    const az = p[a + 2]!;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const bz = p[b + 2]!;
    const cx = p[c]!;
    const cy = p[c + 1]!;
    const cz = p[c + 2]!;
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    projected += (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }
  const s = Math.abs(volume) > 1e-9 ? volume : projected;
  return s < 0 ? -1 : 1;
}

/** The squared XY distance from (x, y) to the segment from (ax, ay) to (bx, by). */
function segment2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let u = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ex = x - ax - u * dx;
  const ey = y - ay - u * dy;
  return ex * ex + ey * ey;
}
