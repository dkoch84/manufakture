// Golden tests for profiles of several regions and Bezier edges (M3 plan, T3.2a), through the
// extrude and revolve features:
//
// - two separate rectangles in one extrude: the summed volume, both sets of named sides, caps
//   numbered by region (`cap:start#k`) in an order that does not depend on the input order;
// - a ring (a region with a hole) plus a disk inside its hole, apart and touching;
// - overlapping regions (glyphs that touch after kerning) fuse into one clean solid;
// - Bezier-bounded regions whose volumes match the analytic area of the curve times the depth;
// - a revolve of two regions, partial and full;
// - a draft across touching and separate regions, applied once after they are joined, and
//   separate regions a draft grows into each other, fused into one solid;
// - an `add` of several regions to a body (one on it, one beside it); what many regions cost.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyFeature,
  type ExtrudeInput,
  type FeatureOutcome,
  type RevolveInput,
  type SketchProfile,
} from '../src/features';
import { XY, circle, rectangle } from '../src/fixtures/parts';
import type { Kernel } from '../src/kernel';
import type { FaceName } from '../src/naming';
import { createNodeKernel } from '../src/node';
import type { ProfileEntity, ProfileLoop, Vec2, Vec3 } from '../src/types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const ids = (prefix: string) => [1, 2, 3, 4].map((i) => `${prefix}${i}`);

/** A profile of several regions on `XY`, each given as its loops (outer first). */
function regions(...rs: ProfileEntity[][][]): SketchProfile {
  return {
    frame: XY,
    regions: rs.map((loops) => ({
      loops: loops.map((entities): ProfileLoop => ({ entities })),
    })),
  };
}

function extrude(profile: SketchProfile, distance: number, extra: Partial<ExtrudeInput> = {}) {
  return applyFeature(k, [], {
    kind: 'extrude',
    id: 'extrude#1',
    mode: 'new',
    profile,
    extent: { type: 'blind', distance },
    ...extra,
  });
}

/** The one body of an outcome, its names, topology and properties; released by `done`. */
function only(out: FeatureOutcome) {
  expect(out.errors).toEqual([]);
  expect(out.bodies).toHaveLength(1);
  const body = out.bodies[0]!;
  const names = body.names!.faces;
  const topology = k.topology(body.shape);
  const props = k.properties(body.shape);
  const byName = (name: string) => {
    const i = names.findIndex((f) => f.name === name);
    expect(i, name).toBeGreaterThanOrEqual(0);
    return topology.faces[i]!;
  };
  return { body, names, topology, props, byName, done: () => k.release(body.shape) };
}

function sorted(names: readonly FaceName[]): string[] {
  return names.map((f) => f.name).sort();
}

