// The move budget every operation's toolpath is held to: an untrusted document asking for a
// toolpath of millions of moves (each level under the per-entry caps) is refused cleanly, with no
// partial toolpath, and every valid toolpath comes out as before.

import { describe, expect, it } from 'vitest';
import { polygon, rect } from '../offset/test-shapes';
import type { CamResult, Setup, Tool, Vec2 } from '../types';
import type { GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  MoveBudgetExceeded,
  OPERATION_MAX_MOVES,
  operationMoveCap,
  tooManyMoves,
  withMoveBudget,
} from './budget';
import { DRILL_MAX_BORE_RINGS, generateDrill, type DrillOperation } from './drill';
import { ENTRY_MAX_TURNS, ENTRY_MAX_RAMP_MOVES, rampTooLong } from './entry';
import { generateFacing, type FacingOperation } from './facing';
import { generatePocket, type PocketOperation } from './pocket';
import { Emitter, PROFILE_MAX_TABS, generateProfile, type ProfileOperation } from './profile';
import { SURFACE3D_MAX_MOVES } from './surface3d';

const deg = (d: number) => (d * Math.PI) / 180;

const flat = (diameter: number): Tool => ({
  id: 'tool#1',
  name: `${diameter} mm flat`,
  kind: 'flat',
  diameter,
  fluteLength: 80,
  flutes: 2,
});
const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500, lead: 800 };

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [-50, -50, -70], max: [350, 250, 0] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};

function context(maxMoves?: number): OperationContext {
  return {
    generation: 1,
    cancelled: false,
    setup,
    checkpoint: () => Promise.resolve(),
    ...(maxMoves === undefined ? {} : { maxMoves }),
  };
}

const profile = (over: Partial<ProfileOperation> = {}): ProfileOperation => ({
  kind: 'profile',
  id: 'profile#1',
  name: 'Outline',
  tool: flat(6),
  feeds,
  loops: [rect(0, 0, 40, 20)],
  side: 'outside',
  depth: { top: 0, bottom: -6 },
  stepdown: 2,
  finishAllowance: 0,
  entry: { kind: 'ramp', angle: deg(3) },
  leadIn: { kind: 'none' },
  leadOut: { kind: 'none' },
  climb: true,
  ...over,
});

const pocket = (over: Partial<PocketOperation> = {}): PocketOperation => ({
  kind: 'pocket',
  id: 'pocket#1',
  name: 'Recess',
  tool: flat(6),
  feeds,
  loops: [rect(0, 0, 40, 20)],
  depth: { top: 0, bottom: -6 },
  stepdown: 3,
  stepover: 0.5,
  finishAllowance: 0,
  entry: { kind: 'helix', angle: deg(3), radius: 2 },
  climb: true,
  ...over,
});

const drill = (over: Partial<DrillOperation> = {}): DrillOperation => ({
  kind: 'drill',
  id: 'drill#1',
  name: 'Holes',
  tool: flat(3),
  feeds,
  points: [{ at: [10, 10], depth: { top: 0, bottom: -6 }, diameter: 12 }],
  ...over,
});

const facing = (over: Partial<FacingOperation> = {}): FacingOperation => ({
  kind: 'facing',
  id: 'facing#1',
  name: 'Face',
  tool: flat(6),
  feeds,
  loops: [rect(0, 0, 100, 60)],
  depth: { top: 0, bottom: -1 },
  stepdown: 0.5,
  stepover: 0.5,
  angle: 0,
  ...over,
});

/** A regular `n`-gon of radius `r` about the origin. */
const ngon = (n: number, r: number): Vec2[] =>
  Array.from({ length: n }, (_, k): Vec2 => [
    r * Math.cos((2 * Math.PI * k) / n),
    r * Math.sin((2 * Math.PI * k) / n),
  ]);

const TOO_MANY =
  /this operation would emit more than .* moves, the most allowed\. Use a larger tool/;

