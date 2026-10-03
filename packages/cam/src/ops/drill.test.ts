import { describe, expect, it } from 'vitest';
import { radiusAbout } from '../arc';
import type { ArcMove, DrillCycle, Toolpath } from '../ir';
import { postGrbl } from '../post/grbl';
import { toolpathStats } from '../stats';
import type { DrillPoint, MachineDrillPoint, Setup, Tool, Vec2, Vec3 } from '../types';
import { validateToolpath } from '../validate';
import { drillPointToMachine, wcsFrame } from '../wcs';
import { registerBuiltinOperations } from '../worker/builtin';
import { packToolpath, unpackToolpath } from '../worker/pack';
import { OperationRegistry, type OperationContext } from '../worker/registry';
import {
  DRILL_BREAKTHROUGH_MARGIN,
  DRILL_CAVITY_CLEARANCE,
  DRILL_MAX_PECKS,
  DRILL_MIN_BORE_RADIUS,
  DRILL_PECK_CLEARANCE,
  generateDrill,
  nearestNeighbourOrder,
  toolTipLength,
  type DrillOperation,
} from './drill';

const IN = 25.4;
const deg = (d: number) => (d * Math.PI) / 180;

const drill6: Tool = {
  id: 'tool#2',
  name: '6 mm drill',
  kind: 'drill',
  diameter: 6,
  fluteLength: 40,
  flutes: 2,
  angle: deg(118),
};

const eighth: Tool = {
  id: 'tool#3',
  name: '1/8" flat',
  kind: 'flat',
  diameter: IN / 8,
  fluteLength: 12,
  flutes: 2,
};

const feeds = { spindle: 12000, cut: 800, plunge: 250, ramp: 400 };

const hole = (at: Vec2, diameter: number, top = 0, bottom = -6, through = false) =>
  ({
    at,
    depth: { top, bottom },
    diameter,
    ...(through ? { through } : {}),
  }) satisfies MachineDrillPoint;

function op(over: Partial<DrillOperation> = {}): DrillOperation {
  return {
    kind: 'drill',
    id: 'drill#1',
    name: 'Holes',
    tool: drill6,
    feeds,
    points: [hole([10, 10], 6)],
    ...over,
  };
}

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [0, 0, 0], max: [40, 20, 6] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 6], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};

function context(s: Setup = setup, checkpoints = { count: 0 }): OperationContext {
  return {
    generation: 1,
    cancelled: false,
    setup: s,
    checkpoint: () => {
      checkpoints.count++;
      return Promise.resolve();
    },
  };
}

/** Generates and checks the IR validator (bar what linking adds). */
async function run(o: DrillOperation, s: Setup = setup) {
  const result = await generateDrill(o, context(s));
  if (!result.ok) throw new Error(result.error.message);
  const issues = validateToolpath(result.value.toolpath).filter(
    (i) => i.code !== 'no-tool' && i.code !== 'spindle-off',
  );
  expect(issues).toEqual([]);
  return result.value;
}

const cycles = (t: Toolpath): DrillCycle[] =>
  t.entries.flatMap((e) => (e.kind === 'cycle' ? [e.drill] : []));

/** The positions after each entry (the position before the first is `start`). */
function positions(t: Toolpath): Vec3[] {
  let pos = t.start;
  return t.entries.map((e) => {
    if (e.kind === 'rapid' || e.kind === 'linear' || e.kind === 'arc') pos = e.to;
    return pos;
  });
}

/**
 * Every rapid that is below the stock top at either end stays inside material already cut away:
 * a column the tool has fed down (its centre within the cut, no deeper than the cut reached).
 */