/** A closed loop of one Bezier and the straight line back to its start. */
function bezierLoop(points: Vec2[], id = 'b1', line = 'l1'): ProfileEntity[] {
  return [
    { kind: 'bezier', id, points },
    { kind: 'line', id: line, start: points[points.length - 1]!, end: points[0]! },
  ];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('several regions in one extrude', () => {
  it('two separate rectangles: summed volume, two sets of sides, numbered caps', () => {
    const a = rectangle(0, 0, 10, 5, ids('a'));
    const b = rectangle(20, 0, 23, 4, ids('b'));
    // Given b first: the caps are numbered by edge id, so a's are still #1.
    const r = only(extrude(regions([b], [a]), 2));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.props.volume).toBeCloseTo((50 + 12) * 2, 9);
      expect(r.body.solids).toBe(2);
      expect(sorted(r.names)).toEqual(
        [
          ...ids('a').map((id) => `extrude#1:side:${id}`),
          ...ids('b').map((id) => `extrude#1:side:${id}`),
          'extrude#1:cap:start#1',
          'extrude#1:cap:start#2',
          'extrude#1:cap:end#1',
          'extrude#1:cap:end#2',
        ].sort(),
      );
      // Region 1 is the rectangle with the `a` edges, at x 0 to 10.
      expect(r.byName('extrude#1:cap:end#1').centroid).toEqual([
        expect.closeTo(5, 9),
        expect.closeTo(2.5, 9),
        expect.closeTo(2, 9),
      ]);
      expect(r.byName('extrude#1:cap:start#2').centroid[0]).toBeCloseTo(21.5, 9);
      // Cap pieces descend from the plain cap name and are positional.
      const cap = r.names.find((f) => f.name === 'extrude#1:cap:end#2')!;
      expect(cap.lineage).toEqual(['extrude#1:cap:end#2', 'extrude#1:cap:end']);
      expect(cap.fragile).toBe(true);
      // Sides of each rectangle are where its edges are.
      expect(r.byName('extrude#1:side:b2').centroid[0]).toBeCloseTo(23, 9);
      expect(r.byName('extrude#1:side:a4').centroid[0]).toBeCloseTo(0, 9);
    } finally {
      r.done();
    }
  });

  it('names do not depend on the order the regions are given in', () => {
    const a = rectangle(0, 0, 10, 5, ids('a'));
    const b = [rectangle(20, 0, 23, 4, ids('b'))];
    const c = [circle([40, 0], 2, 'c1')];
    const one = only(extrude(regions([a], b, c), 2));
    const two = only(extrude(regions(c, b, [a]), 2));
    try {
      const at = (r: typeof one) =>
        Object.fromEntries(r.names.map((f, i) => [f.name, r.topology.faces[i]!.centroid]));
      const p = at(one);
      const q = at(two);
      expect(Object.keys(q).sort()).toEqual(Object.keys(p).sort());
      for (const name of Object.keys(p)) {
        expect(Math.hypot(...sub(p[name]!, q[name]!)), name).toBeLessThan(1e-9);
      }
    } finally {
      one.done();
      two.done();
    }
  });

  it('a ring and a disk apart inside its hole', () => {
    const ring = [circle([0, 0], 10, 'c1'), circle([0, 0], 6, 'c2')];
    const disk = [circle([0, 0], 4, 'c3')];
    const r = only(extrude(regions(ring, disk), 3));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.props.volume / (Math.PI * (100 - 36 + 16) * 3)).toBeCloseTo(1, 9);
      expect(r.body.solids).toBe(2);
      // The ring's outer loop (c1) sorts before the disk's (c3): it is region 1.
      expect(sorted(r.names)).toEqual(
        [
          'extrude#1:cap:end#1',
          'extrude#1:cap:end#2',
          'extrude#1:cap:start#1',
          'extrude#1:cap:start#2',
          'extrude#1:side:c1',
          'extrude#1:side:c2',
          'extrude#1:side:c3',
        ].sort(),
      );
      expect(r.byName('extrude#1:cap:end#1').area).toBeCloseTo(Math.PI * 64, 6);
      expect(r.byName('extrude#1:cap:end#2').area).toBeCloseTo(Math.PI * 16, 6);
    } finally {
      r.done();
    }
  });

  it('a ring and the disk that fills its hole fuse into one cylinder', () => {
    // Adjacent regions share the edge between them (c2), as sketch regions do.
    const ring = [circle([0, 0], 10, 'c1'), circle([0, 0], 6, 'c2')];
    const disk = [circle([0, 0], 6, 'c2')];
    const r = only(extrude(regions(ring, disk), 3));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.props.volume / (Math.PI * 100 * 3)).toBeCloseTo(1, 9);
      expect(r.body.solids).toBe(1);
      // The shared side is gone; the caps of both regions are unified into one face each.
      expect(sorted(r.names)).toEqual([
        '(extrude#1:cap:end#1+extrude#1:cap:end#2)',
        '(extrude#1:cap:start#1+extrude#1:cap:start#2)',
        'extrude#1:side:c1',
      ]);
    } finally {
      r.done();
    }
  });

  it('overlapping regions fuse into one valid solid', () => {
    // Two "glyphs" that overlap after kerning, and a third apart.
    const a = rectangle(0, 0, 4, 10, ids('a'));
    const b = rectangle(3, 2, 8, 6, ids('b'));
    const c = rectangle(20, 0, 22, 2, ids('c'));
    const r = only(extrude(regions([a], [b], [c]), 1.5));
    try {
      expect(r.props.valid).toBe(true);
      const area = 40 + 20 - 4 + 4;
      expect(r.props.volume / (area * 1.5)).toBeCloseTo(1, 9);
      expect(r.body.solids).toBe(2);
      // Every face is named; no placeholder survives.
      expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
      // One top face for the fused pair, one for the separate rectangle.
      const tops = r.topology.faces.filter(
        (f) => f.surface === 'plane' && Math.abs(f.centroid[2] - 1.5) < 1e-9,
      );
      expect(tops).toHaveLength(2);
      expect(r.byName('(extrude#1:cap:end#1+extrude#1:cap:end#2)').area).toBeCloseTo(56, 6);
      expect(r.byName('extrude#1:cap:end#3').area).toBeCloseTo(4, 6);
    } finally {
      r.done();
    }
  });

  it('adds several regions to a body', () => {
    const base = applyFeature(k, [], {
      kind: 'extrude',
      id: 'extrude#1',
      mode: 'new',
      profile: { frame: XY, loops: [{ entities: rectangle(0, 0, 30, 10) }] },
      extent: { type: 'blind', distance: 2 },
    });
    expect(base.errors).toEqual([]);
    const top = { ...XY, origin: [0, 0, 2] as Vec3 };
    const out = applyFeature(k, [{ id: base.bodies[0]!.id, shape: base.bodies[0]!.shape }], {
      kind: 'extrude',
      id: 'extrude#2',
      mode: 'add',
      profile: {
        frame: top,
        regions: [
          { loops: [{ entities: rectangle(2, 2, 6, 8, ids('a')) }] },
          { loops: [{ entities: circle([20, 5], 3, 'c1') }] },
        ],
      },
      extent: { type: 'blind', distance: 1 },
    });
    const r = only(out);
    try {
      expect(r.props.valid).toBe(true);
      expect(r.props.volume).toBeCloseTo(600 + 24 + Math.PI * 9, 6);
      expect(r.body.solids).toBe(1);
      expect(r.byName('extrude#2:cap:end#1').area).toBeCloseTo(24, 6);
      expect(r.byName('extrude#2:cap:end#2').area).toBeCloseTo(Math.PI * 9, 6);
      expect(r.byName('extrude#2:side:c1').surface).toBe('cylinder');
    } finally {
      r.done();
      k.release(base.bodies[0]!.shape);
    }
  });
});

