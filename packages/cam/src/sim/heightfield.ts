// The heightfield of the material-removal simulation (M5 plan, T5.3c): the stock top as one Z per
// cell over the stock's XY, and the tool stamps that lower it. Pure code on typed arrays; it runs
// in the CAM worker.
//
// Cells are `cell` mm squares from the stock's XY minimum, `nx` along X and `ny` along Y, stored
// row by row in X: cell (i, j) has index `j * nx + i` and its centre at
// `(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell)`. A cell's height is the material top at its
// centre, so everything here is exact at cell centres and says nothing between them.
//
// A tool is a solid of revolution about +Z, described by its profile: the height f(r) of its
// surface above the tip at radius r, for 0 <= r <= R (as in `mesh/dropcutter.ts`):
//
//   flat  f(r) = 0
//   ball  f(r) = R - sqrt(R^2 - r^2)
//   bull  f(r) = 0 for r <= R - c, else c - sqrt(c^2 - (r - R + c)^2)   (c the corner radius)
//   vbit  f(r) = 0 for r <= t, else (r - t) / tan(a)                    (a the half angle, t the tip radius)
//
// A move lowers every cell to the lowest the tool's surface reaches over it during the move:
//
// - lines and arcs at one Z (most cutting): exactly, from the cell centre's distance d to the
//   move's XY path, as z + f(d); rows are clipped to the move's reach, so a long diagonal cut
//   never visits its whole bounding box;
// - moves that change Z (plunges, ramps, helices): by stamping the tool at points no more than
//   half a cell apart in XY and no more than `zStep` apart in Z (half the gouge tolerance in the
//   simulation), Z interpolated. Between two stamps the true sweep reaches lower by at most the
//   smaller of the slope times the XY spacing and `zStep`, so a ramp is never cut deeper than it
//   is, and a steep one is left high at the tool's sides by no more than `zStep`. A plunge
//   straight down is stamped at its two ends: the end is the lowest.

import { angleAbout, arcSweep, normalizeAngle, radiusAbout } from '../arc';
import type { ArcMove, Move } from '../ir';
import { err, ok, type Box3, type CamResult, type Tool, type Vec3 } from '../types';

/** Default cells across the smallest tool's diameter. */
export const SIM_CELLS_PER_DIAMETER = 16;

/**
 * The cut width a V-bit or an engraver is sized for when its tip is narrower, mm: a 90 degree V
 * 0.5 mm deep. The default cell follows the width it cuts, not its shank.
 */
export const SIM_VBIT_CUT_WIDTH = 1;

/** The finest default cell, mm. */
export const SIM_MIN_CELL = 0.05;

/**
 * The most cells a simulation holds: 4 million, 16 MiB of heights (Float32) plus as much again for
 * the part's heights and its two tolerance bands. A finer cell is coarsened until it fits.
 */
export const SIM_MAX_CELLS = 4_000_000;

/** Point angle of a drill with none given (118 degrees, the common jobber drill), radians. */
export const SIM_DEFAULT_DRILL_ANGLE = (118 * Math.PI) / 180;

/** A tool's profile for the simulation, mm and radians. */
export type ToolProfile =
  | { readonly kind: 'flat'; readonly radius: number }
  | { readonly kind: 'ball'; readonly radius: number }
  | { readonly kind: 'bull'; readonly radius: number; readonly corner: number }
  | {
      readonly kind: 'vbit';
      readonly radius: number;
      readonly halfAngle: number;
      readonly tipRadius: number;
    };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The profile of a tool: flat, ball and bull end mills as they are; a V-bit or an engraver with an
 * angle as a cone with its flat tip; a drill as a cone of its point angle (118 degrees when none is
 * given); an engraver with no angle as a flat end mill of its diameter.
 */
