// Member sets through the engine (ADR 0015 decision 5): a fake framing domain whose member stage
// frames each wall with the openings that name it. Against the scripted kernel: shared meshes,
// per-group caching, what an edit re-sends, recycles, containment. Against the real kernel:
// member B-reps on demand with exact volumes, released after. Through Comlink on a
// MessageChannel: the transfer round trip and its size for a shed-sized set.

import { readFile } from 'node:fs/promises';
import {
  diffDocuments,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import type { KernelEndpoint } from '@manufakture/kernel/kernel-client';
import { createNodeService, wasmPath } from '@manufakture/kernel/node';
import * as Comlink from 'comlink';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache } from './cache';
import { RegenClient } from './client';
import { RegenEngine } from './engine';
import { ExtensionRegistry, type ExtensionDomain, type ExtensionType } from './extensions';
import { FakeKernel, FakeSolver } from './fake-kernel';
import { meshVolume, type MemberData, type MemberFeature, type MemberStage } from './members';
import {
  PART,
  add,
  apply,
  build,
  extrude,
  mm,
  rectangle,
  setVariable,
  statuses,
} from './test-helpers';
import { regenTransferables } from './transfer';
import type { RegenResult } from './types';
import { createRegenWorkerApi } from './worker-api';

// A fake framing domain -----------------------------------------------------------------------

const STOCK = { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 };
const HEIGHT = 2352.7;
const SPACING = 400;
const S = Math.SQRT1_2;

interface WallMeta {
  length: number;
  y: number;
  /** Add a rafter with a plumb cut and a birdsmouth. */
  rafter: boolean;
}

interface OpeningMeta {
  wall: string;
  at: number;
}

const wall: ExtensionType = {
  schemaVersion: 1,
  expressions: { length: 'length' },
  translate(ctx) {
    const p = ctx.params as { y?: number; rafter?: boolean };
    const metadata = { length: ctx.values.length!, y: p.y ?? 0, rafter: p.rafter ?? false };
    return { inputs: [], metadata };
  },
};

const opening: ExtensionType = {
  schemaVersion: 1,
  expressions: { at: 'length' },
  translate(ctx) {
    return { inputs: [], metadata: { wall: ctx.feature.dependsOn[0]!, at: ctx.values.at! } };
  },
};

function rafter(owner: string, y: number, length = 3000): MemberData {
  return {
    id: 'rafter',
    owner,
    role: 'rafter',
    stock: STOCK,
    length,
    placement: { origin: [0, y + 1000, HEIGHT], x: [1, 0, 0], y: [0, 1, 0] },
    cuts: [
      { kind: 'plane', n: [S, 0, S], k: length * S },
      { kind: 'notch', a: { n: [-1, 0, 0], k: -200 }, b: { n: [0, 0, -1], k: -30 } },
    ],
  };
}

const rafterVolume = (length = 3000) =>
  length * STOCK.width * STOCK.depth -
  (STOCK.width * STOCK.depth ** 2) / 2 -
  200 * STOCK.width * 30;

/** What the tests make the stage do. */
const behaviour = {
  throwFor: null as string | null,
  malformedFor: null as string | null,
  warn: false,
};
/** Group ids `frame` ran for, in order. */
const framedLog: string[] = [];

