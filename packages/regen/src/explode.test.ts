// Exploded views (T4.5a): the pure offsets first (steps compose in order, the slider's progress,
// what does not resolve), then the engine with the real kernel and solver on the box and lid:
// directions read from an edge or a face at the solved pose, and the solved poses untouched.

import type { ExplodeStep, ExplodedView, ManufaktureDocument, Pose } from '@manufakture/core';
import type { ConnectorReport, KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import {
  explodeTrails,
  explodeWarnings,
  explodedOffsets,
  explodedPose,
  resolveExplodedView,
  stepFraction,
  type ExplodeContext,
} from './explode';
import { ASSEMBLY, apply, boxAndLid, mm, setVariable } from './test-helpers';
import { evaluateVariables } from './values';

const IDENTITY: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
/** A quarter turn about z: x goes to y. */
const QUARTER_Z: Pose = {
  translation: [5, 0, 0],
  rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
};

function step(id: string, instances: string[], direction: ExplodeStep['direction'], d: string) {
  return { id, instances, direction, distance: mm(d) };
}

function view(...steps: ExplodeStep[]): ExplodedView {
  return { id: 'explode#1', name: 'Exploded', steps };
}

function context(extra: Partial<ExplodeContext> = {}): ExplodeContext {
  return {
    variables: evaluateVariables([]),
    instances: new Set(['inst#1', 'inst#2', 'inst#3']),
    poses: new Map([
      ['inst#1', IDENTITY],
      ['inst#2', QUARTER_Z],
      ['inst#3', IDENTITY],
    ]),
    ...extra,
  };
}

function near(a: readonly number[] | undefined, b: readonly number[], eps = 1e-9): boolean {
  return a !== undefined && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < eps);
}

