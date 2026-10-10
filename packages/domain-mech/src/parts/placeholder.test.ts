// The `mech.placeholder` feature: its params, its kernel input per shape, its refusals, and a
// placed part through regen with the real kernel (libcascade in Node): the solid's volume, a
// mass-free reference body that measures, and a feature error for a size it will not build.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenSolver } from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerMech } from '../domain';
import { builtinRef, latestBuiltin } from './catalog';
import { placePurchasedPart } from './place';
import {
  MAX_PLACEHOLDER_SIZE,
  placeholderDrift,
  placeholderFeature,
  placeholderInput,
  readPlaceholderParams,
} from './placeholder';

const REF = { source: 'builtin', id: 'bearing/skf-6005-2rsh', version: 1 } as const;

describe('placeholder params', () => {
  it('reads a reference, a shape and an axis (z by default)', () => {
    expect(readPlaceholderParams({ entry: REF, shape: 'ring' }, 1)).toEqual({
      ok: true,
      value: { entry: REF, shape: 'ring', axis: 'z' },
    });
  });

  it('refuses unknown fields, bad references and shapes, and newer versions', () => {
    expect(readPlaceholderParams({ entry: REF, shape: 'ring', colour: 'red' }, 1)).toMatchObject({
      ok: false,
      field: ['colour'],
    });
    expect(
      readPlaceholderParams(
        { entry: { source: 'builtin', id: 'Bad Id', version: 1 }, shape: 'box' },
        1,
      ),
    ).toMatchObject({ ok: false, field: ['entry'] });
    expect(readPlaceholderParams({ entry: REF, shape: 'sphere' }, 1)).toMatchObject({
      ok: false,
      field: ['shape'],
    });
    expect(readPlaceholderParams({ entry: REF, shape: 'box', axis: 'w' }, 1)).toMatchObject({
      ok: false,
      field: ['axis'],
    });
    expect(readPlaceholderParams({ entry: REF, shape: 'box' }, 2)).toMatchObject({ ok: false });
  });
});

describe('placeholder input', () => {
  const params = (shape: 'cylinder' | 'ring' | 'box', axis: 'x' | 'y' | 'z' = 'z') => ({
    entry: REF,
    shape,
    axis,
  });

  it('builds a ring as two circles, a cylinder as one, a box as four lines', () => {
    const ring = placeholderInput('extension#1', params('ring', 'x'), {
      outerDiameter: 47,
      innerDiameter: 25,
      width: 12,
    });
    expect(ring).toMatchObject({
      kind: 'extrude',
      id: 'extension#1',
      mode: 'new',
      extent: { type: 'blind', distance: 12 },
      profile: {
        frame: { normal: [1, 0, 0] },
        loops: [
          { entities: [{ kind: 'circle', radius: 23.5 }] },
          { entities: [{ kind: 'circle', radius: 12.5 }] },
        ],
      },
    });
    const cyl = placeholderInput('extension#1', params('cylinder'), { diameter: 63, length: 74 });
    expect(cyl).toMatchObject({
      extent: { distance: 74 },
      profile: { loops: [{ entities: [{ radius: 31.5 }] }] },
    });
    const box = placeholderInput('extension#1', params('box', 'y'), {
      length: 10,
      width: 6,
      height: 4,
    });
    expect(box).toMatchObject({
      extent: { distance: 4 },
      profile: { frame: { normal: [0, 1, 0] } },
    });
    expect(
      'profile' in box && 'loops' in box.profile && box.profile.loops[0]!.entities,
    ).toHaveLength(4);
  });

  it('refuses missing, zero, huge and inverted sizes', () => {
    expect(placeholderInput('e', params('box'), { length: 1, width: 1 })).toMatchObject({
      error: /height/,
    });
    expect(placeholderInput('e', params('box'), { length: 1, width: 0, height: 1 })).toMatchObject({
      error: /above zero/,
      field: ['expressions', 'width'],
    });
    expect(
      placeholderInput('e', params('cylinder'), { diameter: MAX_PLACEHOLDER_SIZE + 1, length: 1 }),
    ).toMatchObject({ error: /over/ });
    expect(
      placeholderInput('e', params('ring'), { outerDiameter: 10, innerDiameter: 12, width: 1 }),
    ).toMatchObject({ error: /inner diameter/ });
  });

  it('makes the feature from an entry and says when the entry has moved on', () => {
    const entry = latestBuiltin('bearing/skf-6005-2rsh')!;
    const made = placeholderFeature('extension#1', REF, entry, 'Bearing');
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const doc = createDocument({ id: 'd', name: 'D' });
    expect(placeholderDrift(doc, made.feature)).toEqual([]);
    const edited: ExtensionFeature = {
      ...made.feature,
      expressions: {
        ...made.feature.expressions,
        width: { source: '13 mm', lengthUnit: 'mm', angleUnit: 'deg' },
      },
    };
    expect(placeholderDrift(doc, edited)).toEqual([
      'width: 13.00 mm; bearing/skf-6005-2rsh v1 gives 12.00 mm',
    ]);
  });
});

