import { describe, expect, it } from 'vitest';
import { angleAbout, arcSweep, radiusAbout } from '../arc';
import type { Move, Toolpath } from '../ir';
import { isMove } from '../ir';
import { flattenSegments } from '../offset/flatten';
import { distToLoops, loopArea, pointInLoops } from '../offset/geometry';
import { circle, hole, polygon, rect, rng, slot } from '../offset/test-shapes';
import type { ArcSegment2, LineSegment2, Loop2, Segment2, Setup, Tool, Vec2, Vec3 } from '../types';
import { validateToolpath } from '../validate';
import { reverseLoop } from '../wcs';
import { registerBuiltinOperations } from '../worker/builtin';
import { CamCancelled, OperationRegistry, type OperationContext } from '../worker/registry';
import {
  OutlineDistance,
  VCARVE_SAFE_ABOVE,
  generateVCarve,
  generateVCarveClearing,
  generateVCarveClearingOperation,
  vcarveLinkAllowed,
  type VCarveOperation,
} from './vcarve';

const deg = (d: number): number => (d * Math.PI) / 180;

/** A 1/2" 90 degree V-bit (Carbide 3D #301). */
const vbit90: Tool = {
  id: 'tool#1',
  name: '90 deg V-bit',
  kind: 'vbit',
  diameter: 12.7,
  fluteLength: 12,
  flutes: 2,
  angle: deg(90),
};

/** A 1/2" 60 degree V-bit (Carbide 3D #302). */
const vbit60: Tool = { ...vbit90, id: 'tool#2', name: '60 deg V-bit', angle: deg(60) };

const flat6: Tool = {
  id: 'tool#3',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
};

const feeds = { spindle: 18000, cut: 1000, plunge: 300 };

function vcarve(over: Partial<VCarveOperation> = {}): VCarveOperation {
  return {
    kind: 'vcarve',
    id: 'vcarve#1',
    name: 'Lettering',
    tool: vbit90,
    feeds,
    loops: [slot([20, 10], 30, 6)],
    top: 0,
    ...over,
  };
}

const baseSetup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [-50, -50, -12], max: [350, 250, 0] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};

function context(setup: Setup = baseSetup, checkpoints = { count: 0 }): OperationContext {
  return {
    generation: 1,
    cancelled: false,
    setup,
    checkpoint: () => {
      checkpoints.count++;
      return Promise.resolve();
    },
  };
}

/** Generates, checks the IR validator (bar what linking adds), and returns the result. */
async function run(op: VCarveOperation, setup: Setup = baseSetup) {
  const result = await generateVCarve(op, context(setup));
  if (!result.ok) throw new Error(result.error.message);
  const issues = validateToolpath(result.value.toolpath).filter(
    (i) => i.code !== 'no-tool' && i.code !== 'spindle-off',
  );
  expect(issues).toEqual([]);
  return result.value;
}

/** Each move with the position it starts from. */
function withStarts(tp: Toolpath): { from: Vec3; move: Move }[] {
  let pos = tp.start;
  const out: { from: Vec3; move: Move }[] = [];
  for (const e of tp.entries) {
    if (!isMove(e)) continue;
    out.push({ from: pos, move: e });
    pos = e.to;
  }
  return out;
}

/** Points along a move in XY, about every `step` mm (arcs sampled along the arc). */
function samplesOf(from: Vec3, m: Move, step: number): Vec3[] {
  if (m.kind !== 'arc') {
    const len = Math.hypot(m.to[0] - from[0], m.to[1] - from[1], m.to[2] - from[2]);
    const n = Math.max(1, Math.ceil(len / step));
    return Array.from({ length: n + 1 }, (_, k): Vec3 => [
      from[0] + ((m.to[0] - from[0]) * k) / n,
      from[1] + ((m.to[1] - from[1]) * k) / n,
      from[2] + ((m.to[2] - from[2]) * k) / n,
    ]);
  }
  const sweep =
    (m.fullCircle ? 2 * Math.PI : arcSweep({ ...m, start: from, end: m.to })) *
    (m.direction === 'ccw' ? 1 : -1);
  const a0 = angleAbout(m.center, from);
  const r = radiusAbout(m.center, from);
  const n = Math.max(8, Math.ceil((Math.abs(sweep) * r) / step));
  return Array.from({ length: n + 1 }, (_, k): Vec3 => {
    const a = a0 + (sweep * k) / n;
    return [
      m.center[0] + r * Math.cos(a),
      m.center[1] + r * Math.sin(a),
      from[2] + ((m.to[2] - from[2]) * k) / n,
    ];
  });
}

interface CutTool {
  /** Radius of the cutting part, mm. */
  readonly r: number;
  /** Flat tip radius, mm (the whole radius for a flat end mill). */
  readonly tip: number;
  /** tan of the half angle (unused for a flat end mill). */
  readonly tan: number;
}

