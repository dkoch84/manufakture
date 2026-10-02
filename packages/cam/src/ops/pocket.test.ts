import { describe, expect, it } from 'vitest';
import { angleAbout, arcSweep, radiusAbout } from '../arc';
import type { Move, Toolpath } from '../ir';
import { isMove } from '../ir';
import { regionLoops, unionLoops } from '../offset/engine';
import { flattenSegments } from '../offset/flatten';
import { distToLoops, pointInLoops } from '../offset/geometry';
import { circle, dumbbell, hole, polygon, rect, slot } from '../offset/test-shapes';
import type { Loop2, Setup, Vec2, Vec3 } from '../types';
import { validateToolpath } from '../validate';
import { registerBuiltinOperations } from '../worker/builtin';
import { CamCancelled, OperationRegistry, type OperationContext } from '../worker/registry';
import {
  POCKET_SAFE_ABOVE,
  generatePocket,
  generatePocketLayers,
  pocketGeometry,
  type PocketOperation,
} from './pocket';

const tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
} as const;
const R = 3;

const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500, lead: 800 };

function pocket(over: Partial<PocketOperation> = {}): PocketOperation {
  return {
    kind: 'pocket',
    id: 'pocket#1',
    name: 'Recess',
    tool,
    feeds,
    loops: [rect(0, 0, 40, 20)],
    depth: { top: 0, bottom: -6 },
    stepdown: 3,
    stepover: 0.5,
    finishAllowance: 0,
    entry: { kind: 'helix', angle: (3 * Math.PI) / 180, radius: 2 },
    climb: true,
    ...over,
  };
}

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [-50, -50, -12], max: [350, 250, 0] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};

function context(checkpoints = { count: 0 }): OperationContext {
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
async function run(op: PocketOperation) {
  const result = await generatePocket(op, context());
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

/** Points along a move in XY, about every `step` mm (arcs sampled along the arc). */
function samplesOf(from: Vec3, m: Move, step = 0.1): Vec3[] {
  if (m.kind !== 'arc') {
    const len = Math.hypot(m.to[0] - from[0], m.to[1] - from[1]);
    const n = Math.max(1, Math.ceil(len / step));
    return Array.from({ length: n + 1 }, (_, k): Vec3 => [
      from[0] + ((m.to[0] - from[0]) * k) / n,
      from[1] + ((m.to[1] - from[1]) * k) / n,
      from[2] + ((m.to[2] - from[2]) * k) / n,
    ]);
  }
  const sweep =
    (m.fullCircle ? 2 * Math.PI : arcSweep({ ...m, start: from, end: m.to })) *
    (m.direction === 'ccw' ? 1 : -1);
  const a0 = angleAbout(m.center, from);
  const r = radiusAbout(m.center, from);
  const n = Math.max(8, Math.ceil((Math.abs(sweep) * r) / step));
  return Array.from({ length: n + 1 }, (_, k): Vec3 => {
    const a = a0 + (sweep * k) / n;
    return [
      m.center[0] + r * Math.cos(a),
      m.center[1] + r * Math.sin(a),
      from[2] + ((m.to[2] - from[2]) * k) / n,
    ];
  });
}

/** Every tool centre point of feed moves, sampled. */
function feedSamples(tp: Toolpath): Vec3[] {
  return withStarts(tp)
    .filter(({ move }) => move.kind !== 'rapid')
    .flatMap(({ from, move }) => samplesOf(from, move));
}

/** A grid of buckets for nearest-distance queries over many points. */
class PointGrid {
  private readonly cells = new Map<string, Vec2[]>();
  constructor(
    points: readonly Vec2[],
    private readonly size: number,
  ) {
    for (const p of points) {
      const key = this.key(Math.floor(p[0] / size), Math.floor(p[1] / size));
      const list = this.cells.get(key) ?? [];
      list.push(p);
      this.cells.set(key, list);
    }
  }
  private key(i: number, j: number): string {
    return `${i},${j}`;
  }
  /** Whether some point lies within `d` (at most the cell size) of `p`. */
  near(p: Vec2, d: number): boolean {
    const i = Math.floor(p[0] / this.size);
    const j = Math.floor(p[1] / this.size);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const q of this.cells.get(this.key(i + di, j + dj)) ?? []) {
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= d) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Raster check of the swept tool at depth `z`: every grid point inside the pocket that a tool
 * centre can reach must lie within the tool radius of a tool centre point cut at `z`. A point
 * counts as reachable when the centre stepped from it straight away from its nearest wall to the
 * tool radius stands at least the tool radius from every wall (sufficient, not exact: corners and
 * necks drop out, straight walls and arcs right up to the wall stay in). Returns the uncovered
 * grid points.
 */
function uncovered(tp: Toolpath, loops: readonly Loop2[], z: number): Vec2[] {
  const centres = feedSamples(tp)
    .filter((p) => Math.abs(p[2] - z) < 1e-6)
    .map((p): Vec2 => [p[0], p[1]]);
  const grid = new PointGrid(centres, R + 0.1);
  const polys = loops.map((l) => flattenSegments(l.segments, true, 0.01));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polys.flat()) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const depth = (p: Vec2): number => distToLoops(p, loops);
  const reachable = (p: Vec2, d: number): boolean => {
    if (d >= R) return true;
    const e = 1e-3;
    const gx = depth([p[0] + e, p[1]]) - depth([p[0] - e, p[1]]);
    const gy = depth([p[0], p[1] + e]) - depth([p[0], p[1] - e]);
    const g = Math.hypot(gx, gy);
    if (g < 1e-6) return false;
    const c: Vec2 = [p[0] + (gx / g) * (R - d), p[1] + (gy / g) * (R - d)];
    return pointInLoops(c, polys) && depth(c) >= R - 0.01;
  };
  const out: Vec2[] = [];
  const step = 0.25;
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      const p: Vec2 = [x, y];
      if (!pointInLoops(p, polys)) continue;
      const d = depth(p);
      if (d < 0.02 || !reachable(p, d)) continue;
      if (!grid.near(p, R + 0.01)) out.push(p);
    }
  }
  return out;
}

