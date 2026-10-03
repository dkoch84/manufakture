// Representations B and C (and the meshers), one measurement per fresh Node process:
//   node scripts/node-child.ts <task> '<json args>'
// prints its result as JSON on the last stdout line. Plain Node: the spike's own sources use
// `.ts` imports and erasable syntax only.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { heapInUse } from '../../../packages/kernel/src/heap-probe.ts';
import { clipMesh, meshVolume, triangleCount } from '../src/clip.ts';
import { allMembers, fixture, type FixtureName } from '../src/fixtures.ts';
import { loadManifold, manifoldMesh, type Counter, type ManifoldHandle } from '../src/manifold.ts';
import { MemberSet, mesherFor, type Mesher } from '../src/member-set.ts';
import { countByRole, shapeKey, type Member } from '../src/members.ts';

type Args = Record<string, unknown>;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const require = createRequire(import.meta.url);

async function manifold(): Promise<ManifoldHandle> {
  const js = require.resolve('manifold-3d/manifold.js');
  const wasm = require.resolve('manifold-3d/manifold.wasm');
  return loadManifold(readFileSync(wasm), readFileSync(js, 'utf8'));
}

async function mesher(kind: string, count?: Counter): Promise<{ mesher: Mesher; loadMs: number }> {
  if (kind === 'clip') return { mesher: mesherFor(clipMesh), loadMs: 0 };
  const t0 = performance.now();
  const h = await manifold();
  const loadMs = performance.now() - t0;
  return { mesher: mesherFor((m) => manifoldMesh(h, m, count)), loadMs };
}

/** Distinct cut shapes, one member each. */
function cutShapes(members: readonly Member[]): Member[] {
  const by = new Map<string, Member>();
  for (const m of members) if (m.cuts.length > 0 && !by.has(shapeKey(m))) by.set(shapeKey(m), m);
  return [...by.values()];
}

function memory() {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, rss: m.rss };
}