describe('draft with several regions', () => {
  // Drafted once after the regions are joined, so the side two adjacent regions share is gone
  // before anything tilts. A positive draft leans the sides in by h tan(angle) at the far cap.
  const angle = 0.05;
  const h = 2;
  const t = h * Math.tan(angle);
  /** A prismatoid of the given cross-section area at an inward offset: h/6 (A0 + A1 + 4 Am). */
  const prismatoid = (area: (s: number) => number) =>
    (h / 6) * (area(0) + area(t) + 4 * area(t / 2));
  const rect = (w: number, d: number) => (s: number) => (w - 2 * s) * (d - 2 * s);

  it('two adjacent rectangles: one tapered block, no groove along the shared edge', () => {
    // Two 4 x 4 squares sharing their middle edge a2, as a sketch gives adjacent regions.
    const a = rectangle(0, 0, 4, 4, ids('a'));
    const b = rectangle(4, 0, 8, 4, ['b1', 'b2', 'b3', 'a2']);
    const r = only(extrude(regions([a], [b]), h, { draft: angle }));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(1);
      expect(r.props.volume / prismatoid(rect(8, 4))).toBeCloseTo(1, 9);
      expect(r.names.some((f) => f.name.includes('side:a2'))).toBe(false);
      expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
      // Six faces: the caps, the two ends and the two long sides, each across both regions.
      expect(r.topology.faces).toHaveLength(6);
      expect(r.byName('(extrude#1:side:a1+extrude#1:side:b1)').centroid[1]).toBeGreaterThan(
        0.4 * t,
      );
    } finally {
      r.done();
    }
  });

  it('a ring and the disk filling its hole: one cone frustum', () => {
    const ring = [circle([0, 0], 10, 'c1'), circle([0, 0], 6, 'c2')];
    const disk = [circle([0, 0], 6, 'c2')];
    const r = only(extrude(regions(ring, disk), h, { draft: angle }));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(1);
      const disc = (s: number) => Math.PI * (10 - s) ** 2;
      expect(r.props.volume / prismatoid(disc)).toBeCloseTo(1, 6);
      expect(r.names.some((f) => f.name.includes('side:c2'))).toBe(false);
      expect(r.byName('extrude#1:side:c1').surface).toBe('cone');
    } finally {
      r.done();
    }
  });

  it('overlapping regions: the outline of their union tapers', () => {
    // The union of the two is an eight-sided rectilinear outline: area 56, perimeter 36, and
    // offset in by s its area is 56 - 36 s + 4 s^2 (six convex corners less two reflex ones).
    const a = rectangle(0, 0, 4, 10, ids('a'));
    const b = rectangle(3, 2, 8, 6, ids('b'));
    const r = only(extrude(regions([a], [b]), h, { draft: angle }));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(1);
      expect(r.props.volume / prismatoid((s) => 56 - 36 * s + 4 * s * s)).toBeCloseTo(1, 9);
      expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
    } finally {
      r.done();
    }
  });

  it('separate regions: each tapers on its own', () => {
    const a = rectangle(0, 0, 4, 4, ids('a'));
    const b = rectangle(10, 0, 16, 3, ids('b'));
    const r = only(extrude(regions([a], [b]), h, { draft: angle }));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(2);
      expect(r.props.volume / (prismatoid(rect(4, 4)) + prismatoid(rect(6, 3)))).toBeCloseTo(1, 9);
      for (const id of [...ids('a'), ...ids('b')]) r.byName(`extrude#1:side:${id}`);
    } finally {
      r.done();
    }
  });

  // Two 4 x 4 squares a gap g apart in x, drafted so their facing sides lean toward each other
  // by s(z) = z tan(angle) at a distance z from the neutral plane. Past z0 = g / (2 tan) they
  // overlap in a slab (2 s - g) wide in x and (4 + 2 s) deep in y. With u = 2 s - g the overlap
  // is the integral of u (4 + g + u) du / (2 tan) from 0 to U = 2 h tan - g.
  const g = 0.1;
  const overlap = (depth: number) => {
    const u = 2 * depth * Math.tan(angle) - g;
    return ((4 + g) * u * u) / 2 / (2 * Math.tan(angle)) + (u * u * u) / 3 / (2 * Math.tan(angle));
  };
  /** A square's frustum over `depth` whose sides lean out (sign -1) or in (+1) by z tan(angle). */
  const frustum = (depth: number, sign: number) => {
    const s = (z: number) => -sign * z * Math.tan(angle);
    const side = (z: number) => 4 + 2 * s(z);
    return (depth / 6) * (side(0) ** 2 + side(depth) ** 2 + 4 * side(depth / 2) ** 2);
  };
  const squares = () =>
    regions([rectangle(0, 0, 4, 4, ids('a'))], [rectangle(4 + g, 0, 8 + g, 4, ids('b'))]);

  it('a negative draft grows separate regions into each other: they fuse', () => {
    expect(overlap(h)).toBeGreaterThan(0); // the test is about squares that do meet
    const r = only(extrude(squares(), h, { draft: -angle }));
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(1);
      expect(r.props.volume / (2 * frustum(h, -1) - overlap(h))).toBeCloseTo(1, 9);
      expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
      // The facing sides are cut back to where they meet; the far ends keep their names.
      r.byName('extrude#1:side:a4');
      r.byName('extrude#1:side:b2');
    } finally {
      r.done();
    }
  });

  it('a symmetric extent: the half below the sketch plane grows the regions together', () => {
    // Positive draft about the sketch plane: the top half leans in and stays apart, the bottom
    // half leans out and the two squares meet there.
    const r = only(
      extrude(squares(), 2 * h, {
        draft: angle,
        extent: { type: 'symmetric', distance: 2 * h },
      }),
    );
    try {
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(1);
      const expected = 2 * (frustum(h, 1) + frustum(h, -1)) - overlap(h);
      expect(r.props.volume / expected).toBeCloseTo(1, 9);
      expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
      // The box spans both halves, widest at the bottom cap.
      const box = k.properties(r.body.shape).boundingBox!;
      expect(box.min[2]).toBeCloseTo(-h, 5);
      expect(box.max[2]).toBeCloseTo(h, 5);
      expect(box.min[0]).toBeCloseTo(-h * Math.tan(angle), 5);
    } finally {
      r.done();
    }
  });
});