const vTool = (t: Tool): CutTool => ({
  r: t.diameter / 2,
  tip: (t.tipDiameter ?? 0) / 2,
  tan: Math.tan(t.angle! / 2),
});
const flatTool = (t: Tool): CutTool => ({ r: t.diameter / 2, tip: t.diameter / 2, tan: 1 });

/**
 * A heightmap material-removal simulation over the box `[x0, y0]` to `[x1, y1]` (cells of `cell`
 * mm, material starting at `top`), for V-bits and flat end mills: every feed move lowers the cells
 * under the tool's cone to its surface there. Every rapid is checked against the material left at
 * that moment. Programs run in order on the same material.
 */
class Heightmap {
  readonly nx: number;
  readonly ny: number;
  readonly h: Float64Array;
  /** How far the worst rapid ran below the material, mm. */
  rapidBelow = 0;

  constructor(
    readonly x0: number,
    readonly y0: number,
    x1: number,
    y1: number,
    readonly cell: number,
    readonly top: number,
  ) {
    this.nx = Math.ceil((x1 - x0) / cell) + 1;
    this.ny = Math.ceil((y1 - y0) / cell) + 1;
    this.h = new Float64Array(this.nx * this.ny).fill(top);
  }

  at(i: number, j: number): Vec2 {
    return [this.x0 + i * this.cell, this.y0 + j * this.cell];
  }

  /**
   * Calls `f` for every cell the tool can touch on the straight move from `a` to `b`, with the
   * lowest the tool's surface comes over that cell during the move. The surface over a cell is
   * convex along the move, so its minimum is at an end, at the tip circle's edge or where the
   * cone's slope balances the move's: exact, with no sampling along the move.
   */
  private sweep(a: Vec3, b: Vec3, tool: CutTool, f: (k: number, surface: number) => void): void {
    const reachAt = (z: number): number =>
      tool.tip >= tool.r ? tool.r : Math.min(tool.r, tool.tip + (this.top - z) * tool.tan);
    const reach = Math.max(reachAt(a[2]), reachAt(b[2]));
    if (reach < 0) return;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const L = Math.hypot(dx, dy);
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - reach - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.ceil((Math.max(a[0], b[0]) + reach - this.x0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.ceil((Math.max(a[1], b[1]) + reach - this.y0) / c));
    const flat = tool.tip >= tool.r;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const px = this.x0 + i * c - a[0];
        const py = this.y0 + j * c - a[1];
        // Along-move and across-move coordinates of the cell, mm.
        const u = L > 0 ? (px * dx + py * dy) / L : 0;
        const v = L > 0 ? Math.abs(px * dy - py * dx) / L : Math.hypot(px, py);
        if (v > reach) continue;
        const rho = (s: number): number => (L > 0 ? Math.hypot(s * L - u, v) : v);
        const g = (s: number): number => {
          const r = rho(s);
          const z = a[2] + dz * s;
          if (r > reachAt(z) + 1e-12) return Infinity;
          return flat || r <= tool.tip ? z : z + (r - tool.tip) / tool.tan;
        };
        const cands = [0, 1];
        if (L > 0) {
          if (v < tool.tip) {
            const h = Math.sqrt(tool.tip * tool.tip - v * v);
            cands.push((u - h) / L, (u + h) / L);
          }
          const k = flat ? 0 : Math.abs(dz) * tool.tan;
          if (!flat && L > k) {
            // d/ds [dz s + rho(s) / tan] = 0: (sL - u) = -sign(dz) k v / sqrt(L^2 - k^2).
            const w = (-Math.sign(dz) * k * v) / Math.sqrt(L * L - k * k);
            cands.push((u + w) / L);
          }
          cands.push(u / L);
        }
        let best = Infinity;
        for (const s of cands) if (s >= 0 && s <= 1) best = Math.min(best, g(s));
        if (best < Infinity) f(i * this.ny + j, best);
      }
    }
  }

  run(tp: Toolpath, tool: CutTool): void {
    for (const { from, move } of withStarts(tp)) {
      // Arcs as fine chords (the V-carve's arcs are level rings).
      const pts = move.kind === 'arc' ? samplesOf(from, move, this.cell / 4) : [from, move.to];
      for (let n = 0; n + 1 < pts.length; n++) {
        if (move.kind === 'rapid') {
          this.sweep(pts[n]!, pts[n + 1]!, tool, (k, s) => {
            this.rapidBelow = Math.max(this.rapidBelow, this.h[k]! - s);
          });
        } else {
          this.sweep(pts[n]!, pts[n + 1]!, tool, (k, s) => {
            if (this.h[k]! > s) this.h[k] = s;
          });
        }
      }
    }
  }

  /**
   * Compares the cut with the ideal V-carve of `loops`: depth `min(maxDepth, d / tan)` at distance
   * d inside the outline, nothing outside. Returns the worst gouge (cut deeper than the ideal) and
   * the worst uncut depth (left above it), mm, with where they are.
   */
  compare(loops: readonly Loop2[], tan: number, maxDepth: number) {
    const polys = loops.map((l) => flattenSegments(l.segments, true, 0.001));
    let gouge = 0;
    let uncut = 0;
    let gougeAt: Vec2 = [0, 0];
    let uncutAt: Vec2 = [0, 0];
    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < this.ny; j++) {
        const p = this.at(i, j);
        const inside = pointInLoops(p, polys);
        const ideal = inside
          ? this.top - Math.min(maxDepth, distToLoops(p, loops) / tan)
          : this.top;
        const h = this.h[i * this.ny + j]!;
        if (ideal - h > gouge) {
          gouge = ideal - h;
          gougeAt = p;
        }
        if (h - ideal > uncut) {
          uncut = h - ideal;
          uncutAt = p;
        }
      }
    }
    return { gouge, uncut, gougeAt, uncutAt };
  }

  /** The cut height at the cell nearest `p`. */
  heightAt(p: Vec2): number {
    const i = Math.round((p[0] - this.x0) / this.cell);
    const j = Math.round((p[1] - this.y0) / this.cell);
    return this.h[i * this.ny + j]!;
  }
}

