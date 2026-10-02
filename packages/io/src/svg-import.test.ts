// @vitest-environment jsdom
// jsdom only for its DOMParser, to check our XML reader against a real one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Vec2 } from './path2';
import { writeSvg } from './svg';
import {
  DEFAULT_SVG_TOLERANCE,
  MAX_SVG_CHARS,
  MAX_SVG_ELEMENTS,
  SvgImportError,
  fitSvg,
  importSvg,
  parseSvg,
  svgOutlinePaths,
  parseLength,
  parsePathData,
  parseTransform,
  parseXml,
  placeSvgImport,
  svgImportCounts,
  type SvgContour,
  type SvgImport,
  type SvgSegment,
} from './svg-import';

const LETTERS = readFileSync(join(import.meta.dirname, 'fixtures/svg/letters.svg'), 'utf8');
const WORD = readFileSync(join(import.meta.dirname, 'fixtures/svg/word.svg'), 'utf8');
const BRACKET = readFileSync(join(import.meta.dirname, 'goldens/bracket.svg'), 'utf8');

const svg = (body: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

// Geometry helpers, written independently of the importer ------------------------------------

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function sweepOf(s: Extract<SvgSegment, { kind: 'arc' }>): number {
  const a = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
  const b = Math.atan2(s.end[1] - s.center[1], s.end[0] - s.center[0]);
  let d = (s.clockwise ? a - b : b - a) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d;
}

/** Points along a segment, `n` + 1 of them. */
function sampleSegment(s: SvgSegment, n: number): Vec2[] {
  const out: Vec2[] = [];
  if (s.kind === 'line') {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push([
        s.start[0] + t * (s.end[0] - s.start[0]),
        s.start[1] + t * (s.end[1] - s.start[1]),
      ]);
    }
    return out;
  }
  const r = dist(s.start, s.center);
  const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
  const sweep = sweepOf(s) * (s.clockwise ? -1 : 1);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([s.center[0] + r * Math.cos(a), s.center[1] + r * Math.sin(a)]);
  }
  return out;
}

function distanceToSegment(p: Vec2, s: SvgSegment): number {
  if (s.kind === 'line') {
    const d: Vec2 = [s.end[0] - s.start[0], s.end[1] - s.start[1]];
    const len2 = d[0] ** 2 + d[1] ** 2;
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - s.start[0]) * d[0] + (p[1] - s.start[1]) * d[1]) / len2),
    );
    return dist(p, [s.start[0] + t * d[0], s.start[1] + t * d[1]]);
  }
  const r = dist(s.start, s.center);
  const a = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
  const b = Math.atan2(p[1] - s.center[1], p[0] - s.center[0]);
  let u = (s.clockwise ? a - b : b - a) % (2 * Math.PI);
  if (u < 0) u += 2 * Math.PI;
  if (u <= sweepOf(s)) return Math.abs(dist(p, s.center) - r);
  return Math.min(dist(p, s.start), dist(p, s.end));
}

function distanceToPolyline(p: Vec2, pts: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distanceToSegment(p, { kind: 'line', start: pts[i]!, end: pts[i + 1]! }));
  }
  return best;
}

/**
 * The two-sided distance between a contour and a curve sampled densely: every curve sample to
 * the nearest segment, and every point of every segment to the curve's polyline.
 */
function hausdorff(contour: SvgContour, curve: readonly Vec2[]): number {
  let d = 0;
  for (const p of curve) {
    d = Math.max(d, Math.min(...contour.segments.map((s) => distanceToSegment(p, s))));
  }
  for (const s of contour.segments) {
    for (const p of sampleSegment(s, 24)) d = Math.max(d, distanceToPolyline(p, curve));
  }
  return d;
}

function cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
      u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
    ]);
  }
  return out;
}

/** Joined end to start exactly, and every arc's ends on one circle. */
function expectWellFormed(imp: SvgImport) {
  for (const c of imp.contours) {
    const segs = c.segments;
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toEqual(segs[i - 1]!.end);
    if (c.closed) expect(segs[0]!.start).toEqual(segs[segs.length - 1]!.end);
    for (const s of segs) {
      expect(dist(s.start, s.end)).toBeGreaterThan(0);
      if (s.kind === 'arc') {
        const r = dist(s.start, s.center);
        expect(Math.abs(dist(s.end, s.center) - r)).toBeLessThan(1e-9 * Math.max(1, r));
      }
    }
  }
}

/** Signed area of a contour, positive counter-clockwise: the chords' polygon plus each arc's circular segment. */
function area(c: SvgContour): number {
  let a = 0;
  for (const s of c.segments) {
    a += (s.start[0] * s.end[1] - s.end[0] * s.start[1]) / 2;
    if (s.kind === 'arc') {
      const r = dist(s.start, s.center);
      const t = sweepOf(s);
      a += ((s.clockwise ? -1 : 1) * r * r * (t - Math.sin(t))) / 2;
    }
  }
  return a;
}

const byElement = (imp: SvgImport, element: string) =>
  imp.contours.filter((c) => c.element === element);

// Parsing --------------------------------------------------------------------------------------

