// Member data in isolation: shape keys, instance lists, box meshes in TypeScript, cut members
// through Manifold (volumes against hand values, every object deleted, the heap flat over 1,000
// cut members), and the checks a member stage's output goes through.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { heapInUse, type WasmAllocator } from '@manufakture/kernel/testing';
import type { ManifoldToplevel } from 'manifold-3d/manifold';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MemberMeshCache,
  boxMesh,
  checkGroups,
  checkMembers,
  loadManifold,
  manifoldMesh,
  memberInstances,
  memberShapeKey,
  meshVolume,
  type ManifoldCounter,
  type MemberData,
} from './members';

const STOCK = { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 };

function stud(id: string, x: number, extra: Partial<MemberData> = {}): MemberData {
  return {
    id,
    owner: 'extension#1',
    role: 'stud',
    stock: STOCK,
    length: 2352.7,
    placement: { origin: [x, 0, 0], x: [0, 0, 1], y: [1, 0, 0] },
    cuts: [],
    ...extra,
  };
}

const S = Math.SQRT1_2;

/**
 * A rafter-like member: a plumb cut at its top end (a plane at 45 degrees through the far top
 * corner) and a birdsmouth notch (seat and heel, perpendicular) near its foot.
 */
function cutMember(id: string, length = 3000): MemberData {
  return {
    ...stud(id, 0),
    role: 'rafter',
    length,
    cuts: [
      // Removes x + z >= length (in units of 1/sqrt2): the corner above the far top end.
      { kind: 'plane', n: [S, 0, S], k: length * S },
      // Removes x <= 200 and z <= 30 (the notch: dot(-x) >= -200 and dot(-z) >= -30).
      { kind: 'notch', a: { n: [-1, 0, 0], k: -200 }, b: { n: [0, 0, -1], k: -30 } },
    ],
  };
}

/** The volume of `cutMember` by hand: the blank less the 45-degree corner and the notch. */
function cutVolume(length = 3000): number {
  const { width: w, depth: d } = STOCK;
  return length * w * d - (w * d * d) / 2 - 200 * w * 30;
}

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

describe('shape keys and instance lists', () => {
  it('keys by stock, length and local cuts, never by placement', () => {
    const a = stud('s1', 0);
    const b = stud('s2', 406.4);
    expect(memberShapeKey(a)).toBe(memberShapeKey(b));
    expect(memberShapeKey(a)).toBe('us-2x4:38.100x88.900:2352.700:');
    expect(memberShapeKey({ ...a, length: 2352.7004 })).toBe(memberShapeKey(a));
    expect(memberShapeKey({ ...a, length: 2353 })).not.toBe(memberShapeKey(a));
    const cut = cutMember('r1');
    const swapped = { ...cut, cuts: [...cut.cuts].reverse() };
    expect(memberShapeKey(swapped)).toBe(memberShapeKey(cut));
    const negZero: MemberData = {
      ...cut,
      cuts: [{ kind: 'plane', n: [-0, 0, 1], k: -0 }],
    };
    expect(memberShapeKey(negZero)).toBe(
      memberShapeKey({ ...cut, cuts: [{ kind: 'plane', n: [0, 0, 1], k: 0 }] }),
    );
  });

  it('lists 100 identical studs as one shape with 100 transforms', () => {
    const studs = Array.from({ length: 100 }, (_, i) => stud(`s${i}`, i * 406.4));
    const lists = memberInstances(studs);
    expect(lists).toHaveLength(1);
    const [list] = lists;
    expect(list!.ids).toHaveLength(100);
    expect(list!.ids[3]).toBe('extension#1:s3');
    expect(list!.roles.every((r) => r === 'stud')).toBe(true);
    expect(list!.matrices).toHaveLength(1600);
    // Column-major: x axis, y axis, z = x cross y, then the origin.
    expect([...list!.matrices.subarray(16 * 3, 16 * 4)]).toEqual([
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      Math.fround(3 * 406.4),
      0,
      0,
      1,
    ]);
  });
});