describe('several regions, partly on a body', () => {
  it('an add joins the regions that miss the body to it as extra solids', () => {
    // The tool is one shape: a region off the body is fused in with the rest, so the body
    // gains a solid of its own rather than a `detached` body.
    const base = applyFeature(k, [], {
      kind: 'extrude',
      id: 'extrude#1',
      mode: 'new',
      profile: { frame: XY, loops: [{ entities: rectangle(0, 0, 10, 10) }] },
      extent: { type: 'blind', distance: 2 },
    });
    expect(base.errors).toEqual([]);
    const out = applyFeature(k, [{ id: base.bodies[0]!.id, shape: base.bodies[0]!.shape }], {
      kind: 'extrude',
      id: 'extrude#2',
      mode: 'add',
      profile: regions([rectangle(2, 2, 4, 4, ids('a'))], [rectangle(30, 0, 32, 2, ids('b'))]),
      extent: { type: 'blind', distance: 3 },
    });
    const r = only(out);
    try {
      expect(out.warnings).toEqual([]);
      expect(r.props.valid).toBe(true);
      expect(r.body.solids).toBe(2);
      expect(r.props.volume).toBeCloseTo(200 + 4 + 12, 6); // region a rises 1 above the body
      r.byName('extrude#2:side:b1');
    } finally {
      r.done();
      k.release(base.bodies[0]!.shape);
    }
  });

  it('a Bezier side cannot be drafted', () => {
    const out = extrude(
      {
        frame: XY,
        loops: [
          {
            entities: bezierLoop([
              [0, 0],
              [5, 10],
              [10, 0],
            ]),
          },
        ],
      },
      2,
      { draft: 0.05 },
    );
    expect(out.errors).toMatchObject([
      { message: expect.stringMatching(/draft cannot tilt face/) },
    ]);
  });
});

