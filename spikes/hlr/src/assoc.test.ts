// Linking HLR output to the model, and picking:
// 1. every 2D edge gets the 3D pieces it is the image of (`source: true`);
// 2. every sharp, smooth and sewn piece lies on a model edge (found in 3D), outlines on none;
// 3. picking by the nearest projected model edge (the plan's method), with and without a depth
//    tie-break, against that ground truth, clicking along every visible edge of the fixtures.
// Writes results/assoc.json.

import { expect, it } from 'vitest';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import {
  bookshelf,
  boxWithHole,
  bracket,
  dadoPair,
  filletChamfer,
  holeBoard,
  type Fixture,
} from './fixtures';
import { projectExact, shapeOf } from './hlr';
import { round, writeResult } from './results';
import {
  modelEdges,
  pickNearest,
  pickNearestFront,
  projectModelEdges,
  sourceOf,
  type EdgeKey,
} from './source';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import { frameOf, VIEWS, type Vec2 } from './views';

const FIXTURES: [string, (k: Kernel) => Fixture][] = [
  ['box-hole', boxWithHole],
  ['bracket', (k) => bracket(k, 6)],
  ['fillet-chamfer', filletChamfer],
  ['board-10-holes', (k) => holeBoard(k, 10)],
  ['dado-pair', dadoPair],
  ['bookshelf', bookshelf],
];

const same = (a: EdgeKey, b: EdgeKey) => a.body === b.body && a.edge === b.edge;

it('links HLR edges to model edges in 3D and measures picking', async () => {
  const rows: unknown[] = [];
  for (const [name, make] of FIXTURES) {
    const k = await createNodeKernel();
    const fixture = make(k);
    const shapes = fixture.bodies.map((b) => shapeOf(k, b));
    // Ground truth geometry: edges meshed finely. Picking uses the display mesh (0.1 mm).
    const fine = modelEdges(k, fixture.bodies, 0.001);
    const display = modelEdges(k, fixture.bodies, 0.1);
    for (const view of Object.values(VIEWS)) {
      const frame = frameOf(view);
      const t0 = performance.now();
      projectExact(k.oc, shapes, view);
      const t1 = performance.now();
      const { edges } = projectExact(k.oc, shapes, view, { source: true });
      const t2 = performance.now();
      // 1. Every 2D edge has at least one 3D piece; how many have several (coincident in view).
      let unmatched = 0;
      let severalPieces = 0;
      for (const e of edges) {
        if (e.source3d!.length === 0) unmatched++;
        if (e.source3d!.length > 1) severalPieces++;
      }
      // 2. Sources.
      const stats = {
        pieces: 0,
        oneSource: 0,
        severalSources: 0,
        noSource: 0,
        outlineOnEdge: 0,
        outlines: 0,
      };
      const truth = edges.map((e) => {
        const src = dedupe(e.source3d!.flatMap((piece) => sourceOf(piece, fine, 0.01)));
        if (e.cls === 'outline') {
          stats.outlines++;
          if (src.length > 0) stats.outlineOnEdge++;
          return src;
        }
        stats.pieces++;
        if (src.length === 1) stats.oneSource++;
        else if (src.length > 1) stats.severalSources++;
        else stats.noSource++;
        return src;
      });
      const t3 = performance.now();
      // 3. Picking: clicks every 2 mm along visible sharp and smooth edges, away from their ends.
      const projected = projectModelEdges(display, frame);
      const pick = { clicks: 0, nearest: 0, nearestFront: 0, outlineClicks: 0 };
      const misses: { at: Vec2; truth: EdgeKey[]; nearest: EdgeKey | null }[] = [];
      const frontMisses: { at: Vec2; cls: string; truth: EdgeKey[]; picked: EdgeKey | null }[] = [];
      edges.forEach((e, i) => {
        if (!e.visible || e.cls === 'sewn') return;
        const clicks = clickPoints(e.points, 2, 0.5);
        if (e.cls === 'outline') {
          pick.outlineClicks += clicks.length;
          return;
        }
        const want = truth[i]!;
        if (want.length === 0) return;
        for (const c of clicks) {
          pick.clicks++;
          const a = pickNearest(c, projected);
          const b = pickNearestFront(c, projected, 0.15);
          if (a && want.some((w) => same(w, a))) pick.nearest++;
          else if (misses.length < 5) misses.push({ at: c, truth: want, nearest: a });
          if (b && want.some((w) => same(w, b))) pick.nearestFront++;
          else frontMisses.push({ at: c, cls: e.cls, truth: want, picked: b });
        }
      });
      const t4 = performance.now();
      const row = {
        fixture: name,
        view: view.name,
        hlrEdges: edges.length,
        unmatched,
        severalPieces,
        ...stats,
        ...pick,
        nearestRate: round(pick.nearest / Math.max(1, pick.clicks), 4),
        nearestFrontRate: round(pick.nearestFront / Math.max(1, pick.clicks), 4),
        ms: {
          exact: round(t1 - t0),
          exactWithSource: round(t2 - t1),
          matchSources: round(t3 - t2),
          pickAllClicks: round(t4 - t3),
        },
        sampleMisses: misses,
        frontMisses,
      };
      rows.push(row);
      console.log(
        `${name.padEnd(15)} ${view.name.padEnd(5)} unmatched ${unmatched}, several pieces ${severalPieces}, pieces ${stats.pieces} (one source ${stats.oneSource}, several ${stats.severalSources}, none ${stats.noSource}), outlines ${stats.outlines} (on an edge ${stats.outlineOnEdge}); picking ${pick.clicks} clicks: nearest ${row.nearestRate}, nearest+front ${row.nearestFrontRate}`,
      );
      expect(unmatched).toBe(0);
      expect(stats.noSource).toBe(0);
    }
  }
  writeResult('assoc', { rows });
});

function dedupe(keys: EdgeKey[]): EdgeKey[] {
  return keys.filter((k, i) => keys.findIndex((o) => same(o, k)) === i);
}

/** Points every `step` along a 2D polyline, at least `margin` from its ends. */
function clickPoints(poly: readonly Vec2[], step: number, margin: number): Vec2[] {
  const segs: { a: Vec2; b: Vec2; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len });
    total += len;
  }
  const out: Vec2[] = [];
  if (total < 2 * margin) return out;
  const n = Math.max(1, Math.floor((total - 2 * margin) / step));
  for (let i = 0; i <= n; i++) {
    let s = margin + ((total - 2 * margin) * i) / n;
    for (const sg of segs) {
      if (s <= sg.len) {
        const t = sg.len === 0 ? 0 : s / sg.len;
        out.push([sg.a[0] + t * (sg.b[0] - sg.a[0]), sg.a[1] + t * (sg.b[1] - sg.a[1])]);
        break;
      }
      s -= sg.len;
    }
  }
  return out;
}
