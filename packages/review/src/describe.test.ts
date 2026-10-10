import type { HoleFeature } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { Names, featureDetail } from './describe';

const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

const hole = (extra: Partial<HoleFeature> = {}): HoleFeature => ({
  id: 'hole#1',
  kind: 'hole',
  name: 'Holes',
  suppressed: false,
  sketch: 'sketch#2',
  points: ['e5', 'e6'],
  diameter: mm('5.5'),
  extent: { type: 'throughAll' },
  head: { type: 'simple' },
  ...extra,
});

describe('hole details', () => {
  const lookup = new Names([]);

  it('say the clearance standard and the depth', () => {
    expect(featureDetail(hole({ standard: { size: 'M5', fit: 'normal' } }), lookup, 'part#1')).toBe(
      ' (2 holes, M5 normal, 5.5 mm through all) on sketch#2',
    );
  });

  it('say a heat-set insert and a flat bottom', () => {
    const insert = hole({
      diameter: mm('4'),
      extent: { type: 'blind', depth: mm('5.7'), tipAngle: mm('180') },
      standard: { size: 'M3', purpose: 'heat-set-insert' },
    });
    expect(featureDetail(insert, lookup, 'part#1')).toBe(
      ' (2 holes, M3 heat-set insert, 4 mm 5.7 mm deep, 180 deg tip) on sketch#2',
    );
  });
});
