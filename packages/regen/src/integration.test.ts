// End to end in Node: the real kernel service (libcascade through its node harness) and the real
// planegcs solver, driven by a core DocumentStore. Counts come from the engine's counters (kernel
// `feature` ops sent, solves, cache hits), so "only the last feature was rebuilt" is asserted on
// what actually went to the kernel.

import { createHash } from 'node:crypto';
import { DocumentStore, type ChangeEvent, type ImportFeature } from '@manufakture/core';
import type { KernelService, MeshData, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine, type RegenKernel } from './engine';
import { add, block, setVariable, statuses, unwrap } from './test-helpers';
import type { RegenResult } from './types';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

const ROUND = 'fillet#1:round:r1';

/** Bounding box of the triangles of one named face. */
function faceBox(result: RegenResult, mesh: MeshData, name: string) {
  const slot = result.names.indexOf(name);
  expect(slot, `${name} in the name table`).toBeGreaterThanOrEqual(0);
  const face = Array.from(mesh.faceNames).indexOf(slot);
  expect(face, `${name} on a face`).toBeGreaterThanOrEqual(0);
  const first = mesh.faceRanges[2 * face]!;
  const count = mesh.faceRanges[2 * face + 1]!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = first; i < first + count; i++) {
    const v = mesh.indices[i]!;
    for (let c = 0; c < 3; c++) {
      const x = mesh.positions[3 * v + c]!;
      min[c] = Math.min(min[c]!, x);
      max[c] = Math.max(max[c]!, x);
    }
  }
  return { min, max };
}

async function volume(engine: RegenEngine, shape: ShapeId): Promise<number> {
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'properties', shape }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

/** The block minus a vertical fillet of radius r along its 20 mm height. */
const blockVolume = (w: number, d: number, r: number) =>
  w * d * 20 - (r * r - (Math.PI * r * r) / 4) * 20;