const stage: MemberStage = {
  groups({ features }) {
    return features
      .filter((f) => f.type === 'frame.wall')
      .map((w) => ({
        id: w.id,
        features: [
          w.id,
          ...features
            .filter(
              (f) =>
                f.type === 'frame.opening' && (f.metadata as unknown as OpeningMeta).wall === w.id,
            )
            .map((f) => f.id),
        ],
      }));
  },
  frame({ group, features }) {
    framedLog.push(group.id);
    if (behaviour.throwFor === group.id) throw new Error('the layout is broken');
    const [w, ...openings] = features as [MemberFeature, ...MemberFeature[]];
    const meta = w.metadata as unknown as WallMeta;
    const ats = openings.map((o) => (o.metadata as unknown as OpeningMeta).at);
    const members: MemberData[] = [];
    for (let i = 0; i * SPACING < meta.length; i++) {
      const x = i * SPACING;
      if (ats.some((at) => Math.abs(x - at) < 500)) continue;
      members.push({
        id: `s${i}`,
        owner: w.id,
        role: 'stud',
        stock: STOCK,
        length: HEIGHT,
        placement: { origin: [x, meta.y, 0], x: [0, 0, 1], y: [1, 0, 0] },
        cuts: [],
      });
    }
    for (const [i, o] of openings.entries()) {
      members.push({
        id: 'header',
        owner: o.id,
        role: 'header',
        stock: STOCK,
        length: 1000,
        placement: { origin: [ats[i]! - 500, meta.y, 2000], x: [1, 0, 0], y: [0, 1, 0] },
        cuts: [],
      });
    }
    if (meta.rafter) members.push(rafter(w.id, meta.y));
    if (behaviour.malformedFor === group.id) {
      members.push({
        ...members[0]!,
        id: 'bent',
        placement: { origin: [0, 0, 0], x: [2, 0, 0], y: [0, 1, 0] },
      });
    }
    const warnings = behaviour.warn
      ? [{ feature: w.id, message: 'a rule of thumb', code: 'splice-offset', member: `${w.id}:s0` }]
      : [];
    return {
      members,
      warnings,
      metadata: { studs: members.filter((m) => m.role === 'stud').length },
    };
  },
};

const domain = (): ExtensionDomain => ({
  namespace: 'frame',
  implementation: 1,
  types: { 'frame.wall': wall, 'frame.opening': opening },
  members: stage,
});

function wallFeature(
  id: string,
  length: string,
  params: Record<string, unknown> = {},
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'frame.wall',
    schemaVersion: 1,
    dependsOn: [],
    references: [],
    expressions: { length: mm(length) },
    params: params as never,
  };
}

function openingFeature(id: string, host: string, at: string): ExtensionFeature {
  return {
    ...wallFeature(id, '0'),
    extension: 'frame.opening',
    dependsOn: [host],
    expressions: { at: mm(at) },
  };
}

/** A block body, and two walls whose lengths are the variables `w1` and `w2`. */
function twoWalls(extra: Command[] = []): ManufaktureDocument {
  return build([
    setVariable('w1', '4000'),
    setVariable('w2', '3000'),
    setVariable('d', '20'),
    add(rectangle('sketch#1', { width: '40', depth: '30' })),
    add(extrude('extrude#1', 'sketch#1', 'd')),
    add(wallFeature('extension#1', 'w1')),
    add(wallFeature('extension#2', 'w2', { y: 3000 })),
    ...extra,
  ]);
}

function setup(manifold?: () => Promise<never>) {
  const registry = new ExtensionRegistry();
  registry.registerDomain(domain());
  const kernel = new FakeKernel();
  const engine = new RegenEngine({
    kernel,
    solver: new FakeSolver(),
    cache: new MemoryCache(),
    extensions: registry,
    ...(manifold === undefined ? {} : { manifold }),
  });
  return { kernel, engine };
}

async function regen(
  engine: RegenEngine,
  doc: ManufaktureDocument,
  previous?: ManufaktureDocument,
) {
  const r =
    previous === undefined
      ? await engine.regen(doc)
      : await engine.regen(doc, { previous, change: diffDocuments(previous, doc) });
  if (r === null) throw new Error('superseded');
  return r;
}

const setsOf = (r: RegenResult) => r.parts[0]!.members ?? [];
const setOf = (r: RegenResult, group: string) => setsOf(r).find((s) => s.group === group)!;

beforeEach(() => {
  behaviour.throwFor = null;
  behaviour.malformedFor = null;
  behaviour.warn = false;
  framedLog.length = 0;
});

