// The 3D surfacing operation (T5.5a) on a filleted block: the finish never goes below the mesh
// (a ball's centre never nearer the mesh than its radius, point by point along every move), its
// scallops match the stepover, z-level roughing leaves the stock to leave and no more than a
// little extra, rapids never run into material, and memory stays flat over repeated runs.

import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isFeedMove, isMove, type IrEntry, type Toolpath } from '../ir';
import { DropCutter } from '../mesh/dropcutter';
import {
  distToInner,
  filletedBlock,
  filletedBlockMaxWithin,
  type FilletedBlock,
} from '../mesh/test-meshes';
import { rect } from '../offset/test-shapes';
import { movesWithStarts, rapidCollisions, sampleMove } from '../test-helpers';
import type { Mesh, Setup, Tool, Vec3 } from '../types';
import { validateToolpath } from '../validate';
import { registerBuiltinOperations } from '../worker/builtin';
import { CamCancelled, OperationRegistry, type OperationContext } from '../worker/registry';
import {
  SURFACE3D_SAFE_ABOVE,
  generateSurface3d,
  scallopHeight,
  type Surface3dOperation,
} from './surface3d';

export const BLOCK: FilletedBlock = {
  x0: 5,
  y0: 5,
  x1: 65,
  y1: 45,
  bottom: -20,
  top: -2,
  radius: 8,
  segments: 32,
};
const MESH = filletedBlock(BLOCK);
/** The facets' largest distance below the analytic surface. */
const SAGITTA = BLOCK.radius * (1 - Math.cos(Math.PI / (4 * BLOCK.segments)));

const ball6: Tool = {
  id: 'tool#2',
  name: '6 mm ball',
  kind: 'ball',
  number: 2,
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const flat6: Tool = { ...ball6, id: 'tool#1', name: '6 mm flat', kind: 'flat', number: 1 };
const feeds = { spindle: 18000, cut: 1500, plunge: 400 };

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [0, 0, -20], max: [70, 50, 0] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};
const context: OperationContext = {
  generation: 1,
  cancelled: false,
  setup,
  checkpoint: () => Promise.resolve(),
};
const STOCK_TOP = 0;

export const finishOp = (over: Partial<Surface3dOperation> = {}): Surface3dOperation => ({
  kind: 'surface3d',
  id: 'surface3d#1',
  name: 'Finish',
  tool: ball6,
  feeds,
  mesh: MESH,
  stepover: 1,
  angle: 0,
  allowance: 0,
  ...over,
});

export const roughOp = (over: Partial<Surface3dOperation> = {}): Surface3dOperation => ({
  kind: 'surface3d',
  id: 'surface3d#2',
  name: 'Rough',
  tool: flat6,
  feeds,
  mesh: MESH,
  stepover: 2.4,
  angle: 0,
  allowance: 0.5,
  strategy: 'zlevel',
  stepdown: 3,
  ...over,
});

/** The IR validator's issues, bar what linking adds (the tool change and the spindle). */
const irIssues = (tp: Toolpath) =>
  validateToolpath(tp).filter((i) => i.code !== 'no-tool' && i.code !== 'spindle-off');

