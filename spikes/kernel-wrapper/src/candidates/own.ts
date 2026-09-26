// Candidate: our own thin wrapper (src/own/kernel.ts) over libcascade 3.0.2.

import { loadLibcascade, usedHeapBytes } from '../loaders.ts';
import { OwnKernel, type HistoryEntry } from '../own/kernel.ts';
import {
  BOX,
  EXTRUDE_HEIGHT,
  FILLET_RADIUS,
  HOLE,
  meshParams,
  PROFILE,
  type ScenarioReport,
} from '../scenario.ts';
import { elapsed, type Candidate, type HistorySummary, type RunOptions } from './types.ts';

export function summariseOwnHistory(
  entries: HistoryEntry[],
  inputFaces: number,
  resultFaces: number,
): HistorySummary {
  const faces = entries.filter((e) => e.input.kind === 'face');
  const traced = new Set<number>();
  const generatedFrom = { face: 0, edge: 0, vertex: 0 };
  for (const e of entries) {
    for (const i of [...e.modified, ...e.generated]) traced.add(i);
    if (e.kept) traced.add(e.kept);
    if (e.generated.length) generatedFrom[e.input.kind]++;
  }
  return {
    inputFaces,
    modifiedFaces: faces.filter((e) => e.modified.length > 0).length,
    deletedFaces: faces.filter((e) => e.deleted).length,
    keptFaces: faces.filter((e) => e.kept > 0).length,
    generatedFrom,
    resultFaces,
    tracedResultFaces: traced.size,
  };
}

export async function createOwn(): Promise<Candidate & { kernel: OwnKernel }> {
  const loaded = await loadLibcascade();
  const k = new OwnKernel(loaded.module);

  function run(options: RunOptions) {
    const mark = k.checkpoint();
    try {
      const t0 = performance.now();
      const box = k.box(BOX.dx, BOX.dy, BOX.dz);
      const fillet = k.fillet(box, FILLET_RADIUS, undefined, { history: options.history });
      const filletMs = elapsed(t0);

      const t1 = performance.now();
      const prism = k.extrudePolyline(PROFILE, EXTRUDE_HEIGHT);
      const tool = k.cylinder(HOLE.radius, HOLE.length, HOLE.at, HOLE.axis);
      const cut = k.cut(prism, tool, { history: options.history });
      const cutMs = elapsed(t1);

      const t2 = performance.now();
      const q = meshParams(options.fine);
      const meshA = options.mesh ? k.mesh(fillet.shape, q.linear, q.angular) : null;
      const meshB = options.mesh ? k.mesh(cut.shape, q.linear, q.angular) : null;
      const meshMs = elapsed(t2);

      const t3 = performance.now();
      const report: ScenarioReport = {
        filleted: {
          volume: k.volume(fillet.shape),
          faces: k.count(fillet.shape, 'face'),
          triangles: meshA ? meshA.indices.length / 3 : 0,
          vertices: meshA ? meshA.positions.length / 3 : 0,
        },
        extruded: { volume: k.volume(prism), faces: k.count(prism, 'face') },
        cut: {
          volume: k.volume(cut.shape),
          faces: k.count(cut.shape, 'face'),
          triangles: meshB ? meshB.indices.length / 3 : 0,
          vertices: meshB ? meshB.positions.length / 3 : 0,
        },
      };
      const queryMs = elapsed(t3);

      const history = options.history
        ? {
            fillet: summariseOwnHistory(
              fillet.history,
              k.count(box, 'face'),
              report.filleted.faces,
            ),
            cut: summariseOwnHistory(
              cut.history,
              k.count(prism, 'face') + k.count(tool, 'face'),
              report.cut.faces,
            ),
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
    name: 'own-libcascade',
    build: 'libcascade',
    canMesh: true,
    historyApi: 'full',
    kernel: k,
    run,
    boxLoop(n) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const id = k.box(10, 10, 10);
        sum += k.volume(id);
        k.release(id);
      }
      return sum;
    },
    heapBytes: () => loaded.heap.memory.buffer.byteLength,
    usedHeapBytes: () => usedHeapBytes(loaded.heap),
    liveHandles: () => k.shapeCount,
  };
}