const tasks: Record<string, (args: Args) => Promise<unknown>> = {
  /** Member counts by role, shapes and triangles, for both fixtures. */
  async counts() {
    const h = await manifold();
    const out: Record<string, unknown> = {};
    for (const name of ['shed', 'house'] as const) {
      const f = fixture(name);
      const ms = allMembers(f);
      const keys = new Set(ms.map(shapeKey));
      const cut = ms.filter((m) => m.cuts.length > 0);
      const set = new MemberSet(mesherFor(clipMesh));
      for (const [g, gm] of f.groups) set.setGroup(g, gm);
      const setC = new MemberSet(mesherFor((m) => manifoldMesh(h, m)));
      for (const [g, gm] of f.groups) setC.setGroup(g, gm);
      out[name] = {
        members: ms.length,
        byRole: countByRole(ms),
        groups: Object.fromEntries([...f.groups].map(([g, gm]) => [g, gm.length])),
        cutMembers: cut.length,
        notched: cut.filter((m) => m.cuts.some((c) => c.kind === 'notch')).length,
        distinctShapes: keys.size,
        distinctCutShapes: new Set(cut.map(shapeKey)).size,
        largestShareCount: Math.max(
          ...[...keys].map((k) => ms.filter((m) => shapeKey(m) === k).length),
        ),
        clip: set.stats(),
        manifold: setC.stats(),
        dirty: { ...f.dirty, members: f.regenDirty().length },
      };
    }
    return out;
  },

  /** Cold regen in a fresh process: (load manifold,) generate, mesh, instance lists. */
  async cold({ fixture: name, mesher: kind }) {
    const before = memory();
    const t0 = performance.now();
    const { mesher: mesh, loadMs } = await mesher(kind as string);
    const t1 = performance.now();
    const f = fixture(name as FixtureName);
    const t2 = performance.now();
    const set = new MemberSet(mesh);
    for (const [g, ms] of f.groups) set.setGroup(g, ms);
    const t3 = performance.now();
    const inst = set.instances();
    const t4 = performance.now();
    const after = memory();
    return {
      loadMs: round(loadMs),
      generateMs: round(t2 - t1),
      meshMs: round(t3 - t2),
      instancesMs: round(t4 - t3),
      totalMs: round(t4 - t0),
      lists: inst.length,
      ...set.stats(),
      heapUsedGrowthMiB: round((after.heapUsed - before.heapUsed) / 2 ** 20),
      rssMiB: round(after.rss / 2 ** 20, 0),
    };
  },

  /** Warm regen: move the opening (and back), re-frame its wall, mesh new shapes, rebuild instances. */
  async warm({ fixture: name, mesher: kind, runs }) {
    const { mesher: mesh } = await mesher(kind as string);
    const f = fixture(name as FixtureName);
    const set = new MemberSet(mesh);
    for (const [g, ms] of f.groups) set.setGroup(g, ms);
    set.instances();
    const original = f.groups.get(f.dirty.wall)!;
    const times: number[] = [];
    const all: number[] = [];
    let newShapes = 0;
    for (let i = 0; i < (runs as number); i++) {
      const before = set.meshed;
      const t0 = performance.now();
      const ms = i % 2 === 0 ? f.regenDirty() : original;
      set.setGroup(f.dirty.wall, ms);
      set.instances();
      times.push(performance.now() - t0);
      if (i === 0) newShapes = set.meshed - before;
    }
    // Every group again (a wall type or spacing change), with the mesh cache warm.
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const g = fixture(name as FixtureName);
      for (const [k, ms] of g.groups) set.setGroup(k, ms);
      set.instances();
      all.push(performance.now() - t0);
    }
    return {
      wall: f.dirty.wall,
      firstMs: round(times[0]!),
      medianMs: round(median(times)),
      newShapesOnFirstMove: newShapes,
      allGroupsWarmCacheMs: round(median(all)),
      runs,
    };
  },

  /** Own planar clip against Manifold on every distinct cut shape of both fixtures. */
  async meshers({ runs }) {
    const h = await manifold();
    const shapes = [
      ...cutShapes(allMembers(fixture('shed'))),
      ...cutShapes(allMembers(fixture('house'))),
    ];
    const time = (fn: (m: Member) => unknown) => {
      for (const m of shapes) fn(m); // warm-up
      const t: number[] = [];
      for (let r = 0; r < (runs as number); r++) {
        const t0 = performance.now();
        for (const m of shapes) fn(m);
        t.push(performance.now() - t0);
      }
      return median(t);
    };
    const clipMs = time(clipMesh);
    const manifoldMs = time((m) => manifoldMesh(h, m));
    let maxRel = 0;
    let clipTris = 0;
    let manifoldTris = 0;
    for (const m of shapes) {
      const a = clipMesh(m);
      const b = manifoldMesh(h, m);
      clipTris += triangleCount(a);
      manifoldTris += triangleCount(b);
      const va = meshVolume(a);
      maxRel = Math.max(maxRel, Math.abs(va - meshVolume(b)) / va);
    }
    const boxes = allMembers(fixture('house')).filter((m) => m.cuts.length === 0);
    const tb = performance.now();
    for (const m of boxes) clipMesh(m);
    const boxMs = performance.now() - tb;
    return {
      shapes: shapes.length,
      clipMsPerShape: round(clipMs / shapes.length, 4),
      manifoldMsPerShape: round(manifoldMs / shapes.length, 4),
      clipTriangles: clipTris,
      manifoldTriangles: manifoldTris,
      maxVolumeRelDiff: maxRel,
      boxMsPerMember: round(boxMs / boxes.length, 4),
    };
  },

  /** Manifold meshes of every distinct cut shape of a fixture, for the viewport's representation C. */
  async cutMeshes({ fixture: name }) {
    const h = await manifold();
    const out: Record<string, { positions: number[]; normals: number[]; indices: number[] }> = {};
    for (const m of cutShapes(allMembers(fixture(name as FixtureName)))) {
      const mesh = manifoldMesh(h, m);
      out[shapeKey(m)] = {
        positions: [...mesh.positions],
        normals: [...mesh.normals],
        indices: [...mesh.indices],
      };
    }
    return out;
  },

  /**
   * Does Manifold's delete() free? Mesh every distinct cut shape of the house N times on a fresh
   * module, then probe the heap once. `leak` skips the deletes (the control).
   */
  async manifoldLeak({ n, leak }) {
    const h = await manifold();
    if (!h.raw) throw new Error('manifold allocator not found');
    const shapes = cutShapes(allMembers(fixture('house')));
    const count: Counter = { created: 0, deleted: 0 };
    for (let i = 0; i < (n as number); i++)
      for (const m of shapes) manifoldMesh(h, m, count, leak === true);
    return {
      n,
      leak: leak === true,
      ...count,
      memoryBytes: h.raw.memory.buffer.byteLength,
      usedBytes: heapInUse(h.raw),
    };
  },
};

const [task, json] = process.argv.slice(2);
const fn = task ? tasks[task] : undefined;
if (!fn) {
  console.error(`unknown task ${task}; one of ${Object.keys(tasks).join(', ')}`);
  process.exit(2);
}
const result = await fn(JSON.parse(json ?? '{}') as Args);
// Exit only once stdout is flushed: a pipe takes large results in several writes.
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