async function generate(op: Surface3dOperation, ctx = context): Promise<Toolpath> {
  const r = await generateSurface3d(op, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.toolpath;
}

// ---------------------------------------------------------------------------------------------
// Exact distance from a point to the mesh (Ericson, "Real-Time Collision Detection", 5.1.5),
// with a bucket grid over the triangles so a check touches only the triangles nearby.

function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const along = (o: Vec3, d: Vec3, t: number): Vec3 => [
    o[0] + d[0] * t,
    o[1] + d[1] * t,
    o[2] + d[2] * t,
  ];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

class MeshDistance {
  private readonly buckets = new Map<number, number[]>();
  constructor(
    private readonly mesh: Mesh,
    private readonly cell = 2,
  ) {
    const { positions: p, indices: ix } = mesh;
    for (let t = 0; t < ix.length / 3; t++) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = ix[t * 3 + k]! * 3;
        x0 = Math.min(x0, p[v]!);
        x1 = Math.max(x1, p[v]!);
        y0 = Math.min(y0, p[v + 1]!);
        y1 = Math.max(y1, p[v + 1]!);
      }
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
        for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
          const key = i * 100003 + j;
          const list = this.buckets.get(key) ?? [];
          list.push(t);
          this.buckets.set(key, list);
        }
      }
    }
  }

  /** Distance from `q` to the nearest triangle within `reach` in XY; Infinity if none. */
  distance(q: Vec3, reach: number): number {
    const { positions: p, indices: ix } = this.mesh;
    const seen = new Set<number>();
    let best = Infinity;
    for (
      let i = Math.floor((q[0] - reach) / this.cell);
      i <= Math.floor((q[0] + reach) / this.cell);
      i++
    ) {
      for (
        let j = Math.floor((q[1] - reach) / this.cell);
        j <= Math.floor((q[1] + reach) / this.cell);
        j++
      ) {
        for (const t of this.buckets.get(i * 100003 + j) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          const v = (k: number): Vec3 => {
            const o = ix[t * 3 + k]! * 3;
            return [p[o]!, p[o + 1]!, p[o + 2]!];
          };
          const c = closestOnTriangle(q, v(0), v(1), v(2));
          best = Math.min(best, Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]));
        }
      }
    }
    return best;
  }
}

/** Every point along the feed moves, about `step` mm apart. */
function feedSamples(tp: Toolpath, step: number, onlyCuts = false): Vec3[] {
  const out: Vec3[] = [];
  for (const { from, move } of movesWithStarts(tp)) {
    if (move.kind === 'rapid' || (onlyCuts && move.feedClass !== 'cut')) continue;
    out.push(...sampleMove(from, move, step));
  }
  return out;
}

/** Rapids: straight up, or with both ends at least `above` (sideways and down above the stock). */
function unsafeRapids(tp: Toolpath, above: number): number {
  let bad = 0;
  for (const { from, move } of movesWithStarts(tp)) {
    if (move.kind !== 'rapid') continue;
    const up =
      Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) < 1e-9 && move.to[2] >= from[2];
    if (!up && (from[2] < above - 1e-9 || move.to[2] < above - 1e-9)) bad++;
  }
  return bad;
}

