import { describe, expect, it } from 'vitest';
import type { LinearMove, Move, Toolpath } from '../ir';
import { isMove } from '../ir';
import { flattenSegments } from '../offset/flatten';
import { distToLoops, pointInLoops } from '../offset/geometry';
import { polygon, rect } from '../offset/test-shapes';
import type { Loop2, Setup, Vec2, Vec3 } from '../types';
import { validateToolpath } from '../validate';
import { rapidsIntoStockTop } from '../test-helpers';
import { registerBuiltinOperations } from '../worker/builtin';
import { CamCancelled, OperationRegistry, type OperationContext } from '../worker/registry';
import { FACING_SAFE_ABOVE, facingRaster, generateFacing, type FacingOperation } from './facing';

const tool = {
  id: 'tool#1',
  name: '1/2in surfacing',
  kind: 'flat',
  diameter: 12,
  fluteLength: 10,
  flutes: 2,
} as const;
const R = 6;

const feeds = { spindle: 16000, cut: 2000, plunge: 400 };

const stockLoop = rect(0, 0, 100, 60);

function facing(over: Partial<FacingOperation> = {}): FacingOperation {
  return {
    kind: 'facing',
    id: 'facing#1',
    name: 'Face top',
    tool,
    feeds,
    loops: [stockLoop],
    depth: { top: 0, bottom: -3 },
    stepdown: 1,
    stepover: 0.5,
    angle: 0,
    ...over,
  };
}

const heights = { clearance: 10, retract: 3 };

function context(h = heights, checkpoints = { count: 0 }): OperationContext {
  const setup: Setup = {
    id: 'setup#1',
    name: 'Top',
    stock: { min: [0, 0, -12], max: [100, 60, 0] },
    wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
    frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
    heights: h,
    machine: 'shapeoko-5-pro-4x4',
    post: 'grbl',
    operations: [],
  };
  return {
    generation: 1,
    cancelled: false,
    setup,
    checkpoint: () => {
      checkpoints.count++;
      return Promise.resolve();
    },
  };
}

/** Generates, checks the IR validator (bar what linking adds), and returns the result. */
async function run(op: FacingOperation, ctx = context()) {
  const result = await generateFacing(op, ctx);
  if (!result.ok) throw new Error(result.error.message);
  const issues = validateToolpath(result.value.toolpath).filter(
    (i) => i.code !== 'no-tool' && i.code !== 'spindle-off',
  );
  expect(issues).toEqual([]);
  return result.value;
}

/** Each move with the position it starts from. */
function withStarts(tp: Toolpath): { from: Vec3; move: Move }[] {
  let pos = tp.start;
  const out: { from: Vec3; move: Move }[] = [];
  for (const e of tp.entries) {
    if (!isMove(e)) continue;
    out.push({ from: pos, move: e });
    pos = e.to;
  }
  return out;
}

/** Level feed moves at `z`, as XY segments. */
function cutsAt(tp: Toolpath, z: number): [Vec2, Vec2][] {
  return withStarts(tp)
    .filter(
      ({ from, move }) =>
        move.kind === 'linear' &&
        Math.abs(from[2] - z) < 1e-9 &&
        Math.abs(move.to[2] - z) < 1e-9 &&
        Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9,
    )
    .map(({ from, move }): [Vec2, Vec2] => [
      [from[0], from[1]],
      [move.to[0], move.to[1]],
    ]);
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Raster coverage at depth `z`: every point of the loops' area on a fine grid (edges included)
 * lies within the tool radius of a level cut at `z`. Returns the uncovered points.
 */
function uncovered(
  tp: Toolpath,
  loops: readonly Loop2[],
  z: number,
  step = 0.25,
  radius = R,
): Vec2[] {
  const cuts = cutsAt(tp, z);
  const polys = loops.map((l) => flattenSegments(l.segments, true, 0.01));
  const pts = polys.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const out: Vec2[] = [];
  const nx = Math.ceil((maxX - minX) / step);
  const ny = Math.ceil((maxY - minY) / step);
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const p: Vec2 = [minX + ((maxX - minX) * i) / nx, minY + ((maxY - minY) * j) / ny];
      if (!pointInLoops(p, polys) && distToLoops(p, loops) > 1e-9) continue;
      if (!cuts.some(([a, b]) => distToSegment(p, a, b) <= radius + 1e-6)) out.push(p);
    }
  }
  return out;
}

