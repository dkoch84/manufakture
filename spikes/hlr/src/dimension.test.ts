// The dimension model end to end on the M1 bracket: references picked by clicking in a view
// (nearest projected vertex or edge, nearest to the viewer on ties), stored as names, resolved
// and projected again after the walls change from 6 to 8 mm and after the fillet is deleted;
// values formatted through packages/units. Writes results/dimension.json.

import { beforeAll, expect, it } from 'vitest';
import { pickVertex } from '../../../packages/kernel/src/features';
import { build } from '../../../packages/kernel/src/fixtures/parts';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import { pickEdge, pickFace } from '../../../packages/kernel/src/naming';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import type { ShapeId } from '../../../packages/kernel/src/types';
import { formatLength } from '../../../packages/units/src/index';
import { resolveDimension, type Dimension } from './dimension';
import { bracketFeatures } from './fixtures';
import { writeResult } from './results';
import { modelEdges, pickNearestFront, projectModelEdges } from './source';
import { frameOf, project, VIEWS, type Vec2, type View } from './views';

let k: Kernel;
beforeAll(async () => {
  k = await createNodeKernel();
});

const out: Record<string, unknown> = {};

/** The vertex nearest a click, the one nearest the viewer when several project to the same point. */
function clickVertex(shape: ShapeId, view: View, at: Vec2) {
  const frame = frameOf(view);
  const named = k.named(shape)!;
  const hits = named.topology.vertices.map((v) => {
    const p = project(frame, v.point);
    return { v, d: Math.hypot(p.at[0] - at[0], p.at[1] - at[1]), depth: p.depth };
  });
  const dmin = Math.min(...hits.map((h) => h.d));
  const best = hits.filter((h) => h.d <= dmin + 1e-6).sort((a, b) => b.depth - a.depth)[0]!;
  return pickVertex(named.names, named.topology, best.v.index)!;
}

/** The edge nearest a click (the plan's picking, with the depth tie-break). */
function clickEdge(shape: ShapeId, view: View, at: Vec2) {
  const named = k.named(shape)!;
  const edges = projectModelEdges(modelEdges(k, [shape], 0.1), frameOf(view));
  const key = pickNearestFront(at, edges, 0.15)!;
  return pickEdge(named.names, key.edge)!;
}

it('dimensions follow the model: t 6 -> 8, then the fillet deleted', () => {
  const t6 = build(k, bracketFeatures(6)).shape;
  const named = k.named(t6)!;
  const face = (name: string) =>
    pickFace(named.names, named.names.faces.findIndex((f) => f.name === name) + 1)!;

  // Picked in the views, as a user would: front view clicks at the foot's right end, the
  // upright's back edge; top view clicks on the two counterbore circles.
  const dims: Record<string, { dim: Dimension; view: View }> = {
    footThickness: {
      view: VIEWS.front,
      dim: {
        kind: 'vertical',
        from: { vertex: clickVertex(t6, VIEWS.front, [50, 0]) },
        to: { vertex: clickVertex(t6, VIEWS.front, [50, 6]) },
      },
    },
    height: {
      view: VIEWS.front,
      dim: {
        kind: 'vertical',
        from: { vertex: clickVertex(t6, VIEWS.front, [0, 0]) },
        to: { vertex: clickVertex(t6, VIEWS.front, [0, 40]) },
      },
    },
    holeSpacing: {
      view: VIEWS.top,
      dim: {
        kind: 'horizontal',
        from: { edge: clickEdge(t6, VIEWS.top, [29, 0]) },
        to: { edge: clickEdge(t6, VIEWS.top, [44, 0]) },
      },
    },
    holeDiameterTop: {
      view: VIEWS.top,
      dim: { kind: 'diameter', of: { face: face('hole#1:wall:e7') } },
    },
    holeDiameterFront: {
      view: VIEWS.front,
      dim: { kind: 'diameter', of: { face: face('hole#1:wall:e7') } },
    },
    filletRadius: {
      view: VIEWS.front,
      dim: { kind: 'radius', of: { face: face('fillet#1:round:r2') } },
    },
  };
  out.stored = Object.fromEntries(Object.entries(dims).map(([n, d]) => [n, d.dim]));

  const t8 = build(k, bracketFeatures(8)).shape;
  const noFillet = build(k, bracketFeatures(8).slice(0, 2)).shape;
  const results: Record<string, unknown> = {};
  for (const [label, shape] of [
    ['t6', t6],
    ['t8', t8],
    ['t8 without fillet', noFillet],
  ] as const) {
    results[label] = Object.fromEntries(
      Object.entries(dims).map(([n, { dim, view }]) => {
        const r = resolveDimension(k, shape, dim, view);
        return [
          n,
          {
            status: r.status,
            value: r.value,
            warnings: r.warnings,
            anchors: r.anchors?.kind ?? null,
          },
        ];
      }),
    );
  }
  out.resolved = results;
  console.log(JSON.stringify(results, null, 1));
  const v = (label: string, n: string) =>
    (results[label] as Record<string, { value: number | null; status: string }>)[n]!;
  expect(v('t6', 'footThickness')).toMatchObject({ status: 'exact', value: 6 });
  expect(v('t8', 'footThickness')).toMatchObject({ status: 'exact', value: 8 });
  expect(v('t8', 'height')).toMatchObject({ status: 'exact', value: 40 });
  expect(v('t6', 'holeSpacing').value).toBeCloseTo(15, 9);
  expect(v('t8', 'holeSpacing')).toMatchObject({ status: 'exact' });
  expect(v('t8', 'holeSpacing').value).toBeCloseTo(15, 9);
  expect(v('t8', 'holeDiameterTop').value).toBeCloseTo(4.5, 9);
  expect(v('t8', 'holeDiameterFront').value).toBeCloseTo(4.5, 9);
  expect(v('t8', 'filletRadius')).toMatchObject({ status: 'exact', value: 4 });
  expect(v('t8 without fillet', 'filletRadius')).toMatchObject({ status: 'lost', value: null });
  expect(v('t8 without fillet', 'footThickness')).toMatchObject({ status: 'exact', value: 8 });
});

it('formats values through packages/units', () => {
  const cases: [number, Parameters<typeof formatLength>[1]][] = [
    [900, { unit: 'ft-in', denominator: 16 }],
    [1028.7, { unit: 'ft-in', denominator: 16 }],
    [18, { unit: 'in-fraction', denominator: 32 }],
    [4.5, { unit: 'mm' }],
  ];
  const formatted = cases.map(([mm, f]) => ({ mm, format: f, text: formatLength(mm, f) }));
  out.formatted = formatted;
  console.log(formatted);
  // By hand: 900 mm = 35.433 in = 2' 11.433", nearest 1/16 is 11-7/16; 1028.7 mm = 40.5 in.
  expect(formatted[0]!.text).toBe(`2' 11-7/16"`);
  expect(formatted[1]!.text).toBe(`3' 4-1/2"`);
});

it('writes results/dimension.json', () => {
  writeResult('dimension', out);
});
