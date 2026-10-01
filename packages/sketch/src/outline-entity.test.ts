// Outline entities (T3.2c): the anchor in the solver, validation, several paths at once, placing
// and naming glyph loops, and their regions next to ordinary sketch geometry.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyCoordinates,
  coordinateCount,
  packCoordinates,
  type OutlineEntity,
  type SketchEntity,
  type Vec2,
} from './model';
import { outlinePartsRegions, type PathCommand } from './outline';
import { outlineEdgeId, placeOutline } from './outline-entity';
import { loadPlanegcsBackend, type PlanegcsBackend } from './planegcs/system';
import { XY_PLANE } from './placement';
import { regionFill } from './region-mesh';
import { regionProfile } from './region-profile';
import {
  MAX_OUTLINE_PLACEMENT_WORK,
  MAX_OUTLINE_POLYGON_POINTS,
  detectRegions,
  type OutlineShape,
  type Region,
  type RegionCurve,
} from './regions';
import { line, mm } from './test-helpers';
import { validateSketch } from './validate';

const M = (x: number, y: number): PathCommand => ({ kind: 'moveTo', to: [x, y] });
const L = (x: number, y: number): PathCommand => ({ kind: 'lineTo', to: [x, y] });
const Q = (cx: number, cy: number, x: number, y: number): PathCommand => ({
  kind: 'quadTo',
  control: [cx, cy],
  to: [x, y],
});
const Z: PathCommand = { kind: 'close' };

function square(x0: number, y0: number, x1: number, y1: number, cw = false): PathCommand[] {
  return cw
    ? [M(x0, y0), L(x0, y1), L(x1, y1), L(x1, y0), Z]
    : [M(x0, y0), L(x1, y0), L(x1, y1), L(x0, y1), Z];
}

/** An "O": a square ring with a rounded (quadratic) top, 4 wide and 4 high, from x = `x`. */
function letterO(x: number): PathCommand[] {
  return [
    M(x, 0),
    L(x + 4, 0),
    L(x + 4, 3),
    Q(x + 4, 4, x + 3, 4),
    L(x, 4),
    Z,
    ...square(x + 1, 1, x + 3, 3, true),
  ];
}

function outline(id: string, anchor: Vec2, angle = 0, construction = false): OutlineEntity {
  return {
    id,
    kind: 'outline',
    construction,
    anchor,
    angle,
    source: {
      kind: 'text',
      text: 'OO',
      font: 'font#1',
      size: mm(4),
      align: { horizontal: 'left', vertical: 'baseline' },
    },
  };
}

const rectangle = (x0: number, y0: number, x1: number, y1: number): SketchEntity[] => [
  line('l1', [x0, y0], [x1, y0]),
  line('l2', [x1, y0], [x1, y1]),
  line('l3', [x1, y1], [x0, y1]),
  line('l4', [x0, y1], [x0, y0]),
];

/** "OO" in entity `e5`, placed at `anchor`. */
function textShapes(anchor: Vec2, angle = 0, id = 'e5'): OutlineShape[] {
  const glyphs = [letterO(0), letterO(5)];
  return placeOutline({ id, anchor, angle }, [0, 1], outlinePartsRegions(glyphs));
}

const areaOf = (regions: readonly Region[]) => regions.reduce((a, r) => a + r.area, 0);
/**
 * The O's outer area: a 4 x 4 square less the corner the quadratic cuts off (the corner triangle
 * of 1/2 less the parabolic segment, 2/3 of it). The O itself less its 2 x 2 counter.
 */
const OUTER_AREA = 16 - 1 / 6;
const O_AREA = OUTER_AREA - 4;

