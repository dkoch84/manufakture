// The regen worker's per-body results as the app's part bodies: viewport ids, meshes kept while
// a body is unchanged, and the registry used for measuring, exporting and picking.

import { applyCommand, createDocument } from '@manufakture/core';
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
    assemblies: [],
    sources: [],
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
  it('shows every body of a part as <part>/<body>, and keeps unchanged meshes', async () => {
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
    expect(part.bodies.map((b) => b.view.id)).toEqual(['part#1/extrude#1', 'part#1/extrude#2']);
    expect(part.bodies.map((b) => [b.bodyId, b.creator, b.solids])).toEqual([
      ['extrude#1', 'extrude#1', 1],
      ['extrude#2', 'extrude#2', 1],
    ]);
    // Registered under the names export uses: Body <n> in a part of several bodies.
    expect([...registry]).toEqual([
      ['part#1/extrude#1', { shape: 1, name: 'Body 1', role: 'part' }],
      ['part#1/extrude#2', { shape: 2, name: 'Body 2', role: 'part' }],
    ]);

    const second = (await regen.regen(doc))!;
    expect(second.parts[0]!.bodies[0]!.view).toBe(part.bodies[0]!.view);
    expect(second.parts[0]!.bodies[1]!.view).not.toBe(part.bodies[1]!.view);
    expect(registry.get('part#1/extrude#2')!.shape).toBe(3);

    const third = (await regen.regen(doc))!;
    expect(third.parts[0]!.bodies.map((b) => b.view.id)).toEqual(['part#1/extrude#1']);
    // The only body is named after the part.
    expect([...registry]).toEqual([
      ['part#1/extrude#1', { shape: 4, name: 'Part 1', role: 'part' }],
    ]);
    expect(viewBodyId('part#1', 'extrude#3')).toBe('part#1/extrude#3');
  });

  it('keeps pinned sources like parts, and registers every instance body with its source shape', async () => {
    const instance = (id: string, source: { part: string } | { source: string }) => ({
      instanceId: id,
      status: 'ok' as const,
      source,
      bodies: ['extrude#1'],
      transform: { translation: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const },
      moved: false,
      errors: [],
      warnings: [],
    });
    const withAssembly = (generation: number, meshed: boolean, sources = true): RegenResult => ({
      ...result(generation, [body('extrude#1', 1, meshed)]),
      assemblies: [
        {
          assemblyId: 'assembly#1',
          outcome: 'solved',
          dof: 12,
          instances: [
            instance('inst#1', { part: 'part#1' }),
            ...(sources ? [instance('inst#2', { source: 'source:abc:part#1' })] : []),
          ],
          mates: [],
          redundant: [],
          conflicting: [],
          issues: [],
          warnings: [],
          ms: 0,
        },
      ],
      sources: sources
        ? [
            {
              key: 'source:abc:part#1',
              documentId: 'other',
              documentName: 'Knobs',
              versionId: 'v-1',
              versionName: 'v1',
              partId: 'part#1',
              partName: 'Knob',
              bodies: [body('extrude#1', 7, meshed)],
            },
          ]
        : [],
    });
    const replies = [withAssembly(1, true), withAssembly(2, false), withAssembly(3, false, false)];
    const registry = new Map<string, KernelBody>();
    const regen = kernelRegenerator(() => ({ regen: async () => replies.shift()! }), registry);
    let doc = createDocument({ id: 'd', name: 'D' });
    const r = applyCommand(doc, { type: 'addAssembly', assemblyId: 'assembly#1', name: 'A' });
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;

    const first = (await regen.regen(doc))!;
    expect(first.assemblies).toHaveLength(1);
    expect(first.sources!.map((x) => [x.key, x.documentName, x.versionName])).toEqual([
      ['source:abc:part#1', 'Knobs', 'v1'],
    ]);
    const sourceView = first.sources![0]!.bodies[0]!.view;
    expect(sourceView.id).toBe('source:abc:part#1/extrude#1');
    expect(registry.get('assembly#1/inst#1/extrude#1')).toMatchObject({ shape: 1, role: 'part' });
    expect(registry.get('assembly#1/inst#2/extrude#1')).toMatchObject({ shape: 7, role: 'part' });

    // Unchanged: the source keeps its mesh.
    const second = (await regen.regen(doc))!;
    expect(second.sources![0]!.bodies[0]!.view).toBe(sourceView);

    // The pinned instance is gone: so are its registration and its source's meshes.
    const third = (await regen.regen(doc))!;
    expect(third.sources).toEqual([]);
    expect(registry.has('assembly#1/inst#2/extrude#1')).toBe(false);
    expect(registry.has('assembly#1/inst#1/extrude#1')).toBe(true);
  });

  it('passes every applied result to the member sink, in order, and no superseded one', async () => {
    const replies = [
      result(2, [body('extrude#1', 1, true)]),
      result(1, [body('extrude#1', 1, true)]),
    ];
    const seen: number[] = [];
    const regen = kernelRegenerator(() => ({ regen: async () => replies.shift()! }), new Map(), {
      getState: () => ({
        applyRegen: (r) => seen.push((r as unknown as { generation: number }).generation),
      }),
    });
    const doc = createDocument({ id: 'd', name: 'D' });
    await regen.regen(doc);
    // An older result arriving late is dropped, for members as for bodies.
    expect(await regen.regen(doc)).toBeNull();
    expect(seen).toEqual([2]);
  });
});