describe('Bezier profile edges', () => {
  it('a quadratic arch: volume is the parabolic segment area times the depth', () => {
    // The parabola from (0,0) to (10,0) through its control (5,10) peaks at 5:
    // the segment's area is 2/3 * base * height = 100/3.
    const r = only(
      extrude(
        {
          frame: XY,
          loops: [
            {
              entities: bezierLoop([
                [0, 0],
                [5, 10],
                [10, 0],
              ]),
            },
          ],
        },
        3,
      ),
    );
    try {
      expect(r.props.valid).toBe(true);
      expect(Math.abs(r.props.volume / ((100 / 3) * 3) - 1)).toBeLessThan(1e-6);
      expect(sorted(r.names)).toEqual([
        'extrude#1:cap:end',
        'extrude#1:cap:start',
        'extrude#1:side:b1',
        'extrude#1:side:l1',
      ]);
      expect(r.byName('extrude#1:side:l1').surface).toBe('plane');
      expect(r.byName('extrude#1:side:b1').surface).toBe('surfaceofextrusion');
    } finally {
      r.done();
    }
  });

  it('a cubic arch, given clockwise: volume is 0.6 w h times the depth', () => {
    // x(t) = w (3t^2 - 2t^3), y(t) = 3h t (1 - t): the area under it is
    // 18 w h * integral t^2 (1-t)^2 dt = 0.6 w h. Given clockwise (end to
    // start) to check the kernel orients the loop itself.
    const w = 10;
    const h = 7;
    const points: Vec2[] = [
      [w, 0],
      [w, h],
      [0, h],
      [0, 0],
    ];
    const r = only(extrude({ frame: XY, loops: [{ entities: bezierLoop(points) }] }, 2));
    try {
      expect(r.props.valid).toBe(true);
      expect(Math.abs(r.props.volume / (0.6 * w * h * 2) - 1)).toBeLessThan(1e-6);
    } finally {
      r.done();
    }
  });

  it('a glyph-like region: a Bezier outline with a Bezier hole, next to a second region', () => {
    // An "O": outer and inner loops of two cubics each. The area of a closed
    // loop of cubics is computed here exactly by Green's theorem (the
    // integrand is a polynomial of degree 5, which 3-point Gauss-Legendre
    // integrates exactly).
    const oval = (rx: number, ry: number, id: string): ProfileEntity[] => {
      const c = 4 / 3;
      return [
        {
          kind: 'bezier',
          id: `${id}a`,
          points: [
            [rx, 0],
            [rx, c * ry],
            [-rx, c * ry],
            [-rx, 0],
          ],
        },
        {
          kind: 'bezier',
          id: `${id}b`,
          points: [
            [-rx, 0],
            [-rx, -c * ry],
            [rx, -c * ry],
            [rx, 0],
          ],
        },
      ];
    };
    const area = (loop: ProfileEntity[]) => {
      const g = [
        [-Math.sqrt(3 / 5), 5 / 9],
        [0, 8 / 9],
        [Math.sqrt(3 / 5), 5 / 9],
      ];
      let sum = 0;
      for (const e of loop) {
        if (e.kind !== 'bezier') throw new Error('Beziers only');
        const [p0, p1, p2, p3] = e.points as Vec2[];
        for (const [x, wt] of g) {
          const t = (x! + 1) / 2;
          const u = 1 - t;
          const pt = [0, 1].map(
            (i) =>
              u * u * u * p0![i]! +
              3 * u * u * t * p1![i]! +
              3 * u * t * t * p2![i]! +
              t * t * t * p3![i]!,
          );
          const d = [0, 1].map(
            (i) =>
              3 * u * u * (p1![i]! - p0![i]!) +
              6 * u * t * (p2![i]! - p1![i]!) +
              3 * t * t * (p3![i]! - p2![i]!),
          );
          sum += (wt! / 2) * 0.5 * (pt[0]! * d[1]! - pt[1]! * d[0]!);
        }
      }
      return Math.abs(sum);
    };
    const outer = oval(5, 8, 'o');
    const inner = oval(3, 6, 'i');
    const bar = rectangle(8, -8, 10, 8, ids('r'));
    const r = only(extrude(regions([outer, inner], [bar]), 1));
    try {
      expect(r.props.valid).toBe(true);
      const expected = area(outer) - area(inner) + 32;
      expect(Math.abs(r.props.volume / expected - 1)).toBeLessThan(1e-6);
      expect(r.body.solids).toBe(2);
      // The O's outer loop (oa, ob) sorts before the bar's (r1..r4).
      expect(r.byName('extrude#1:cap:end#1').area).toBeCloseTo(area(outer) - area(inner), 6);
      for (const id of ['oa', 'ob', 'ia', 'ib']) r.byName(`extrude#1:side:${id}`);
    } finally {
      r.done();
    }
  });

  it('revolves a Bezier edge into one named face', () => {
    // A quadratic from (2,0) up to (2,6) bulging out to x = 4 at the middle
    // (control (6,3)), closed by the line back down: revolved about y.
    const loop = bezierLoop([
      [2, 0],
      [6, 3],
      [2, 6],
    ]);
    const out = applyFeature(k, [], {
      kind: 'revolve',
      id: 'revolve#1',
      mode: 'new',
      profile: {
        frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
        loops: [{ entities: loop }],
      },
      axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
      angle: 2 * Math.PI,
    });
    const r = only(out);
    try {
      expect(r.props.valid).toBe(true);
      // Pappus: 2 pi times the first moment of the region about the axis.
      // The region lies between the chord x = 2 and the curve x = 2 + 8u,
      // y = 6s, with u = s (1 - s); its moment is the integral over y of
      // (x^2 - 4) / 2 = 16u + 32u^2, that is 6 (16/6 + 32/30) = 22.4.
      const moment = 22.4;
      expect(Math.abs(r.props.volume / (2 * Math.PI * moment) - 1)).toBeLessThan(1e-6);
      expect(sorted(r.names)).toEqual(['revolve#1:side:b1', 'revolve#1:side:l1']);
      expect(r.byName('revolve#1:side:b1').surface).toBe('surfaceofrevolution');
    } finally {
      r.done();
    }
  });
});