describe('exploded offsets', () => {
  it('composes steps in order: an instance moved twice ends at the sum of both moves', () => {
    const v = resolveExplodedView(
      view(
        step('step#1', ['inst#2', 'inst#3'], { vector: [0, 0, 2] }, '10'),
        step('step#2', ['inst#3'], { vector: [3, 0, 0] }, '4'),
      ),
      context(),
    );
    expect(explodeWarnings(v)).toEqual([]);
    // Directions are unit vectors, whatever length was written.
    expect(v.steps[0]!.direction).toEqual([0, 0, 1]);
    const offsets = explodedOffsets(v);
    expect(offsets.get('inst#1')).toBeUndefined();
    expect(offsets.get('inst#2')).toEqual([0, 0, 10]);
    expect(offsets.get('inst#3')).toEqual([4, 0, 10]);
    expect(explodedPose(QUARTER_Z, offsets.get('inst#2'))).toEqual({
      translation: [5, 0, 10],
      rotation: QUARTER_Z.rotation,
    });
    expect(explodedPose(IDENTITY, undefined)).toBe(IDENTITY);
  });

  it('plays the steps one after another as the slider goes from assembled to exploded', () => {
    expect([0, 0.25, 0.5, 0.75, 1].map((p) => stepFraction(p, 2, 0))).toEqual([0, 0.5, 1, 1, 1]);
    expect([0, 0.25, 0.5, 0.75, 1].map((p) => stepFraction(p, 2, 1))).toEqual([0, 0, 0, 0.5, 1]);
    expect(stepFraction(2, 2, 1)).toBe(1);
    expect(stepFraction(-1, 2, 0)).toBe(0);
    const v = resolveExplodedView(
      view(
        step('step#1', ['inst#3'], { vector: [0, 0, 1] }, '10'),
        step('step#2', ['inst#3'], { vector: [1, 0, 0] }, '4'),
      ),
      context(),
    );
    expect(explodedOffsets(v, 0).size).toBe(0);
    expect(explodedOffsets(v, 0.25).get('inst#3')).toEqual([0, 0, 5]);
    expect(explodedOffsets(v, 0.75).get('inst#3')).toEqual([2, 0, 10]);
    // Trails: each step from where the one before left the instance.
    expect(explodeTrails(v, 0.75)).toEqual([
      { stepId: 'step#1', instanceId: 'inst#3', from: [0, 0, 0], to: [0, 0, 10] },
      { stepId: 'step#2', instanceId: 'inst#3', from: [0, 0, 10], to: [2, 0, 10] },
    ]);
    expect(explodeTrails(v, 0)).toEqual([]);
  });

  it('warns about a step naming a deleted instance and still moves the others', () => {
    const v = resolveExplodedView(
      view(step('step#1', ['inst#9', 'inst#2'], { vector: [1, 0, 0] }, '7')),
      context(),
    );
    expect(v.steps[0]!.instances).toEqual(['inst#2']);
    expect(v.steps[0]!.warnings).toEqual([
      expect.objectContaining({ code: 'missing-instance', instances: ['inst#9'] }),
    ]);
    expect(explodedOffsets(v).get('inst#2')).toEqual([7, 0, 0]);
  });

  it('skips suppressed instances without a warning', () => {
    const poses = new Map([['inst#1', IDENTITY]]);
    const v = resolveExplodedView(
      view(step('step#1', ['inst#1', 'inst#2'], { vector: [1, 0, 0] }, '7')),
      context({ poses }),
    );
    expect(v.steps[0]!.instances).toEqual(['inst#1']);
    expect(v.steps[0]!.warnings).toEqual([]);
  });

  it('makes a distance that does not evaluate a warning, and the step moves nothing', () => {
    const variables = evaluateVariables([{ name: 'gap', expression: mm('12') }]);
    const v = resolveExplodedView(
      view(
        step('step#1', ['inst#1'], { vector: [1, 0, 0] }, 'nope + 1'),
        step('step#2', ['inst#1'], { vector: [0, 1, 0] }, 'gap * 2'),
      ),
      context({ variables }),
    );
    expect(v.steps[0]!.distance).toBeNull();
    expect(v.steps[0]!.warnings[0]!.code).toBe('expression');
    expect(v.steps[1]!.distance).toBe(24);
    expect(explodedOffsets(v).get('inst#1')).toEqual([0, 24, 0]);
  });

  it("reads an edge or face direction at its instance's solved pose, and flips it", () => {
    const report: ConnectorReport = {
      ok: true,
      frame: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [2, 0, 0] },
      kind: 'edge',
      index: 1,
      via: 'exact',
      fragile: false,
      oriented: true,
    };
    const edge = { faces: ['a', 'b'] };
    const v = resolveExplodedView(
      view(
        step('step#1', ['inst#1'], { instance: 'inst#2', edge }, '10'),
        step('step#2', ['inst#3'], { instance: 'inst#2', edge, flip: true }, '10'),
      ),
      context({ direction: () => report }),
    );
    // inst#2 is turned a quarter about z, so its local x points along world y.
    expect(near(v.steps[0]!.direction!, [0, 1, 0])).toBe(true);
    expect(near(v.steps[1]!.direction!, [0, -1, 0])).toBe(true);
    expect(near(explodedOffsets(v).get('inst#1'), [0, 10, 0])).toBe(true);
  });

  it('makes a direction that does not resolve a warning on its step, never a failure', () => {
    const lost: ConnectorReport = {
      ok: false,
      status: 'lost',
      missing: ['b'],
      message: 'b is lost',
    };
    const fragile: ConnectorReport = {
      ok: true,
      frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
      kind: 'face',
      index: 1,
      via: 'ordinal',
      fragile: true,
      oriented: true,
    };
    const v = resolveExplodedView(
      view(
        step('step#1', ['inst#1'], { instance: 'inst#2', face: { face: 'b' } }, '10'),
        step('step#2', ['inst#1'], { instance: 'inst#9', face: { face: 'b' } }, '10'),
        step('step#3', ['inst#3'], { instance: 'inst#1', face: { face: 'c' } }, '10'),
      ),
      context({
        direction: (s) => (s.id === 'step#1' ? lost : s.id === 'step#3' ? fragile : undefined),
      }),
    );
    expect(v.steps.map((s) => s.direction === null)).toEqual([true, true, false]);
    expect(v.steps.map((s) => s.warnings.map((w) => w.code))).toEqual([
      ['direction'],
      ['direction'],
      ['reference'],
    ]);
    expect(v.steps[0]!.warnings[0]).toMatchObject({ reason: 'lost' });
    expect(v.steps[1]!.warnings[0]).toMatchObject({ reason: 'missing-instance' });
    expect(explodedOffsets(v).get('inst#1')).toBeUndefined();
    expect(explodedOffsets(v).get('inst#3')).toEqual([0, 0, 10]);
  });
});

