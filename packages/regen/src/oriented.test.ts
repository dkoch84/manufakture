// Oriented sizes on request (T4.3d) with the real kernel and solver: a panel extruded on a plane
// turned 30 degrees about z gets its exact sizes (its axis-aligned box is larger), a board made by
// an extension type the request skips is never sent to the `obb` op, and asking again for the
// same bodies is a cache hit that sends nothing.

import type { ExtensionFeature, SketchPlane } from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { ExtensionRegistry, type ExtensionType } from './extensions';
import { OrientedCache } from './oriented';
import { PART, add, apply, build, extrude, mm, rectangle, setVariable } from './test-helpers';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

/** A fake board: its sketch extruded by its `thickness`, as `domain-wood` builds a panel. */
const board: ExtensionType<{ sketch: string }> = {
  schemaVersion: 1,
  expressions: { thickness: 'length' },
  translate(ctx) {
    const profile = ctx.profile(ctx.params.sketch);
    if (!profile.ok) return { error: profile.message };
    return {
      inputs: [
        {
          kind: 'extrude',
          id: ctx.feature.id,
          profile: profile.value,
          extent: { type: 'blind', distance: ctx.values.thickness! },
          mode: 'new',
        },
      ],
    };
  },
};

const boardFeature: ExtensionFeature = {
  id: 'extension#1',
  kind: 'extension',
  name: 'Shelf',
  suppressed: false,
  extension: 'fake.board',
  schemaVersion: 1,
  dependsOn: ['sketch#1'],
  references: [],
  expressions: { thickness: mm('18') },
  params: { sketch: 'sketch#1' },
  operation: 'new',
};

const c = Math.cos(Math.PI / 6);
const s = Math.sin(Math.PI / 6);
/** The XY plane turned 30 degrees about z, lifted clear of the board. */
const TURNED: SketchPlane = {
  type: 'plane',
  origin: [0, 0, 100],
  normal: [0, 0, 1],
  xDir: [c, s, 0],
};

function engineWithBoards(): RegenEngine {
  const extensions = new ExtensionRegistry();
  extensions.registerDomain({
    namespace: 'fake',
    implementation: 1,
    types: { 'fake.board': board as ExtensionType },
  });
  return new RegenEngine({ kernel: service, solver, extensions });
}

function document(panelWidth = '300') {
  return build([
    setVariable('w', panelWidth),
    add(rectangle('sketch#1', { width: '400', depth: '250' })),
    add(boardFeature),
    add(
      rectangle('sketch#2', {
        width: 'w',
        depth: '200',
        plane: TURNED,
        ids: ['e5', 'e6', 'e7', 'e8'],
        firstConstraint: 12,
      }),
    ),
    add(extrude('extrude#1', 'sketch#2', '18')),
  ]);
}

describe('orientedSizes with the real kernel', () => {
  it('sizes a turned panel exactly, skips boards, and answers a second request from the cache', async () => {
    const engine = engineWithBoards();
    const doc = document();
    const regen = (await engine.regen(doc))!;
    expect(regen.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extension#1', 'extrude#1']);

    const first = (await engine.orientedSizes(doc, PART, { skipExtensions: ['fake.board'] }))!;
    expect(first.missing).toEqual([]);
    expect(first.failures).toEqual([]);
    expect(first.sizes.map((x) => x.bodyId)).toEqual(['extrude#1']);
    const [length, width, thickness] = first.sizes[0]!.sizes;
    expect(length).toBeCloseTo(300, 6);
    expect(width).toBeCloseTo(200, 6);
    expect(thickness).toBeCloseTo(18, 6);
    // Only the panel went to the kernel: the board was not sent.
    expect(engine.orientedStats).toEqual({ obbOps: 1, obbHits: 0 });

    const second = (await engine.orientedSizes(doc, PART, { skipExtensions: ['fake.board'] }))!;
    expect(second.sizes).toEqual(first.sizes);
    expect(engine.orientedStats).toEqual({ obbOps: 1, obbHits: 1 });

    // Without the skip, and naming bodies: the board is measured too; a body the part does not
    // have is reported missing.
    const named = (await engine.orientedSizes(doc, PART, {
      bodies: ['extension#1', 'nope#1'],
    }))!;
    expect(named.missing).toEqual(['nope#1']);
    expect(named.sizes.map((x) => x.bodyId)).toEqual(['extension#1']);
    expect(named.sizes[0]!.sizes[0]).toBeCloseTo(400, 6);
    expect(engine.orientedStats.obbOps).toBe(2);

    // A wider panel is a new body key: measured again.
    const wider = apply(doc, setVariable('w', '320'));
    await engine.regen(wider);
    const third = (await engine.orientedSizes(wider, PART, { skipExtensions: ['fake.board'] }))!;
    expect(third.sizes[0]!.sizes[0]).toBeCloseTo(320, 6);
    expect(engine.orientedStats.obbOps).toBe(3);

    await expect(engine.orientedSizes(doc, 'part#99')).rejects.toThrow(/no part/);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('answers null when a newer regen supersedes the request', async () => {
    const engine = engineWithBoards();
    const doc = document();
    await engine.regen(doc);
    const stale = engine.orientedSizes(doc, PART, { generation: engine.generation - 1 });
    expect(await stale).toBeNull();
    await engine.dispose();
  });
});

describe('the oriented sizes cache', () => {
  it('drops the least recently used entry beyond its limit', () => {
    const cache = new OrientedCache(2);
    const box = (n: number) => ({
      center: [0, 0, 0] as [number, number, number],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as const,
      halfSizes: [n / 2, 1, 1] as [number, number, number],
      sizes: [n, 2, 2] as [number, number, number],
      source: 'obb' as const,
    });
    cache.set('a', box(10));
    cache.set('b', box(20));
    expect(cache.get('a')?.sizes[0]).toBe(10);
    cache.set('c', box(30));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.size).toBe(2);
  });
});
