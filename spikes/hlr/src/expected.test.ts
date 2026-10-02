// HLR against views drawn by hand: the box with a hole, the cylinder and the M1 bracket, front,
// top, right and isometric (the bracket without isometric). The expected edges and their
// visibility are worked out by hand in the comments below; the comparison is in compare.ts.
// Also checks that the 2D coordinates HLR returns agree with `views.ts`'s projection, and that
// each edge's analytic record (line, arc, elliptical arc) matches its sampled points.
// Writes results/expected.json.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import { arc3, compareView, distToPolys, seg, type Comparison, type ExpectedView } from './compare';
import { bracket, boxWithHole, cylinder, M4 } from './fixtures';
import { projectExact, projectPoly, shapeOf, type Curve2, type ProjectedEdge } from './hlr';
import { writeResult } from './results';
import { frameOf, project, VIEWS, type Vec2, type Vec3 } from './views';

let k: Kernel;
beforeAll(async () => {
  k = await createNodeKernel();
});

const results: Record<string, Record<string, Comparison & { algorithm: string }>> = {};

/** The 12 edges of an axis-aligned box. */
function boxEdges(min: Vec3, max: Vec3) {
  const c = (i: number): Vec3 => [
    i & 1 ? max[0] : min[0],
    i & 2 ? max[1] : min[1],
    i & 4 ? max[2] : min[2],
  ];
  const out: { a: Vec3; b: Vec3; corners: [number, number] }[] = [];
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4])
      if (!(i & bit)) out.push({ a: c(i), b: c(i | bit), corners: [i, i | bit] });
  return out;
}

// Box 100 x 50 x 20 with a 10 mm hole through Z at (50, 25).
//
// Front (looking +Y; paper x = X, y = Z): the 100 x 20 outline. Hidden: the hole's two silhouettes
// at X = 45 and 55. Its circles at Z = 0 and 20 project onto the outline (hidden under visible).
// Top: the outline and the hole's circle; the bottom circle is under it. Right (looking -X; paper
// x = Y): the 50 x 20 outline, hidden silhouettes at Y = 20 and 30. Isometric (viewer at
// (1, -1, 1)): the nine edges of the faces +X, -Y, +Z and the top circle are visible; the three
// edges at the far corner (0, 50, 0) are hidden; so are the bottom circle and both silhouettes of
// the hole wall (they leave the top ellipse outward, behind the top face), and 20 mm of depth
// hides the bottom circle entirely.
const box: Record<string, ExpectedView> = (() => {
  const B = boxEdges([0, 0, 0], [100, 50, 20]);
  const sil = (x: number, y: number) => seg([x, y, 0], [x, y, 20]);
  const far = B.filter((e) => e.corners.includes(2));
  const near = B.filter((e) => !e.corners.includes(2));
  // Iso silhouettes of the hole: generators where the view direction is tangent to the wall, at
  // the angle whose radial direction is perpendicular to the horizontal view direction (1, -1).
  const r = 5;
  const g = (deg: number): Vec3 => [
    50 + r * Math.cos((deg * Math.PI) / 180),
    25 + r * Math.sin((deg * Math.PI) / 180),
    0,
  ];
  const isoSil = [45, 225].map((d) => {
    const p = g(d);
    return seg(p, [p[0], p[1], 20]);
  });
  return {
    front: {
      visible: [
        seg([0, 0, 0], [100, 0, 0]),
        seg([100, 0, 0], [100, 0, 20]),
        seg([100, 0, 20], [0, 0, 20]),
        seg([0, 0, 20], [0, 0, 0]),
      ],
      hidden: [sil(45, 25), sil(55, 25)],
    },
    top: {
      visible: [
        seg([0, 0, 20], [100, 0, 20]),
        seg([100, 0, 20], [100, 50, 20]),
        seg([100, 50, 20], [0, 50, 20]),
        seg([0, 50, 20], [0, 0, 20]),
        arc3([50, 25, 20], 'z', 5),
      ],
      hidden: [],
    },
    right: {
      visible: [
        seg([100, 0, 0], [100, 50, 0]),
        seg([100, 50, 0], [100, 50, 20]),
        seg([100, 50, 20], [100, 0, 20]),
        seg([100, 0, 20], [100, 0, 0]),
      ],
      hidden: [sil(50, 20), sil(50, 30)],
    },
    iso: {
      visible: [...near.map((e) => seg(e.a, e.b)), arc3([50, 25, 20], 'z', 5)],
      hidden: [...far.map((e) => seg(e.a, e.b)), arc3([50, 25, 0], 'z', 5), ...isoSil],
    },
  };
})();

