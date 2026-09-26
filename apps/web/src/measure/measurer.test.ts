import { describe, expect, it } from 'vitest';
import { geometryRef } from '../state/selection';
import { placeholderName } from '../viewport/naming';
import { measureTarget, measureTargets } from './measurer';

describe('measure targets from the selection', () => {
  it('sends real names by name', () => {
    expect(measureTarget(geometryRef('face', 'b', 'extrude#1:cap:end'))).toEqual({
      kind: 'face',
      name: 'extrude#1:cap:end',
    });
    expect(measureTarget(geometryRef('edge', 'b', 'A|B[C,D]#2'))).toEqual({
      kind: 'edge',
      name: 'A|B[C,D]#2',
    });
  });

  it('sends viewport placeholders as the index they encode', () => {
    const refs = [
      geometryRef('face', 'b', placeholderName('face', 3), { placeholder: true }),
      geometryRef('edge', 'b', placeholderName('edge', 12), { placeholder: true }),
      geometryRef('vertex', 'b', placeholderName('vertex', 7), { placeholder: true }),
    ];
    expect(measureTargets(refs)).toEqual([
      { kind: 'face', index: 3 },
      { kind: 'edge', index: 12 },
      { kind: 'vertex', index: 7 },
    ]);
  });

  it('does not read a placeholder of another kind as an index', () => {
    expect(measureTarget(geometryRef('face', 'b', placeholderName('edge', 3)))).toEqual({
      kind: 'face',
      name: 'placeholder:edge:3',
    });
  });
});
