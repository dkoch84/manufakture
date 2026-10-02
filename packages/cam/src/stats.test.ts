import { describe, expect, it } from 'vitest';
import type { IrEntry, Toolpath } from './ir';
import { toolpathBounds, toolpathStats } from './stats';
import { sampleToolpath } from './test-helpers';

describe('toolpathStats', () => {
  it('sums lengths per class and estimates time from feeds and the rapid rate', () => {
    const r = toolpathStats(sampleToolpath(), { rapidRate: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    const helix = Math.hypot(2 * 2 * Math.PI, 1);
    const ramp = Math.sqrt(101) + helix;
    expect(s.lengthByClass.plunge).toBeCloseTo(6, 12);
    expect(s.lengthByClass.cut).toBeCloseTo(50 + 10 * Math.PI, 12);
    expect(s.lengthByClass.lead).toBeCloseTo(10, 12);
    expect(s.lengthByClass.ramp).toBeCloseTo(ramp, 12);
    expect(s.cutLength).toBeCloseTo(6 + 50 + 10 * Math.PI + 10 + ramp, 12);
    expect(s.rapidLength).toBeCloseTo(5 + 13, 12);
    expect(s.moveCount).toBe(8);
    expect(s.toolChanges).toBe(1);

    const feed = 6 / 300 + (50 + 10 * Math.PI) / 1000 + 10 / 500 + ramp / 400;
    expect(s.estimate.feedMinutes).toBeCloseTo(feed, 12);
    expect(s.estimate.rapidMinutes).toBeCloseTo(18 / 5000, 12);
    expect(s.estimate.dwellMinutes).toBeCloseTo(1.5 / 60, 12);
    expect(s.estimate.totalMinutes).toBeCloseTo(feed + 18 / 5000 + 1.5 / 60, 12);
  });

  it('an empty program is all zeros', () => {
    const r = toolpathStats({ start: [0, 0, 0], entries: [] }, { rapidRate: 1000 });
    expect(r.ok && r.value.cutLength === 0 && r.value.estimate.totalMinutes === 0).toBe(true);
  });

  it('refuses a rapid rate of zero', () => {
    const r = toolpathStats(sampleToolpath(), { rapidRate: 0 });
    expect(r.ok ? undefined : r.error.code).toBe('invalid-input');
  });
});

describe('toolpathBounds', () => {
  it('includes arc extremes, rapids and the start', () => {
    const b = toolpathBounds(sampleToolpath());
    // The half turn reaches x = 20 although its ends are at x = 30; the helix reaches y = 18 and 22.
    expect(b.all).toEqual({ min: [0, 0, -3], max: [50, 40, 10] });
    expect(b.feed).toEqual({ min: [0, 0, -3], max: [50, 40, 5] });
  });

  it('arc extremes beyond every end point', () => {
    const b = toolpathBounds({
      start: [10, 0, 0],
      entries: [
        {
          kind: 'arc',
          to: [-10, 0, 0],
          center: [0, 0],
          direction: 'cw',
          fullCircle: false,
          feed: 100,
          feedClass: 'cut',
          op: 'pocket#1',
          pass: 0,
        },
      ],
    });
    // Clockwise from +X to -X goes through -Y.
    expect(b.feed?.min[1]).toBeCloseTo(-10, 12);
    expect(b.feed?.max[1]).toBeCloseTo(0, 12);
  });

  it('no feed moves: feed bounds undefined, all bounds the rapids', () => {
    const b = toolpathBounds({
      start: [0, 0, 10],
      entries: [{ kind: 'rapid', to: [5, 6, 7], op: 'link', pass: 0 }],
    });
    expect(b.feed).toBeUndefined();
    expect(b.all).toEqual({ min: [0, 0, 7], max: [5, 6, 10] });
  });

  it('skips canned-cycle markers: same stats and bounds with and without them', () => {
    const op = 'drill#1';
    const moves: IrEntry[] = [
      { kind: 'linear', to: [5, 5, -6], feed: 300, feedClass: 'plunge', op, pass: 0 },
      { kind: 'dwell', seconds: 6, op, pass: 0 },
      { kind: 'rapid', to: [5, 5, 3], op, pass: 0 },
    ];
    const plain: Toolpath = { start: [5, 5, 3], entries: moves };
    const marked: Toolpath = {
      start: [5, 5, 3],
      entries: [
        { kind: 'cycle', drill: { at: [5, 5], top: 0, bottom: -6, retract: 3, dwell: 6 }, op },
        ...moves,
        { kind: 'cycleEnd', op },
      ],
    };
    const a = toolpathStats(plain, { rapidRate: 5000 });
    const b = toolpathStats(marked, { rapidRate: 5000 });
    expect(b).toEqual(a);
    expect(b.ok && b.value.estimate.dwellMinutes).toBeCloseTo(0.1, 12);
    expect(toolpathBounds(marked)).toEqual(toolpathBounds(plain));
  });
});
