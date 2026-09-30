// The regen worker's per-body results as the app's part bodies: viewport ids, meshes kept while
// a body is unchanged, and the registry used for measuring, exporting and picking.

import { createDocument } from '@manufakture/core';
import type { ShapeId } from '@manufakture/kernel';
import type { BodyResult, RegenResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import type { KernelBody } from '../io/exchange';
import { boxBody } from '../viewport/testMeshes';
import { kernelRegenerator, viewBodyId } from './kernelModel';

const box = boxBody();

function body(bodyId: string, shape: number, meshed: boolean): BodyResult {
  return {
    bodyId,
    creator: bodyId,
    shape: shape as ShapeId,
    bodyKey: `${bodyId}@${shape}`,
    solids: 1,
    meshChanged: meshed,
    mesh: meshed ? box.mesh : null,
    topology: meshed ? (box.topology ?? null) : null,
  };
}

function result(generation: number, bodies: BodyResult[]): RegenResult {
  return {
    generation,
    names: [...box.names],
    parts: [{ partId: 'part#1', features: [], dirty: [], bodies, consumed: [] }],
    counters: {
      featureOps: 0,
      otherOps: 0,
      batches: 0,
      solves: 0,
      cacheHits: 0,
      cacheMisses: 0,
    },
    ms: 0,
  };
}

describe('kernelRegenerator', () => {
  it('shows every body of a part, the first under the part id, and keeps unchanged meshes', async () => {
    const replies = [
      result(1, [body('extrude#1', 1, true), body('extrude#2', 2, true)]),
      // Only body 2 changed.
      result(2, [body('extrude#1', 1, false), body('extrude#2', 3, true)]),
      // Body 2 was merged away.
      result(3, [body('extrude#1', 4, true)]),
    ];
    const registry = new Map<string, KernelBody>();
    const regen = kernelRegenerator(() => ({ regen: async () => replies.shift()! }), registry);
    const doc = createDocument({ id: 'd', name: 'D' });

    const first = (await regen.regen(doc))!;
    const part = first.parts[0]!;
    expect(part.bodies!.map((b) => b.id)).toEqual(['part#1', 'part#1/extrude#2']);
    expect(part.body).toBe(part.bodies![0]);
    expect([...registry]).toEqual([
      ['part#1', { shape: 1, name: 'Part 1', role: 'part' }],
      ['part#1/extrude#2', { shape: 2, name: 'Part 1 extrude#2', role: 'part' }],
    ]);

    const second = (await regen.regen(doc))!;
    expect(second.parts[0]!.bodies![0]).toBe(part.bodies![0]);
    expect(second.parts[0]!.bodies![1]).not.toBe(part.bodies![1]);
    expect(registry.get('part#1/extrude#2')!.shape).toBe(3);

    const third = (await regen.regen(doc))!;
    expect(third.parts[0]!.bodies!.map((b) => b.id)).toEqual(['part#1']);
    expect([...registry.keys()]).toEqual(['part#1']);
    expect(viewBodyId('part#1', 'extrude#3', false)).toBe('part#1/extrude#3');
  });
});