describe('meshes', () => {
  it('meshes a box in TypeScript: 12 outward triangles enclosing the blank', () => {
    const mesh = boxMesh(2352.7, 38.1, 88.9);
    expect(mesh.indices).toHaveLength(36);
    expect(meshVolume(mesh)).toBeCloseTo(2352.7 * 38.1 * 88.9, 0);
    // Each face's normal points away from the box's centre.
    for (let v = 0; v < 24; v++) {
      const p = [0, 1, 2].map((i) => mesh.positions[v * 3 + i]!);
      const n = [0, 1, 2].map((i) => mesh.normals[v * 3 + i]!);
      const centre = [2352.7 / 2, 38.1 / 2, 88.9 / 2];
      expect(n.reduce((s, ni, i) => s + ni * (p[i]! - centre[i]!), 0)).toBeGreaterThan(0);
    }
  });

  it('meshes a cut member through Manifold to its exact volume, deleting every object', () => {
    const count: ManifoldCounter = { created: 0, deleted: 0 };
    const mesh = manifoldMesh(wasm, cutMember('r1'), count);
    expect(meshVolume(mesh) / cutVolume()).toBeCloseTo(1, 6);
    expect(count.created).toBeGreaterThan(0);
    expect(count.deleted).toBe(count.created);
  });

  it('deletes every object even when a boolean throws', () => {
    const count: ManifoldCounter = { created: 0, deleted: 0 };
    const bad = { ...cutMember('r1'), cuts: [{ kind: 'plane', n: [NaN, 0, 0], k: 1 }] } as never;
    try {
      manifoldMesh(wasm, bad, count);
    } catch {
      // Whatever Manifold makes of it, nothing stays alive.
    }
    expect(count.deleted).toBe(count.created);
  });

  it('caches one mesh per shape and loads Manifold only for a member with cuts', async () => {
    let loads = 0;
    const cache = new MemberMeshCache(async () => {
      loads++;
      return wasm;
    });
    const studs = Array.from({ length: 50 }, (_, i) => stud(`s${i}`, i * 406.4));
    expect(await cache.ensure(studs)).toEqual(new Map());
    expect([cache.size, cache.made, loads]).toEqual([1, 1, 0]);
    expect(cache.manifoldRequested).toBe(false);
    const rafters = [cutMember('r1'), cutMember('r2'), cutMember('r3', 2500)];
    expect(await cache.ensure([...studs, ...rafters])).toEqual(new Map());
    expect([cache.size, cache.made, loads]).toEqual([3, 3, 1]);
    await cache.ensure(rafters);
    expect([cache.made, loads]).toEqual([3, 1]);
    expect(cache.retain(new Set([memberShapeKey(studs[0]!)]))).toHaveLength(2);
    expect(cache.size).toBe(1);
  });

  it('reports the shapes it cannot mesh, and asks for Manifold again after a failed load', async () => {
    let fail = true;
    const cache = new MemberMeshCache(async () => {
      if (fail) throw new Error('no wasm here');
      return wasm;
    });
    const failed = await cache.ensure([stud('s1', 0), cutMember('r1')]);
    expect([...failed.values()]).toEqual(['Manifold did not load: no wasm here']);
    expect(cache.size).toBe(1);
    fail = false;
    expect(await cache.ensure([cutMember('r1')])).toEqual(new Map());
    // A cut that leaves nothing.
    const gone = {
      ...stud('s2', 0),
      cuts: [{ kind: 'plane' as const, n: [1, 0, 0] as const, k: -1 }],
    };
    expect([...(await cache.ensure([gone])).values()]).toEqual(['its cuts leave nothing of it']);
  });
});

/**
 * A fresh Manifold module whose allocator the heap probe can reach: instantiated from the bytes
 * so the instance's exports are at hand, with `malloc` and `free` found by their names in the glue
 * (as the T6.5a spike did).
 */
async function probedManifold(): Promise<{ wasm: ManifoldToplevel; allocator: WasmAllocator }> {
  const require = createRequire(import.meta.url);
  const bytes = readFileSync(require.resolve('manifold-3d/manifold.wasm'));
  const glue = readFileSync(require.resolve('manifold-3d/manifold.js'), 'utf8');
  const { default: Module } = await import('manifold-3d/manifold');
  let instance: WebAssembly.Instance | undefined;
  const options = {
    instantiateWasm(imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance) => void) {
      void WebAssembly.instantiate(bytes, imports).then((r) => {
        instance = r.instance;
        receive(r.instance);
      });
      return {};
    },
  };
  const module = await (Module as (o: unknown) => Promise<ManifoldToplevel>)(options);
  module.setup();
  const name = (re: RegExp) => glue.match(re)?.[1];
  const malloc = name(/_malloc=wasmExports\["(\w+)"\]/)!;
  const free = name(/_free=wasmExports\["(\w+)"\]/)!;
  const ex = instance!.exports as Record<string, unknown>;
  const memory = Object.values(ex).find((e) => e instanceof WebAssembly.Memory)!;
  return {
    wasm: module,
    allocator: {
      memory: memory as WebAssembly.Memory,
      malloc: (n) => (ex[malloc] as (n: number) => number)(n),
      free: (p) => void (ex[free] as (p: number) => void)(p),
    },
  };
}