function rapidsAboveStockOrInCut(t: Toolpath, toolRadius: number, stockTop = 0): void {
  const cut: { c: Vec2; reach: number; deepest: number }[] = [];
  let pos = t.start;
  for (const e of t.entries) {
    if (e.kind === 'linear' || e.kind === 'arc') {
      const c: Vec2 = e.kind === 'arc' ? e.center : [e.to[0], e.to[1]];
      const reach = e.kind === 'arc' ? radiusAbout(e.center, e.to) : 0;
      const z = Math.min(pos[2], e.to[2]);
      const col = cut.find((k) => Math.hypot(k.c[0] - c[0], k.c[1] - c[1]) < 1e-9);
      if (z < stockTop) {
        if (col) {
          col.reach = Math.max(col.reach, reach);
          col.deepest = Math.min(col.deepest, z);
        } else cut.push({ c, reach, deepest: z });
      }
    }
    if (e.kind === 'rapid') {
      for (const p of [pos, e.to]) {
        if (p[2] >= stockTop - 1e-9) continue;
        const inside = cut.some(
          (k) =>
            Math.hypot(p[0] - k.c[0], p[1] - k.c[1]) <= k.reach + 1e-9 &&
            p[2] >= k.deepest - 1e-9 &&
            toolRadius > 0,
        );
        expect(inside, `rapid to ${e.to.join(', ')} below the stock top outside the cut`).toBe(
          true,
        );
      }
      // A rapid below the stock top never moves sideways.
      if (Math.min(pos[2], e.to[2]) < stockTop - 1e-9) {
        expect(Math.hypot(e.to[0] - pos[0], e.to[1] - pos[1])).toBeLessThan(1e-9);
      }
    }
    if (e.kind === 'rapid' || e.kind === 'linear' || e.kind === 'arc') pos = e.to;
  }
}