describe('parallel finishing', () => {
  it('never puts the ball below the mesh, and keeps it on the surface', async () => {
    const tol = 0.01;
    const tp = await generate(finishOp({ tolerance: tol }));
    expect(irIssues(tp)).toEqual([]);
    const md = new MeshDistance(MESH);
    const R = 3;
    let closest = Infinity;
    let farthest = 0;
    const samples = feedSamples(tp, 0.1);
    expect(samples.length).toBeGreaterThan(20000);
    for (const p of samples)
      closest = Math.min(closest, md.distance([p[0], p[1], p[2] + R], R + 0.5));
    // Cutting (not the plunges down from above the stock), the ball rests on the mesh, or on the
    // floor: within the tolerance of touching.
    for (const p of feedSamples(tp, 0.1, true)) {
      const d = md.distance([p[0], p[1], p[2] + R], R + 0.5);
      if (p[2] > BLOCK.bottom + 1e-6) farthest = Math.max(farthest, d - R);
    }
    // No gouge beyond the tolerance.
    expect(closest).toBeGreaterThanOrEqual(R - tol);
    expect(farthest).toBeLessThanOrEqual(tol);
  });

  it('leaves the stock to leave, with a ball and a flat end mill', async () => {
    const md = new MeshDistance(MESH);
    const a = 0.4;
    const tol = 0.01;
    const ball = await generate(finishOp({ allowance: a, stepover: 2, tolerance: tol }));
    let closest = Infinity;
    for (const p of feedSamples(ball, 0.2)) {
      closest = Math.min(closest, md.distance([p[0], p[1], p[2] + 3], 4));
    }
    expect(closest).toBeGreaterThanOrEqual(3 + a - tol);
    expect(closest).toBeLessThanOrEqual(3 + a + tol);
    // A flat end mill: its bottom stays at least the allowance above the mesh under it, and its
    // tip is never below the analytic surface's highest point within its radius by more.
    const flat = await generate(
      finishOp({ tool: flat6, allowance: a, stepover: 2, tolerance: tol }),
    );
    let worst = Infinity;
    for (const p of feedSamples(flat, 0.2)) {
      const high = filletedBlockMaxWithin(BLOCK, p[0], p[1], 3);
      if (high > -Infinity) worst = Math.min(worst, p[2] - high);
    }
    expect(worst).toBeGreaterThanOrEqual(a - tol - SAGITTA);
  });

  it('leaves scallops that match the stepover on the flat top', async () => {
    for (const stepover of [1, 2]) {
      const tp = await generate(finishOp({ stepover }));
      const pts = feedSamples(tp, 0.05);
      // The lines' spacing as the raster laid them out (at most the stepover).
      const ys = [
        ...new Set(pts.filter((p) => p[0] > 30 && p[0] < 31).map((p) => +p[1].toFixed(6))),
      ].sort((u, v) => u - v);
      const spacing = (ys[ys.length - 1]! - ys[0]!) / (ys.length - 1);
      expect(spacing).toBeLessThanOrEqual(stepover);
      const R = 3;
      // The material left at points across the flat top: the lowest the ball reached over them.
      let scallop = 0;
      for (let y = 16; y <= 34; y += 0.02) {
        for (const x of [25, 35, 45]) {
          let low = Infinity;
          for (const p of pts) {
            const d = Math.hypot(p[0] - x, p[1] - y);
            if (d <= R) low = Math.min(low, p[2] + R - Math.sqrt(R * R - d * d));
          }
          scallop = Math.max(scallop, low - BLOCK.top);
        }
      }
      const expected = scallopHeight({ kind: 'ball', radius: R }, spacing);
      expect(Math.abs(scallop - expected)).toBeLessThan(0.002);
      expect(expected).toBeCloseTo(R - Math.sqrt(R * R - (spacing / 2) ** 2), 12);
    }
  });

  it('links neighbouring lines along the surface in a zigzag and retracts in a one-way raster', async () => {
    const zig = await generate(finishOp({ stepover: 2 }));
    const one = await generate(finishOp({ stepover: 2, pattern: 'oneway' }));
    const rapids = (tp: Toolpath) => tp.entries.filter((e) => e.kind === 'rapid').length;
    const lines = Math.ceil((BLOCK.y1 - BLOCK.y0) / 2) + 1;
    expect(rapids(zig)).toBeLessThanOrEqual(3);
    expect(rapids(one)).toBeGreaterThanOrEqual(3 * (lines - 1));
    for (const tp of [zig, one]) {
      expect(unsafeRapids(tp, STOCK_TOP + SURFACE3D_SAFE_ABOVE)).toBe(0);
      expect(tp.start[2]).toBe(10);
      const last = tp.entries[tp.entries.length - 1]!;
      expect(isMove(last) && last.to[2]).toBe(10);
      expect(irIssues(tp)).toEqual([]);
    }
  });

  it('runs at an angle, inside a given boundary', async () => {
    const tp = await generate(
      finishOp({ angle: Math.PI / 6, stepover: 1.5, boundary: [rect(15, 10, 40, 30)] }),
    );
    expect(irIssues(tp)).toEqual([]);
    for (const p of feedSamples(tp, 0.5)) {
      expect(p[0]).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(p[0]).toBeLessThanOrEqual(55 + 1e-6);
      expect(p[1]).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(p[1]).toBeLessThanOrEqual(40 + 1e-6);
    }
    expect(unsafeRapids(tp, STOCK_TOP + SURFACE3D_SAFE_ABOVE)).toBe(0);
  });

  it('filters the cutter locations to far fewer moves within the tolerance', async () => {
    const coarse = await generate(finishOp({ stepover: 2, tolerance: 0.05 }));
    const fine = await generate(finishOp({ stepover: 2, tolerance: 0.002 }));
    const feedsOf = (tp: Toolpath) => tp.entries.filter((e: IrEntry) => isFeedMove(e)).length;
    expect(feedsOf(coarse)).toBeLessThan(feedsOf(fine));
    // On the flat top a line is one move: the raster's 60 mm at 0.5 mm sampling is 121 points.
    expect(feedsOf(coarse)).toBeLessThan(21 * 60);
  });

  it('finishes with a bull nose and a V-bit, and agrees with the drop-cutter', async () => {
    const bull: Tool = { ...ball6, kind: 'bull', cornerRadius: 1 };
    const vbit: Tool = { ...ball6, kind: 'vbit', angle: Math.PI / 2, diameter: 12.7 };
    for (const tool of [bull, vbit]) {
      const tp = await generate(finishOp({ tool, stepover: 3, tolerance: 0.005 }));
      expect(irIssues(tp)).toEqual([]);
      const shape =
        tool.kind === 'bull'
          ? ({ kind: 'bull', radius: 3, corner: 1 } as const)
          : ({ kind: 'vbit', radius: 6.35, halfAngle: Math.PI / 4, tipRadius: 0 } as const);
      const dc = new DropCutter(MESH, shape);
      let below = 0;
      for (const p of feedSamples(tp, 0.25))
        below = Math.max(below, dc.drop(p[0], p[1], -20) - p[2]);
      expect(below).toBeLessThanOrEqual(0.005);
    }
  });
});