describe('Manifold memory', () => {
  it('stays flat over 1,000 cut members made and deleted', async () => {
    // T6.5a's method: the same work N times on a fresh module, one probe at the end, two N.
    const inUse = async (n: number) => {
      const { wasm: fresh, allocator } = await probedManifold();
      const count: ManifoldCounter = { created: 0, deleted: 0 };
      for (let i = 0; i < n; i++) manifoldMesh(fresh, cutMember(`r${i}`, 2000 + i), count);
      expect(count.deleted).toBe(count.created);
      return heapInUse(allocator);
    };
    const few = await inUse(10);
    const many = await inUse(1000);
    // A leak of one object per member would be tens of KiB per member; allow 256 KiB in all.
    expect(Math.abs(many - few)).toBeLessThan(256 * 1024);
  }, 60_000);
});

describe('checking what a member stage returns', () => {
  const group = { id: 'extension#1', features: ['extension#1', 'extension#2'] };
  const check = (out: unknown) => checkMembers('frame', group, out);

  it('copies well-formed members out, frozen', () => {
    const given = { members: [stud('s1', 0), { ...stud('king-l', 0), owner: 'extension#2' }] };
    const got = check(given);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.members).toEqual(given.members);
    expect(got.members[0]).not.toBe(given.members[0]);
    expect(Object.isFrozen(got.members[0]!.placement.origin)).toBe(true);
  });

  it('refuses malformed members with the reason', () => {
    const bad = (m: Partial<MemberData> | Record<string, unknown>) =>
      check({ members: [{ ...stud('s1', 0), ...m }] });
    const message = (r: ReturnType<typeof check>) => (r.ok ? '' : r.error.message);
    expect(message(bad({ owner: 'extension#9' }))).toMatch(/not a feature of its group/);
    expect(message(bad({ length: -1 }))).toMatch(/length/);
    expect(message(bad({ placement: { origin: [0, 0, 0], x: [2, 0, 0], y: [0, 1, 0] } }))).toMatch(
      /not a unit vector/,
    );
    expect(message(bad({ placement: { origin: [0, 0, 0], x: [1, 0, 0], y: [S, S, 0] } }))).toMatch(
      /not perpendicular/,
    );
    expect(message(bad({ cuts: [{ kind: 'dado' }] }))).toMatch(/unknown kind/);
    expect(message(check({ members: [stud('s1', 0), stud('s1', 9)] }))).toMatch(
      /two members are extension#1:s1/,
    );
    expect(message(check({ nope: true }))).toMatch(/expected \{ members \}/);
    expect(
      bad({ owner: 'x' }).ok ? '' : (bad({ owner: 'x' }) as { error: { code: string } }).error.code,
    ).toBe('extension');
  });

  it('turns a failure value into an invalid error, and checks warnings', () => {
    expect(check({ error: 'no wall type' })).toEqual({
      ok: false,
      error: { code: 'invalid', message: 'no wall type' },
    });
    const got = check({
      members: [],
      warnings: [
        { feature: 'extension#2', message: 'wider than any rule', code: 'no-header-rule' },
      ],
    });
    expect(got).toMatchObject({
      ok: true,
      warnings: [{ feature: 'extension#2', code: 'no-header-rule' }],
    });
    expect(check({ members: [], warnings: [{ feature: 'extension#7', message: 'x' }] }).ok).toBe(
      false,
    );
  });

  it('checks groups: unique ids, built features only', () => {
    const given = new Set(['extension#1', 'extension#2']);
    expect(checkGroups('frame', [{ id: 'g', features: ['extension#1'] }], given).ok).toBe(true);
    expect(checkGroups('frame', [{ id: 'g', features: [] }], given).ok).toBe(false);
    expect(checkGroups('frame', [{ id: 'g', features: ['extension#3'] }], given).ok).toBe(false);
    const twice = [
      { id: 'g', features: ['extension#1'] },
      { id: 'g', features: ['extension#2'] },
    ];
    expect(checkGroups('frame', twice, given)).toMatchObject({
      ok: false,
      error: { code: 'extension', message: 'The "frame" member grouping failed: two groups are g' },
    });
  });
});
