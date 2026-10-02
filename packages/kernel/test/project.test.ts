// Golden tests for the `project` op (M4 plan, T4.4b): hidden-line views against views drawn by hand
// (the T4.4a spike's expectations: a box with a hole and a cylinder in front, top, right and
// isometric views, the M1 bracket in front, top and right), the curve records (circles in a top
// view, ellipse arcs in an isometric one, lines for circles seen edge on), two touching boards (a
// side and a back in its rabbet: no hidden edge drawn visible), per-item results, placed items,
// sections, the options, the frame arithmetic against OCCT's projector, the errors, and the op
// through the service.

import { beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from '../src/errors';
import { build, polygon, profile } from '../src/fixtures/parts';
import type { FeatureInput } from '../src/features';
import { holeSize } from '../src/holes';
import type { Kernel } from '../src/kernel';
import { createNodeKernel, createNodeService } from '../src/node';
import {
  boundsOf,
  endsOf,
  projectPoint,
  viewFrame,
  type Curve2,
  type ProjectedEdge,
  type ProjectResult,
  type ProjectView,
  type SectionFace,
} from '../src/project';
import type { Frame, Placement, ShapeId, Vec2, Vec3 } from '../src/types';
import {
  arc3,
  compareView,
  curvePoints,
  distToPolys,
  seg,
  type ExpectedView,
} from './project-compare';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const S3 = 1 / Math.sqrt(3);

/** Third-angle views of a Z-up model: front looks along +Y, top down -Z, right along -X. */
const VIEWS: Record<'front' | 'top' | 'right' | 'iso', ProjectView> = {
  front: { direction: [0, 1, 0], up: [0, 0, 1] },
  top: { direction: [0, 0, -1], up: [0, 1, 0] },
  right: { direction: [-1, 0, 0], up: [0, 0, 1] },
  iso: { direction: [-S3, S3, -S3], up: [0, 0, 1] },
};

const near = (a: number, b: number, tol = 1e-6) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const nearVec2 = (a: Vec2, b: Vec2, tol = 1e-6) => {
  near(a[0], b[0], tol);
  near(a[1], b[1], tol);
};

function cut(body: ShapeId, tools: ShapeId[]): ShapeId {
  const out = k.boolean('cut', body, tools).shape;
  for (const t of tools) k.release(t);
  k.release(body);
  return out;
}

/** 100 x 50 x 20 block with a 10 mm through hole at (50, 25), vertical. */
const boxWithHole = () => cut(k.box(100, 50, 20), [k.cylinder(5, 40, [50, 25, -10])]);

/** Project one body as item `body`. */
const one = (shape: ShapeId, view: ProjectView, options = {}) =>
  k.project([{ shape, key: 'body' }], view, options);

/** The 12 edges of an axis-aligned box, with the corner indices they join (bit 0 x, 1 y, 2 z). */
function boxEdges(min: Vec3, max: Vec3) {
  const c = (i: number): Vec3 => [
    i & 1 ? max[0] : min[0],
    i & 2 ? max[1] : min[1],
    i & 4 ? max[2] : min[2],
  ];
  const out: { a: Vec3; b: Vec3; corners: [number, number] }[] = [];
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4])
      if (!(i & bit)) out.push({ a: c(i), b: c(i | bit), corners: [i, i | bit] });
  }
  return out;
}

/** Each record's own geometry is consistent: its end points lie on it and arcs are well formed. */
function checkRecords(edges: readonly ProjectedEdge[]) {
  for (const e of edges) {
    const c = e.curve;
    if (c.kind === 'arc' || c.kind === 'ellipseArc') {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.start).toBeLessThan(2 * Math.PI);
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.end - c.start).toBeLessThanOrEqual(2 * Math.PI + 1e-9);
    }
    if (c.kind === 'ellipseArc') {
      expect(c.major).toBeGreaterThanOrEqual(c.minor);
      expect(c.rotation).toBeGreaterThan(-Math.PI - 1e-12);
      expect(c.rotation).toBeLessThanOrEqual(Math.PI);
    }
    for (const p of endsOf(c)) expect(distToPolys(p, [curvePoints(c)])).toBeLessThan(1e-6);
  }
}

