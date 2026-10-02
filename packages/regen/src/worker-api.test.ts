// The regen worker end to end through Comlink, in Node: the worker API (the real kernel and the
// real planegcs solver in-process) is exposed on one end of a MessageChannel and the main-thread
// `RegenClient` talks to the other, so the document is really structured-cloned and the mesh
// buffers really transferred. Only `new Worker()` itself is left out.

import { readFile } from 'node:fs/promises';
import type { KernelEndpoint } from '@manufakture/kernel/kernel-client';
import type { KernelStatus, MeshData } from '@manufakture/kernel';
import { wasmPath } from '@manufakture/kernel/node';
import * as Comlink from 'comlink';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCamSetup } from '@manufakture/core';
import { RegenClient } from './client';
import {
  ASSEMBLY,
  apply,
  block,
  boxAndLid,
  hinge,
  mm,
  setVariable,
  statuses,
  twoBodies,
} from './test-helpers';
import type { RegenResult } from './types';
import { createRegenWorkerApi } from './worker-api';

let bytes: Uint8Array;
const fetchWasm = async () =>
  new Response(bytes.slice(), {
    headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.length) },
  });

const channels: MessagePort[] = [];
let api: ReturnType<typeof createRegenWorkerApi>;
let client: RegenClient;
const statusLog: KernelStatus[] = [];
/** Every result the worker sent, before transfer. */
const sent: RegenResult[] = [];

beforeAll(async () => {
  bytes = new Uint8Array(await readFile(wasmPath()));
  api = createRegenWorkerApi({ source: { url: 'kernel.wasm', fetch: fetchWasm } });
  const regen = api.regen.bind(api);
  api.regen = async (document, options) => {
    const result = await regen(document, options);
    if (result) sent.push(result);
    return result;
  };
  client = new RegenClient(
    (): KernelEndpoint => {
      const { port1, port2 } = new MessageChannel();
      channels.push(port1, port2);
      Comlink.expose(api, port1);
      return { endpoint: port2, terminate: () => port1.close() };
    },
    { onStatus: (s) => statusLog.push(s) },
  );
  await client.ready;
}, 60_000);

afterAll(() => {
  client.terminate();
  for (const p of channels) p.close();
});

const faceCount = (mesh: MeshData) => mesh.faceRanges.length / 2;

/** The block with another width, so a regen has kernel work to do. */
function widened(width: number) {
  const doc = block();
  return {
    ...doc,
    variables: doc.variables.map((v) =>
      v.name === 'width' ? { ...v, expression: { ...v.expression, source: String(width) } } : v,
    ),
  };
}

