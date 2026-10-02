// The 3D surfacing operation (M5 plan, T5.5a; ADR 0014 decision 13): machine a curved part from
// its mesh. Two strategies:
//
// - `parallel` (finishing, the default): straight raster lines a stepover apart within a boundary,
//   the tool dropped onto the mesh along each line with our TypeScript drop-cutter (flat, ball,
//   bull and V cutters, `mesh/dropcutter.ts`), refined where the surface bends, filtered to lines
//   and arcs within a tolerance (`mesh/fit.ts`), and linked along the surface between neighbouring
//   lines or with a retract where that is not certain to be safe;
// - `zlevel` (roughing): the part sliced at falling heights (`mesh/slices.ts`), each slice cleared
//   by the pocket operation's layer clearing (`generatePocketLayers`), leaving a stock to leave
//   on every side and on top.
//
// Waterline (constant-Z) finishing is out of M5's scope (T5.0b, ADR 0014 decision 13). The
// README's "The 3D surfacing operation" section describes the order of moves, the conventions and
// the warnings.

import { stockTopZ } from '../job';
import { differenceLoops, offsetLoops, regionLoops } from '../offset/engine';
import { checkSegments, flattenSegments } from '../offset/flatten';
import { distToLoops, pointInLoops } from '../offset/geometry';
import type { CamWarning, GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  err,
  ok,
  type CamResult,
  type Entry,
  type Loop2,
  type Mesh,
  type Surface3dInput,
  type Vec2,
  type Vec3,
} from '../types';
import { wcsOriginInSetup } from '../wcs';
import { DropCutter, cutterForTool, meshBounds, type CutterShape } from '../mesh/dropcutter';
import { fitPolyline, type FitElement } from '../mesh/fit';
import { heightGrid, superLevelLoops } from '../mesh/slices';
import { facingRaster } from './facing';
import { generatePocketLayers, type PocketLayer, type PocketOperation } from './pocket';
import { Emitter, PROFILE_SAFE_ABOVE, levels } from './profile';

/**
 * Fields of a `surface3d` operation that `Surface3dInput` (types.ts) and the core schema do not
 * have yet. All optional; the core schema (with a format bump) and `Surface3dInput` should take
 * them over when the UI (T5.5b) needs them.
 */
export interface Surface3dExtras {
  /** `parallel` (finishing, the default) or `zlevel` (roughing). */
  readonly strategy?: Surface3dStrategy;
  /**
   * Where the tool centre may go, machine XY (outer loops counter-clockwise, holes clockwise).
   * Default: for `parallel` the mesh's XY bounding box; for `zlevel` the stock outline grown by
   * half the tool diameter, so the tool clears the stock's edges.
   */
  readonly boundary?: readonly Loop2[];
  /**
   * How far the posted path may stray from the cutter locations, mm (half for the refinement,
   * half for the filtering to lines and arcs). Default `SURFACE3D_TOLERANCE`.
   */
  readonly tolerance?: number;
  /** Distance between drop points along a raster line, mm, before refinement. */
  readonly sampling?: number;
  /** The lowest the tool tip goes, machine Z. Default: the mesh's lowest point. */
  readonly floor?: number;
  /** `parallel`: `zigzag` (the default) or `oneway`, as for facing. */
  readonly pattern?: 'zigzag' | 'oneway';
  /** `zlevel`: the most one slice may go below the one above, mm. Default half the tool diameter. */
  readonly stepdown?: number;
  /** `zlevel`: how each slice is entered; default a helix (`SURFACE3D_ROUGH_ENTRY`). */
  readonly entry?: Entry;
  /** `zlevel`: climb milling when true (the default), conventional when false. */
  readonly climb?: boolean;
  /** `zlevel`: the slice grid's cell, mm. Default `SURFACE3D_SLICE_CELL`. */
  readonly sliceCell?: number;
}

export type Surface3dStrategy = 'parallel' | 'zlevel';

/** A `surface3d` operation as the generator reads it. */
export type Surface3dOperation = Surface3dInput & Surface3dExtras;