/** Points cut below the top whose tool would reach past the walls or into an island. */
function gouges(tp: Toolpath, loops: readonly Loop2[], clearance = R): Vec3[] {
  const polys = loops.map((l) => flattenSegments(l.segments, true, 0.01));
  return feedSamples(tp).filter(
    (p) =>
      p[2] < -1e-9 &&
      (!pointInLoops([p[0], p[1]], polys) || distToLoops([p[0], p[1]], loops) < clearance - 0.006),
  );
}

/** The Z levels the clearing passes cut at, by pass. */
function levelsByPass(tp: Toolpath): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of tp.entries.filter(isMove)) {
    if (m.kind === 'rapid') continue;
    out.set(m.pass, Math.min(out.get(m.pass) ?? Infinity, m.to[2]));
  }
  return out;
}

describe('pocket operation: clearing', () => {
  it('clears a rectangle at every level with no uncut area, in steps no deeper than the stepdown', async () => {
    const op = pocket();
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const lv = levelsByPass(toolpath);
    expect([...lv.values()]).toEqual([-3, -6]);
    for (const z of [-3, -6]) expect(uncovered(toolpath, op.loops, z)).toEqual([]);
    expect(gouges(toolpath, op.loops)).toEqual([]);
    // Starts at clearance and ends there.
    expect(toolpath.start[2]).toBe(10);
    expect(toolpath.entries[toolpath.entries.length - 1]).toMatchObject({ kind: 'rapid' });
  });

  it('links the rings of a level at depth: rapids only between levels', async () => {
    const { toolpath } = await run(pocket());
    const moves = withStarts(toolpath);
    for (const pass of [0, 1]) {
      const inPass = moves.filter(({ move }) => move.pass === pass);
      const firstFeed = inPass.findIndex(({ move }) => move.kind !== 'rapid');
      // Before the first feed of the pass: rapids to the entry. After it, none until the end.
      const later = inPass.slice(firstFeed).filter(({ move }) => move.kind === 'rapid');
      expect(later.length).toBeLessThanOrEqual(pass === 1 ? 1 : 0);
    }
  });

  it('cuts climb (counter-clockwise outer rings) or conventional (clockwise)', async () => {
    const climb = await run(pocket({ entry: { kind: 'plunge' } }));
    const conv = await run(pocket({ entry: { kind: 'plunge' }, climb: false }));
    const area = (tp: Toolpath): number => {
      // Signed area swept by the cut moves of the outermost ring: the last ring of pass 0.
      const cuts = withStarts(tp).filter(
        ({ move }) => move.kind !== 'rapid' && move.pass === 0 && move.feedClass === 'cut',
      );
      let a = 0;
      for (const { from, move } of cuts) a += from[0] * move.to[1] - move.to[0] * from[1];
      return a;
    };
    expect(area(climb.toolpath)).toBeGreaterThan(0);
    expect(area(conv.toolpath)).toBeLessThan(0);
  });

  it('cleans up stepover cusps in corners when the stepover is over 85% of the diameter', async () => {
    const op = pocket({ stepover: 0.95 });
    const geom = pocketGeometry(op.loops, {
      toolRadius: R,
      stepover: 0.95 * 6,
      allowance: 0,
      finishing: false,
    });
    if (!geom.ok) throw new Error(geom.error.message);
    expect(geom.value.spots.length).toBeGreaterThan(0);
    expect(geom.value.cuspArea).toBe(0);
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    expect(uncovered(toolpath, op.loops, -6)).toEqual([]);
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('clears a circle with full-circle rings, arcs kept as arcs', async () => {
    const op = pocket({ loops: [circle([0, 0], 15)], stepover: 0.6 });
    const { toolpath } = await run(op);
    const cutArcs = toolpath.entries.filter(
      (e) => e.kind === 'arc' && e.feedClass === 'cut' && !e.fullCircle,
    );
    expect(cutArcs.length).toBeGreaterThan(0);
    expect(
      toolpath.entries.filter((e) => e.kind === 'linear' && e.feedClass === 'cut').length,
    ).toBeLessThan(20);
    expect(uncovered(toolpath, op.loops, -6)).toEqual([]);
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('leaves an island untouched and clears around it', async () => {
    const island = hole(rect(20, 15, 20, 10));
    const op = pocket({ loops: [rect(0, 0, 60, 40), island] });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    // No tool centre at depth comes closer to the island than the tool radius, or inside it.
    const islandPolys = [flattenSegments(island.segments, true, 0.01)];
    for (const p of feedSamples(toolpath).filter((q) => q[2] < 0)) {
      expect(pointInLoops([p[0], p[1]], islandPolys)).toBe(false);
      expect(distToLoops([p[0], p[1]], [island])).toBeGreaterThan(R - 0.006);
    }
    expect(gouges(toolpath, op.loops)).toEqual([]);
    expect(uncovered(toolpath, op.loops, -6)).toEqual([]);
  });

  it('clears a recessed border with one entry per level, routed through cut rings', async () => {
    const op = pocket({ loops: [rect(0, 0, 200, 100), hole(rect(20, 20, 160, 60))] });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const moves = withStarts(toolpath);
    for (const pass of [0, 1]) {
      const entries = moves.filter(
        ({ move }, i) =>
          move.kind !== 'rapid' && move.pass === pass && moves[i - 1]?.move.kind === 'rapid',
      );
      expect(entries).toHaveLength(1);
    }
    for (const z of [-3, -6]) expect(uncovered(toolpath, op.loops, z)).toEqual([]);
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('clears around several islands with no uncut area and no gouge', async () => {
    const op = pocket({
      loops: [
        rect(0, 0, 100, 100),
        hole(circle([30, 30], 10)),
        hole(circle([70, 70], 10)),
        hole(rect(60, 15, 20, 20)),
      ],
    });
    const { toolpath } = await run(op);
    for (const z of [-3, -6]) expect(uncovered(toolpath, op.loops, z)).toEqual([]);
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('has a raster check that catches a first ring too far from the wall', async () => {
    // Clearing that leaves 0.3 mm on the walls (no finishing pass) must fail the check.
    const op = pocket({ finishAllowance: 0.3, finishPass: false });
    const { toolpath } = await run(op);
    const missed = uncovered(toolpath, op.loops, -6);
    expect(missed.length).toBeGreaterThan(100);
    expect(Math.max(...missed.map((p) => distToLoops(p, op.loops)))).toBeLessThan(0.31);
  });

  it('warns when an island runs counter-clockwise and so is cut as pocket', async () => {
    const op = pocket({ loops: [rect(0, 0, 60, 40), circle([30, 20], 5)] });
    const { warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toEqual(['island-orientation']);
    expect(warnings?.[0]?.message).toContain('Loop(s) 1 ');
  });

  it('warns about a neck too narrow for the tool, with its area, and clears both lobes', async () => {
    const op = pocket({ loops: [dumbbell(4)] });
    const { toolpath, warnings } = await run(op);
    const neck = warnings?.filter((w) => w.code === 'unreachable') ?? [];
    expect(neck).toHaveLength(1);
    const geom = pocketGeometry(op.loops, {
      toolRadius: R,
      stepover: 3,
      allowance: 0,
      finishing: false,
    });
    if (!geom.ok) throw new Error(geom.error.message);
    expect(geom.value.unreachable).toHaveLength(1);
    const u = geom.value.unreachable[0]!;
    // The neck is 4 mm wide and about 20.4 mm long; the tool reaches into it about 0.2 mm at
    // each end, where the lobes' circles are.
    expect(u.area).toBeGreaterThan(70);
    expect(u.area).toBeLessThan(82);
    expect(Math.abs(u.at[0])).toBeLessThan(10);
    expect(Math.abs(u.at[1])).toBeLessThan(2);
    expect(neck[0]!.message).toContain(`${u.area.toFixed(1)} mm2`);
    // Everything else is cleared: the lobes, deeper than the tool can miss.
    const missed = uncovered(toolpath, op.loops, -6).filter((p) => Math.abs(p[0]) > 10.5);
    expect(missed).toEqual([]);
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('does not report square corners as unreachable', () => {
    const geom = pocketGeometry([rect(0, 0, 40, 20)], {
      toolRadius: R,
      stepover: 3,
      allowance: 0,
      finishing: true,
    });
    if (!geom.ok) throw new Error(geom.error.message);
    expect(geom.value.unreachable).toEqual([]);
  });
});

describe('pocket operation: entry', () => {
  it('enters by a helix inside the pocket, no steeper than the ramp angle', async () => {
    const angle = (3 * Math.PI) / 180;
    const op = pocket({ entry: { kind: 'helix', angle, radius: 2 } });
    const { toolpath } = await run(op);
    const helix = withStarts(toolpath).filter(
      ({ move }) => move.kind === 'arc' && move.feedClass === 'ramp',
    );
    expect(helix.length).toBeGreaterThan(0);
    for (const { from, move } of helix) {
      if (move.kind !== 'arc') throw new Error('arc expected');
      expect(move.fullCircle).toBe(true);
      const radius = radiusAbout(move.center, from);
      expect(radius).toBeCloseTo(2, 9);
      const drop = from[2] - move.to[2];
      expect(drop).toBeGreaterThan(0);
      expect(drop / (2 * Math.PI * radius)).toBeLessThanOrEqual(Math.tan(angle) + 1e-12);
      // The whole helix keeps the tool inside the pocket.
      for (let k = 0; k < 64; k++) {
        const a = (2 * Math.PI * k) / 64;
        const p: Vec2 = [
          move.center[0] + radius * Math.cos(a),
          move.center[1] + radius * Math.sin(a),
        ];
        expect(distToLoops(p, op.loops)).toBeGreaterThanOrEqual(R - 1e-9);
      }
    }
    // The second level's helix starts just above the first level's floor, not at the top.
    const plunges = toolpath.entries.filter((e) => e.kind === 'rapid' && e.pass === 1);
    expect(
      plunges.some((e) => 'to' in e && Math.abs(e.to[2] - (-3 + POCKET_SAFE_ABOVE)) < 1e-9),
    ).toBe(true);
  });

  it('shrinks the helix to the room there is', async () => {
    const op = pocket({
      loops: [rect(0, 0, 14, 14)],
      entry: { kind: 'helix', angle: 0.05, radius: 10 },
    });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const helix = withStarts(toolpath).find(
      ({ move }) => move.kind === 'arc' && move.feedClass === 'ramp',
    );
    if (!helix || helix.move.kind !== 'arc') throw new Error('no helix');
    const radius = radiusAbout(helix.move.center, helix.from);
    expect(radius).toBeGreaterThan(R * 0.2);
    expect(radius).toBeLessThanOrEqual(7 - R + 1e-9);
  });

  it('ramps along the ring when no helix fits, with a warning, at most at the angle', async () => {
    const angle = (5 * Math.PI) / 180;
    const op = pocket({ loops: [slot([0, 0], 30, 7)], entry: { kind: 'helix', angle, radius: 2 } });
    const { toolpath, warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toEqual(['helix-fallback']);
    const ramps = withStarts(toolpath).filter(
      ({ move }) => move.kind !== 'rapid' && move.feedClass === 'ramp',
    );
    expect(ramps.length).toBeGreaterThan(0);
    for (const { from, move } of ramps) {
      const len =
        move.kind === 'arc'
          ? radiusAbout(move.center, from) * arcSweep({ ...move, start: from, end: move.to })
          : Math.hypot(move.to[0] - from[0], move.to[1] - from[1]);
      expect((from[2] - move.to[2]) / len).toBeLessThanOrEqual(Math.tan(angle) + 1e-9);
    }
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('plunges when asked to', async () => {
    const { toolpath } = await run(pocket({ entry: { kind: 'plunge' } }));
    expect(toolpath.entries.some((e) => 'feedClass' in e && e.feedClass === 'ramp')).toBe(false);
    expect(toolpath.entries.some((e) => 'feedClass' in e && e.feedClass === 'plunge')).toBe(true);
  });
});

describe('pocket operation: allowances and finishing', () => {
  it('leaves the allowance on the walls, then finishes them at the tool radius', async () => {
    const op = pocket({ finishAllowance: 0.5 });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const passes = [...levelsByPass(toolpath).entries()];
    // Two clearing passes, then the wall in one finishing pass (6 mm is within the flutes).
    expect(passes).toEqual([
      [0, -6 + 3],
      [1, -6],
      [2, -6],
    ]);
    const moves = withStarts(toolpath).filter(({ move }) => move.kind !== 'rapid');
    // Clearing keeps the tool radius plus the allowance from the walls.
    const clearing = moves
      .filter(({ move }) => move.pass < 2)
      .flatMap(({ from, move }) => samplesOf(from, move));
    for (const p of clearing.filter((q) => q[2] < 0)) {
      expect(distToLoops([p[0], p[1]], op.loops)).toBeGreaterThan(3.5 - 0.006);
    }
    // The finishing cut runs at exactly the tool radius.
    const finish = moves.filter(
      ({ move }) => move.kind !== 'rapid' && move.pass === 2 && move.feedClass === 'cut',
    );
    expect(finish.length).toBeGreaterThan(0);
    for (const { from, move } of finish) {
      for (const p of samplesOf(from, move)) {
        expect(Math.abs(distToLoops([p[0], p[1]], op.loops) - R)).toBeLessThan(0.003);
      }
    }
    // It leads in and out from the cleared area.
    expect(
      moves.filter(
        ({ move }) => move.kind !== 'rapid' && move.pass === 2 && move.feedClass === 'lead',
      ),
    ).toHaveLength(2);
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });

  it('leaves a floor allowance and clears it in a floor pass', async () => {
    const op = pocket({ floorAllowance: 0.3 });
    const { toolpath } = await run(op);
    expect([...levelsByPass(toolpath).values()]).toEqual([-2.85, -5.7, -6]);
    expect(uncovered(toolpath, op.loops, -6)).toEqual([]);
    const without = await run(pocket({ floorAllowance: 0.3, floorPass: false }));
    expect([...levelsByPass(without.toolpath).values()]).toEqual([-2.85, -5.7]);
  });

  it('finishes the walls in stepdown steps when a neck kept the clearing out', async () => {
    // Necks 7 mm wide: the 6 mm tool plus 2 x 0.5 allowance does not fit, the finishing does.
    const op = pocket({ loops: [dumbbell(7)], finishAllowance: 0.5 });
    const { toolpath, warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toContain('finish-steps-down');
    expect(gouges(toolpath, op.loops)).toEqual([]);
  });
});

/**
 * Simulates material removal on a heightmap (cells of `cell` mm, stock top at `op.depth.top`):
 * every feed move lowers the cells under the tool disk. Returns how far the worst rapid ran below
 * the material left at that moment (under a disk 0.05 mm narrower than the tool, so grazing the
 * edge of a cut does not count), and the worst gouge into a wall or island.
 */
function simulate(tp: Toolpath, op: PocketOperation, cell: number) {
  const r = op.tool.diameter / 2;
  const polys = op.loops.map((l) => flattenSegments(l.segments, true, 0.01));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polys.flat()) {
    minX = Math.min(minX, p[0] - r - 1);
    minY = Math.min(minY, p[1] - r - 1);
    maxX = Math.max(maxX, p[0] + r + 1);
    maxY = Math.max(maxY, p[1] + r + 1);
  }
  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const ny = Math.ceil((maxY - minY) / cell) + 1;
  const h = new Float64Array(nx * ny).fill(op.depth.top);
  const disk = (x: number, y: number, rr: number, f: (k: number) => void): void => {
    const i0 = Math.max(0, Math.floor((x - rr - minX) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((x + rr - minX) / cell));
    const j0 = Math.max(0, Math.floor((y - rr - minY) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((y + rr - minY) / cell));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cx = minX + i * cell;
        const cy = minY + j * cell;
        if ((cx - x) ** 2 + (cy - y) ** 2 <= rr * rr) f(i * ny + j);
      }
    }
  };
  let rapidBelow = 0;
  let gouge = 0;
  for (const { from, move } of withStarts(tp)) {
    const pts = samplesOf(from, move, 0.05);
    if (move.kind === 'rapid') {
      for (const p of pts) {
        disk(p[0], p[1], r - 0.05, (k) => {
          rapidBelow = Math.max(rapidBelow, h[k]! - p[2]);
        });
      }
      continue;
    }
    for (const p of pts) {
      if (p[2] < op.depth.top - 1e-9) {
        const inside = pointInLoops([p[0], p[1]], polys);
        const d = inside ? distToLoops([p[0], p[1]], op.loops) : -1;
        gouge = Math.max(gouge, r - d);
      }
      disk(p[0], p[1], r, (k) => {
        if (h[k]! > p[2]) h[k] = p[2];
      });
    }
  }
  return { rapidBelow, gouge };
}

describe('pocket operation: material removal', () => {
  it('never rapids into material left on a re-entry (island near a wall, floor allowance)', async () => {
    const op = pocket({
      loops: [rect(0, 0, 33.69, 51.17), hole(circle([23.79, 42.47], 4))],
      stepover: 0.645,
      stepdown: 3.39,
      depth: { top: 0, bottom: -3.48 },
      floorAllowance: 0.2,
    });
    const { toolpath } = await run(op);
    const sim = simulate(toolpath, op, 0.1);
    expect(sim.rapidBelow).toBeLessThan(1e-6);
    expect(sim.gouge).toBeLessThan(0.003);
  });

  it('never rapids into material with a small tool between islands and walls', async () => {
    const op = pocket({
      tool: { ...tool, diameter: 1 },
      loops: [
        rect(0, 0, 20, 12),
        hole(rect(6, 4, 8, 4)),
        hole(circle([3, 9], 1.2)),
        hole(circle([17, 1.9], 1)),
      ],
      depth: { top: 0, bottom: -3 },
      stepdown: 1.5,
      stepover: 0.45,
      finishAllowance: 0.1,
      floorAllowance: 0.1,
    });
    const { toolpath } = await run(op);
    const sim = simulate(toolpath, op, 0.04);
    expect(sim.rapidBelow).toBeLessThan(1e-6);
    expect(sim.gouge).toBeLessThan(0.003);
  });

  it('plunges a finishing pass at the wall from above the top when it has no room to lead in', async () => {
    // A bulb off the left wall, through a neck narrower than the 2 mm tool: it has a finishing
    // loop of its own. The allowance is large enough that the clearing ring in the square counts
    // as covering that loop, but there is no room in the bulb to lead in from the cleared pocket,
    // so the pass plunges at the wall, through the allowance, which is uncut from the top down.
    const bulb = polygon(
      Array.from({ length: 96 }, (_, k): Vec2 => {
        const t = Math.PI + (2 * Math.PI * k) / 96;
        return [-1.85 + 2 * Math.cos(t), 12 + 2 * Math.sin(t)];
      }),
    );
    // One outline (the walls' distance check needs no overlap inside it).
    const united = unionLoops([rect(0, 0, 24, 24), bulb]);
    if (!united.ok) throw new Error(united.error.message);
    const op = pocket({
      tool: { ...tool, diameter: 2 },
      loops: regionLoops(united.value),
      finishAllowance: 9,
      entry: { kind: 'plunge' },
    });
    const { toolpath, warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toEqual(['finish-plunge-at-wall']);
    const moves = withStarts(toolpath);
    const plunges = moves
      .map((m, i) => ({ ...m, i }))
      .filter(
        ({ from, move }) => move.kind !== 'rapid' && move.feedClass === 'plunge' && from[0] < 0,
      );
    expect(plunges.length).toBeGreaterThan(0);
    for (const { from, i } of plunges) {
      // Straight down from the rapid that stopped above the top, not above the cleared floor.
      const before = moves[i - 1]!;
      expect(before.move.kind).toBe('rapid');
      expect(from[2]).toBeCloseTo(op.depth.top + POCKET_SAFE_ABOVE, 9);
    }
    const sim = simulate(toolpath, op, 0.05);
    expect(sim.rapidBelow).toBeLessThan(1e-6);
    expect(sim.gouge).toBeLessThan(0.003);
  });
});

describe('pocket operation: layers, refusals, plumbing', () => {
  it('clears z-level layers with their own loops (3D roughing)', async () => {
    const big = [rect(0, 0, 40, 30)];
    const small = [rect(5, 5, 20, 15)];
    const result = await generatePocketLayers(
      pocket(),
      [
        { z: -2, loops: big },
        { z: -4, loops: small },
        { z: -6, loops: small },
      ],
      context(),
    );
    if (!result.ok) throw new Error(result.error.message);
    const tp = result.value.toolpath;
    expect(
      validateToolpath(tp).filter((i) => i.code !== 'no-tool' && i.code !== 'spindle-off'),
    ).toEqual([]);
    expect([...levelsByPass(tp).values()]).toEqual([-2, -4, -6]);
    expect(uncovered(tp, big, -2)).toEqual([]);
    expect(uncovered(tp, small, -4)).toEqual([]);
    expect(gouges(tp, small).filter((p) => p[2] < -2 - 1e-9)).toEqual([]);
    const bad = await generatePocketLayers(
      pocket(),
      [
        { z: -4, loops: big },
        { z: -2, loops: big },
      ],
      context(),
    );
    expect(bad.ok).toBe(false);
  });

  it('refuses bad input and a tool that does not fit', async () => {
    const bad = async (over: Partial<PocketOperation>) => {
      const result = await generatePocket(pocket(over), context());
      expect(result.ok).toBe(false);
      return result.ok ? '' : result.error.message;
    };
    expect(await bad({ stepover: 0 })).toContain('stepover');
    expect(await bad({ stepover: 1.2 })).toContain('stepover');
    expect(await bad({ stepdown: 0 })).toContain('stepdown');
    expect(await bad({ depth: { top: 0, bottom: 1 } })).toContain('bottom');
    expect(await bad({ floorAllowance: 6 })).toContain('floor allowance');
    expect(await bad({ loops: [] })).toContain('no loops');
    expect(await bad({ loops: [rect(0, 0, 5, 5)] })).toContain('does not fit');
    expect(await bad({ entry: { kind: 'helix', angle: 0, radius: 1 } })).toContain('angle');
  });

  it('calls checkpoint between passes and stops on CamCancelled', async () => {
    const counter = { count: 0 };
    const result = await generatePocket(pocket(), context(counter));
    expect(result.ok).toBe(true);
    expect(counter.count).toBeGreaterThan(2);
    const cancelling: OperationContext = {
      ...context(),
      checkpoint: () => Promise.reject(new CamCancelled()),
    };
    await expect(generatePocket(pocket(), cancelling)).rejects.toBeInstanceOf(CamCancelled);
  });

  it('is registered as the pocket generator', () => {
    const registry = registerBuiltinOperations(new OperationRegistry());
    expect(registry.get('pocket')).toBe(generatePocket);
  });
});