// Box 100 x 50 x 20 with a 10 mm hole through Z at (50, 25).
//
// Front (looking +Y; paper x = X, y = Z): the 100 x 20 outline. Hidden: the hole's two silhouettes
// at X = 45 and 55. Its circles at Z = 0 and 20 project onto the outline (hidden under visible).
// Top: the outline and the hole's circle; the bottom circle is under it. Right (looking -X; paper
// x = -Y... see `viewFrame`): the 50 x 20 outline, hidden silhouettes at Y = 20 and 30. Isometric
// (viewer at (1, -1, 1)): the nine edges of the faces +X, -Y, +Z and the top circle are visible;
// the three edges at the far corner (0, 50, 0) are hidden; so are the bottom circle and both
// silhouettes of the hole wall.
const BOX: Record<keyof typeof VIEWS, ExpectedView> = (() => {
  const B = boxEdges([0, 0, 0], [100, 50, 20]);
  const sil = (x: number, y: number) => seg([x, y, 0], [x, y, 20]);
  const far = B.filter((e) => e.corners.includes(2));
  const nearEdges = B.filter((e) => !e.corners.includes(2));
  // Iso silhouettes of the hole: where the wall's radius is perpendicular to the horizontal view
  // direction (1, -1), at 45 and 225 degrees.
  const isoSil = [45, 225].map((deg) => {
    const t = (deg * Math.PI) / 180;
    const p: Vec3 = [50 + 5 * Math.cos(t), 25 + 5 * Math.sin(t), 0];
    return seg(p, [p[0], p[1], 20]);
  });
  const rect = (pts: Vec3[]) => pts.map((p, i) => seg(p, pts[(i + 1) % pts.length]!));
  return {
    front: {
      visible: rect([
        [0, 0, 0],
        [100, 0, 0],
        [100, 0, 20],
        [0, 0, 20],
      ]),
      hidden: [sil(45, 25), sil(55, 25)],
    },
    top: {
      visible: [
        ...rect([
          [0, 0, 20],
          [100, 0, 20],
          [100, 50, 20],
          [0, 50, 20],
        ]),
        arc3([50, 25, 20], 'z', 5),
      ],
      hidden: [],
    },
    right: {
      visible: rect([
        [100, 0, 0],
        [100, 50, 0],
        [100, 50, 20],
        [100, 0, 20],
      ]),
      hidden: [sil(50, 20), sil(50, 30)],
    },
    iso: {
      visible: [...nearEdges.map((e) => seg(e.a, e.b)), arc3([50, 25, 20], 'z', 5)],
      hidden: [...far.map((e) => seg(e.a, e.b)), arc3([50, 25, 0], 'z', 5), ...isoSil],
    },
  };
})();