describe('regen with the real kernel and solver', () => {
  it('builds the block, rebuilds only the fillet for its variable, and keeps the fillet on its edge through a sketch edit', async () => {
    const store = unwrap(DocumentStore.create(block()));
    const engine = new RegenEngine({ kernel: service, solver });
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));

    // First regen: everything is built.
    const first = (await engine.regen(store.document))!;
    expect(statuses(first)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(first.counters).toMatchObject({
      featureOps: 2,
      solves: 1,
      cacheHits: 0,
      cacheMisses: 3,
    });
    const part = first.parts[0]!;
    expect(part.dirty).toEqual(['sketch#1', 'extrude#1', 'fillet#1']);
    expect(part.meshChanged).toBe(true);
    expect(part.mesh).not.toBeNull();
    expect(part.features[2]!.references).toEqual([
      {
        referenceId: 'r1',
        target: 'extrude#1:side:e1|extrude#1:side:e2',
        via: 'exact',
        fragile: false,
      },
    ]);
    expect(await volume(engine, part.shape!)).toBeCloseTo(blockVolume(40, 30, 3), 3);
    const round = faceBox(first, part.mesh!, ROUND);
    expect(round.min[0]).toBeCloseTo(37, 3);
    expect(round.max[0]).toBeCloseTo(40, 3);
    expect(round.min[1]).toBeCloseTo(0, 3);
    expect(round.max[1]).toBeCloseTo(3, 3);

    // A variable only the fillet reads: one kernel op, the fillet; sketch and extrude from cache.
    unwrap(store.execute(setVariable('radius', '5mm')));
    const second = (await engine.update(events.at(-1)!))!;
    expect(second.counters).toMatchObject({
      featureOps: 1,
      solves: 0,
      cacheHits: 2,
      cacheMisses: 1,
    });
    expect(second.parts[0]!.dirty).toEqual(['fillet#1']);
    expect(second.parts[0]!.features.map((f) => f.cached)).toEqual([true, true, false]);
    expect(await volume(engine, second.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 5), 3);

    // Undo: back to a body the cache still has; nothing is sent to the kernel but the mesh.
    unwrap(store.undo());
    const undone = (await engine.update(events.at(-1)!))!;
    expect(undone.counters).toMatchObject({ featureOps: 0, solves: 0, cacheHits: 3 });
    expect(undone.parts[0]!.shape).toBe(part.shape);
    expect(undone.parts[0]!.meshChanged).toBe(true);

    // Survival: widen the base sketch. Sketch, extrude and fillet rebuild; the fillet resolves
    // exactly to the same named edge, which has moved to the new corner.
    unwrap(store.execute(setVariable('width', '60')));
    const third = (await engine.update(events.at(-1)!))!;
    expect(statuses(third)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(third.counters).toMatchObject({ featureOps: 2, solves: 1 });
    expect(third.parts[0]!.dirty).toEqual(['sketch#1', 'extrude#1', 'fillet#1']);
    const fillet = third.parts[0]!.features[2]!;
    expect(fillet.warnings).toEqual([]);
    expect(fillet.references).toEqual([
      {
        referenceId: 'r1',
        target: 'extrude#1:side:e1|extrude#1:side:e2',
        via: 'exact',
        fragile: false,
      },
    ]);
    const moved = faceBox(third, third.parts[0]!.mesh!, ROUND);
    expect(moved.min[0]).toBeCloseTo(57, 3);
    expect(moved.max[0]).toBeCloseTo(60, 3);
    expect(moved.min[1]).toBeCloseTo(0, 3);
    expect(moved.max[1]).toBeCloseTo(3, 3);
    expect(await volume(engine, third.parts[0]!.shape!)).toBeCloseTo(blockVolume(60, 30, 3), 3);

    // A rename changes no geometry: no op, no solve, no mesh.
    unwrap(
      store.execute({
        type: 'renameFeature',
        partId: 'part#1',
        featureId: 'fillet#1',
        name: 'Round',
      }),
    );
    const renamed = (await engine.update(events.at(-1)!))!;
    expect(renamed.counters).toMatchObject({ featureOps: 0, otherOps: 0, solves: 0, batches: 0 });
    expect(renamed.parts[0]!.dirty).toEqual([]);
    expect(renamed.parts[0]!.meshChanged).toBe(false);
    expect(renamed.parts[0]!.mesh).toBeNull();

    // Disposing releases every shape the engine kept.
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('cancels a regen whose kernel batch is running when a newer one arrives, and leaks nothing', async () => {
    const store = unwrap(DocumentStore.create(block()));
    const replies: string[] = [];
    let submitted!: () => void;
    const firstBatch = new Promise<void>((resolve) => (submitted = resolve));
    // The real service, watched: when the first batch is in the kernel, the next edit arrives.
    const kernel: RegenKernel = {
      run: async (request) => {
        const reply = service.run(request);
        submitted();
        const r = await reply;
        replies.push(`${r.generation}:${r.status}`);
        return r;
      },
      release: (shapes) => service.release(shapes),
      cancel: (generation) => service.cancel(generation),
      stats: () => service.stats(),
    };
    const engine = new RegenEngine({ kernel, solver });
    const a = engine.regen(store.document);
    await firstBatch;
    unwrap(store.execute(setVariable('radius', '4mm')));
    const b = engine.regen(store.document);
    expect(await a).toBeNull();
    const result = (await b)!;
    expect(replies[0]).toMatch(/:cancelled$/);
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(result.generation).toBe(engine.generation);
    expect(await volume(engine, result.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 4), 3);
    expect(engine.stats.superseded).toBe(1);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('rebuilds from the document after the kernel recycles', async () => {
    const store = unwrap(DocumentStore.create(block()));
    let recycled = 0;
    const engine = new RegenEngine({
      kernel: service,
      solver,
      onKernelRecycled: () => recycled++,
    });
    const first = (await engine.regen(store.document))!;
    await service.recycle();
    expect(recycled).toBe(1);
    const again = (await engine.regen(store.document))!;
    expect(again.counters).toMatchObject({ featureOps: 2, solves: 0 });
    expect(again.parts[0]!.bodyKey).toBe(first.parts[0]!.bodyKey);
    // Same body, so the mesh the viewport has is still right.
    expect(again.parts[0]!.meshChanged).toBe(false);
    expect(await volume(engine, again.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 3), 3);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('retries, and caches nothing, when a recycle runs between a cache hit and the batch that uses it', async () => {
    const store = unwrap(DocumentStore.create(block()));
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));
    // The real service, with a recycle queued just before the next batch: the extrude comes from
    // the cache (its shape id is from the old instance) and the fillet batch runs on the new one,
    // where `applyFeature` passes the unknown body through with a `no-body` error.
    let recycleNext = false;
    const kernel: RegenKernel = {
      run: (request) => {
        if (recycleNext) {
          recycleNext = false;
          void service.recycle();
        }
        return service.run(request);
      },
      release: (shapes) => service.release(shapes),
      cancel: (generation) => service.cancel(generation),
      onRecycle: (hook) => service.onRecycle(hook),
      stats: () => service.stats(),
    };
    let recycled = 0;
    const engine = new RegenEngine({ kernel, solver, onKernelRecycled: () => recycled++ });
    const first = (await engine.regen(store.document))!;
    expect(statuses(first)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });

    unwrap(store.execute(setVariable('radius', '4mm')));
    recycleNext = true;
    const second = (await engine.update(events.at(-1)!))!;
    expect(recycled).toBe(1);
    expect(engine.stats.retries).toBe(1);
    expect(statuses(second)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(second.parts[0]!.features[2]!.errors).toEqual([]);
    expect(await volume(engine, second.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 4), 3);

    // Nothing the stale batch produced was cached: the same document is all cache hits, and ok.
    const third = (await engine.regen(store.document))!;
    expect(third.counters).toMatchObject({ featureOps: 0, cacheHits: 3 });
    expect(third.parts[0]!.features[2]).toMatchObject({ status: 'ok', errors: [], cached: true });
    expect(await volume(engine, third.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 4), 3);

    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('cuts an imported STEP solid from the body, and keeps a reference import out of it', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const first = (await engine.regen(block()))!;
    const props = async (shape: ShapeId) => {
      const r = (
        await service.run({ generation: engine.generation, ops: [{ op: 'properties', shape }] })
      ).results[0]!;
      if (!r.ok) throw new Error(r.error.message);
      return r.value as { volume: number; boundingBox: { min: readonly number[] } };
    };
    // A 5 mm cube at the block's plain corner (the fillet is at the other end), as a STEP file.
    const min = (await props(first.parts[0]!.shape!)).boundingBox.min;
    const made = await service.run({
      generation: engine.generation,
      ops: [
        { op: 'box', size: [5, 5, 5], at: [min[0]!, min[1]!, min[2]!], keep: false },
        { op: 'exportStep', bodies: [{ shape: { result: 0 }, name: 'Cube' }] },
      ],
    });
    const exported = made.results[1]!;
    if (!exported.ok) throw new Error(exported.error.message);
    const bytes = (exported.value as { data: Uint8Array }).data;
    const imported = (operation: ImportFeature['operation'], data = bytes): ImportFeature => ({
      id: 'import#1',
      kind: 'import',
      name: 'Cube.step',
      suppressed: false,
      source: {
        format: 'step',
        fileName: 'Cube.step',
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        data: Buffer.from(data).toString('base64'),
      },
      operation,
    });
    const doc = (operation: ImportFeature['operation'], data?: Uint8Array) => {
      const store = unwrap(DocumentStore.create(block()));
      unwrap(store.execute(add(imported(operation, data))));
      return store.document;
    };

    const cut = (await engine.regen(doc('cut')))!;
    expect(statuses(cut)['import#1']).toBe('ok');
    expect(await volume(engine, cut.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 3) - 125, 3);
    expect(cut.names.filter((n) => n.startsWith('import#1:face:')).length).toBeGreaterThan(0);

    // A reference changes no geometry and sends no feature op.
    const reference = (await engine.regen(doc('reference')))!;
    expect(statuses(reference)['import#1']).toBe('ok');
    expect(reference.parts[0]!.features[3]!.warnings).toMatchObject([{ code: 'reference-body' }]);
    expect(reference.counters.featureOps).toBe(0);
    expect(reference.parts[0]!.shape).toBe(first.parts[0]!.shape);

    // A file the kernel cannot read fails the import, not the regen; the body passes through.
    const broken = (await engine.regen(doc('add', new TextEncoder().encode('not a STEP file'))))!;
    expect(statuses(broken)['import#1']).toBe('error');
    expect(broken.parts[0]!.features[3]!.errors.length).toBeGreaterThan(0);
    expect(await volume(engine, broken.parts[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 3), 3);

    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });
});
