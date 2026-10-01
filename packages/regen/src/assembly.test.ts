// The pure halves of assemblies in regen: choosing one connector report among an instance's
// bodies. The engine's use of them is in engine.test.ts (fake kernel) and integration.test.ts.

import type { ConnectorReport } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { pickReport } from './assembly';

const found = (via: 'exact' | 'descendant' | 'ordinal', index = 1): ConnectorReport => ({
  ok: true,
  frame: { origin: [index, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  kind: 'face',
  index,
  via,
  fragile: via === 'ordinal',
  oriented: true,
});
const lost = (missing: string[]): ConnectorReport => ({
  ok: false,
  status: 'lost',
  missing,
  message: `${missing.join(', ')} is lost`,
});

describe('pickReport', () => {
  it('takes the only body that finds the connector', () => {
    const r = pickReport([
      { bodyId: 'extrude#1', report: lost(['a']) },
      { bodyId: 'extrude#2', report: found('exact', 2) },
    ]);
    expect(r).toMatchObject({ ok: true, index: 2 });
  });

  it('prefers an exact match on one body over a descendant on another, in any order', () => {
    const exact = { bodyId: 'extrude#2', report: found('exact', 2) };
    const descendant = { bodyId: 'extrude#1', report: found('descendant', 1) };
    expect(pickReport([descendant, exact])).toBe(exact.report);
    expect(pickReport([exact, descendant])).toBe(exact.report);
  });

  it('calls two equally good matches on different bodies ambiguous, naming the bodies', () => {
    const r = pickReport([
      { bodyId: 'pattern#2:i2', report: found('descendant', 1) },
      { bodyId: 'extrude#1', report: found('descendant', 4) },
    ]);
    expect(r).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: ['extrude#1', 'pattern#2:i2'],
      message: 'it matches geometry on 2 bodies (extrude#1, pattern#2:i2)',
    });
    const twoExact = pickReport([
      { bodyId: 'b', report: found('exact', 1) },
      { bodyId: 'a', report: found('exact', 1) },
      { bodyId: 'c', report: found('descendant', 1) },
    ]);
    expect(twoExact).toMatchObject({ status: 'ambiguous', candidates: ['a', 'b'] });
  });

  it('falls back to an ambiguity within a body, then the loss with the fewest missing names', () => {
    const within: ConnectorReport = {
      ok: false,
      status: 'ambiguous',
      candidates: ['x', 'y'],
      message: 'ambiguous',
    };
    expect(
      pickReport([
        { bodyId: 'a', report: lost(['p', 'q']) },
        { bodyId: 'b', report: within },
      ]),
    ).toBe(within);
    expect(
      pickReport([
        { bodyId: 'a', report: lost(['p', 'q']) },
        { bodyId: 'b', report: lost(['p']) },
      ]),
    ).toMatchObject({ status: 'lost', missing: ['p'] });
    expect(pickReport([])).toBeUndefined();
  });
});
