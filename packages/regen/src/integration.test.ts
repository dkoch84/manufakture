// End to end in Node: the real kernel service (libcascade through its node harness) and the real
// planegcs solver, driven by a core DocumentStore. Counts come from the engine's counters (kernel
// `feature` ops sent, solves, cache hits), so "only the last feature was rebuilt" is asserted on
// what actually went to the kernel.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DocumentStore,
  parseDocument,
  type ChangeEvent,
  type DerivedFeature,
  type ImportFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { KernelService, MeshData, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine, type RegenKernel } from './engine';
import {
  add,
  apply,
  block,
  build,
  derivedOf,
  fillet,
  mm,
  pin,
  setVariable,
  statuses,
  twoBodies,
  unwrap,
} from './test-helpers';
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
    expect(part.bodies[0]!.meshChanged).toBe(true);
    expect(part.bodies[0]!.mesh).not.toBeNull();
    expect(part.features[2]!.references).toEqual([
      {
        referenceId: 'r1',
        target: 'extrude#1:side:e1|extrude#1:side:e2',
        via: 'exact',
        fragile: false,
      },
    ]);
    expect(await volume(engine, part.bodies[0]!.shape!)).toBeCloseTo(blockVolume(40, 30, 3), 3);
    const round = faceBox(first, part.bodies[0]!.mesh!, ROUND);
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
    expect(await volume(engine, second.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 5),
      3,
    );

    // Undo: back to a body the cache still has; nothing is sent to the kernel but the mesh.
    unwrap(store.undo());
    const undone = (await engine.update(events.at(-1)!))!;
    expect(undone.counters).toMatchObject({ featureOps: 0, solves: 0, cacheHits: 3 });
    expect(undone.parts[0]!.bodies[0]!.shape).toBe(part.bodies[0]!.shape);
    expect(undone.parts[0]!.bodies[0]!.meshChanged).toBe(true);

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
    const moved = faceBox(third, third.parts[0]!.bodies[0]!.mesh!, ROUND);
    expect(moved.min[0]).toBeCloseTo(57, 3);
    expect(moved.max[0]).toBeCloseTo(60, 3);
    expect(moved.min[1]).toBeCloseTo(0, 3);
    expect(moved.max[1]).toBeCloseTo(3, 3);
    expect(await volume(engine, third.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(60, 30, 3),
      3,
    );

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
    expect(renamed.parts[0]!.bodies[0]!.meshChanged).toBe(false);
    expect(renamed.parts[0]!.bodies[0]!.mesh).toBeNull();

    // Disposing releases every shape the engine kept.
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('rebuilds only the edited body of a two-body part', async () => {
    const store = unwrap(DocumentStore.create(twoBodies()));
    const engine = new RegenEngine({ kernel: service, solver });
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));
    const volumes = async (r: RegenResult) =>
      Promise.all(r.parts[0]!.bodies.map((b) => volume(engine, b.shape)));

    const first = (await engine.regen(store.document))!;
    expect(Object.values(statuses(first)).every((s) => s === 'ok')).toBe(true);
    expect(first.parts[0]!.bodies.map((b) => [b.bodyId, b.solids, b.meshChanged])).toEqual([
      ['extrude#1', 1, true],
      ['extrude#2', 1, true],
    ]);
    expect(first.counters.featureOps).toBe(4);
    const [v1, v2] = await volumes(first);
    expect(v1).toBeCloseTo(blockVolume(40, 30, 3), 3);
    expect(v2).toBeCloseTo(blockVolume(40, 30, 2), 3);
    // Two bodies, not one compound: each mesh has its own seven faces.
    for (const b of first.parts[0]!.bodies) expect(b.mesh!.faceRanges.length / 2).toBe(7);

    // Body 2's width: its sketch, extrusion and fillet; nothing of body 1 reaches the kernel.
    unwrap(store.execute(setVariable('w2', '60')));
    const wide = (await engine.update(events.at(-1)!))!;
    expect(wide.counters).toMatchObject({ featureOps: 2, solves: 1 });
    expect(wide.parts[0]!.dirty).toEqual(['sketch#2', 'extrude#2', 'fillet#2']);
    const cached = Object.fromEntries(wide.parts[0]!.features.map((f) => [f.featureId, f.cached]));
    expect(cached).toMatchObject({
      'extrude#1': true,
      'fillet#1': true,
      'extrude#2': false,
      'fillet#2': false,
    });
    expect(wide.parts[0]!.bodies.map((b) => b.meshChanged)).toEqual([false, true]);
    expect(wide.parts[0]!.bodies[0]!.shape).toBe(first.parts[0]!.bodies[0]!.shape);
    const [w1, w2] = await volumes(wide);
    expect(w1).toBeCloseTo(v1!, 6);
    expect(w2).toBeCloseTo(blockVolume(60, 30, 2), 3);

    // Body 1's radius: its fillet alone.
    unwrap(store.execute(setVariable('r1', '5mm')));
    const round = (await engine.update(events.at(-1)!))!;
    expect(round.counters).toMatchObject({ featureOps: 1, solves: 0 });
    expect(round.parts[0]!.bodies.map((b) => b.meshChanged)).toEqual([true, false]);
    expect((await volumes(round))[0]).toBeCloseTo(blockVolume(40, 30, 5), 3);

    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('regenerates the M1 bracket (no scopes) to the same volume and names as before bodies', async () => {
    const json: unknown = JSON.parse(
      readFileSync(new URL('../../core/src/fixtures/v5-bracket.json', import.meta.url), 'utf8'),
    );
    const doc = unwrap(parseDocument(json)).document;
    const engine = new RegenEngine({ kernel: service, solver });
    const result = (await engine.regen(doc))!;
    expect(Object.values(statuses(result)).every((s) => s === 'ok')).toBe(true);
    const bodies = result.parts[0]!.bodies;
    expect(bodies.map((b) => [b.bodyId, b.creator, b.solids])).toEqual([
      ['extrude#1', 'extrude#1', 1],
    ]);
    expect(result.parts[0]!.consumed).toEqual([]);
    // What the one-body (joined) regen gave before T2.1c.
    expect(await volume(engine, bodies[0]!.shape)).toBeCloseTo(4794.849555921539, 6);
    const names = new Set(Array.from(bodies[0]!.mesh!.faceNames, (i) => result.names[i]));
    expect([...names].sort()).toEqual([
      '(extrude#1:cap:end#2+extrude#2:cap:start)',
      'extrude#1:cap:end#1',
      'extrude#1:cap:start',
      'extrude#1:side:e1',
      'extrude#1:side:e2',
      'extrude#1:side:e3',
      'extrude#1:side:e4',
      'fillet#1:round:r2',
    ]);
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
    expect(await volume(engine, result.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 4),
      3,
    );
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
    expect(again.parts[0]!.bodies[0]!.bodyKey).toBe(first.parts[0]!.bodies[0]!.bodyKey);
    // Same body, so the mesh the viewport has is still right.
    expect(again.parts[0]!.bodies[0]!.meshChanged).toBe(false);
    expect(await volume(engine, again.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 3),
      3,
    );
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
    expect(await volume(engine, second.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 4),
      3,
    );

    // Nothing the stale batch produced was cached: the same document is all cache hits, and ok.
    const third = (await engine.regen(store.document))!;
    expect(third.counters).toMatchObject({ featureOps: 0, cacheHits: 3 });
    expect(third.parts[0]!.features[2]).toMatchObject({ status: 'ok', errors: [], cached: true });
    expect(await volume(engine, third.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 4),
      3,
    );

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
    const min = (await props(first.parts[0]!.bodies[0]!.shape!)).boundingBox.min;
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
    expect(await volume(engine, cut.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 3) - 125,
      3,
    );
    expect(cut.names.filter((n) => n.startsWith('import#1:face:')).length).toBeGreaterThan(0);

    // A reference changes no geometry and sends no feature op.
    const reference = (await engine.regen(doc('reference')))!;
    expect(statuses(reference)['import#1']).toBe('ok');
    expect(reference.parts[0]!.features[3]!.warnings).toMatchObject([{ code: 'reference-body' }]);
    expect(reference.counters.featureOps).toBe(0);
    expect(reference.parts[0]!.bodies[0]!.shape).toBe(first.parts[0]!.bodies[0]!.shape);

    // A file the kernel cannot read fails the import, not the regen; the body passes through.
    const broken = (await engine.regen(doc('add', new TextEncoder().encode('not a STEP file'))))!;
    expect(statuses(broken)['import#1']).toBe('error');
    expect(broken.parts[0]!.features[3]!.errors.length).toBeGreaterThan(0);
    expect(await volume(engine, broken.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      blockVolume(40, 30, 3),
      3,
    );

    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });
});

