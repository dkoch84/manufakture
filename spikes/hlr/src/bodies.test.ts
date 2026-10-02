// Several bodies in one view, and section views:
// 1. per-body layers from one HLR run (`CompoundOfEdges(S, ...)`) against the whole-view result;
// 2. projecting each body alone and merging, against projecting them together (occlusion
//    between bodies is lost; how much drawing is wrong);
// 3. reusing one body's projection for a translated instance (shift the 2D output);
// 4. a section: the bracket cut by a half space (a big box) at Y = 0, seen from the front.
// Writes results/bodies.json.

import { expect, it } from 'vitest';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import { distToPolys, uncovered } from './compare';
import { bookshelf, bracket, cabinetRun, dadoPair, M4, type Fixture } from './fixtures';
import { projectExact, projectPoly, shapeOf, type ProjectedEdge } from './hlr';
import { round, writeResult } from './results';
import { frameOf, project, VIEWS, type Vec2 } from './views';

const out: Record<string, unknown> = {};

const vis = (edges: readonly ProjectedEdge[], visible: boolean) =>
  edges.filter((e) => e.visible === visible && (e.cls === 'sharp' || e.cls === 'outline'));

it('per-body layers from one run equal the whole view; separate runs lose occlusion', async () => {
  const rows: unknown[] = [];
  for (const [name, make] of [
    ['dado-pair', dadoPair],
    ['bookshelf', bookshelf],
    ['cabinet-run-100', (k: Kernel) => cabinetRun(k, 20)],
  ] as [string, (k: Kernel) => Fixture][]) {
    const k = await createNodeKernel();
    const fixture = make(k);
    const shapes = fixture.bodies.map((b) => shapeOf(k, b));
    for (const view of Object.values(VIEWS)) {
      const t0 = performance.now();
      const whole = projectExact(k.oc, shapes, view).edges;
      const t1 = performance.now();
      const layered = projectExact(k.oc, shapes, view, { perItem: true }).edges;
      const t2 = performance.now();
      const separate = shapes.flatMap((sh) => projectExact(k.oc, [sh], view).edges);
      const t3 = performance.now();
      const row = {
        fixture: name,
        view: view.name,
        ms: { whole: round(t1 - t0), perBodyLayers: round(t2 - t1), eachBodyAlone: round(t3 - t2) },
        perBodyLayers: {
          visibleNotInWhole: uncovered(vis(layered, true), vis(whole, true)),
          wholeVisibleNotInLayers: uncovered(vis(whole, true), vis(layered, true)),
          hiddenNotInWhole: uncovered(vis(layered, false), vis(whole, false)),
        },
        eachBodyAlone: {
          // Drawn visible although another body hides it:
          visibleThatShouldBeHidden: uncovered(vis(separate, true), vis(whole, true)),
          visibleTotal: round(
            vis(whole, true).reduce((n, e) => n + lengthOf(e.points), 0),
            1,
          ),
        },
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      expect(row.perBodyLayers.visibleNotInWhole).toBe(0);
      expect(row.perBodyLayers.wholeVisibleNotInLayers).toBe(0);
    }
  }
  out.layers = rows;
});

const lengthOf = (pts: readonly Vec2[]) => {
  let l = 0;
  for (let i = 1; i < pts.length; i++)
    l += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return l;
};

it('a translated instance: projecting once and shifting the 2D output gives the same edges', async () => {
  const k = await createNodeKernel();
  const rows: unknown[] = [];
  const body = bracket(k, 6).bodies[0]!;
  const offset = [120, 35, -20] as const;
  const moved = k.transform(body, { kind: 'translate', vector: offset }).shape;
  for (const view of Object.values(VIEWS)) {
    const frame = frameOf(view);
    const shift = project(frame, offset).at;
    const once = projectExact(k.oc, [shapeOf(k, body)], view).edges.map((e) => ({
      ...e,
      points: e.points.map((p): Vec2 => [p[0] + shift[0], p[1] + shift[1]]),
    }));
    const placed = projectExact(k.oc, [shapeOf(k, moved)], view).edges;
    const row = {
      view: view.name,
      shiftedNotInPlaced: uncovered(once, placed, 1e-6),
      placedNotInShifted: uncovered(placed, once, 1e-6),
    };
    rows.push(row);
    expect(row.shiftedNotInPlaced).toBe(0);
    expect(row.placedNotInShifted).toBe(0);
  }
  out.translatedInstance = rows;
});

it('a section view: the bracket cut at Y = 0, seen from the front', async () => {
  const k = await createNodeKernel();
  const body = bracket(k, 6).bodies[0]!;
  const t0 = performance.now();
  // Keep Y > 0: remove everything in front of the plane with a box far larger than the part.
  const half = k.box(1e4, 1e4, 1e4, [-5e3, -1e4, -5e3]);
  const cut = k.boolean('cut', body, [half]).shape;
  const t1 = performance.now();
  const r = projectExact(k.oc, [shapeOf(k, cut)], VIEWS.front);
  const t2 = performance.now();
  // The section faces: planar faces on Y = 0 whose outward normal points at the viewer (-Y).
  const topo = k.topology(cut);
  const section = topo.faces.filter(
    (f) =>
      f.surface === 'plane' && f.normal && f.normal[1] < -0.999 && Math.abs(f.centroid[1]) < 1e-9,
  );
  // By hand: the L (50 x 6 + 6 x 34 = 504) plus the fillet's corner (16 (1 - pi / 4)), less per hole
  // the through hole (4.5 x 1.6) and the counterbore (8 x 4.4); the holes split the foot in three.
  const d = M4.clearance.normal;
  const cb = M4.counterbore;
  const expectedArea =
    504 + 16 * (1 - Math.PI / 4) - 2 * (d * (6 - cb.depth) + cb.diameter * cb.depth);
  const area = section.reduce((n, f) => n + f.area, 0);
  // Section boundary edges: every edge of those faces; all must be drawn visible.
  const faceIds = new Set(section.map((f) => f.index));
  const boundary = topo.edges.filter((e) => e.faces.some((f) => faceIds.has(f)));
  const frame = frameOf(VIEWS.front);
  const visible = vis(r.edges, true).map((e) => e.points);
  const notDrawn = boundary.filter(
    (e) => distToPolys(project(frame, e.midpoint).at, visible) > 0.08,
  ).length;
  out.section = {
    cutMs: round(t1 - t0),
    hlrMs: round(t2 - t1),
    sectionFaces: section.length,
    area: round(area, 4),
    expectedArea: round(expectedArea, 4),
    boundaryEdges: boundary.length,
    boundaryEdgesNotDrawnVisible: notDrawn,
    hlrEdges: r.edges.length,
  };
  console.log(out.section);
  expect(section.length).toBe(3);
  expect(area).toBeCloseTo(expectedArea, 6);
  expect(notDrawn).toBe(0);
});

it('poly HLR where boards touch: the bookshelf front view, whole and one side alone', async () => {
  const k = await createNodeKernel();
  const shapes = bookshelf(k).bodies.map((b) => shapeOf(k, b));
  const row = (label: string, s: typeof shapes) => {
    const e = projectExact(k.oc, s, VIEWS.front).edges;
    const p = projectPoly(k.oc, s, VIEWS.front).edges;
    return { label, visiblePolyNotExact: uncovered(vis(p, true), vis(e, true), 0.15) };
  };
  const rows = [
    row('all 7 boards', shapes),
    row('left side alone', [shapes[0]!]),
    row('left side and back', [shapes[0]!, shapes[6]!]),
  ];
  console.log(rows);
  out.polyContact = rows;
  expect(rows[1]!.visiblePolyNotExact).toBe(0);
});

it('writes results/bodies.json', () => {
  writeResult('bodies', out);
});
