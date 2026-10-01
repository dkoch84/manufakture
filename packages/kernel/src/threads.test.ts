// Thread tables, profile arithmetic, turn pieces and thread face names: plain data, no wasm.
// The geometry itself is checked by the kernel goldens (test/threads.test.ts).

import { describe, expect, it } from 'vitest';
import { validateFeature } from './features';
import { threadFace } from './naming';
import {
  THREAD_SIZES,
  threadLimits,
  threadProblem,
  threadProfile,
  threadSize,
  threadTurns,
  type ThreadGeometry,
} from './threads';

const H = Math.sqrt(3) / 2;

describe('thread tables', () => {
  // ISO 724 basic dimensions (pitch diameter D2, minor diameter D1), as the standard's table
  // prints them to three decimals.
  const ISO_724: [string, number, number, number, number][] = [
    ['M2', 0.4, 1.74, 1.567, 1.6],
    ['M2.5', 0.45, 2.208, 2.013, 2.05],
    ['M3', 0.5, 2.675, 2.459, 2.5],
    ['M3.5', 0.6, 3.11, 2.85, 2.9],
    ['M4', 0.7, 3.545, 3.242, 3.3],
    ['M5', 0.8, 4.48, 4.134, 4.2],
    ['M6', 1, 5.35, 4.917, 5],
    ['M8', 1.25, 7.188, 6.647, 6.8],
    ['M10', 1.5, 9.026, 8.376, 8.5],
    ['M12', 1.75, 10.863, 10.106, 10.2],
    ['M14', 2, 12.701, 11.835, 12],
    ['M16', 2, 14.701, 13.835, 14],
    ['M18', 2.5, 16.376, 15.294, 15.5],
    ['M20', 2.5, 18.376, 17.294, 17.5],
  ];

  it.each(ISO_724)(
    '%s matches ISO 724 and the ISO 2306 tap drill',
    (size, pitch, d2, d1, drill) => {
      const s = threadSize('iso-metric', size)!;
      expect(s.pitch).toBe(pitch);
      expect(s.major).toBe(Number(size.slice(1)));
      expect(Math.round(s.pitchDiameter * 1000) / 1000).toBe(d2);
      expect(Math.round(s.minor * 1000) / 1000).toBe(d1);
      expect(s.tapDrill).toBe(drill);
      expect(s.tpi).toBeNull();
    },
  );

  // ASME B1.1 basic major and minor diameters (inches) and the 75% tap drills.
  const UNC: [string, number, number, number, string, number][] = [
    ['#4-40', 40, 0.112, 0.0849, '#43', 0.089],
    ['#5-40', 40, 0.125, 0.0979, '#38', 0.1015],
    ['#6-32', 32, 0.138, 0.1042, '#36', 0.1065],
    ['#8-32', 32, 0.164, 0.1302, '#29', 0.136],
    ['#10-24', 24, 0.19, 0.1449, '#25', 0.1495],
    ['#12-24', 24, 0.216, 0.1709, '#16', 0.177],
    ['1/4-20', 20, 0.25, 0.1959, '#7', 0.201],
    ['5/16-18', 18, 0.3125, 0.2524, 'F', 0.257],
    ['3/8-16', 16, 0.375, 0.3073, '5/16', 0.3125],
    ['7/16-14', 14, 0.4375, 0.3602, 'U', 0.368],
    ['1/2-13', 13, 0.5, 0.4167, '27/64', 0.4219],
  ];

  it.each(UNC)('%s matches ASME B1.1', (size, tpi, major, minor, drillName, drill) => {
    const s = threadSize('unc', size)!;
    expect(s.tpi).toBe(tpi);
    expect(s.pitch).toBeCloseTo(25.4 / tpi, 12);
    expect(s.major).toBeCloseTo(major * 25.4, 12);
    expect(Math.round((s.minor / 25.4) * 10000) / 10000).toBe(minor);
    expect(s.tapDrillName).toBe(drillName);
    expect(s.tapDrill).toBeCloseTo(drill * 25.4, 12);
    expect(s.choice).toBeNull();
  });

  it('finds UNC sizes with or without the thread count, and nothing else', () => {
    expect(threadSize('unc', '1/4')).toBe(threadSize('unc', '1/4-20'));
    expect(threadSize('unc', '1/4-28')).toBeUndefined();
    expect(threadSize('iso-metric', '1/4')).toBeUndefined();
    expect(threadSize('iso-metric', 'M7')).toBeUndefined();
  });

  it('every size is listed once, metric then UNC, each in increasing size', () => {
    const metric = THREAD_SIZES.filter((s) => s.system === 'iso-metric');
    const unc = THREAD_SIZES.filter((s) => s.system === 'unc');
    expect(metric.map((s) => s.size)).toEqual(ISO_724.map((r) => r[0]));
    expect(unc.map((s) => s.size)).toEqual(UNC.map((r) => r[0]));
    expect(THREAD_SIZES).toEqual([...metric, ...unc]);
    for (const list of [metric, unc]) {
      for (let i = 1; i < list.length; i++)
        expect(list[i]!.major).toBeGreaterThan(list[i - 1]!.major);
    }
    expect(metric.filter((s) => s.choice === 2).map((s) => s.size)).toEqual(['M3.5', 'M14', 'M18']);
  });
});

