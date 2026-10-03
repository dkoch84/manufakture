// Representation C's mesher for cut members: manifold-3d 3.5.4. Every Manifold is a wasm object
// that must be deleted; `track` counts creations and deletions so the spike can prove it frees
// what it makes, and `manifoldAllocator` exposes the module's allocator to the heap probe.

import type { ManifoldToplevel, Manifold } from 'manifold-3d/manifold';
import type { MeshData } from './clip.ts';
import type { Cut } from './members.ts';

export interface ManifoldHandle {
  wasm: ManifoldToplevel;
  /** The module's memory and allocator, when it was loaded with `instantiate`. */
  raw?: { memory: WebAssembly.Memory; malloc(size: number): number; free(ptr: number): void };
}

export interface Counter {
  created: number;
  deleted: number;
}

/**
 * Load manifold. `bytes` and `glue` (the text of manifold.js, to find the minified names of
 * `malloc` and `free`) are for Node; the browser path is not used by the spike.
 */
export async function loadManifold(bytes?: Uint8Array, glue?: string): Promise<ManifoldHandle> {
  const factory = (await import('manifold-3d/manifold')).default;
  let instance: WebAssembly.Instance | undefined;
  const options = bytes
    ? {
        instantiateWasm(imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance) => void) {
          void WebAssembly.instantiate(bytes as BufferSource, imports).then((r) => {
            instance = r.instance;
            receive(r.instance);
          });
          return {};
        },
      }
    : {};
  const wasm = await factory(options as never);
  wasm.setup();
  if (!instance || !glue) return { wasm };
  const name = (re: RegExp) => glue.match(re)?.[1];
  const malloc = name(/_malloc=wasmExports\["(\w+)"\]/);
  const free = name(/_free=wasmExports\["(\w+)"\]/);
  const memory = Object.values(instance.exports).find((e) => e instanceof WebAssembly.Memory);
  if (!malloc || !free || !memory) return { wasm };
  const ex = instance.exports as Record<string, (n: number) => number>;
  return {
    wasm,
    raw: {
      memory: memory as WebAssembly.Memory,
      malloc: (n) => ex[malloc]!(n),
      free: (p) => void ex[free]!(p),
    },
  };
}

/** A cut member's mesh through Manifold: box, `trimByPlane` per plane cut, minus each notch wedge. */
export function manifoldMesh(
  h: ManifoldHandle,
  m: { length: number; stock: { width: number; depth: number }; cuts: readonly Cut[] },
  count?: Counter,
  leak = false,
): MeshData {
  const { Manifold } = h.wasm;
  const made: Manifold[] = [];
  const keep = (x: Manifold) => {
    made.push(x);
    if (count) count.created++;
    return x;
  };
  const box = keep(Manifold.cube([m.length, m.stock.width, m.stock.depth]));
  let body = box;
  for (const c of m.cuts) {
    if (c.kind !== 'plane') continue;
    // trimByPlane keeps dot(n, p) >= offset; a cut removes dot(n, p) >= k.
    const n = c.plane.n;
    body = keep(body.trimByPlane([-n[0], -n[1], -n[2]], -c.plane.k));
  }
  for (const c of m.cuts) {
    if (c.kind !== 'notch') continue;
    const wedge = keep(keep(box.trimByPlane(c.a.n, c.a.k)).trimByPlane(c.b.n, c.b.k));
    body = keep(body.subtract(wedge));
  }
  const mesh = body.getMesh();
  if (!leak)
    for (const x of made) {
      x.delete();
      if (count) count.deleted++;
    }
  return flatMesh(mesh.vertProperties, mesh.numProp, mesh.triVerts);
}

/** Flat-shaded, unindexed copy of an indexed mesh: three vertices and one normal per triangle. */
export function flatMesh(props: Float32Array, numProp: number, tri: Uint32Array): MeshData {
  const n = tri.length;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const indices = new Uint32Array(n);
  for (let t = 0; t < n; t += 3) {
    const a = tri[t]! * numProp;
    const b = tri[t + 1]! * numProp;
    const c = tri[t + 2]! * numProp;
    const ax = props[a]!,
      ay = props[a + 1]!,
      az = props[a + 2]!;
    const ux = props[b]! - ax,
      uy = props[b + 1]! - ay,
      uz = props[b + 2]! - az;
    const vx = props[c]! - ax,
      vy = props[c + 1]! - ay,
      vz = props[c + 2]! - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let i = 0; i < 3; i++) {
      const s = tri[t + i]! * numProp;
      const o = (t + i) * 3;
      positions[o] = props[s]!;
      positions[o + 1] = props[s + 1]!;
      positions[o + 2] = props[s + 2]!;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
      indices[t + i] = t + i;
    }
  }
  return { positions, normals, indices };
}
