// The drop-cutter against closed-form answers, and against a brute-force bound on random meshes
// that shares no code with it (ported from the T5.0b spike, with bull and flat-tipped V cutters).

import { describe, expect, it } from 'vitest';
import type { Mesh } from '../types';
import { seededRandom } from '../test-helpers';
import { DropCutter, cutterForTool, meshBounds, type CutterShape } from './dropcutter';

const mesh = (tris: number[][]): Mesh => ({
  positions: Float32Array.from(tris.flat()),
  indices: Uint32Array.from(tris.flatMap((_, i) => [i * 3, i * 3 + 1, i * 3 + 2])),
});

/** A horizontal square [0, 10]^2 at height h. */
const square = (h: number): Mesh =>
  mesh([
    [0, 0, h, 10, 0, h, 10, 10, h],
    [0, 0, h, 10, 10, h, 0, 10, h],
  ]);

/** A large plane z = m x over [-50, 50]^2. */
const slope = (m: number): Mesh =>
  mesh([
    [-50, -50, -50 * m, 50, -50, 50 * m, 50, 50, 50 * m],
    [-50, -50, -50 * m, 50, 50, 50 * m, -50, 50, -50 * m],
  ]);

const deg = (d: number): number => (d * Math.PI) / 180;
const R = 3;
const flat: CutterShape = { kind: 'flat', radius: R };
const ball: CutterShape = { kind: 'ball', radius: R };
const bull: CutterShape = { kind: 'bull', radius: R, corner: 1 };
const v90: CutterShape = { kind: 'vbit', radius: R, halfAngle: deg(45), tipRadius: 0 };
const v60: CutterShape = { kind: 'vbit', radius: R, halfAngle: deg(30), tipRadius: 0 };
const v90tip: CutterShape = { kind: 'vbit', radius: R, halfAngle: deg(45), tipRadius: 0.5 };

/** The profile f(r), written out again here so the brute force shares nothing with the cutter. */
function profile(c: CutterShape, r: number): number {
  switch (c.kind) {
    case 'flat':
      return 0;
    case 'ball':
      return c.radius - Math.sqrt(Math.max(0, c.radius ** 2 - r * r));
    case 'bull': {
      const u = r - (c.radius - c.corner);
      return u <= 0 ? 0 : c.corner - Math.sqrt(Math.max(0, c.corner ** 2 - u * u));
    }
    case 'vbit':
      return Math.max(0, r - c.tipRadius) / Math.tan(c.halfAngle);
  }
}

