// Plain mesh helpers shared by both drop-cutters and the checks: no kernel, no OCL.

export interface Mesh {
  name: string;
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise from outside. */
  indices: Uint32Array;
}

export interface Box3 {
  min: [number, number, number];
  max: [number, number, number];
}

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}

export function bounds(mesh: Mesh): Box3 {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/** Raster lines along X, `stepover` apart in Y, covering the box grown by `margin`. */
export function rasterLines(
  box: Box3,
  stepover: number,
  margin: number,
): Array<[number, number, number, number]> {
  const x0 = box.min[0] - margin;
  const x1 = box.max[0] + margin;
  const y0 = box.min[1] - margin;
  const y1 = box.max[1] + margin;
  const n = Math.floor((y1 - y0) / stepover + 1e-9);
  const lines: Array<[number, number, number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const y = y0 + i * stepover;
    lines.push(i % 2 === 0 ? [x0, y, x1, y] : [x1, y, x0, y]);
  }
  return lines;
}

/**
 * Sample lines the way OCL's PathDropCutter does (`num_steps = floor(length / sampling + 1)`,
 * both ends included), so the two cutters see the same XY points. Returns x, y pairs.
 */
export function sampleLines(
  lines: ReadonlyArray<readonly [number, number, number, number]>,
  sampling: number,
): Float64Array {
  const out: number[] = [];
  for (const [ax, ay, bx, by] of lines) {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.floor(len / sampling + 1);
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      out.push(ax + (bx - ax) * f, ay + (by - ay) * f);
    }
  }
  return Float64Array.from(out);
}

/** Squared distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDistance2(
  px: number,
  py: number,
  pz: number,
  t: ArrayLike<number>,
  o: number,
): number {
  const ax = t[o]!,
    ay = t[o + 1]!,
    az = t[o + 2]!;
  const bx = t[o + 3]!,
    by = t[o + 4]!,
    bz = t[o + 5]!;
  const cx = t[o + 6]!,
    cy = t[o + 7]!,
    cz = t[o + 8]!;
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const acx = cx - ax,
    acy = cy - ay,
    acz = cz - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = px - bx,
      bpy = py - by,
      bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - cx,
      cpy = py - cy,
      cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx;
      qy = by;
      qz = bz;
    } else if (d6 >= 0 && d5 <= d6) {
      qx = cx;
      qy = cy;
      qz = cz;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + v * abx;
      qy = ay + v * aby;
      qz = az + v * abz;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + w * acx;
      qy = ay + w * acy;
      qz = az + w * acz;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = bx + w * (cx - bx);
      qy = by + w * (cy - by);
      qz = bz + w * (cz - bz);
    } else {
      const denom = 1 / (va + vb + vc);
      const v = vb * denom;
      const w = vc * denom;
      qx = ax + abx * v + acx * w;
      qy = ay + aby * v + acy * w;
      qz = az + abz * v + acz * w;
    }
  }
  const dx = px - qx,
    dy = py - qy,
    dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/** Triangle corner coordinates as one Float64Array, nine numbers per triangle. */
export function triangleCoords(mesh: Mesh): Float64Array {
  const { positions: p, indices: ix } = mesh;
  const out = new Float64Array(ix.length * 3);
  for (let i = 0; i < ix.length; i++) {
    const v = ix[i]! * 3;
    out[i * 3] = p[v]!;
    out[i * 3 + 1] = p[v + 1]!;
    out[i * 3 + 2] = p[v + 2]!;
  }
  return out;
}