describe('several regions in one revolve', () => {
  const frame = { origin: [0, 0, 0] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, -1, 0] as Vec3 };
  const axis = { origin: [0, 0, 0] as Vec3, direction: [0, 0, 1] as Vec3 };
  const input = (angle: number, profile: SketchProfile): RevolveInput => ({
    kind: 'revolve',
    id: 'revolve#1',
    mode: 'new',
    profile,
    axis,
    angle,
  });

  it('two rings, a quarter turn: Pappus volumes and numbered caps', () => {
    const profile: SketchProfile = {
      frame,
      regions: [
        { loops: [{ entities: rectangle(10, 0, 12, 3, ids('b')) }] },
        { loops: [{ entities: rectangle(2, 0, 4, 5, ids('a')) }] },
      ],
    };
    const r = only(applyFeature(k, [], input(Math.PI / 2, profile)));
    try {
      expect(r.props.valid).toBe(true);
      const expected = (Math.PI / 2) * (3 * 10 + 11 * 6);
      expect(r.props.volume / expected).toBeCloseTo(1, 9);
      expect(r.body.solids).toBe(2);
      expect(sorted(r.names).filter((n) => n.includes(':cap:'))).toEqual([
        'revolve#1:cap:end#1',
        'revolve#1:cap:end#2',
        'revolve#1:cap:start#1',
        'revolve#1:cap:start#2',
      ]);
      // Region 1 is the inner rectangle (edges a1..a4), area 10.
      expect(r.byName('revolve#1:cap:start#1').area).toBeCloseTo(10, 9);
      expect(r.byName('revolve#1:cap:start#2').area).toBeCloseTo(6, 9);
    } finally {
      r.done();
    }
  });

  it('regions on both sides of the axis sweep through each other and fuse', () => {
    const profile: SketchProfile = {
      frame,
      regions: [
        { loops: [{ entities: rectangle(2, 0, 4, 5, ids('a')) }] },
        { loops: [{ entities: rectangle(-5, 1, -3, 3, ids('b')) }] },
      ],
    };
    const r = only(applyFeature(k, [], input(2 * Math.PI, profile)));
    try {
      expect(r.props.valid).toBe(true);
      // Revolved, they are the annuli r 2..4 (z 0..5) and r 3..5 (z 1..3).
      const ring = (r0: number, r1: number, h: number) => Math.PI * (r1 * r1 - r0 * r0) * h;
      const expected = ring(2, 4, 5) + ring(3, 5, 2) - ring(3, 4, 2);
      expect(r.props.volume / expected).toBeCloseTo(1, 9);
      expect(r.body.solids).toBe(1);
      expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
    } finally {
      r.done();
    }
  });
});

