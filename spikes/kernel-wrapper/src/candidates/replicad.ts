// Candidate: replicad 1.1.0, on its own OCCT build (replicad-opencascadejs
// 1.1.0) and, for modelling only, on libcascade 3.0.2.
//
// replicad keeps one global OCCT module (setOC), so each run sets it first.
// It has no history API: its booleans and fillets create the OCCT builder,
// take Shape() and hand the builder to a FinalizationRegistry. With
// `history: true` this candidate therefore uses replicad's escape hatch
// (getOC() plus `.wrapped`) to run the two operations on raw OCCT builders and
// wraps the results back into replicad shapes with cast().

import * as replicad from 'replicad';
import type { OpenCascadeInstance as ReplicadOc } from 'replicad-opencascadejs';
import { loadLibcascade, loadReplicadOc, usedHeapBytes, type Heap } from '../loaders.ts';
import { collectHistory, explorerIndexer, Scope, type Oc } from '../own/kernel.ts';
import {
  BOX,
  EXTRUDE_HEIGHT,
  FILLET_RADIUS,
  HOLE,
  meshParams,
  PROFILE,
  type ScenarioReport,
} from '../scenario.ts';
import { summariseOwnHistory } from './own.ts';
import { elapsed, type Candidate, type HistorySummary, type RunOptions } from './types.ts';

type Shape3D = replicad.Shape3D;

/**
 * replicad's trimmed build binds NCollection_IndexedMap but cannot construct
 * it (its NCollection_BaseMap base is not bound), so sub-shapes are numbered
 * with TopExp_Explorer there. libcascade has the full binding.
 */
function indexer(oc: Oc, s: Scope) {
  return explorerIndexer(oc, s);
}

function faceCount(shape: Shape3D): number {
  const faces = shape.faces;
  for (const f of faces) f.delete();
  return faces.length;
}

function meshCounts(shape: Shape3D, fine: boolean | undefined) {
  const q = meshParams(fine);
  const m = shape.mesh({ tolerance: q.linear, angularTolerance: q.angular });
  // Copy into typed arrays, as a renderer would need.
  const positions = new Float32Array(m.vertices);
  const normals = new Float32Array(m.normals);
  const indices = new Uint32Array(m.triangles);
  if (normals.length !== positions.length) throw new Error('normals do not match positions');
  return { triangles: indices.length / 3, vertices: positions.length / 3 };
}

/** Fillet every edge through raw OCCT, keeping the builder for its history. */
function filletWithHistory(box: Shape3D): { shape: Shape3D; history: HistorySummary } {
  // replicad's build binds the same OCCT classes under the same names.
  const oc = replicad.getOC() as unknown as Oc;
  const s = new Scope(oc);
  try {
    const input = box.wrapped as never;
    const maker = s.own(new oc.BRepFilletAPI_MakeFillet(input));
    const edges = box.edges;
    for (const e of edges) maker.Add(FILLET_RADIUS, e.wrapped as never);
    for (const e of edges) e.delete();
    maker.Build();
    if (!maker.IsDone()) throw new Error('fillet failed');
    const result = maker.Shape();
    const kinds = ['face', 'edge', 'vertex'] as const;
    const entries = collectHistory(oc, s, maker, [input], result, [...kinds], indexer(oc, s));
    const shape = replicad.cast(result as never) as Shape3D;
    return { shape, history: summariseOwnHistory(entries, faceCount(box), faceCount(shape)) };
  } finally {
    s.dispose();
  }
}

function cutWithHistory(base: Shape3D, tool: Shape3D) {
  const oc = replicad.getOC() as unknown as Oc;
  const s = new Scope(oc);
  try {
    const a = base.wrapped as never;
    const b = tool.wrapped as never;
    const builder = s.own(new oc.BRepAlgoAPI_Cut(a, b));
    if (!builder.IsDone() || builder.HasErrors()) throw new Error('boolean failed');
    const result = builder.Shape();
    const entries = collectHistory(oc, s, builder, [a, b], result, ['face'], indexer(oc, s));
    const shape = replicad.cast(result as never) as Shape3D;
    const inputFaces = faceCount(base) + faceCount(tool);
    return { shape, history: summariseOwnHistory(entries, inputFaces, faceCount(shape)) };
  } finally {
    s.dispose();
  }
}

