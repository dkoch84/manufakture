// Candidate: occt-wasm 5.3.5 used directly. It is brepjs's default kernel: a
// C++ facade over OCCT 8.0.1 with shapes in a C++ arena, addressed from JS by
// integer ids. Measured on its own so that brepjs's overhead can be separated
// from the kernel build's.

import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { loadOcctWasm, usedHeapBytes } from '../loaders.ts';
import {
  BOX,
  EXTRUDE_HEIGHT,
  FILLET_RADIUS,
  HOLE,
  meshParams,
  PROFILE,
  type ScenarioReport,
} from '../scenario.ts';
import {
  elapsed,
  parseFlatHistory,
  summariseHashHistory,
  type Candidate,
  type RunOptions,
} from './types.ts';

/** Same upper bound brepjs uses for face hashes. */
export const HASH_UPPER_BOUND = 2147483647;

function profilePrism(k: OcctKernel): ShapeHandle {
  const edges = PROFILE.map(([x, y], i) => {
    const [nx, ny] = PROFILE[(i + 1) % PROFILE.length]!;
    return k.makeLineEdge({ x, y, z: 0 }, { x: nx, y: ny, z: 0 });
  });
  const face = k.makeFace(k.makeWire(edges));
  return k.extrude(face, 0, 0, EXTRUDE_HEIGHT);
}

/** A Z-axis cylinder turned onto +Y and moved to the drill position. */
function drill(k: OcctKernel): ShapeHandle {
  const cyl = k.makeCylinder(HOLE.radius, HOLE.length);
  // Rotating by -90 degrees about X maps +Z onto +Y.
  const turned = k.rotate(
    cyl,
    { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    -Math.PI / 2,
  );
  return k.translate(turned, HOLE.at[0], HOLE.at[1], HOLE.at[2]);
}

function meshCounts(k: OcctKernel, shape: ShapeHandle, fine: boolean | undefined) {
  const q = meshParams(fine);
  const m = k.tessellate(shape, { linearDeflection: q.linear, angularDeflection: q.angular });
  return { triangles: m.triangleCount, vertices: m.vertexCount };
}

export async function createOcctWasm(): Promise<Candidate & { kernel: OcctKernel }> {
  const loaded = await loadOcctWasm();
  const k = loaded.module;
  const hashes = (s: ShapeHandle) => k.subShapeHashes(s, 'face', HASH_UPPER_BOUND);

  function run(options: RunOptions) {
    const mark = k.checkpoint();
    try {
      const t0 = performance.now();
      const box = k.makeBox(BOX.dx, BOX.dy, BOX.dz);
      const edges = k.getSubShapes(box, 'edge');
      let filleted: ShapeHandle;
      let filletEvo = null;
      if (options.history) {
        filletEvo = k.filletWithHistory(box, edges, FILLET_RADIUS, hashes(box), HASH_UPPER_BOUND);
        filleted = filletEvo.result;
      } else {
        filleted = k.fillet(box, edges, FILLET_RADIUS);
      }
      const filletMs = elapsed(t0);

      const t1 = performance.now();
      const prism = profilePrism(k);
      const tool = drill(k);
      let cut: ShapeHandle;
      let cutEvo = null;
      const cutInputs = options.history ? [...hashes(prism), ...hashes(tool)] : [];
      if (options.history) {
        cutEvo = k.cutWithHistory(prism, tool, cutInputs, HASH_UPPER_BOUND);
        cut = cutEvo.result;
      } else {
        cut = k.cut(prism, tool);
      }
      const cutMs = elapsed(t1);

      const t2 = performance.now();
      const meshA = options.mesh ? meshCounts(k, filleted, options.fine) : null;
      const meshB = options.mesh ? meshCounts(k, cut, options.fine) : null;
      const meshMs = elapsed(t2);

      const t3 = performance.now();
      const report: ScenarioReport = {
        filleted: {
          volume: k.getVolume(filleted),
          faces: k.subShapeCount(filleted, 'face'),
          triangles: meshA?.triangles ?? 0,
          vertices: meshA?.vertices ?? 0,
        },
        extruded: { volume: k.getVolume(prism), faces: k.subShapeCount(prism, 'face') },
        cut: {
          volume: k.getVolume(cut),
          faces: k.subShapeCount(cut, 'face'),
          triangles: meshB?.triangles ?? 0,
          vertices: meshB?.vertices ?? 0,
        },
      };
      const queryMs = elapsed(t3);

      const summarise = (
        evo: { modified: number[]; generated: number[]; deleted: number[] },
        inputs: number[],
        result: ShapeHandle,
      ) =>
        summariseHashHistory(
          inputs,
          hashes(result),
          parseFlatHistory(evo.modified),
          parseFlatHistory(evo.generated),
          new Set(evo.deleted),
        );
      const history =
        filletEvo && cutEvo
          ? {
              fillet: summarise(filletEvo, hashes(box), filleted),
              cut: summarise(cutEvo, cutInputs, cut),
            }
          : null;
      return {
        report,
        timings: { filletMs, cutMs, meshMs, queryMs, totalMs: elapsed(t0) },
        history,
      };
    } finally {
      k.releaseSince(mark);
    }
  }

  return {
    name: 'occt-wasm',
    build: 'occt-wasm',
    canMesh: true,
    historyApi: 'faces-by-hash',
    kernel: k,
    run,
    boxLoop(n) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const id = k.makeBox(10, 10, 10);
        sum += k.getVolume(id);
        k.release(id);
      }
      return sum;
    },
    heapBytes: () => loaded.heap.memory.buffer.byteLength,
    usedHeapBytes: () => usedHeapBytes(loaded.heap),
    liveHandles: () => k.shapeCount,
  };
}