describe('the outline entity in the model and the solver', () => {
  let backend: PlanegcsBackend;
  beforeAll(async () => {
    backend = await loadPlanegcsBackend();
  });

  it('packs its anchor as its coordinates', () => {
    const e = outline('e1', [3, 4], 0.5);
    expect(coordinateCount('outline')).toBe(2);
    const packed = packCoordinates([e]);
    expect([...packed]).toEqual([3, 4]);
    expect(applyCoordinates([e], new Float64Array([7, 8]))).toEqual([{ ...e, anchor: [7, 8] }]);
  });

  it('solves its anchor like a point, keeping the angle and source as they are', () => {
    const e = outline('e1', [3, 4], 0.25);
    const system = backend.createSystem();
    const result = system.update({
      entities: [e],
      constraints: [
        {
          id: 'k1',
          kind: 'horizontalDistance',
          a: { entity: '@origin' },
          b: { entity: 'e1', at: 'anchor' },
          value: mm(10),
        },
        {
          id: 'k2',
          kind: 'verticalDistance',
          a: { entity: '@origin' },
          b: { entity: 'e1', at: 'anchor' },
          value: mm(5),
        },
      ],
    });
    expect(result.status).toBe('solved');
    const solved = result.entities[0] as OutlineEntity;
    expect(solved.anchor[0]).toBeCloseTo(10, 9);
    expect(solved.anchor[1]).toBeCloseTo(5, 9);
    expect(solved.angle).toBe(0.25);
    expect(solved.source).toEqual(e.source);
    expect(result.diagnosis.dof).toBe(0);
    expect(result.diagnosis.entities).toEqual({ e1: 'fully' });
  });

  it('is referenced as a point only, at its anchor', () => {
    const e = outline('e1', [0, 0]);
    const l = line('l1', [0, 0], [10, 0]);
    expect(
      validateSketch({
        entities: [e, l],
        constraints: [
          {
            id: 'k1',
            kind: 'coincident',
            a: { entity: 'e1', at: 'anchor' },
            b: { entity: 'l1', at: 'start' },
          },
        ],
      }),
    ).toEqual([]);
    const issues = validateSketch({
      entities: [e, l],
      constraints: [
        { id: 'k1', kind: 'coincident', a: { entity: 'e1' }, b: { entity: 'l1', at: 'start' } },
        { id: 'k2', kind: 'pointOnObject', point: { entity: 'l1', at: 'end' }, on: 'e1' },
        { id: 'k3', kind: 'horizontal', line: 'e1' },
      ],
    });
    expect(issues.map((i) => [i.constraintId, i.code])).toEqual([
      ['k1', 'invalid-reference'],
      ['k2', 'invalid-reference'],
      ['k3', 'invalid-reference'],
    ]);
  });

  it('refuses a non-finite anchor or angle, and a split id', () => {
    const issues = validateSketch({
      entities: [
        outline('e1', [Number.NaN, 0]),
        { ...outline('e2', [0, 0]), angle: Number.POSITIVE_INFINITY },
        outline('e3#a', [0, 0]),
      ],
      constraints: [],
    });
    expect(issues.map((i) => [i.entityId, i.code])).toEqual([
      ['e1', 'invalid-geometry'],
      ['e2', 'invalid-geometry'],
      ['e3#a', 'invalid-geometry'],
    ]);
  });
});

describe('outlinePartsRegions', () => {
  it('converts paths that do not overlap one by one, numbering contours within each', () => {
    const { regions, issues } = outlinePartsRegions([letterO(0), [], letterO(5)]);
    expect(issues).toEqual([]);
    expect(
      regions.map((r) => [r.outer.part, r.outer.contour, r.holes.map((h) => [h.part, h.contour])]),
    ).toEqual([
      [0, 0, [[0, 1]]],
      [2, 0, [[2, 1]]],
    ]);
    expect(regions.every((r) => r.outer.segments.every((s) => s.part === r.outer.part))).toBe(true);
  });

  it('merges paths that overlap, saying which paths and contours took part', () => {
    // Two bars crossing, as two paths (glyphs that touch after kerning), and one apart.
    const { regions, issues } = outlinePartsRegions([
      square(0, 0, 10, 2),
      square(4, -3, 6, 5),
      square(20, 0, 22, 2),
    ]);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'merged',
        parts: [0, 1],
        contours: [
          [0, 0],
          [1, 0],
        ],
      }),
    ]);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.outer.area).toBeCloseTo(20 + 16 - 4, 9);
    expect(new Set(regions[0]!.outer.segments.map((s) => s.part))).toEqual(new Set([0, 1]));
    expect(regions[1]!.outer.part).toBe(2);
  });

  it('starts every path in a contour of its own, even one that does not start with moveTo', () => {
    const { regions } = outlinePartsRegions([
      square(0, 0, 4, 4),
      [L(4, 0), L(4, 4), L(0, 4), Z, ...square(1, 1, 2, 2)].slice(0, 4),
    ]);
    // The second draws from the origin, overlapping the first: one merged region, no
    // segment of the second continuing the first's last contour.
    expect(regions).toHaveLength(1);
    expect(regions[0]!.outer.area).toBeCloseTo(16, 9);
  });
});

