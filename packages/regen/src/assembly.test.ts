// The pure halves of assemblies in regen: choosing one connector report among an instance's
// bodies, and turning a solve into results (limit warnings, solved poses). The engine's use of them is in engine.test.ts (fake kernel) and integration.test.ts.

import { solve, type Pose } from '@manufakture/assembly';
import type { ConnectorReport } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import {
  applyReport,
  emptyAssemblyResult,
  namedCoordinates,
  pickReport,
  solvedPoses,
} from './assembly';
import type { AssemblyResult, InstanceResult, MateResult } from './types';

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

describe('applyReport', () => {
  const I: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const at = (z: number): Pose => ({ translation: [0, 0, z], rotation: [0, 0, 0, 1] });
  const instance = (id: string, pose: Pose, suppressed = false): InstanceResult => ({
    instanceId: id,
    status: suppressed ? 'suppressed' : 'ok',
    source: { part: 'part#1' },
    bodies: [],
    transform: pose,
    moved: false,
    errors: [],
    warnings: [],
  });
  const mateResult = (id: string): MateResult => ({
    mateId: id,
    status: 'ok',
    coordinates: [],
    residual: null,
    connectors: [
      { connectorId: 'mc#1', instanceId: 'cab', frame: I, reference: null },
      { connectorId: 'mc#2', instanceId: 'drawer', frame: I, reference: null },
    ],
    errors: [],
    warnings: [],
  });

  function solved(z: number): AssemblyResult {
    const result = emptyAssemblyResult('assembly#1');
    result.instances.push(instance('cab', I), instance('drawer', at(z)), instance('off', I, true));
    result.mates.push(mateResult('mate#1'));
    const report = solve({
      instances: [
        { id: 'cab', pose: I, fixed: true },
        { id: 'drawer', pose: at(z) },
      ],
      mates: [
        {
          id: 'mate#1',
          kind: 'slider',
          a: { instance: 'cab', frame: I },
          b: { instance: 'drawer', frame: I },
          limits: { min: 0, max: 457.2 },
        },
      ],
    });
    applyReport(
      result,
      report,
      new Map([
        ['cab', I],
        ['drawer', at(z)],
      ]),
    );
    return result;
  }

  it('puts a clamp to a limit on the mate as a limit warning, and the solved pose on the instance', () => {
    const result = solved(600);
    const mate = result.mates[0]!;
    expect(mate.coordinates[0]).toBeCloseTo(457.2, 9);
    expect(mate.warnings).toEqual([
      expect.objectContaining({ code: 'limit', clamped: true, bound: 'max', limit: 457.2 }),
    ]);
    expect((mate.warnings[0] as { value: number }).value).toBeCloseTo(600, 9);
    expect(mate.warnings[0]!.message).toMatch(/600\.00 mm, past its maximum of 457\.20 mm/);
    expect(result.instances[1]!.moved).toBe(true);
    const poses = solvedPoses(result);
    expect(Object.keys(poses)).toEqual(['cab', 'drawer']);
    expect(poses.drawer!.translation[2]).toBeCloseTo(457.2, 9);
  });

  it('gives no warning for a pose within the limits', () => {
    const result = solved(200);
    expect(result.mates[0]!.warnings).toEqual([]);
    expect(result.instances[1]!.moved).toBe(false);
    expect(solvedPoses(result).drawer!.translation[2]).toBeCloseTo(200, 9);
  });
});

describe('namedCoordinates', () => {
  it('names each coordinate and says which are angles', () => {
    expect(namedCoordinates('slider', [457.2])).toEqual([
      { name: 'distance', value: 457.2, angular: false },
    ]);
    expect(namedCoordinates('cylindrical', [3, 1])).toEqual([
      { name: 'distance', value: 3, angular: false },
      { name: 'angle', value: 1, angular: true },
    ]);
    expect(namedCoordinates('fastened', [])).toEqual([]);
    // Not solved: no coordinates.
    expect(namedCoordinates('revolute', [])).toEqual([]);
  });
});
