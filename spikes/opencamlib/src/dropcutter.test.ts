// The TypeScript drop-cutter against closed-form answers, and against a brute-force bound on
// random meshes that shares no code with it.

import { describe, expect, it } from 'vitest';
import { DropCutter, type Cutter } from './dropcutter.ts';
import type { Mesh } from './geometry.ts';

const mesh = (name: string, tris: number[][]): Mesh => ({
  name,
  positions: Float32Array.from(tris.flat()),
  indices: Uint32Array.from(tris.flatMap((_, i) => [i * 3, i * 3 + 1, i * 3 + 2])),
});

/** A horizontal square [0, 10]^2 at height h. */
const square = (h: number) =>
  mesh('square', [
    [0, 0, h, 10, 0, h, 10, 10, h],
    [0, 0, h, 10, 10, h, 0, 10, h],
  ]);

/** A large plane z = m x over [-50, 50]^2. */
const slope = (m: number) =>
  mesh('slope', [
    [-50, -50, -50 * m, 50, -50, 50 * m, 50, 50, 50 * m],
    [-50, -50, -50 * m, 50, 50, 50 * m, -50, 50, -50 * m],
  ]);

const flat: Cutter = { kind: 'flat', diameter: 6 };
const ball: Cutter = { kind: 'ball', diameter: 6 };
const v90: Cutter = { kind: 'vbit', diameter: 6, angle: 90 };
const v60: Cutter = { kind: 'vbit', diameter: 6, angle: 60 };
const R = 3;

describe('closed-form cases', () => {
  it('rests every cutter on a horizontal facet', () => {
    for (const c of [flat, ball, v90]) {
      const dc = new DropCutter(square(5), c);
      expect(dc.drop(5, 5, -100)).toBeCloseTo(5, 12);
      expect(dc.drop(20, 5, -100)).toBe(-100);
    }
  });

  it('touches a horizontal edge with the rim, the ball or the cone', () => {
    // Axis 2 mm outside the edge x = 10.
    expect(new DropCutter(square(5), flat).drop(12, 5, -100)).toBeCloseTo(5, 12);
    expect(new DropCutter(square(5), ball).drop(12, 5, -100)).toBeCloseTo(
      5 - (R - Math.sqrt(R * R - 4)),
      12,
    );
    expect(new DropCutter(square(5), v90).drop(12, 5, -100)).toBeCloseTo(3, 12);
    // A corner: 2 mm out in x and y, so sqrt(8) from the axis.
    expect(new DropCutter(square(5), v90).drop(12, 12, -100)).toBeCloseTo(5 - Math.sqrt(8), 12);
  });

  it('rides an inclined plane', () => {
    const m = 0.5;
    const L = Math.sqrt(1 + m * m);
    const x = 3,
      y = 1;
    // Ball: centre at distance R from the plane.
    expect(new DropCutter(slope(m), ball).drop(x, y, -100)).toBeCloseTo(m * x + R * L - R, 10);
    // Flat: the rim on the uphill side.
    expect(new DropCutter(slope(m), flat).drop(x, y, -100)).toBeCloseTo(m * (x + R), 10);
    // A 60 degree V-bit's side rises at 60 degrees, steeper than this slope: the tip touches.
    expect(new DropCutter(slope(m), v60).drop(x, y, -100)).toBeCloseTo(m * x, 10);
    // A 90 degree V-bit on a 60 degree slope: the rim touches.
    const steep = Math.tan(Math.PI / 3);
    expect(new DropCutter(slope(steep), v90).drop(x, y, -100)).toBeCloseTo(
      steep * (x + R) - R,
      5, // the plane's corners are float32
    );
  });

  it('drops onto a ridge edge and a spike vertex', () => {
    // A 45 degree roof with its ridge along Y at x = 0, z = 10.
    const roof = mesh('roof', [
      [-20, -20, -10, 0, -20, 10, 0, 20, 10],
      [-20, -20, -10, 0, 20, 10, -20, 20, -10],
      [0, -20, 10, 20, -20, -10, 20, 20, -10],
      [0, -20, 10, 20, 20, -10, 0, 20, 10],
    ]);
    // Ball 1 mm off the ridge: the facet contact would need 3 sin 45 = 2.12 mm, so the edge wins.
    expect(new DropCutter(roof, ball).drop(1, 0, -100)).toBeCloseTo(
      10 - (R - Math.sqrt(R * R - 1)),
      10,
    );
    // A spike: a narrow pyramid with its apex at (0, 0, 10).
    const spike = mesh('spike', [
      [-0.1, -0.1, 0, 0.1, -0.1, 0, 0, 0, 10],
      [0.1, -0.1, 0, 0.1, 0.1, 0, 0, 0, 10],
      [0.1, 0.1, 0, -0.1, 0.1, 0, 0, 0, 10],
      [-0.1, 0.1, 0, -0.1, -0.1, 0, 0, 0, 10],
    ]);
    expect(new DropCutter(spike, ball).drop(1.5, 0, -100)).toBeCloseTo(
      10 - (R - Math.sqrt(R * R - 2.25)),
      10,
    );
    expect(new DropCutter(spike, v90).drop(1.5, 0, -100)).toBeCloseTo(8.5, 10);
  });

  it('rejects bad cutters', () => {
    expect(() => new DropCutter(square(0), { kind: 'flat', diameter: 0 })).toThrow(RangeError);
    expect(() => new DropCutter(square(0), { kind: 'vbit', diameter: 6, angle: 180 })).toThrow(
      RangeError,
    );
  });
});

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A lower bound by brute force: sample each triangle densely and drop the cutter on every sample
 * as if it were a vertex. Converges to the true answer from below as the sampling gets finer.
 */