// Tests ---------------------------------------------------------------------------------------

describe('member sets', () => {
  it('registers a member stage only with both functions', () => {
    const registry = new ExtensionRegistry();
    expect(() =>
      registry.registerDomain({ ...domain(), members: { groups: () => [] } as never }),
    ).toThrow(/needs groups and frame/);
    registry.registerDomain(domain());
    expect(registry.memberStages().map((s) => [s.namespace, s.implementation])).toEqual([
      ['frame', 1],
    ]);
  });

  it("carries a group's members next to the bodies, 100 identical studs sharing one mesh", async () => {
    const { engine } = setup();
    const doc = build([add(wallFeature('extension#1', '40000'))]);
    const r = await regen(engine, doc);
    expect(statuses(r)).toEqual({ 'extension#1': 'ok' });
    const [set] = setsOf(r);
    expect(set).toMatchObject({
      group: 'extension#1',
      namespace: 'frame',
      features: ['extension#1'],
      cached: false,
      changed: true,
      count: 100,
      metadata: { studs: 100 },
    });
    expect(set!.members).toHaveLength(100);
    expect(set!.instances).toHaveLength(1);
    expect(set!.instances![0]!.ids).toHaveLength(100);
    expect(set!.instances![0]!.ids[99]).toBe('extension#1:s99');
    expect(set!.instances![0]!.matrices).toHaveLength(1600);
    // One mesh for the 100 studs: a 12-triangle box, sent once.
    expect(r.memberMeshes!.added).toHaveLength(1);
    expect(r.memberMeshes!.removed).toEqual([]);
    const mesh = r.memberMeshes!.added[0]!;
    expect(mesh.key).toBe(set!.instances![0]!.shape);
    expect(mesh.indices).toHaveLength(36);
    expect(meshVolume(mesh)).toBeCloseTo(HEIGHT * STOCK.width * STOCK.depth, 0);
    expect(engine.memberStats).toMatchObject({ framed: 1, meshesMade: 1, meshes: 1, groups: 1 });
  });

  it('frames a wall with the openings that name it; their members belong to the opening', async () => {
    const { engine } = setup();
    const doc = twoWalls([add(openingFeature('extension#3', 'extension#1', '2000'))]);
    const r = await regen(engine, doc);
    expect(setsOf(r).map((s) => [s.group, s.features])).toEqual([
      ['extension#1', ['extension#1', 'extension#3']],
      ['extension#2', ['extension#2']],
    ]);
    const ids = setOf(r, 'extension#1').members!.map((m) => `${m.owner}:${m.id}`);
    expect(ids).toContain('extension#3:header');
    expect(ids).not.toContain('extension#1:s5'); // x = 2000, where the opening is
    // A suppressed opening is not framed: the wall gets its stud back.
    const suppressed = apply(doc, {
      type: 'suppressFeature',
      partId: PART,
      featureId: 'extension#3',
      suppressed: true,
    });
    const again = await regen(engine, suppressed, doc);
    expect(setOf(again, 'extension#1').features).toEqual(['extension#1']);
    expect(setOf(again, 'extension#1').members!.map((m) => m.id)).toContain('s5');
  });

  it('serves every group from the cache on a regen that changes nothing, and sends nothing again', async () => {
    const { engine } = setup();
    const doc = twoWalls();
    await regen(engine, doc);
    expect(framedLog).toEqual(['extension#1', 'extension#2']);
    const again = await regen(engine, doc);
    expect(framedLog).toHaveLength(2);
    for (const set of setsOf(again)) {
      expect(set).toMatchObject({ cached: true, changed: false, members: null, instances: null });
    }
    expect(again.memberMeshes).toBeUndefined();
    expect(engine.memberStats).toMatchObject({ framed: 2, cacheHits: 2 });
  });

  it("re-sends only the edited wall's set", async () => {
    const { engine } = setup();
    const doc = twoWalls();
    const first = await regen(engine, doc);
    const edited = apply(doc, setVariable('w2', '3400'));
    const r = await regen(engine, edited, doc);
    expect(framedLog).toEqual(['extension#1', 'extension#2', 'extension#2']);
    expect(setOf(r, 'extension#1')).toMatchObject({ cached: true, changed: false, members: null });
    expect(setOf(r, 'extension#2')).toMatchObject({ cached: false, changed: true, count: 9 });
    expect(setOf(r, 'extension#2').setKey).not.toBe(setOf(first, 'extension#2').setKey);
    // Its studs have a shape the main thread already has.
    expect(r.memberMeshes).toBeUndefined();
  });

  it('keeps member sets through a kernel recycle: bodies are rebuilt, members are not', async () => {
    const { kernel, engine } = setup();
    const doc = twoWalls();
    await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extrude#1']);
    kernel.recycle();
    const edited = apply(doc, setVariable('d', '25'));
    const r = await regen(engine, edited, doc);
    expect(kernel.featureOps).toEqual(['extrude#1', 'extrude#1']);
    expect(kernel.live.has(r.parts[0]!.bodies[0]!.shape)).toBe(true);
    expect(framedLog).toEqual(['extension#1', 'extension#2']);
    expect(setsOf(r).every((s) => s.cached && !s.changed)).toBe(true);
    expect(engine.memberStats.meshesMade).toBe(1);
  });

  it('drops the set of a deleted wall and the meshes no member uses any more', async () => {
    const { engine } = setup();
    const doc = twoWalls([add(openingFeature('extension#3', 'extension#1', '2000'))]);
    const first = await regen(engine, doc);
    const header = setOf(first, 'extension#1').instances!.find((l) => l.roles[0] === 'header')!;
    const deleted = apply(
      doc,
      { type: 'deleteFeature', partId: PART, featureId: 'extension#3' },
      { type: 'deleteFeature', partId: PART, featureId: 'extension#1' },
    );
    const r = await regen(engine, deleted, doc);
    expect(setsOf(r).map((s) => s.group)).toEqual(['extension#2']);
    expect(r.memberMeshes).toEqual({ added: [], removed: [header.shape] });
    expect(engine.memberStats).toMatchObject({ meshes: 1, groups: 1 });
  });

  it('meshes members with cuts through Manifold, once per shape', async () => {
    const { engine } = setup();
    const doc = build([
      add(wallFeature('extension#1', '1200', { rafter: true })),
      add(wallFeature('extension#2', '1200', { rafter: true, y: 5000 })),
    ]);
    const r = await regen(engine, doc);
    const meshes = r.memberMeshes!.added;
    expect(meshes).toHaveLength(2); // the stud and the (shared) rafter
    // A shape key ends with its cuts: empty for the stud.
    const cut = meshes.find((m) => !m.key.endsWith(':'))!;
    expect(meshVolume(cut) / rafterVolume()).toBeCloseTo(1, 6);
    const stats = engine.memberStats;
    expect(stats.manifoldCreated).toBeGreaterThan(0);
    expect(stats.manifoldDeleted).toBe(stats.manifoldCreated);
  });

  it('fails only the group whose stage throws, never the regen', async () => {
    const { engine } = setup();
    behaviour.throwFor = 'extension#2';
    const r = await regen(engine, twoWalls());
    expect(statuses(r)).toMatchObject({
      'extrude#1': 'ok',
      'extension#1': 'ok',
      'extension#2': 'error',
    });
    const failed = r.parts[0]!.features.find((f) => f.featureId === 'extension#2')!;
    expect(failed.errors).toEqual([
      {
        code: 'extension',
        message: 'The "frame" member stage (group extension#2) failed: the layout is broken',
      },
    ]);
    expect(setsOf(r).map((s) => s.group)).toEqual(['extension#1']);
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extrude#1']);
  });

  it('refuses a malformed member with an error on the group, and reports warnings', async () => {
    const { engine } = setup();
    behaviour.malformedFor = 'extension#1';
    behaviour.warn = true;
    const r = await regen(engine, twoWalls());
    const results = r.parts[0]!.features;
    expect(results.find((f) => f.featureId === 'extension#1')).toMatchObject({
      status: 'error',
      errors: [{ code: 'extension', message: expect.stringMatching(/"bent".*not a unit vector/) }],
    });
    expect(results.find((f) => f.featureId === 'extension#2')).toMatchObject({
      status: 'ok',
      warnings: [
        {
          code: 'members',
          message: 'a rule of thumb',
          group: 'extension#2',
          domainCode: 'splice-offset',
          member: 'extension#2:s0',
        },
      ],
    });
  });

  it('fails the groups with cut members when Manifold does not load, and loads it again later', async () => {
    let fail = true;
    const { engine } = setup(async () => {
      if (fail) throw new Error('the asset is missing');
      const { loadManifold } = await import('./members');
      return (await loadManifold()) as never;
    });
    const doc = build([
      add(wallFeature('extension#1', '1200', { rafter: true })),
      add(wallFeature('extension#2', '1200', { y: 4000 })),
    ]);
    const r = await regen(engine, doc);
    expect(statuses(r)).toEqual({ 'extension#1': 'error', 'extension#2': 'ok' });
    expect(r.parts[0]!.features[0]!.errors[0]!.message).toBe(
      'Member extension#1:rafter could not be meshed: Manifold did not load: the asset is missing',
    );
    fail = false;
    const again = await regen(engine, doc);
    expect(statuses(again)).toEqual({ 'extension#1': 'ok', 'extension#2': 'ok' });
  });
});