describe('z-level roughing', () => {
  it('leaves the stock to leave on every side and on top, and not much more', async () => {
    const a = 0.5;
    const r = 3;
    const result = await generateSurface3d(roughOp({ allowance: a }), context);
    if (!result.ok) throw new Error(result.error.message);
    const tp = result.value.toolpath;
    expect(irIssues(tp)).toEqual([]);
    const tol = SAGITTA + 1e-3;
    const pts = feedSamples(tp, 0.25);
    let worst = Infinity;
    for (const p of pts) {
      // Material within the tool's radius plus the allowance stands no higher than a below the tip.
      const high = filletedBlockMaxWithin(BLOCK, p[0], p[1], r + a);
      if (high > -Infinity) worst = Math.min(worst, p[2] - a - high);
    }
    expect(worst).toBeGreaterThanOrEqual(-tol);
    // The flat top is roughed to exactly the allowance above it.
    const overTop = pts.filter(
      (p) => distToInner(BLOCK, p[0], p[1]) === 0 && Math.abs(p[2] - (BLOCK.top + a)) < 1e-9,
    );
    expect(overTop.length).toBeGreaterThan(100);
    // At the floor the tool's edge comes to within the allowance plus the slice's reach of the wall.
    const atFloor = pts.filter((p) => Math.abs(p[2] - BLOCK.bottom) < 1e-9);
    expect(atFloor.length).toBeGreaterThan(100);
    const gap = Math.min(...atFloor.map((p) => distToInner(BLOCK, p[0], p[1]) - BLOCK.radius - r));
    expect(gap).toBeGreaterThanOrEqual(a - tol);
    expect(gap).toBeLessThanOrEqual(a + 1);
    // Levels: every level cut flat, no more than the stepdown below the one above.
    const flatLevels = new Set<number>();
    for (const { from, move } of movesWithStarts(tp)) {
      if (
        move.kind === 'linear' &&
        move.feedClass === 'cut' &&
        Math.abs(move.to[2] - from[2]) < 1e-9
      ) {
        flatLevels.add(+move.to[2].toFixed(9));
      }
    }
    const zs = [...flatLevels].sort((u, v) => v - u);
    expect(zs).toContain(BLOCK.top + a);
    expect(zs[zs.length - 1]).toBe(BLOCK.bottom);
    expect(STOCK_TOP - zs[0]!).toBeLessThanOrEqual(3 + 1e-9);
    for (let i = 1; i < zs.length; i++) expect(zs[i - 1]! - zs[i]!).toBeLessThanOrEqual(3 + 1e-9);
  });

  it('never rapids into material (a heightmap of the stock cut by every feed move)', async () => {
    const tp = await generate(roughOp());
    const withTool: Toolpath = {
      start: tp.start,
      entries: [
        { kind: 'toolChange', tool: flat6.id, name: flat6.name, diameter: flat6.diameter },
        ...tp.entries,
      ],
    };
    expect(rapidCollisions(withTool, setup.stock, { cell: 0.5 })).toEqual([]);
  });

  it('roughs within a given boundary, and warns about a round tool', async () => {
    const r = await generateSurface3d(
      roughOp({ tool: ball6, boundary: [rect(10, 10, 30, 20)] }),
      context,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.warnings?.map((w) => w.code)).toContain('rough-round-tool');
    for (const p of feedSamples(r.value.toolpath, 0.5)) {
      expect(p[0]).toBeGreaterThanOrEqual(10 - 1e-3);
      expect(p[0]).toBeLessThanOrEqual(40 + 1e-3);
    }
  });
});

