import { describe, expect, it } from 'vitest';
import { nameFromFeature } from './naming';

describe('which feature a face name comes from', () => {
  it('finds the feature at the start of a name and inside merges, corners and instances', () => {
    expect(nameFromFeature('extrude#1:cap:end', 'extrude#1')).toBe(true);
    expect(nameFromFeature('extrude#1:cap:end', 'extrude#12')).toBe(false);
    expect(nameFromFeature('extrude#12:cap:end', 'extrude#1')).toBe(false);
    expect(nameFromFeature('(extrude#1:side:e1+extrude#2:side:e5)', 'extrude#2')).toBe(true);
    expect(nameFromFeature('fillet#1:corner:a&extrude#3:side:e2&b', 'extrude#3')).toBe(true);
    expect(nameFromFeature('pattern#1:i2/hole#1:wall:e3', 'hole#1')).toBe(true);
    expect(nameFromFeature('pattern#1:i2/hole#1:wall:e3', 'pattern#1')).toBe(true);
    expect(nameFromFeature('xextrude#1:cap:end', 'extrude#1')).toBe(false);
    expect(nameFromFeature('sketch#1', 'sketch#1')).toBe(false);
  });
});
