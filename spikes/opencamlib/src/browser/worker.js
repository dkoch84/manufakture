/* global self, fetch, performance */
// Module worker for the browser probe (worker.test.ts): loads ocl.mjs, which fetches ocl.wasm as
// a separate asset next to it, and runs a PathDropCutter on the bracket mesh. Plain JavaScript,
// served as is.

import ocl from '/out/ocl.mjs';

self.onmessage = async ({ data: { lines, sampling, floor } }) => {
  const t0 = performance.now();
  const m = await ocl();
  const loadMs = performance.now() - t0;
  const buf = await (await fetch('/cache/bracket.mesh')).arrayBuffer();
  const [np, ni] = new Uint32Array(buf, 0, 2);
  const p = new Float32Array(buf, 8, np);
  const ix = new Uint32Array(buf, 8 + np * 4, ni);
  const surf = new m.STLSurf();
  for (let i = 0; i < ix.length; i += 3) {
    const pts = [0, 1, 2].map(
      (c) => new m.Point(p[ix[i + c] * 3], p[ix[i + c] * 3 + 1], p[ix[i + c] * 3 + 2]),
    );
    const tri = new m.Triangle(pts[0], pts[1], pts[2]);
    surf.addTriangle(tri);
    tri.delete();
    for (const q of pts) q.delete();
  }
  const cutter = new m.BallCutter(6.35, 100);
  const op = new m.PathDropCutter();
  op.setSTL(surf);
  op.setCutter(cutter);
  op.setSampling(sampling);
  op.setZ(floor);
  const path = new m.Path();
  for (const [ax, ay, bx, by] of lines) {
    const a = new m.Point(ax, ay, 0);
    const b = new m.Point(bx, by, 0);
    const l = new m.Line(a, b);
    path.appendLine(l);
    l.delete();
    a.delete();
    b.delete();
  }
  op.setPath(path);
  const t1 = performance.now();
  op.run();
  const runMs = performance.now() - t1;
  const v = op.getPoints();
  const out = new Float64Array(v.size() * 3);
  for (let i = 0; i < v.size(); i++) {
    const q = v.get(i);
    out[i * 3] = q.x;
    out[i * 3 + 1] = q.y;
    out[i * 3 + 2] = q.z;
    q.delete();
  }
  v.delete();
  op.delete();
  path.delete();
  cutter.delete();
  surf.delete();
  self.postMessage({ loadMs, runMs, points: out }, [out.buffer]);
};