describe('the move budget', () => {
  it('caps the emitter and turns the overflow into an invalid-input error', async () => {
    const em = new Emitter('op#1', feeds, [0, 0, 5], 3);
    em.rapid([1, 0, 5]);
    em.linear([1, 0, 0], 'plunge');
    em.linear([2, 0, 0], 'cut');
    expect(() => em.linear([3, 0, 0], 'cut')).toThrow(MoveBudgetExceeded);
    expect(em.entries).toHaveLength(3);
    expect(new Emitter('op#1', feeds, [0, 0, 5]).maxMoves).toBe(OPERATION_MAX_MOVES);

    const r = await withMoveBudget('op#1', () => {
      throw new MoveBudgetExceeded(3e6);
    });
    expect(r).toEqual(tooManyMoves('op#1', 3e6));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-input');
      expect(r.error.message).toBe(
        'op#1: this operation would emit more than 3 million moves, the most allowed. Use a larger tool, stepdown, stepover or entry angle.',
      );
    }
    // Any other error goes through.
    await expect(
      withMoveBudget('op#1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('takes a lower cap from the context, never a higher one', () => {
    expect(OPERATION_MAX_MOVES).toBeGreaterThanOrEqual(1e6);
    expect(SURFACE3D_MAX_MOVES).toBe(OPERATION_MAX_MOVES);
    expect(operationMoveCap({})).toBe(OPERATION_MAX_MOVES);
    expect(operationMoveCap({ maxMoves: 100 })).toBe(100);
    expect(operationMoveCap({ maxMoves: 1e12 })).toBe(OPERATION_MAX_MOVES);
    expect(operationMoveCap({ maxMoves: 0 })).toBe(OPERATION_MAX_MOVES);
    expect(operationMoveCap({ maxMoves: Number.NaN })).toBe(OPERATION_MAX_MOVES);
  });

  it('leaves every valid toolpath as it was, and refuses one entry over the cap', async () => {
    type Gen = (ctx: OperationContext) => Promise<CamResult<GeneratedToolpath>>;
    const cases: [string, Gen][] = [
      ['profile', (c) => generateProfile(profile(), c)],
      ['pocket', (c) => generatePocket(pocket(), c)],
      ['drill', (c) => generateDrill(drill(), c)],
      ['facing', (c) => generateFacing(facing(), c)],
    ];
    for (const [kind, gen] of cases) {
      const full = await gen(context());
      if (!full.ok) throw new Error(`${kind}: ${full.error.message}`);
      const n = full.value.toolpath.entries.length;
      const exact = await gen(context(n));
      expect(exact, kind).toEqual(full);
      const over = await gen(context(n - 1));
      expect(over.ok, kind).toBe(false);
      if (!over.ok) {
        expect(over.error.code).toBe('invalid-input');
        expect(over.error.message).toMatch(TOO_MANY);
        expect(over.error.message).toContain(`more than ${n - 1} moves`);
      }
    }
  });

  it('refuses a needle-thin profile ramped down 60 mm with every level under the entry caps', async () => {
    // A 0.01 mm tool on a 50-gon 0.008 mm in radius, ramped at half a degree in 1 mm steps: each
    // level's ramp is some 2,300 laps (114,000 moves, under ENTRY_MAX_RAMP_MOVES), but the 60
    // levels add up to about 7 million moves (1.7 GB of IR before the cap).
    const exploit = profile({
      tool: flat(0.01),
      loops: [polygon(ngon(50, 0.008))],
      side: 'on',
      depth: { top: 0, bottom: -60 },
      stepdown: 1,
      entry: { kind: 'ramp', angle: deg(0.5) },
    });
    const ring = 2 * 50 * 0.008 * Math.sin(Math.PI / 50);
    expect(rampTooLong(1 / Math.tan(deg(0.5)), ring, 50)).toBeUndefined();
    const t0 = performance.now();
    const r = await generateProfile(exploit, context(200_000));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-input');
      expect(r.error.message).toMatch(TOO_MANY);
    }
  });

  it('counts the tab breaks in a ramp', () => {
    const laps = ENTRY_MAX_TURNS;
    const segments = Math.floor(ENTRY_MAX_RAMP_MOVES / laps) - 2;
    expect(rampTooLong(laps * 10, 10, segments)).toBeUndefined();
    expect(rampTooLong(laps * 10, 10, segments, 1)).toBeUndefined();
    expect(rampTooLong(laps * 10, 10, segments, 2)).toMatch(/ring of \d+ segments and 2 tabs/);
  });

  it('refuses more tabs a loop than PROFILE_MAX_TABS, and caps a tab spacing at it', async () => {
    const tabs = { count: PROFILE_MAX_TABS + 1, width: 2, height: 1 };
    const r = await generateProfile(profile({ tabs }), context());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/tab count must be at most 1000/);
    const huge = await generateProfile(profile({ tabs: { ...tabs, count: 1e9 } }), context());
    expect(huge.ok).toBe(false);
    // A spacing that asks for millions of tabs gets at most PROFILE_MAX_TABS (here far fewer fit).
    const t0 = performance.now();
    const spaced = await generateProfile(
      profile({ tabs: { ...tabs, count: 4 }, tabSpacing: 1e-6 }),
      context(),
    );
    expect(performance.now() - t0).toBeLessThan(3000);
    if (!spaced.ok) throw new Error(spaced.error.message);
    expect(spaced.value.warnings?.map((w) => w.code)).toContain('tabs-capped');
  });

  it('refuses a bore with too many rings or helix turns, before emitting it', async () => {
    // A 0.2 mm hole 6 mm deep with a 0.0001 mm tool: some 2,000 rings of 1,000 turns each.
    const t0 = performance.now();
    const rings = await generateDrill(
      drill({
        tool: flat(1e-4),
        points: [{ at: [10, 10], depth: { top: 0, bottom: -6 }, diameter: 0.2 }],
      }),
      context(),
    );
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(rings.ok).toBe(false);
    if (!rings.ok) {
      expect(rings.error.code).toBe('invalid-input');
      expect(rings.error.message).toMatch(
        new RegExp(`needs \\d+ rings; at most ${DRILL_MAX_BORE_RINGS} are allowed`),
      );
    }
    // Four rings, but the innermost helix at half a degree goes round some 19,000 times.
    const turns = await generateDrill(
      drill({
        tool: flat(0.02),
        points: [{ at: [10, 10], depth: { top: 0, bottom: -20 }, diameter: 0.1 }],
        helixAngle: deg(0.5),
      }),
      context(),
    );
    expect(turns.ok).toBe(false);
    if (!turns.ok) {
      expect(turns.error.message).toMatch(
        new RegExp(`the bore at \\(10, 10\\): a helix entry .* at most ${ENTRY_MAX_TURNS}`),
      );
    }
    // Every ring's turns count against the operation's budget.
    const many = await generateDrill(
      drill({
        tool: flat(1),
        points: [{ at: [10, 10], depth: { top: 0, bottom: -20 }, diameter: 40 }],
        helixAngle: deg(0.5),
      }),
      context(100),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error.message).toMatch(TOO_MANY);
  });
});