describe('parsePathData', () => {
  it('reads absolute and relative commands, implicit repeats and H/V', () => {
    const { commands, error } = parsePathData('m10 20 5 0l0 5h-5v-5 Z l1,1');
    expect(error).toBeNull();
    expect(commands).toEqual([
      { kind: 'M', to: [10, 20] },
      { kind: 'L', to: [15, 20] },
      { kind: 'L', to: [15, 25] },
      { kind: 'L', to: [10, 25] },
      { kind: 'L', to: [10, 20] },
      { kind: 'Z' },
      { kind: 'L', to: [11, 21] }, // after Z the current point is the subpath start
    ]);
  });

  it('reads compact numbers and arc flags', () => {
    const { commands, error } = parsePathData('M1.5.5L-1e1-2a1 1 0 00 1 1A2,3,30,1,0,4,5');
    expect(error).toBeNull();
    expect(commands[0]).toEqual({ kind: 'M', to: [1.5, 0.5] });
    expect(commands[1]).toEqual({ kind: 'L', to: [-10, -2] });
    expect(commands[2]).toEqual({
      kind: 'A',
      rx: 1,
      ry: 1,
      rotation: 0,
      large: false,
      sweep: false,
      to: [-9, -1],
    });
    expect(commands[3]).toMatchObject({ rx: 2, ry: 3, rotation: 30, large: true, sweep: false });
  });

  it('reflects control points for S and T', () => {
    const { commands } = parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0 Q25 5 30 0 T40 0 t10 0');
    expect(commands[2]).toEqual({ kind: 'C', c1: [10, -10], c2: [20, -10], to: [20, 0] });
    expect(commands[4]).toEqual({ kind: 'Q', c: [35, -5], to: [40, 0] });
    expect(commands[5]).toEqual({ kind: 'Q', c: [45, 5], to: [50, 0] });
    // S after a non-cubic uses the current point.
    expect(parsePathData('M0 0 L5 5 S10 10 10 0').commands[2]).toEqual({
      kind: 'C',
      c1: [5, 5],
      c2: [10, 10],
      to: [10, 0],
    });
  });

  it('keeps the commands before an error', () => {
    const r = parsePathData('M0 0 L10 0 L10 x10');
    expect(r.commands).toHaveLength(2);
    expect(r.error).toMatch(/character 16/);
    expect(parsePathData('L0 0').error).toMatch(/must start with M/);
    expect(parsePathData('M0 0 K1 1').error).toMatch(/unknown command 'K'/);
    expect(parsePathData('M0 0 Z 5 5').error).toMatch(/unexpected '5'/);
    expect(parsePathData('M0 0 A1 1 0 2 0 1 1').commands).toHaveLength(1);
  });
});