describe('closed-form cases', () => {
  it('rests every cutter on a horizontal facet', () => {
    for (const c of [flat, ball, bull, v90, v90tip]) {
      const dc = new DropCutter(square(5), c);
      expect(dc.drop(5, 5, -100)).toBeCloseTo(5, 12);
      expect(dc.drop(20, 5, -100)).toBe(-100);
    }
  });

  it('touches a horizontal edge with the rim, the ball, the torus or the cone', () => {
    // Axis 2 mm outside the edge x = 10.
    expect(new DropCutter(square(5), flat).drop(12, 5, -100)).toBeCloseTo(5, 12);
    expect(new DropCutter(square(5), ball).drop(12, 5, -100)).toBeCloseTo(
      5 - (R - Math.sqrt(R * R - 4)),
      12,
    );
    // Bull, corner 1: the torus starts at r = 2, so at 2 mm the flat bottom just reaches.
    expect(new DropCutter(square(5), bull).drop(12, 5, -100)).toBeCloseTo(5, 10);
    // 2.5 mm out: 0.5 mm into the corner, which rises 1 - sqrt(1 - 0.25).
    expect(new DropCutter(square(5), bull).drop(12.5, 5, -100)).toBeCloseTo(
      5 - (1 - Math.sqrt(0.75)),
      10,
    );
    expect(new DropCutter(square(5), v90).drop(12, 5, -100)).toBeCloseTo(3, 12);
    // The flat tip of radius 0.5: the cone starts there.
    expect(new DropCutter(square(5), v90tip).drop(12, 5, -100)).toBeCloseTo(3.5, 10);
    // A corner: 2 mm out in x and y, so sqrt(8) from the axis.
    expect(new DropCutter(square(5), v90).drop(12, 12, -100)).toBeCloseTo(5 - Math.sqrt(8), 12);
  });

  it('rides an inclined plane', () => {
    const m = 0.5;
    const L = Math.sqrt(1 + m * m);
    const x = 3;
    const y = 1;
    // Ball: centre at distance R from the plane.
    expect(new DropCutter(slope(m), ball).drop(x, y, -100)).toBeCloseTo(m * x + R * L - R, 10);
    // Flat: the rim on the uphill side.
    expect(new DropCutter(slope(m), flat).drop(x, y, -100)).toBeCloseTo(m * (x + R), 10);
    // Bull: the tube circle's uphill point (2 mm out), then a ball of 1 mm on the plane.
    expect(new DropCutter(slope(m), bull).drop(x, y, -100)).toBeCloseTo(m * (x + 2) + L - 1, 10);
    // A 60 degree V-bit's side rises at 60 degrees, steeper than this slope: the tip touches.
    expect(new DropCutter(slope(m), v60).drop(x, y, -100)).toBeCloseTo(m * x, 10);
    // With a flat tip, the tip's uphill rim.
    expect(new DropCutter(slope(m), v90tip).drop(x, y, -100)).toBeCloseTo(m * (x + 0.5), 10);
    // A 90 degree V-bit on a 60 degree slope: the rim touches.
    const steep = Math.tan(Math.PI / 3);
    expect(new DropCutter(slope(steep), v90).drop(x, y, -100)).toBeCloseTo(
      steep * (x + R) - R,
      5, // the plane's corners are float32
    );
    expect(new DropCutter(slope(steep), v90tip).drop(x, y, -100)).toBeCloseTo(
      steep * (x + R) - (R - 0.5),
      5,
    );
  });

  it('drops onto a ridge edge and a spike vertex', () => {
    // A 45 degree roof with its ridge along Y at x = 0, z = 10.
    const roof = mesh([
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
    // Bull 2.5 mm off the ridge: 0.5 mm into its corner.
    expect(new DropCutter(roof, bull).drop(2.5, 0, -100)).toBeCloseTo(
      10 - (1 - Math.sqrt(0.75)),
      10,
    );
    // A spike: a narrow pyramid with its apex at (0, 0, 10).
    const spike = mesh([
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
    expect(new DropCutter(spike, v90tip).drop(1.5, 0, -100)).toBeCloseTo(9, 10);
  });

  it('a bull with its corner equal to its radius is a ball', () => {
    const asBall = new DropCutter(slope(0.7), { kind: 'bull', radius: R, corner: R });
    const real = new DropCutter(slope(0.7), ball);
    for (const [x, y] of [
      [0, 0],
      [3.3, -1],
      [-7, 2],
    ] as const) {
      expect(asBall.drop(x, y, -100)).toBeCloseTo(real.drop(x, y, -100), 12);
    }
  });

  it('rejects bad cutters', () => {
    expect(() => new DropCutter(square(0), { kind: 'flat', radius: 0 })).toThrow(RangeError);
    expect(
      () =>
        new DropCutter(square(0), { kind: 'vbit', radius: 3, halfAngle: deg(90), tipRadius: 0 }),
    ).toThrow(RangeError);
    expect(() => new DropCutter(square(0), { kind: 'bull', radius: 3, corner: 4 })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new DropCutter(square(0), { kind: 'vbit', radius: 3, halfAngle: deg(30), tipRadius: 3 }),
    ).toThrow(RangeError);
  });
});

/**
 * A lower bound by brute force: sample each triangle densely and drop the cutter on every sample
 * as if it were a vertex. Converges to the true answer from below as the sampling gets finer.
 */
function sampledDrop(m: Mesh, c: CutterShape, x: number, y: number, n: number): number {
  const r = c.radius;
  let best = -Infinity;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]! * 3;
    const b = m.indices[t + 1]! * 3;
    const cc = m.indices[t + 2]! * 3;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const v = j / n;
        const w = 1 - u - v;
        const px = w * p[a]! + u * p[b]! + v * p[cc]!;
        const py = w * p[a + 1]! + u * p[b + 1]! + v * p[cc + 1]!;
        const pz = w * p[a + 2]! + u * p[b + 2]! + v * p[cc + 2]!;
        const d = Math.hypot(px - x, py - y);
        if (d <= r) best = Math.max(best, pz - profile(c, d));
      }
    }
  }
  return best;
}

describe('random meshes against a brute-force bound', () => {
  const cases: [string, CutterShape, number][] = [
    ['flat', flat, 0.04],
    ['ball', ball, 1e-3],
    ['bull', bull, 0.04],
    ['V 90', v90, 0.04],
    ['V 60', v60, 0.04],
    ['V 90 with a tip', v90tip, 0.04],
  ];
  for (const [name, cutter, above] of cases) {
    it(name, () => {
      const rand = seededRandom(7 + name.length);
      const tris: number[][] = [];
      for (let i = 0; i < 40; i++) {
        const cx = rand() * 20;
        const cy = rand() * 20;
        const cz = rand() * 10;
        const tri: number[] = [];
        for (let k = 0; k < 3; k++)
          tri.push(cx + (rand() - 0.5) * 8, cy + (rand() - 0.5) * 8, cz + (rand() - 0.5) * 8);
        tris.push(tri);
      }
      const m = mesh(tris);
      const dc = new DropCutter(m, cutter, { cellSize: 1.7 });
      let worstBelow = 0;
      let worstAbove = 0;
      for (let k = 0; k < 60; k++) {
        const x = rand() * 20;
        const y = rand() * 20;
        const exact = dc.drop(x, y, -1000);
        const bound = sampledDrop(m, cutter, x, y, 240);
        if (bound === -Infinity) {
          expect(exact).toBe(-1000);
          continue;
        }
        // Never below the brute-force bound (a gouge), and above it only by sampling error.
        worstBelow = Math.max(worstBelow, bound - exact);
        worstAbove = Math.max(worstAbove, exact - bound);
      }
      expect(worstBelow).toBeLessThan(1e-9);
      // The sampling error of the bound at 240 steps (the spike measured flat 0.023, ball 6e-5,
      // V 0.008 and 0.011 mm): rim and cone-edge contacts fall between samples on steep triangles.
      expect(worstAbove).toBeLessThan(above);
    });
  }
});