/** Rapids stop this far above the stock top (or the mesh, when higher), mm. */
export const SURFACE3D_SAFE_ABOVE = PROFILE_SAFE_ABOVE;

/** Default tolerance of the posted path against the cutter locations, mm. */
export const SURFACE3D_TOLERANCE = 0.01;

/** Default slice grid cell for z-level roughing, mm. */
export const SURFACE3D_SLICE_CELL = 0.2;

/** Slice loops are simplified within this, mm (and grown by it first, so nothing is lost). */
export const SURFACE3D_SLICE_SIMPLIFY = 0.02;

/** Default entry of a z-level slice: a helix at 3 degrees (the pocket shrinks its radius to fit). */
export const SURFACE3D_ROUGH_ENTRY: Entry = {
  kind: 'helix',
  angle: (3 * Math.PI) / 180,
  radius: 1,
};

/** Midpoint refinement stops after this many halvings, or below `MIN_STEP`. */
const MAX_REFINE = 10;
const MIN_STEP = 0.002;

/** A link along the surface is checked against the boundary every this many mm. */
const LINK_STEP = 0.5;
/** A link may run this close outside the boundary, mm (its ends lie on it). */
const LINK_TOLERANCE = 1e-3;
/** Chord error for the boundary's inside test, mm. */
const INSIDE_TOLERANCE = 1e-4;

/** A level within this of another one is not added again, mm. */
const LEVEL_MERGE = 1e-3;
/** Horizontal faces with less area than this, mm2, get no level of their own. */
const FLAT_MIN_AREA = 1;
/** A triangle whose normal is within this of +Z (its cosine) counts as horizontal. */
const FLAT_COS = Math.cos((0.01 * Math.PI) / 180);