describe('the result crosses the worker boundary', () => {
  it('transfers matrices and new meshes, and the worker keeps its own meshes', async () => {
    const { engine } = setup();
    const doc = build([
      setVariable('w1', '4000'),
      add(wallFeature('extension#1', 'w1')),
      add(wallFeature('extension#2', '3000', { y: 3000 })),
    ]);
    const r = await regen(engine, doc);
    const buffers = regenTransferables(r);
    const lists = setsOf(r).flatMap((s) => s.instances!);
    expect(buffers).toEqual(
      expect.arrayContaining([
        ...lists.map((l) => l.matrices.buffer),
        ...r.memberMeshes!.added.flatMap((m) => [
          m.positions.buffer,
          m.normals.buffer,
          m.indices.buffer,
        ]),
      ]),
    );
    const copy = structuredClone(r, { transfer: buffers });
    expect(copy.parts[0]!.members).toHaveLength(2);
    expect(copy.parts[0]!.members![0]!.instances![0]!.matrices).toBeInstanceOf(Float32Array);
    expect(copy.memberMeshes!.added[0]!.indices).toHaveLength(36);
    // Detached here; the engine's cache still has the mesh (a later regen meshes nothing).
    expect(r.memberMeshes!.added[0]!.positions.byteLength).toBe(0);
    await regen(engine, apply(doc, setVariable('w1', '4400')), doc);
    expect(engine.memberStats.meshesMade).toBe(1);
  });
});