function boundsOf(loops: readonly Loop2[], margin: number): [number, number, number, number] {
  const pts = loops.flatMap((l) => flattenSegments(l.segments, true, 0.01));
  return [
    Math.min(...pts.map((p) => p[0])) - margin,
    Math.min(...pts.map((p) => p[1])) - margin,
    Math.max(...pts.map((p) => p[0])) + margin,
    Math.max(...pts.map((p) => p[1])) + margin,
  ];
}

function simulate(tp: Toolpath, op: VCarveOperation, cell: number): Heightmap {
  const [x0, y0, x1, y1] = boundsOf(op.loops, 2);
  const map = new Heightmap(x0, y0, x1, y1, cell, op.top);
  map.run(tp, vTool(op.tool));
  return map;
}

/** Every feed move's points, sampled. */
function feedPoints(tp: Toolpath): Vec3[] {
  return withStarts(tp)
    .filter(({ move }) => move.kind !== 'rapid')
    .flatMap(({ from, move }) => samplesOf(from, move, 0.05));
}

// ---------------------------------------------------------------------------------------------
// Lettering: "O", "A", "B" and a dot, from the T5.8 SVG fixture (packages/io/src/fixtures/svg/
// letters.svg), with the SVG's y axis flipped. The O's Beziers are an ellipse, here a polygon.

const line = (start: Vec2, end: Vec2): LineSegment2 => ({ kind: 'line', start, end });
const arc = (start: Vec2, end: Vec2, center: Vec2, ccw: boolean): ArcSegment2 => ({
  kind: 'arc',
  start,
  end,
  center,
  ccw,
});

/** Flips the SVG's y (the viewBox is 50 high) and orients the loop as `ccw` asks. */
function svgLoop(segments: Segment2[], ccw: boolean): Loop2 {
  const f = (p: Vec2): Vec2 => [p[0], 50 - p[1]];
  const flipped: Loop2 = {
    segments: segments.map((s): Segment2 =>
      s.kind === 'line'
        ? line(f(s.start), f(s.end))
        : arc(f(s.start), f(s.end), f(s.center), !s.ccw),
    ),
  };
  return loopArea(flipped) > 0 === ccw ? flipped : reverseLoop(flipped);
}

const lines = (pts: Vec2[]): Segment2[] => polygon(pts).segments.slice();

function ellipse(c: Vec2, rx: number, ry: number, n: number): Vec2[] {
  return Array.from({ length: n }, (_, k): Vec2 => {
    const a = (2 * Math.PI * k) / n;
    return [c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)];
  });
}

function letters(): Loop2[] {
  const A = (pts: Vec2[]): Vec2[] => pts.map((p) => [p[0] + 40, p[1]]);
  const B = (x: number): number => x + 75;
  return [
    // O
    svgLoop(lines(ellipse([20, 25], 14, 20, 96)), true),
    svgLoop(lines(ellipse([20, 25], 7, 12, 64)), false),
    // A
    svgLoop(
      lines(
        A([
          [0, 45],
          [11, 5],
          [19, 5],
          [30, 45],
          [23, 45],
          [20.5, 35],
          [9.5, 35],
          [7, 45],
        ]),
      ),
      true,
    ),
    svgLoop(
      lines(
        A([
          [11.5, 28],
          [15, 13],
          [18.5, 28],
        ]),
      ),
      false,
    ),
    // B: in the SVG, arcs with sweep-flag 1 run clockwise on screen, so counter-clockwise in y-up
    // terms before the flip, which `svgLoop` turns round.
    svgLoop(
      [
        line([B(0), 5], [B(14), 5]),
        arc([B(14), 5], [B(14), 24], [B(14), 14.5], true),
        line([B(14), 24], [B(15), 24]),
        arc([B(15), 24], [B(15), 45], [B(15), 34.5], true),
        line([B(15), 45], [B(0), 45]),
        line([B(0), 45], [B(0), 5]),
      ],
      true,
    ),
    svgLoop(
      [
        line([B(7), 11], [B(13), 11]),
        arc([B(13), 11], [B(13), 18], [B(13), 14.5], true),
        line([B(13), 18], [B(7), 18]),
        line([B(7), 18], [B(7), 11]),
      ],
      false,
    ),
    svgLoop(
      [
        line([B(7), 29], [B(14), 29]),
        arc([B(14), 29], [B(14), 39], [B(14), 34], true),
        line([B(14), 39], [B(7), 39]),
        line([B(7), 39], [B(7), 29]),
      ],
      false,
    ),
    // The dot.
    circle([112, 10], 4),
  ];
}

