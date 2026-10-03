import { describe, expect, it } from 'vitest';
import type { IrEntry, Toolpath } from './ir';
import { isMove } from './ir';
import {
  JOB_LINK_OP,
  JOB_SAFE_ABOVE,
  JOB_SPINDLE_DWELL,
  assembleJob,
  cyclePieces,
  jobOperations,
  orderPieces,
  stockTopZ,
  type JobOperation,
  type JobOptions,
  type JobSetup,
} from './job';
import { rect, circle } from './offset/test-shapes';
import { generateDrill, type DrillOperation } from './ops/drill';
import { generateFacing, type FacingOperation } from './ops/facing';
import { generatePocket, type PocketOperation } from './ops/pocket';
import { generateProfile, type ProfileOperation } from './ops/profile';
import { postCarbideMotion } from './post/carbide-motion';
import { postGrbl } from './post/grbl';
import { toolpathStats } from './stats';
import { movesWithStarts, rapidCollisions, seededRandom } from './test-helpers';
import type { MachineDrillPoint, OperationInput, Setup, Tool, Vec2, Vec3 } from './types';
import { validateToolpath } from './validate';
import type { CamOperationResult } from './worker/api';
import { packToolpath } from './worker/pack';
import type { OperationContext } from './worker/registry';

const flat6: Tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  number: 1,
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const flat3: Tool = {
  id: 'tool#2',
  name: '3 mm flat',
  kind: 'flat',
  number: 2,
  diameter: 3,
  fluteLength: 15,
  flutes: 2,
};
const drill3: Tool = {
  id: 'tool#3',
  name: '3 mm drill',
  kind: 'drill',
  number: 3,
  diameter: 3,
  fluteLength: 30,
  flutes: 2,
  angle: (118 * Math.PI) / 180,
};
const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500, lead: 800 };

function makeSetup(over: Partial<Setup> = {}): Setup {
  return {
    id: 'setup#1',
    name: 'Top',
    stock: { min: [0, 0, -12], max: [200, 150, 0] },
    wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
    frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
    heights: { clearance: 10, retract: 3 },
    machine: 'shapeoko-5-pro-4x4',
    post: 'grbl',
    operations: [],
    ...over,
  };
}

function context(setup: Setup): OperationContext {
  return { generation: 1, cancelled: false, setup, checkpoint: () => Promise.resolve() };
}

const hole = (at: Vec2, diameter = 3, bottom = -6): MachineDrillPoint => ({
  at,
  depth: { top: 0, bottom },
  diameter,
});

function profileOp(over: Partial<ProfileOperation> = {}): ProfileOperation {
  return {
    kind: 'profile',
    id: 'profile#1',
    name: 'Outline',
    tool: flat6,
    feeds,
    loops: [rect(20, 20, 60, 40)],
    side: 'outside',
    depth: { top: 0, bottom: -6 },
    stepdown: 3,
    finishAllowance: 0,
    entry: { kind: 'plunge' },
    leadIn: { kind: 'none' },
    leadOut: { kind: 'none' },
    climb: true,
    ...over,
  };
}

function pocketOp(over: Partial<PocketOperation> = {}): PocketOperation {
  return {
    kind: 'pocket',
    id: 'pocket#1',
    name: 'Recess',
    tool: flat6,
    feeds,
    loops: [rect(120, 30, 40, 30)],
    depth: { top: 0, bottom: -4 },
    stepdown: 2,
    stepover: 0.5,
    finishAllowance: 0,
    entry: { kind: 'helix', angle: (3 * Math.PI) / 180, radius: 2 },
    climb: true,
    ...over,
  };
}

function facingOp(over: Partial<FacingOperation> = {}): FacingOperation {
  return {
    kind: 'facing',
    id: 'facing#1',
    name: 'Face',
    tool: flat6,
    feeds,
    loops: [rect(0, 0, 200, 150)],
    depth: { top: 0, bottom: -0.5 },
    stepdown: 0.5,
    stepover: 0.6,
    angle: 0,
    ...over,
  };
}

function drillOp(over: Partial<DrillOperation> = {}): DrillOperation {
  return {
    kind: 'drill',
    id: 'drill#1',
    name: 'Holes',
    tool: drill3,
    feeds: { ...feeds, spindle: 12000 },
    points: [hole([10, 10]), hole([190, 140])],
    ...over,
  };
}