function makeCandidate(
  name: 'replicad' | 'replicad-libcascade',
  oc: ReplicadOc,
  heap: Heap,
  canMesh: boolean,
): Candidate {
  function run(options: RunOptions) {
    replicad.setOC(oc);
    const owned: Array<{ delete(): void }> = [];
    const own = <T extends { delete(): void }>(x: T): T => {
      owned.push(x);
      return x;
    };
    try {
      const t0 = performance.now();
      // makeBox is BRepPrimAPI_MakeBox, as in the other candidates. (makeBaseBox,
      // the one in replicad's examples, sketches a rectangle and extrudes it.)
      const box = own(replicad.makeBox([0, 0, 0], [BOX.dx, BOX.dy, BOX.dz]));
      let filletHistory: HistorySummary | null = null;
      let filleted: Shape3D;
      if (options.history) {
        const r = filletWithHistory(box);
        filleted = own(r.shape);
        filletHistory = r.history;
      } else {
        filleted = own(box.fillet(FILLET_RADIUS));
      }
      const filletMs = elapsed(t0);

      const t1 = performance.now();
      let pen = replicad.draw(PROFILE[0] as [number, number]);
      for (const p of PROFILE.slice(1)) pen = pen.lineTo(p as [number, number]);
      const prism = own(pen.close().sketchOnPlane('XY').extrude(EXTRUDE_HEIGHT) as Shape3D);
      const tool = own(
        replicad.makeCylinder(HOLE.radius, HOLE.length, [...HOLE.at], [...HOLE.axis]),
      );
      let cut: Shape3D;
      let cutHistory: HistorySummary | null = null;
      if (options.history) {
        const r = cutWithHistory(prism, tool);
        cut = own(r.shape);
        cutHistory = r.history;
      } else {
        cut = own(prism.cut(tool));
      }
      const cutMs = elapsed(t1);

      const t2 = performance.now();
      const meshA = options.mesh && canMesh ? meshCounts(filleted, options.fine) : null;
      const meshB = options.mesh && canMesh ? meshCounts(cut, options.fine) : null;
      const meshMs = elapsed(t2);

      const t3 = performance.now();
      const report: ScenarioReport = {
        filleted: {
          volume: replicad.measureVolume(filleted),
          faces: faceCount(filleted),
          triangles: meshA?.triangles ?? 0,
          vertices: meshA?.vertices ?? 0,
        },
        extruded: { volume: replicad.measureVolume(prism), faces: faceCount(prism) },
        cut: {
          volume: replicad.measureVolume(cut),
          faces: faceCount(cut),
          triangles: meshB?.triangles ?? 0,
          vertices: meshB?.vertices ?? 0,
        },
      };
      const queryMs = elapsed(t3);
      const history =
        filletHistory && cutHistory ? { fillet: filletHistory, cut: cutHistory } : null;
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
    name,
    build: name === 'replicad' ? 'replicad-opencascadejs' : 'libcascade',
    canMesh,
    historyApi: 'none',
    run,
    boxLoop(n) {
      replicad.setOC(oc);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const box = replicad.makeBox([0, 0, 0], [10, 10, 10]);
        sum += replicad.measureVolume(box);
        box.delete();
      }
      return sum;
    },
    heapBytes: () => heap.memory.buffer.byteLength,
    usedHeapBytes: () => usedHeapBytes(heap),
    liveHandles: () => null,
  };
}

export async function createReplicad(): Promise<Candidate> {
  const loaded = await loadReplicadOc();
  return makeCandidate('replicad', loaded.module, loaded.heap, true);
}

/**
 * replicad on libcascade 3.0.2. Modelling works; meshing does not, because
 * replicad's mesh() calls C++ helpers (ReplicadMeshExtractor and friends) that
 * only replicad's own build contains.
 */
export async function createReplicadOnLibcascade(): Promise<Candidate & { oc: ReplicadOc }> {
  const loaded = await loadLibcascade();
  const oc = loaded.module as unknown as ReplicadOc;
  return { ...makeCandidate('replicad-libcascade', oc, loaded.heap, false), oc };
}