// ---------------------------------------------------------------------------------------------

describe('V-carve: depth follows the width', () => {
  it('carves a slot of width w with a 90 degree bit to w / 2 along its centre', async () => {
    const w = 6;
    const op = vcarve({ loops: [slot([20, 10], 30, w)] });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const cuts = feedPoints(toolpath);
    expect(Math.min(...cuts.map((p) => p[2]))).toBeCloseTo(-w / 2, 3);
    // The centre line, end centre to end centre, is cut to w / 2.
    const map = simulate(toolpath, op, 0.1);
    for (let x = 5; x <= 35; x += 0.5) {
      expect(map.heightAt([x, 10])).toBeCloseTo(-w / 2, 2);
    }
    const cmp = map.compare(op.loops, 1, Infinity);
    expect(cmp.gouge).toBeLessThan(0.01);
    expect(cmp.uncut).toBeLessThan(0.01);
    expect(map.rapidBelow).toBeLessThan(1e-9);
  });

  it('carves a straight slot with a 60 degree bit to (w / 2) / tan(30 degrees)', async () => {
    const op = vcarve({ tool: vbit60, loops: [rect(0, 0, 40, 5)] });
    const { toolpath } = await run(op);
    const map = simulate(toolpath, op, 0.1);
    const depth = 2.5 / Math.tan(deg(30));
    for (let x = 5; x <= 35; x += 1) expect(map.heightAt([x, 2.5])).toBeCloseTo(-depth, 2);
    const cmp = map.compare(op.loops, Math.tan(deg(30)), Infinity);
    expect(cmp.gouge).toBeLessThan(0.01);
    expect(cmp.uncut).toBeLessThan(0.01);
  });

  it("carves a rectangle's corners right into the corner", async () => {
    const op = vcarve({ loops: [rect(0, 0, 20, 10)] });
    const { toolpath } = await run(op);
    const map = simulate(toolpath, op, 0.05);
    const cmp = map.compare(op.loops, 1, Infinity);
    expect(cmp.gouge).toBeLessThan(0.01);
    expect(cmp.uncut).toBeLessThan(0.01);
    // The tool tip reaches each corner (to within a cell), so the carve's outline is sharp there.
    const tips = feedPoints(toolpath);
    for (const c of [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ] as const) {
      expect(Math.min(...tips.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])))).toBeLessThan(0.05);
      // A point on the bisector 0.3 mm in is cut 0.3 / sqrt 2 deep (its distance to the walls).
      const s = 0.3 / Math.SQRT2;
      const p: Vec2 = [c[0] + (c[0] === 0 ? s : -s), c[1] + (c[1] === 0 ? s : -s)];
      expect(map.heightAt(p)).toBeLessThan(-s + 0.02);
    }
    // Along the long sides of the centre line, depth 5 (the half width).
    expect(map.heightAt([10, 5])).toBeCloseTo(-5, 2);
  });

  it('accounts for a flat tip: the centre is (w / 2 - tip radius) / tan deep', async () => {
    const tool: Tool = { ...vbit90, tipDiameter: 0.5 };
    const op = vcarve({ tool, loops: [rect(0, 0, 40, 6)] });
    const { toolpath } = await run(op);
    const cuts = feedPoints(toolpath);
    expect(Math.min(...cuts.map((p) => p[2]))).toBeCloseTo(-(3 - 0.25), 3);
    const map = simulate(toolpath, op, 0.05);
    // The tip never takes the carve wider than the outline.
    const cmp = map.compare(op.loops, 1, Infinity);
    expect(cmp.gouge).toBeLessThan(0.01);
    expect(map.heightAt([20, 3])).toBeCloseTo(-2.75, 2);
  });

  it('carves the lettering fixture to the ideal V-carve surface', async () => {
    const op = vcarve({ loops: letters() });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const map = simulate(toolpath, op, 0.1);
    const cmp = map.compare(op.loops, 1, Infinity);
    expect(cmp.gouge).toBeLessThan(0.006);
    expect(cmp.uncut).toBeLessThan(0.02);
    expect(map.rapidBelow).toBeLessThan(1e-9);
    // Every letter is reached: the dot is carved to its 4 mm radius at its centre.
    expect(map.heightAt([112, 10])).toBeCloseTo(-4, 1);
  });
});

