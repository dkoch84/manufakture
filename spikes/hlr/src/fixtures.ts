// The bodies the spike projects. Raw kernel operations except the M1 bracket, which goes through
// the feature layer so its faces, edges and vertices are named like a real part's.
//
// Woodworking boards are boxes with dadoes and rabbets cut as boxes, the way the `tools` input
// (T4.2a) will make them; shelf-pin holes are cylinders.

import type { FeatureInput } from '../../../packages/kernel/src/features';
import { build, polygon, profile } from '../../../packages/kernel/src/fixtures/parts';
import { holeSize } from '../../../packages/kernel/src/holes';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import type { Frame, ShapeId } from '../../../packages/kernel/src/types';

export interface Fixture {
  name: string;
  /** Placed bodies, one shape each. */
  bodies: ShapeId[];
}

const cut = (k: Kernel, body: ShapeId, tools: ShapeId[]): ShapeId => {
  const out = k.boolean('cut', body, tools).shape;
  for (const t of tools) k.release(t);
  k.release(body);
  return out;
};

/** 100 x 50 x 20 block with a 10 mm through hole at (50, 25), vertical. */
export function boxWithHole(k: Kernel): Fixture {
  const body = cut(k, k.box(100, 50, 20), [k.cylinder(5, 40, [50, 25, -10])]);
  return { name: 'box-hole', bodies: [body] };
}

/** Cylinder r 20, h 50, axis Z, base at the origin. */
export function cylinder(k: Kernel): Fixture {
  return { name: 'cylinder', bodies: [k.cylinder(20, 50)] };
}

/** 600 x 300 x 18 board (thickness along Z) with `n` 5 mm through holes in rows of 10. */
export function holeBoard(k: Kernel, n: number): Fixture {
  const tools: ShapeId[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % 10;
    const row = Math.floor(i / 10);
    tools.push(k.cylinder(2.5, 40, [50 + col * 55, 40 + row * 60, -10]));
  }
  return { name: `board-${n}-holes`, bodies: [cut(k, k.box(600, 300, 18), tools)] };
}

/** Box 80 x 60 x 30 with its four vertical edges filleted (R 6) and its top edges chamfered (3). */
export function filletChamfer(k: Kernel): Fixture {
  const box = k.box(80, 60, 30);
  const vertical = k
    .topology(box)
    .edges.filter((e) => e.curve === 'line' && Math.abs(e.midpoint[2] - 15) < 1e-9)
    .map((e) => e.index);
  const filleted = k.fillet(box, vertical, 6).shape;
  const top = k
    .topology(filleted)
    .edges.filter((e) => Math.abs(e.midpoint[2] - 30) < 1e-9)
    .map((e) => ({ edge: e.index }));
  const chamfered = k.chamfer(filleted, top, { kind: 'distance', distance: 3 }).shape;
  k.release(box);
  k.release(filleted);
  return { name: 'fillet-chamfer', bodies: [chamfered] };
}

/** A vase: a cubic Bezier profile revolved about Z (B-spline surfaces, freeform silhouettes). */
export function vase(k: Kernel): Fixture {
  const front: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const p = k.profile(front, [
    {
      entities: [
        { kind: 'line', start: [0, 0], end: [30, 0] },
        {
          kind: 'bezier',
          points: [
            [30, 0],
            [60, 40],
            [5, 70],
            [20, 100],
          ],
        },
        { kind: 'line', start: [20, 100], end: [0, 100] },
        { kind: 'line', start: [0, 100], end: [0, 0] },
      ],
    },
  ]);
  const body = k.revolve(p, { origin: [0, 0, 0], direction: [0, 0, 1] }, 2 * Math.PI).shape;
  k.release(p);
  return { name: 'vase', bodies: [body] };
}

/** One side board (18 thick along X) with a dado for a shelf, and the shelf sitting in it. */
export function dadoPair(k: Kernel): Fixture {
  const side = cut(k, k.box(18, 300, 600), [k.box(6, 300, 18, [12, 0, 300])]);
  const shelf = k.box(400, 300, 18, [12, 0, 300]);
  return { name: 'dado-pair', bodies: [side, shelf] };
}

/**
 * A bookshelf, 800 wide, 300 deep, 900 high: two sides with four dadoes, a back rabbet and 20
 * shelf-pin holes each, four shelves in the dadoes, and a 6 mm back in the rabbets.
 */