// Through regen with the real kernel -------------------------------------------------------------

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

/** No sketches here: a solver that is never asked. */
const NO_SOLVER = {
  solve: () => {
    throw new Error('no sketches in these tests');
  },
} as unknown as RegenSolver;

function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

async function withEngine(run: (engine: RegenEngine) => Promise<void>) {
  const extensions = new ExtensionRegistry();
  registerMech(extensions);
  const engine = new RegenEngine({ kernel: service, solver: NO_SOLVER, extensions });
  try {
    await run(engine);
  } finally {
    await engine.dispose();
    await service.idle();
  }
  expect(service.leaks()).toEqual([]);
}

describe('mech.placeholder through regen', () => {
  it('builds the bearing ring with the volume of its dimensions, and refuses a bad size', async () => {
    let doc = createDocument({ id: 'doc-ph', name: 'Placeholders' });
    doc = apply(doc, { type: 'addAssembly', assemblyId: 'assembly#1', name: 'A' });
    const placed = await placePurchasedPart(doc, builtinRef('bearing/skf-6005-2rsh')!, {
      assemblyId: 'assembly#1',
    });
    if (!placed.ok) throw new Error(placed.message);
    doc = apply(doc, placed.command);
    await withEngine(async (engine) => {
      const result = await engine.regen(doc);
      if (result === null) throw new Error('superseded');
      const part = result.parts.find((p) => p.partId === placed.partId)!;
      const f = part.features.find((x) => x.featureId === 'extension#1')!;
      expect(f.status, JSON.stringify(f.errors)).toBe('ok');
      expect(f.metadata).toMatchObject({ kind: 'placeholder', shape: 'ring' });
      expect(part.bodies.map((b) => b.bodyId)).toEqual(['extension#1']);
      const reply = await service.run({
        generation: engine.generation,
        ops: [{ op: 'properties', shape: part.bodies[0]!.shape }],
      });
      const r = reply.results[0]!;
      if (!r.ok) throw new Error(r.error.message);
      const volume = (r.value as { volume: number }).volume;
      expect(volume).toBeCloseTo((Math.PI / 4) * (47 ** 2 - 25 ** 2) * 12, 0);
      expect(result.assemblies[0]?.instances.length).toBe(1);

      const feature = doc.parts[1]!.features[0] as ExtensionFeature;
      const bad = apply(doc, {
        type: 'editFeature',
        partId: placed.partId,
        feature: {
          ...feature,
          expressions: {
            ...feature.expressions,
            innerDiameter: { source: '50 mm', lengthUnit: 'mm', angleUnit: 'deg' },
          },
        },
      });
      const again = await engine.regen(bad);
      const fb = again!.parts.find((p) => p.partId === placed.partId)!.features[0]!;
      expect(fb.status).toBe('error');
      expect(JSON.stringify(fb.errors)).toMatch(/inner diameter must be less than the outer/);
    });
  }, 60_000);
});