export function toolProfile(
  tool: Pick<Tool, 'kind' | 'diameter' | 'cornerRadius' | 'angle' | 'tipDiameter' | 'name'>,
): CamResult<ToolProfile> {
  const radius = tool.diameter / 2;
  if (!(finite(radius) && radius > 0)) {
    return err('invalid-input', `The tool ${tool.name} has no positive diameter.`);
  }
  switch (tool.kind) {
    case 'flat':
      return ok({ kind: 'flat', radius });
    case 'ball':
      return ok({ kind: 'ball', radius });
    case 'bull': {
      const c = tool.cornerRadius ?? 0;
      if (!(finite(c) && c >= 0 && c <= radius)) {
        return err('invalid-input', `The tool ${tool.name} has a corner radius out of range.`);
      }
      if (c === 0) return ok({ kind: 'flat', radius });
      if (c === radius) return ok({ kind: 'ball', radius });
      return ok({ kind: 'bull', radius, corner: c });
    }
    case 'vbit':
    case 'engraver':
    case 'drill': {
      const angle = tool.angle ?? (tool.kind === 'drill' ? SIM_DEFAULT_DRILL_ANGLE : undefined);
      if (angle === undefined) return ok({ kind: 'flat', radius });
      if (!(finite(angle) && angle > 0 && angle < Math.PI)) {
        return err('invalid-input', `The tool ${tool.name} has an angle out of range.`);
      }
      const tipRadius = (tool.tipDiameter ?? 0) / 2;
      if (!(finite(tipRadius) && tipRadius >= 0 && tipRadius <= radius)) {
        return err('invalid-input', `The tool ${tool.name} has a tip diameter out of range.`);
      }
      return ok({ kind: 'vbit', radius, halfAngle: angle / 2, tipRadius });
    }
  }
}

/** f(r): the height of the tool's surface above its tip at radius r (0 <= r <= radius). */
export function profileHeight(p: ToolProfile, r: number): number {
  switch (p.kind) {
    case 'flat':
      return 0;
    case 'ball': {
      const q = p.radius * p.radius - r * r;
      return p.radius - Math.sqrt(q > 0 ? q : 0);
    }
    case 'bull': {
      const s = r - (p.radius - p.corner);
      if (s <= 0) return 0;
      const q = p.corner * p.corner - s * s;
      return p.corner - Math.sqrt(q > 0 ? q : 0);
    }
    case 'vbit':
      return r <= p.tipRadius ? 0 : (r - p.tipRadius) / Math.tan(p.halfAngle);
  }
}

/** The grid of a heightfield. */
export interface SimGrid {
  /** XY of the first cell's outer corner (the stock's XY minimum), machine mm. */
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
}

/**
 * The width a tool's cut is sized by for the default cell: its diameter, or for a V-bit or an
 * engraver its tip diameter when that is wider than `SIM_VBIT_CUT_WIDTH`, else that width (never
 * more than the diameter).
 */
export function simCutWidth(tool: SimCellTool): number {
  if (tool.kind !== 'vbit' && tool.kind !== 'engraver') return tool.diameter;
  const tip = tool.tipDiameter ?? 0;
  return Math.min(tool.diameter, Math.max(finite(tip) ? tip : 0, SIM_VBIT_CUT_WIDTH));
}

/** What `simCellSize` reads of a tool. */
export type SimCellTool = Pick<Tool, 'diameter'> & Partial<Pick<Tool, 'kind' | 'tipDiameter'>>;

/**
 * The cell size for a stock and tools: `options.cell` when given, else the narrowest cut width
 * (`simCutWidth`: the diameter, or a V-bit's tip or nominal cut width) over
 * `SIM_CELLS_PER_DIAMETER` but at least `SIM_MIN_CELL`; then coarsened until the grid holds at
 * most `maxCells` (default `SIM_MAX_CELLS`).
 */
export function simCellSize(
  stock: Box3,
  tools: readonly SimCellTool[],
  options: { cell?: number; maxCells?: number } = {},
): number {
  const w = stock.max[0] - stock.min[0];
  const h = stock.max[1] - stock.min[1];
  const smallest = Math.min(...tools.map(simCutWidth).filter((d) => finite(d) && d > 0));
  let cell =
    options.cell ??
    (Number.isFinite(smallest) ? Math.max(SIM_MIN_CELL, smallest / SIM_CELLS_PER_DIAMETER) : 1);
  const maxCells = options.maxCells ?? SIM_MAX_CELLS;
  const cells = Math.ceil(w / cell) * Math.ceil(h / cell);
  if (cells > maxCells) {
    cell = Math.sqrt((w * h) / maxCells);
    while (Math.ceil(w / cell) * Math.ceil(h / cell) > maxCells) cell *= 1.001;
  }
  return cell;
}

/** The grid over a stock's XY at `cell` mm. */
export function gridFor(stock: Box3, cell: number): SimGrid {
  return {
    x0: stock.min[0],
    y0: stock.min[1],
    cell,
    nx: Math.max(1, Math.ceil((stock.max[0] - stock.min[0]) / cell - 1e-9)),
    ny: Math.max(1, Math.ceil((stock.max[1] - stock.min[1]) / cell - 1e-9)),
  };
}