describe('V-carve: maximum depth and the flat floor', () => {
  it('stops at the maximum depth and clears the floor with the V-bit', async () => {
    const op = vcarve({ loops: [rect(0, 0, 30, 16)], maxDepth: 2 });
    const { toolpath, warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toEqual(['flat-floor']);
    const cuts = feedPoints(toolpath);
    expect(Math.min(...cuts.map((p) => p[2]))).toBeCloseTo(-2, 6);
    const map = simulate(toolpath, op, 0.1);
    const cmp = map.compare(op.loops, 1, 2);
    expect(cmp.gouge).toBeLessThan(0.01);
    // Ridges between the floor rings: at most VCARVE_FLAT_RIDGE (0.2 mm) by default.
    expect(cmp.uncut).toBeLessThan(0.21);
  });

  it('warns that the bit cannot go deeper than its cone, and carves flat there', async () => {
    // 30 mm wide: the 12.7 mm 90 degree bit reaches 6.35 mm deep at most.
    const op = vcarve({ loops: [rect(0, 0, 40, 30)] });
    const { toolpath, warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toEqual(['tool-depth-limit', 'flat-floor']);
    const cuts = feedPoints(toolpath);
    expect(Math.min(...cuts.map((p) => p[2]))).toBeCloseTo(-6.35, 6);
  });

  it('caps a maximum depth deeper than the bit reaches, with a warning', async () => {
    const op = vcarve({ loops: [slot([20, 10], 30, 6)], maxDepth: 9 });
    const { toolpath, warnings } = await run(op);
    expect(warnings?.map((w) => w.code)).toEqual(['max-depth-limited']);
    expect(Math.min(...feedPoints(toolpath).map((p) => p[2]))).toBeCloseTo(-3, 3);
  });

  it('leaves the floor to a clearing end mill: the two programs carve the shape together', async () => {
    const loops = [rect(0, 0, 50, 24), hole(circle([25, 12], 3))];
    const clearing = { tool: flat6, feeds, stepdown: 2, stepover: 0.4 };
    const alone = await run(vcarve({ loops, maxDepth: 2 }));
    const op = vcarve({ loops, maxDepth: 2, clearing });
    const { toolpath, warnings } = await run(op);
    expect(warnings).toBeUndefined();
    const cleared = await generateVCarveClearing(op, context());
    if (!cleared.ok) throw new Error(cleared.error.message);
    expect(cleared.value.warnings).toBeUndefined();
    // The V-bit cuts much less than when it clears the floor itself.
    const length = (tp: Toolpath): number =>
      withStarts(tp)
        .filter(({ move }) => move.kind !== 'rapid')
        .reduce(
          (a, { from, move }) => a + Math.hypot(move.to[0] - from[0], move.to[1] - from[1]),
          0,
        );
    expect(length(toolpath)).toBeLessThan(0.6 * length(alone.toolpath));
    // The end mill first, then the V-bit, on the same material.
    const [x0, y0, x1, y1] = boundsOf(loops, 2);
    const map = new Heightmap(x0, y0, x1, y1, 0.1, 0);
    map.run(cleared.value.toolpath, flatTool(flat6));
    map.run(toolpath, vTool(vbit90));
    const cmp = map.compare(loops, 1, 2);
    expect(cmp.gouge).toBeLessThan(0.01);
    expect(cmp.uncut).toBeLessThan(0.21);
    expect(map.rapidBelow).toBeLessThan(1e-9);
  });

  it('gives an empty clearing with a warning when there is no floor or the end mill does not fit', async () => {
    const clearing = { tool: flat6, feeds, stepdown: 2, stepover: 0.4 };
    const none = await generateVCarveClearing(vcarve({ clearing }), context());
    if (!none.ok) throw new Error(none.error.message);
    expect(none.value.toolpath.entries).toEqual([]);
    expect(none.value.warnings?.map((w) => w.code)).toEqual(['no-floor']);
    const small = await generateVCarveClearing(
      vcarve({ loops: [rect(0, 0, 40, 8)], maxDepth: 1, clearing }),
      context(),
    );
    if (!small.ok) throw new Error(small.error.message);
    expect(small.value.warnings?.map((w) => w.code)).toEqual(['clearing-tool-does-not-fit']);
    const missing = await generateVCarveClearing(vcarve(), context());
    expect(missing.ok).toBe(false);
  });
});

describe('V-carve: the clearing as an operation of its own', () => {
  it('cuts what generateVCarveClearing cuts, tagged with its own id, and is registered', async () => {
    const loops = [rect(0, 0, 50, 24), hole(circle([25, 12], 3))];
    const clearing = { tool: flat6, feeds, stepdown: 2, stepover: 0.4 };
    const carve = vcarve({ loops, maxDepth: 2, clearing });
    const direct = await generateVCarveClearing(carve, context());
    const own = await generateVCarveClearingOperation(
      {
        kind: 'vcarveClearing',
        id: 'vcarve#1/clearing',
        name: 'Letters (clearing)',
        tool: flat6,
        feeds,
        carve: vcarve({ loops, maxDepth: 2 }),
        stepdown: 2,
        stepover: 0.4,
      },
      context(),
    );
    if (!direct.ok || !own.ok) throw new Error('expected both to generate');
    const moves = (tp: Toolpath) => tp.entries.filter(isMove);
    expect(moves(own.value.toolpath).map((m) => m.to)).toEqual(
      moves(direct.value.toolpath).map((m) => m.to),
    );
    expect(new Set(moves(own.value.toolpath).map((m) => m.op))).toEqual(
      new Set(['vcarve#1/clearing']),
    );
    const registry = registerBuiltinOperations(new OperationRegistry());
    expect(registry.get('vcarveClearing')).toBe(generateVCarveClearingOperation);
  }, 30_000);
});

describe('V-carve: moves and heights', () => {
  it('cuts in stepdown levels, each level only where the carve is deeper than the last', async () => {
    const op = vcarve({ loops: [slot([20, 10], 30, 6)], stepdown: 1 });
    const { toolpath } = await run(op);
    const byPass = new Map<number, number>();
    for (const m of toolpath.entries.filter(isMove)) {
      if (m.kind === 'rapid') continue;
      byPass.set(m.pass, Math.min(byPass.get(m.pass) ?? Infinity, m.to[2]));
    }
    expect([...byPass.keys()]).toEqual([0, 1, 2]);
    [-1, -2, -3].forEach((z, pass) => expect(byPass.get(pass)).toBeCloseTo(z, 6));
    const map = simulate(toolpath, op, 0.1);
    const cmp = map.compare(op.loops, 1, Infinity);
    expect(cmp.gouge).toBeLessThan(0.01);
    expect(cmp.uncut).toBeLessThan(0.01);
  });

  it('never rapids below the stock top, which may be above the carved face', async () => {
    // The face is 2 mm below the stock top (`top` is the geometry's height, not the stock's).
    const setup: Setup = { ...baseSetup, heights: { clearance: 10, retract: 0.5 } };
    const op = vcarve({ loops: letters(), top: -2 });
    const { toolpath } = await run(op, setup);
    for (const { from, move } of withStarts(toolpath)) {
      if (move.kind !== 'rapid') continue;
      // A rapid that moves in XY stays at the retract height, above the stock top.
      if (Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9) {
        expect(move.to[2]).toBeGreaterThanOrEqual(VCARVE_SAFE_ABOVE - 1e-9);
      }
      expect(move.to[2]).toBeGreaterThanOrEqual(VCARVE_SAFE_ABOVE - 1e-9);
    }
    const map = simulate(toolpath, op, 0.2);
    expect(map.rapidBelow).toBeLessThan(1e-9);
    // The stock top with a bottom origin: 12 mm of stock, so the top is at Z 12.
    const bottom: Setup = {
      ...baseSetup,
      wcs: { ...baseSetup.wcs, origin: { xy: 'front-left', z: 'bottom' } },
    };
    const low = await run(vcarve({ top: 12 - 3 }), bottom);
    for (const m of low.toolpath.entries.filter(isMove)) {
      if (m.kind === 'rapid') expect(m.to[2]).toBeGreaterThanOrEqual(12 + VCARVE_SAFE_ABOVE - 1e-9);
    }
  });

  it('links pieces at depth only through the carve, and starts and ends at clearance', async () => {
    const op = vcarve({ loops: letters() });
    const { toolpath } = await run(op);
    expect(toolpath.start[2]).toBe(10);
    const last = toolpath.entries[toolpath.entries.length - 1]!;
    expect(last).toMatchObject({ kind: 'rapid', to: [expect.any(Number), expect.any(Number), 10] });
    // No feed move takes the cone outside the outline (checked exactly in the generator, by
    // samples here).
    const dist = new OutlineDistance(op.loops);
    for (const p of feedPoints(toolpath)) {
      expect(dist.dist([p[0], p[1]])).toBeGreaterThanOrEqual(-p[2] - 0.006);
    }
  });

  it('never feeds across the face between letters close together: such links retract', async () => {
    // Centre lines end in the corners at the top surface, where the cone has no reach, so a link
    // between neighbouring letters must not count as "inside the carve" there.
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed);
      const loops: Loop2[] = [];
      // Letters in columns: each goes above the last or starts a column to its right.
      let x = 0;
      let y = 0;
      let right = 0;
      const count = 3 + Math.floor(random() * 2);
      for (let k = 0; k < count; k++) {
        const gap = 0.5 + random() * 5.5;
        if (k > 0 && random() < 0.5) y += gap;
        else if (k > 0) {
          x = right + gap;
          y = random() * 2;
        }
        let w: number;
        let h: number;
        if (random() < 0.3) {
          // A letter with an island: a frame whose bars are 4 to 5 mm wide.
          const bar = 4 + random();
          w = 2 * bar + 2 + random() * 4;
          h = 2 * bar + 2 + random() * 6;
          loops.push(rect(x, y, w, h), hole(rect(x + bar, y + bar, w - 2 * bar, h - 2 * bar)));
        } else {
          w = 4 + random() * 2;
          h = 10 + random() * 10;
          loops.push(rect(x, y, w, h));
        }
        right = Math.max(right, x + w);
        y += h;
      }
      const tool = random() < 0.5 ? vbit90 : vbit60;
      const op = vcarve(random() < 0.5 ? { tool, loops } : { tool, loops, maxDepth: 1.5 });
      const { toolpath } = await run(op);
      const polys = loops.map((l) => flattenSegments(l.segments, true, 0.001));
      const dist = new OutlineDistance(loops);
      for (const { from, move } of withStarts(toolpath)) {
        if (move.kind === 'rapid') continue;
        for (const p of samplesOf(from, move, 0.05)) {
          if (p[2] > op.top + 1e-9) continue;
          const xy: Vec2 = [p[0], p[1]];
          const ok = pointInLoops(xy, polys) || dist.dist(xy) < 0.01;
          if (!ok) {
            throw new Error(
              `seed ${seed}: feed from (${from.join(', ')}) to (${move.to.join(', ')}) passes (${xy.join(', ')}) outside the shape`,
            );
          }
        }
      }
    }
  }, 30_000);

  it('feeds a link only inside the shape and clear of the outline, never across a gap at the top', () => {
    // Two bars 1 mm apart, one above the other.
    const op = vcarve({ loops: [rect(0, 0, 4, 20), rect(0, 21, 4, 20)] });
    const allowed = (a: Vec3, b: Vec3): boolean => {
      const r = vcarveLinkAllowed(op, a, b);
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    // Corner to corner across the gap with the tip at the top: the cone reaches nothing there,
    // but the move scores the face between the letters.
    expect(allowed([4, 20, 0], [4, 21, 0])).toBe(false);
    expect(allowed([0, 20, 0], [0, 21, 0])).toBe(false);
    // Across the gap a little below the top.
    expect(allowed([3.7, 19.7, -0.3], [3.7, 21.3, -0.3])).toBe(false);
    // Through a bar, at the top and at depth, is fine; so is straight down at a corner.
    expect(allowed([2, 5, 0], [2, 10, 0])).toBe(true);
    expect(allowed([2, 5, -1.5], [2, 10, -1.5])).toBe(true);
    expect(allowed([4, 20, 0], [4, 20, -0.001])).toBe(true);
    // Deeper than the bar allows is not.
    expect(allowed([2, 5, -2.5], [2, 10, -2.5])).toBe(false);
  });

  it('never cuts outside a very sharp tip', async () => {
    // Two 17 degree wedges pointing at each other: near the tips a normal can cross the outline
    // within the ridge tolerance, where the unsigned distance keeps rising outside.
    for (const tool of [vbit90, vbit60]) {
      const loops = [
        polygon([
          [0, -3],
          [20, 0],
          [0, 3],
        ]),
        polygon([
          [41, 3],
          [21, 0],
          [41, -3],
        ]),
      ];
      const op = vcarve({ tool, loops });
      const { toolpath } = await run(op);
      const polys = loops.map((l) => flattenSegments(l.segments, true, 0.001));
      const dist = new OutlineDistance(loops);
      for (const p of feedPoints(toolpath)) {
        if (p[2] > -1e-9) continue;
        const xy: Vec2 = [p[0], p[1]];
        expect(pointInLoops(xy, polys) || dist.dist(xy) < 0.01).toBe(true);
      }
      const map = simulate(toolpath, op, 0.02);
      const cmp = map.compare(op.loops, vTool(tool).tan, Infinity);
      expect(cmp.gouge).toBeLessThan(0.006);
    }
  }, 30_000);

  it('measures distance to the outline like the exact distance', () => {
    const loops = letters();
    const d = new OutlineDistance(loops);
    for (let x = -5; x <= 125; x += 3.7) {
      for (let y = -5; y <= 55; y += 2.9) {
        expect(d.dist([x, y])).toBeCloseTo(distToLoops([x, y], loops), 9);
      }
    }
  });

  it('tells inside from outside like a point-in-polygon test', () => {
    const loops = letters();
    const d = new OutlineDistance(loops);
    const polys = loops.map((l) => flattenSegments(l.segments, true, 0.0001));
    for (let x = -5; x <= 125; x += 0.37) {
      for (let y = -5; y <= 55; y += 0.29) {
        if (distToLoops([x, y], loops) < 1e-3) continue;
        expect(d.inside([x, y])).toBe(pointInLoops([x, y], polys));
      }
    }
  });

  it('carves a sign of 20 letters in seconds', async () => {
    // Twenty "O"s of 400 vertices each with a 60 degree bit, carved to a point and to 2 mm. The
    // README's "Performance" note has the measured times; the bound here is generous.
    const ring = (cx: number, rx: number, ry: number): Vec2[] =>
      Array.from({ length: 200 }, (_, k): Vec2 => {
        const a = (2 * Math.PI * k) / 200;
        return [cx + rx * Math.cos(a), 25 + ry * Math.sin(a)];
      });
    const loops = Array.from({ length: 20 }, (_, i) => [
      polygon(ring(20 + 32 * i, 14, 20)),
      hole(polygon(ring(20 + 32 * i, 9, 15))),
    ]).flat();
    for (const maxDepth of [undefined, 2]) {
      const op = vcarve(
        maxDepth === undefined ? { tool: vbit60, loops } : { tool: vbit60, loops, maxDepth },
      );
      const t0 = performance.now();
      const r = await generateVCarve(op, context());
      const ms = performance.now() - t0;
      expect(r.ok).toBe(true);
      expect(ms).toBeLessThan(30_000);
    }
  }, 120_000);
});

describe('V-carve: refusals and plumbing', () => {
  it('refuses tools that are not V-bits, bad numbers, no loops and shapes too small', async () => {
    const bad = async (over: Partial<VCarveOperation>) => {
      const r = await generateVCarve(vcarve(over), context());
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error.message;
    };
    expect(await bad({ tool: flat6 })).toMatch(/V-bit/);
    expect(await bad({ tool: { ...vbit90, angle: deg(180) } })).toMatch(/angle/);
    expect(await bad({ tool: { ...vbit90, tipDiameter: 20 } })).toMatch(/tip/);
    expect(await bad({ maxDepth: 0 })).toMatch(/maximum depth/);
    expect(await bad({ stepdown: -1 })).toMatch(/stepdown/);
    expect(await bad({ loops: [] })).toMatch(/no loops/);
    expect(await bad({ tool: { ...vbit90, tipDiameter: 2 }, loops: [rect(0, 0, 10, 1)] })).toMatch(
      /too small/,
    );
    expect(await bad({ clearing: { tool: vbit60, feeds, stepdown: 1, stepover: 0.5 } })).toMatch(
      /clearing tool/,
    );
    // A vanishing clearing entry angle would ramp for millions of moves: refused up front.
    const clearing = { tool: flat6, feeds, stepdown: 1, stepover: 0.5 };
    expect(await bad({ clearing: { ...clearing, entry: { kind: 'ramp', angle: 1e-8 } } })).toMatch(
      /Clearing entry: The ramp angle must be at least 0\.5/,
    );
  });

  it('warns about areas narrower than a flat tip', async () => {
    const tool: Tool = { ...vbit90, tipDiameter: 1 };
    const tri = polygon([
      [0, 0],
      [30, 0],
      [0, 6],
    ]);
    const { warnings } = await run(vcarve({ tool, loops: [tri] }));
    expect(warnings?.map((w) => w.code)).toContain('too-narrow');
  });

  it('calls checkpoint while it works and stops on CamCancelled', async () => {
    const counter = { count: 0 };
    const r = await generateVCarve(vcarve({ loops: letters() }), context(baseSetup, counter));
    expect(r.ok).toBe(true);
    expect(counter.count).toBeGreaterThan(5);
    const cancelling: OperationContext = {
      ...context(),
      checkpoint: () => Promise.reject(new CamCancelled()),
    };
    await expect(generateVCarve(vcarve(), cancelling)).rejects.toBeInstanceOf(CamCancelled);
  });

  it('is registered as the vcarve generator', () => {
    const registry = registerBuiltinOperations(new OperationRegistry());
    expect(registry.get('vcarve')).toBe(generateVCarve);
  });

  it('refuses a carve past the move budget, with no partial toolpath', async () => {
    const full = await generateVCarve(vcarve(), context());
    if (!full.ok) throw new Error(full.error.message);
    const n = full.value.toolpath.entries.length;
    expect(await generateVCarve(vcarve(), { ...context(), maxMoves: n })).toEqual(full);
    const over = await generateVCarve(vcarve(), { ...context(), maxMoves: n - 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe('invalid-input');
      expect(over.error.message).toBe(
        `vcarve#1: this operation would emit more than ${n - 1} moves, the most allowed. Use a larger tool, stepdown, stepover or entry angle.`,
      );
    }
  });
});