describe('placeOutline', () => {
  it('places, turns and names the loops of each glyph', () => {
    const shapes = textShapes([100, 50], Math.PI / 2);
    expect(shapes.map((s) => [s.key, s.fragile, s.holes.map((h) => h.key)])).toEqual([
      ['e5.g0.c0', false, ['e5.g0.c1']],
      ['e5.g1.c0', false, ['e5.g1.c1']],
    ]);
    const [o] = shapes;
    expect(o!.outer.area).toBeCloseTo(OUTER_AREA, 9);
    // Turned a quarter: the glyph's (4, 0) corner lands at anchor + (0, 4).
    const corner = o!.outer.curves[0]!;
    if (corner.kind !== 'line') throw new Error('expected a line');
    expect(corner.start[0]).toBeCloseTo(100, 12);
    expect(corner.start[1]).toBeCloseTo(50, 12);
    expect(corner.end[0]).toBeCloseTo(100, 12);
    expect(corner.end[1]).toBeCloseTo(54, 12);
    expect(o!.outer.curves.map((c) => c.edgeId)).toEqual([
      'e5.g0.c0.s0#1',
      'e5.g0.c0.s1#1',
      'e5.g0.c0.s2#1',
      'e5.g0.c0.s3#1',
      'e5.g0.c0.s4#1',
    ]);
    expect(o!.outer.curves.every((c) => c.entityId === 'e5' && c.fragile)).toBe(true);
    const bezier = o!.outer.curves[2]!;
    expect(bezier.kind).toBe('bezier');
    if (bezier.kind === 'bezier') expect(bezier.points).toHaveLength(3);
  });

  it('builds edge ids the kernel accepts: a token and one final positional piece', () => {
    const id = outlineEdgeId('e12', 7, {
      kind: 'line',
      start: [0, 0],
      end: [1, 0],
      part: 3,
      contour: 2,
      index: 11,
      split: 1,
      piece: 0,
      reversed: false,
    });
    expect(id).toBe('e12.g7.c2.s11#2');
    expect(id).toMatch(/^[A-Za-z0-9_.@-]+(#[a-z]+)*(#[1-9][0-9]*)?$/);
  });
});

describe('detectRegions with outlines', () => {
  it('cuts letter-shaped holes in the face around a text, with the letters and counters as regions', () => {
    const plate = rectangle(-2, -2, 13, 6);
    const shapes = textShapes([0, 0]);
    const { regions, voids, diagnostics } = detectRegions([...plate, outline('e5', [0, 0])], {
      outlines: shapes,
    });
    expect(diagnostics).toEqual([]);
    expect(voids).toEqual([]);
    expect(regions.map((r) => r.id)).toEqual([
      'e5.g0.c0',
      'e5.g0.c1/counter',
      'e5.g1.c0',
      'e5.g1.c1/counter',
      'l1/L+l2/L+l3/L+l4/L',
    ]);
    const plateRegion = regions.find((r) => r.id.startsWith('l1'))!;
    expect(plateRegion.holes).toHaveLength(2);
    expect(plateRegion.holes.every((h) => h.area < 0)).toBe(true);
    expect(plateRegion.area).toBeCloseTo(15 * 8 - 2 * OUTER_AREA, 9);
    expect(plateRegion.entityIds).toEqual(['e5', 'l1', 'l2', 'l3', 'l4']);
    const letters = regions.filter((r) => /\.c0$/.test(r.id));
    expect(letters.map((r) => r.area)).toEqual([
      expect.closeTo(O_AREA, 9),
      expect.closeTo(O_AREA, 9),
    ]);
    expect(letters.every((r) => r.depth === 1 && r.selectedWith === undefined)).toBe(true);
    const counters = regions.filter((r) => r.id.endsWith('/counter'));
    expect(counters.map((r) => [r.area, r.depth, r.selectedWith])).toEqual([
      [expect.closeTo(4, 12), 2, ['l1', 'l2', 'l3', 'l4']],
      [expect.closeTo(4, 12), 2, ['l1', 'l2', 'l3', 'l4']],
    ]);
    // Everything together tiles the plate.
    expect(areaOf(regions)).toBeCloseTo(15 * 8, 9);
  });

  it('keeps a text with nothing around it as letters only, without counter faces', () => {
    const { regions, voids, diagnostics } = detectRegions([outline('e5', [0, 0])], {
      outlines: textShapes([0, 0]),
    });
    expect(diagnostics).toEqual([]);
    expect(voids).toEqual([]);
    expect(regions.map((r) => [r.id, r.depth])).toEqual([
      ['e5.g0.c0', 0],
      ['e5.g1.c0', 0],
    ]);
    expect(areaOf(regions)).toBeCloseTo(2 * O_AREA, 9);
  });

  it('puts a text inside a hole with the void, its counters voids too', () => {
    const plate = rectangle(-10, -10, 30, 20);
    const hole = rectangle(-2, -2, 13, 6).map((e) => ({ ...e, id: e.id.replace('l', 'h') }));
    const { regions, voids } = detectRegions([...plate, ...hole], { outlines: textShapes([0, 0]) });
    expect(voids.map((v) => v.id)).toEqual(
      ['e5.g0.c1/counter', 'e5.g1.c1/counter', 'h1/L+h2/L+h3/L+h4/L'].sort(),
    );
    expect(voids.find((v) => v.id.startsWith('h'))!.holes).toHaveLength(2);
    expect(regions.map((r) => r.id)).toContain('e5.g0.c0');
  });

  it('warns and cuts no hole when a text crosses other geometry', () => {
    const plate = rectangle(2, -2, 13, 6);
    const { regions, diagnostics } = detectRegions(plate, { outlines: textShapes([0, 0]) });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'outline-overlap',
        severity: 'warning',
        entityIds: ['e5', 'l1', 'l2', 'l3', 'l4'],
      }),
    ]);
    const plateRegion = regions.find((r) => r.id.startsWith('l1'))!;
    // The second O lies inside the plate and still cuts its hole; the first crosses the edge.
    expect(plateRegion.holes).toHaveLength(1);
    expect(
      regions.filter((r) => r.id.startsWith('e5.') && !r.id.endsWith('/counter')),
    ).toHaveLength(2);
  });

  it('warns when a text encloses other geometry, or two texts overlap', () => {
    const inside = detectRegions(
      [
        line('c1', [0.2, 0.2], [0.8, 0.2]),
        line('c2', [0.8, 0.2], [0.5, 0.8]),
        line('c3', [0.5, 0.8], [0.2, 0.2]),
      ],
      {
        outlines: textShapes([0, 0]),
      },
    );
    expect(inside.diagnostics.map((d) => [d.code, d.entityIds])).toEqual([
      ['outline-overlap', ['c1', 'c2', 'c3', 'e5']],
    ]);
    const two = detectRegions([], {
      outlines: [...textShapes([0, 0]), ...textShapes([2, 0], 0, 'e6')],
    });
    expect(two.diagnostics.map((d) => [d.code, d.entityIds])).toEqual([
      ['outline-overlap', ['e5', 'e6']],
      ['outline-overlap', ['e5', 'e6']],
    ]);
  });

  it("cuts a glyph in another glyph's counter into that counter, whichever comes first", () => {
    const plate = rectangle(-2, -2, 6, 6);
    const ring = [...square(0, 0, 4, 4), ...square(1, 1, 3, 3, true)];
    const dot = square(1.5, 1.5, 2.5, 2.5);
    for (const glyphs of [
      [dot, ring],
      [ring, dot],
    ]) {
      const shapes = placeOutline(
        { id: 'e5', anchor: [0, 0], angle: 0 },
        [0, 1],
        outlinePartsRegions(glyphs),
      );
      const ringKey = glyphs[0] === ring ? 'e5.g0' : 'e5.g1';
      const dotKey = glyphs[0] === ring ? 'e5.g1' : 'e5.g0';
      const { regions, voids, diagnostics } = detectRegions(plate, { outlines: shapes });
      expect(diagnostics).toEqual([]);
      expect(voids).toEqual([]);
      const byId = new Map(regions.map((r) => [r.id, r]));
      // The plate has one hole, the ring's; the ring's counter has one, the dot's.
      expect(byId.get('l1/L+l2/L+l3/L+l4/L')!.holes).toHaveLength(1);
      const counter = byId.get(`${ringKey}.c1/counter`)!;
      expect(counter.holes).toHaveLength(1);
      expect(counter.area).toBeCloseTo(3, 12);
      expect(counter.selectedWith).toEqual(['l1', 'l2', 'l3', 'l4']);
      expect(byId.get(`${dotKey}.c0`)!.depth).toBe(counter.depth + 1);
      // Everything together tiles the plate, with no area counted twice.
      expect(areaOf(regions)).toBeCloseTo(64, 9);
    }
  });

  it('gives the kernel Bezier entities, and fills Bezier regions for highlighting', () => {
    const { regions } = detectRegions([], { outlines: textShapes([0, 0]) });
    const profile = regionProfile(regions[0]!, XY_PLANE);
    const kinds = profile.loops[0]!.entities.map((e) => e.kind);
    expect(kinds).toEqual(['line', 'line', 'bezier', 'line', 'line']);
    const bezier = profile.loops[0]!.entities[2]!;
    if (bezier.kind === 'bezier')
      expect(bezier.points).toEqual([
        [4, 3],
        [4, 4],
        [3, 4],
      ]);
    expect(profile.edges['e5.g0.c0.s2#1']).toEqual({ entityId: 'e5', fragile: true });
    const fill = regionFill(regions[0]!, XY_PLANE, { linear: 0.001, angular: 0.25 });
    expect(fill.area).toBeCloseTo(O_AREA, 2);
  });
});