/** Cell centre X of column `i`. */
export function cellX(g: SimGrid, i: number): number {
  return g.x0 + (i + 0.5) * g.cell;
}

/** Cell centre Y of row `j`. */
export function cellY(g: SimGrid, j: number): number {
  return g.y0 + (j + 0.5) * g.cell;
}

/** Called for every cell a move reaches, with the lowest Z the tool's surface has over it. */
export type CellVisitor = (k: number, z: number) => void;

/** First and last column (or row) whose centre lies in [lo, hi]; empty when first > last. */
function span(origin: number, cell: number, n: number, lo: number, hi: number): [number, number] {
  return [
    Math.max(0, Math.ceil((lo - origin) / cell - 0.5)),
    Math.min(n - 1, Math.floor((hi - origin) / cell - 0.5)),
  ];
}

/** The tool stamped at one point: every cell within `reach` of (x, y). */
export function stampPoint(
  g: SimGrid,
  x: number,
  y: number,
  z: number,
  tool: ToolProfile,
  reach: number,
  visit: CellVisitor,
): void {
  if (!(reach > 0)) return;
  const [j0, j1] = span(g.y0, g.cell, g.ny, y - reach, y + reach);
  for (let j = j0; j <= j1; j++) {
    const dy = cellY(g, j) - y;
    const q = reach * reach - dy * dy;
    if (q < 0) continue;
    const hw = Math.sqrt(q);
    const [i0, i1] = span(g.x0, g.cell, g.nx, x - hw, x + hw);
    const row = j * g.nx;
    for (let i = i0; i <= i1; i++) {
      const r = Math.hypot(cellX(g, i) - x, dy);
      if (r <= reach) visit(row + i, z + profileHeight(tool, r));
    }
  }
}

/** The x interval where a * x + b lies in [lo, hi] (a whole or empty line when a is 0). */
function linear(a: number, b: number, lo: number, hi: number): [number, number] {
  if (Math.abs(a) < 1e-15) return b >= lo && b <= hi ? [-Infinity, Infinity] : [1, 0];
  const p = (lo - b) / a;
  const q = (hi - b) / a;
  return p < q ? [p, q] : [q, p];
}

/** A straight move at constant Z from (ax, ay) to (bx, by): exact distances to the segment. */
function sweepFlatLine(
  g: SimGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  z: number,
  tool: ToolProfile,
  reach: number,
  visit: CellVisitor,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const L = Math.sqrt(L2);
  if (L < 1e-9) {
    stampPoint(g, ax, ay, z, tool, reach, visit);
    return;
  }
  const [j0, j1] = span(g.y0, g.cell, g.ny, Math.min(ay, by) - reach, Math.max(ay, by) + reach);
  for (let j = j0; j <= j1; j++) {
    const yc = cellY(g, j);
    // The capsule is convex: its row is one interval, the hull of the end disks' and the band's.
    let lo = Infinity;
    let hi = -Infinity;
    for (const [px, py] of [
      [ax, ay],
      [bx, by],
    ] as const) {
      const q = reach * reach - (yc - py) * (yc - py);
      if (q >= 0) {
        const hw = Math.sqrt(q);
        lo = Math.min(lo, px - hw);
        hi = Math.max(hi, px + hw);
      }
    }
    // Band: projection t in [0, 1] and perpendicular distance in [-reach, reach].
    const t = linear(dx / L2, (-ax * dx + (yc - ay) * dy) / L2, 0, 1);
    const s = linear(dy / L, (-ax * dy - (yc - ay) * dx) / L, -reach, reach);
    const blo = Math.max(t[0], s[0]);
    const bhi = Math.min(t[1], s[1]);
    if (blo <= bhi) {
      lo = Math.min(lo, blo);
      hi = Math.max(hi, bhi);
    }
    if (!(lo <= hi)) continue;
    const [i0, i1] = span(g.x0, g.cell, g.nx, lo, hi);
    const row = j * g.nx;
    for (let i = i0; i <= i1; i++) {
      const px = cellX(g, i) - ax;
      const py = yc - ay;
      let u = (px * dx + py * dy) / L2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(px - u * dx, py - u * dy);
      if (d <= reach) visit(row + i, z + profileHeight(tool, d));
    }
  }
}

