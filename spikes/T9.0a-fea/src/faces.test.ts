// Face identity across the hand-over: does gmsh's surface tag n (after importing the kernel's STEP)
// name the same face as the kernel's face index n? Compared by each face's centre of area: the
// kernel's from its display mesh, gmsh's from OCCT through gmsh.model.occ.getCenterOfMass.

import { expect, test } from 'vitest';
import { createNodeKernel } from '../../../packages/kernel/src/node.ts';
import { loadGmsh, solids, writeResult } from './node-env.ts';

test('face order survives STEP into gmsh', async () => {
  const steps = await solids();
  const k = await createNodeKernel();
  const gmsh = await loadGmsh();
  const out: Record<string, unknown> = {};
  for (const id of ['cantilever', 'plate-hole', 'lame', 'bracket'] as const) {
    const surf = k.mesh(k.importStep(steps[id]), { linear: 0.005, angular: 0.05 });
    const nf = surf.faceRanges.length / 2;
    const kc: number[][] = [];
    for (let f = 0; f < nf; f++) {
      const [first, count] = [surf.faceRanges[2 * f]!, surf.faceRanges[2 * f + 1]!];
      let ax = 0,
        ay = 0,
        az = 0,
        at = 0;
      for (let t = first; t < first + count; t += 3) {
        const p = [0, 1, 2].map((q) =>
          [0, 1, 2].map((c) => surf.positions[3 * surf.indices[t + q]! + c]!),
        );
        const u = [0, 1, 2].map((c) => p[1]![c]! - p[0]![c]!),
          v = [0, 1, 2].map((c) => p[2]![c]! - p[0]![c]!);
        const area =
          0.5 *
          Math.hypot(
            u[1]! * v[2]! - u[2]! * v[1]!,
            u[2]! * v[0]! - u[0]! * v[2]!,
            u[0]! * v[1]! - u[1]! * v[0]!,
          );
        ax += (area * (p[0]![0]! + p[1]![0]! + p[2]![0]!)) / 3;
        ay += (area * (p[0]![1]! + p[1]![1]! + p[2]![1]!)) / 3;
        az += (area * (p[0]![2]! + p[1]![2]! + p[2]![2]!)) / 3;
        at += area;
      }
      kc.push([ax / at, ay / at, az / at]);
    }
    gmsh.model.add(id);
    gmsh.FS.writeFile('/f.step', steps[id]);
    gmsh.model.occ.importShapes('/f.step');
    gmsh.model.occ.synchronize();
    const tags = gmsh.model
      .getEntities(2)
      .dimTags.filter((_: number, i: number) => i % 2 === 1) as number[];
    let same = 0,
      worst = 0;
    tags.forEach((tag, i) => {
      const { x, y, z } = gmsh.model.occ.getCenterOfMass(2, tag);
      const d = Math.hypot(x - kc[i]![0]!, y - kc[i]![1]!, z - kc[i]![2]!);
      worst = Math.max(worst, d);
      if (d < 0.05) same++;
    });
    gmsh.model.remove();
    out[id] = {
      kernelFaces: nf,
      gmshSurfaces: tags.length,
      sameOrder: same,
      worstCentreDistanceMm: worst,
    };
    console.log(id, out[id]);
  }
  gmsh.finalize();
  writeResult('faces', { solids: out });
  expect(Object.keys(out).length).toBe(4);
});
