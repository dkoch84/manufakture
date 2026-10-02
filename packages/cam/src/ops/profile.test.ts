import { describe, expect, it } from 'vitest';
import { angleAbout, arcSweep, radiusAbout } from '../arc';
import type { ArcMove, IrEntry, LinearMove, Move, Toolpath } from '../ir';
import { isMove } from '../ir';
import { distToLoops, loopArea } from '../offset/geometry';
import { circle, dumbbell, hole, rect, roundedRect } from '../offset/test-shapes';
import type { Loop2, ProfileInput, Setup, Vec2, Vec3 } from '../types';
import { validateToolpath } from '../validate';
import { createCamWorkerApi } from '../worker/api';
import { registerBuiltinOperations } from '../worker/builtin';
import { CamCancelled, OperationRegistry, type OperationContext } from '../worker/registry';
import { generateProfile, type ProfileOperation } from './profile';

const tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
} as const;

const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500, lead: 800 };

function profile(over: Partial<ProfileOperation> = {}): ProfileOperation {
  return {
    kind: 'profile',
    id: 'profile#1',
    name: 'Outline',
    tool,
    feeds,
    loops: [rect(0, 0, 40, 20)],
    side: 'outside',
    depth: { top: 0, bottom: -3 },
    stepdown: 3,
    finishAllowance: 0,
    entry: { kind: 'plunge' },
    leadIn: { kind: 'none' },
    leadOut: { kind: 'none' },
    climb: false,
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
async function run(op: ProfileOperation) {
  const result = await generateProfile(op, context());
  if (!result.ok) throw new Error(result.error.message);
  const issues = validateToolpath(result.value.toolpath).filter(
    (i) => i.code !== 'no-tool' && i.code !== 'spindle-off',
  );
  expect(issues).toEqual([]);
  return result.value;
}

const round = (v: number): number => Math.round(v * 1e9) / 1e9 + 0;
const roundVec = <T extends readonly number[]>(v: T): number[] => v.map(round);

/** Entries with coordinates rounded to 1e-9, for exact comparison. */
function rounded(entries: readonly IrEntry[]): unknown[] {
  return entries.map((e) =>
    e.kind === 'arc'
      ? { ...e, to: roundVec(e.to), center: roundVec(e.center) }
      : 'to' in e
        ? { ...e, to: roundVec(e.to) }
        : e,
  );
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

/** Points along a feed move in XY (arcs sampled). */
function samplesOf(from: Vec3, m: Move, n = 8): Vec2[] {
  if (m.kind !== 'arc') {
    return Array.from({ length: n + 1 }, (_, k): Vec2 => [
      from[0] + ((m.to[0] - from[0]) * k) / n,
      from[1] + ((m.to[1] - from[1]) * k) / n,
    ]);
  }
  const sweep = arcSweep({ ...m, start: from, end: m.to }) * (m.direction === 'ccw' ? 1 : -1);
  const a0 = angleAbout(m.center, from);
  const r = radiusAbout(m.center, from);
  return Array.from({ length: n + 1 }, (_, k): Vec2 => {
    const a = a0 + (sweep * k) / n;
    return [m.center[0] + r * Math.cos(a), m.center[1] + r * Math.sin(a)];
  });
}

/** Exact XY length of a move. */
function xyLength(from: Vec3, m: Move): number {
  return m.kind === 'arc'
    ? radiusAbout(m.center, from) * arcSweep({ ...m, start: from, end: m.to })
    : Math.hypot(m.to[0] - from[0], m.to[1] - from[1]);
}

/** Cut moves (level, along the path) of one pass. */
function cutMoves(tp: Toolpath, pass: number) {
  return withStarts(tp).filter(
    ({ move }) => move.kind !== 'rapid' && move.pass === pass && move.feedClass === 'cut',
  );
}

/** Signed area of the XY polyline a pass's cut moves trace: positive counter-clockwise. */
function passArea(tp: Toolpath, pass: number): number {
  const pts = cutMoves(tp, pass).flatMap(({ from, move }) => samplesOf(from, move).slice(1));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function passes(tp: Toolpath): number[] {
  return [...new Set(tp.entries.filter(isMove).map((m) => m.pass))].sort((a, b) => a - b);
}

/** Largest deviation of a pass's cut moves from distance `d` to the loops. */
function deviation(tp: Toolpath, pass: number, loops: readonly Loop2[], d: number): number {
  let worst = 0;
  for (const { from, move } of cutMoves(tp, pass)) {
    for (const p of samplesOf(from, move))
      worst = Math.max(worst, Math.abs(distToLoops(p, loops) - d));
  }
  return worst;
}

/** Unit tangent of travel at the end (or start) of an XY move. */
function tangent(from: Vec3, m: Move, at: 'start' | 'end'): Vec2 {
  if (m.kind !== 'arc') {
    const dx = m.to[0] - from[0];
    const dy = m.to[1] - from[1];
    const l = Math.hypot(dx, dy);
    return [dx / l, dy / l];
  }
  const p = at === 'end' ? m.to : from;
  const r = radiusAbout(m.center, p);
  const u: Vec2 = [(p[0] - m.center[0]) / r, (p[1] - m.center[1]) / r];
  return m.direction === 'ccw' ? [-u[1], u[0]] : [u[1], -u[0]];
}

describe('profile operation: golden IR', () => {
  it('cuts a rectangle outside in one pass, conventional, plunging at the middle of a long side', async () => {
    const { toolpath, warnings } = await run(profile());
    expect(warnings).toBeUndefined();
    expect(roundVec(toolpath.start)).toEqual([20, -3, 10]);
    const op = 'profile#1';
    const cut = (to: Vec3): LinearMove => ({
      kind: 'linear',
      to,
      feed: 1000,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    const arc = (to: Vec3, center: Vec2): ArcMove => ({
      kind: 'arc',
      to,
      center,
      direction: 'ccw',
      fullCircle: false,
      feed: 1000,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    expect(rounded(toolpath.entries)).toEqual([
      { kind: 'rapid', to: [20, -3, 0.5], op, pass: 0 },
      { kind: 'linear', to: [20, -3, -3], feed: 300, feedClass: 'plunge', op, pass: 0 },
      cut([40, -3, -3]),
      arc([43, 0, -3], [40, 0]),
      cut([43, 20, -3]),
      arc([40, 23, -3], [40, 20]),
      cut([0, 23, -3]),
      arc([-3, 20, -3], [0, 20]),
      cut([-3, 0, -3]),
      arc([0, -3, -3], [0, 0]),
      cut([20, -3, -3]),
      { kind: 'rapid', to: [20, -3, 10], op, pass: 0 },
    ]);
  });

  it('climb milling reverses the same rectangle', async () => {
    const { toolpath } = await run(profile({ climb: true }));
    // Reversed, the first longest side is the top one, now run left to right.
    expect(roundVec(toolpath.start)).toEqual([20, 23, 10]);
    const moves = toolpath.entries.filter(isMove).map((m) => roundVec(m.to));
    expect(moves.slice(2, 5)).toEqual([
      [40, 23, -3],
      [43, 20, -3],
      [43, 0, -3],
    ]);
    const arcs = toolpath.entries.filter((e): e is ArcMove => e.kind === 'arc');
    expect(arcs.every((a) => a.direction === 'cw')).toBe(true);
  });
});

describe('profile operation: sides and the tool centre path', () => {
  const shapes: [string, Loop2][] = [
    ['rectangle', rect(0, 0, 60, 40)],
    ['rounded rectangle', roundedRect(80, 50, 8)],
    ['circle', circle([0, 0], 30)],
  ];

  for (const [name, loop] of shapes) {
    for (const side of ['outside', 'inside', 'on'] as const) {
      it(`${name}, ${side}: the path is at the tool radius and arcs stay arcs`, async () => {
        const { toolpath } = await run(profile({ loops: [loop], side }));
        const d = side === 'on' ? 0 : 3;
        // The analytic fast path is exact; Clipper's refit is within its tolerance.
        expect(deviation(toolpath, 0, [loop], d)).toBeLessThan(side === 'outside' ? 1e-9 : 0.003);
        const arcs = cutMoves(toolpath, 0).filter(({ move }) => move.kind === 'arc');
        if (name === 'circle') {
          expect(cutMoves(toolpath, 0).every(({ move }) => move.kind === 'arc')).toBe(true);
          const expected = side === 'outside' ? 33 : side === 'inside' ? 27 : 30;
          for (const { from, move } of arcs) {
            expect(radiusAbout((move as ArcMove).center, from)).toBeCloseTo(expected, 6);
          }
        } else if (name === 'rounded rectangle') {
          const radii = arcs.map(({ from, move }) => radiusAbout((move as ArcMove).center, from));
          const expected = side === 'outside' ? 11 : side === 'inside' ? 5 : 8;
          expect(radii.length).toBeGreaterThanOrEqual(4);
          for (const r of radii) expect(r).toBeCloseTo(expected, 2);
        } else if (side === 'outside') {
          expect(arcs).toHaveLength(4); // the round joins at the corners
        } else {
          expect(arcs).toHaveLength(0); // inside and on: sharp corners
        }
      });

      for (const climb of [false, true]) {
        it(`${name}, ${side}, ${climb ? 'climb' : 'conventional'}: direction by winding`, async () => {
          const { toolpath } = await run(profile({ loops: [loop], side, climb }));
          // M3 spindle: climb keeps the wall on the right of travel. Outside and on walls are on
          // the left of a counter-clockwise path, inside walls on its right.
          const ccw = side === 'inside' ? climb : !climb;
          expect(Math.sign(passArea(toolpath, 0))).toBe(ccw ? 1 : -1);
        });
      }
    }
  }

  it('cuts a hole of an outside profile first, on the scrap side', async () => {
    const loops = [rect(0, 0, 100, 60), hole(rect(30, 20, 40, 20))];
    const { toolpath } = await run(profile({ loops }));
    // Pass 0 is the hole (smaller), pass 1 the outline.
    expect(Math.abs(passArea(toolpath, 0))).toBeLessThan(Math.abs(passArea(toolpath, 1)));
    for (const { move } of cutMoves(toolpath, 0)) {
      expect(move.to[0]).toBeGreaterThan(30);
      expect(move.to[0]).toBeLessThan(70);
    }
    expect(deviation(toolpath, 0, loops, 3)).toBeLessThan(0.003);
    expect(deviation(toolpath, 1, loops, 3)).toBeLessThan(0.003);
  });
});

describe('profile operation: depth passes and finishing', () => {
  it('steps down evenly to the final depth, no step deeper than the stepdown', async () => {
    const { toolpath } = await run(
      profile({ depth: { top: 0, bottom: -12.5 }, stepdown: 3, loops: [roundedRect(80, 50, 8)] }),
    );
    const levels = passes(toolpath).map((p) => {
      const zs = new Set(cutMoves(toolpath, p).map(({ move }) => round(move.to[2])));
      expect(zs.size).toBe(1);
      return [...zs][0]!;
    });
    expect(levels).toHaveLength(5);
    expect(levels[levels.length - 1]).toBe(-12.5);
    let prev = 0;
    for (const z of levels) {
      expect(prev - z).toBeLessThanOrEqual(3 + 1e-9);
      expect(prev - z).toBeCloseTo(2.5, 9);
      prev = z;
    }
    // Between passes on the same loop the tool plunges straight on, with no rapid in between.
    expect(toolpath.entries.filter((e) => e.kind === 'rapid')).toHaveLength(2);
  });

  it('roughs and finishes each loop before any loop enclosing it', async () => {
    const loops = [rect(0, 0, 100, 60), hole(rect(30, 20, 40, 20))];
    const { toolpath } = await run(
      profile({ loops, depth: { top: 0, bottom: -12.5 }, stepdown: 3, finishAllowance: 0.25 }),
    );
    const inHole = (p: Vec3): boolean => p[0] > 25 && p[0] < 75 && p[1] > 15 && p[1] < 45;
    const order = passes(toolpath).map((p) => {
      const cut = cutMoves(toolpath, p);
      const hole = cut.every(({ move }) => inHole(move.to));
      expect(hole || cut.every(({ move }) => !inHole(move.to))).toBe(true);
      const offset = Math.min(
        ...cut.map(({ move }) => distToLoops([move.to[0], move.to[1]], loops)),
      );
      return `${hole ? 'hole' : 'outline'}:${offset < 3.1 ? 'finish' : 'rough'}`;
    });
    expect(order).toEqual([
      ...Array<string>(5).fill('hole:rough'),
      'hole:finish',
      ...Array<string>(5).fill('outline:rough'),
      'outline:finish',
    ]);
  });

  describe('finishes in stepdown steps where the roughing could not reach', () => {
    const depth = { top: 0, bottom: -12.5 };
    const tool635 = { ...tool, diameter: 6.35, fluteLength: 22 };
    /** The distinct cut depths of each pass whose path runs at the tool radius (finishing). */
    function finishLevels(tp: Toolpath, loops: readonly Loop2[]): number[][] {
      return passes(tp)
        .filter((p) => deviation(tp, p, loops, 6.35 / 2) < 0.003)
        .map((p) => [...new Set(cutMoves(tp, p).map(({ move }) => round(move.to[2])))]);
    }

    it('an inside cut whose roughing splits at a neck', async () => {
      const loops = [dumbbell(7)];
      const result = await run(
        profile({ side: 'inside', loops, tool: tool635, depth, stepdown: 3, finishAllowance: 0.5 }),
      );
      expect(result.warnings?.map((w) => w.code)).toEqual(['finish-steps-down']);
      // Two roughed lobes, then the one finishing loop through the neck, stepping down.
      expect(passes(result.toolpath)).toHaveLength(15);
      expect(finishLevels(result.toolpath, loops)).toEqual([[-2.5], [-5], [-7.5], [-10], [-12.5]]);
    });

    it('an outside cut whose roughing merges across a narrow gap', async () => {
      const loops = [rect(0, 0, 50, 50), rect(56.6, 0, 50, 50)];
      const result = await run(
        profile({ loops, tool: tool635, depth, stepdown: 3, finishAllowance: 0.25 }),
      );
      expect(result.warnings?.map((w) => w.code)).toEqual(['finish-steps-down']);
      // One merged roughing loop, then each part's finishing loop in steps.
      expect(passes(result.toolpath)).toHaveLength(15);
      const levels = finishLevels(result.toolpath, loops);
      expect(levels).toHaveLength(10);
      for (const [i, l] of levels.entries()) expect(l).toEqual([-2.5 * ((i % 5) + 1)]);
    });

    it('but not for a plain rectangle or the corners of a hole', async () => {
      const loops = [rect(0, 0, 100, 60), hole(rect(4, 4, 20, 20))];
      const result = await run(
        profile({ loops, tool: tool635, depth, stepdown: 3, finishAllowance: 0.25 }),
      );
      expect(result.warnings).toBeUndefined();
      expect(finishLevels(result.toolpath, loops)).toEqual([[-12.5], [-12.5]]);
    });
  });

  it('roughs with an allowance, then finishes the wall in one full-depth pass', async () => {
    const loop = rect(0, 0, 60, 40);
    const { toolpath } = await run(
      profile({ loops: [loop], depth: { top: 0, bottom: -9 }, stepdown: 3, finishAllowance: 0.5 }),
    );
    expect(passes(toolpath)).toEqual([0, 1, 2, 3]);
    for (const p of [0, 1, 2]) expect(deviation(toolpath, p, [loop], 3.5)).toBeLessThan(1e-9);
    expect(deviation(toolpath, 3, [loop], 3)).toBeLessThan(1e-9);
    const finishZ = new Set(cutMoves(toolpath, 3).map(({ move }) => move.to[2]));
    expect([...finishZ]).toEqual([-9]);
    // The finishing pass feeds down from above the stock, not by rapid into the slot.
    const plunge = withStarts(toolpath).find(
      ({ move }) => move.pass === 3 && move.kind === 'linear' && move.feedClass === 'plunge',
    )!;
    expect(plunge.from[2]).toBe(0.5);
  });

  it('finishes in steps when the depth is beyond the flutes, and warns', async () => {
    const result = await run(
      profile({
        tool: { ...tool, fluteLength: 8 },
        depth: { top: 0, bottom: -12 },
        stepdown: 4,
        finishAllowance: 0.3,
      }),
    );
    expect(result.warnings?.map((w) => w.code)).toContain('depth-exceeds-flutes');
    expect(passes(result.toolpath)).toHaveLength(6);
  });

  it('leaves the allowance without a finishing pass when asked', async () => {
    const { toolpath } = await run(profile({ finishAllowance: 0.5, finishPass: false }));
    expect(passes(toolpath)).toEqual([0]);
    expect(deviation(toolpath, 0, [rect(0, 0, 40, 20)], 3.5)).toBeLessThan(1e-9);
  });

  it('checkpoints before every pass and lets CamCancelled through', async () => {
    const counter = { count: 0 };
    const op = profile({ depth: { top: 0, bottom: -9 }, stepdown: 3, finishAllowance: 0.2 });
    const result = await generateProfile(op, context(counter));
    expect(result.ok).toBe(true);
    expect(counter.count).toBe(4);
    const cancelling: OperationContext = {
      ...context(),
      checkpoint: () => Promise.reject(new CamCancelled()),
    };
    await expect(generateProfile(op, cancelling)).rejects.toBeInstanceOf(CamCancelled);
  });
});

describe('profile operation: tabs', () => {
  /** Runs of consecutive moves at the tab height in one pass: [start, moves]. */
  function tabRuns(tp: Toolpath, pass: number, tabTop: number) {
    const runs: { from: Vec3; moves: Move[] }[] = [];
    let current: { from: Vec3; moves: Move[] } | undefined;
    for (const { from, move } of withStarts(tp)) {
      if (move.pass !== pass || move.kind === 'rapid') continue;
      const level = Math.abs(from[2] - tabTop) < 1e-9 && Math.abs(move.to[2] - tabTop) < 1e-9;
      const xy = Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9;
      if (level && xy) {
        current ??= { from, moves: [] };
        current.moves.push(move);
      } else if (current) {
        runs.push(current);
        current = undefined;
      }
    }
    if (current) runs.push(current);
    return runs;
  }

  const runLength = (run: { from: Vec3; moves: Move[] }): number => {
    let pos = run.from;
    let len = 0;
    for (const m of run.moves) {
      len += xyLength(pos, m);
      pos = m.to;
    }
    return len;
  };

  it('leaves tabs at the requested height and width, on straight sides, only in deep passes', async () => {
    const loop = rect(0, 0, 100, 60);
    const { toolpath, warnings } = await run(
      profile({
        loops: [loop],
        depth: { top: 0, bottom: -12 },
        stepdown: 4,
        tabs: { count: 4, width: 8, height: 3 },
      }),
    );
    expect(warnings).toBeUndefined();
    expect(tabRuns(toolpath, 0, -9)).toHaveLength(0);
    expect(tabRuns(toolpath, 1, -9)).toHaveLength(0);
    const runs = tabRuns(toolpath, 2, -9);
    expect(runs).toHaveLength(4);
    for (const r of runs) {
      // Tool centre path over the tab: the tab's width plus the tool diameter.
      expect(runLength(r)).toBeCloseTo(8 + 6, 9);
      expect(r.moves.every((m) => m.kind === 'linear')).toBe(true);
      // On one straight side, clear of the corners' round joins.
      const end = r.moves[r.moves.length - 1]!.to;
      const onBottomOrTop = Math.abs(r.from[1] - end[1]) < 1e-9;
      const along = onBottomOrTop ? [r.from[0], end[0]] : [r.from[1], end[1]];
      const limit = onBottomOrTop ? 100 : 60;
      for (const v of along) {
        expect(v).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect(v).toBeLessThanOrEqual(limit - 0.5 + 1e-9);
      }
    }
    // The cut rises vertically onto each tab and drops back to depth after it.
    const vertical = withStarts(toolpath).filter(
      ({ from, move }) =>
        move.pass === 2 &&
        move.kind === 'linear' &&
        Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) < 1e-12 &&
        from[2] !== move.to[2],
    );
    expect(vertical.filter(({ move }) => move.to[2] === -9)).toHaveLength(4);
    expect(
      vertical.filter(
        ({ move }) => move.kind === 'linear' && move.to[2] === -12 && move.feedClass === 'plunge',
      ),
    ).toHaveLength(5); // four after the tabs, one entry plunge
  });

  it('keeps tabs off arcs shorter than the tab and puts them on long arcs', async () => {
    const small = await run(
      profile({
        loops: [roundedRect(120, 80, 2)],
        depth: { top: 0, bottom: -6 },
        stepdown: 6,
        tabs: { count: 6, width: 8, height: 2 },
      }),
    );
    const runs = tabRuns(small.toolpath, 0, -4);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.moves.every((m) => m.kind === 'linear')).toBe(true);

    const disc = await run(
      profile({
        loops: [circle([0, 0], 40)],
        depth: { top: 0, bottom: -6 },
        stepdown: 6,
        tabs: { count: 3, width: 8, height: 2 },
      }),
    );
    const arcRuns = tabRuns(disc.toolpath, 0, -4);
    expect(arcRuns).toHaveLength(3);
    for (const r of arcRuns) {
      expect(r.moves.every((m) => m.kind === 'arc')).toBe(true);
      expect(runLength(r)).toBeCloseTo(14, 3);
    }
  });

  it('places tabs by spacing', async () => {
    const { toolpath } = await run(
      profile({
        loops: [rect(0, 0, 200, 100)],
        depth: { top: 0, bottom: -6 },
        stepdown: 6,
        tabs: { count: 0, width: 6, height: 2 },
        tabSpacing: 100,
      }),
    );
    // Length 600 + 2 pi 3: six tabs.
    expect(tabRuns(toolpath, 0, -4)).toHaveLength(6);
  });

  it('skips tabs on small inside loops and keeps them on large ones', async () => {
    const tabs = { count: 3, width: 6, height: 2 };
    const depth = { top: 0, bottom: -6 };
    const small = await run(
      profile({ loops: [circle([0, 0], 10)], side: 'inside', depth, stepdown: 6, tabs }),
    );
    expect(small.warnings?.map((w) => w.code)).toEqual(['tabs-skipped']);
    expect(tabRuns(small.toolpath, 0, -4)).toHaveLength(0);
    const large = await run(
      profile({ loops: [rect(0, 0, 100, 80)], side: 'inside', depth, stepdown: 6, tabs }),
    );
    expect(large.warnings).toBeUndefined();
    expect(tabRuns(large.toolpath, 0, -4)).toHaveLength(3);
  });

  it('carries tabs to the finishing pass at the same places', async () => {
    const { toolpath } = await run(
      profile({
        loops: [rect(0, 0, 100, 60)],
        depth: { top: 0, bottom: -6 },
        stepdown: 6,
        finishAllowance: 0.5,
        tabs: { count: 4, width: 8, height: 2 },
      }),
    );
    const rough = tabRuns(toolpath, 0, -4);
    const finish = tabRuns(toolpath, 1, -4);
    expect(rough).toHaveLength(4);
    expect(finish).toHaveLength(4);
    const centre = (r: { from: Vec3; moves: Move[] }): Vec2 => {
      const end = r.moves[r.moves.length - 1]!.to;
      return [(r.from[0] + end[0]) / 2, (r.from[1] + end[1]) / 2];
    };
    for (const f of finish) {
      const c = centre(f);
      const nearest = Math.min(
        ...rough.map((r) => Math.hypot(centre(r)[0] - c[0], centre(r)[1] - c[1])),
      );
      expect(nearest).toBeCloseTo(0.5, 6);
    }
  });

  it('warns when tabs are as high as the cut is deep', async () => {
    const { warnings } = await run(profile({ tabs: { count: 2, width: 5, height: 3 } }));
    expect(warnings?.map((w) => w.code)).toEqual(['tabs-unused']);
  });

  it('drops tabs that have no room', async () => {
    const { warnings, toolpath } = await run(
      profile({
        loops: [rect(0, 0, 20, 20)],
        depth: { top: 0, bottom: -6 },
        stepdown: 6,
        tabs: { count: 8, width: 10, height: 2 },
      }),
    );
    expect(warnings?.map((w) => w.code)).toEqual(['tabs-dropped']);
    expect(tabRuns(toolpath, 0, -4).length).toBeLessThan(8);
  });
});

describe('profile operation: leads and entries', () => {
  it('lead-in and lead-out arcs are tangent to the cut, on the scrap side', async () => {
    for (const climb of [false, true]) {
      const loop = rect(0, 0, 40, 20);
      const { toolpath } = await run(
        profile({
          climb,
          leadIn: { kind: 'arc', radius: 5 },
          leadOut: { kind: 'arc', radius: 5 },
        }),
      );
      const moves = withStarts(toolpath);
      const leads = moves.filter(({ move }) => move.kind === 'arc' && move.feedClass === 'lead');
      expect(leads).toHaveLength(2);
      const [into, outOf] = leads;
      const iIn = moves.indexOf(into!);
      const iOut = moves.indexOf(outOf!);
      const firstCut = moves[iIn + 1]!;
      const lastCut = moves[iOut - 1]!;
      expect(firstCut.move.kind !== 'rapid' && firstCut.move.feedClass).toBe('cut');
      const tIn = tangent(into!.from, into!.move, 'end');
      const tCut = tangent(firstCut.from, firstCut.move, 'start');
      expect(tIn[0]).toBeCloseTo(tCut[0], 9);
      expect(tIn[1]).toBeCloseTo(tCut[1], 9);
      const tOut = tangent(outOf!.from, outOf!.move, 'start');
      const tLast = tangent(lastCut.from, lastCut.move, 'end');
      expect(tOut[0]).toBeCloseTo(tLast[0], 9);
      expect(tOut[1]).toBeCloseTo(tLast[1], 9);
      for (const lead of leads) {
        expect(radiusAbout((lead.move as ArcMove).center, lead.from)).toBeCloseTo(5, 9);
        for (const p of samplesOf(lead.from, lead.move)) {
          expect(distToLoops(p, [loop])).toBeGreaterThanOrEqual(3 - 1e-9);
          const inPart = p[0] > 0 && p[0] < 40 && p[1] > 0 && p[1] < 20;
          expect(inPart).toBe(false);
        }
      }
      // The plunge is at the lead-in's start, off the part.
      const plunge = moves.find(
        ({ move }) => move.kind === 'linear' && move.feedClass === 'plunge',
      )!;
      expect(roundVec(plunge.move.to.slice(0, 2))).toEqual(roundVec(into!.from.slice(0, 2)));
    }
  });

  it('line leads approach square to the wall from the scrap side', async () => {
    const { toolpath } = await run(
      profile({ side: 'inside', loops: [rect(0, 0, 60, 40)], leadIn: { kind: 'line', length: 4 } }),
    );
    const lead = withStarts(toolpath).find(
      ({ move }) => move.kind === 'linear' && move.feedClass === 'lead',
    )!;
    expect(roundVec(lead.from.slice(0, 2))).toEqual([30, 7]);
    expect(roundVec(lead.move.to.slice(0, 2))).toEqual([30, 3]);
  });

  it('drops a lead that would cut into the part, with a warning', async () => {
    const { toolpath, warnings } = await run(
      profile({ side: 'inside', loops: [circle([0, 0], 10)], leadIn: { kind: 'arc', radius: 20 } }),
    );
    expect(warnings?.map((w) => w.code)).toEqual(['lead-collision']);
    expect(
      toolpath.entries.some((e) => isMove(e) && e.kind !== 'rapid' && e.feedClass === 'lead'),
    ).toBe(false);
  });

  it('ramps along the path at the requested angle, then cuts a full lap at depth', async () => {
    const angle = (3 * Math.PI) / 180;
    const loop = roundedRect(80, 50, 8);
    const { toolpath, warnings } = await run(
      profile({
        loops: [loop],
        depth: { top: 0, bottom: -6 },
        stepdown: 3,
        entry: { kind: 'ramp', angle },
        leadIn: { kind: 'arc', radius: 3 },
        leadOut: { kind: 'arc', radius: 3 },
      }),
    );
    expect(warnings?.map((w) => w.code)).toEqual(['lead-in-ignored']);
    const moves = withStarts(toolpath);
    const ramps = moves.filter(({ move }) => move.kind !== 'rapid' && move.feedClass === 'ramp');
    expect(ramps.length).toBeGreaterThan(0);
    let dropped = 0;
    for (const { from, move } of ramps) {
      const pts = samplesOf(from, move, 64);
      const len = xyLength(from, move);
      const dz = from[2] - move.to[2];
      expect(dz).toBeGreaterThan(0);
      expect(dz / len).toBeLessThanOrEqual(Math.tan(angle) * (1 + 1e-6));
      dropped += dz;
      // Ramps run on the tool centre path.
      for (const p of pts) expect(Math.abs(distToLoops(p, [loop]) - 3)).toBeLessThan(1e-6);
    }
    expect(dropped).toBeCloseTo(6, 9);
    // No plunge goes below material already cut: the only plunges reach the level above.
    for (const { move } of moves) {
      if (move.kind === 'linear' && move.feedClass === 'plunge') {
        expect([0, -3]).toContain(round(move.to[2]));
      }
    }
    // A full lap at each depth: the level cut length is at least the path's length.
    const pathLength = 2 * (80 + 50 - 4 * 8) + 2 * Math.PI * 11;
    for (const p of [0, 1]) {
      let level = 0;
      for (const { from, move } of cutMoves(toolpath, p)) {
        if (Math.abs(from[2] - move.to[2]) > 1e-12) continue;
        level += xyLength(from, move);
      }
      expect(level).toBeGreaterThanOrEqual(pathLength - 1e-3);
    }
  });

  it('ramps over several laps of a short loop', async () => {
    const { toolpath } = await run(
      profile({
        loops: [circle([0, 0], 5)],
        depth: { top: 0, bottom: -3 },
        stepdown: 3,
        entry: { kind: 'ramp', angle: (2 * Math.PI) / 180 },
      }),
    );
    const ramps = toolpath.entries.filter(
      (e): e is ArcMove => e.kind === 'arc' && e.feedClass === 'ramp',
    );
    // 3 mm at 2 degrees is 86 mm of ramp; the path is 2 pi 8 = 50 mm long.
    expect(ramps.length).toBeGreaterThan(3);
  });

  it('enters by helix on the scrap side, at most the helix angle', async () => {
    const angle = (3 * Math.PI) / 180;
    const { toolpath, warnings } = await run(
      profile({
        loops: [rect(0, 0, 60, 40)],
        depth: { top: 0, bottom: -6 },
        stepdown: 3,
        entry: { kind: 'helix', angle, radius: 2 },
      }),
    );
    expect(warnings).toBeUndefined();
    const helix = withStarts(toolpath).filter(({ move }) => move.kind === 'arc' && move.fullCircle);
    const perTurn = 2 * Math.PI * 2 * Math.tan(angle);
    const turns = Math.ceil(3 / perTurn);
    expect(helix).toHaveLength(2 * turns);
    for (const { from, move } of helix) {
      const m = move as ArcMove;
      expect(m.feedClass).toBe('ramp');
      expect(from[2] - m.to[2]).toBeLessThanOrEqual(perTurn + 1e-9);
      expect(m.center[1]).toBeCloseTo(-5, 9); // below the cut at y = -3: the scrap side
    }
  });

  it('leaves the helix tangent to the cut', async () => {
    for (const climb of [false, true]) {
      const { toolpath } = await run(
        profile({ climb, entry: { kind: 'helix', angle: 0.05, radius: 2 } }),
      );
      const moves = withStarts(toolpath);
      let last = -1;
      moves.forEach(({ move }, i) => {
        if (move.kind === 'arc' && move.fullCircle) last = i;
      });
      const h = moves[last]!;
      const next = moves[last + 1]!;
      expect(next.move.kind !== 'rapid' && next.move.feedClass).toBe('cut');
      const a = tangent(h.from, h.move, 'end');
      const b = tangent(next.from, next.move, 'start');
      expect(a[0]).toBeCloseTo(b[0], 9);
      expect(a[1]).toBeCloseTo(b[1], 9);
    }
  });

  it('falls back to a plunge when the helix does not fit', async () => {
    const { toolpath, warnings } = await run(
      profile({
        side: 'inside',
        loops: [circle([0, 0], 8)],
        entry: { kind: 'helix', angle: 0.05, radius: 6 },
      }),
    );
    expect(warnings?.map((w) => w.code)).toEqual(['helix-fallback']);
    expect(toolpath.entries.some((e) => e.kind === 'arc' && e.fullCircle)).toBe(false);
  });
});

describe('profile operation: refusals and the worker', () => {
  it('refuses bad input as values', async () => {
    const bad: Partial<ProfileOperation>[] = [
      { loops: [] },
      { stepdown: 0 },
      { depth: { top: -3, bottom: 0 } },
      { tool: { ...tool, diameter: 0 } },
      { finishAllowance: -1 },
      { tabs: { count: 1.5, width: 5, height: 1 } },
      { entry: { kind: 'ramp', angle: 0 } },
      { entry: { kind: 'helix', angle: 0.1, radius: 0 } },
      { leadIn: { kind: 'arc', radius: -1 } },
      { feeds: { ...feeds, cut: 0 } },
      { side: 'inside', loops: [circle([0, 0], 2)] },
      { side: 'on', loops: [{ segments: [] }] },
    ];
    for (const over of bad) {
      const result = await generateProfile(profile(over), context());
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-input');
    }
  });

  it('warns about holes of an outside profile too small for the tool', async () => {
    const { warnings, toolpath } = await run(
      profile({ loops: [rect(0, 0, 100, 60), hole(circle([50, 30], 2.5))] }),
    );
    expect(warnings?.map((w) => w.code)).toEqual(['loop-too-small']);
    expect(warnings?.[0]?.message).toMatch(/^Hole 1 /);
    expect(passes(toolpath)).toEqual([0]);
  });

  it('warns about a tab spacing with no tabs', async () => {
    const { warnings } = await run(profile({ tabSpacing: 50 }));
    expect(warnings?.map((w) => w.code)).toEqual(['tab-spacing-unused']);
  });

  it('warns about inside loops too small for the tool', async () => {
    const { warnings } = await run(
      profile({ side: 'inside', loops: [rect(0, 0, 60, 40), circle([100, 0], 2)] }),
    );
    expect(warnings?.map((w) => w.code)).toEqual(['loop-too-small']);
  });

  it('runs through the worker as a built-in operation', async () => {
    const operations = registerBuiltinOperations(new OperationRegistry());
    expect(operations.has('profile')).toBe(true);
    const api = createCamWorkerApi({ operations });
    const op: ProfileInput = profile({
      loops: [roundedRect(300, 150, 10)],
      depth: { top: 0, bottom: -12.5 },
      stepdown: 3,
      finishAllowance: 0.25,
      tabs: { count: 6, width: 8, height: 3 },
      leadIn: { kind: 'arc', radius: 4 },
      leadOut: { kind: 'arc', radius: 4 },
      climb: true,
    });
    const reply = await api.generate({ generation: 1, setup: { ...setup, operations: [op] } });
    expect(reply.status).toBe('done');
    if (reply.status !== 'done') return;
    expect(reply.operations[0]).toMatchObject({ id: 'profile#1', ok: true });
  });
});

describe('profile operation: the plywood sign outline', () => {
  it('cuts a 300 x 150 sign out of 12 mm plywood with tabs, a finish pass and leads', async () => {
    const loop = roundedRect(300, 150, 10);
    const { toolpath, warnings } = await run(
      profile({
        tool: { ...tool, diameter: 6.35, fluteLength: 22 },
        loops: [loop],
        depth: { top: 0, bottom: -12.5 },
        stepdown: 3,
        finishAllowance: 0.25,
        tabs: { count: 6, width: 8, height: 3 },
        leadIn: { kind: 'arc', radius: 4 },
        leadOut: { kind: 'arc', radius: 4 },
        climb: true,
      }),
    );
    // The 4 mm finishing leads would leave the 0.25 mm band the roughing cleared to full depth.
    expect(warnings?.map((w) => w.code)).toEqual(['finish-lead-dropped']);
    expect(passes(toolpath)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Math.sign(loopArea(loop))).toBe(1);
    expect(Math.sign(passArea(toolpath, 5))).toBe(-1); // climb outside: clockwise
    const lowest = Math.min(...toolpath.entries.filter(isMove).map((m) => m.to[2]));
    expect(lowest).toBe(-12.5);
    // The roughing passes keep their leads.
    const roughLeads = toolpath.entries.filter(
      (e) => isMove(e) && e.kind !== 'rapid' && e.pass === 0 && e.feedClass === 'lead',
    );
    expect(roughLeads).toHaveLength(2);
    // No finishing feed below the stock's top has its tool centre beyond the roughed slot: the
    // finishing tool never meets stock that the roughing did not clear to full depth.
    const band = 6.35 / 2 + 0.25;
    let below = 0;
    for (const { from, move } of withStarts(toolpath)) {
      if (move.kind === 'rapid' || move.pass !== 5) continue;
      if (Math.min(from[2], move.to[2]) >= 0) continue;
      below++;
      for (const p of samplesOf(from, move)) {
        expect(distToLoops(p, [loop])).toBeLessThanOrEqual(band + 1e-6);
      }
    }
    expect(below).toBeGreaterThan(10);
  });
});