// Cylinder r 20, h 50 about Z. Front and right: a 40 x 50 rectangle whose sides are silhouettes;
// the circles project onto its top and bottom (their back halves hidden under the front halves).
// Top: the circle. Isometric: the top circle, the front half of the bottom circle (angles -135 to
// 45 degrees, facing the viewer's horizontal direction (1, -1)) and the two silhouettes at 45 and
// 225 degrees are visible; the back half of the bottom circle is hidden.
const cyl: Record<string, ExpectedView> = (() => {
  const rect = (u: 'x' | 'y'): Vec3[][] => {
    const p = (s: number, z: number): Vec3 => (u === 'x' ? [s, 0, z] : [0, s, z]);
    return [
      seg(p(-20, 0), p(20, 0)),
      seg(p(20, 0), p(20, 50)),
      seg(p(20, 50), p(-20, 50)),
      seg(p(-20, 50), p(-20, 0)),
    ];
  };
  const at = (deg: number, z: number): Vec3 => [
    20 * Math.cos((deg * Math.PI) / 180),
    20 * Math.sin((deg * Math.PI) / 180),
    z,
  ];
  return {
    front: { visible: rect('x'), hidden: [] },
    top: { visible: [arc3([0, 0, 50], 'z', 20)], hidden: [] },
    right: { visible: rect('y'), hidden: [] },
    iso: {
      visible: [
        arc3([0, 0, 50], 'z', 20),
        arc3([0, 0, 0], 'z', 20, -135, 45),
        seg(at(45, 0), at(45, 50)),
        seg(at(225, 0), at(225, 50)),
      ],
      hidden: [arc3([0, 0, 0], 'z', 20, 45, 225)],
    },
  };
})();

// The M1 bracket, t = 6: an L in XZ (foot 50 x 6, upright 6 x 40), 30 wide in Y (-15 to 15), a
// fillet R 4 in the inside corner (centre X 10, Z 10), two M4 counterbored holes at X = 25 and 40
// (4.5 through, counterbore 8 x 4.4 from the top, so the floor is at Z = 1.6).
//
// Front: the L with the fillet arc, visible. Hidden per hole: the through hole's silhouettes
// (X = c +- 2.25, Z 0 to 1.6), the counterbore's (X = c +- 4, Z 1.6 to 6) and the floor
// (Z = 1.6, X = c - 4 to c + 4). The hole's top and bottom circles fall under the outline.
// Top: the 50 x 30 outline, the upright's inner top edge at X = 6, and per hole the counterbore
// circle (r 4) and the through hole's circle at the floor (r 2.25); everything below lies under
// these. The fillet's tangent edge with the foot top (X = 10) is a visible smooth edge. Right (looking -X; paper x = Y): the 30 x 40
// outline and the foot's top edge at Z = 6, visible; the fillet's tangent edge at Z = 10 is a
// visible smooth edge; hidden: both holes (they coincide), the same five lines per hole as in
// front, in Y.
const d = M4.clearance.normal;
const cbR = M4.counterbore.diameter / 2;
const floor = 6 - M4.counterbore.depth;
const brk: Record<string, ExpectedView> = (() => {
  const y0 = -15;
  const holeLines = (c: number, along: 'x' | 'y'): Vec3[][] => {
    const p = (s: number, z: number): Vec3 => (along === 'x' ? [c + s, y0, z] : [50, s, z]);
    return [
      seg(p(-d / 2, 0), p(-d / 2, floor)),
      seg(p(d / 2, 0), p(d / 2, floor)),
      seg(p(-cbR, floor), p(-cbR, 6)),
      seg(p(cbR, floor), p(cbR, 6)),
      seg(p(-cbR, floor), p(cbR, floor)),
    ];
  };
  return {
    front: {
      visible: [
        seg([0, y0, 0], [50, y0, 0]),
        seg([50, y0, 0], [50, y0, 6]),
        seg([50, y0, 6], [10, y0, 6]),
        arc3([10, y0, 10], 'y', 4, 180, 270),
        seg([6, y0, 10], [6, y0, 40]),
        seg([6, y0, 40], [0, y0, 40]),
        seg([0, y0, 40], [0, y0, 0]),
      ],
      hidden: [...holeLines(25, 'x'), ...holeLines(40, 'x')],
      smooth: [],
    },
    top: {
      visible: [
        seg([0, -15, 40], [50, -15, 40]),
        seg([50, -15, 40], [50, 15, 40]),
        seg([50, 15, 40], [0, 15, 40]),
        seg([0, 15, 40], [0, -15, 40]),
        seg([6, -15, 40], [6, 15, 40]),
        ...[25, 40].flatMap((c) => [arc3([c, 0, 6], 'z', cbR), arc3([c, 0, floor], 'z', d / 2)]),
      ],
      hidden: [],
      // Not the other tangent edge (X = 6, Z = 10): it projects exactly onto the sharp edge at
      // X = 6, and HLR reports only the sharp one (first run of this test expected both).
      smooth: [seg([10, -15, 6], [10, 15, 6])],
    },
    right: {
      visible: [
        seg([50, -15, 0], [50, 15, 0]),
        seg([50, 15, 0], [50, 15, 40]),
        seg([50, 15, 40], [50, -15, 40]),
        seg([50, -15, 40], [50, -15, 0]),
        seg([50, -15, 6], [50, 15, 6]),
      ],
      hidden: holeLines(0, 'y'),
      // Only Z = 10: the tangent edge with the foot top projects onto the sharp edge at Z = 6.
      smooth: [seg([50, -15, 10], [50, 15, 10])],
    },
  };
})();

