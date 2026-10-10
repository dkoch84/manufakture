// The alternative mesher: fTetWild (float-tetwild-wasm, MPL-2.0) on the kernel's own surface
// tessellation, for the thick-walled cylinder. fTetWild gives linear tets inside an envelope around
// the input surface, so the TET10 mid-side nodes are put on straight edges, and curved boundaries
// stay faceted. Compared on the same Lame metrics as gmsh's mesh.

import { expect, test } from 'vitest';
import { loadFloatTetwild } from 'float-tetwild-wasm';
import { createNodeKernel } from '../../../packages/kernel/src/node.ts';
import { thickCylinder } from './cases.ts';
import { boundaryFaces, type TetMesh } from './mesh.ts';
import { solids, writeResult } from './node-env.ts';
import { applySurfaceLoads, assemble, fixNodes, pattern, pcg, nodalStress } from './solver.ts';
import { amg, spmv } from './amg.ts';
import { rcm } from './order.ts';
import { EDGES } from './tet10.ts';

/** Linear tets to TET10 with mid-side nodes at edge midpoints. */
function toTet10(vertices: Float64Array, tets: Uint32Array): TetMesh {
  const nv = vertices.length / 3;
  const edgeNode = new Map<number, number>();
  const extra: number[] = [];
  const ne = tets.length / 4;
  const out = new Uint32Array(10 * ne);
  for (let e = 0; e < ne; e++) {
    for (let a = 0; a < 4; a++) out[10 * e + a] = tets[4 * e + a]!;
    EDGES.forEach(([i, j], q) => {
      const a = tets[4 * e + i]!,
        b = tets[4 * e + j]!;
      const key = Math.min(a, b) * nv + Math.max(a, b);
      let k = edgeNode.get(key);
      if (k === undefined) {
        k = nv + extra.length / 3;
        edgeNode.set(key, k);
        for (let c = 0; c < 3; c++) extra.push(0.5 * (vertices[3 * a + c]! + vertices[3 * b + c]!));
      }
      out[10 * e + 4 + q] = k;
    });
  }
  const nodes = new Float64Array(vertices.length + extra.length);
  nodes.set(vertices);
  nodes.set(extra, vertices.length);
  return { nodes, tets: out };
}

test('fTetWild on the thick-walled cylinder', async () => {
  const steps = await solids();
  const k = await createNodeKernel();
  const shape = k.importStep(steps.lame);
  const surf = k.mesh(shape, { linear: 0.01, angular: 0.1 });
  // Weld the per-face vertices of the display mesh into one watertight surface.
  const map = new Map<string, number>();
  const verts: number[] = [];
  const remap = new Uint32Array(surf.positions.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const p = [surf.positions[3 * i]!, surf.positions[3 * i + 1]!, surf.positions[3 * i + 2]!];
    const key = p.map((v) => v.toFixed(4)).join(',');
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(...p);
    }
    remap[i] = id;
  }
  const faces = Int32Array.from(surf.indices, (i) => remap[i]!);

  const ft = await loadFloatTetwild({ moduleArgs: { print: () => {}, printErr: () => {} } });
  const runs: unknown[] = [];
  for (const rel of [0.08, 0.04, 0.025]) {
    let t = performance.now();
    const r = ft.tetrahedralizeTyped(new Float64Array(verts), faces, {
      idealEdgeLengthRel: rel,
      epsRel: 1e-3,
    });
    const meshMs = performance.now() - t;
    expect(r.status).toBe(0);
    const mesh = rcm(toTet10(r.vertices, r.tets));
    // fTetWild moves the boundary within its envelope: select boundary nodes and faces with a tolerance.
    const tol = 0.05;
    const n = mesh.nodes.length / 3;
    const fixed = new Uint8Array(3 * n);
    fixNodes(mesh, fixed, (x) => Math.abs(x) < tol, [0]);
    fixNodes(mesh, fixed, (_x, y) => Math.abs(y) < tol, [1]);
    fixNodes(mesh, fixed, (_x, _y, z) => Math.abs(z) < tol || Math.abs(z - 10) < tol, [2]);
    const f = new Float64Array(3 * n);
    const total = applySurfaceLoads(
      mesh,
      boundaryFaces(mesh),
      [{ where: (x, y) => Math.abs(Math.hypot(x, y) - 10) < tol, pressure: 100 }],
      f,
    );
    for (let i = 0; i < f.length; i++) if (fixed[i]) f[i] = 0;
    t = performance.now();
    const a = pattern(mesh);
    assemble(mesh, thickCylinder.material, fixed, a);
    const m = amg(a, mesh.nodes, fixed);
    const cg = pcg((x, y) => spmv(m.fine, x, y), f, m);
    const solveMs = performance.now() - t;
    const stress = nodalStress(mesh, thickCylinder.material, cg.x);
    // Evaluate with the boundary tolerance: snap the radius test used by the case.
    const snapped = { nodes: Float64Array.from(mesh.nodes), tets: mesh.tets };
    for (let i = 0; i < n; i++) {
      const x = snapped.nodes[3 * i]!,
        y = snapped.nodes[3 * i + 1]!;
      const rr = Math.hypot(x, y);
      for (const target of [10, 20])
        if (Math.abs(rr - target) < tol) {
          snapped.nodes[3 * i] = (x * target) / rr;
          snapped.nodes[3 * i + 1] = (y * target) / rr;
        }
    }
    const metrics = thickCylinder.evaluate(snapped, cg.x, stress);
    runs.push({
      idealEdgeLengthRel: rel,
      dof: 3 * n,
      elements: mesh.tets.length / 10,
      meshMs,
      solveMs,
      iterations: cg.iterations,
      totalLoad: total,
      metrics,
    });
    console.log(
      `fTetWild rel ${rel}: dof ${3 * n} mesh ${meshMs.toFixed(0)} ms solve ${solveMs.toFixed(0)} ms load ${total.map((v) => v.toFixed(0))}`,
    );
    for (const mm of metrics)
      console.log(
        `   ${mm.name}: ${mm.fea.toPrecision(5)} vs ${mm.analytical.toPrecision(5)} (${(100 * mm.error).toFixed(2)}%)`,
      );
  }
  writeResult('tetwild', { surfaceTriangles: faces.length / 3, runs });
});
