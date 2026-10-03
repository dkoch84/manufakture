// Ramp and helix entries: the shallowest angle every operation accepts, and the caps that refuse
// an entry too long to emit (a vanishing angle or a needle-thin helix in an untrusted document
// would otherwise ask for hundreds of millions of moves).

import { describe, expect, it } from 'vitest';
import { rect } from '../offset/test-shapes';
import type { Entry, Setup } from '../types';
import type { OperationContext } from '../worker/registry';
import {
  ENTRY_MAX_RAMP_MOVES,
  ENTRY_MAX_TURNS,
  ENTRY_MIN_ANGLE,
  entryProblem,
  helixTooLong,
  helixTurns,
  rampTooLong,
} from './entry';
import { generatePocket, type PocketOperation } from './pocket';
import { generateProfile, type ProfileOperation } from './profile';

const deg = (d: number) => (d * Math.PI) / 180;

const tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
} as const;
const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500, lead: 800 };

const pocket = (over: Partial<PocketOperation> = {}): PocketOperation => ({
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
  entry: { kind: 'helix', angle: deg(3), radius: 2 },
  climb: true,
  ...over,
});

const profile = (over: Partial<ProfileOperation> = {}): ProfileOperation => ({
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
});

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
const context: OperationContext = {
  generation: 1,
  cancelled: false,
  setup,
  checkpoint: () => Promise.resolve(),
};

/** The refusal's message (failing the test when the operation is not refused). */
async function refused(
  run: Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>,
): Promise<string> {
  const t0 = performance.now();
  const r = await run;
  expect(r.ok).toBe(false);
  // Refused before emitting the entry, not after.
  expect(performance.now() - t0).toBeLessThan(3000);
  if (r.ok) return '';
  expect(r.error.code).toBe('invalid-input');
  return r.error.message;
}

describe('entry angle', () => {
  it('accepts half a degree to 90 degrees, and refuses shallower ones', () => {
    expect(ENTRY_MIN_ANGLE).toBeCloseTo(deg(0.5), 15);
    const ok: Entry[] = [
      { kind: 'plunge' },
      { kind: 'ramp', angle: deg(0.5) },
      { kind: 'ramp', angle: Math.PI / 2 },
      { kind: 'helix', angle: deg(3), radius: 1 },
    ];
    for (const e of ok) expect(entryProblem(e), JSON.stringify(e)).toBeUndefined();
    const bad: Entry[] = [
      { kind: 'ramp', angle: 0 },
      { kind: 'ramp', angle: 1e-8 },
      { kind: 'ramp', angle: deg(0.49) },
      { kind: 'helix', angle: 1e-8, radius: 1 },
      { kind: 'ramp', angle: deg(91) },
      { kind: 'ramp', angle: Number.NaN },
    ];
    for (const e of bad) expect(entryProblem(e)).toMatch(/at least 0\.5 and at most 90 degrees/);
    expect(entryProblem({ kind: 'helix', angle: deg(3), radius: 0 })).toMatch(/radius/);
    expect(entryProblem({ kind: 'spiral' } as unknown as Entry)).toMatch(/Unknown entry/);
  });

  it('is enforced by the pocket and the profile', async () => {
    for (const entry of [
      { kind: 'ramp', angle: 1e-8 },
      { kind: 'helix', angle: 1e-8, radius: 2 },
    ] as const) {
      expect(await refused(generatePocket(pocket({ entry }), context))).toMatch(
        new RegExp(`${entry.kind} angle must be at least 0\\.5`),
      );
      expect(await refused(generateProfile(profile({ entry }), context))).toMatch(
        new RegExp(`${entry.kind} angle must be at least 0\\.5`),
      );
    }
    // Half a degree itself still makes a toolpath.
    const half = await generatePocket(
      pocket({ entry: { kind: 'helix', angle: ENTRY_MIN_ANGLE, radius: 2 } }),
      context,
    );
    expect(half.ok).toBe(true);
  });
});

describe('entry length caps', () => {
  it('counts helix turns and refuses more than ENTRY_MAX_TURNS', () => {
    expect(helixTurns(3, 2, deg(3))).toBe(Math.ceil(3 / (2 * Math.PI * 2 * Math.tan(deg(3)))));
    expect(helixTurns(1e-6, 2, deg(3))).toBe(1);
    expect(helixTooLong(ENTRY_MAX_TURNS, 1, 1, deg(1))).toBeUndefined();
    expect(helixTooLong(ENTRY_MAX_TURNS + 1, 1, 1, deg(1))).toMatch(/at most 10000 are allowed/);
  });

  it('counts ramp laps and moves, and refuses past either cap', () => {
    expect(rampTooLong(100, 10, 4)).toBeUndefined();
    expect(rampTooLong(10 * (ENTRY_MAX_TURNS + 1), 10, 4)).toMatch(/10001 times round/);
    // Few laps of a ring with very many segments: the move cap.
    const segments = ENTRY_MAX_RAMP_MOVES / 10 + 1;
    expect(rampTooLong(100, 10, segments)).toMatch(/million moves are allowed/);
  });

  it('refuses a profile helix on a needle-thin radius', async () => {
    // 0.0001 mm radius at half a degree: some 550,000 turns for the 3 mm drop.
    const entry = { kind: 'helix', angle: ENTRY_MIN_ANGLE, radius: 1e-4 } as const;
    expect(await refused(generateProfile(profile({ entry }), context))).toMatch(
      /profile#1: a helix entry .* needs \d+ turns; at most 10000 are allowed/,
    );
  });

  it('refuses a profile ramp that would go round the part ten thousand times', async () => {
    const entry = { kind: 'ramp', angle: ENTRY_MIN_ANGLE } as const;
    const deep = { depth: { top: 0, bottom: -20000 }, stepdown: 20000 };
    expect(await refused(generateProfile(profile({ entry, ...deep }), context))).toMatch(
      /profile#1: a ramp entry .* times round/,
    );
  });

  it('refuses a pocket helix or ramp past the caps', async () => {
    const deep = { depth: { top: 0, bottom: -10000 }, stepdown: 10000 };
    const helix = { kind: 'helix', angle: ENTRY_MIN_ANGLE, radius: 2 } as const;
    expect(await refused(generatePocket(pocket({ entry: helix, ...deep }), context))).toMatch(
      /pocket#1: a helix entry .* turns; at most 10000 are allowed/,
    );
    const ramp = { kind: 'ramp', angle: ENTRY_MIN_ANGLE } as const;
    expect(await refused(generatePocket(pocket({ entry: ramp, ...deep }), context))).toMatch(
      /pocket#1: a ramp entry .* times round/,
    );
  });
});