/** A polygon (counter-clockwise points) as an outline shape of entity `id`, all lines. */
function polygonShape(id: string, key: string, points: readonly Vec2[]): OutlineShape {
  const curves: RegionCurve[] = points.map((start, k) => ({
    kind: 'line',
    edgeId: `${key}.s${k}#1`,
    entityId: id,
    fragile: true,
    reversed: false,
    start,
    end: points[(k + 1) % points.length]!,
  }));
  let area = 0;
  points.forEach((p, k) => {
    const q = points[(k + 1) % points.length]!;
    area += (p[0] * q[1] - q[0] * p[1]) / 2;
  });
  return { entityId: id, key, fragile: false, outer: { curves, area }, holes: [] };
}

/**
 * A comb of `teeth` teeth 0.5 wide every 2 (4 segments each): a spine along y 0 to 1 with teeth
 * up to y 10, or (`down`) a spine along y 11 to 12 with teeth down to y 1.5, shifted by 1, so the
 * two combs interleave without touching.
 */
function comb(id: string, teeth: number, down: boolean): OutlineShape {
  const points: Vec2[] = [];
  const width = 2 * teeth + 1;
  if (!down) {
    points.push([0, 0], [width, 0], [width, 1]);
    for (let k = teeth - 1; k >= 0; k--) {
      const x = 2 * k;
      points.push([x + 0.5, 1], [x + 0.5, 10], [x, 10], [x, 1]);
    }
  } else {
    points.push([width, 12], [0, 12], [0, 11]);
    for (let k = 0; k < teeth; k++) {
      const x = 2 * k + 1;
      points.push([x, 11], [x, 1.5], [x + 0.5, 1.5], [x + 0.5, 11]);
    }
    points.push([width, 11]);
  }
  return polygonShape(id, `${id}.g0.c0`, points);
}