describe('the cost of many regions', () => {
  it('a 10 x 5 grid of letters, apart and touching in pairs', () => {
    // 50 small "glyphs" (a square with a square hole), as a line of text
    // would give. Measured, not asserted tightly: the README quotes these.
    const glyph = (x: number, y: number, n: number): ProfileEntity[][] => [
      rectangle(x, y, x + 3, y + 4, ids(`o${n}x`)),
      rectangle(x + 1, y + 1, x + 2, y + 3, ids(`i${n}x`)),
    ];
    const run = (step: number, area: number) => {
      const rs: ProfileEntity[][][] = [];
      for (let i = 0; i < 10; i++)
        for (let j = 0; j < 5; j++) rs.push(glyph(i * step, j * 6, rs.length));
      const t0 = performance.now();
      const r = only(extrude(regions(...rs), 0.6));
      const ms = performance.now() - t0;
      try {
        expect(r.props.valid).toBe(true);
        expect(r.props.volume / (area * 0.6)).toBeCloseTo(1, 6);
        expect(r.names.every((f) => !f.name.includes('?'))).toBe(true);
      } finally {
        r.done();
      }
      return ms;
    };
    // Apart (no boolean) and with each glyph overlapping its neighbour in x
    // (one fuse per row of ten).
    // Overlapping: each pair in a row shares a 0.5 x 4 strip of wall.
    const apart = run(4, 500);
    const touching = run(2.5, 500 - 5 * 9 * 2);
    console.log(
      `50 regions: apart ${apart.toFixed(0)} ms, overlapping rows ${touching.toFixed(0)} ms`,
    );
    expect(apart).toBeLessThan(20_000);
    expect(touching).toBeLessThan(60_000);
  }, 120_000);
});