function sampledDrop(m: Mesh, c: Cutter, x: number, y: number, n: number): number {
  const r = c.diameter / 2;
  const f = (d: number) =>
    c.kind === 'flat'
      ? 0
      : c.kind === 'ball'
        ? r - Math.sqrt(r * r - d * d)
        : d / Math.tan(((c.angle / 2) * Math.PI) / 180);
  let best = -Infinity;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]! * 3,
      b = m.indices[t + 1]! * 3,
      cc = m.indices[t + 2]! * 3;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n,
          v = j / n,
          w = 1 - u - v;
        const px = w * p[a]! + u * p[b]! + v * p[cc]!;
        const py = w * p[a + 1]! + u * p[b + 1]! + v * p[cc + 1]!;
        const pz = w * p[a + 2]! + u * p[b + 2]! + v * p[cc + 2]!;
        const d = Math.hypot(px - x, py - y);
        if (d <= r) best = Math.max(best, pz - f(d));
      }
    }
  }
  return best;
}

describe('random meshes against a brute-force bound', () => {
  for (const cutter of [flat, ball, v90, v60]) {
    it(`${cutter.kind}${cutter.kind === 'vbit' ? ` ${cutter.angle}` : ''}`, () => {
      const rand = rng(7 + cutter.diameter + (cutter.kind === 'vbit' ? cutter.angle : 0));
      const tris: number[][] = [];
      for (let i = 0; i < 40; i++) {
        const cx = rand() * 20,
          cy = rand() * 20,
          cz = rand() * 10;
        const tri: number[] = [];
        for (let k = 0; k < 3; k++)
          tri.push(cx + (rand() - 0.5) * 8, cy + (rand() - 0.5) * 8, cz + (rand() - 0.5) * 8);
        tris.push(tri);
      }
      const m = mesh('random', tris);
      const dc = new DropCutter(m, cutter, { cellSize: 1.7 });
      let worstBelow = 0;
      let worstAbove = 0;
      for (let k = 0; k < 60; k++) {
        const x = rand() * 20,
          y = rand() * 20;
        const exact = dc.drop(x, y, -1000);
        const bound = sampledDrop(m, cutter, x, y, 240);
        if (bound === -Infinity) {
          expect(exact).toBe(-1000);
          continue;
        }
        // Never below the brute-force bound (a gouge), and only above it by sampling error.
        worstBelow = Math.max(worstBelow, bound - exact);
        worstAbove = Math.max(worstAbove, exact - bound);
      }
      expect(worstBelow).toBeLessThan(1e-9);
      // Sampling error of the bound (measured at 240 steps: flat 0.023, ball 6e-5, V 0.008 and
      // 0.011 mm). The flat's rim and the cone's edge contacts fall between samples on steep
      // random triangles, so they converge slowest.
      expect(worstAbove).toBeLessThan(cutter.kind === 'ball' ? 1e-3 : 0.04);
    });
  }
});

describe('grid index', () => {
  it('gives the same answers at any cell size', () => {
    const rand = rng(11);
    const tris: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const cx = rand() * 50,
        cy = rand() * 50;
      tris.push([cx, cy, rand() * 5, cx + rand() * 3, cy, rand() * 5, cx, cy + rand() * 3, rand()]);
    }
    const m = mesh('grid', tris);
    const xy = Float64Array.from({ length: 400 }, () => rand() * 50);
    const a = new DropCutter(m, ball, { cellSize: 0.3 }).dropPoints(xy, -10);
    const b = new DropCutter(m, ball, { cellSize: 1000 }).dropPoints(xy, -10);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