describe('parseTransform', () => {
  const apply = (s: string, p: Vec2) => {
    const m = parseTransform(s)!;
    return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  };
  it('reads every kind, applied right to left', () => {
    expect(apply('translate(10)', [1, 1])).toEqual([11, 1]);
    expect(apply('translate(10 5) scale(2)', [1, 1])).toEqual([12, 7]);
    expect(apply('scale(2,3)', [1, 1])).toEqual([2, 3]);
    expect(apply('matrix(1 2 3 4 5 6)', [1, 1])).toEqual([9, 12]);
    const r = apply('rotate(90 10 10)', [20, 10]);
    expect(r[0]).toBeCloseTo(10, 12);
    expect(r[1]).toBeCloseTo(20, 12);
    expect(apply('skewX(45)', [0, 2])[0]).toBeCloseTo(2, 12);
    expect(apply('skewY(45)', [2, 0])[1]).toBeCloseTo(2, 12);
  });
  it('refuses what does not parse', () => {
    expect(parseTransform('translate(1')).toBeNull();
    expect(parseTransform('turn(3)')).toBeNull();
    expect(parseTransform('matrix(1 2 3)')).toBeNull();
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('parseLength', () => {
  it('converts CSS units to user units (96 per inch)', () => {
    expect(parseLength('10')).toBe(10);
    expect(parseLength('1in')).toBe(96);
    expect(parseLength('25.4mm')).toBeCloseTo(96, 12);
    expect(parseLength('72pt')).toBeCloseTo(96, 12);
    expect(parseLength('50%', 300)).toBe(150);
    expect(parseLength('50%')).toBeNull();
    expect(parseLength('3furlongs')).toBeNull();
  });
});

describe('parseXml', () => {
  it('skips the prolog, DOCTYPE, comments and CDATA, decodes entities, drops prefixes', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY ns "http://x"> <!-- ] > --> ]>
       <!-- a comment with <tags> --><svg:svg xmlns:svg="http://www.w3.org/2000/svg">
       <![CDATA[ <path d="M0 0"/> ]]><svg:g id="a&amp;b&#65;&#x42;&ns;" title='q"q'><svg:path d="M0 0"/></svg:g>
       text &lt; here</svg:svg>`,
    );
    expect(root.name).toBe('svg');
    expect(root.children).toHaveLength(1);
    const g = root.children[0]!;
    expect(g.name).toBe('g');
    expect(g.attrs.get('id')).toBe('a&bAB&ns;');
    expect(g.attrs.get('title')).toBe('q"q');
    expect(g.children[0]!.name).toBe('path');
  });

  it('refuses malformed XML with a line number', () => {
    const bad = [
      '<svg><g></svg>',
      '<svg><path d="M0 0></svg>',
      '<svg x=1></svg>',
      '<svg>',
      '<svg><!-- </svg>',
    ];
    for (const text of bad) {
      expect(() => parseXml(text)).toThrow(SvgImportError);
      try {
        parseXml(text);
      } catch (e) {
        expect((e as SvgImportError).code).toBe('xml');
        expect((e as Error).message).toMatch(/line \d+/);
      }
    }
  });

  it('matches DOMParser on a real drawing (element names, counts and attributes)', () => {
    const doc = new DOMParser().parseFromString(BRACKET, 'image/svg+xml');
    const names: string[] = [];
    const walk = (e: Element) => {
      names.push(`${e.localName}:${e.getAttribute('d') ?? ''}`);
      for (const c of Array.from(e.children)) walk(c);
    };
    walk(doc.documentElement);
    const ours: string[] = [];
    const walk2 = (e: ReturnType<typeof parseXml>) => {
      ours.push(`${e.name}:${e.attrs.get('d') ?? ''}`);
      e.children.forEach(walk2);
    };
    walk2(parseXml(BRACKET));
    expect(ours).toEqual(names);
  }, 30_000);
});

// Import ---------------------------------------------------------------------------------------

describe('importSvg: the lettering fixture', () => {
  const imp = importSvg(LETTERS);

  it('makes closed contours for every letter and its counters, and a circle for the dot', () => {
    expect(imp.issues).toEqual([]);
    expect(imp.page).toEqual({ width: 120, height: 50 });
    expect(imp.contours.every((c) => c.closed)).toBe(true);
    expect(byElement(imp, 'path#O')).toHaveLength(2);
    expect(byElement(imp, 'path#A')).toHaveLength(2);
    expect(byElement(imp, 'path#B')).toHaveLength(3);
    expect(imp.circles).toEqual([{ center: [112, 10], radius: 4, element: 'circle#dot' }]);
    expectWellFormed(imp);
  });

  it('places the page with y up: millimetres, bottom left at the origin', () => {
    // Arcs replacing the O's Beziers may bulge past them by up to the tolerance.
    expect(imp.bounds!.min[0]).toBeCloseTo(6, 1);
    expect(imp.bounds!.min[1]).toBeCloseTo(5, 1);
    expect(imp.bounds!.max[0]).toBeCloseTo(116, 1);
    expect(imp.bounds!.max[1]).toBeCloseTo(45, 1);
    // A's outline after translate(40, 0): its apex is at (51, 5) in the file, (51, 45) here.
    const a = byElement(imp, 'path#A')[0]!;
    expect(a.segments.map((s) => s.start)).toContainEqual([51, 45]);
  });

  it('keeps straight letters straight and circular arcs exact', () => {
    const [aOuter, aHole] = byElement(imp, 'path#A');
    expect(aOuter!.segments.every((s) => s.kind === 'line')).toBe(true);
    expect(aOuter!.segments).toHaveLength(8);
    expect(aHole!.segments).toHaveLength(3);
    const bOuter = byElement(imp, 'path#B')[0]!;
    const arcs = bOuter.segments.filter((s) => s.kind === 'arc');
    expect(arcs).toHaveLength(2);
    expect(arcs.map((s) => dist(s.start, s.center))).toEqual([
      expect.closeTo(9.5, 9),
      expect.closeTo(10.5, 9),
    ]);
    // Bowls bulge to the right of the stem: clockwise with y up.
    expect(arcs.every((s) => s.kind === 'arc' && s.clockwise)).toBe(true);
    // Areas: the A outline as a polygon, the B counters as rectangles plus half discs.
    expect(Math.abs(area(aOuter!))).toBeCloseTo(
      Math.abs(
        // shoelace of the outline, y flipped
        [
          [0, 45],
          [11, 5],
          [19, 5],
          [30, 45],
          [23, 45],
          [20.5, 35],
          [9.5, 35],
          [7, 45],
        ].reduce((s, p, i, all) => {
          const q = all[(i + 1) % all.length]!;
          return s + (p[0]! * q[1]! - q[0]! * p[1]!) / 2;
        }, 0),
      ),
      6,
    );
    const [, upper, lower] = byElement(imp, 'path#B');
    expect(Math.abs(area(upper!))).toBeCloseTo(6 * 7 + (Math.PI * 3.5 ** 2) / 2, 3);
    expect(Math.abs(area(lower!))).toBeCloseTo(7 * 10 + (Math.PI * 5 ** 2) / 2, 3);
  });

  it('replaces the Beziers of the O by arcs within the tolerance (two-sided distance)', () => {
    const [outer, inner] = byElement(imp, 'path#O');
    const flip = (p: Vec2): Vec2 => [p[0], 50 - p[1]];
    const curve = (pieces: [Vec2, Vec2, Vec2, Vec2][]) =>
      pieces.flatMap(([a, b, c, d], i) =>
        cubic(flip(a), flip(b), flip(c), flip(d), 400).slice(i === 0 ? 0 : 1),
      );
    const outerCurve = curve([
      [
        [34, 25],
        [34, 36.046],
        [27.732, 45],
        [20, 45],
      ],
      [
        [20, 45],
        [12.268, 45],
        [6, 36.046],
        [6, 25],
      ],
      [
        [6, 25],
        [6, 13.954],
        [12.268, 5],
        [20, 5],
      ],
      [
        [20, 5],
        [27.732, 5],
        [34, 13.954],
        [34, 25],
      ],
    ]);
    const innerCurve = curve([
      [
        [27, 25],
        [27, 18.373],
        [23.866, 13],
        [20, 13],
      ],
      [
        [20, 13],
        [16.134, 13],
        [13, 18.373],
        [13, 25],
      ],
      [
        [13, 25],
        [13, 31.627],
        [16.134, 37],
        [20, 37],
      ],
      [
        [20, 37],
        [23.866, 37],
        [27, 31.627],
        [27, 25],
      ],
    ]);
    const dOuter = hausdorff(outer!, outerCurve);
    const dInner = hausdorff(inner!, innerCurve);
    expect(dOuter).toBeLessThanOrEqual(DEFAULT_SVG_TOLERANCE);
    expect(dInner).toBeLessThanOrEqual(DEFAULT_SVG_TOLERANCE);
    expect(imp.maxDeviation).toBeLessThanOrEqual(DEFAULT_SVG_TOLERANCE);
    // Arcs, not a polyline: a handful of pieces per quarter.
    expect(outer!.segments.every((s) => s.kind === 'arc')).toBe(true);
    expect(outer!.segments.length).toBeLessThan(40);
    // The counter runs the other way round from the outline, as in the file.
    expect(Math.sign(area(outer!))).toBe(-Math.sign(area(inner!)));
  });

  it('holds a finer tolerance with more arcs', () => {
    const fine = importSvg(LETTERS, { tolerance: 0.0005 });
    const coarse = importSvg(LETTERS, { tolerance: 0.05 });
    const n = (i: SvgImport) => byElement(i, 'path#O')[0]!.segments.length;
    expect(n(fine)).toBeGreaterThan(n(imp));
    expect(n(coarse)).toBeLessThan(n(imp));
    expect(fine.maxDeviation).toBeLessThanOrEqual(0.0005);
    expect(coarse.maxDeviation).toBeLessThanOrEqual(0.05);
  });

  it('scales before fitting', () => {
    const big = importSvg(LETTERS, { scale: 10 });
    expect(big.page).toEqual({ width: 1200, height: 500 });
    expect(big.circles[0]!.radius).toBeCloseTo(40, 9);
    expect(big.maxDeviation).toBeLessThanOrEqual(DEFAULT_SVG_TOLERANCE);
    expect(byElement(big, 'path#O')[0]!.segments.length).toBeGreaterThan(
      byElement(imp, 'path#O')[0]!.segments.length,
    );
    expect(svgImportCounts(big)).toMatchObject({ circles: 1 });
  });
});

describe('importSvg: shapes, units and structure', () => {
  it('reads rect, rounded rect, circle, ellipse, line, polyline and polygon', () => {
    const imp = importSvg(
      svg(`
        <rect id="r" x="10" y="10" width="20" height="10"/>
        <rect id="rr" x="40" y="10" width="20" height="10" rx="3"/>
        <circle id="c" cx="20" cy="50" r="5"/>
        <ellipse id="e" cx="50" cy="50" rx="10" ry="5"/>
        <line id="l" x1="0" y1="90" x2="10" y2="90"/>
        <polyline id="pl" points="20,90 30,90 30,80"/>
        <polygon id="pg" points="40 90 50 90 45 80"/>
        <rect width="0" height="5"/>
        <circle r="0"/>`),
    );
    expectWellFormed(imp);
    const rect = byElement(imp, 'rect#r')[0]!;
    expect(rect.segments.map((s) => s.start)).toEqual([
      [10, 90],
      [30, 90],
      [30, 80],
      [10, 80],
    ]);
    const rr = byElement(imp, 'rect#rr')[0]!;
    expect(rr.segments.filter((s) => s.kind === 'arc')).toHaveLength(4);
    expect(Math.abs(area(rr))).toBeCloseTo(200 - (4 - Math.PI) * 9, 3);
    expect(imp.circles).toEqual([{ center: [20, 50], radius: 5, element: 'circle#c' }]);
    const e = byElement(imp, 'ellipse#e')[0]!;
    expect(e.closed).toBe(true);
    expect(Math.abs(area(e))).toBeCloseTo(Math.PI * 50, 1);
    expect(byElement(imp, 'line#l')[0]!.closed).toBe(false);
    expect(byElement(imp, 'polyline#pl')[0]!.closed).toBe(false);
    expect(byElement(imp, 'polygon#pg')[0]!.closed).toBe(true);
    expect(imp.issues.map((i) => i.code)).toEqual(['open-path']);
    expect(imp.issues[0]!.message).toMatch(/^2 open paths/);
  });

  it('approximates an ellipse within the tolerance', () => {
    const imp = importSvg(
      svg('<ellipse cx="50" cy="50" rx="40" ry="10" transform="rotate(30 50 50)"/>'),
      {
        tolerance: 0.002,
      },
    );
    const curve: Vec2[] = [];
    const a = Math.PI / 6;
    for (let i = 0; i <= 4000; i++) {
      const t = (2 * Math.PI * i) / 4000;
      const x = 40 * Math.cos(t);
      const y = 10 * Math.sin(t);
      // Rotated in the file's y-down space, then y flipped.
      curve.push([
        50 + x * Math.cos(a) - y * Math.sin(a),
        100 - (50 + x * Math.sin(a) + y * Math.cos(a)),
      ]);
    }
    expect(hausdorff(imp.contours[0]!, curve)).toBeLessThanOrEqual(0.002);
  });

  it('turns a circle under a non-uniform scale into arcs, and keeps it a circle under a rotation', () => {
    const squashed = importSvg(svg('<circle cx="10" cy="10" r="5" transform="scale(2 1)"/>'));
    expect(squashed.circles).toHaveLength(0);
    expect(squashed.contours).toHaveLength(1);
    const turned = importSvg(svg('<circle cx="10" cy="0" r="5" transform="rotate(90) scale(2)"/>'));
    expect(turned.circles).toHaveLength(1);
    expect(turned.circles[0]!.radius).toBeCloseTo(10, 12);
    expect(turned.circles[0]!.center[0]).toBeCloseTo(0, 12);
    expect(turned.circles[0]!.center[1]).toBeCloseTo(80, 12);
  });

  it('reads the page size in real units, pixels without units, and preserveAspectRatio', () => {
    // 1 inch wide, viewBox 0..10: one user unit is 2.54 mm.
    const inch = importSvg(
      svg('<rect width="10" height="10"/>', 'width="1in" height="1in" viewBox="0 0 10 10"'),
    );
    expect(inch.page!.width).toBeCloseTo(25.4, 12);
    expect(inch.bounds!.max[0]).toBeCloseTo(25.4, 12);
    // No size, no viewBox: 96 pixels to the inch, y flipped about the user origin.
    const px = importSvg(svg('<rect width="96" height="48"/>', ''));
    expect(px.page).toBeNull();
    expect(px.bounds!.min).toEqual([0, expect.closeTo(-12.7, 12)]);
    expect(px.bounds!.max[0]).toBeCloseTo(25.4, 12);
    // A square viewBox in a wide page: centred (xMidYMid meet), or stretched with "none".
    const meet = importSvg(
      svg('<rect width="10" height="10"/>', 'width="40mm" height="10mm" viewBox="0 0 10 10"'),
    );
    expect(meet.bounds!.min[0]).toBeCloseTo(15, 12);
    expect(meet.bounds!.max[0]).toBeCloseTo(25, 12);
    const none = importSvg(
      svg(
        '<rect width="10" height="10"/>',
        'width="40mm" height="10mm" viewBox="0 0 10 10" preserveAspectRatio="none"',
      ),
    );
    expect(none.bounds!.max[0]).toBeCloseTo(40, 12);
    // A viewBox alone sets the page in pixels.
    const vb = importSvg(svg('<rect width="96" height="96"/>', 'viewBox="0 0 96 96"'));
    expect(vb.page!.width).toBeCloseTo(25.4, 12);
  });

  it('follows nested transforms, nested svg, use and symbol; skips defs and hidden elements', () => {
    const imp = importSvg(
      svg(`
        <defs><rect id="sq" width="2" height="2"/></defs>
        <symbol id="sym" viewBox="0 0 1 1"><rect width="1" height="1"/></symbol>
        <g transform="translate(10 10)"><g transform="scale(2)"><use href="#sq" x="1" y="1"/></g></g>
        <use xlink:href="#sym" x="50" y="50" width="10" height="10"/>
        <svg x="70" y="70" width="20" height="20" viewBox="0 0 2 2"><rect width="1" height="1"/></svg>
        <rect width="5" height="5" display="none"/>
        <g style="fill:red; display: none"><rect width="5" height="5"/></g>
        <clipPath><rect width="99" height="99"/></clipPath>`),
    );
    const boxes = imp.contours.map((c) => {
      const xs = c.segments.map((s) => s.start[0]);
      const ys = c.segments.map((s) => s.start[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    expect(boxes).toEqual([
      [12, 84, 16, 88], // (10 + 2 * 1) .. (10 + 2 * 3), y flipped
      [50, 40, 60, 50],
      [70, 20, 80, 30],
    ]);
  });

  it('reports what it skips', () => {
    const imp = importSvg(
      svg(`
        <text x="1" y="1">Hello</text><text>again</text><image href="x.png" width="1" height="1"/>
        <path id="bad" d="M0 0 L10 0 L10 10 Z L5 x"/>
        <path d="M0 0 L5 5" transform="spin(3)"/>
        <use href="#missing"/>
        <g id="loop"><use href="#loop"/></g>
        <rect width="banana" height="5"/>`),
    );
    const codes = imp.issues.map((i) => i.code);
    // One issue per kind, with a count and examples.
    expect(codes).toEqual([
      'unsupported-element',
      'unsupported-element',
      'path-error',
      'attribute',
      'use',
      'open-path',
    ]);
    const message = (code: string) => imp.issues.find((i) => i.code === code)!.message;
    expect(message('path-error')).toMatch(/^<path#bad>: the path data has an error/);
    expect(message('attribute')).toMatch(
      /^2 attributes could not be read, for example: transform="spin\(3\)" on <path>.*; width="banana" on <rect>/,
    );
    expect(message('use')).toMatch(/^2 <use> elements were skipped, for example: .*"#missing"/);
    expect(imp.issues[0]!.message).toMatch(
      /^2 <text> elements were not imported: convert text to paths/,
    );
    // The bad path keeps its closed triangle.
    expect(byElement(imp, 'path#bad')[0]!.closed).toBe(true);
  });

  it('closes a subpath that ends at its start, and drops pieces shorter than the tolerance', () => {
    const imp = importSvg(
      svg('<path d="M0 0 L10 0 L10 10 L0.0001 0.0002 M20 20 L30 20 L30 20.0001 L30 30 L20 20 Z"/>'),
    );
    expect(imp.contours).toHaveLength(2);
    expect(imp.contours.every((c) => c.closed)).toBe(true);
    expect(imp.contours[0]!.segments).toHaveLength(3);
    expect(imp.contours[1]!.segments).toHaveLength(3);
    expectWellFormed(imp);
    expect(imp.maxDeviation).toBeLessThan(0.001);
  });

  it('refuses what is not an SVG, too much output, and bad options', () => {
    expect(() => importSvg('<html><body/></html>')).toThrow(/not <svg>/);
    expect(() => importSvg('just text')).toThrow(SvgImportError);
    const many = svg(
      Array.from({ length: 50 }, (_, i) => `<rect x="${i}" width="1" height="1"/>`).join(''),
    );
    expect(() => importSvg(many, { maxSegments: 100 })).toThrow(/more than 100 lines and arcs/);
    expect(() => importSvg(many, { scale: 0 })).toThrow(RangeError);
    expect(() => importSvg(many, { tolerance: Number.NaN })).toThrow(RangeError);
  });

  it('reads back what writeSvg writes', () => {
    const text = writeSvg({
      layers: [{ name: 'cut' }],
      items: [
        {
          kind: 'path',
          layer: 'cut',
          closed: true,
          segments: [
            { kind: 'line', a: [0, 0], b: [40, 0] },
            { kind: 'arc', center: [40, 10], radius: 10, start: -Math.PI / 2, end: Math.PI / 2 },
            { kind: 'line', a: [40, 20], b: [0, 20] },
          ],
        },
        {
          kind: 'path',
          layer: 'cut',
          segments: [{ kind: 'arc', center: [20, 10], radius: 3, start: 0, end: 2 * Math.PI }],
        },
      ],
    });
    const imp = placeSvgImport(importSvg(text), 'bottom-left', [0, 0]);
    expectWellFormed(imp);
    const [plate, hole] = imp.contours;
    expect(plate!.closed).toBe(true);
    expect(plate!.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line', 'line']);
    const arc = plate!.segments[1]!;
    expect(arc.kind === 'arc' && arc.center[0]).toBeCloseTo(40, 6);
    expect(arc.kind === 'arc' && arc.center[1]).toBeCloseTo(10, 6);
    expect(Math.abs(area(plate!))).toBeCloseTo(800 + 50 * Math.PI, 2);
    // A full circle is written as two half arcs: a closed contour of two arcs.
    expect(hole!.closed).toBe(true);
    expect(hole!.segments.map((s) => s.kind)).toEqual(['arc', 'arc']);
  });

  it('imports a real drawing (the bracket golden) without errors', () => {
    const imp = importSvg(BRACKET);
    expectWellFormed(imp);
    expect(imp.contours.length + imp.circles.length).toBeGreaterThan(20);
    expect(imp.issues.find((i) => i.code === 'unsupported-element')?.message).toMatch(/<text>/);
  });
});

describe('placeSvgImport', () => {
  const imp = importSvg(LETTERS);
  it('moves the page corner, the bottom left or the centre onto the point', () => {
    const page = placeSvgImport(imp, 'page', [100, 200]);
    expect(page.circles[0]!.center).toEqual([212, 210]);
    const corner = placeSvgImport(imp, 'bottom-left', [0, 0]);
    expect(corner.bounds!.min[0]).toBeCloseTo(0, 12);
    expect(corner.bounds!.min[1]).toBeCloseTo(0, 12);
    const centre = placeSvgImport(imp, 'center', [0, 0]);
    expect(centre.bounds!.min[0]).toBeCloseTo(-55, 1);
    expect(centre.bounds!.max[1]).toBeCloseTo(20, 1);
    expectWellFormed(centre);
    // Arcs move with their centres.
    const arc = (i: SvgImport) =>
      byElement(i, 'path#B')[0]!.segments.find((s) => s.kind === 'arc')!;
    const a = arc(imp);
    const b = arc(page);
    expect(b.kind === 'arc' && a.kind === 'arc' && b.center[0] - a.center[0]).toBeCloseTo(100, 12);
  });
});

describe('svgOutlinePaths: exact paths for a sketch outline', () => {
  it('keeps Beziers and lines exact, maps them to millimetres, and records fill rules', () => {
    const parsed = parseSvg(LETTERS);
    const out = svgOutlinePaths(parsed);
    expect(out.paths.map((p) => p.element)).toEqual(['path#O', 'path#A', 'path#B', 'circle#dot']);
    expect(out.paths.every((p) => p.fillRule === 'evenodd')).toBe(true);
    const o = out.paths[0]!.commands;
    expect(o[0]).toEqual({ kind: 'moveTo', to: [34, 25] });
    expect(o[1]).toEqual({
      kind: 'cubicTo',
      control1: [34, 50 - 36.046],
      control2: [27.732, 5],
      to: [20, 5],
    });
    expect(o.filter((c) => c.kind === 'close')).toHaveLength(2);
    // The A after its group's translate: lines only.
    const a = out.paths[1]!.commands;
    expect(a[1]).toEqual({ kind: 'lineTo', to: [51, 45] });
    expect(a.every((c) => c.kind !== 'cubicTo' && c.kind !== 'quadTo')).toBe(true);
    // Bounds: the O's Beziers reach x = 6 exactly (an extreme between control points).
    expect(out.bounds!.min[0]).toBeCloseTo(6, 9);
    expect(out.bounds!.max[0]).toBeCloseTo(116, 9);
    expect(out.commands).toBe(out.paths.reduce((n, p) => n + p.commands.length, 0));
  });

  it('reads a word converted to paths: quadratic outlines under flipping transforms', () => {
    const out = svgOutlinePaths(parseSvg(WORD));
    expect(out.paths).toHaveLength(8);
    // Every letter but the H has curves.
    expect(out.paths.filter((p) => p.commands.some((c) => c.kind === 'quadTo'))).toHaveLength(7);
    // Cap height 20 mm on a 5 mm baseline margin: the letters stand between y 5 and about 25.
    expect(out.bounds!.min[1]).toBeGreaterThan(4);
    expect(out.bounds!.max[1]).toBeGreaterThan(24);
    expect(out.bounds!.max[1]).toBeLessThan(26);
  });

  it('turns elliptical arcs into cubics within the tolerance', () => {
    const text = svg('<ellipse cx="50" cy="50" rx="40" ry="10" transform="rotate(30 50 50)"/>');
    for (const tol of [0.01, 0.001, 0.00001]) {
      const out = svgOutlinePaths(parseSvg(text), { tolerance: tol });
      const cmds = out.paths[0]!.commands;
      let worst = 0;
      let at: Vec2 = [0, 0];
      for (const c of cmds) {
        if (c.kind === 'cubicTo') {
          for (const p of cubic(at, c.control1, c.control2, c.to, 200)) {
            // Back to the ellipse's frame: undo the flip, the rotation and the centre.
            const x = p[0] - 50;
            const y = 100 - p[1] - 50;
            const r = Math.PI / 6;
            const u = x * Math.cos(r) + y * Math.sin(r);
            const v = -x * Math.sin(r) + y * Math.cos(r);
            // Distance to the ellipse, near enough: the radial error of (u/40, v/10) times the radius.
            const e = Math.hypot(u / 40, v / 10);
            const t = Math.atan2(v / 10, u / 40);
            worst = Math.max(
              worst,
              Math.abs(e - 1) * Math.hypot(40 * Math.cos(t), 10 * Math.sin(t)),
            );
          }
        }
        if (c.kind !== 'close') at = c.to;
      }
      expect(worst).toBeLessThanOrEqual(tol);
      expect(cmds.filter((c) => c.kind === 'cubicTo').length).toBeGreaterThanOrEqual(4);
    }
  });

  it('reads fill-rule from attributes and styles, inherited', () => {
    const parsed = parseSvg(
      svg(`<g fill-rule="evenodd"><path id="a" d="M0 0 H1 V1 Z"/>
           <path id="b" style="fill-rule: nonzero" d="M0 0 H1 V1 Z"/></g>
           <path id="c" d="M0 0 H1 V1 Z"/>`),
    );
    expect(parsed.shapes.map((s) => s.fillRule)).toEqual(['evenodd', 'nonzero', 'nonzero']);
  });

  it('parses once: fitting and placing again need no parse', () => {
    const parsed = parseSvg(LETTERS);
    const a = fitSvg(parsed, { scale: 1 });
    const b = fitSvg(parsed, { scale: 2 });
    expect(b.circles[0]!.radius).toBeCloseTo(2 * a.circles[0]!.radius, 12);
    expect(fitSvg(parsed)).toEqual(importSvg(LETTERS));
  });
});

describe('importSvg: hostile files', () => {
  it('stops a <use> fan-out whose leaves draw nothing', () => {
    // Eight levels, each using the one below ten times: 10^8 visits if nothing stopped it.
    let body = '<g id="l0"><g/></g>';
    for (let i = 1; i <= 8; i++) {
      body += `<g id="l${i}">${Array.from({ length: 10 }, () => `<use href="#l${i - 1}"/>`).join('')}</g>`;
    }
    const text = svg(`<defs>${body}</defs><use href="#l8"/>`);
    const t0 = performance.now();
    expect(() => parseSvg(text)).toThrow(/more than [\d,]+ elements \(counting each <use>/);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('refuses deep nesting before it overflows the stack', () => {
    const deep = '<g>'.repeat(10_000) + '</g>'.repeat(10_000);
    expect(() => parseSvg(svg(deep))).toThrow(/nests elements more than/);
  });

  it('refuses too many elements and too large a file', () => {
    const many = svg('<g/>'.repeat(MAX_SVG_ELEMENTS + 1));
    expect(() => parseSvg(many)).toThrow(/more than 200,000 elements/);
    const big = ' '.repeat(MAX_SVG_CHARS + 1);
    try {
      parseSvg(big);
      expect.unreachable();
    } catch (e) {
      expect((e as SvgImportError).code).toBe('too-large');
    }
  });

  it('takes no unit from the object prototype', () => {
    const imp = importSvg(
      svg('<rect x="1constructor" width="10" height="10"/><circle r="1__proto__"/>'),
    );
    expect(imp.issues.map((i) => i.code)).toEqual(['attribute']);
    expect(imp.issues[0]!.message).toMatch(/^2 attributes could not be read/);
    expect(imp.contours).toHaveLength(1);
    expect(parseLength('1constructor')).toBeNull();
    expect(parseLength('1toString')).toBeNull();
  });

  it('drops what is not finite, with an issue, and never loops on it', () => {
    const cases = [
      '<polygon id="p" points="0,0 10,0 1e999,5"/>',
      '<rect width="10" height="10" transform="scale(1e200) scale(1e200)"/>',
      '<circle r="1e300" transform="scale(1e10)"/>',
      '<path d="M0 0 l1e308 0 l1e308 0 l0 1 z"/>',
      '<path d="M0 0 A1e300 1e300 0 0 1 10 0 Z"/>',
    ];
    for (const body of cases) {
      const t0 = performance.now();
      const imp = importSvg(svg(body));
      const out = svgOutlinePaths(parseSvg(svg(body)));
      expect(performance.now() - t0, body).toBeLessThan(2000);
      for (const c of imp.contours)
        for (const g of c.segments)
          expect([...g.start, ...g.end].every(Number.isFinite), body).toBe(true);
      for (const c of imp.circles) expect(Number.isFinite(c.radius), body).toBe(true);
      for (const p of out.paths)
        for (const c of p.commands)
          if (c.kind !== 'close') expect(c.to.every(Number.isFinite), body).toBe(true);
    }
    // A viewBox that overflows is ignored, and so is a transform that does.
    expect(
      importSvg(svg('<rect width="1" height="1"/>', 'viewBox="0 0 1e999 1e999"')).page,
    ).toBeNull();
    const big = importSvg(
      svg('<rect width="10" height="10" transform="scale(1e200) scale(1e200)"/>'),
    );
    expect(big.issues.map((i) => i.code)).toContain('attribute');
    // A scale that overflows the fit drops the shapes, with a not-finite issue.
    const huge = importSvg(svg('<rect width="10" height="10"/>'), { scale: 1e307 });
    expect(huge.contours).toEqual([]);
    expect(huge.issues.map((i) => i.code)).toContain('not-finite');
  });

  it('reports a path error once however often the path is used', () => {
    const imp = importSvg(
      svg('<defs><path id="p" d="M0 0 L10 0 L10 10 Z x"/></defs>' + '<use href="#p"/>'.repeat(5)),
    );
    expect(imp.issues.filter((i) => i.code === 'path-error')).toHaveLength(1);
  });

  it('reports a root transform it cannot read', () => {
    const imp = importSvg(svg('<rect width="1" height="1"/>', 'transform="spin(1)"'));
    expect(imp.issues.map((i) => i.code)).toEqual(['attribute']);
  });

  it('stays linear on long runs of whitespace', () => {
    const spaces = ' '.repeat(100_000);
    const t0 = performance.now();
    expect(parseTransform(`translate(1)${spaces}x`)).toBeNull();
    expect(parseTransform(`${spaces},${spaces}translate(1)`)).not.toBeNull();
    expect(parseLength(`1${spaces}mm${spaces}x`)).toBeNull();
    expect(parseLength(`1${spaces}mm`)).toBeCloseTo(96 / 25.4, 12);
    importSvg(
      svg(
        '<rect width="1" height="1"/>',
        `width="1${spaces}mm${spaces}!" style="display${spaces}: inline"`,
      ),
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("reads each element's attributes once, however often <use> draws it", () => {
    const mb = 1024 * 1024;
    // 1,000 visits of one path: ten uses of ten uses of ten uses.
    const fanOut = (leaf: string) =>
      `<defs>${leaf}` +
      `<g id="a">${'<use href="#p"/>'.repeat(10)}</g>` +
      `<g id="b">${'<use href="#a"/>'.repeat(10)}</g></defs>` +
      '<use href="#b"/>'.repeat(10);
    const style = `fill-rule:evenodd;${'stroke:none;'.repeat(mb / 12)}`;
    const transform = 'translate(0.001) '.repeat(mb / 17);
    const spaces = ' '.repeat(mb);
    const cases: [string, string][] = [
      ['style', `<path id="p" style="${style}" d="M0 0 L1 0 L1 1 Z"/>`],
      ['transform', `<path id="p" transform="${transform}" d="M0 0 L1 0 L1 1 Z"/>`],
      ['length', `<rect id="p" x="1${spaces}" width="1" height="1"/>`],
      ['bad length', `<rect id="p" x="1${spaces}x" width="1" height="1"/>`],
      ['points', `<polygon id="p" points="0 0 1 0 1 1${spaces}"/>`],
      ['viewBox', `<svg id="p" viewBox="0 0 1 1${spaces}"><rect width="1" height="1"/></svg>`],
    ];
    for (const [what, leaf] of cases) {
      const t0 = performance.now();
      const parsed = parseSvg(svg(fanOut(leaf)));
      expect(performance.now() - t0, what).toBeLessThan(2000);
      expect(parsed.shapes, what).toHaveLength(1000);
      if (what === 'style') expect(parsed.shapes[0]!.fillRule).toBe('evenodd');
    }
    // A long href (trimmed, so it names the rect) on a <use> drawn many times is read once too.
    const t0 = performance.now();
    const named = parseSvg(
      svg(
        `<defs><rect id="r" width="1" height="1"/>` +
          `<g id="a">${`<use href="#r${spaces}"/>`.repeat(10)}</g></defs>` +
          '<use href="#a"/>'.repeat(100),
      ),
    );
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(named.shapes).toHaveLength(1000);
  });

  it('bounds outline paths while it makes them: arcs reused under a huge scale', () => {
    // 10,000 arcs, each a full circle in two halves, drawn 20 times.
    const arcs = 'M0 0 ' + 'a1 1 0 1 1 2 0 a1 1 0 1 1 -2 0 '.repeat(5000);
    const file = (scale: string) =>
      svg(
        `<defs><path id="p" d="${arcs}"/></defs>` +
          `<g transform="scale(${scale})">${'<use href="#p"/>'.repeat(20)}</g>`,
      );
    const caps = { maxCommands: 100_000, maxCoordinate: 1e6 };
    const refusal = (scale: string, options: Parameters<typeof svgOutlinePaths>[1]) => {
      const parsed = parseSvg(file(scale));
      const heap = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      let error: unknown = null;
      try {
        svgOutlinePaths(parsed, options);
      } catch (e) {
        error = e;
      }
      const ms = performance.now() - t0;
      const grown = process.memoryUsage().heapUsed - heap;
      expect(ms, scale).toBeLessThan(2000);
      expect(grown, scale).toBeLessThan(256 * 1024 * 1024);
      expect(error, scale).toBeInstanceOf(SvgImportError);
      return error as SvgImportError;
    };
    // Past the coordinate bound: refused at the first arc's ends, before it is split.
    const far = refusal('1e12', caps);
    expect([far.code, far.limit]).toEqual(['out-of-range', 'coordinates']);
    // Within range but too many cubics: stopped as soon as the cap is passed.
    const many = refusal('1000', caps);
    expect([many.code, many.limit]).toEqual(['too-complex', 'commands']);
    // With no coordinate bound, the command cap alone stops it.
    const unbounded = refusal('1e12', { maxCommands: 100_000 });
    expect([unbounded.code, unbounded.limit]).toEqual(['too-complex', 'commands']);
    // The same artwork at scale 1 is well within the caps... once.
    const once = svgOutlinePaths(
      parseSvg(svg(`<path d="${'M0 0 ' + 'a1 1 0 1 1 2 0 a1 1 0 1 1 -2 0 '.repeat(50)}"/>`)),
      caps,
    );
    expect(once.commands).toBeLessThanOrEqual(1 + 100 * 4);
    // And a cap on paths, checked before the next path is made.
    expect(() =>
      svgOutlinePaths(parseSvg(svg('<rect width="1" height="1"/>'.repeat(3))), { maxPaths: 2 }),
    ).toThrow(expect.objectContaining({ code: 'too-complex', limit: 'paths' }));
  });

  it('groups issues: many bad elements make a few short messages', () => {
    const n = 100_000;
    const long = 'x'.repeat(10_000);
    const bodies = [
      // Path data errors, each with its own long id.
      Array.from({ length: n }, (_, i) => `<path id="a${i}${long.slice(0, 50)}" d="X"/>`),
      // Bad lengths and transforms, all different.
      Array.from({ length: n / 2 }, (_, i) => `<rect width="${i}q${i}" height="1"/>`).concat(
        Array.from({ length: n / 2 }, (_, i) => `<g transform="spin(${i})"/>`),
      ),
      // <use> elements naming nothing, all different.
      Array.from({ length: n }, (_, i) => `<use href="#missing${i}${long.slice(0, 50)}"/>`),
    ];
    for (const body of bodies) {
      const t0 = performance.now();
      const parsed = parseSvg(svg(body.join('')));
      expect(performance.now() - t0).toBeLessThan(5000);
      expect(parsed.issues).toHaveLength(1);
      const text = parsed.issues.map((i) => i.message).join('');
      expect(text.length).toBeLessThan(1000);
      expect(text).toMatch(
        /^100,000 (attributes|elements|<use> elements) .*, for example: .*; and 99,997 more\.$/,
      );
    }
    // A long id is cut wherever it is quoted.
    const one = parseSvg(svg(`<path id="${long}" d="M0 0 L1 0 L1 1 Z x"/>`));
    expect(one.issues[0]!.message.length).toBeLessThan(200);
    expect(one.shapes[0]!.element.length).toBeLessThanOrEqual(43);
  });
});