describe('the regen worker', () => {
  it('regenerates a document into a named mesh with its topology, transferring the buffers', async () => {
    const result = (await client.regen(block()))!;
    expect(result).not.toBeNull();
    expect(result.generation).toBe(client.latestGeneration);
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    const part = result.parts[0]!;
    const body = part.bodies[0]!;
    expect(part.bodies.map((b) => [b.bodyId, b.creator, b.solids])).toEqual([
      ['extrude#1', 'extrude#1', 1],
    ]);
    expect(body.meshChanged).toBe(true);
    const mesh = body.mesh!;
    expect(faceCount(mesh)).toBe(7);
    // Every face slot holds a name from the naming layer.
    const names = Array.from(mesh.faceNames, (i) => result.names[i]);
    expect(names).toContain('fillet#1:round:r1');
    expect(names).toContain('extrude#1:cap:end');
    // Topology numbers faces and edges like the mesh.
    expect(body.topology!.faces).toHaveLength(7);
    expect(body.topology!.edges).toHaveLength(mesh.edgeRanges.length / 2);
    // The sketch result says where it was solved.
    expect(part.features[0]!.placement).toEqual({
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xDir: [1, 0, 0],
    });
    // Transferred, not copied: the worker's buffers are detached.
    expect(sent.at(-1)!.parts[0]!.bodies[0]!.mesh!.positions.byteLength).toBe(0);
  });

  it('lets a measure at the current generation run next to regens, on the body it returned', async () => {
    const result = (await client.regen(block()))!;
    // The same document again: nothing changed, so no mesh, but the body is the same shape.
    expect(result.parts[0]!.bodies[0]!.meshChanged).toBe(false);
    const shape = result.parts[0]!.bodies[0]!.shape!;
    const reply = await client.submit(
      [{ op: 'measure', shape, targets: [], body: true }] as const,
      client.latestGeneration,
    );
    expect(reply?.status).toBe('done');
    const [r] = reply!.results;
    expect(r.ok && r.value.body!.volume).toBeCloseTo(
      40 * 30 * 20 - (9 - (Math.PI * 9) / 4) * 20,
      3,
    );
  });

  it('sends a mesh per body, and only for the bodies an edit changed, transferring each', async () => {
    // Body 1 wider than the block before: the same block would be the body already reported.
    const doc = apply(twoBodies(), setVariable('w1', '45'));
    const first = (await client.regen(doc))!;
    const bodies = first.parts[0]!.bodies;
    expect(bodies.map((b) => [b.bodyId, b.meshChanged, faceCount(b.mesh!)])).toEqual([
      ['extrude#1', true, 7],
      ['extrude#2', true, 7],
    ]);
    // Each body's mesh names its own faces from the one name table.
    const names = (mesh: MeshData) => Array.from(mesh.faceNames, (i) => first.names[i]);
    expect(names(bodies[0]!.mesh!)).toContain('fillet#1:round:r1');
    expect(names(bodies[1]!.mesh!)).toContain('fillet#2:round:r2');
    expect(names(bodies[1]!.mesh!)).not.toContain('extrude#1:cap:end');
    for (const b of sent.at(-1)!.parts[0]!.bodies) expect(b.mesh!.positions.byteLength).toBe(0);

    // A radius only body 2 reads: only its mesh comes back.
    const edited = apply(doc, setVariable('r2', '4mm'));
    const second = (await client.regen(edited))!;
    expect(second.counters.featureOps).toBe(1);
    expect(second.parts[0]!.bodies.map((b) => [b.bodyId, b.meshChanged, b.mesh !== null])).toEqual([
      ['extrude#1', false, false],
      ['extrude#2', true, true],
    ]);
    expect(second.parts[0]!.bodies[0]!.shape).toBe(bodies[0]!.shape);
    expect(sent.at(-1)!.parts[0]!.bodies[1]!.mesh!.positions.byteLength).toBe(0);
  });

  it('supersedes an older regen with a newer one', async () => {
    const doc = block();
    const wide = {
      ...doc,
      variables: doc.variables.map((v) =>
        v.name === 'width' ? { ...v, expression: { ...v.expression, source: '50' } } : v,
      ),
    };
    const [older, newer] = await Promise.all([client.regen(wide), client.regen(doc)]);
    expect(newer).not.toBeNull();
    expect(newer!.generation).toBeGreaterThan(older?.generation ?? 0);
    expect(statuses(newer!)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
  });

  it('lets a batch at a newer generation supersede a running regen, but not one at the current', async () => {
    // Only a regen may take a new generation: any other batch that does cancels the regen in
    // flight (the service treats its batches as stale), and nothing reports in its place.
    const running = client.regen(widened(61));
    const newer = client.submit([{ op: 'box', size: [1, 1, 1], keep: false }] as const);
    expect(await running).toBeNull();
    expect((await newer)?.status).toBe('done');
    // At the client's current generation it runs next to the regen, which completes.
    const regen = client.regen(widened(62));
    const beside = client.submit(
      [{ op: 'box', size: [1, 1, 1], keep: false }] as const,
      client.latestGeneration,
    );
    expect((await beside)?.status).toBe('done');
    expect(statuses((await regen)!)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'fillet#1': 'ok',
    });
  });

  it('releases shapes outside the batch queue, so a regen cancelling older batches cannot drop it', async () => {
    const made = await client.submit(
      [{ op: 'box', size: [2, 2, 2] }] as const,
      client.latestGeneration,
    );
    const shape = (made!.results[0] as { ok: true; value: { shape: number } }).value.shape;
    // A regen is running, the release starts, and a newer regen cancels every batch up to the
    // running one's generation (the release's, had it been a batch).
    const first = client.regen(widened(63));
    const release = client.release([shape as never]);
    const second = client.regen(widened(64));
    expect(await release).toEqual({ released: [shape], unknown: [] });
    await Promise.all([first, second]);
    expect((await client.leaks()).map((r) => r.id)).not.toContain(shape);
  });

  it('resolves a pending regen to null when the worker is stopped', async () => {
    // A worker that never answers.
    const stuck = new MessageChannel();
    channels.push(stuck.port1, stuck.port2);
    const c = new RegenClient(() => ({ endpoint: stuck.port2, terminate: () => {} }));
    const pending = c.regen(block());
    c.terminate();
    expect(await pending).toBeNull();
  });

  it('reports a recycle, after which a regen rebuilds on the new instance', async () => {
    const before = (await client.regen(block()))!;
    const report = await client.recycle();
    await vi.waitFor(() => expect(statusLog.some((s) => s.type === 'recycled')).toBe(true));
    expect(report.lostShapes).toBeGreaterThan(0);
    const after = (await client.regen(block()))!;
    expect(statuses(after)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(after.parts[0]!.bodies[0]!.shape).not.toBe(before.parts[0]!.bodies[0]!.shape);
    expect(after.counters.featureOps).toBe(2);
    const stats = await client.regenStats();
    expect(stats.regens).toBeGreaterThanOrEqual(4);
  });

  it('solves an assembly preview and coalesces drags at the current generation, without cancelling a regen', async () => {
    const doc = boxAndLid();
    const result = (await client.regen(doc))!;
    const asm = result.assemblies![0]!;
    expect(asm).toMatchObject({ outcome: 'solved', dof: 1 });
    expect(asm.instances[1]!.transform.translation[2]).toBeCloseTo(20, 9);

    // A preview with the hinge's lid connector turned a quarter turn: the lid swings round.
    const turned = apply(doc, {
      type: 'editMate',
      assemblyId: ASSEMBLY,
      mate: hinge({ rotate: 1 }),
    });
    const preview = (await client.solveAssembly(turned, ASSEMBLY))!;
    expect(preview).toMatchObject({ assemblyId: ASSEMBLY, outcome: 'solved', dof: 1 });
    expect(preview.instances[1]!.moved).toBe(true);
    // The preview neither took a generation nor changed what the worker reports.
    expect(client.latestGeneration).toBe(result.generation);

    // A burst of pointer moves: only the latest target is solved.
    const open = { point: [20, 0, 5] as const, position: [20, 35, 50] as const };
    const steps = await Promise.all([
      client.dragInstance(ASSEMBLY, 'inst#2', { point: [20, 0, 5], position: [20, 10, 40] }),
      client.dragInstance(ASSEMBLY, 'inst#2', { point: [20, 0, 5], position: [20, 20, 45] }),
      client.dragInstance(ASSEMBLY, 'inst#2', open),
    ]);
    expect(steps.slice(0, 2)).toEqual([null, null]);
    const last = steps[2]!;
    expect(last).toMatchObject({ generation: result.generation, moved: ['inst#2'] });
    expect(last.target.reached).toBe(true);
    expect(last.transforms['inst#2']!.rotation[0]).toBeCloseTo(-Math.SQRT1_2, 9);

    // Committing the drag is a pose-only edit: the regen sends no mesh and keeps the lid there.
    const committed = apply(doc, {
      type: 'setPoses',
      assemblyId: ASSEMBLY,
      poses: Object.fromEntries(last.moved.map((id) => [id, last.transforms[id]!])),
    });
    const after = (await client.regen(committed))!;
    expect(after.parts.every((p) => p.bodies.every((b) => !b.meshChanged))).toBe(true);
    const lid = after.assemblies![0]!.instances[1]!;
    expect(lid.moved).toBe(false);
    expect(lid.transform.rotation[0]).toBeCloseTo(-Math.SQRT1_2, 9);
  });
  it('checks interference on demand with the solved transforms, streaming pairs; a newer regen or a stop ends it', async () => {
    // The lid lies on the box: they touch, so not even their boxes are a candidate.
    const doc = boxAndLid();
    const lying = (await client.regen(doc))!;
    expect(lying.assemblies[0]!.dof).toBe(1);
    const none = (await client.interference(ASSEMBLY))!;
    expect(none).toMatchObject({
      assemblyId: ASSEMBLY,
      generation: lying.generation,
      instances: ['inst#1', 'inst#2'],
      pairs: [],
      candidates: 0,
      booleans: 0,
      failures: [],
      status: 'done',
    });
    // Asking does not take a generation.
    expect(client.latestGeneration).toBe(lying.generation);

    // The lid turned a quarter turn down about the hinge (the box's top back edge, x along
    // y = 30, z = 20): it hangs into the box, x 0..40, y 25..30, z -10..20, so they share
    // 40 x 5 x 20 = 4000 mm3.
    const s = Math.SQRT1_2;
    const down = apply(doc, {
      type: 'setPoses',
      assemblyId: ASSEMBLY,
      poses: { 'inst#2': { translation: [0, 30, -10], rotation: [s, 0, 0, s] } },
    });
    const hanging = (await client.regen(down))!;
    const lid = hanging.assemblies[0]!.instances[1]!;
    expect(hanging.assemblies[0]!.mates[0]!.status).toBe('ok');
    expect(lid.transform.translation[1]).toBeCloseTo(30, 9);
    expect(lid.transform.translation[2]).toBeCloseTo(-10, 9);
    const streamed: { a: string; b: string; volume: number; mesh: MeshData | null }[] = [];
    const report = (await client.interference(ASSEMBLY, {
      mesh: true,
      onPair: (pair) => streamed.push(pair),
    }))!;
    expect(report).toMatchObject({ status: 'done', candidates: 1, booleans: 1, failures: [] });
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]).toMatchObject({ a: 'inst#1', b: 'inst#2', mesh: null });
    expect(report.pairs[0]!.volume).toBeCloseTo(4000, 6);
    // The pair came on its own, before the report, with the overlap's mesh in world coordinates.
    expect(streamed).toHaveLength(1);
    const mesh = streamed[0]!.mesh!;
    expect(faceCount(mesh)).toBe(6);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    mesh.positions.forEach((v, i) => {
      lo[i % 3] = Math.min(lo[i % 3]!, v);
      hi[i % 3] = Math.max(hi[i % 3]!, v);
    });
    [0, 25, 0].forEach((v, i) => expect(lo[i]).toBeCloseTo(v, 4));
    [40, 30, 20].forEach((v, i) => expect(hi[i]).toBeCloseTo(v, 4));

    // A stop before the first pair: cancelled, with the candidates known and no boolean run.
    const stopped = client.interference(ASSEMBLY);
    await client.cancelInterference(ASSEMBLY);
    expect(await stopped).toMatchObject({
      status: 'cancelled',
      candidates: 1,
      booleans: 0,
      pairs: [],
    });

    // A regen asked for meanwhile supersedes a check: it resolves to null.
    const superseded = client.interference(ASSEMBLY);
    const back = (await client.regen(doc))!;
    expect(await superseded).toBeNull();
    expect(back.assemblies[0]!.instances[1]!.transform.translation[2]).toBeCloseTo(20, 9);
    expect((await client.interference(ASSEMBLY))!.pairs).toEqual([]);

    // An assembly the last regen does not have: nothing to check.
    expect(await client.interference('assembly#9')).toBeNull();
    // The check left nothing in the kernel beyond the bodies the regens keep.
    const leaks = await client.leaks();
    expect(leaks.every((r) => r.operation !== 'interference')).toBe(true);
  });

  it('answers drawing views and sheets at the current generation, picking data included', async () => {
    const doc = apply(block(), {
      type: 'addDrawing',
      drawing: {
        id: 'drawing#1',
        name: 'Drawing',
        nextIds: { sheet: 2, view: 2 },
        sheets: [
          {
            id: 'sheet#1',
            name: 'Sheet 1',
            size: 'A4',
            orientation: 'landscape',
            views: [
              {
                id: 'view#1',
                source: { part: 'part#1' },
                direction: 'top',
                scale: { paper: mm('1'), model: mm('2') },
                position: [100, 100],
                options: { hidden: true, smooth: false },
              },
            ],
            dimensions: [],
            notes: [],
          },
        ],
      },
    });
    const result = (await client.regen(doc))!;
    const view = (await client.drawingView(doc, 'drawing#1', 'view#1', { pick: true }))!;
    expect(view.generation).toBe(result.generation);
    expect(client.latestGeneration).toBe(result.generation);
    expect(view.bounds!.max[0]).toBeCloseTo(40, 6);
    expect(view.bounds!.max[1]).toBeCloseTo(30, 6);
    expect(view.pick!.items[0]!.edges.length).toBeGreaterThan(0);
    const sheet = (await client.drawingSheet(doc, 'drawing#1', 'sheet#1'))!;
    expect(sheet.views[0]!.cached).toBe(true);
    expect(sheet.display!.items.some((i) => i.owner === 'view#1')).toBe(true);
  });

  it('answers CAM geometry at the current generation, transferring the mesh, without cancelling a regen', async () => {
    const doc = apply(
      block(),
      {
        type: 'addCamTool',
        tool: {
          id: 'tool#1',
          name: '6 mm flat',
          kind: 'flat',
          diameter: mm('6'),
          fluteLength: mm('22'),
          flutes: 2,
          presets: [],
        },
      },
      {
        type: 'addCamSetup',
        setup: {
          ...createCamSetup('setup#1', 'Top', 'part#1', 'shapeoko-4-xxl', 'grbl'),
          operations: [
            {
              id: 'profile#1',
              kind: 'profile',
              name: 'Outline',
              suppressed: false,
              tool: 'tool#1',
              geometry: [{ kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } }],
              feeds: { spindle: mm('18000rpm'), cut: mm('1000mm/min'), plunge: mm('300mm/min') },
              side: 'outside',
              depth: { kind: 'through' },
              stepdown: mm('2'),
              entry: { kind: 'plunge' },
              leadIn: { kind: 'none' },
              leadOut: { kind: 'none' },
              climb: true,
            },
          ],
        },
      },
    );
    const regen = client.regen(doc);
    // Sent while the regen is in flight: at the client's current generation, so it waits for the
    // regen on the worker's chain instead of cancelling it.
    const cam = client.camGeometry(doc, 'setup#1', { mesh: true });
    const [result, geometry] = await Promise.all([regen, cam]);
    expect(result).not.toBeNull();
    expect(geometry).not.toBeNull();
    expect(geometry!.generation).toBe(result!.generation);
    expect(client.latestGeneration).toBe(result!.generation);
    const profile = geometry!.operations[0]!;
    expect(profile.status).toBe('ok');
    expect(profile.values).toMatchObject({ depth: { top: 0, bottom: -20 } });
    expect(geometry!.mesh!.positions).toBeInstanceOf(Float32Array);
    expect(geometry!.mesh!.indices.length).toBeGreaterThan(0);
  });

  it('answers oriented sizes at the current generation, without cancelling the regen', async () => {
    const doc = block();
    const result = (await client.regen(doc))!;
    const sizes = (await client.orientedSizes(doc, 'part#1'))!;
    expect(sizes.generation).toBe(result.generation);
    expect(client.latestGeneration).toBe(result.generation);
    expect(sizes.sizes).toHaveLength(1);
    expect(sizes.failures).toEqual([]);
    // The block is 40 x 30 x 20 with one rounded vertical edge: its box is still 40 x 30 x 20.
    const [l, w, t] = sizes.sizes[0]!.sizes;
    expect([l, w, t].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([40, 30, 20]);
  });
});
