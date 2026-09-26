// Candidate: brepjs 20.0.0 on its default kernel, occt-wasm 5.3.5.
//
// brepjs keeps a global kernel registry; this candidate registers its own
// occt-wasm instance (loaded through the spike's hook so the heap can be
// probed). Shapes are handles with delete() / Symbol.dispose, backed by a
// FinalizationRegistry safety net. History comes from the *WithEvolution
// variants, keyed by face hash. Those variants return EMPTY evolution maps
// unless an input already carries metadata (face origins, tags or colours):
// collectInputFaceHashes() skips hashing otherwise. Setting a shape origin is
// the cheapest way to opt in.

import * as b from 'brepjs';
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
import { summariseHashHistory, elapsed, type Candidate, type RunOptions } from './types.ts';

type Disposable3D = b.ValidSolid | b.Shape3D;

function faceHashes(shape: Disposable3D): number[] {
  return b.getFaces(shape).map((f) => b.getHashCode(f));
}

function meshCounts(shape: Disposable3D, fine: boolean | undefined) {
  const q = meshParams(fine);
  const m = b.mesh(shape, {
    tolerance: q.linear,
    angularTolerance: q.angular,
    cache: false,
  });
  return { triangles: m.triangles.length / 3, vertices: m.vertices.length / 3 };
}

export async function createBrepjs(): Promise<Candidate> {
  const loaded = await loadOcctWasm();
  const adapter = b.OcctWasmAdapter.fromKernel(loaded.module);
  b.registerKernel('occt-wasm', adapter);

  function run(options: RunOptions) {
    const owned: Array<{ delete(): void }> = [];
    const own = <T extends { delete(): void }>(x: T): T => {
      owned.push(x);
      return x;
    };
    try {
      const t0 = performance.now();
      const box = own(b.box(BOX.dx, BOX.dy, BOX.dz));
      let filleted: b.ValidSolid;
      let filletEvo: b.ShapeEvolution | null = null;
      if (options.history) {
        // Evolution is only computed when an input carries metadata (see header).
        b.setShapeOrigin(box, 1);
        const r = b.unwrap(b.filletWithEvolution(box, undefined, FILLET_RADIUS));
        filleted = own(r.shape);
        filletEvo = r.evolution;
      } else {
        filleted = own(b.unwrap(b.fillet(box, b.getEdges(box), FILLET_RADIUS)));
      }
      const filletMs = elapsed(t0);

      const t1 = performance.now();
      const face = own(b.unwrap(b.polygon(PROFILE.map(([x, y]) => [x, y, 0] as b.Vec3))));
      const prism = own(b.unwrap(b.validSolid(b.unwrap(b.extrude(face, EXTRUDE_HEIGHT)))));
      const tool = own(b.cylinder(HOLE.radius, HOLE.length, { at: HOLE.at, axis: HOLE.axis }));
      let cut: b.ValidSolid;
      let cutEvo: b.ShapeEvolution | null = null;
      if (options.history) {
        b.setShapeOrigin(prism, 2);
        b.setShapeOrigin(tool, 3);
        const r = b.unwrap(b.cutWithEvolution(prism, tool));
        cut = own(r.shape);
        cutEvo = r.evolution;
      } else {
        cut = own(b.unwrap(b.cut(prism, tool)));
      }
      const cutMs = elapsed(t1);

      const t2 = performance.now();
      const meshA = options.mesh ? meshCounts(filleted, options.fine) : null;
      const meshB = options.mesh ? meshCounts(cut, options.fine) : null;
      const meshMs = elapsed(t2);

      const t3 = performance.now();
      const report: ScenarioReport = {
        filleted: {
          volume: b.unwrap(b.measureVolume(filleted)),
          faces: b.getFaces(filleted).length,
          triangles: meshA?.triangles ?? 0,
          vertices: meshA?.vertices ?? 0,
        },
        extruded: { volume: b.unwrap(b.measureVolume(prism)), faces: b.getFaces(prism).length },
        cut: {
          volume: b.unwrap(b.measureVolume(cut)),
          faces: b.getFaces(cut).length,
          triangles: meshB?.triangles ?? 0,
          vertices: meshB?.vertices ?? 0,
        },
      };
      const queryMs = elapsed(t3);

      const history =
        filletEvo && cutEvo
          ? {
              fillet: summariseHashHistory(
                faceHashes(box),
                faceHashes(filleted),
                filletEvo.modified,
                filletEvo.generated,
                filletEvo.deleted,
              ),
              cut: summariseHashHistory(
                [...faceHashes(prism), ...faceHashes(tool)],
                faceHashes(cut),
                cutEvo.modified,
                cutEvo.generated,
                cutEvo.deleted,
              ),
            }
          : null;
      return {
        report,
        timings: { filletMs, cutMs, meshMs, queryMs, totalMs: elapsed(t0) },
        history,
      };
    } finally {
      for (const x of owned.reverse()) x.delete();
    }
  }

  return {
    name: 'brepjs',
    build: 'occt-wasm',
    canMesh: true,
    historyApi: 'faces-by-hash',
    run,
    boxLoop(n) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const box = b.box(10, 10, 10);
        sum += b.unwrap(b.measureVolume(box));
        box.delete();
      }
      return sum;
    },
    heapBytes: () => loaded.heap.memory.buffer.byteLength,
    usedHeapBytes: () => usedHeapBytes(loaded.heap),
    liveHandles: () => b.getDisposalStats().liveHandles,
  };
}
