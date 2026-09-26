import { describe, expect, it } from 'vitest';
import { materialize, renamePick, snapConstraints } from './draft';

describe('drafts', () => {
  it('gives temporary ids permanent ones from the counters, references included', () => {
    let e = 7;
    let k = 3;
    const m = materialize(
      {
        entities: [
          { id: '$0', kind: 'line', construction: false, start: [0, 0], end: [1, 0] },
          { id: '$1', kind: 'line', construction: false, start: [1, 0], end: [1, 1] },
        ],
        constraints: [
          { kind: 'coincident', a: { entity: '$0', at: 'end' }, b: { entity: '$1', at: 'start' } },
          { kind: 'tangent', a: 'e2', b: '$1', at: ['end', 'start'] },
        ],
      },
      () => `e${e++}`,
      () => `k${k++}`,
    );
    expect(m.entities.map((x) => x.id)).toEqual(['e7', 'e8']);
    expect(m.constraints).toEqual([
      {
        kind: 'coincident',
        a: { entity: 'e7', at: 'end' },
        b: { entity: 'e8', at: 'start' },
        id: 'k3',
      },
      { kind: 'tangent', a: 'e2', b: 'e8', at: ['end', 'start'], id: 'k4' },
    ]);
    expect([...m.ids]).toEqual([
      ['$0', 'e7'],
      ['$1', 'e8'],
    ]);
  });

  it('renames the snap target of a pick', () => {
    const rename = (id: string) => (id === '$0' ? 'e5' : id);
    expect(
      renamePick(
        { position: [1, 2], target: { kind: 'point', ref: { entity: '$0', at: 'end' } } },
        rename,
      ),
    ).toEqual({ position: [1, 2], target: { kind: 'point', ref: { entity: 'e5', at: 'end' } } });
    expect(
      renamePick({ position: [1, 2], target: { kind: 'curve', entity: '$0' } }, rename).target,
    ).toEqual({
      kind: 'curve',
      entity: 'e5',
    });
  });

  it('never constrains a point to itself', () => {
    expect(
      snapConstraints(
        { kind: 'point', ref: { entity: 'e1', at: 'end' } },
        { entity: 'e1', at: 'end' },
      ),
    ).toEqual([]);
    expect(snapConstraints({ kind: 'curve', entity: 'e1' }, { entity: 'e1', at: 'end' })).toEqual(
      [],
    );
    expect(snapConstraints(null, { entity: 'e1', at: 'end' })).toEqual([]);
  });
});