const EPS = 1e-9;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): boolean => finite(v) && v > 0;
const warn = (code: string, message: string): CamWarning => ({ code, message });
const dist2 = (a: Vec2 | Vec3, b: Vec2 | Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (v: number, d = 1): string => (Math.round(v * 10 ** d) / 10 ** d + 0).toFixed(d);

/**
 * The scallop height a cutter leaves between raster lines `stepover` apart on a flat floor, mm:
 * the cusp between two neighbouring passes. 0 for a flat end mill (and for a bull whose flat
 * bottoms overlap); on a slope the cusp is larger, since the stepover is measured in XY.
 */
export function scallopHeight(shape: CutterShape, stepover: number): number {
  const h = stepover / 2;
  switch (shape.kind) {
    case 'flat':
      return h <= shape.radius ? 0 : Infinity;
    case 'ball':
      return h <= shape.radius ? shape.radius - Math.sqrt(shape.radius ** 2 - h * h) : Infinity;
    case 'bull': {
      const u = h - (shape.radius - shape.corner);
      if (u <= 0) return 0;
      return u <= shape.corner ? shape.corner - Math.sqrt(shape.corner ** 2 - u * u) : Infinity;
    }
    case 'vbit': {
      const u = h - shape.tipRadius;
      if (u <= 0) return 0;
      return h <= shape.radius ? u / Math.tan(shape.halfAngle) : Infinity;
    }
  }
}

function checkMesh(mesh: Mesh): string | undefined {
  const { positions: p, indices: ix } = mesh;
  if (!(p instanceof Float32Array) || !(ix instanceof Uint32Array)) {
    return 'The mesh must be a Float32Array of positions and a Uint32Array of indices.';
  }
  if (ix.length === 0 || ix.length % 3 !== 0) {
    return 'The mesh has no triangles (or a partial one).';
  }
  if (p.length % 3 !== 0) return 'The mesh positions are not xyz triples.';
  const vertices = p.length / 3;
  for (let k = 0; k < ix.length; k++) {
    if (ix[k]! >= vertices) return `Mesh index ${ix[k]} is out of range.`;
  }
  for (let k = 0; k < p.length; k++) {
    if (!Number.isFinite(p[k]!)) return 'The mesh has a coordinate that is not finite.';
  }
  return undefined;
}

function checkInput(op: Surface3dOperation): string | undefined {
  if (!positive(op.tool.diameter)) return 'The tool diameter must be greater than zero.';
  if (!(positive(op.stepover) && op.stepover <= op.tool.diameter + EPS)) {
    return 'The stepover must be greater than zero and at most the tool diameter.';
  }
  if (!finite(op.angle)) return 'The raster angle must be finite.';
  if (!(finite(op.allowance) && op.allowance >= 0))
    return 'The stock to leave must be zero or more.';
  if (!positive(op.feeds.cut) || !positive(op.feeds.plunge)) {
    return 'The cut and plunge feeds must be greater than zero.';
  }
  if (op.feeds.ramp !== undefined && !positive(op.feeds.ramp)) {
    return 'The ramp feed must be greater than zero.';
  }
  if (op.feeds.lead !== undefined && !positive(op.feeds.lead)) {
    return 'The lead feed must be greater than zero.';
  }
  const strategy = op.strategy ?? 'parallel';
  if (strategy !== 'parallel' && strategy !== 'zlevel') {
    return `Unknown strategy '${String(op.strategy)}'.`;
  }
  if (op.pattern !== undefined && op.pattern !== 'zigzag' && op.pattern !== 'oneway') {
    return `Unknown pattern '${String(op.pattern)}'.`;
  }
  if (op.tolerance !== undefined && !(finite(op.tolerance) && op.tolerance >= 1e-4)) {
    return 'The tolerance must be at least 0.0001 mm.';
  }
  if (op.sampling !== undefined && !(finite(op.sampling) && op.sampling >= 0.001)) {
    return 'The sampling must be at least 0.001 mm.';
  }
  if (op.floor !== undefined && !finite(op.floor)) return 'The floor must be finite.';
  if (op.stepdown !== undefined && !positive(op.stepdown)) {
    return 'The stepdown must be greater than zero.';
  }
  if (op.sliceCell !== undefined && !(finite(op.sliceCell) && op.sliceCell >= 0.01)) {
    return 'The slice cell must be at least 0.01 mm.';
  }
  if (op.boundary !== undefined) {
    if (op.boundary.length === 0) return 'The boundary has no loops.';
    for (let i = 0; i < op.boundary.length; i++) {
      const problem = checkSegments(op.boundary[i]!.segments, true);
      if (problem) return `boundary loop ${i}: ${problem}`;
    }
  }
  return checkMesh(op.mesh);
}

const rectLoop = (x0: number, y0: number, x1: number, y1: number): Loop2 => {
  const p: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return { segments: p.map((a, i) => ({ kind: 'line' as const, start: a, end: p[(i + 1) % 4]! })) };
};

/**
 * Generates a `surface3d` operation's toolpath (registered as the `surface3d` generator): a
 * parallel finish by default, z-level roughing with `strategy: 'zlevel'`.
 */
export async function generateSurface3d(
  input: Surface3dInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const op = input as Surface3dOperation;
  const problem = checkInput(op);
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  const bounds = meshBounds(op.mesh)!;
  const stockTop = stockTopZ(context.setup);
  const materialTop = Math.max(stockTop, bounds.max[2]);
  const floor = op.floor ?? bounds.min[2];
  if (!(floor < materialTop - EPS)) {
    return err('invalid-input', `${op.id}: the floor is not below the stock top.`);
  }
  return (op.strategy ?? 'parallel') === 'zlevel'
    ? roughZLevel(op, context, bounds, materialTop, floor)
    : finishParallel(op, context, bounds, materialTop, floor);
}

// ---------------------------------------------------------------------------------------------
// Parallel finishing

type Bounds = NonNullable<ReturnType<typeof meshBounds>>;

async function finishParallel(
  op: Surface3dOperation,
  context: OperationContext,
  bounds: Bounds,
  materialTop: number,
  floor: number,
): Promise<CamResult<GeneratedToolpath>> {
  const a = op.allowance;
  const shape = cutterForTool(op.tool, a);
  if (!shape.ok) return err(shape.error.code, `${op.id}: ${shape.error.message}`);
  const dc = new DropCutter(op.mesh, shape.value);
  const R = op.tool.diameter / 2;
  const tol = op.tolerance ?? SURFACE3D_TOLERANCE;
  const sampling = op.sampling ?? Math.min(0.5, Math.max(0.05, R / 4));
  const zigzag = (op.pattern ?? 'zigzag') === 'zigzag';
  const boundary = op.boundary ?? [
    rectLoop(bounds.min[0], bounds.min[1], bounds.max[0], bounds.max[1]),
  ];
  const raster = facingRaster(boundary, {
    toolRadius: 0,
    stepover: op.stepover,
    angle: op.angle,
    margin: 0,
  });
  if (!raster.ok) return err(raster.error.code, `${op.id}: ${raster.error.message}`);
  const { area, lines } = raster.value;
  if (lines.length === 0) return err('invalid-input', `${op.id}: the boundary is empty.`);
  const polys = area.map((l) => flattenSegments(l.segments, true, INSIDE_TOLERANCE));

  const heights = context.setup.heights;
  const retractZ = Math.max(heights.retract, materialTop + SURFACE3D_SAFE_ABOVE);
  const clearanceZ = Math.max(heights.clearance, retractZ);
  const em = new Emitter(op.id, op.feeds, [0, 0, clearanceZ]);
  let start: Vec3 | undefined;
  let lowest = Infinity;

  /** The tip height at (x, y): the grown cutter dropped, lifted by the stock to leave. */
  const dropFloor = floor - a;
  const zAt = (x: number, y: number): number => dc.drop(x, y, dropFloor) + a;

  /**
   * Cutter locations from `p` to `q`: samples `sampling` apart, halved where the middle of a
   * chord is off the surface by more than half the tolerance. Where a halving reaches `MIN_STEP`
   * and the surface still jumps (a wall under a flat end mill), the step goes up first or
   * across first, so it never runs below either end.
   */
  const locations = (p: Vec2, q: Vec2): Vec3[] => {
    const len = dist2(p, q);
    const n = Math.max(1, Math.ceil(len / sampling - 1e-9));
    const out: Vec3[] = [];
    const at = (t: number): Vec3 => {
      const x = p[0] + (q[0] - p[0]) * t;
      const y = p[1] + (q[1] - p[1]) * t;
      return [x, y, zAt(x, y)];
    };
    const refine = (ta: number, A: Vec3, tb: number, B: Vec3, depth: number): void => {
      const tm = (ta + tb) / 2;
      const M = at(tm);
      const off = Math.abs(M[2] - (A[2] + B[2]) / 2);
      if (off <= tol / 2) {
        out.push(B);
        return;
      }
      if (depth >= MAX_REFINE || (tb - ta) * len <= MIN_STEP) {
        // A jump the halving cannot resolve: up first, or across first, never through.
        if (B[2] > A[2]) out.push([A[0], A[1], B[2]]);
        else out.push([B[0], B[1], A[2]]);
        out.push(B);
        return;
      }
      refine(ta, A, tm, M, depth + 1);
      refine(tm, M, tb, B, depth + 1);
    };
    let prev = at(0);
    out.push(prev);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const next = at(t);
      refine((k - 1) / n, prev, t, next, 0);
      prev = next;
    }
    return out;
  };

  const emitFit = (pts: readonly Vec3[]): void => {
    const fit: FitElement[] = fitPolyline(pts, tol / 2);
    for (const e of fit) {
      if (e.kind === 'line') em.linear(e.to, 'cut');
      else em.arc(e.to, e.center, e.ccw, 'cut');
      if (e.to[2] < lowest) lowest = e.to[2];
    }
  };

  /** Up (straight) to the retract height, across, down by rapids to above the material, then fed. */
  const approach = (p: Vec3): void => {
    if (!start) {
      start = [p[0], p[1], clearanceZ];
      em.cur = start;
    } else if (em.cur[2] < retractZ) {
      em.rapid([em.cur[0], em.cur[1], retractZ]);
    }
    em.rapid([p[0], p[1], em.cur[2]]);
    const above = Math.max(p[2], materialTop) + SURFACE3D_SAFE_ABOVE;
    if (above < em.cur[2]) em.rapid([p[0], p[1], above]);
    em.linear(p, 'plunge');
    if (p[2] < lowest) lowest = p[2];
  };

  /** A zigzag link may follow the surface when it is short and stays inside the boundary. */
  const linkLimit = 2 * op.stepover + EPS;
  const canLink = (from: Vec2, to: Vec2): boolean => {
    if (!zigzag || dist2(from, to) > linkLimit) return false;
    const n = Math.max(1, Math.ceil(dist2(from, to) / LINK_STEP));
    for (let k = 0; k <= n; k++) {
      const p: Vec2 = [
        from[0] + ((to[0] - from[0]) * k) / n,
        from[1] + ((to[1] - from[1]) * k) / n,
      ];
      if (!pointInLoops(p, polys) && distToLoops(p, area) > LINK_TOLERANCE) return false;
    }
    return true;
  };

  let forward = true;
  for (const line of lines) {
    await context.checkpoint();
    const chords = forward ? line : [...line].reverse();
    for (const chord of chords) {
      const from = forward ? chord.a : chord.b;
      const to = forward ? chord.b : chord.a;
      const pts = locations(from, to);
      const first = pts[0]!;
      const here: Vec2 = [em.cur[0], em.cur[1]];
      if (start && canLink(here, from)) {
        emitFit(locations(here, from));
      } else {
        approach(first);
      }
      emitFit(pts);
    }
    if (zigzag) forward = !forward;
    em.pass++;
  }
  em.pass = Math.max(0, em.pass - 1);
  em.rapid([em.cur[0], em.cur[1], clearanceZ]);

  const warnings: CamWarning[] = [];
  const stockTop = stockTopZ(context.setup);
  if (stockTop - lowest > op.tool.fluteLength) {
    warnings.push(
      warn(
        'depth-exceeds-flutes',
        `The finish reaches ${fmt(stockTop - lowest)} mm below the stock top but the tool's flutes are ${fmt(op.tool.fluteLength)} mm long.`,
      ),
    );
  }
  const toolpath = { start: start ?? [0, 0, clearanceZ], entries: em.entries };
  return ok(warnings.length > 0 ? { toolpath, warnings } : { toolpath });
}