// The real kernel ---------------------------------------------------------------------------

describe('member B-reps on demand (real kernel)', () => {
  let service: KernelService;
  beforeAll(async () => {
    service = await createNodeService();
  }, 60_000);

  it("builds members' B-reps with their exact volumes, exports one STEP, and releases them", async () => {
    const registry = new ExtensionRegistry();
    registry.registerDomain(domain());
    const engine = new RegenEngine({
      kernel: service,
      solver: new FakeSolver(),
      extensions: registry,
    });
    const doc = build([
      add(wallFeature('extension#1', '1200', { rafter: true })),
      add(openingFeature('extension#2', 'extension#1', '600')),
    ]);
    await regen(engine, doc);
    const before = service.stats().shapeCount;
    const ids = ['extension#1:s0', 'extension#1:rafter', 'extension#2:header', 'extension#1:nope'];
    const r = (await engine.memberBodies(PART, ids, { volumes: true, step: true }))!;
    expect(r.missing).toEqual(['extension#1:nope']);
    expect(r.bodies.map((b) => [b.id, b.ok, b.error])).toEqual([
      ['extension#1:s0', true, undefined],
      ['extension#1:rafter', true, undefined],
      ['extension#2:header', true, undefined],
    ]);
    const volume = (id: string) => r.bodies.find((b) => b.id === id)!.volume!;
    expect(volume('extension#1:s0') / (HEIGHT * STOCK.width * STOCK.depth)).toBeCloseTo(1, 9);
    expect(volume('extension#1:rafter') / rafterVolume()).toBeCloseTo(1, 9);
    expect(volume('extension#2:header') / (1000 * STOCK.width * STOCK.depth)).toBeCloseTo(1, 9);
    // One batch per owner, plus the export.
    expect(r.batches).toBe(3);
    const text = new TextDecoder().decode(r.step!.subarray(0, 200));
    expect(text.startsWith('ISO-10303-21')).toBe(true);
    expect(new TextDecoder().decode(r.step!)).toContain('extension#1:rafter');
    // Nothing kept between requests.
    expect(service.stats().shapeCount).toBe(before);
  }, 60_000);

  it('keeps member sets through a real recycle, and builds B-reps on the new instance', async () => {
    const registry = new ExtensionRegistry();
    registry.registerDomain(domain());
    let recycled = 0;
    const engine = new RegenEngine({
      kernel: service,
      solver: new FakeSolver(),
      extensions: registry,
      onKernelRecycled: () => recycled++,
    });
    const doc = build([
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add(wallFeature('extension#2', '1200', { rafter: true })),
    ]);
    const first = await regen(engine, doc);
    framedLog.length = 0;
    await service.recycle();
    expect(recycled).toBe(1);
    const r = await regen(engine, doc);
    expect(r.counters.featureOps).toBe(1); // the extrude, rebuilt
    expect(framedLog).toEqual([]);
    expect(r.parts[0]!.members![0]).toMatchObject({ cached: true, changed: false });
    expect(r.parts[0]!.members![0]!.setKey).toBe(first.parts[0]!.members![0]!.setKey);
    const bodies = (await engine.memberBodies(PART, ['extension#2:rafter'], { volumes: true }))!;
    expect(bodies.bodies[0]!.volume! / rafterVolume()).toBeCloseTo(1, 9);
  }, 60_000);
});

