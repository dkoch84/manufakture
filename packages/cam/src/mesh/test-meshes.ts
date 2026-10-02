// Test meshes for the 3D operations (T5.5a): a block with its top edges and top corners rounded,
// built as triangles with every vertex on the analytic surface, and that surface's height.

import type { Mesh } from '../types';

export interface FilletedBlock {
  /** XY outline of the block, machine mm. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Bottom and top Z. */
  readonly bottom: number;
  readonly top: number;
  /** Radius of the rounded top edges (and, in plan, of the corners). */
  readonly radius: number;
  /** Facets per quarter turn, around the corners and over the fillet. */
  readonly segments: number;
}

/**
 * The block as a closed triangle mesh, counter-clockwise seen from outside: a flat top, a
 * quarter-round fillet along every top edge meeting in quarter spheres at the corners, vertical
 * walls with rounded vertical corners, and a flat bottom. Every vertex lies on the analytic
 * surface (`filletedBlockTop`), so the facets lie at or below it (by at most the sagitta,
 * `radius * (1 - cos(pi / (4 * segments)))`).
 */
export function filletedBlock(b: FilletedBlock): Mesh {
  const { x0, y0, x1, y1, bottom, top, radius: rho, segments: n } = b;
  const z0 = top - rho;
  // The outline's ring: per corner, n + 1 directions from the inner rectangle's corner.
  const corners: [number, number, number][] = [
    [x1 - rho, y0 + rho, -Math.PI / 2],
    [x1 - rho, y1 - rho, 0],
    [x0 + rho, y1 - rho, Math.PI / 2],
    [x0 + rho, y0 + rho, Math.PI],
  ];
  const ring: { bx: number; by: number; nx: number; ny: number }[] = [];
  for (const [bx, by, a0] of corners) {
    for (let k = 0; k <= n; k++) {
      const a = a0 + (k * Math.PI) / 2 / n;
      ring.push({ bx, by, nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  const L = ring.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const vertex = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const tri = (a: number, b2: number, c: number): void => {
    const ax = pos[a * 3]!;
    const ay = pos[a * 3 + 1]!;
    const az = pos[a * 3 + 2]!;
    const ux = pos[b2 * 3]! - ax;
    const uy = pos[b2 * 3 + 1]! - ay;
    const uz = pos[b2 * 3 + 2]! - az;
    const vx = pos[c * 3]! - ax;
    const vy = pos[c * 3 + 1]! - ay;
    const vz = pos[c * 3 + 2]! - az;
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area > 1e-12) idx.push(a, b2, c);
  };
  // Fillet rings j = 0 (the wall's top, horizontal normal) to n (the flat top's edge).
  const rings: number[][] = [];
  for (let j = 0; j <= n; j++) {
    const t = (j * Math.PI) / 2 / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    rings.push(ring.map((q) => vertex(q.bx + rho * c * q.nx, q.by + rho * c * q.ny, z0 + rho * s)));
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < L; i++) {
      const i2 = (i + 1) % L;
      tri(rings[j]![i]!, rings[j]![i2]!, rings[j + 1]![i2]!);
      tri(rings[j]![i]!, rings[j + 1]![i2]!, rings[j + 1]![i]!);
    }
  }
  // The flat top: the inner rectangle.
  const t0 = vertex(x0 + rho, y0 + rho, top);
  const t1 = vertex(x1 - rho, y0 + rho, top);
  const t2 = vertex(x1 - rho, y1 - rho, top);
  const t3 = vertex(x0 + rho, y1 - rho, top);
  tri(t0, t1, t2);
  tri(t0, t2, t3);
  // Walls and bottom.
  const low = ring.map((q) => vertex(q.bx + rho * q.nx, q.by + rho * q.ny, bottom));
  for (let i = 0; i < L; i++) {
    const i2 = (i + 1) % L;
    tri(low[i]!, low[i2]!, rings[0]![i2]!);
    tri(low[i]!, rings[0]![i2]!, rings[0]![i]!);
  }
  const centre = vertex((x0 + x1) / 2, (y0 + y1) / 2, bottom);
  for (let i = 0; i < L; i++) tri(centre, low[(i + 1) % L]!, low[i]!);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** The block's top surface height at (x, y), or -Infinity outside its outline. */
export function filletedBlockTop(b: FilletedBlock, x: number, y: number): number {
  const d = distToInner(b, x, y);
  if (d > b.radius) return -Infinity;
  return b.top - b.radius + Math.sqrt(b.radius * b.radius - d * d);
}

/** Distance in XY from (x, y) to the block's inner rectangle (the flat top). */
export function distToInner(b: FilletedBlock, x: number, y: number): number {
  const dx = Math.max(b.x0 + b.radius - x, 0, x - (b.x1 - b.radius));
  const dy = Math.max(b.y0 + b.radius - y, 0, y - (b.y1 - b.radius));
  return Math.hypot(dx, dy);
}

/** The highest point of the block's surface within `reach` of (x, y) in XY, or -Infinity. */
export function filletedBlockMaxWithin(
  b: FilletedBlock,
  x: number,
  y: number,
  reach: number,
): number {
  const d = Math.max(0, distToInner(b, x, y) - reach);
  if (d > b.radius) return -Infinity;
  return b.top - b.radius + Math.sqrt(b.radius * b.radius - d * d);
}
