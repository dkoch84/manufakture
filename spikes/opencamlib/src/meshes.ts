// The two meshes both drop-cutters run on: the M1 bracket, and a filleted block with a filleted
// boss tessellated to about 100k triangles. Built with packages/kernel and welded with
// packages/io's exportMesh, the way the CAM geometry stage will hand meshes to the CAM worker.
// Each mesh is also cached as raw bytes in .cache/ so the worker probe can read it without the
// kernel.

import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, polygon, profile } from '../../../packages/kernel/src/fixtures/parts';
import type { FeatureInput } from '../../../packages/kernel/src/features';
import { holeSize } from '../../../packages/kernel/src/holes';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import type { Deflection, Frame, ShapeId } from '../../../packages/kernel/src/types';
import { exportMesh } from '../../../packages/io/src/export';
import type { Mesh } from './geometry.ts';

export const CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');

/** CAM tolerance for the bracket: 0.01 mm chordal, finer than any finishing scallop. */
export const BRACKET_DEFLECTION: Deflection = { linear: 0.01, angular: 0.1 };
/** Chosen so the filleted part lands near 100k triangles. */
export const FILLETED_DEFLECTION: Deflection = { linear: 0.004, angular: 0.06 };

const M4 = holeSize('M4')!;

/** The M1 bracket (packages/kernel/test/bracket.test.ts, spikes/hlr): an L, 6 mm walls. */
function bracketFeatures(t: number): FeatureInput[] {
  const front: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  return [
    {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        front,
        polygon(
          [
            [0, 0],
            [50, 0],
            [50, t],
            [t, t],
            [t, 40],
            [0, 40],
          ],
          ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
        ),
      ),
      extent: { type: 'symmetric', distance: 30 },
      mode: 'new',
    },
    {
      kind: 'hole',
      id: 'hole#1',
      frame: { origin: [0, 0, t], xDir: [1, 0, 0], normal: [0, 0, 1] },
      points: [
        { id: 'e7', at: [25, 0] },
        { id: 'e8', at: [40, 0] },
      ],
      diameter: M4.clearance.normal,
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: M4.counterbore.diameter, depth: M4.counterbore.depth },
    },
    {
      kind: 'fillet',
      id: 'fillet#1',
      radius: 4,
      edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
    },
  ];
}

function bracketShape(k: Kernel): ShapeId {
  return build(k, bracketFeatures(6)).shape;
}

/**
 * A 120 x 90 x 30 block with every edge filleted (r 8) and a boss (r 22, 15 high) on top, its top
 * edge filleted r 6 and its root r 4. Curved everywhere a 3D finish matters.
 */
function filletedShape(k: Kernel): ShapeId {
  const box = k.box(120, 90, 30);
  const edges = Array.from({ length: k.count(box, 'edge') }, (_, i) => i + 1);
  const rounded = k.fillet(box, edges, 8).shape;
  k.release(box);
  const boss = k.cylinder(22, 15, [60, 45, 30]);
  const fused = k.boolean('fuse', rounded, [boss], { simplify: true }).shape;
  k.release(rounded);
  k.release(boss);
  const circleAt = (shape: ShapeId, z: number) =>
    k
      .topology(shape)
      .edges.filter((e) => e.curve === 'circle' && Math.abs(e.midpoint[2] - z) < 1e-6)
      .map((e) => e.index);
  const top = k.fillet(fused, circleAt(fused, 45), 6).shape;
  k.release(fused);
  const out = k.fillet(top, circleAt(top, 30), 4).shape;
  k.release(top);
  return out;
}

function welded(k: Kernel, name: string, shape: ShapeId, deflection: Deflection): Mesh {
  const data = k.mesh(shape, deflection);
  const { mesh } = exportMesh({ name, mesh: data });
  return { name, positions: mesh.positions, indices: mesh.indices };
}

export const MESH_NAMES = ['bracket', 'filleted'] as const;
export type MeshName = (typeof MESH_NAMES)[number];

/** Build both meshes with the kernel and cache them. */
export async function buildMeshes(): Promise<Record<MeshName, Mesh>> {
  const k = await createNodeKernel();
  const bracket = welded(k, 'bracket', bracketShape(k), BRACKET_DEFLECTION);
  const filleted = welded(k, 'filleted', filletedShape(k), FILLETED_DEFLECTION);
  for (const m of [bracket, filleted]) writeCached(m);
  return { bracket, filleted };
}

function writeCached(m: Mesh): void {
  mkdirSync(CACHE, { recursive: true });
  const header = new Uint32Array([m.positions.length, m.indices.length]);
  const bytes = new Uint8Array(8 + m.positions.byteLength + m.indices.byteLength);
  bytes.set(new Uint8Array(header.buffer), 0);
  bytes.set(new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength), 8);
  bytes.set(
    new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength),
    8 + m.positions.byteLength,
  );
  writeFileSync(join(CACHE, `${m.name}.mesh`), bytes);
}

/** A mesh from the cache, or null when buildMeshes has not run yet. */
export function readCached(name: MeshName): Mesh | null {
  const file = join(CACHE, `${name}.mesh`);
  if (!existsSync(file)) return null;
  const b = readFileSync(file);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const [np, ni] = new Uint32Array(buf, 0, 2);
  return {
    name,
    positions: new Float32Array(buf, 8, np),
    indices: new Uint32Array(buf, 8 + np! * 4, ni),
  };
}