describe('grid index', () => {
  it('gives the same answers at any cell size, for every cutter', () => {
    const rand = seededRandom(11);
    const tris: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const cx = rand() * 50;
      const cy = rand() * 50;
      tris.push([cx, cy, rand() * 5, cx + rand() * 3, cy, rand() * 5, cx, cy + rand() * 3, rand()]);
    }
    const m = mesh(tris);
    const xy = Float64Array.from({ length: 400 }, () => rand() * 50);
    for (const c of [flat, ball, bull, v90, v90tip]) {
      const a = new DropCutter(m, c, { cellSize: 0.3 }).dropPoints(xy, -10);
      const b = new DropCutter(m, c, { cellSize: 1000 }).dropPoints(xy, -10);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it('handles an empty mesh', () => {
    const dc = new DropCutter({ positions: new Float32Array(), indices: new Uint32Array() }, ball);
    expect(dc.drop(1, 2, -5)).toBe(-5);
    expect(meshBounds({ positions: new Float32Array(), indices: new Uint32Array() })).toBe(
      undefined,
    );
  });
});

describe('cutterForTool', () => {
  const base = { diameter: 6 };
  it('maps each tool kind, and grows it by the stock to leave', () => {
    expect(cutterForTool({ ...base, kind: 'flat' })).toEqual({
      ok: true,
      value: { kind: 'flat', radius: 3 },
    });
    expect(cutterForTool({ ...base, kind: 'flat' }, 0.5)).toEqual({
      ok: true,
      value: { kind: 'bull', radius: 3.5, corner: 0.5 },
    });
    expect(cutterForTool({ ...base, kind: 'ball' }, 0.5)).toEqual({
      ok: true,
      value: { kind: 'ball', radius: 3.5 },
    });
    expect(cutterForTool({ ...base, kind: 'bull', cornerRadius: 1 }, 0.25)).toEqual({
      ok: true,
      value: { kind: 'bull', radius: 3.25, corner: 1.25 },
    });
    expect(cutterForTool({ ...base, kind: 'bull', cornerRadius: 0 })).toEqual({
      ok: true,
      value: { kind: 'flat', radius: 3 },
    });
    const v = cutterForTool({ ...base, kind: 'vbit', angle: deg(60), tipDiameter: 0.2 });
    expect(v.ok && v.value).toEqual({
      kind: 'vbit',
      radius: 3,
      halfAngle: deg(30),
      tipRadius: 0.1,
    });
  });

  it('a grown cutter keeps the real tool the stock to leave away', () => {
    // Ball on an inclined plane: the grown ball's centre is R + a from the plane.
    const m = 0.5;
    const a = 0.4;
    const grown = cutterForTool({ ...base, kind: 'ball' }, a);
    if (!grown.ok) throw new Error(grown.error.message);
    const tip = new DropCutter(slope(m), grown.value).drop(1, 1, -100) + a;
    const centre = tip + R;
    // Distance from the centre to the plane z = m x.
    expect((centre - m * 1) / Math.sqrt(1 + m * m)).toBeCloseTo(R + a, 9);
  });

  it('refuses what it cannot drop', () => {
    expect(cutterForTool({ ...base, kind: 'drill', angle: deg(118) }).ok).toBe(false);
    expect(cutterForTool({ ...base, kind: 'engraver' }).ok).toBe(false);
    expect(cutterForTool({ ...base, kind: 'vbit', angle: deg(60) }, 0.1).ok).toBe(false);
    expect(cutterForTool({ ...base, kind: 'vbit' }).ok).toBe(false);
    expect(cutterForTool({ ...base, kind: 'bull' }).ok).toBe(false);
    expect(cutterForTool({ diameter: 0, kind: 'flat' }).ok).toBe(false);
    expect(cutterForTool({ ...base, kind: 'flat' }, -1).ok).toBe(false);
  });
});
