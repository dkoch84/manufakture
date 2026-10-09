// The pure halves of assemblies in regen: choosing one connector report among an instance's
// bodies, and turning a solve into results (limit warnings, solved poses). The engine's use of them is in engine.test.ts (fake kernel) and integration.test.ts.

import { solve, type Pose } from '@manufakture/assembly';
import type { ConnectorReport } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import type { Assembly, Mate } from '@manufakture/core';
import {
  applyReport,
  connectorFrames,
  emptyAssemblyResult,
  namedCoordinates,
  pickReport,
  posedMates,
  resultSolverInput,
  solvedPoses,
  sweepPoses,
} from './assembly';
import type { AssemblyResult, InstanceResult, MateResult } from './types';
import { evaluateVariables } from './values';

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

describe('connectorFrames', () => {
  it("gives each connector's frame in world coordinates at its instance's solved pose", () => {
    const h = Math.SQRT1_2;
    const result = emptyAssemblyResult('assembly#1');
    const inst = (id: string, transform: InstanceResult['transform']): InstanceResult => ({
      instanceId: id,
      status: 'ok',
      source: { part: 'part#1' },
      bodies: [],
      transform,
      moved: false,
      errors: [],
      warnings: [],
    });
    // The cabinet turned a quarter about world x and lifted; the drawer where it is.
    result.instances.push(
      inst('cab', { translation: [0, 0, 10], rotation: [h, 0, 0, h] }),
      inst('drawer', { translation: [5, 0, 0], rotation: [0, 0, 0, 1] }),
    );
    result.mates.push({
      mateId: 'mate#1',
      status: 'ok',
      coordinates: [0],
      residual: null,
      connectors: [
        {
          connectorId: 'mc#1',
          instanceId: 'cab',
          frame: { translation: [0, 1, 0], rotation: [0, 0, 0, 1] },
          reference: null,
        },
        { connectorId: 'mc#2', instanceId: 'drawer', frame: null, reference: null },
      ],
      errors: [],
      warnings: [],
    });
    const frames = connectorFrames(result, 'mate#1', 'slider')!;
    expect(frames.b).toBeNull();
    expect(frames.motion).toEqual([{ coordinate: 'distance', axis: 'z', angular: false }]);
    const a = frames.a!;
    expect(a).toMatchObject({ connectorId: 'mc#1', instanceId: 'cab' });
    const near = (v: readonly number[], w: number[]) =>
      v.forEach((c, i) => expect(c).toBeCloseTo(w[i]!, 12));
    // The frame's origin (0, 1, 0) in the cabinet turns to (0, 0, 1), then lifts by 10.
    near(a.origin, [0, 0, 11]);
    near(a.x, [1, 0, 0]);
    near(a.y, [0, 0, 1]);
    near(a.z, [0, -1, 0]);
    expect(connectorFrames(result, 'mate#9', 'slider')).toBeUndefined();
  });
});