/** Generates `op` with the real generator and wraps it as a job operation. */
async function generated(op: OperationInput, setup: Setup): Promise<JobOperation> {
  const ctx = context(setup);
  const result =
    op.kind === 'profile'
      ? await generateProfile(op, ctx)
      : op.kind === 'pocket'
        ? await generatePocket(op, ctx)
        : op.kind === 'facing'
          ? await generateFacing(op, ctx)
          : op.kind === 'drill'
            ? await generateDrill(op, ctx)
            : undefined;
  if (!result) throw new Error(`no generator for ${op.kind} in this test`);
  return {
    id: op.id,
    name: op.name,
    tool: op.tool,
    feeds: op.feeds,
    result: result.ok
      ? {
          ok: true,
          toolpath: result.value.toolpath,
          ...(result.value.warnings ? { warnings: result.value.warnings } : {}),
        }
      : { ok: false, error: result.error },
  };
}

async function job(setup: Setup, ops: readonly OperationInput[], options: JobOptions = {}) {
  const jobOps = await Promise.all(ops.map((o) => generated(o, setup)));
  const r = assembleJob(setup, jobOps, options);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The stock in machine coordinates (the fixtures' frame is the identity, origin on top). */
const stockBox = (setup: Setup) => setup.stock;

/** Everything the acceptance tests demand of a whole job. */
function checkJob(setup: JobSetup & Pick<Setup, 'stock'>, tp: Toolpath, clearance: number): void {
  // The IR validator passes on the whole job.
  expect(validateToolpath(tp)).toEqual([]);
  // Starts and ends at the clearance height, spindle off at the end.
  expect(tp.start[2]).toBeGreaterThanOrEqual(clearance - 1e-9);
  const moves = tp.entries.filter(isMove);
  expect(moves.at(-1)!.to[2]).toBeGreaterThanOrEqual(clearance - 1e-9);
  expect(tp.entries.at(-1)).toMatchObject({ kind: 'spindle', state: 'off' });
  // Every tool change: at the clearance height with the spindle off, then spindle on and a dwell.
  let pos = tp.start;
  let spindleOn = false;
  tp.entries.forEach((e: IrEntry, i) => {
    if (isMove(e)) pos = e.to;
    if (e.kind === 'spindle') spindleOn = e.state !== 'off';
    if (e.kind === 'toolChange') {
      expect(pos[2]).toBeGreaterThanOrEqual(clearance - 1e-9);
      expect(spindleOn).toBe(false);
      expect(tp.entries[i + 1]).toMatchObject({ kind: 'spindle', state: 'cw' });
      expect(tp.entries[i + 2]).toMatchObject({ kind: 'dwell' });
    }
  });
  // The job's own sideways rapids all run above the stock top.
  const top = stockTopZ(setup);
  for (const { from, move } of movesWithStarts(tp)) {
    if (move.op !== JOB_LINK_OP) continue;
    const sideways = Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9;
    if (sideways) {
      expect(Math.min(from[2], move.to[2])).toBeGreaterThanOrEqual(top + JOB_SAFE_ABOVE - 1e-9);
    }
    // Down only to above the stock top.
    if (move.to[2] < from[2])
      expect(move.to[2]).toBeGreaterThanOrEqual(top + JOB_SAFE_ABOVE - 1e-9);
  }
  // No rapid below the material left: against the stock and a raster of what has been cut.
  expect(rapidCollisions(tp, stockBox(setup as Setup), { cell: 0.25 })).toEqual([]);
}

describe('job assembly: structure', () => {
  it('links a profile, a pocket and drilling into one valid program', async () => {
    const setup = makeSetup();
    const j = await job(setup, [profileOp(), pocketOp(), drillOp()], { rapidRate: 5000 });
    checkJob(setup, j.toolpath, 10);
    expect(j.operations.map((s) => s.op)).toEqual(['profile#1', 'pocket#1', 'drill#1']);
    expect(j.toolChanges).toEqual(['tool#1', 'tool#3']);
    // The first entries: tool change, spindle on with the operation's speed, the dwell.
    expect(j.toolpath.entries.slice(0, 3)).toEqual([
      {
        kind: 'toolChange',
        tool: 'tool#1',
        number: 1,
        name: '6 mm flat',
        diameter: 6,
        op: 'profile#1',
      },
      { kind: 'spindle', state: 'cw', rpm: 18000, op: 'profile#1' },
      { kind: 'dwell', seconds: JOB_SPINDLE_DWELL.value, op: 'profile#1' },
    ]);
    // The operator comment names the operation.
    expect(j.toolpath.entries).toContainEqual({ kind: 'comment', text: 'Recess', op: 'pocket#1' });
    // Statistics of the whole program.
    const stats = toolpathStats(j.toolpath, { rapidRate: 5000 });
    expect(stats.ok && stats.value).toEqual(j.stats);
    expect(j.stats!.toolChanges).toBe(2);
    // Spans cover each operation's entries, in order and without overlap.
    for (const [k, s] of j.operations.entries()) {
      if (k > 0) expect(s.from).toBeGreaterThanOrEqual(j.operations[k - 1]!.to);
      const ops = new Set(j.toolpath.entries.slice(s.from, s.to).map((e) => e.op));
      ops.delete(JOB_LINK_OP);
      expect([...ops]).toEqual([s.op]);
    }
  });

  it('changes the spindle speed (with a dwell) when the same tool runs at another speed', async () => {
    const setup = makeSetup();
    const j = await job(setup, [profileOp(), pocketOp({ feeds: { ...feeds, spindle: 16000 } })]);
    checkJob(setup, j.toolpath, 10);
    expect(j.toolChanges).toEqual(['tool#1']);
    const spindles = j.toolpath.entries.filter((e) => e.kind === 'spindle');
    expect(spindles.map((e) => (e.state === 'off' ? 'off' : e.rpm))).toEqual([18000, 16000, 'off']);
    const at = j.toolpath.entries.findIndex((e) => e.kind === 'spindle' && e.op === 'pocket#1');
    expect(j.toolpath.entries[at + 1]).toMatchObject({ kind: 'dwell' });
  });

  it('keeps the user order, or groups by tool stably', async () => {
    const setup = makeSetup();
    const ops = [
      drillOp({ id: 'drill#1' }),
      profileOp(),
      drillOp({ id: 'drill#2', points: [hole([100, 140])] }),
      pocketOp(),
    ];
    const user = await job(setup, ops);
    expect(user.operations.map((s) => s.op)).toEqual([
      'drill#1',
      'profile#1',
      'drill#2',
      'pocket#1',
    ]);
    expect(user.toolChanges).toEqual(['tool#3', 'tool#1', 'tool#3', 'tool#1']);
    checkJob(setup, user.toolpath, 10);
    const grouped = await job(setup, ops, { groupByTool: true });
    expect(grouped.operations.map((s) => s.op)).toEqual([
      'drill#1',
      'drill#2',
      'profile#1',
      'pocket#1',
    ]);
    expect(grouped.toolChanges).toEqual(['tool#3', 'tool#1']);
    checkJob(setup, grouped.toolpath, 10);
  });

  it('leaves out suppressed operations, and fails on an operation with an error', async () => {
    const setup = makeSetup();
    const good = await generated(profileOp(), setup);
    const bad = await generated(
      pocketOp({ id: 'pocket#9', tool: { ...flat6, diameter: 60 } }),
      setup,
    );
    expect(bad.result.ok).toBe(false);
    const r = assembleJob(setup, [good, bad]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.failures.map((f) => f.op)).toEqual(['pocket#9']);
      expect(r.error.message).toContain('pocket#9');
    }
    const skipped = assembleJob(setup, [good, { ...bad, suppressed: true }]);
    expect(skipped.ok).toBe(true);
    if (skipped.ok) expect(skipped.value.operations.map((s) => s.op)).toEqual(['profile#1']);
    // Nothing left to cut is an error, not an empty program.
    expect(assembleJob(setup, [{ ...good, suppressed: true }]).ok).toBe(false);
    // A spindle speed of zero is the operation's error.
    const zero = assembleJob(setup, [{ ...good, feeds: { spindle: 0 } }]);
    expect(!zero.ok && zero.error.failures[0]!.op).toBe('profile#1');
  });

  it('refuses an operation that starts below the stock top', () => {
    const setup = makeSetup();
    const op: JobOperation = {
      id: 'profile#1',
      tool: flat6,
      feeds,
      result: {
        ok: true,
        toolpath: {
          start: [10, 10, -1],
          entries: [
            {
              kind: 'linear',
              to: [20, 10, -1],
              feed: 100,
              feedClass: 'cut',
              op: 'profile#1',
              pass: 0,
            },
          ],
        },
      },
    };
    const r = assembleJob(setup, [op]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.failures[0]!.op).toBe('profile#1');
  });

  it('crosses at the clearance height when the retract height is not above the stock top', async () => {
    const setup = makeSetup({ heights: { clearance: 8, retract: 0.2 } });
    const j = await job(setup, [
      drillOp({ points: [hole([10, 10]), hole([60, 10]), hole([30, 80]), hole([150, 20])] }),
    ]);
    checkJob(setup, j.toolpath, 8);
    expect(j.retract).toBe(8);
    for (const { from, move } of movesWithStarts(j.toolpath)) {
      if (move.op === JOB_LINK_OP && Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 0) {
        expect(move.to[2]).toBe(8);
      }
    }
  });

  it('raises a clearance below the stock top, with a warning', async () => {
    const setup = makeSetup({ heights: { clearance: -2, retract: -3 } });
    const j = await job(setup, [profileOp()]);
    expect(j.clearance).toBe(JOB_SAFE_ABOVE);
    expect(j.warnings.map((w) => w.code)).toContain('clearance-raised');
    checkJob(setup, j.toolpath, JOB_SAFE_ABOVE);
  });

  it('refuses an operation that rapids sideways below the stock top, and allows rapids straight down', () => {
    const setup = makeSetup();
    const op = 'pocket#1';
    const cut = (to: Vec3): IrEntry => ({
      kind: 'linear',
      to,
      feed: 300,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    const operation = (entries: IrEntry[]): JobOperation => ({
      id: op,
      tool: flat6,
      feeds,
      result: { ok: true, toolpath: { start: [10, 10, 5], entries } },
    });
    // Down by rapid to just above the stock top, fed in, then up by rapid: fine.
    const ok = assembleJob(setup, [
      operation([
        { kind: 'rapid', to: [10, 10, 0.5], op, pass: 0 },
        cut([10, 10, -2]),
        cut([40, 10, -2]),
        { kind: 'rapid', to: [40, 10, -1.5], op, pass: 0 },
        cut([40, 10, -4]),
        { kind: 'rapid', to: [40, 10, 5], op, pass: 0 },
      ]),
    ]);
    expect(ok.ok).toBe(true);
    // Sideways at Z -1.5, even over material the operation has cut: refused, naming the operation.
    const bad = assembleJob(setup, [
      operation([
        { kind: 'rapid', to: [10, 10, 0.5], op, pass: 0 },
        cut([10, 10, -2]),
        cut([40, 10, -2]),
        { kind: 'rapid', to: [40, 10, -1.5], op, pass: 0 },
        { kind: 'rapid', to: [10, 10, -1.5], op, pass: 0 },
        { kind: 'rapid', to: [10, 10, 5], op, pass: 0 },
      ]),
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.failures).toEqual([
        expect.objectContaining({ op, code: 'rapid-below-stock' }),
      ]);
      expect(bad.error.message).toContain('below the stock top');
    }
    // A sideways rapid that dives below the stock top on the way: refused too.
    const diving = assembleJob(setup, [
      operation([{ kind: 'rapid', to: [30, 10, -0.2], op, pass: 0 }, cut([30, 10, -2])]),
    ]);
    expect(diving.ok).toBe(false);
    // Across exactly at the stock top: allowed (nothing is above it to hit).
    const level = assembleJob(setup, [
      operation([
        { kind: 'rapid', to: [10, 10, 0], op, pass: 0 },
        { kind: 'rapid', to: [30, 10, 0], op, pass: 0 },
        cut([30, 10, -2]),
      ]),
    ]);
    expect(level.ok).toBe(true);
  });

  it('assembles a bottom-origin job with a top margin, rapids all above the stock top', async () => {
    // Stock 19 mm thick (an 18 mm part and a 1 mm top margin), origin on the bottom: the stock
    // top is Z 19; a retract of 5 is far below it.
    const setup = makeSetup({
      stock: { min: [0, 0, 0], max: [200, 150, 19] },
      wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'bottom' } },
      heights: { clearance: 30, retract: 5 },
    });
    expect(stockTopZ(setup)).toBe(19);
    const j = await job(setup, [
      facingOp({ depth: { top: 19, bottom: 18 }, stepdown: 0.5, pattern: 'oneway' }),
      // The part's top, not the stock's: what the review measured rapiding at Z 18.5.
      pocketOp({ depth: { top: 18, bottom: 14 } }),
      profileOp({
        depth: { top: 18, bottom: 12 },
        loops: [rect(20, 20, 60, 40), rect(20, 80, 40, 40)],
      }),
      drillOp({
        points: [
          { at: [10, 10], depth: { top: 19, bottom: 13 }, diameter: 3 },
          { at: [190, 140], depth: { top: 19, bottom: 13 }, diameter: 3 },
        ],
      }),
    ]);
    checkJob(setup, j.toolpath, 30);
    for (const { from, move } of movesWithStarts(j.toolpath)) {
      if (move.kind !== 'rapid') continue;
      if (Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9) {
        expect(Math.min(from[2], move.to[2])).toBeGreaterThanOrEqual(19.5 - 1e-9);
      }
    }
  });

  it("passes the operations' warnings through, tagged with their ids", async () => {
    const setup = makeSetup();
    const j = await job(setup, [profileOp({ tool: { ...flat6, fluteLength: 2 } })]);
    expect(j.warnings).toContainEqual(
      expect.objectContaining({ op: 'profile#1', code: 'depth-exceeds-flutes' }),
    );
  });
});

describe('job assembly: independent pieces', () => {
  it('splits canned-cycle drilling into holes, and leaves bores alone', async () => {
    const setup = makeSetup();
    const straight = await generateDrill(
      drillOp({ points: [hole([10, 10]), hole([40, 10]), hole([70, 10])], peck: 2 }),
      context(setup),
    );
    if (!straight.ok) throw new Error(straight.error.message);
    const split = cyclePieces(straight.value.toolpath)!;
    expect(split.pieces).toHaveLength(3);
    for (const p of split.pieces) {
      expect(p.entries[0]!.kind).toBe('cycle');
      expect(p.entries.at(-1)!.kind).toBe('cycleEnd');
    }
    const bored = await generateDrill(
      drillOp({ tool: flat3, points: [hole([10, 10], 8), hole([40, 10], 8)] }),
      context(setup),
    );
    if (!bored.ok) throw new Error(bored.error.message);
    expect(cyclePieces(bored.value.toolpath)).toBeUndefined();
  });

  it('never orders pieces longer than they came', () => {
    const random = seededRandom(7);
    for (let n = 0; n < 200; n++) {
      const pieces = Array.from({ length: 2 + Math.floor(random() * 8) }, () => {
        const a: Vec3 = [random() * 100, random() * 100, 3];
        const b: Vec3 = [a[0] + random() * 20, a[1] + random() * 20, 3];
        return { start: a, entries: [], end: b };
      });
      const from: Vec3 = [random() * 100, random() * 100, 10];
      const len = (ps: typeof pieces) => {
        let cur = from;
        let total = 0;
        for (const p of ps) {
          total += Math.hypot(p.start[0] - cur[0], p.start[1] - cur[1]);
          cur = p.end;
        }
        return total;
      };
      const ordered = orderPieces(from, pieces);
      expect(new Set(ordered)).toEqual(new Set(pieces));
      expect(len(ordered)).toBeLessThanOrEqual(len(pieces) + 1e-9);
    }
  });

  it('reorders explicit pieces an operation hands over, and links them safely', () => {
    const setup = makeSetup();
    // Three short slots 2 mm deep, handed over far-near-middle from the origin.
    const slotAt = (x: number, k: number): Toolpath => ({
      start: [x, 50, 3],
      entries: [
        {
          kind: 'linear',
          to: [x, 50, -2],
          feed: 300,
          feedClass: 'plunge',
          op: 'profile#1',
          pass: k,
        },
        {
          kind: 'linear',
          to: [x + 10, 50, -2],
          feed: 1000,
          feedClass: 'cut',
          op: 'profile#1',
          pass: k,
        },
      ],
    });
    const op: JobOperation = {
      id: 'profile#1',
      tool: flat6,
      feeds,
      result: {
        ok: true,
        toolpath: { start: [0, 0, 10], entries: [] },
        pieces: [slotAt(150, 0), slotAt(10, 1), slotAt(80, 2)],
      },
    };
    const r = assembleJob(setup, [op]);
    if (!r.ok) throw new Error(r.error.message);
    const plunges = r.value.toolpath.entries.filter(
      (e) => e.kind === 'linear' && e.feedClass === 'plunge',
    );
    expect(plunges.map((e) => (e as { to: Vec3 }).to[0])).toEqual([10, 80, 150]);
    checkJob(setup, r.value.toolpath, 10);
    // Between pieces of one operation the tool crosses at the retract height.
    const crossings = movesWithStarts(r.value.toolpath).filter(
      ({ from, move }) => move.op === JOB_LINK_OP && Math.abs(move.to[0] - from[0]) > 1,
    );
    expect(crossings.map(({ move }) => move.to[2])).toEqual([10, 3, 3]);
  });

  it('cuts the rapid length against the naive order on a fixture job', async () => {
    const setup = makeSetup();
    // The user's order: holes near the front, an outline at the back right with another tool,
    // then a row of holes along the back. The drill operation orders its holes from the WCS
    // origin, wherever the tool comes from, and the user's order changes tools twice.
    const row = (y: number, xs: readonly number[]) => xs.map((x) => hole([x, y]));
    const ops = [
      drillOp({ id: 'drill#1', points: row(20, [10, 40, 70]) }),
      profileOp({ loops: [rect(140, 70, 40, 40)] }),
      drillOp({ id: 'drill#2', points: row(135, [10, 40, 70, 100, 130, 160, 190]) }),
    ];
    const naive = await job(setup, ops, { groupByTool: false, reorder: false, rapidRate: 5000 });
    const linked = await job(setup, ops, { groupByTool: true, reorder: true, rapidRate: 5000 });
    checkJob(setup, naive.toolpath, 10);
    checkJob(setup, linked.toolpath, 10);
    expect(linked.stats!.cutLength).toBeCloseTo(naive.stats!.cutLength, 6);
    expect(linked.stats!.toolChanges).toBeLessThan(naive.stats!.toolChanges);
    // Measured: naive 637 mm, grouped and reordered 605 mm, reordered alone 572 mm (the back
    // row runs from the end nearer the outline).
    expect(linked.stats!.rapidLength).toBeLessThan(naive.stats!.rapidLength);
    const reordered = await job(setup, ops, { reorder: true, rapidRate: 5000 });
    checkJob(setup, reordered.toolpath, 10);
    expect(reordered.stats!.rapidLength).toBeLessThan(naive.stats!.rapidLength * 0.92);
  });
});

describe('job assembly: no rapid into material (randomised fixtures)', () => {
  it('the material check itself catches a rapid through stock and allows one in a cut', () => {
    const op = 'profile#1';
    const cut = (to: Vec3): IrEntry => ({
      kind: 'linear',
      to,
      feed: 500,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    const head: IrEntry[] = [
      { kind: 'toolChange', tool: 'tool#1', name: '6 mm', diameter: 6, op },
      { kind: 'spindle', state: 'cw', rpm: 18000, op },
      cut([10, 10, -2]),
      cut([50, 10, -2]),
    ];
    const box = { min: [0, 0, -12], max: [100, 60, 0] } as const;
    const back: IrEntry = { kind: 'rapid', to: [10, 10, -1.5], op, pass: 0 };
    expect(rapidCollisions({ start: [10, 10, 5], entries: [...head, back] }, box)).toEqual([]);
    const across: IrEntry = { kind: 'rapid', to: [50, 40, -1], op, pass: 0 };
    const hit = rapidCollisions({ start: [10, 10, 5], entries: [...head, across] }, box);
    expect(hit[0]!.depth).toBeGreaterThan(1);
    // Down onto the stock top from above is a plunge by rapid.
    const down: IrEntry = { kind: 'rapid', to: [80, 40, -0.5], op, pass: 0 };
    expect(rapidCollisions({ start: [80, 40, 5], entries: [...head, down] }, box)).not.toEqual([]);
  });

  /** A random job on a random stock: profiles, pockets, facings and drilling, any tools. */
  function randomJob(seed: number): { setup: Setup; ops: OperationInput[]; options: JobOptions } {
    const random = seededRandom(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    const W = 80 + Math.round(random() * 80);
    const H = 60 + Math.round(random() * 60);
    const T = 6 + Math.round(random() * 8);
    const retract = pick([-1, 0.2, 1, 3, 5]);
    const clearance = Math.max(retract, pick([0.3, 4, 10, 15]));
    const setup = makeSetup({
      stock: { min: [0, 0, -T], max: [W, H, 0] },
      heights: { clearance, retract },
    });
    const box = (): [number, number, number, number] => {
      const w = 15 + random() * (W / 2 - 15);
      const h = 15 + random() * (H / 2 - 15);
      return [5 + random() * (W - w - 10), 5 + random() * (H - h - 10), w, h];
    };
    const ops: OperationInput[] = [];
    const n = 2 + Math.floor(random() * 4);
    for (let k = 0; k < n; k++) {
      const tool = pick([flat6, flat3]);
      const kind = pick(['profile', 'pocket', 'facing', 'drill', 'drill', 'profile'] as const);
      const id = `${kind}#${k + 1}`;
      const depth = -(1 + random() * (T - 1));
      if (kind === 'profile') {
        const [x, y, w, h] = box();
        ops.push(
          profileOp({
            id,
            tool,
            loops: [
              random() < 0.3
                ? circle([x + w / 2, y + h / 2], Math.min(w, h) / 2)
                : rect(x, y, w, h),
            ],
            side: pick(['outside', 'inside', 'on'] as const),
            depth: { top: 0, bottom: random() < 0.3 ? -T - 0.5 : depth },
            stepdown: 1 + random() * 3,
            entry: pick([
              { kind: 'plunge' },
              { kind: 'ramp', angle: (5 * Math.PI) / 180 },
              { kind: 'helix', angle: (3 * Math.PI) / 180, radius: 1.5 },
            ] as const),
            ...(random() < 0.4 ? { tabs: { count: 3, width: 4, height: 1 } } : {}),
            climb: random() < 0.5,
          }),
        );
      } else if (kind === 'pocket') {
        const [x, y, w, h] = box();
        ops.push(
          pocketOp({
            id,
            tool,
            loops: [rect(x, y, w, h)],
            depth: { top: 0, bottom: Math.max(depth, -4) },
            stepdown: 1 + random() * 2,
            stepover: 0.4 + random() * 0.3,
          }),
        );
      } else if (kind === 'facing') {
        ops.push(
          facingOp({
            id,
            tool,
            loops: [rect(0, 0, W, H)],
            depth: { top: 0, bottom: -0.2 - random() * 0.6 },
            stepdown: 0.5,
            stepover: 0.5 + random() * 0.3,
            angle: random() * Math.PI,
          }),
        );
      } else {
        // Straight, peck, and bored holes (a 3 mm flat in 5 mm holes).
        const bore = tool === flat3 && random() < 0.5;
        const count = 2 + Math.floor(random() * 6);
        ops.push(
          drillOp({
            id,
            tool: bore ? flat3 : drill3,
            points: Array.from({ length: count }, () =>
              hole(
                [6 + random() * (W - 12), 6 + random() * (H - 12)],
                bore ? 5 : 3,
                random() < 0.3 ? -T : depth,
              ),
            ),
            ...(random() < 0.5 ? { peck: 1 + random() * 2 } : {}),
          }),
        );
      }
    }
    return { setup, ops, options: { groupByTool: random() < 0.5, reorder: random() < 0.8 } };
  }

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: valid, retracts before tool changes, no rapid into material`, async () => {
      const { setup, ops, options } = randomJob(seed);
      const jobOps = await Promise.all(ops.map((o) => generated(o, setup)));
      // An operation the random numbers made impossible fails the job; leave it out to go on.
      const failing = jobOps.filter((o) => !o.result.ok);
      const r0 = assembleJob(setup, jobOps, options);
      expect(r0.ok).toBe(failing.length === 0);
      const r = assembleJob(
        setup,
        jobOps.map((o) => (o.result.ok ? o : { ...o, suppressed: true })),
        options,
      );
      if (!r.ok) {
        // Every operation failed: only possible when nothing is left.
        expect(failing.length).toBe(jobOps.length);
        return;
      }
      checkJob(setup, r.value.toolpath, Math.max(setup.heights.clearance, JOB_SAFE_ABOVE));
    }, 30000);
  }
});

describe('job assembly: worker results and posts', () => {
  it('assembles from the worker results, naming an operation not generated', async () => {
    const setup = makeSetup();
    const profile = profileOp();
    const drill = drillOp();
    const g = await generateProfile(profile, context(setup));
    if (!g.ok) throw new Error(g.error.message);
    const results: CamOperationResult[] = [
      {
        id: profile.id,
        kind: 'profile',
        key: 'k1',
        cached: false,
        ms: 0,
        ok: true,
        toolpath: packToolpath(g.value.toolpath),
        warnings: [],
      },
    ];
    const withSetup = { ...setup, operations: [profile, drill] };
    const missing = assembleJob(setup, jobOperations(withSetup, results));
    expect(!missing.ok && missing.error.failures).toEqual([
      expect.objectContaining({ op: 'drill#1', code: 'not-generated' }),
    ]);
    const r = assembleJob(setup, jobOperations(withSetup, results, ['drill#1']));
    if (!r.ok) throw new Error(r.error.message);
    checkJob(setup, r.value.toolpath, 10);
  });

  it('keeps a V-carve clearing ahead of its V-carve when grouping by tool', async () => {
    const setup = makeSetup();
    // The "V-bit" (flat3 here) cuts an outline first, then the clearing (flat6) and its carve.
    const early = await generated(profileOp({ tool: flat3 }), setup);
    const clearing: JobOperation = {
      ...(await generated(pocketOp(), setup)),
      before: 'profile#2',
    };
    const carve = await generated(
      profileOp({ id: 'profile#2', tool: flat3, loops: [rect(130, 40, 20, 10)] }),
      setup,
    );
    const grouped = assembleJob(setup, [early, clearing, carve], { groupByTool: true });
    if (!grouped.ok) throw new Error(grouped.error.message);
    expect(grouped.value.operations.map((s) => s.op)).toEqual([
      'profile#1',
      'pocket#1',
      'profile#2',
    ]);
    expect(grouped.value.toolChanges).toEqual(['tool#2', 'tool#1', 'tool#2']);
    checkJob(setup, grouped.value.toolpath, 10);
    // When grouping keeps the order anyway, nothing moves and no tool change is added.
    const later = await generated(
      pocketOp({ id: 'pocket#2', loops: [rect(10, 100, 30, 30)] }),
      setup,
    );
    const kept = assembleJob(setup, [clearing, carve, later], { groupByTool: true });
    if (!kept.ok) throw new Error(kept.error.message);
    expect(kept.value.operations.map((s) => s.op)).toEqual(['pocket#1', 'pocket#2', 'profile#2']);
    // `jobOperations` marks a clearing to run before its carve.
    const vcarveClearing = {
      kind: 'vcarveClearing',
      id: 'vcarve#1/clearing',
      name: 'Sign (clearing)',
      tool: flat6,
      feeds,
      carve: { kind: 'vcarve', id: 'vcarve#1' },
      stepdown: 1,
      stepover: 0.4,
    } as unknown as OperationInput;
    const [marked] = jobOperations({ operations: [vcarveClearing] }, []);
    expect(marked!.before).toBe('vcarve#1');
    expect(jobOperations({ operations: [profileOp()] }, [])[0]!.before).toBeUndefined();
  });

  it('assembles and posts an operation of 300,000 entries (no spread past the call stack)', () => {
    const setup = makeSetup();
    const id = 'surface3d#1';
    const n = 300_000;
    // A raster at Z -1 over the stock, as a fine 3D finish would emit.
    const entries: IrEntry[] = [
      { kind: 'rapid', to: [10, 10, 3], op: id, pass: 0 },
      { kind: 'linear', to: [10, 10, -1], feed: 300, feedClass: 'plunge', op: id, pass: 0 },
    ];
    for (let i = 1; i < n - 2; i++) {
      const x = 10 + (i % 1000) * 0.1;
      const y = 10 + Math.floor(i / 1000) * 0.4;
      entries.push({
        kind: 'linear',
        to: [x, y, -1],
        feed: 1000,
        feedClass: 'cut',
        op: id,
        pass: 0,
      });
    }
    const last = entries.at(-1)!;
    if (last.kind !== 'linear') throw new Error('expected a linear move');
    entries.push({ kind: 'rapid', to: [last.to[0], last.to[1], 10], op: id, pass: 0 });
    expect(entries.length).toBe(n);
    const op: JobOperation = {
      id,
      tool: flat6,
      feeds,
      result: { ok: true, toolpath: { start: [10, 10, 10], entries } },
    };
    const r = assembleJob(setup, [op]);
    if (!r.ok) throw new Error(r.error.message);
    const own = r.value.toolpath.entries.filter((e) => e.op === id && isMove(e));
    expect(own.length).toBe(entries.length);
    const grbl = postGrbl({
      toolpath: r.value.toolpath,
      job: 'Job test',
      setup: 'Top',
      date: '2026-10-02',
      heights: { clearance: r.value.clearance, retract: r.value.retract },
    });
    if (!grbl.ok) throw new Error(grbl.error.message);
    expect(grbl.value.files[0]!.lines.length).toBeGreaterThan(n - 10);
  });

  it('posts as one file per tool for Grbl and one file with M6 for Carbide Motion', async () => {
    const setup = makeSetup();
    const j = await job(setup, [profileOp(), drillOp()]);
    const postJob = {
      toolpath: j.toolpath,
      job: 'Job test',
      setup: 'Top',
      date: '2026-10-02',
      heights: { clearance: j.clearance, retract: j.retract },
    };
    const grbl = postGrbl(postJob);
    if (!grbl.ok) throw new Error(grbl.error.message);
    expect(grbl.value.files.map((f) => f.tools)).toEqual([['tool#1'], ['tool#3']]);
    // `test/job-gcode.test.ts` runs the G-code verifier on these files.
    const cm = postCarbideMotion(postJob);
    if (!cm.ok) throw new Error(cm.error.message);
    expect(cm.value.files).toHaveLength(1);
    expect(cm.value.files[0]!.text).toMatch(/M6 T3/);
  });
});