/** The long raster cuts at `z` (longer than `min` mm), as unit directions. */
function rasterDirections(tp: Toolpath, z: number, min = 20): Vec2[] {
  return cutsAt(tp, z)
    .filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) > min)
    .map(([a, b]) => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    });
}

/** Every rapid that moves in XY happens at `z` or above; every rapid down stops above the floor. */
function checkRapids(tp: Toolpath, retractZ: number): void {
  const moves = withStarts(tp);
  moves.forEach(({ from, move }, i) => {
    if (move.kind !== 'rapid') return;
    if (Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9) {
      expect(from[2]).toBeGreaterThanOrEqual(retractZ - 1e-9);
      expect(move.to[2]).toBeGreaterThanOrEqual(retractZ - 1e-9);
    }
    if (move.to[2] < from[2]) {
      const next = moves.slice(i + 1).find((m) => m.move.kind !== 'rapid');
      // The next feed move plunges a whole stepdown below the floor cut so far.
      expect(next?.move.kind).toBe('linear');
      expect((next!.move as LinearMove).feedClass).toBe('plunge');
      expect(move.to[2]).toBeGreaterThanOrEqual(next!.move.to[2] + FACING_SAFE_ABOVE - 1e-9);
    }
  });
}

describe('generateFacing', () => {
  it('covers the whole stock top at the final depth (zigzag, 0 degrees)', async () => {
    const { toolpath, warnings } = await run(facing());
    expect(warnings).toBeUndefined();
    expect(uncovered(toolpath, [stockLoop], -3)).toEqual([]);
  });

  it('the coverage check finds gaps (self-test: a full-diameter stepover, a smaller tool)', async () => {
    const { toolpath } = await run(facing({ stepover: 1 }));
    expect(uncovered(toolpath, [stockLoop], -3)).toEqual([]);
    expect(uncovered(toolpath, [stockLoop], -3, 0.25, R - 0.5).length).toBeGreaterThan(0);
  });

  it.each([0, 30, 45, 90, 135])(
    'covers the stock top at %d degrees, both patterns',
    async (deg) => {
      for (const pattern of ['zigzag', 'oneway'] as const) {
        const { toolpath } = await run(facing({ angle: (deg * Math.PI) / 180, pattern }));
        expect(uncovered(toolpath, [stockLoop], -3)).toEqual([]);
      }
    },
  );

  it('rasters along the angle', async () => {
    for (const deg of [0, 45]) {
      const a = (deg * Math.PI) / 180;
      const dir: Vec2 = [Math.cos(a), Math.sin(a)];
      const { toolpath } = await run(facing({ angle: a }));
      const dirs = rasterDirections(toolpath, -3);
      expect(dirs.length).toBeGreaterThan(5);
      for (const d of dirs) {
        // Zigzag: along or against the raster direction.
        expect(Math.abs(d[0] * dir[0] + d[1] * dir[1])).toBeCloseTo(1, 9);
      }
      // Both ways in a zigzag.
      expect(dirs.some((d) => d[0] * dir[0] + d[1] * dir[1] > 0)).toBe(true);
      expect(dirs.some((d) => d[0] * dir[0] + d[1] * dir[1] < 0)).toBe(true);
    }
  });

  it('cuts in equal depth passes down to the bottom, one IR pass each', async () => {
    const { toolpath } = await run(facing({ depth: { top: 0, bottom: -2.5 }, stepdown: 1 }));
    const feedZs = new Set(
      toolpath.entries
        .filter((e): e is LinearMove => e.kind === 'linear' && e.feedClass === 'cut')
        .map((e) => Math.round(e.to[2] * 1e6) / 1e6),
    );
    // ceil(2.5 / 1) = 3 levels of 2.5 / 3 mm.
    expect([...feedZs].sort((a, b) => b - a)).toEqual([
      Math.round((-2.5 / 3) * 1e6) / 1e6,
      Math.round((-5 / 3) * 1e6) / 1e6,
      -2.5,
    ]);
    const byPass = new Map<number, Set<number>>();
    for (const e of toolpath.entries) {
      if (e.kind !== 'linear' || e.feedClass !== 'cut') continue;
      const set = byPass.get(e.pass) ?? new Set<number>();
      set.add(Math.round(e.to[2] * 1e6));
      byPass.set(e.pass, set);
    }
    expect([...byPass.keys()]).toEqual([0, 1, 2]);
    for (const zs of byPass.values()) expect(zs.size).toBe(1);
  });

  it('faces in a single pass when the depth is within the stepdown', async () => {
    const { toolpath } = await run(facing({ depth: { top: 0, bottom: -0.5 }, stepdown: 1 }));
    const zs = new Set(
      toolpath.entries.filter((e) => e.kind === 'linear').map((e) => (e as LinearMove).to[2]),
    );
    expect([...zs]).toEqual([-0.5]);
  });

  it('starts and ends at the clearance height and rapids only above the retract height', async () => {
    for (const pattern of ['zigzag', 'oneway'] as const) {
      const { toolpath } = await run(facing({ pattern }));
      expect(toolpath.start[2]).toBe(10);
      const last = toolpath.entries[toolpath.entries.length - 1]!;
      expect(last.kind).toBe('rapid');
      expect((last as Move).to[2]).toBe(10);
      checkRapids(toolpath, 3);
    }
  });

  it('keeps the retract height above the stock top', async () => {
    const op = facing({ depth: { top: 5, bottom: 3 }, pattern: 'oneway' });
    const { toolpath } = await run(op, context({ clearance: 4, retract: 2 }));
    // Retract at least FACING_SAFE_ABOVE over the top; clearance no lower than that.
    checkRapids(toolpath, 5 + FACING_SAFE_ABOVE);
    expect(toolpath.start[2]).toBe(5 + FACING_SAFE_ABOVE);
    expect(uncovered(toolpath, [stockLoop], 3)).toEqual([]);
  });

  it('zigzag steps over at depth and goes straight on down between levels', async () => {
    const { toolpath } = await run(facing());
    const rapids = toolpath.entries.filter((e) => e.kind === 'rapid');
    // Down to the first line before cutting, and up to clearance at the end: nothing between.
    const firstFeed = toolpath.entries.findIndex((e) => e.kind === 'linear');
    expect(toolpath.entries.slice(firstFeed).filter((e) => e.kind === 'rapid')).toHaveLength(1);
    expect(rapids.length).toBeLessThanOrEqual(3);
    // Step-overs are cut moves across the raster, at depth.
    const across = cutsAt(toolpath, -3).filter(([a, b]) => Math.abs(b[0] - a[0]) < 1e-9);
    expect(across.length).toBeGreaterThan(5);
    // Plunges between levels: one per level, each a stepdown deep.
    const plunges = toolpath.entries.filter(
      (e): e is LinearMove => e.kind === 'linear' && e.feedClass === 'plunge',
    );
    expect(plunges.map((p) => p.to[2])).toEqual([-1, -2, -3]);
  });

  it('one-way cuts every line the same way and retracts between lines', async () => {
    const a = Math.PI / 4;
    const { toolpath } = await run(facing({ pattern: 'oneway', angle: a }));
    const dirs = rasterDirections(toolpath, -3, 1);
    expect(dirs.length).toBeGreaterThan(5);
    for (const d of dirs) {
      expect(d[0] * Math.cos(a) + d[1] * Math.sin(a)).toBeCloseTo(1, 9);
    }
    // Every line gets its own plunge, after a retract to the retract height.
    const moves = withStarts(toolpath);
    const plunges = moves.filter(
      ({ move }) => move.kind === 'linear' && move.feedClass === 'plunge',
    );
    const lines = cutsAt(toolpath, -3).length;
    expect(plunges.filter(({ move }) => move.to[2] === -3)).toHaveLength(lines);
    const ups = moves.filter(({ from, move }) => move.kind === 'rapid' && move.to[2] > from[2]);
    expect(ups.every(({ move }) => move.to[2] === 3 || move.to[2] === 10)).toBe(true);
    expect(ups.length).toBeGreaterThanOrEqual(3 * lines - 1);
    checkRapids(toolpath, 3);
    // No feed move across the raster at all: no step-over through the stock.
    for (const [p, q] of cutsAt(toolpath, -3)) {
      const d: Vec2 = [q[0] - p[0], q[1] - p[1]];
      expect(Math.abs(d[0] * -Math.sin(a) + d[1] * Math.cos(a))).toBeLessThan(1e-9);
    }
  });

  it('runs the tool centre a margin beyond the outline, the tool radius by default', async () => {
    const xs = (tp: Toolpath): number[] => cutsAt(tp, -3).flatMap(([a, b]) => [a[0], b[0]]);
    const byDefault = await run(facing());
    expect(Math.min(...xs(byDefault.toolpath))).toBeCloseTo(-R, 6);
    expect(Math.max(...xs(byDefault.toolpath))).toBeCloseTo(100 + R, 6);
    const wide = await run(facing({ margin: 10 }));
    expect(Math.min(...xs(wide.toolpath))).toBeCloseTo(-10, 6);
    expect(Math.max(...xs(wide.toolpath))).toBeCloseTo(110, 6);
  });

  it('with no margin stays on the outline, warns, and still covers a square stock at 0 degrees', async () => {
    const { toolpath, warnings } = await run(facing({ margin: 0 }));
    expect(warnings?.map((w) => w.code)).toEqual(['margin-small']);
    const xs = cutsAt(toolpath, -3).flatMap(([a, b]) => [a[0], b[0]]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    expect(uncovered(toolpath, [stockLoop], -3)).toEqual([]);
  });

  it('covers stock narrower than the tool with one line', async () => {
    const strip = rect(0, 0, 50, 8);
    const { toolpath } = await run(facing({ loops: [strip] }));
    const lines = new Set(cutsAt(toolpath, -3).map(([a]) => Math.round(a[1] * 1e6)));
    expect(lines.size).toBe(1);
    expect(uncovered(toolpath, [strip], -3)).toEqual([]);
  });

  it('faces a non-convex area, linking a zigzag only inside it', async () => {
    // An L: the notch between the arms must not be crossed at depth.
    const ell = polygon([
      [0, 0],
      [100, 0],
      [100, 30],
      [30, 30],
      [30, 80],
      [0, 80],
    ]);
    for (const pattern of ['zigzag', 'oneway'] as const) {
      for (const deg of [0, 30]) {
        const { toolpath } = await run(
          facing({ loops: [ell], pattern, angle: (deg * Math.PI) / 180 }),
        );
        expect(uncovered(toolpath, [ell], -3, 0.5)).toEqual([]);
        // Every feed move at depth keeps the tool centre within the margin of the L.
        const polys = [flattenSegments(ell.segments, true, 0.01)];
        for (const [a, b] of cutsAt(toolpath, -3)) {
          for (let k = 0; k <= 20; k++) {
            const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20];
            if (pointInLoops(p, polys)) continue;
            expect(distToLoops(p, [ell])).toBeLessThanOrEqual(R + 1e-3);
          }
        }
      }
    }
  });

  it('warns when the depth exceeds the flute length', async () => {
    const { warnings } = await run(facing({ depth: { top: 0, bottom: -12 }, stepdown: 2 }));
    expect(warnings?.map((w) => w.code)).toEqual(['depth-exceeds-flutes']);
  });

  it.each([
    ['a zero stepover', { stepover: 0 }],
    ['a stepover over 1', { stepover: 1.5 }],
    ['a negative margin', { margin: -1 }],
    ['an unknown pattern', { pattern: 'spiral' as never }],
    ['an inverted depth', { depth: { top: -3, bottom: 0 } }],
    ['a zero stepdown', { stepdown: 0 }],
    ['a non-finite angle', { angle: Number.NaN }],
    ['no loops', { loops: [] }],
    ['a zero plunge feed', { feeds: { ...feeds, plunge: 0 } }],
  ])('rejects %s', async (_, over) => {
    const result = await generateFacing(facing(over as Partial<FacingOperation>), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-input');
  });

  it('calls checkpoint between passes and stops on CamCancelled', async () => {
    const checkpoints = { count: 0 };
    await run(facing(), context(heights, checkpoints));
    expect(checkpoints.count).toBeGreaterThan(3);
    const cancelling: OperationContext = {
      ...context(),
      checkpoint: () => Promise.reject(new CamCancelled()),
    };
    await expect(generateFacing(facing(), cancelling)).rejects.toBeInstanceOf(CamCancelled);
  });

  it('is registered as the facing generator', () => {
    const registry = registerBuiltinOperations(new OperationRegistry());
    expect(registry.get('facing')).toBe(generateFacing);
  });
});

describe('facingRaster', () => {
  it('spaces lines at most a stepover apart, overlapping the edges by the stepover', () => {
    const raster = facingRaster([stockLoop], {
      toolRadius: R,
      stepover: 5,
      angle: 0,
      margin: R,
    });
    if (!raster.ok) throw new Error(raster.error.message);
    const ys = raster.value.lines.map((l) => l[0]!.a[1]);
    expect(ys[0]).toBeCloseTo(R - 5, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(60 - R + 5, 9);
    expect(raster.value.spacing).toBeLessThanOrEqual(5);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeCloseTo(raster.value.spacing, 9);
    }
  });

  it('splits a line into stretches where it leaves the area', () => {
    const u = polygon([
      [0, 0],
      [60, 0],
      [60, 40],
      [40, 40],
      [40, 10],
      [20, 10],
      [20, 40],
      [0, 40],
    ]);
    const raster = facingRaster([u], { toolRadius: 3, stepover: 2, angle: 0, margin: 0 });
    if (!raster.ok) throw new Error(raster.error.message);
    const counts = raster.value.lines.map((l) => l.length);
    expect(counts).toContain(1);
    expect(counts).toContain(2);
    for (const line of raster.value.lines) {
      for (const c of line) expect(c.b[0]).toBeGreaterThan(c.a[0]);
    }
  });
});

describe('generateFacing: origin on the stock bottom', () => {
  // Stock 19 mm thick (an 18 mm part and a 1 mm top margin), origin on the bottom: the stock top
  // is Z 19. A retract of 5 is below it.
  function bottomContext(h = { clearance: 30, retract: 5 }): OperationContext {
    const ctx = context(h);
    return {
      ...ctx,
      setup: {
        ...ctx.setup,
        stock: { min: [0, 0, 0], max: [100, 60, 19] },
        wcs: { ...ctx.setup.wcs, origin: { xy: 'front-left', z: 'bottom' } },
      },
    };
  }
  const sidewaysRapids = (tp: Toolpath) =>
    withStarts(tp).filter(
      ({ from, move }) =>
        move.kind === 'rapid' && Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 0,
    );

  it('faces from the stock top with every rapid above it (one way, so it retracts per line)', async () => {
    const r = await run(
      facing({ depth: { top: 19, bottom: 18 }, stepdown: 0.5, pattern: 'oneway' }),
      bottomContext(),
    );
    expect(rapidsIntoStockTop(r.toolpath, 19, FACING_SAFE_ABOVE)).toEqual([]);
    const sideways = sidewaysRapids(r.toolpath);
    expect(sideways.length).toBeGreaterThan(2);
    for (const { move } of sideways) expect(move.to[2]).toBeCloseTo(19.5, 9);
    expect(r.warnings?.map((w) => w.code) ?? []).not.toContain('top-below-stock');
  });

  it('stays above the stock top when the operation starts below it, with a warning', async () => {
    const r = await run(
      facing({ depth: { top: 18.5, bottom: 18 }, stepdown: 0.5, pattern: 'oneway' }),
      bottomContext(),
    );
    expect(rapidsIntoStockTop(r.toolpath, 19, FACING_SAFE_ABOVE)).toEqual([]);
    expect(r.warnings?.map((w) => w.code)).toContain('top-below-stock');
  });

  it('keeps a retract that is already above the stock top', async () => {
    const r = await run(
      facing({ depth: { top: 19, bottom: 18 }, stepdown: 0.5, pattern: 'oneway' }),
      bottomContext({ clearance: 30, retract: 22 }),
    );
    for (const { move } of sidewaysRapids(r.toolpath)) expect(move.to[2]).toBe(22);
  });
});