describe('derived parts with the real kernel', () => {
  const D = 'derived#1:from/';
  const bracket = (): ManufaktureDocument =>
    unwrap(
      parseDocument(
        JSON.parse(
          readFileSync(new URL('../../core/src/fixtures/v6-bracket.json', import.meta.url), 'utf8'),
        ),
      ),
    ).document;
  /** The M1 bracket: a 40 x 20 plate of `t` mm with a 2 mm round on one vertical edge. */
  const bracketVolume = (t: number) => 40 * 20 * t - (4 - Math.PI) * t;
  const derivedAt = (source: ManufaktureDocument): DerivedFeature =>
    derivedOf('derived#1', pin(source), {
      placement: {
        translation: [mm('0'), mm('0'), mm('10')],
        rotation: [mm('0'), mm('0'), mm('0')],
      },
    });
  // The back left vertical edge of the plate (x = 0, y = 20), by its derived faces.
  const edge: [string, string] = [`${D}extrude#1:side:e3`, `${D}extrude#1:side:e4`];
  const ROUND2 = 'fillet#1:round:r1';

  it('keeps a fillet on a derived edge exact when the pin moves to a version with another #thickness', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = build([add(derivedAt(bracket())), add(fillet('fillet#1', edge, '1'))]);
    const first = (await engine.regen(doc))!;
    expect(statuses(first)).toEqual({ 'derived#1': 'ok', 'fillet#1': 'ok' });
    const at6 = first.parts[0]!.bodies;
    expect(at6.map((b) => b.bodyId)).toEqual([`${D}extrude#1`]);
    expect(first.parts[0]!.features[1]!.references).toEqual([
      { referenceId: 'r1', target: edge.join('|'), via: 'exact', fragile: false },
    ]);
    const small = (1 - Math.PI / 4) * 6;
    expect(await volume(engine, at6[0]!.shape)).toBeCloseTo(bracketVolume(6) - small, 6);
    // Every face of the derived body is named from the source, the fillet's round excepted.
    const names = Array.from(at6[0]!.mesh!.faceNames, (i) => first.names[i]!);
    expect(names.filter((n) => !n.startsWith(D))).toEqual([ROUND2]);
    expect(names).toContain(`${D}fillet#1:round:r2`);
    let round = faceBox(first, at6[0]!.mesh!, ROUND2);
    expect(round.min[2]).toBeCloseTo(10, 3);
    expect(round.max[2]).toBeCloseTo(16, 3);

    // Update the pin: the source at a version where #thickness is 8 mm.
    const thicker = apply(bracket(), setVariable('thickness', '8mm'));
    const updated = (await engine.regen(
      apply(doc, {
        type: 'editFeature',
        partId: doc.parts[0]!.id,
        feature: derivedAt(thicker),
      }),
    ))!;
    expect(statuses(updated)).toEqual({ 'derived#1': 'ok', 'fillet#1': 'ok' });
    expect(updated.parts[0]!.features[1]!.references).toEqual([
      { referenceId: 'r1', target: edge.join('|'), via: 'exact', fragile: false },
    ]);
    const at8 = updated.parts[0]!.bodies[0]!;
    expect(await volume(engine, at8.shape)).toBeCloseTo(
      bracketVolume(8) - (1 - Math.PI / 4) * 8,
      6,
    );
    // The round runs the full new height, on the same edge.
    round = faceBox(updated, at8.mesh!, ROUND2);
    expect(round.min[0]).toBeCloseTo(0, 3);
    expect(round.max[0]).toBeCloseTo(1, 3);
    expect(round.min[1]).toBeCloseTo(19, 3);
    expect(round.max[1]).toBeCloseTo(20, 3);
    expect(round.min[2]).toBeCloseTo(10, 3);
    expect(round.max[2]).toBeCloseTo(18, 3);

    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('cuts with a derived body, and recovers from a recycle between the source and the derive', async () => {
    let recycleBeforeDerive = true;
    const kernel: RegenKernel = {
      run: (request) => {
        const op = request.ops[0];
        if (recycleBeforeDerive && op?.op === 'feature' && op.feature.kind === 'derive') {
          recycleBeforeDerive = false;
          void service.recycle();
        }
        return service.run(request);
      },
      release: (shapes) => service.release(shapes),
      cancel: (generation) => service.cancel(generation),
      onRecycle: (hook) => service.onRecycle(hook),
      stats: () => service.stats(),
    };
    const engine = new RegenEngine({ kernel, solver });
    // The block (40 x 30 x 20) minus the bracket, sunk 6 mm into the back of its top, clear of
    // the block's own round at the front.
    const doc = apply(
      block(),
      add({
        ...derivedAt(bracket()),
        operation: 'cut',
        placement: {
          translation: [mm('0'), mm('10'), mm('14')],
          rotation: [mm('0'), mm('0'), mm('0')],
        },
      }),
    );
    const r = (await engine.regen(doc))!;
    expect(statuses(r)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'fillet#1': 'ok',
      'derived#1': 'ok',
    });
    expect(engine.stats.retries).toBe(1);
    const body = r.parts[0]!.bodies;
    expect(body.map((b) => b.bodyId)).toEqual(['extrude#1']);
    expect(await volume(engine, body[0]!.shape)).toBeCloseTo(
      blockVolume(40, 30, 3) - bracketVolume(6),
      3,
    );
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });
});
