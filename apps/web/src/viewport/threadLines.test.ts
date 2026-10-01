import type { ThreadReport } from '@manufakture/kernel';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { cosmeticThreadLines, threadHelix } from './threadLines';

const report: ThreadReport = {
  bodyId: 'extrude#1',
  side: 'external',
  representation: 'cosmetic',
  axis: { origin: [0, 0, 2], direction: [0, 0, 1] },
  radius: 2.9,
  length: 10,
  major: 6,
  pitch: 1,
  hand: 'right',
  phase: 0,
  start: 'chamfer',
  end: 'closed',
};

describe('threadHelix', () => {
  it('runs the length of the thread at the radius, one turn per pitch, with end circles', () => {
    const [helix, start, end] = threadHelix(report);
    expect(helix![0]![2]).toBeCloseTo(2, 9);
    expect(helix!.at(-1)![2]).toBeCloseTo(12, 9);
    for (const p of helix!) {
      // Just off the face, outside a shaft.
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(2.94, 9);
    }
    // Phase 0 starts on +x; a right-hand helix turns toward +y as it rises.
    expect(helix![0]![0]).toBeGreaterThan(2.9);
    const quarter = helix![Math.round(helix!.length / 40)]!;
    expect(quarter[1]).toBeGreaterThan(0);
    expect(start!.every((p) => Math.abs(p[2] - 2) < 1e-9)).toBe(true);
    expect(end!.every((p) => Math.abs(p[2] - 12) < 1e-9)).toBe(true);
  });

  it('turns the other way for a left hand, and sits inside a hole', () => {
    const [helix] = threadHelix({ ...report, hand: 'left', side: 'internal', radius: 2.5 });
    expect(Math.hypot(helix![0]![0], helix![0]![1])).toBeCloseTo(2.46, 9);
    expect(helix![Math.round(helix!.length / 40)]![1]).toBeLessThan(0);
  });
});

describe('cosmeticThreadLines', () => {
  const result = (status: FeatureResult['status'], thread?: ThreadReport) =>
    ({ featureId: 'thread#1', status, ...(thread ? { thread } : {}) }) as FeatureResult;

  it('draws cosmetic threads that built, and nothing for modelled or failed ones', () => {
    expect(cosmeticThreadLines({ features: [result('ok', report)] })).toHaveLength(3);
    expect(
      cosmeticThreadLines({ features: [result('ok', { ...report, representation: 'modelled' })] }),
    ).toEqual([]);
    expect(cosmeticThreadLines({ features: [result('error', report)] })).toEqual([]);
    expect(cosmeticThreadLines({ features: [result('ok')] })).toEqual([]);
    expect(cosmeticThreadLines(undefined)).toEqual([]);
  });
});