// ---------------------------------------------------------------------------------------------
// Z-level roughing

/** Heights of the mesh's upward horizontal faces with at least `FLAT_MIN_AREA` of area. */
function flatHeights(mesh: Mesh): number[] {
  const { positions: p, indices: ix } = mesh;
  const found: { z: number; area: number }[] = [];
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k]! * 3;
    const b = ix[k + 1]! * 3;
    const c = ix[k + 2]! * 3;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0) || nz / len < FLAT_COS) continue;
    found.push({ z: Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!), area: len / 2 });
  }
  found.sort((x, y) => x.z - y.z);
  const out: number[] = [];
  let i = 0;
  while (i < found.length) {
    let j = i;
    let area = 0;
    let z = found[i]!.z;
    while (j < found.length && found[j]!.z - found[i]!.z <= LEVEL_MERGE) {
      area += found[j]!.area;
      z = Math.max(z, found[j]!.z);
      j++;
    }
    if (area >= FLAT_MIN_AREA) out.push(z);
    i = j;
  }
  return out;
}

async function roughZLevel(
  op: Surface3dOperation,
  context: OperationContext,
  bounds: Bounds,
  materialTop: number,
  floor: number,
): Promise<CamResult<GeneratedToolpath>> {
  const a = op.allowance;
  const r = op.tool.diameter / 2;
  const stepdown = op.stepdown ?? op.tool.diameter / 2;
  const cell = op.sliceCell ?? SURFACE3D_SLICE_CELL;
  const { stock, wcs } = context.setup;
  const origin = wcsOriginInSetup(stock, wcs.origin);
  const boundary = op.boundary ?? [
    rectLoop(
      stock.min[0] - origin[0] - r / 2,
      stock.min[1] - origin[1] - r / 2,
      stock.max[0] - origin[0] + r / 2,
      stock.max[1] - origin[1] + r / 2,
    ),
  ];
  // The region the pocket clears around: the boundary grown so the pocket's own inset of the
  // tool radius and the stock to leave brings the tool centre back onto it.
  const grown = offsetLoops(boundary, r + a);
  if (!grown.ok) return err(grown.error.code, `${op.id}: boundary: ${grown.error.message}`);
  const outer = regionLoops(grown.value);
  if (outer.length === 0) return err('invalid-input', `${op.id}: the boundary is empty.`);

  // Levels: even steps from the top down to the floor, plus the stock to leave above every
  // horizontal face, so flat areas are roughed to exactly that.
  const base = levels(materialTop, floor, stepdown);
  if (!base.ok) return err(base.error.code, `${op.id}: ${base.error.message}`);
  const zs = [...base.value];
  for (const h of flatHeights(op.mesh)) {
    const z = h + a;
    if (
      z < materialTop - LEVEL_MERGE &&
      z > floor &&
      zs.every((w) => Math.abs(w - z) > LEVEL_MERGE)
    ) {
      zs.push(z);
    }
  }
  zs.sort((x, y) => y - x);

  // The slice grid: highest material within `reach` of each node.
  const reach = cell * Math.SQRT2 + SURFACE3D_SLICE_SIMPLIFY;
  const sampler = new DropCutter(op.mesh, { kind: 'flat', radius: reach });
  const empty = Math.min(floor, bounds.min[2]) - a - 1000;
  const grid = await heightGrid(
    sampler,
    {
      minX: bounds.min[0] - reach,
      minY: bounds.min[1] - reach,
      maxX: bounds.max[0] + reach,
      maxY: bounds.max[1] + reach,
    },
    cell,
    empty,
    () => context.checkpoint(),
  );
  if (!grid) {
    return err(
      'invalid-input',
      `${op.id}: the slice grid of ${cell} mm over the part is too large; use a larger slice cell.`,
    );
  }

  const layers: PocketLayer[] = [];
  for (const z of zs) {
    await context.checkpoint();
    // Material that stands higher than the stock to leave below the tool: an island.
    const islands = superLevelLoops(grid, z - a + 1e-6, SURFACE3D_SLICE_SIMPLIFY);
    const region = differenceLoops(outer, islands);
    if (!region.ok)
      return err(region.error.code, `${op.id}: slice at ${fmt(z, 3)}: ${region.error.message}`);
    const loops = regionLoops(region.value);
    if (loops.length > 0) layers.push({ z, loops });
  }

  const pocket: PocketOperation = {
    kind: 'pocket',
    id: op.id,
    name: op.name,
    tool: op.tool,
    feeds: op.feeds,
    loops: outer,
    depth: { top: materialTop, bottom: floor },
    stepdown,
    stepover: Math.min(1, op.stepover / op.tool.diameter),
    finishAllowance: a,
    entry: op.entry ?? SURFACE3D_ROUGH_ENTRY,
    climb: op.climb ?? true,
  };
  const result = await generatePocketLayers(pocket, layers, context);
  if (!result.ok) return result;
  const warnings = [...(result.value.warnings ?? [])];
  if (materialTop - floor > op.tool.fluteLength) {
    warnings.push(
      warn(
        'depth-exceeds-flutes',
        `The roughing goes ${fmt(materialTop - floor)} mm deep but the tool's flutes are ${fmt(op.tool.fluteLength)} mm long.`,
      ),
    );
  }
  if (op.tool.kind !== 'flat') {
    warnings.push(
      warn(
        'rough-round-tool',
        `Z-level roughing with a ${op.tool.kind} tool leaves more than the stock to leave between levels; a flat end mill roughs closest.`,
      ),
    );
  }
  return ok(
    warnings.length > 0
      ? { toolpath: result.value.toolpath, warnings }
      : { toolpath: result.value.toolpath },
  );
}