// Through the worker protocol ---------------------------------------------------------------

/**
 * A shed-sized member set (T6.5a's shed: 147 members): four walls of studs at 16" with plates,
 * kings, jacks, headers and cripples, rafters with cuts in two lengths, gable studs.
 */
const shedStage: MemberStage = {
  groups: ({ features }) => [{ id: features[0]!.id, features: [features[0]!.id] }],
  frame({ group }) {
    const owner = group.id;
    const members: MemberData[] = [];
    const box = (id: string, role: string, length: number, origin: [number, number, number]) =>
      members.push({
        id,
        owner,
        role,
        stock: STOCK,
        length,
        placement: { origin, x: [0, 0, 1], y: [1, 0, 0] },
        cuts: [],
      });
    const walls = [4877, 4877, 3658, 3658];
    walls.forEach((len, w) => {
      for (let i = 0; i * 406.4 < len; i++)
        box(`w${w}:s${i}`, 'stud', HEIGHT, [i * 406.4, w * 4000, 0]);
      for (const c of ['bottom', 'top1', 'top2'])
        box(`w${w}:${c}`, 'plate', len, [0, w * 4000, 3000]);
      for (const r of ['king-l', 'king-r', 'jack-l', 'jack-r'])
        box(`w${w}:${r}`, r, 2000 + w, [0, w * 4000, 0]);
      for (const h of ['header-1', 'header-2'])
        box(`w${w}:${h}`, 'header', 1000, [0, w * 4000, 2000]);
    });
    for (let i = 0; i < 26; i++) {
      members.push({ ...rafter(owner, i * 406.4, i % 2 === 0 ? 2400 : 2600), id: `r${i}` });
    }
    for (let i = 0; i < 16; i++) {
      members.push({
        ...rafter(owner, 0, 600 + 100 * (i % 8)),
        id: `g${i}`,
        role: 'gable-stud',
        cuts: [{ kind: 'plane', n: [S, 0, S], k: (600 + 100 * (i % 8)) * S }],
      });
    }
    while (members.length < 147)
      box(`c${members.length}`, 'cripple', 300, [members.length * 10, 0, 0]);
    return { members };
  },
};