/** Points of an analytic 2D curve record, to check it against the sampled points. */
function curvePoints(c: Curve2, n = 64): Vec2[] {
  if (c.kind === 'line') return [c.a, c.b];
  if (c.kind === 'polyline') return c.points;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = c.start + ((c.end - c.start) * i) / n;
    if (c.kind === 'arc')
      out.push([c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)]);
    else {
      const u = c.major * Math.cos(t);
      const v = c.minor * Math.sin(t);
      const cr = Math.cos(c.rotation);
      const sr = Math.sin(c.rotation);
      out.push([c.center[0] + u * cr - v * sr, c.center[1] + u * sr + v * cr]);
    }
  }
  return out;
}

function checkRecords(edges: readonly ProjectedEdge[]) {
  for (const e of edges) {
    const analytic = curvePoints(e.curve);
    for (const p of e.points) expect(distToPolys(p, [analytic])).toBeLessThan(0.05);
    for (const p of analytic) expect(distToPolys(p, [e.points])).toBeLessThan(0.05);
  }
}

const cases = [
  ['box-hole', boxWithHole, box],
  ['cylinder', cylinder, cyl],
  ['bracket', (kk: Kernel) => bracket(kk, 6), brk],
] as const;

describe.each(cases)('%s against the hand-drawn views', (name, make, views) => {
  for (const [viewName, expected] of Object.entries(views)) {
    for (const algorithm of ['exact', 'poly'] as const) {
      it(`${viewName}, ${algorithm}`, () => {
        const fixture = make(k);
        const shapes = fixture.bodies.map((b) => shapeOf(k, b));
        const view = VIEWS[viewName as keyof typeof VIEWS];
        const run = algorithm === 'exact' ? projectExact : projectPoly;
        const { edges } = run(k.oc, shapes, view, { meshDeflection: 0.01 });
        // Poly output is chords of the mesh: allow the mesh deflection on top of the sampling.
        const cmp = compareView(edges, view, expected, algorithm === 'exact' ? 0.08 : 0.12);
        (results[name] ??= {})[`${viewName}.${algorithm}`] = { algorithm, ...cmp };
        if (!cmp.ok)
          console.log(name, viewName, algorithm, JSON.stringify(cmp.mismatches.slice(0, 5)));
        if (algorithm === 'exact') checkRecords(edges);
        expect(cmp.mismatches).toEqual([]);
        for (const b of fixture.bodies) k.release(b);
      });
    }
  }
});

it('HLR 2D coordinates, HLRAlgo_Projector.Project and views.ts agree (every view)', () => {
  const fixture = boxWithHole(k);
  const shapes = fixture.bodies.map((b) => shapeOf(k, b));
  const oc = k.oc;
  for (const view of Object.values(VIEWS)) {
    const frame = frameOf(view);
    const { edges } = projectExact(oc, shapes, view);
    const ends = edges.filter((e) => e.curve.kind === 'line').flatMap((e) => e.points);
    const ax = new oc.gp_Ax2(
      new oc.gp_Pnt(0, 0, 0),
      new oc.gp_Dir(frame.z[0], frame.z[1], frame.z[2]),
      new oc.gp_Dir(frame.x[0], frame.x[1], frame.x[2]),
    );
    const projector = new oc.HLRAlgo_Projector(ax);
    for (const e of boxEdges([0, 0, 0], [100, 50, 20])) {
      const ours = project(frame, e.a).at;
      // Every projected box corner is an end point of some line edge of the HLR result...
      expect(Math.min(...ends.map((p) => Math.hypot(p[0] - ours[0], p[1] - ours[1])))).toBeLessThan(
        1e-9,
      );
      // ... and OCCT's projector puts it at the same place.
      const out = new oc.gp_Pnt2d(0, 0);
      const pnt = new oc.gp_Pnt(e.a[0], e.a[1], e.a[2]);
      projector.Project(pnt, out);
      expect(Math.hypot(out.X() - ours[0], out.Y() - ours[1])).toBeLessThan(1e-9);
      out.delete();
      pnt.delete();
    }
    projector.delete();
    ax.delete();
  }
});

it('writes results/expected.json', () => {
  writeResult('expected', { results });
});
