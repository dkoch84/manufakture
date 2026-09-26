import type { SketchConstraint } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import type { SolveInfo } from './session';
import { conflictBlame, constraintState, describeStatus, entityStatus } from './status';

const solved = (
  patch: Partial<SolveInfo['diagnosis']> = {},
  status: SolveInfo['status'] = 'solved',
): SolveInfo => ({
  status,
  diagnosis: {
    dof: 0,
    conflicting: [],
    redundant: [],
    partiallyRedundant: [],
    entities: {},
    ...patch,
  },
  issues: [],
});

describe('the sketch status', () => {
  it('counts the degrees of freedom left', () => {
    expect(describeStatus(solved({ dof: 3 }), null)).toMatchObject({
      kind: 'under',
      dof: 3,
      text: '3 degrees of freedom left',
    });
    expect(describeStatus(solved({ dof: 1 }), null).text).toBe('1 degree of freedom left');
    expect(describeStatus(solved(), null)).toMatchObject({
      kind: 'fully',
      text: 'Fully constrained',
    });
    expect(describeStatus(solved({ redundant: ['k4'] }), null).text).toBe(
      'Fully constrained, 1 redundant constraint',
    );
  });

  it('reports conflicts from the lists, not the solve status', () => {
    expect(
      describeStatus(solved({ dof: null, conflicting: ['k1', 'k2'] }, 'conflicting'), null),
    ).toMatchObject({
      kind: 'conflict',
      text: 'Over-constrained: 2 constraints conflict',
    });
    expect(describeStatus(solved({ conflicting: ['k1'] }), null).kind).toBe('conflict');
  });

  it('reports what stops a solve', () => {
    expect(describeStatus(null, null).kind).toBe('solving');
    expect(describeStatus(null, 'worker died')).toMatchObject({
      kind: 'error',
      text: 'The solver failed: worker died',
    });
    const invalid: SolveInfo = {
      ...solved({}, 'invalid'),
      issues: [{ code: 'expression', message: "Unknown variable 't'" }],
    };
    expect(describeStatus(invalid, null)).toMatchObject({
      kind: 'invalid',
      text: "Unknown variable 't'",
    });
    expect(describeStatus(solved({}, 'failed'), null).kind).toBe('failed');
    expect(describeStatus({ ...solved({}, 'aborted'), message: 'out of memory' }, null).text).toBe(
      'out of memory',
    );
  });

  it('colours entities and constraints from the diagnosis', () => {
    const s = solved({
      entities: { e1: 'fully', e2: 'over' },
      conflicting: ['k1'],
      redundant: ['k2'],
    });
    expect(entityStatus(s, 'e1')).toBe('fully');
    expect(entityStatus(s, 'e3')).toBe('under');
    expect(entityStatus(null, 'e1')).toBe('under');
    expect(constraintState(s, 'k1')).toBe('conflicting');
    expect(constraintState(s, 'k2')).toBe('redundant');
    expect(constraintState(s, 'k3')).toBe('ok');
  });
});

describe('blaming a conflict', () => {
  const constraints = ['k1', 'k2', 'k3', 'k4'].map(
    (id) => ({ id, kind: 'horizontal', line: 'e1' }) as SketchConstraint,
  );

  it('blames the newest constraint the last edit added', () => {
    expect(conflictBlame(['k1', 'k3', 'k2'], constraints, ['k2'])).toEqual({
      blamed: 'k2',
      others: ['k1', 'k3'],
    });
  });

  it('falls back to the newest in creation order', () => {
    expect(conflictBlame(['k3', 'k1'], constraints, [])).toEqual({ blamed: 'k3', others: ['k1'] });
    expect(conflictBlame([], constraints, ['k1'])).toEqual({ blamed: null, others: [] });
  });
});