describe('generateDrill', () => {
  it('drills a matching hole straight down inside a cycle marker, from and back to the retract height', async () => {
    const { toolpath } = await run(op());
    expect(toolpath.start).toEqual([10, 10, 10]);
    expect(cycles(toolpath)).toEqual([{ at: [10, 10], top: 0, bottom: -6, retract: 3 }]);
    const moves = toolpath.entries.map((e) =>
      e.kind === 'rapid' || e.kind === 'linear'
        ? [e.kind, ...e.to, ...(e.kind === 'linear' ? [e.feedClass, e.feed] : [])]
        : [e.kind],
    );
    expect(moves).toEqual([
      ['rapid', 10, 10, 3],
      ['cycle'],
      ['linear', 10, 10, -6, 'plunge', 250],
      ['rapid', 10, 10, 3],
      ['cycleEnd'],
      ['rapid', 10, 10, 10],
    ]);
    rapidsAboveStockOrInCut(toolpath, 3);
  });

  it('pecks: each peck retracts to the retract height, re-enters just above the last depth', async () => {
    const { toolpath } = await run(op({ peck: 2, dwell: 0.5 }));
    expect(cycles(toolpath)).toEqual([
      { at: [10, 10], top: 0, bottom: -6, retract: 3, peck: 2, dwell: 0.5 },
    ]);
    const inCycle = toolpath.entries.slice(
      toolpath.entries.findIndex((e) => e.kind === 'cycle') + 1,
      toolpath.entries.findIndex((e) => e.kind === 'cycleEnd'),
    );
    const c = DRILL_PECK_CLEARANCE;
    expect(
      inCycle.map((e) =>
        e.kind === 'dwell'
          ? ['dwell', e.seconds, e.pass]
          : e.kind === 'rapid' || e.kind === 'linear'
            ? [e.kind, e.to[2], e.pass]
            : [e.kind],
      ),
    ).toEqual([
      ['linear', -2, 0],
      ['rapid', 3, 0],
      ['rapid', -2 + c, 1],
      ['linear', -4, 1],
      ['rapid', 3, 1],
      ['rapid', -4 + c, 2],
      ['linear', -6, 2],
      ['dwell', 0.5, 2],
      ['rapid', 3, 2],
    ]);
    // Every peck but the last is followed by a rapid up to exactly the retract height.
    const feedsDown = inCycle.filter((e) => e.kind === 'linear');
    expect(feedsDown.every((e) => e.kind === 'linear' && e.feedClass === 'plunge')).toBe(true);
    rapidsAboveStockOrInCut(toolpath, 3);
  });

  it('measures pecks from the stock top and ends with a shorter peck when they do not divide', async () => {
    const { toolpath } = await run(op({ peck: 2.5 }));
    const depths = toolpath.entries.flatMap((e) => (e.kind === 'linear' ? [e.to[2]] : []));
    expect(depths).toEqual([-2.5, -5, -6]);
    // A peck as deep as the hole is one straight feed, and the cycle has no peck.
    const one = await run(op({ peck: 10 }));
    expect(cycles(one.toolpath)[0]!.peck).toBeUndefined();
  });

  it('adds the drill point and the breakthrough margin below a through hole', async () => {
    const tip = 3 / Math.tan(deg(59));
    expect(toolTipLength(drill6)).toBeCloseTo(tip, 12);
    const { toolpath } = await run(op({ points: [hole([10, 10], 6, 0, -6, true)] }));
    expect(cycles(toolpath)[0]!.bottom).toBeCloseTo(-6 - tip - DRILL_BREAKTHROUGH_MARGIN, 12);
    const custom = await run(op({ points: [hole([10, 10], 6, 0, -6, true)], breakthrough: 0.2 }));
    expect(cycles(custom.toolpath)[0]!.bottom).toBeCloseTo(-6 - tip - 0.2, 12);
    // A blind hole gets neither.
    const blind = await run(op({ points: [hole([10, 10], 6, 0, -4)] }));
    expect(cycles(blind.toolpath)[0]!.bottom).toBe(-4);
    // Tip lengths of the other tools.
    expect(toolTipLength(eighth)).toBe(0);
    expect(toolTipLength({ ...eighth, kind: 'ball' })).toBeCloseTo(IN / 16, 12);
    expect(toolTipLength({ ...eighth, kind: 'bull', cornerRadius: 0.5 })).toBe(0.5);
    expect(
      toolTipLength({
        id: 'tool#4',
        name: 'drill',
        kind: 'drill',
        diameter: 6,
        fluteLength: 40,
        flutes: 2,
      }),
    ).toBeCloseTo(3 / Math.tan(deg(59)), 12);
  });

  it('drills a counterbored hole from the retract height: no rapid below the stock top over it', async () => {
    // The through hole of a counterbore starts at the counterbore's floor, 2 mm down.
    const { toolpath } = await run(op({ points: [hole([10, 10], 6, -2, -6, true)], peck: 1.5 }));
    const c = cycles(toolpath)[0]!;
    expect(c.top).toBe(0);
    expect(c.retract).toBe(3);
    const pos = positions(toolpath);
    const firstFeed = toolpath.entries.findIndex((e) => e.kind === 'linear');
    expect(pos[firstFeed - 2]).toEqual([10, 10, 3]);
    rapidsAboveStockOrInCut(toolpath, 3);
  });

  it('keeps the retract height at least just above the stock top', async () => {
    const low: Setup = { ...setup, heights: { clearance: 0.2, retract: 0.1 } };
    const { toolpath } = await run(op(), low);
    expect(cycles(toolpath)[0]!.retract).toBe(0.5);
    expect(toolpath.start[2]).toBe(0.5);
    // The WCS on the stock bottom: the stock top is at machine Z 6.
    const bottom: Setup = {
      ...setup,
      wcs: { ...setup.wcs, origin: { xy: 'front-left', z: 'bottom' } },
    };
    const b = await run(op({ points: [hole([10, 10], 6, 4, 0)] }), bottom);
    expect(cycles(b.toolpath)[0]).toMatchObject({ top: 6, retract: 6.5 });
  });

  it('bores a 6 mm hole with a 1/8" end mill: a helix whose outer diameter is 6 mm, then a finishing circle', async () => {
    const { toolpath } = await run(op({ tool: eighth, points: [hole([20, 10], 6, 0, -6)] }));
    const arcs = toolpath.entries.filter((e): e is ArcMove => e.kind === 'arc');
    expect(arcs.length).toBeGreaterThan(2);
    const r = IN / 16;
    const pos = positions(toolpath);
    for (const a of arcs) {
      expect(a.center).toEqual([20, 10]);
      expect(a.fullCircle).toBe(true);
      expect(a.direction).toBe('ccw');
      expect(Math.abs(2 * (radiusAbout(a.center, a.to) + r) - 6)).toBeLessThan(0.01);
    }
    const ramps = arcs.filter((a) => a.feedClass === 'ramp');
    const finish = arcs.filter((a) => a.feedClass === 'cut');
    expect(finish).toHaveLength(1);
    expect(finish[0]!.to[2]).toBe(-6);
    expect(ramps[ramps.length - 1]!.to[2]).toBe(-6);
    // The helix descends evenly, and at most the angle's slope at the wall per turn.
    const pitch = 2 * Math.PI * 3 * Math.tan(deg(3));
    const firstArc = toolpath.entries.findIndex((e) => e.kind === 'arc');
    let z = pos[firstArc - 1]![2];
    expect(z).toBe(0);
    for (const a of ramps) {
      expect(z - a.to[2]).toBeLessThanOrEqual(pitch + 1e-9);
      z = a.to[2];
    }
    // No cycle markers: a bore is not a canned cycle.
    expect(cycles(toolpath)).toEqual([]);
    // Off the wall to the centre, then up.
    const tail = toolpath.entries.slice(-3);
    expect(tail.map((e) => e.kind)).toEqual(['linear', 'rapid', 'rapid']);
    expect(tail[0]!.kind === 'linear' && tail[0]!.to).toEqual([20, 10, -6]);
    rapidsAboveStockOrInCut(toolpath, r);
  });

  it('bores a hole wider than twice the tool in rings from the inside out, leaving no core', async () => {
    const tool = { ...eighth, diameter: 6 };
    const { toolpath } = await run(
      op({ tool, points: [hole([20, 10], 20, 0, -6, true)], helixAngle: deg(10) }),
    );
    const arcs = toolpath.entries.filter((e): e is ArcMove => e.kind === 'arc');
    const radii = [...new Set(arcs.map((a) => +radiusAbout(a.center, a.to).toFixed(9)))];
    // Inside out; the innermost within the tool radius, steps of at most half the tool.
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(radii[0]).toBeLessThanOrEqual(3);
    for (let k = 1; k < radii.length; k++) expect(radii[k]! - radii[k - 1]!).toBeLessThanOrEqual(3);
    expect(2 * (radii[radii.length - 1]! + 3)).toBeCloseTo(20, 9);
    // Every ring reaches the bottom (the through depth, no tip on a flat end mill).
    const bottom = -6 - DRILL_BREAKTHROUGH_MARGIN;
    for (const rr of radii) {
      const ring = arcs.filter((a) => Math.abs(radiusAbout(a.center, a.to) - rr) < 1e-6);
      expect(Math.min(...ring.map((a) => a.to[2]))).toBeCloseTo(bottom, 12);
    }
    // One pass per ring.
    const passes = new Set(arcs.map((a) => a.pass));
    expect(passes.size).toBe(radii.length);
    rapidsAboveStockOrInCut(toolpath, 3);
  });

  it('errors on holes smaller than the tool, naming them', async () => {
    const r = await generateDrill(
      op({ tool: eighth, points: [hole([5, 5], 3), hole([20, 10], 6), hole([30, 5], 2)] }),
      context(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-input');
    expect(r.error.message).toContain('2 holes are smaller than the 3.175 mm tool');
    expect(r.error.message).toContain('3 mm at (5, 5)');
    expect(r.error.message).toContain('2 mm at (30, 5)');
    // Within the inch-rounding tolerance it drills.
    expect(
      (await generateDrill(op({ tool: eighth, points: [hole([5, 5], 3.17)] }), context())).ok,
    ).toBe(true);
  });

  it('errors on a drill smaller than the hole, and on V-bits', async () => {
    const r = await generateDrill(op({ points: [hole([5, 5], 8)] }), context());
    expect(!r.ok && r.error.message).toMatch(/6 mm drill is smaller than a hole .*end mill/);
    const v = await generateDrill(
      op({ tool: { ...drill6, kind: 'vbit', angle: deg(90) } }),
      context(),
    );
    expect(!v.ok && v.error.message).toMatch(/vbit cannot drill/);
  });

  it('drills a hole slightly larger than the tool straight, within the match tolerance', async () => {
    const { toolpath } = await run(op({ points: [hole([5, 5], 6.04)] }));
    expect(cycles(toolpath)).toHaveLength(1);
    const bored = await run(op({ tool: { ...drill6, kind: 'flat' }, points: [hole([5, 5], 6.2)] }));
    expect(cycles(bored.toolpath)).toHaveLength(0);
    const loose = await run(op({ points: [hole([5, 5], 6.2)], matchTolerance: 0.3 }));
    expect(cycles(loose.toolpath)).toHaveLength(1);
  });

  it('drills straight rather than bore a ring smaller than the minimum radius, even with no tolerance', async () => {
    const flat = { ...drill6, kind: 'flat' as const };
    const hair = await run(op({ tool: flat, matchTolerance: 0, points: [hole([5, 5], 6.03)] }));
    expect(cycles(hair.toolpath)).toHaveLength(1);
    expect(hair.toolpath.entries.some((e) => e.kind === 'arc')).toBe(false);
    const ring = await run(op({ tool: flat, matchTolerance: 0, points: [hole([5, 5], 6.06)] }));
    const arcs = ring.toolpath.entries.filter((e): e is ArcMove => e.kind === 'arc');
    expect(arcs.length).toBeGreaterThan(0);
    for (const a of arcs) {
      expect(radiusAbout(a.center, a.to)).toBeGreaterThanOrEqual(DRILL_MIN_BORE_RADIUS);
    }
  });

  it('caps the breakthrough above a cavity floor under the exit, with a warning', async () => {
    const tip = toolTipLength(drill6);
    // A web 4 mm thick over a cavity 1.5 mm high: the full breakthrough (2.3 mm) reaches its floor.
    const web = { ...hole([10, 10], 6, 0, -4, true), clearBelow: 1.5 };
    const r = await run(op({ points: [web] }));
    expect(cycles(r.toolpath)[0]!.bottom).toBeCloseTo(-4 - (1.5 - DRILL_CAVITY_CLEARANCE), 12);
    expect(r.warnings?.map((w) => w.code)).toEqual(['breakthrough-capped']);
    // Room enough below: the whole breakthrough, no warning.
    const roomy = await run(op({ points: [{ ...web, clearBelow: 10 }] }));
    expect(cycles(roomy.toolpath)[0]!.bottom).toBeCloseTo(-4 - tip - DRILL_BREAKTHROUGH_MARGIN, 12);
    expect(roomy.warnings).toBeUndefined();
    // The clear height passes through drillPointToMachine.
    const frame = wcsFrame(setup.wcs, setup.stock);
    if (!frame.ok) throw new Error(frame.error.message);
    const m = drillPointToMachine(frame.value, {
      position: [10, 10, 6],
      axis: [0, 0, -1],
      diameter: 6,
      depth: 4,
      through: true,
      clearBelow: 3,
      entryTilt: 0.5,
    });
    expect(m.ok && m.value).toMatchObject({ clearBelow: 3, entryTilt: 0.5 });
  });

  it('warns when a drill, but not a bore, enters a mouth sloped more than 20 degrees', async () => {
    const slope = (t: number) => ({ ...hole([10, 10], 6), entryTilt: deg(t) });
    expect((await run(op({ points: [slope(19)] }))).warnings).toBeUndefined();
    const steep = await run(op({ points: [slope(25)] }));
    expect(steep.warnings).toEqual([
      expect.objectContaining({
        code: 'sloped-entry',
        message: expect.stringContaining('25 degrees'),
      }),
    ]);
    const bored = await run(op({ tool: eighth, points: [slope(25)] }));
    expect(bored.warnings).toBeUndefined();
  });

  it('merges duplicates cautiously: the highest cavity floor and the steepest mouth', async () => {
    const a = { ...hole([10, 10], 6, 0, -4, true), clearBelow: 5, entryTilt: deg(5) };
    const b = { ...hole([10, 10], 6, 0, -5, true), clearBelow: 1.5, entryTilt: deg(30) };
    const r = await run(op({ points: [a, b] }));
    // Floors at -9 and -6.5: the merged hole ends at -5, with 1.5 mm clear above the higher floor.
    expect(cycles(r.toolpath)[0]!.bottom).toBeCloseTo(-5 - (1.5 - DRILL_CAVITY_CLEARANCE), 12);
    expect(r.warnings?.map((w) => w.code)).toEqual(['breakthrough-capped', 'sloped-entry']);
    // One source already below the other's floor (-6.5): a warning, and no breakthrough.
    const c = { ...hole([10, 10], 6, 0, -7, true) };
    const deep = await run(op({ points: [b, c] }));
    expect(deep.warnings?.map((w) => w.code)).toEqual(['merged-below-floor', 'sloped-entry']);
    expect(cycles(deep.toolpath)[0]!.bottom).toBeCloseTo(-7, 12);
    // A duplicate with nothing measured under it keeps the other's floor.
    const plain = await run(op({ points: [hole([10, 10], 6, 0, -5, true), b] }));
    expect(cycles(plain.toolpath)[0]!.bottom).toBeCloseTo(-5 - (1.5 - DRILL_CAVITY_CLEARANCE), 12);
  });

  it('refuses bad numbers and empty operations', async () => {
    const bad = async (o: DrillOperation) => {
      const r = await generateDrill(o, context());
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error.message;
    };
    expect(await bad(op({ points: [] }))).toMatch(/no holes/);
    expect(await bad(op({ peck: 0 }))).toMatch(/peck/);
    expect(await bad(op({ dwell: -1 }))).toMatch(/dwell/);
    expect(await bad(op({ breakthrough: -1 }))).toMatch(/breakthrough/);
    expect(await bad(op({ helixAngle: 0 }))).toMatch(/helix angle/);
    expect(await bad(op({ helixAngle: 1e-8 }))).toMatch(/at least 0\.5/);
    expect(await bad(op({ boreStepover: 1.5 }))).toMatch(/stepover/);
    expect(await bad(op({ points: [hole([0, 0], 6, -6, 0)] }))).toMatch(/bottom/);
    expect(await bad(op({ points: [hole([0, Number.NaN], 6)] }))).toMatch(/not finite/);
    expect(await bad(op({ feeds: { ...feeds, plunge: 0 } }))).toMatch(/plunge/);
  });

  it('refuses a peck so small that a hole needs more than DRILL_MAX_PECKS pecks', async () => {
    // 6 mm in pecks of 1e-7 mm would be 60 million depths; refused before any is listed.
    const r = await generateDrill(op({ peck: 1e-7 }), context());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-input');
      expect(r.error.message).toMatch(
        new RegExp(
          `drill#1: the hole at \\(10, 10\\) is 6 mm deep and needs 60000000 pecks.*at most ${DRILL_MAX_PECKS}`,
        ),
      );
    }
    // A peck far below the rounding step of the hole's depth must not stall either.
    const far = await generateDrill(
      op({ points: [hole([10, 10], 6, 1e9, 1e9 - 6)], peck: 1e-9 }),
      context(),
    );
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.error.message).toMatch(/needs \d+ pecks/);
    // Exactly at the cap is allowed: 6 mm in 10000 pecks.
    const most = await run(op({ peck: 6 / DRILL_MAX_PECKS }));
    const plunges = most.toolpath.entries.filter((e) => e.kind === 'linear');
    expect(plunges.length).toBe(DRILL_MAX_PECKS);
    expect(plunges.at(-1)!.kind === 'linear' && plunges.at(-1)!.to[2]).toBe(-6);
    // Depths go down by one peck each, measured from the top by index (no running sum drift).
    const zs = plunges.map((e) => (e.kind === 'linear' ? e.to[2] : 0));
    expect(zs[4999]).toBe(-5000 * (6 / DRILL_MAX_PECKS));
  });

  it('visits holes in nearest-neighbour order from the WCS origin and merges duplicates', async () => {
    const points = [hole([30, 15], 6), hole([5, 5], 6), hole([31, 4], 6), hole([12, 6], 6)];
    const { toolpath } = await run(op({ points: [...points, hole([5, 5], 6, 0, -8)] }));
    expect(cycles(toolpath).map((c) => c.at)).toEqual([
      [5, 5],
      [12, 6],
      [31, 4],
      [30, 15],
    ]);
    // The duplicate at (5, 5) went as deep as the deeper of the two.
    expect(cycles(toolpath)[0]!.bottom).toBe(-8);
    expect(nearestNeighbourOrder([{ at: [3, 0] }, { at: [1, 0] }], [0, 0])).toEqual([
      { at: [1, 0] },
      { at: [3, 0] },
    ]);
    // Between holes the tool crosses at the retract height.
    const pos = positions(toolpath);
    toolpath.entries.forEach((e, i) => {
      if (e.kind !== 'rapid' || i === 0) return;
      const from = pos[i - 1]!;
      if (Math.hypot(e.to[0] - from[0], e.to[1] - from[1]) > 1e-9) {
        expect(from[2]).toBe(3);
        expect(e.to[2]).toBe(3);
      }
    });
  });

  it("drills the bracket's two holes at their machine positions", async () => {
    // The M1 bracket (40 x 20 x 6 plate, model Z 0 to 6) as the geometry stage gives its holes:
    // the 6 mm hole at (20, 10) and the 4 mm through-hole of a counterbore at (8, 10), 2 mm down.
    const holes: DrillPoint[] = [
      { position: [20, 10, 6], axis: [0, 0, -1], diameter: 6, depth: 6, through: true },
      { position: [8, 10, 4], axis: [0, 0, -1], diameter: 4, depth: 4, through: true },
    ];
    const frame = wcsFrame(setup.wcs, setup.stock);
    if (!frame.ok) throw new Error(frame.error.message);
    const points = holes.map((h) => {
      const m = drillPointToMachine(frame.value, h);
      if (!m.ok) throw new Error(m.error.message);
      return m.value;
    });
    const tool = { ...drill6, diameter: 4 };
    const r = await generateDrill(op({ tool, points }), context());
    expect(!r.ok && r.error.message).toMatch(/smaller than a hole \(6 mm at \(20, 10\)\)/);
    const { toolpath } = await run(
      op({ tool: eighth, points: points.map((p) => ({ ...p, diameter: eighth.diameter })) }),
    );
    expect(cycles(toolpath).map((c) => c.at)).toEqual([
      [8, 10],
      [20, 10],
    ]);
    const tip = toolTipLength(eighth);
    expect(cycles(toolpath).map((c) => c.bottom)).toEqual([
      -6 - tip - DRILL_BREAKTHROUGH_MARGIN,
      -6 - tip - DRILL_BREAKTHROUGH_MARGIN,
    ]);
  });

  it('is registered, posts for Grbl as plain G0 and G1 moves, and survives packing', async () => {
    const registry = registerBuiltinOperations(new OperationRegistry());
    expect(registry.get('drill')).toBe(generateDrill);
    const { toolpath } = await run(
      op({ peck: 2, dwell: 0.5, points: [hole([10, 10], 6), hole([30, 10], 6)] }),
    );
    const program: Toolpath = {
      start: toolpath.start,
      entries: [
        { kind: 'toolChange', tool: drill6.id, number: 2, name: drill6.name, diameter: 6 },
        { kind: 'spindle', state: 'cw', rpm: feeds.spindle },
        ...toolpath.entries,
        { kind: 'spindle', state: 'off' },
      ],
    };
    expect(validateToolpath(program)).toEqual([]);
    const post = postGrbl({ toolpath: program, job: 'Bracket', heights: setup.heights });
    if (!post.ok) throw new Error(post.error.message);
    const text = post.value.files[0]!.text;
    expect(text).not.toMatch(/G8[0-9]/);
    expect(text).toContain('G4 P0.5');
    expect(text.match(/G1 Z-6/g)).toHaveLength(2);
    expect(unpackToolpath(packToolpath(program))).toEqual(program);
    const stats = toolpathStats(toolpath, { rapidRate: 5000 });
    expect(stats.ok && stats.value.lengthByClass.plunge).toBeCloseTo(2 * (3 + 2 + 2.5 + 2.5), 9);
  });

  it('checkpoints before every hole', async () => {
    const counter = { count: 0 };
    const r = await generateDrill(
      op({ points: [hole([1, 1], 6), hole([9, 1], 6), hole([20, 1], 6)] }),
      context(setup, counter),
    );
    expect(r.ok).toBe(true);
    expect(counter.count).toBe(3);
  });

  it('warns when the deepest hole is deeper than the flutes', async () => {
    const r = await run(op({ tool: { ...drill6, fluteLength: 5 } }));
    expect(r.warnings?.map((w) => w.code)).toEqual(['depth-exceeds-flutes']);
  });
});