describe('refusals, warnings, cancelling and registration', () => {
  it('refuses bad input', async () => {
    const bad: Partial<Surface3dOperation>[] = [
      { stepover: 0 },
      { stepover: 7 },
      { allowance: -1 },
      { angle: Number.NaN },
      { tool: { ...ball6, kind: 'drill', angle: 2 } },
      { tool: { ...ball6, kind: 'vbit', angle: Math.PI / 2 }, allowance: 0.2 },
      { mesh: { positions: new Float32Array(), indices: new Uint32Array() } },
      { mesh: { positions: new Float32Array(9), indices: Uint32Array.from([0, 1, 5]) } },
      { floor: 5 },
      { tolerance: 0 },
      { boundary: [] },
      { strategy: 'waterline' as never },
      { pattern: 'spiral' as never },
      { feeds: { spindle: 1, cut: 0, plunge: 1 } },
    ];
    for (const over of bad) {
      const r = await generateSurface3d(finishOp(over), context);
      expect(r.ok, JSON.stringify(Object.keys(over))).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-input');
    }
    const rough = await generateSurface3d(roughOp({ stepdown: -1 }), context);
    expect(rough.ok).toBe(false);
  });

  it('warns when the finish goes deeper than the flutes', async () => {
    const r = await generateSurface3d(
      finishOp({ tool: { ...ball6, fluteLength: 5 }, stepover: 3 }),
      context,
    );
    expect(r.ok && r.value.warnings?.map((w) => w.code)).toEqual(['depth-exceeds-flutes']);
  });

  it('stops at a checkpoint when superseded', async () => {
    let calls = 0;
    const stale: OperationContext = {
      ...context,
      checkpoint: () => {
        calls++;
        return calls > 3 ? Promise.reject(new CamCancelled()) : Promise.resolve();
      },
    };
    await expect(generateSurface3d(finishOp(), stale)).rejects.toBeInstanceOf(CamCancelled);
    calls = 0;
    await expect(generateSurface3d(roughOp(), stale)).rejects.toBeInstanceOf(CamCancelled);
  });

  it('is registered as the surface3d generator', () => {
    const registry = registerBuiltinOperations(new OperationRegistry());
    expect(registry.get('surface3d')).toBe(generateSurface3d);
  });
});

describe('memory', () => {
  it('stays flat over repeated runs', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const op = finishOp({ stepover: 3 });
    const heap: number[] = [];
    for (let k = 0; k < 8; k++) {
      await generate(op);
      gc();
      heap.push(process.memoryUsage().heapUsed);
    }
    // After the first two runs (code and caches warming up), no growth beyond noise.
    const growth = heap[heap.length - 1]! - heap[2]!;
    expect(growth).toBeLessThan(2 * 1024 * 1024);
  });
});