describe('exploded views in the engine (real kernel and solver)', () => {
  let service: KernelService;
  let solver: SolverService;

  beforeAll(async () => {
    service = await createNodeService();
    solver = createSolverService();
  }, 60_000);

  afterAll(async () => {
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  function exploded(doc: ManufaktureDocument, steps: ExplodeStep[]): ManufaktureDocument {
    return apply(doc, {
      type: 'addExplodedView',
      assemblyId: ASSEMBLY,
      explodedView: { id: 'explode#1', name: 'Exploded', steps },
    });
  }

  it('resolves an edge and a face of an instance at its solved pose, leaving the poses alone', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const assembled = boxAndLid();
    const plain = (await engine.regen(assembled))!.assemblies![0]!;
    const doc = exploded(assembled, [
      // Up along the lid's top face normal (the lid lies on the box at z 20).
      step('step#1', ['inst#2'], { instance: 'inst#2', face: { face: 'extrude#1:cap:end' } }, '30'),
      // Along the box's back top edge, flipped: cap:end x side:e3 runs along -x, so +x.
      step(
        'step#2',
        ['inst#2'],
        {
          instance: 'inst#1',
          edge: { faces: ['extrude#1:cap:end', 'extrude#1:side:e3'] },
          flip: true,
        },
        '5',
      ),
    ]);
    const asm = (await engine.regen(doc))!.assemblies![0]!;
    expect(asm.instances.map((x) => x.transform)).toEqual(plain.instances.map((x) => x.transform));
    // The document's stored poses are not touched by regen.
    expect(doc.assemblies[0]!.instances.map((x) => x.pose)).toEqual(
      assembled.assemblies[0]!.instances.map((x) => x.pose),
    );
    const v = asm.explodedViews![0]!;
    expect(explodeWarnings(v)).toEqual([]);
    expect(near(v.steps[0]!.direction!, [0, 0, 1])).toBe(true);
    expect(near(v.steps[1]!.direction!, [1, 0, 0])).toBe(true);
    expect(near(explodedOffsets(v).get('inst#2'), [5, 0, 30])).toBe(true);
    const lid = asm.instances[1]!.transform;
    expect(near(explodedPose(lid, explodedOffsets(v).get('inst#2')).translation, [5, 0, 50])).toBe(
      true,
    );

    // A face the lid no longer has: a warning on the step, and the rest still applies.
    const lost = exploded(assembled, [
      step('step#1', ['inst#2'], { instance: 'inst#2', face: { face: 'extrude#1:side:e9' } }, '30'),
      step('step#2', ['inst#2'], { vector: [0, 0, 1] }, '8'),
    ]);
    const lostAsm = (await engine.regen(lost))!.assemblies![0]!;
    expect(lostAsm.outcome).toBe('solved');
    const lv = lostAsm.explodedViews![0]!;
    expect(lv.steps[0]!.warnings[0]).toMatchObject({ code: 'direction', reason: 'lost' });
    expect(explodedOffsets(lv).get('inst#2')).toEqual([0, 0, 8]);
    await engine.dispose();
  });

  it('reads step distances from variables, and warns about a step naming a deleted instance', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = apply(boxAndLid(), setVariable('gap', '15'));
    doc = exploded(doc, [step('step#1', ['inst#2'], { vector: [0, 0, 1] }, 'gap * 2')]);
    let v = (await engine.regen(doc))!.assemblies![0]!.explodedViews![0]!;
    expect(explodedOffsets(v).get('inst#2')).toEqual([0, 0, 30]);
    doc = apply(doc, setVariable('gap', '20'));
    v = (await engine.regen(doc))!.assemblies![0]!.explodedViews![0]!;
    expect(explodedOffsets(v).get('inst#2')).toEqual([0, 0, 40]);
    // Core refuses to delete an instance a step names, so only a hand-made document has one.
    const asm = doc.assemblies[0]!;
    const handMade: ManufaktureDocument = {
      ...doc,
      assemblies: [
        {
          ...asm,
          explodedViews: [view(step('step#1', ['inst#7', 'inst#2'], { vector: [0, 0, 1] }, '9'))],
        },
      ],
    };
    const r = (await engine.regen(handMade))!.assemblies![0]!;
    expect(r.outcome).toBe('solved');
    const hv = r.explodedViews![0]!;
    expect(hv.steps[0]!.warnings).toEqual([
      expect.objectContaining({ code: 'missing-instance', instances: ['inst#7'] }),
    ]);
    expect(explodedOffsets(hv).get('inst#2')).toEqual([0, 0, 9]);
    await engine.dispose();
  });
});