describe('member sets through the regen worker', () => {
  const channels: MessagePort[] = [];
  let client: RegenClient;

  beforeAll(async () => {
    const bytes = new Uint8Array(await readFile(wasmPath()));
    const registry = new ExtensionRegistry();
    registry.registerDomain({ ...domain(), members: shedStage });
    const api = createRegenWorkerApi({
      source: {
        url: 'kernel.wasm',
        fetch: async () =>
          new Response(bytes.slice(), {
            headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.length) },
          }),
      },
      engine: { extensions: registry },
    });
    client = new RegenClient((): KernelEndpoint => {
      const { port1, port2 } = new MessageChannel();
      channels.push(port1, port2);
      Comlink.expose(api, port1);
      return { endpoint: port2, terminate: () => port1.close() };
    });
    await client.ready;
  }, 60_000);

  afterAll(() => {
    client.terminate();
    for (const p of channels) p.close();
  });

  it("sends a shed's member set once, with typed arrays, and measures its size", async () => {
    const doc = build([add(wallFeature('extension#1', '1'))]);
    const r = (await client.regen(doc))!;
    const [set] = r.parts[0]!.members!;
    expect(set!.count).toBe(147);
    const lists = set!.instances!;
    expect(lists.every((l) => l.matrices instanceof Float32Array)).toBe(true);
    expect(lists.reduce((n, l) => n + l.ids.length, 0)).toBe(147);
    const meshes = r.memberMeshes!.added;
    expect(meshes.length).toBe(lists.length);
    const matrixBytes = lists.reduce((n, l) => n + l.matrices.byteLength, 0);
    const meshBytes = meshes.reduce(
      (n, m) => n + m.positions.byteLength + m.normals.byteLength + m.indices.byteLength,
      0,
    );
    const membersJson = JSON.stringify(set!.members).length;
    const listsJson = JSON.stringify(lists.map((l) => [l.shape, l.ids, l.roles])).length;
    expect(matrixBytes).toBe(147 * 64);
    // Recorded in the README ("Member sets"): what one cold regen of a shed sends.
    console.log(
      `shed member set: ${set!.count} members, ${meshes.length} shapes; matrices ${matrixBytes} B, meshes ${meshBytes} B (transferred); members ${membersJson} B and lists ${listsJson} B as JSON (cloned)`,
    );
    // Unchanged: nothing is sent again.
    const again = (await client.regen(doc))!;
    expect(again.parts[0]!.members![0]).toMatchObject({
      changed: false,
      members: null,
      instances: null,
    });
    expect(again.memberMeshes).toBeUndefined();
    // B-reps through the worker: the STEP bytes arrive, transferred.
    const bodies = (await client.memberBodies(PART, ['extension#1:r0'], { step: true }))!;
    expect(bodies.bodies[0]!.ok).toBe(true);
    expect(bodies.step).toBeInstanceOf(Uint8Array);
  }, 60_000);
});