const M6: ThreadGeometry = {
  side: 'external',
  axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
  radius: 3,
  major: 6,
  pitch: 1,
  length: 10,
};

describe('thread profile', () => {
  it('an external thread: root at the basic minor diameter, P/4 wide; crest at the cylinder', () => {
    const p = threadProfile(M6);
    expect(p.root).toBeCloseTo((6 - (5 / 4) * H) / 2, 12);
    expect(p.rootWidth).toBe(0.25);
    expect(p.crest).toBe(3);
    expect(p.trim).toBe(false);
    expect(p.opening).toBeCloseTo(3.05, 12);
    // The 60 degree flanks: the groove widens by 2 tan 30 per unit of radius.
    expect(p.openingWidth).toBeCloseTo(0.25 + 2 * (3.05 - p.root) * Math.tan(Math.PI / 6), 12);
    expect(p.openingWidth).toBeLessThan(1);
  });

  it('an internal thread: root at the major diameter, P/8 wide', () => {
    const minor = (6 - (5 / 4) * H) / 2;
    const p = threadProfile({ ...M6, side: 'internal', radius: minor });
    expect(p.root).toBe(3);
    expect(p.rootWidth).toBe(0.125);
    expect(p.crest).toBe(minor);
    expect(p.opening).toBeCloseTo(minor - 0.05, 12);
    expect(p.trim).toBe(false);
    // A hole at ISO 724's rounded minor diameter, 0.0003 mm under the exact one, is not trimmed.
    expect(threadProfile({ ...M6, side: 'internal', radius: 4.917 / 2 })).toMatchObject({
      crest: 4.917 / 2,
      trim: false,
    });
  });

  it('the clearance moves the profile away from the mating part', () => {
    const ext = threadProfile({ ...M6, clearance: 0.2 });
    expect(ext.root).toBeCloseTo(threadProfile(M6).root - 0.2, 12);
    // A shaft at the nominal diameter is trimmed to the major diameter minus the clearance.
    expect(ext.crest).toBeCloseTo(2.8, 12);
    expect(ext.trim).toBe(true);
    expect(ext.far).toBeCloseTo(3.05, 12);
    const int = threadProfile({ ...M6, side: 'internal', radius: 2.4, clearance: 0.2 });
    expect(int.root).toBeCloseTo(3.2, 12);
    // A hole smaller than the minor diameter plus the clearance is opened up to it.
    expect(int.crest).toBeCloseTo((6 - (5 / 4) * H) / 2 + 0.2, 12);
    expect(int.trim).toBe(true);
    expect(int.far).toBeCloseTo(2.35, 12);
  });

  it('limits: what the cylinder radius may be', () => {
    const ext = threadLimits('external', 6, 1);
    const depth = (5 / 8) * H;
    expect(ext.crest).toBeCloseTo(3, 12);
    expect(ext.min).toBeCloseTo(3 - depth + depth / 4, 12);
    expect(ext.max).toBe(4);
    const int = threadLimits('internal', 6, 1, 0.1);
    expect(int.crest).toBeCloseTo(3.1 - depth, 12);
    expect(int.max).toBeCloseTo(3.1 - depth / 4, 12);
    expect(int.min).toBeCloseTo(3.1 - depth - 0.5, 12);
  });
});

