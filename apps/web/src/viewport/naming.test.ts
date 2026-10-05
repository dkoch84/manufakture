import { featureIdsInName } from '@manufakture/core/names';
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

  // The boundary rules are core's (featureIdsInName), not a second set of the viewport's own.
  it('finds every member of a corner and a nested tail, not only those after a separator', () => {
    const corner = 'fillet#3:corner:extrude#1:cap:end&extrude#2:side:e1&extrude#2:side:e2';
    expect(nameFromFeature(corner, 'fillet#3')).toBe(true);
    expect(nameFromFeature(corner, 'extrude#1')).toBe(true);
    expect(nameFromFeature(corner, 'extrude#2')).toBe(true);
    expect(nameFromFeature('shell#2:offset:extrude#1:cap:end', 'extrude#1')).toBe(true);
    expect(nameFromFeature('fillet#3:round:import#2:face:7&extrude#1:cap:end', 'import#2')).toBe(
      true,
    );
  });

  it('does not read a derived part source name as this document', () => {
    const name = 'derived#1:from/extrude#1:cap:end';
    expect(nameFromFeature(name, 'derived#1')).toBe(true);
    expect(nameFromFeature(name, 'extrude#1')).toBe(false);
    const merged = '(extrude#2:side:e5+derived#1:from/(extrude#1:cap:end+hole#5:wall:e5))';
    expect(nameFromFeature(merged, 'extrude#2')).toBe(true);
    expect(nameFromFeature(merged, 'derived#1')).toBe(true);
    expect(nameFromFeature(merged, 'hole#5')).toBe(false);
  });

  it('needs a whole id of a known feature kind followed by a colon', () => {
    expect(nameFromFeature('myextrude#1:cap:end', 'extrude#1')).toBe(false);
    expect(nameFromFeature('extrude#1x:cap:end', 'extrude#1')).toBe(false);
    expect(nameFromFeature('9extrude#1:cap:end', 'extrude#1')).toBe(false);
    expect(nameFromFeature('#extrude#1:cap:end', 'extrude#1')).toBe(false);
    expect(nameFromFeature('widget#1:cap:end', 'widget#1')).toBe(false);
    expect(nameFromFeature('extrude#1', 'extrude#1')).toBe(false);
  });

  it('reads script operation prefixes and kernel placeholders', () => {
    expect(nameFromFeature('scripted#2:boss/cap:end', 'scripted#2')).toBe(true);
    expect(nameFromFeature('scripted#2:rnd/round:extrude#1:cap:end', 'extrude#1')).toBe(true);
    // A `?faceN` no history reached names no feature; wrapped, only the wrapper counts.
    expect(nameFromFeature('?face3', 'extrude#1')).toBe(false);
    expect(nameFromFeature('hole#2:?face3', 'hole#2')).toBe(true);
    // A viewport placeholder is not a feature's face either.
    expect(nameFromFeature('placeholder:face:3', 'extrude#1')).toBe(false);
  });

  it('agrees with core for every name', () => {
    for (const name of [
      'extrude#1:cap:end',
      'pattern#7:i2/derived#1:from/extrude#3:side:e1',
      'mirror#8:image/hole#5:wall:e5',
      'extrude#1:side:e1|extrude#2:cap:end',
    ]) {
      for (const id of ['extrude#1', 'extrude#2', 'extrude#3', 'hole#5', 'derived#1']) {
        expect(nameFromFeature(name, id), `${name} / ${id}`).toBe(
          featureIdsInName(name).includes(id),
        );
      }
    }
  });
});