// Cylinder r 20, h 50 about Z. Front and right: a 40 x 50 rectangle whose sides are silhouettes;
// the circles project onto its top and bottom (their back halves hidden under the front halves).
// Top: the circle. Isometric: the top circle, the front half of the bottom circle (-135 to 45
// degrees) and the silhouettes at 45 and 225 degrees are visible; the back half of the bottom
// circle is hidden.
const CYL: Record<keyof typeof VIEWS, ExpectedView> = (() => {
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
// Front: the L with the fillet arc, visible. Hidden per hole: the through hole's silhouettes, the
// counterbore's and its floor. Top: the 50 x 30 outline, the upright's inner top edge at X = 6,
// per hole the counterbore circle (r 4) and the through hole's circle at the floor (r 2.25); the
// fillet's tangent edge with the foot top (X = 10) is a visible smooth edge (the other one, at
// X = 6, projects onto the sharp edge there and HLR reports only that). Right: the 30 x 40 outline
// and the foot's top edge at Z = 6, the fillet's tangent edge at Z = 10 smooth; hidden: both holes
// (they coincide), the same five lines per hole as in front.
const M4 = holeSize('M4')!;
const D = M4.clearance.normal;
const CB_R = M4.counterbore.diameter / 2;
const FLOOR = 6 - M4.counterbore.depth;

function bracketFeatures(t: number): FeatureInput[] {
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
      diameter: D,
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

const BRACKET: Partial<Record<keyof typeof VIEWS, ExpectedView>> = (() => {
  const y0 = -15;
  const holeLines = (c: number, along: 'x' | 'y'): Vec3[][] => {
    const p = (s: number, z: number): Vec3 => (along === 'x' ? [c + s, y0, z] : [50, s, z]);
    return [
      seg(p(-D / 2, 0), p(-D / 2, FLOOR)),
      seg(p(D / 2, 0), p(D / 2, FLOOR)),
      seg(p(-CB_R, FLOOR), p(-CB_R, 6)),
      seg(p(CB_R, FLOOR), p(CB_R, 6)),
      seg(p(-CB_R, FLOOR), p(CB_R, FLOOR)),
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
        ...[25, 40].flatMap((c) => [arc3([c, 0, 6], 'z', CB_R), arc3([c, 0, FLOOR], 'z', D / 2)]),
      ],
      hidden: [],
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
      smooth: [seg([50, -15, 10], [50, 15, 10])],
    },
  };
})();

describe('views against views drawn by hand', () => {
  const cases: [string, () => ShapeId, Partial<Record<keyof typeof VIEWS, ExpectedView>>][] = [
    ['box with a hole', boxWithHole, BOX],
    ['cylinder', () => k.cylinder(20, 50), CYL],
    ['M1 bracket', () => build(k, bracketFeatures(6)).shape, BRACKET],
  ];
  for (const [name, make, views] of cases) {
    for (const [viewName, expected] of Object.entries(views)) {
      it(`${name}, ${viewName}`, () => {
        const body = make();
        const view = VIEWS[viewName as keyof typeof VIEWS];
        const r = one(body, view);
        const cmp = compareView(r.edges, view, expected!);
        expect(cmp.mismatches).toEqual([]);
        checkRecords(r.edges);
        expect(r.keys).toEqual(['body']);
        expect(r.edges.every((e) => e.item === 0)).toBe(true);
        expect(r.sections).toBeUndefined();
        k.release(body);
      });
    }
  }
});

const sweep = (edges: readonly ProjectedEdge[]) =>
  edges.reduce(
    (n, e) =>
      n +
      (e.curve.kind === 'line' || e.curve.kind === 'polyline' ? 0 : e.curve.end - e.curve.start),
    0,
  );

describe('curve records', () => {
  it('the box: lines and an exact circle in the top view, lines for the edge-on circles in front', () => {
    const body = boxWithHole();
    const top = one(body, VIEWS.top);
    const arcs = top.edges.filter((e) => e.curve.kind === 'arc' && e.visible);
    expect(arcs.length).toBeGreaterThan(0);
    for (const e of arcs) {
      const c = e.curve as Extract<Curve2, { kind: 'arc' }>;
      nearVec2(c.center, [50, 25]);
      near(c.radius, 5);
    }
    near(sweep(arcs), 2 * Math.PI);
    expect(
      top.edges.some((e) => e.curve.kind === 'polyline' || e.curve.kind === 'ellipseArc'),
    ).toBe(false);
    // Front: the hole's circles come back from HLR as B-splines on a line; they must be lines.
    const front = one(body, VIEWS.front);
    expect(front.edges.every((e) => e.curve.kind === 'line')).toBe(true);
    expect(front.bounds).toEqual({ min: [0, 0], max: [100, 20] });
    k.release(body);
  });

  it('the box isometric: the hole is elliptical arcs, semi-axes r and r / sqrt(3)', () => {
    const body = boxWithHole();
    const r = one(body, VIEWS.iso);
    const frame = viewFrame(VIEWS.iso);
    const ellipses = r.edges.filter((e) => e.curve.kind === 'ellipseArc');
    expect(r.edges.some((e) => e.curve.kind === 'arc' || e.curve.kind === 'polyline')).toBe(false);
    const top = projectPoint(frame, [50, 25, 20]);
    const visibleTop = ellipses.filter((e) => e.visible);
    expect(visibleTop.length).toBeGreaterThanOrEqual(1);
    for (const e of ellipses) {
      const c = e.curve as Extract<Curve2, { kind: 'ellipseArc' }>;
      near(c.major, 5);
      near(c.minor, 5 * S3);
      // The major axis is horizontal on paper: along the projection of (axis x view z).
      near(Math.abs(Math.sin(c.rotation)), 0);
    }
    for (const e of visibleTop) nearVec2((e.curve as { center: Vec2 }).center, top);
    // The whole top ellipse is drawn visible.
    near(sweep(visibleTop), 2 * Math.PI);
    k.release(body);
  });

  it('a board with 40 holes: 40 circles of radius 2.5 in the top view', () => {
    const tools: ShapeId[] = [];
    for (let i = 0; i < 40; i++) {
      tools.push(k.cylinder(2.5, 40, [50 + (i % 10) * 55, 40 + Math.floor(i / 10) * 60, -10]));
    }
    const board = cut(k.box(600, 300, 18), tools);
    const r = one(board, VIEWS.top);
    const byCentre = new Map<string, number>();
    for (const e of r.edges.filter((x) => x.visible && x.curve.kind === 'arc')) {
      const c = e.curve as Extract<Curve2, { kind: 'arc' }>;
      near(c.radius, 2.5);
      const key = `${c.center[0].toFixed(6)},${c.center[1].toFixed(6)}`;
      byCentre.set(key, (byCentre.get(key) ?? 0) + c.end - c.start);
    }
    expect(byCentre.size).toBe(40);
    for (const total of byCentre.values()) near(total, 2 * Math.PI);
    expect(r.bounds).toEqual({ min: [0, 0], max: [600, 300] });
    k.release(board);
  });

  it('bounds of arcs and ellipse arcs are exact', () => {
    const quarter: Curve2 = {
      kind: 'arc',
      center: [0, 0],
      radius: 2,
      start: 0.1,
      end: Math.PI / 2 + 0.2,
    };
    const b = boundsOf([quarter])!;
    near(b.max[1], 2);
    near(b.max[0], 2 * Math.cos(0.1));
    near(b.min[0], 2 * Math.cos(Math.PI / 2 + 0.2));
    const tilted: Curve2 = {
      kind: 'ellipseArc',
      center: [1, 1],
      major: 3,
      minor: 1,
      rotation: Math.PI / 4,
      start: 0,
      end: 2 * Math.PI,
    };
    const e = boundsOf([tilted])!;
    // Half-width of a rotated ellipse: sqrt(a^2 cos^2 + b^2 sin^2).
    const half = Math.sqrt((9 + 1) / 2);
    nearVec2(e.min, [1 - half, 1 - half]);
    nearVec2(e.max, [1 + half, 1 + half]);
    expect(boundsOf([])).toBeNull();
  });
});

describe('several items', () => {
  // A bookshelf side, 18 thick along X, 300 deep, 900 high, with a 6 x 6 rabbet at the back
  // (X 12 to 18, Y 294 to 300); a 6 mm back from X 12 to 412 sits in it, from Z 50 to 900.
  //
  // Front view (paper x = X, y = Z): the side's outline is visible; the back's visible part is
  // X 18 to 412. Its left edge at X = 12, the bottom from 12 to 18 and the rabbet's edges at
  // X = 12 are behind the side's front face, so hidden. The poly algorithm draws them visible
  // (T4.4a): this is the case that rules it out.
  const sideAndBack = () => {
    const side = cut(k.box(18, 300, 900), [k.box(6, 6, 900, [12, 294, 0])]);
    const back = k.box(400, 6, 850, [12, 294, 50]);
    return { side, back };
  };
  const CONTACT: ExpectedView = {
    visible: [
      seg([0, 0, 0], [18, 0, 0]),
      seg([18, 0, 0], [18, 0, 900]),
      seg([18, 0, 900], [0, 0, 900]),
      seg([0, 0, 900], [0, 0, 0]),
      seg([18, 294, 50], [412, 294, 50]),
      seg([412, 294, 50], [412, 294, 900]),
      seg([412, 294, 900], [18, 294, 900]),
    ],
    hidden: [seg([12, 0, 0], [12, 0, 900]), seg([12, 294, 50], [18, 294, 50])],
  };

  it('touching boards: no hidden edge is drawn visible (side and back in its rabbet)', () => {
    const { side, back } = sideAndBack();
    const r = k.project(
      [
        { shape: side, key: 'side' },
        { shape: back, key: 'back' },
      ],
      VIEWS.front,
    );
    expect(compareView(r.edges, VIEWS.front, CONTACT).mismatches).toEqual([]);
    // Nothing visible on X = 12 at all, from either board.
    const onX12 = r.edges.filter(
      (e) => e.visible && curvePoints(e.curve).every((p) => Math.abs(p[0] - 12) < 1e-6),
    );
    expect(onX12).toEqual([]);
    // Per item: the back's left edge is the back's, hidden; the side never draws X > 18.
    expect(r.keys).toEqual(['side', 'back']);
    const back12 = r.edges.filter(
      (e) => e.item === 1 && curvePoints(e.curve).every((p) => Math.abs(p[0] - 12) < 1e-6),
    );
    expect(back12.length).toBeGreaterThan(0);
    expect(back12.every((e) => !e.visible)).toBe(true);
    for (const e of r.edges.filter((x) => x.item === 0)) {
      for (const p of curvePoints(e.curve)) expect(p[0]).toBeLessThanOrEqual(18 + 1e-9);
    }
    expect(r.bounds).toEqual({ min: [0, 0], max: [412, 900] });
    k.release(side);
    k.release(back);
  });

  it('per-item layers from one run add up to the whole view, and occlusion crosses items', () => {
    const { side, back } = sideAndBack();
    const both = k.project(
      [
        { shape: side, key: 'side' },
        { shape: back, key: 'back' },
      ],
      VIEWS.front,
    );
    // The back alone draws its left edge visible; with the side in front, the same edge is hidden.
    const alone = one(back, VIEWS.front);
    const visibleAt12 = (r: ProjectResult) =>
      r.edges.some(
        (e) => e.visible && curvePoints(e.curve).every((p) => Math.abs(p[0] - 12) < 1e-6),
      );
    expect(visibleAt12(alone)).toBe(true);
    expect(visibleAt12(both)).toBe(false);
    // Order of items does not change the result, only the item indices.
    const swapped = k.project(
      [
        { shape: back, key: 'back' },
        { shape: side, key: 'side' },
      ],
      VIEWS.front,
    );
    const describe = (r: ProjectResult, keyOf: (i: number) => string) =>
      r.edges
        .map((e) => `${keyOf(e.item)} ${e.cls} ${e.visible} ${JSON.stringify(e.curve)}`)
        .sort();
    expect(describe(swapped, (i) => swapped.keys[i]!)).toEqual(
      describe(both, (i) => both.keys[i]!),
    );
    k.release(side);
    k.release(back);
  });

  it('a placed item equals the body moved there, and lands where the pose puts it', () => {
    const body = boxWithHole();
    // A quarter turn about Z, then 200 along X: (x, y, z) -> (200 - y, x, z).
    const pose: Placement = {
      translation: [200, 0, 0],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    };
    const placedView = k.project([{ shape: body, key: 'turned', transform: pose }], VIEWS.top);
    expect(placedView.bounds).toEqual({ min: [150, 0], max: [200, 100] });
    const hole = placedView.edges.filter((e) => e.curve.kind === 'arc');
    expect(hole.length).toBeGreaterThan(0);
    for (const e of hole) nearVec2((e.curve as { center: Vec2 }).center, [175, 50]);
    // The same as a copy turned and moved by the kernel, in every view, within 1e-6 mm.
    const moved = k.transform(
      k.transform(body, {
        kind: 'rotate',
        axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
        angle: Math.PI / 2,
      }).shape,
      { kind: 'translate', vector: [200, 0, 0] },
    ).shape;
    for (const view of Object.values(VIEWS)) {
      const a = k.project([{ shape: body, key: 'b', transform: pose }], view);
      const b = one(moved, view);
      const pa = a.edges.filter((e) => e.visible).map((e) => curvePoints(e.curve));
      const pb = b.edges.filter((e) => e.visible).map((e) => curvePoints(e.curve));
      for (const poly of pa) for (const p of poly) expect(distToPolys(p, pb)).toBeLessThan(1e-6);
      for (const poly of pb) for (const p of poly) expect(distToPolys(p, pa)).toBeLessThan(1e-6);
    }
    // Two instances of one body, one in front of the other: the front one hides the back one.
    const pair = k.project(
      [
        { shape: body, key: 'front' },
        {
          shape: body,
          key: 'behind',
          transform: { translation: [20, 100, 5], rotation: [0, 0, 0, 1] },
        },
      ],
      VIEWS.front,
    );
    const behindVisible = pair.edges
      .filter((e) => e.item === 1 && e.visible)
      .flatMap((e) => curvePoints(e.curve));
    // Only what shows above Z = 20 or right of X = 100 is visible on the back instance.
    for (const p of behindVisible) expect(p[1] >= 20 - 1e-9 || p[0] >= 100 - 1e-9).toBe(true);
    expect(behindVisible.length).toBeGreaterThan(0);
    k.release(body);
    k.release(moved);
  });
});

describe('sections', () => {
  const loopClosed = (loop: readonly Curve2[]) => {
    // Each curve meets the next at one of its ends, and the last meets the first.
    for (let i = 0; i < loop.length; i++) {
      const a = endsOf(loop[i]!);
      const b = endsOf(loop[(i + 1) % loop.length]!);
      const d = Math.min(...a.flatMap((p) => b.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));
      expect(d).toBeLessThan(1e-6);
    }
  };
  const area = (faces: readonly SectionFace[]) => faces.reduce((n, f) => n + f.area, 0);

  it('the M1 bracket cut at Y = 0, seen from the front: three faces of the hand-computed area', () => {
    const body = build(k, bracketFeatures(6)).shape;
    const r = k.project([{ shape: body, key: 'bracket' }], VIEWS.front, {
      section: { origin: [0, 0, 0], normal: [0, 1, 0] },
    });
    expect(r.sections).toHaveLength(1);
    const faces = r.sections![0]!.faces;
    expect(r.sections![0]!.item).toBe(0);
    // The L (50 x 6 + 6 x 34 = 504) plus the fillet's corner (16 (1 - pi / 4)), less per hole the
    // through hole (4.5 x 1.6) and the counterbore (8 x 4.4); the holes split the foot in three.
    expect(faces).toHaveLength(3);
    const cb = M4.counterbore;
    near(
      area(faces),
      504 + 16 * (1 - Math.PI / 4) - 2 * (D * (6 - cb.depth) + cb.diameter * cb.depth),
      1e-6,
    );
    const visible = r.edges
      .filter((e) => e.visible && e.cls === 'sharp')
      .map((e) => curvePoints(e.curve));
    for (const f of faces) {
      expect(f.holes).toEqual([]);
      loopClosed(f.outer);
      // Every section edge is drawn visible.
      for (const c of f.outer)
        for (const p of curvePoints(c)) expect(distToPolys(p, visible)).toBeLessThan(1e-6);
    }
    // The fillet's arc in the section is an exact arc of radius 4 about (10, 10).
    const arcs = faces.flatMap((f) => f.outer).filter((c) => c.kind === 'arc');
    expect(arcs).toHaveLength(1);
    nearVec2((arcs[0] as { center: Vec2 }).center, [10, 10]);
    near((arcs[0] as { radius: number }).radius, 4);
    // The part in front of the plane is gone: nothing at Y < 0 is drawn (front view: the outline
    // is that of the cut body, 50 x 40, unchanged here since the section is mid-depth).
    expect(r.bounds).toEqual({ min: [0, 0], max: [50, 40] });
    k.release(body);
  });

  it('a box with a hole cut at Z = 10, seen from the top: a face with a round hole', () => {
    const body = boxWithHole();
    // Looking down -Z, keep what is below the plane: the normal is the view direction.
    const r = one(body, VIEWS.top, { section: { origin: [0, 0, 10], normal: [0, 0, -1] } });
    const faces = r.sections![0]!.faces;
    expect(faces).toHaveLength(1);
    const f = faces[0]!;
    near(f.area, 5000 - 25 * Math.PI, 1e-6);
    expect(f.outer.map((c) => c.kind)).toEqual(['line', 'line', 'line', 'line']);
    loopClosed(f.outer);
    expect(f.holes).toHaveLength(1);
    loopClosed(f.holes[0]!);
    for (const c of f.holes[0]!) {
      expect(c.kind).toBe('arc');
      nearVec2((c as { center: Vec2 }).center, [50, 25]);
      near((c as { radius: number }).radius, 5);
    }
    near(
      f.holes[0]!.reduce(
        (n, c) => n + (c as { end: number; start: number }).end - (c as { start: number }).start,
        0,
      ),
      2 * Math.PI,
    );
    k.release(body);
  });

  it('a box with a hole cut through the hole at Y = 25: two faces, the material behind kept', () => {
    const body = boxWithHole();
    const r = one(body, VIEWS.front, { section: { origin: [0, 25, 0], normal: [0, 1, 0] } });
    const faces = r.sections![0]!.faces;
    expect(faces).toHaveLength(2);
    near(area(faces), 2 * 45 * 20, 1e-6);
    for (const f of faces) {
      expect(f.outer).toHaveLength(4);
      loopClosed(f.outer);
    }
    // The cut body is Y 25 to 50: the hole's silhouettes at X = 45 and 55 are section edges, so
    // visible; what is left hidden (the half wall's back, its half circles) lies under them.
    const visible = r.edges.filter((e) => e.visible).map((e) => curvePoints(e.curve));
    for (const x of [45, 55]) {
      expect(distToPolys([x, 10], visible)).toBeLessThan(1e-9);
    }
    for (const e of r.edges.filter((x) => !x.visible)) {
      for (const p of curvePoints(e.curve)) expect(distToPolys(p, visible)).toBeLessThan(1e-6);
    }
    k.release(body);
  });

  it('a plane that misses an item keeps it whole; one that removes it leaves nothing', () => {
    const body = boxWithHole();
    const plain = one(body, VIEWS.top);
    const missed = one(body, VIEWS.top, { section: { origin: [0, 0, 100], normal: [0, 0, -1] } });
    expect(missed.sections).toEqual([{ item: 0, faces: [] }]);
    expect(missed.edges.length).toBe(plain.edges.length);
    expect(missed.bounds).toEqual(plain.bounds);
    const gone = k.project(
      [
        { shape: body, key: 'a' },
        { shape: body, key: 'b', transform: { translation: [0, 0, 200], rotation: [0, 0, 0, 1] } },
      ],
      VIEWS.top,
      { section: { origin: [0, 0, 100], normal: [0, 0, 1] } },
    );
    // Keeps Z >= 100: item a is gone entirely, item b is whole.
    expect(gone.sections).toEqual([
      { item: 0, faces: [] },
      { item: 1, faces: [] },
    ]);
    expect(gone.edges.every((e) => e.item === 1)).toBe(true);
    expect(gone.edges.length).toBe(plain.edges.length);
    k.release(body);
  });
});

describe('options', () => {
  it('hidden: false drops hidden edges; smooth: false drops tangent edges; sewn: true adds seams', () => {
    const bracket = build(k, bracketFeatures(6)).shape;
    const all = one(bracket, VIEWS.right);
    expect(all.edges.some((e) => !e.visible)).toBe(true);
    expect(all.edges.some((e) => e.cls === 'smooth')).toBe(true);
    expect(all.edges.some((e) => e.cls === 'sewn')).toBe(false);
    const visibleOnly = one(bracket, VIEWS.right, { hidden: false });
    expect(visibleOnly.edges.every((e) => e.visible)).toBe(true);
    expect(visibleOnly.edges).toEqual(all.edges.filter((e) => e.visible));
    const noSmooth = one(bracket, VIEWS.right, { smooth: false });
    expect(noSmooth.edges).toEqual(all.edges.filter((e) => e.cls !== 'smooth'));
    // The cylinder seen from the right: one visible seam down the middle (T4.4a).
    const cyl = k.cylinder(20, 50);
    const seams = one(cyl, VIEWS.right, { sewn: true }).edges.filter((e) => e.cls === 'sewn');
    expect(seams.length).toBeGreaterThan(0);
    for (const e of seams) {
      expect(e.visible).toBe(true);
      for (const p of curvePoints(e.curve)) near(p[0], 0);
    }
    k.release(bracket);
    k.release(cyl);
  });

  it('freeform silhouettes are polylines within the deflection', () => {
    // A vase: a cubic Bezier revolved about Z, so its faces and silhouettes are B-splines.
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
    const vase = k.revolve(p, { origin: [0, 0, 0], direction: [0, 0, 1] }, 2 * Math.PI).shape;
    const points = (deflection: number) =>
      one(vase, VIEWS.front, { deflection })
        .edges.filter((e) => e.curve.kind === 'polyline')
        .reduce((n, e) => n + (e.curve as { points: Vec2[] }).points.length, 0);
    const fine = points(0.005);
    const coarse = points(0.5);
    expect(coarse).toBeGreaterThan(0);
    expect(fine).toBeGreaterThan(coarse);
    // The silhouette's widest point: the Bezier's maximum radius, on both sides.
    const r = one(vase, VIEWS.front, { deflection: 0.005 });
    let widest = 0;
    for (let i = 0; i <= 10000; i++) {
      const t = i / 10000;
      const u = 1 - t;
      widest = Math.max(widest, u ** 3 * 30 + 3 * u * u * t * 60 + 3 * u * t * t * 5 + t ** 3 * 20);
    }
    near(r.bounds!.max[0], widest, 0.01);
    near(r.bounds!.min[0], -widest, 0.01);
    k.release(p);
    k.release(vase);
  });
});

describe('the view frame', () => {
  it('viewFrame and projectPoint agree with HLR output and with HLRAlgo_Projector', () => {
    const body = k.box(100, 50, 20);
    const oc = k.oc;
    const views: ProjectView[] = [
      ...Object.values(VIEWS),
      { direction: [0.3, 0.8, -0.5], up: [0.1, 0, 1], origin: [10, -20, 5] },
    ];
    for (const view of views) {
      const frame = viewFrame(view);
      const ends = one(body, view)
        .edges.filter((e) => e.curve.kind === 'line')
        .flatMap((e) => endsOf(e.curve));
      const ax = new oc.gp_Ax2(
        new oc.gp_Pnt(...frame.origin),
        new oc.gp_Dir(...frame.z),
        new oc.gp_Dir(...frame.x),
      );
      const projector = new oc.HLRAlgo_Projector(ax);
      for (const e of boxEdges([0, 0, 0], [100, 50, 20])) {
        const ours = projectPoint(frame, e.a);
        // Every visible box corner is an end of an HLR line (hidden ones too, for a box)...
        expect(
          Math.min(...ends.map((p) => Math.hypot(p[0] - ours[0], p[1] - ours[1]))),
        ).toBeLessThan(1e-9);
        // ... and OCCT's projector puts it at the same place, less the frame's origin:
        // `HLRAlgo_Projector.Project` ignores the origin (measured), the HLR run does not.
        const out = new oc.gp_Pnt2d(0, 0);
        const pnt = new oc.gp_Pnt(...e.a);
        projector.Project(pnt, out);
        const shift = projectPoint(frame, [0, 0, 0]);
        expect(Math.hypot(out.X() + shift[0] - ours[0], out.Y() + shift[1] - ours[1])).toBeLessThan(
          1e-9,
        );
        out.delete();
        pnt.delete();
      }
      projector.delete();
      ax.delete();
    }
    // The frame is right-handed and orthonormal, z toward the viewer.
    const f = viewFrame(views.at(-1)!);
    const d = Math.hypot(0.3, 0.8, 0.5);
    near(f.z[0], -0.3 / d);
    near(f.z[1], -0.8 / d);
    near(f.z[2], 0.5 / d);
    k.release(body);
  });
});

describe('errors', () => {
  it('refuses bad arguments with invalid-argument, unknown shapes with unknown-shape', () => {
    const body = k.box(10, 10, 10);
    const item = { shape: body, key: 'a' };
    const refused: [string, () => unknown, RegExp][] = [
      [
        'a zero direction',
        () => k.project([item], { direction: [0, 0, 0], up: [0, 0, 1] }),
        /direction is a zero/,
      ],
      [
        'a zero up',
        () => k.project([item], { direction: [0, 1, 0], up: [0, 0, 0] }),
        /up is a zero/,
      ],
      [
        'up parallel to the direction',
        () => k.project([item], { direction: [0, 1, 0], up: [0, -2, 0] }),
        /parallel/,
      ],
      [
        'a NaN in the view',
        () => k.project([item], { direction: [0, 1, Number.NaN], up: [0, 0, 1] }),
        /finite/,
      ],
      [
        'a repeated key',
        () => k.project([item, { shape: body, key: 'a' }], VIEWS.front),
        /repeated/,
      ],
      [
        'a zero quaternion',
        () =>
          k.project(
            [{ ...item, transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 0] } }],
            VIEWS.front,
          ),
        /items\[0\]\.transform\.rotation is a zero quaternion/,
      ],
      ['a zero deflection', () => k.project([item], VIEWS.front, { deflection: 0 }), /deflection/],
      [
        'a zero section normal',
        () => k.project([item], VIEWS.front, { section: { origin: [0, 0, 0], normal: [0, 0, 0] } }),
        /section\.normal/,
      ],
    ];
    for (const [name, fn, message] of refused) {
      let error: unknown = null;
      try {
        fn();
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(KernelError);
      expect((error as KernelError).code, name).toBe('invalid-argument');
      expect((error as KernelError).operation, name).toBe('project');
      expect((error as KernelError).message, name).toMatch(message);
    }
    expect(() => k.project([{ shape: 999_999 as ShapeId, key: 'x' }], VIEWS.front)).toThrow(
      /unknown shape/,
    );
    k.release(body);
  });

  it('no items: an empty view', () => {
    expect(k.project([], VIEWS.front)).toEqual({ keys: [], edges: [], bounds: null });
    expect(
      k.project([], VIEWS.front, { section: { origin: [0, 0, 0], normal: [0, 1, 0] } }),
    ).toEqual({
      keys: [],
      edges: [],
      bounds: null,
      sections: [],
    });
  });
});

describe('the project op', () => {
  it('runs through the service on shapes made earlier in the batch', async () => {
    const service = await createNodeService();
    const reply = await service.run({
      generation: 1,
      ops: [
        { op: 'box', size: [100, 50, 20], keep: false },
        { op: 'cylinder', radius: 5, height: 40, at: [50, 25, -10], keep: false },
        { op: 'boolean', kind: 'cut', shape: { result: 0 }, tools: [{ result: 1 }], keep: false },
        {
          op: 'project',
          items: [{ shape: { result: 2 }, key: 'block' }],
          view: { direction: [0, 0, -1], up: [0, 1, 0] },
          hidden: false,
          section: { origin: [0, 0, 10], normal: [0, 0, -1] },
        },
        {
          op: 'project',
          items: [{ shape: { result: 2 }, key: 'k' }],
          view: { direction: [0, 0, 1], up: [0, 0, 2] },
        },
        { op: 'project', items: [{ shape: { result: 2 } }], view: VIEWS.front } as never,
      ],
    });
    expect(reply.status).toBe('done');
    const ok = reply.results[3]!;
    expect(ok.ok).toBe(true);
    const value = (ok as { value: ProjectResult }).value;
    expect(value.keys).toEqual(['block']);
    expect(value.bounds).toEqual({ min: [0, 0], max: [100, 50] });
    near(value.sections![0]!.faces[0]!.area, 5000 - 25 * Math.PI, 1e-6);
    const parallel = reply.results[4]!;
    expect(parallel.ok).toBe(false);
    expect((parallel as { error: { code: string } }).error.code).toBe('invalid-argument');
    const malformed = reply.results[5]!;
    expect(malformed.ok).toBe(false);
    expect((malformed as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'invalid-op',
      message: expect.stringMatching(/key must be a string/),
    });
  });
});