describe('thread problems', () => {
  it('accepts good geometry', () => {
    expect(threadProblem(M6)).toBeNull();
    expect(
      threadProblem({
        ...M6,
        side: 'internal',
        radius: 2.5,
        hand: 'left',
        start: 'open',
        end: 'chamfer',
      }),
    ).toBeNull();
  });

  it.each<[Partial<ThreadGeometry> | Record<string, unknown>, RegExp]>([
    [{ side: 'inside' }, /side must be/],
    [{ axis: { origin: [0, 0], direction: [0, 0, 1] } }, /axis must be/],
    [{ axis: { origin: [0, 0, 0], direction: [0, 0, 0] } }, /zero vector/],
    [{ pitch: 0 }, /pitch must be a positive number/],
    [{ length: -1 }, /length must be a positive number/],
    [{ radius: Number.NaN }, /radius must be a positive number/],
    [{ clearance: -0.1 }, /clearance must be/],
    [{ hand: 'both' }, /hand must be/],
    [{ start: 'faded' }, /start must be/],
    [{ pitch: 4 }, /too coarse/],
    [{ radius: 2.55 }, /needs a cylinder 5.188 to 8 mm across; this one is 5.1/],
    [{ radius: 4.5 }, /needs a cylinder/],
    [{ length: 0.4, start: 'closed', end: 'closed' }, /too short/],
  ])('rejects %j', (change, message) => {
    expect(threadProblem({ ...M6, ...change } as ThreadGeometry)).toMatch(message);
  });

  it('the feature validates the same way, and takes a scope but no body id', () => {
    const input = { kind: 'thread', id: 'thread#3', ...M6 };
    expect(validateFeature(input)).toBeNull();
    expect(validateFeature({ ...input, scope: ['extrude#1'] })).toBeNull();
    expect(validateFeature({ ...input, body: 'x' })).toMatch(/only a feature that makes a body/);
    expect(validateFeature({ ...input, pitch: 'one' })).toMatch(/pitch must be/);
    expect(validateFeature({ ...input, id: 'thread' })).toMatch(/must look like/);
  });
});

describe('thread turns', () => {
  it('cuts the centre line at whole turns, numbered from the start', () => {
    expect(threadTurns(-1, 2.5)).toEqual([
      { from: -1, to: 0, turn: 0 },
      { from: 0, to: 1, turn: 1 },
      { from: 1, to: 2, turn: 2 },
      { from: 2, to: 2.5, turn: 3 },
    ]);
    expect(threadTurns(0.4, 1.6)).toEqual([
      { from: 0.4, to: 1, turn: 1 },
      { from: 1, to: 1.6, turn: 2 },
    ]);
    expect(threadTurns(0.3, 0.8)).toEqual([{ from: 0.3, to: 0.8, turn: 1 }]);
  });

  it('a sliver at the end is shared with the turn before it, keeping both numbers', () => {
    expect(threadTurns(-1, 3.05)).toEqual([
      { from: -1, to: 0, turn: 0 },
      { from: 0, to: 1, turn: 1 },
      { from: 1, to: 2, turn: 2 },
      { from: 2, to: 2.525, turn: 3 },
      { from: 2.525, to: 3.05, turn: 4 },
    ]);
  });

  it('a longer thread keeps the numbers and spans of every earlier turn', () => {
    const short = threadTurns(0.4, 5.6);
    const long = threadTurns(0.4, 8.6);
    expect(long.slice(0, short.length - 1)).toEqual(short.slice(0, -1));
  });
});

describe('thread face names', () => {
  it('per-turn faces descend from the turnless name; none is fragile', () => {
    expect(threadFace('thread#5', 'root', 3)).toEqual({
      name: 'thread#5:thread:root:3',
      lineage: ['thread#5:thread:root:3', 'thread#5:thread:root'],
      fragile: false,
    });
    expect(threadFace('thread#5', 'chamfer-start')).toEqual({
      name: 'thread#5:thread:chamfer-start',
      lineage: ['thread#5:thread:chamfer-start'],
      fragile: false,
    });
    expect(threadFace('thread#5', 'flank-a', 0).name).toBe('thread#5:thread:flank-a:0');
  });
});
