// The operation list's statuses: suppressed, pending until geometry arrives, ok when it resolved,
// error with the stage's messages and the sources to re-pick, and stale once the inputs a
// toolpath was generated from changed.

import type { CamOperation } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { operationStatus, wcsLost, type GeneratedOutcome } from './status';

const op = (patch: Partial<CamOperation> = {}) =>
  ({
    id: 'profile#1',
    kind: 'profile',
    name: 'Outline',
    suppressed: false,
    tool: 'tool#1',
    geometry: [],
    side: 'outside',
    depth: { kind: 'through' },
    entry: { kind: 'plunge' },
    leadIn: { kind: 'none' },
    leadOut: { kind: 'none' },
    climb: true,
    ...patch,
  }) as CamOperation;

function geometry(result: Partial<CamGeometryResult['operations'][number]>): CamGeometryResult {
  return {
    generation: 1,
    setupId: 'setup#1',
    partId: 'part#1',
    bodyId: 'extrude#1',
    bodyKey: 'b',
    key: 'k',
    status: 'ok',
    errors: [],
    warnings: [],
    references: [],
    bounds: null,
    setup: null,
    operations: [
      {
        operationId: 'profile#1',
        kind: 'profile',
        key: 'key-1',
        status: 'ok',
        errors: [],
        warnings: [],
        references: [],
        sources: [],
        values: null,
        ...result,
      },
    ],
    cached: false,
    ms: 0,
  };
}

const none = new Map<string, GeneratedOutcome>();

describe('operationStatus', () => {
  it('is suppressed, pending or unavailable before anything else', () => {
    expect(operationStatus(op({ suppressed: true }), null, none).state).toBe('suppressed');
    expect(operationStatus(op(), null, none).state).toBe('pending');
    expect(operationStatus(op(), null, none, false).state).toBe('unavailable');
  });

  it('is ok when the geometry resolved, with warnings', () => {
    const s = operationStatus(
      op(),
      geometry({ warnings: [{ code: 'heights', message: 'Sources at different heights' }] }),
      none,
    );
    expect(s).toMatchObject({
      state: 'ok',
      warnings: ['Sources at different heights'],
      toolpath: 'none',
    });
  });

  it('is an error with the sources to re-pick', () => {
    const s = operationStatus(
      op(),
      geometry({
        status: 'error',
        errors: [
          { code: 'reference-lost', message: 'Face r2 is gone', source: 1 },
          { code: 'reference-ambiguous', message: 'Face r1 matches 2', source: 0 },
          { code: 'expression', message: 'Bad depth' },
        ],
      }),
      none,
    );
    expect(s.state).toBe('error');
    expect(s.errors).toEqual(['Face r2 is gone', 'Face r1 matches 2', 'Bad depth']);
    expect(s.repick).toEqual([0, 1]);
  });

  it('marks a toolpath stale when the key it came from moved, and shows a failure', () => {
    const done = new Map([['profile#1', { key: 'key-0', ok: true, warnings: [] }]]);
    expect(operationStatus(op(), geometry({}), done)).toMatchObject({
      state: 'ok',
      toolpath: 'generated',
      stale: true,
    });
    const fresh = new Map([
      ['profile#1', { key: 'key-1', ok: false, message: 'Tool too large', warnings: [] }],
    ]);
    expect(operationStatus(op(), geometry({}), fresh)).toMatchObject({
      toolpath: 'failed',
      stale: false,
      errors: ['Tool too large'],
    });
  });

  it('reports a lost WCS face', () => {
    const g = {
      ...geometry({}),
      status: 'error' as const,
      errors: [{ code: 'setup' as const, message: 'The WCS face is gone' }],
    };
    expect(wcsLost(g)).toBe('The WCS face is gone');
    expect(wcsLost(null)).toBeNull();
    expect(operationStatus(op(), g, none).state).toBe('error');
  });
});