/** An arc at constant Z: exact distances to the arc. */
function sweepFlatArc(
  g: SimGrid,
  from: Vec3,
  move: ArcMove,
  sweep: number,
  tool: ToolProfile,
  reach: number,
  visit: CellVisitor,
): void {
  const [cx, cy] = move.center;
  const ra = radiusAbout(move.center, from);
  const z = from[2];
  if (ra < 1e-9) {
    stampPoint(g, cx, cy, z, tool, reach, visit);
    return;
  }
  const a0 = angleAbout(move.center, from);
  const ccw = move.direction === 'ccw';
  const [ex, ey] = move.to;
  const outer = ra + reach;
  const inner = ra - reach;
  const [j0, j1] = span(g.y0, g.cell, g.ny, cy - outer, cy + outer);
  const visitRange = (j: number, lo: number, hi: number, yc: number): void => {
    const [i0, i1] = span(g.x0, g.cell, g.nx, lo, hi);
    const row = j * g.nx;
    for (let i = i0; i <= i1; i++) {
      const xc = cellX(g, i);
      const rho = Math.hypot(xc - cx, yc - cy);
      const along = normalizeAngle(
        ccw ? Math.atan2(yc - cy, xc - cx) - a0 : a0 - Math.atan2(yc - cy, xc - cx),
      );
      const d =
        along <= sweep
          ? Math.abs(rho - ra)
          : Math.min(Math.hypot(xc - from[0], yc - from[1]), Math.hypot(xc - ex, yc - ey));
      if (d <= reach) visit(row + i, z + profileHeight(tool, d));
    }
  };
  for (let j = j0; j <= j1; j++) {
    const yc = cellY(g, j);
    const dy = yc - cy;
    const qo = outer * outer - dy * dy;
    if (qo < 0) continue;
    const ho = Math.sqrt(qo);
    const qi = inner > 0 ? inner * inner - dy * dy : -1;
    if (qi > 0) {
      const hi = Math.sqrt(qi);
      visitRange(j, cx - ho, cx - hi, yc);
      visitRange(j, cx + hi, cx + ho, yc);
    } else {
      visitRange(j, cx - ho, cx + ho, yc);
    }
  }
}

/** Default most Z between two stamps of a move that changes Z, mm. */
export const SIM_Z_STEP = 0.025;

/**
 * Every cell the tool reaches during `move` from `from`, with the lowest Z its surface has there
 * (see the file comment). `reach` is the radius considered, at most the tool's: the collision
 * check passes a slightly smaller one so that grazing a cut's wall does not count. `zStep` is the
 * most Z between two stamps of a move that changes Z.
 */
export function sweepMove(
  g: SimGrid,
  from: Vec3,
  move: Move,
  tool: ToolProfile,
  reach: number,
  zStep: number,
  visit: CellVisitor,
): void {
  if (!(reach > 0)) return;
  const step = g.cell / 2;
  const dz = Math.abs(move.to[2] - from[2]);
  const zs = zStep > 0 ? zStep : SIM_Z_STEP;
  const flat = Math.abs(move.to[2] - from[2]) < 1e-9;
  if (move.kind !== 'arc') {
    if (flat) {
      sweepFlatLine(g, from[0], from[1], move.to[0], move.to[1], from[2], tool, reach, visit);
      return;
    }
    const len = Math.hypot(move.to[0] - from[0], move.to[1] - from[1]);
    const n = len < 1e-9 ? 1 : Math.max(1, Math.ceil(len / step), Math.ceil(dz / zs));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      stampPoint(
        g,
        from[0] + (move.to[0] - from[0]) * t,
        from[1] + (move.to[1] - from[1]) * t,
        from[2] + (move.to[2] - from[2]) * t,
        tool,
        reach,
        visit,
      );
    }
    return;
  }
  const sweep = arcSweep({
    start: from,
    end: move.to,
    center: move.center,
    direction: move.direction,
    fullCircle: move.fullCircle,
  });
  if (flat) {
    sweepFlatArc(g, from, move, sweep, tool, reach, visit);
    return;
  }
  // A helix: stamps along it, the radius going linearly from start to end as the IR's arcs do
  // (the validator holds the two radii equal within its tolerance).
  const r0 = radiusAbout(move.center, from);
  const r1 = radiusAbout(move.center, move.to);
  const a0 = angleAbout(move.center, from);
  const sign = move.direction === 'ccw' ? 1 : -1;
  const n = Math.max(1, Math.ceil((sweep * Math.max(r0, r1)) / step), Math.ceil(dz / zs));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = a0 + sign * sweep * t;
    const r = r0 + (r1 - r0) * t;
    stampPoint(
      g,
      move.center[0] + r * Math.cos(a),
      move.center[1] + r * Math.sin(a),
      from[2] + (move.to[2] - from[2]) * t,
      tool,
      reach,
      visit,
    );
  }
}