describe('detectRegions with outlines: bounded work', () => {
  it('checks two large interleaved outlines that never touch quickly, and finds no overlap', () => {
    const a = comb('e5', 16_000, false);
    const b = comb('e6', 16_000, true);
    expect(a.outer.curves.length).toBeGreaterThan(64_000);
    expect(a.outer.area).toBeGreaterThan(0);
    expect(b.outer.area).toBeGreaterThan(0);
    const started = performance.now();
    const { regions, diagnostics } = detectRegions([], { outlines: [a, b] });
    // The pairwise check took 13 s before the grid; well under a second now.
    expect(performance.now() - started).toBeLessThan(3000);
    expect(diagnostics).toEqual([]);
    expect(regions).toHaveLength(2);
  });

  it('still finds where two large outlines touch', () => {
    const a = comb('e5', 4000, false);
    const b = comb('e6', 4000, true);
    // Move one tooth of the upper comb onto a tooth of the lower one.
    const touching = polygonShape(
      'e6',
      'e6.g0.c0',
      b.outer.curves.map((c, k) => (k === 10 ? ([2 * 4 + 0.25, 5] as Vec2) : c.start)),
    );
    const { diagnostics } = detectRegions([], { outlines: [a, touching] });
    expect(diagnostics.map((d) => [d.code, d.entityIds])).toEqual([
      ['outline-overlap', ['e5', 'e6']],
      ['outline-overlap', ['e5', 'e6']],
    ]);
  });

  it('places many glyphs of one text in a plate without comparing every pair', () => {
    // 40,000 small squares in a 200 by 200 grid inside one plate: each cuts its hole.
    const shapes: OutlineShape[] = [];
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 200; j++) {
        const x = i * 2;
        const y = j * 2;
        shapes.push(
          polygonShape('e5', `e5.g${i * 200 + j}.c0`, [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ]),
        );
      }
    }
    const started = performance.now();
    const { regions, diagnostics } = detectRegions(rectangle(-1, -1, 401, 401), {
      outlines: shapes,
    });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(diagnostics).toEqual([]);
    const plate = regions.find((r) => r.id.startsWith('l1'))!;
    expect(plate.holes).toHaveLength(40_000);
    expect(regions.filter((r) => r.depth === 1)).toHaveLength(40_000);
  });

  it('falls back to outline-overlap before flattening a text of many Beziers into too many points', () => {
    // 200,000 quadratic Beziers around a circle, each bulging far out: 130 chords each at the
    // sketch's deflection, 26 million points (over a gigabyte) if flattened.
    const n = 200_000;
    const at = (k: number, r: number): Vec2 => [
      r * Math.cos((2 * Math.PI * k) / n),
      r * Math.sin((2 * Math.PI * k) / n),
    ];
    const curves: RegionCurve[] = [];
    for (let k = 0; k < n; k++) {
      curves.push({
        kind: 'bezier',
        edgeId: `e5.g0.c0.s${k}#1`,
        entityId: 'e5',
        fragile: true,
        reversed: false,
        start: at(k, 100),
        end: at(k + 1, 100),
        points: [at(k, 100), at(k + 0.5, 200), at(k + 1, 100)],
      });
    }
    const shape: OutlineShape = {
      entityId: 'e5',
      key: 'e5.g0.c0',
      fragile: false,
      outer: { curves, area: Math.PI * 100 * 100 },
      holes: [],
    };
    const plate = rectangle(-300, -300, 300, 300);
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const { regions, diagnostics } = detectRegions(plate, { outlines: [shape] });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(500 * 2 ** 20);
    expect(diagnostics.map((d) => [d.code, d.entityIds])).toEqual([
      ['outline-overlap', ['e5', 'l1', 'l2', 'l3', 'l4']],
    ]);
    expect(diagnostics[0]!.message).toMatch(/too complex to check/);
    expect(regions.find((r) => r.id.startsWith('l1'))!.holes).toHaveLength(0);
    // A lower cap stops a small text the same way; the default leaves it alone.
    const small = textShapes([0, 0]);
    expect(detectRegions(plate, { outlines: small }).diagnostics).toEqual([]);
    expect(
      detectRegions(plate, { outlines: small, outlinePoints: 10 }).diagnostics.map((d) => d.code),
    ).toEqual(['outline-overlap']);
    expect(MAX_OUTLINE_POLYGON_POINTS).toBeGreaterThanOrEqual(4_000_000);
  });

  it('falls back to outline-overlap, cutting no hole, when the work budget runs out', () => {
    const plate = rectangle(-2, -2, 30, 6);
    const shapes = [...textShapes([0, 0]), ...textShapes([15, 0], 0, 'e6')];
    // Within the budget the two texts are apart and cut their holes.
    const fine = detectRegions(plate, { outlines: shapes });
    expect(fine.diagnostics).toEqual([]);
    expect(fine.regions.find((r) => r.id.startsWith('l1'))!.holes).toHaveLength(4);
    const starved = detectRegions(plate, { outlines: shapes, outlineWork: 50 });
    expect(starved.diagnostics.map((d) => [d.code, d.severity, d.entityIds])).toEqual([
      ['outline-overlap', 'warning', ['e5', 'l1', 'l2', 'l3', 'l4']],
      ['outline-overlap', 'warning', ['e6', 'l1', 'l2', 'l3', 'l4']],
    ]);
    expect(starved.diagnostics[0]!.message).toMatch(/too complex to check/);
    const plateRegion = starved.regions.find((r) => r.id.startsWith('l1'))!;
    expect(plateRegion.holes).toHaveLength(0);
    // Letters stay regions; no counters are made.
    expect(starved.regions.filter((r) => r.id.startsWith('e')).map((r) => r.depth)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(MAX_OUTLINE_PLACEMENT_WORK).toBeGreaterThan(1_000_000);
  });
});