export function bookshelf(k: Kernel): Fixture {
  const W = 800;
  const D = 300;
  const H = 900;
  const T = 18;
  const dadoes = [50, 330, 610, 870];
  const side = (x0: number, inner: number): ShapeId => {
    const tools: ShapeId[] = [];
    const xd = inner > x0 ? x0 + T - 6 : x0;
    for (const z of dadoes) tools.push(k.box(6, D, T, [xd, 0, z]));
    tools.push(k.box(6, 6, H, [xd, D - 6, 0]));
    for (let i = 0; i < 20; i++) {
      const y = i % 2 === 0 ? 50 : D - 60;
      const z = 120 + Math.floor(i / 2) * 64;
      const xh = inner > x0 ? x0 + T - 10 : x0 - 30;
      tools.push(k.cylinder(2.5, 40, [xh, y, z], [1, 0, 0]));
    }
    return cut(k, k.box(T, D, H, [x0, 0, 0]), tools);
  };
  const left = side(0, 1);
  const right = side(W - T, 0);
  const shelves = dadoes.map((z) => k.box(W - 2 * (T - 6), D - 6, T, [T - 6, 0, z]));
  const back = k.box(W - 2 * (T - 6), 6, H - 50, [T - 6, D - 6, 50]);
  return { name: 'bookshelf', bodies: [left, right, ...shelves, back] };
}

/**
 * A kitchen run of 20 base cabinets, 5 boards each (100 bodies): two sides with a dado for the
 * bottom, a bottom, a top stretcher and a back, side by side along X.
 */
export function cabinetRun(k: Kernel, cabinets = 20): Fixture {
  const bodies: ShapeId[] = [];
  const W = 600;
  const D = 560;
  const H = 720;
  const T = 18;
  for (let c = 0; c < cabinets; c++) {
    const x = c * W;
    const left = cut(k, k.box(T, D, H, [x, 0, 0]), [k.box(6, D, T, [x + T - 6, 0, 100])]);
    const right = cut(k, k.box(T, D, H, [x + W - T, 0, 0]), [k.box(6, D, T, [x + W - T, 0, 100])]);
    const bottom = k.box(W - 2 * (T - 6), D - 6, T, [x + T - 6, 0, 100]);
    const top = k.box(W - 2 * T, 100, T, [x + T, 0, H - T]);
    const back = k.box(W - 2 * T, 6, H - 118, [x + T, D - 6, 118]);
    bodies.push(left, right, bottom, top, back);
  }
  return { name: `cabinet-run-${bodies.length}`, bodies };
}

export const M4 = holeSize('M4')!;

/** The M1 bracket (packages/kernel/test/bracket.test.ts) with walls `t` thick, built through features. */
export function bracketFeatures(t: number): FeatureInput[] {
  const front: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  return [
    {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        front,
        polygon(
          [
            [0, 0],
            [50, 0],
            [50, t],
            [t, t],
            [t, 40],
            [0, 40],
          ],
          ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
        ),
      ),
      extent: { type: 'symmetric', distance: 30 },
      mode: 'new',
    },
    {
      kind: 'hole',
      id: 'hole#1',
      frame: { origin: [0, 0, t], xDir: [1, 0, 0], normal: [0, 0, 1] },
      points: [
        { id: 'e7', at: [25, 0] },
        { id: 'e8', at: [40, 0] },
      ],
      diameter: M4.clearance.normal,
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: M4.counterbore.diameter, depth: M4.counterbore.depth },
    },
    {
      kind: 'fillet',
      id: 'fillet#1',
      radius: 4,
      edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
    },
  ];
}

export function bracket(k: Kernel, t = 6): Fixture {
  return { name: `bracket-t${t}`, bodies: [build(k, bracketFeatures(t)).shape] };
}

/**
 * A large imported STEP file: the 100-board cabinet run, with the bookshelf and four vases in front
 * of it, written to STEP and read back as one shape (an import is one compound, not a list of bodies). No real-world
 * STEP file is in the repository; this stands in for one.
 */
export function stepImport(k: Kernel): Fixture & { bytes: number } {
  const parts = [...cabinetRun(k, 20).bodies];
  // In front of the run, so they hide part of it in every view but the top.
  const place = (id: ShapeId, vector: readonly [number, number, number]) => {
    parts.push(k.transform(id, { kind: 'translate', vector }).shape);
    k.release(id);
  };
  for (const b of bookshelf(k).bodies) place(b, [1000, -800, 0]);
  for (let i = 0; i < 4; i++) place(vase(k).bodies[0]!, [200 * i, -1200, 0]);
  const step = k.exportStep(parts.map((shape, i) => ({ shape, name: `part${i + 1}` })));
  for (const p of parts) k.release(p);
  return { name: 'step-import', bodies: [k.importStep(step)], bytes: step.length };
}

/** Every fixture of the timing table, by name. */
export const FIXTURES: Record<string, (k: Kernel) => Fixture> = {
  'box-hole': boxWithHole,
  cylinder,
  'board-40-holes': (k) => holeBoard(k, 40),
  'fillet-chamfer': filletChamfer,
  vase,
  bracket: (k) => bracket(k, 6),
  'dado-pair': dadoPair,
  bookshelf,
  'cabinet-run-100': (k) => cabinetRun(k, 20),
  'step-import': stepImport,
};