describe('sweeps over a mate from a regen result', () => {
  const I: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });
  const connector = (id: string, instance: string) => ({
    id,
    instance,
    inference: 'centroid' as const,
    origin: { id: `r${id}`, ref: { face: 'f' } },
  });
  const mateOf = (id: string, kind: Mate['kind'], a: string, b: string, extra = {}): Mate =>
    ({
      id,
      name: id,
      kind,
      suppressed: false,
      a: connector(`${id}a`, a),
      b: connector(`${id}b`, b),
      ...extra,
    }) as Mate;
  const assembly = {
    id: 'assembly#1',
    name: 'Drawer',
    instances: [
      {
        id: 'cab',
        name: 'Cabinet',
        source: { part: 'p' },
        fixed: true,
        suppressed: false,
        pose: I,
      },
      {
        id: 'drawer',
        name: 'Drawer',
        source: { part: 'p' },
        fixed: false,
        suppressed: false,
        pose: I,
      },
      { id: 'knob', name: 'Knob', source: { part: 'p' }, fixed: false, suppressed: false, pose: I },
      { id: 'off', name: 'Off', source: { part: 'p' }, fixed: false, suppressed: true, pose: I },
    ],
    mates: [
      mateOf('mate#1', 'slider', 'cab', 'drawer', { limits: { min: mm('0'), max: mm('#travel') } }),
      mateOf('mate#2', 'fastened', 'drawer', 'knob'),
      mateOf('mate#3', 'fastened', 'drawer', 'off'),
    ],
    nextIds: {},
  } as unknown as Assembly;
  const variables = evaluateVariables([
    { name: 'travel', expression: mm('400') } as unknown as Parameters<
      typeof evaluateVariables
    >[0][number],
  ]);

  function result(): AssemblyResult {
    const r = emptyAssemblyResult('assembly#1');
    const inst = (
      id: string,
      z: number,
      status: InstanceResult['status'] = 'ok',
    ): InstanceResult => ({
      instanceId: id,
      status,
      source: { part: 'p' },
      bodies: [],
      transform: { translation: [0, 0, z], rotation: [0, 0, 0, 1] },
      moved: false,
      errors: [],
      warnings: [],
    });
    r.instances.push(
      inst('cab', 0),
      inst('drawer', 100),
      inst('knob', 105),
      inst('off', 0, 'suppressed'),
    );
    const m = (
      id: string,
      a: string,
      b: string,
      bFrame: Pose,
      status: MateResult['status'] = 'ok',
    ): MateResult => ({
      mateId: id,
      status,
      coordinates: [],
      residual: null,
      connectors: [
        { connectorId: `${id}a`, instanceId: a, frame: I, reference: null },
        { connectorId: `${id}b`, instanceId: b, frame: bFrame, reference: null },
      ],
      errors: [],
      warnings: [],
    });
    // The knob's connector is 5 below its origin, so the fastened mate holds it 5 above the drawer.
    r.mates.push(
      m('mate#1', 'cab', 'drawer', I),
      m('mate#2', 'drawer', 'knob', { translation: [0, 0, -5], rotation: [0, 0, 0, 1] }),
      m('mate#3', 'drawer', 'off', I, 'suppressed'),
    );
    return r;
  }

  it('rebuilds the solver input at the solved poses, limits evaluated', () => {
    const input = resultSolverInput(assembly, result(), variables);
    expect(input.instances.map((i) => [i.id, i.fixed, i.pose.translation[2]])).toEqual([
      ['cab', true, 0],
      ['drawer', false, 100],
      ['knob', false, 105],
    ]);
    expect(input.mates.map((m) => m.id)).toEqual(['mate#1', 'mate#2']);
    expect(input.mates[0]!.limits).toEqual({ min: 0, max: 400 });
  });

  it('poses the instances at each value of the travel, the fastened knob following', () => {
    const input = resultSolverInput(assembly, result(), variables);
    const steps = sweepPoses(input, 'mate#1', [0, 200, 450]);
    expect(steps.map((s) => s.value)).toEqual([0, 200, 450]);
    expect(steps.map((s) => s.poses!.drawer!.translation[2])).toEqual([
      expect.closeTo(0, 9),
      expect.closeTo(200, 9),
      expect.closeTo(450, 9),
    ]);
    expect(steps[1]!.poses!.knob!.translation[2]).toBeCloseTo(205, 9);
    expect(steps[1]!.poses!.cab).toEqual(I);
  });

  it('reads the mates at hand-made poses: past a limit, off a mate', () => {
    const input = resultSolverInput(assembly, result(), variables);
    const checks = posedMates(input, {
      drawer: { translation: [0, 0, 500], rotation: [0, 0, 0, 1] },
    });
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      mateId: 'mate#1',
      kind: 'slider',
      coordinates: [{ name: 'distance', value: expect.closeTo(500, 9), angular: false }],
      outsideLimits: { bound: 'max', limit: 400, value: expect.closeTo(500, 9) },
    });
    // The knob stayed at 105 while the drawer went to 500: 400 mm off its fastened mate.
    expect(checks[1]!.mateId).toBe('mate#2');
    expect(checks[1]!.residual.position).toBeCloseTo(400, 9);
    expect(checks[1]!.outsideLimits).toBeNull();
  });
});
