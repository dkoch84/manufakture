// The facing operation (M5 plan, T5.2d; ADR 0014): flatten the top of the stock and bring it to a
// set thickness. Straight raster lines at an angle, a stepover apart, over the area grown by a
// margin, cut zigzag (each line the other way, linked at depth) or one way (retracting between
// lines), at each depth level from the stock top down. The README's "The facing operation"
// section describes the order of moves, the conventions and the warnings.

import { offsetLoops, regionLoops } from '../offset/engine';
import { checkSegments, flattenSegments } from '../offset/flatten';
import { distToLoops, pointInLoops } from '../offset/geometry';
import type { CamWarning, GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  err,
  ok,
  type CamResult,
  type FacingInput,
  type Loop2,
  type Vec2,
  type Vec3,
} from '../types';
import { Emitter, PROFILE_SAFE_ABOVE, levels } from './profile';

/**
 * Fields of a facing operation that `FacingInput` (types.ts) does not have yet. All optional; the
 * core schema (T5.1b) and `FacingInput` should take them over.
 */
export interface FacingExtras {
  /**
   * How far beyond `loops` the tool centre runs, mm, zero or more. Default: the tool radius, so
   * the tool's edge clears the stock's edge at the end of every line and the edges are faced
   * cleanly.
   */
  readonly margin?: number;
  /**
   * `zigzag` (default) cuts each line the opposite way to the one before and steps over at depth;
   * `oneway` cuts every line the same way (along the raster direction) and retracts between them.
   */
  readonly pattern?: FacingPattern;
}

export type FacingPattern = 'zigzag' | 'oneway';

/** A facing operation as the generator reads it. */
export type FacingOperation = FacingInput & FacingExtras;

/** Rapids stop this far above material the tool has already cut down to, mm. */
export const FACING_SAFE_ABOVE = PROFILE_SAFE_ABOVE;

/** The outermost lines run this far inside the grown area at least, mm, so they have length. */
const EDGE_INSET = 1e-3;

/** Chord error for the inside tests of the grown area, mm. */
const INSIDE_TOLERANCE = 1e-4;

/** A zigzag step-over is checked every this many mm. */
const LINK_STEP = 0.5;

/** A step-over may run this close outside the grown area, mm (its ends lie on the boundary). */
const LINK_TOLERANCE = 1e-3;

/** More raster lines than this means a stepover far too small for the area. */
const MAX_LINES = 100000;

const EPS = 1e-9;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): boolean => finite(v) && v > 0;
const warn = (code: string, message: string): CamWarning => ({ code, message });
const dist2 = (a: Vec2 | Vec3, b: Vec2 | Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function checkInput(op: FacingOperation): string | undefined {
  if (!positive(op.tool.diameter)) return 'The tool diameter must be greater than zero.';
  if (!finite(op.depth.top) || !finite(op.depth.bottom)) return 'The depths must be finite.';
  if (!(op.depth.top > op.depth.bottom)) return 'The bottom depth must be below the top.';
  if (!positive(op.stepdown)) return 'The stepdown must be greater than zero.';
  if (!(finite(op.stepover) && op.stepover > 0 && op.stepover <= 1)) {
    return 'The stepover must be greater than 0 and at most 1 (a fraction of the tool diameter).';
  }
  if (!finite(op.angle)) return 'The raster angle must be finite.';
  if (op.margin !== undefined && !(finite(op.margin) && op.margin >= 0)) {
    return 'The margin must be zero or more.';
  }
  if (op.pattern !== undefined && op.pattern !== 'zigzag' && op.pattern !== 'oneway') {
    return `Unknown pattern '${String(op.pattern)}'.`;
  }
  if (!positive(op.feeds.cut) || !positive(op.feeds.plunge)) {
    return 'The cut and plunge feeds must be greater than zero.';
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Raster geometry

/** One raster line's stretch inside the area: from `a` to `b` along the raster direction. */
export interface FacingChord {
  readonly a: Vec2;
  readonly b: Vec2;
}

/** The raster of a facing operation: its lines' stretches inside the grown area, line by line. */
export interface FacingRaster {
  /** The area the tool centre covers: `loops` grown by the margin. */
  readonly area: readonly Loop2[];
  /** Unit raster direction (cutting direction of a one-way raster). */
  readonly dir: Vec2;
  /** Per line, from the line with the lowest offset across the raster up, its chords along `dir`. */
  readonly lines: readonly (readonly FacingChord[])[];
  /** Distance between neighbouring lines, mm: at most the stepover. */
  readonly spacing: number;
}

export interface FacingRasterOptions {
  readonly toolRadius: number;
  /** Stepover, mm, greater than zero. */
  readonly stepover: number;
  /** Raster direction, radians from machine +X. */
  readonly angle: number;
  /** Growth of `loops`, mm, zero or more. */
  readonly margin: number;
}

/** Parameters `t` along the line `o + t * dir` where it meets segment chains of `loops`. */
function crossings(loops: readonly Loop2[], o: Vec2, dir: Vec2): number[] {
  const out: number[] = [];
  const nx = -dir[1];
  const ny = dir[0];
  for (const loop of loops) {
    for (const s of loop.segments) {
      if (s.kind === 'line') {
        // Signed distances of the ends from the line.
        const da = (s.start[0] - o[0]) * nx + (s.start[1] - o[1]) * ny;
        const db = (s.end[0] - o[0]) * nx + (s.end[1] - o[1]) * ny;
        const along = (p: Vec2): number => (p[0] - o[0]) * dir[0] + (p[1] - o[1]) * dir[1];
        if (Math.abs(da) <= EPS) out.push(along(s.start));
        if (Math.abs(db) <= EPS) out.push(along(s.end));
        if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
          const k = da / (da - db);
          out.push(
            along([
              s.start[0] + (s.end[0] - s.start[0]) * k,
              s.start[1] + (s.end[1] - s.start[1]) * k,
            ]),
          );
        }
      } else {
        // Every meeting with the arc's whole circle: extra breaks only split a stretch, and the
        // inside test of each piece decides what is kept.
        const cx = s.center[0] - o[0];
        const cy = s.center[1] - o[1];
        const R = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
        const tc = cx * dir[0] + cy * dir[1];
        const d = cx * nx + cy * ny;
        const h2 = R * R - d * d;
        if (h2 < 0) continue;
        const h = Math.sqrt(h2);
        out.push(tc - h, tc + h);
      }
    }
  }
  return out;
}

/**
 * The raster lines of a facing operation: `loops` grown by the margin (with the offset engine),
 * crossed by lines along `angle` a stepover apart, each cut into its stretches inside the grown
 * area. The outermost lines sit a tool radius less the stepover inside the loops' extent across
 * the raster (so the tool overlaps the edge by the stepover), or just inside the grown area when
 * the margin is smaller than that. Loops no wider than the tool get one line through the middle.
 */
export function facingRaster(
  loops: readonly Loop2[],
  options: FacingRasterOptions,
): CamResult<FacingRaster> {
  for (let i = 0; i < loops.length; i++) {
    const problem = checkSegments(loops[i]!.segments, true);
    if (problem) return err('invalid-input', `loop ${i}: ${problem}`);
  }
  const grown = offsetLoops(loops, options.margin);
  if (!grown.ok) return grown;
  const area = regionLoops(grown.value);
  const dir: Vec2 = [Math.cos(options.angle), Math.sin(options.angle)];
  const across: Vec2 = [-dir[1], dir[0]];
  if (area.length === 0) return ok({ area, dir, lines: [], spacing: options.stepover });

  const polys = area.map((l) => flattenSegments(l.segments, true, INSIDE_TOLERANCE));
  const extent = (pts: readonly (readonly Vec2[])[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const poly of pts)
      for (const p of poly) {
        const v = p[0] * across[0] + p[1] * across[1];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    return [lo, hi];
  };
  const [aLo, aHi] = extent(polys);
  const [sLo, sHi] = extent(loops.map((l) => flattenSegments(l.segments, true, INSIDE_TOLERANCE)));
  const r = options.toolRadius;
  const s = options.stepover;
  let v0 = Math.max(sLo + r - s, aLo + EDGE_INSET);
  let v1 = Math.min(sHi - r + s, aHi - EDGE_INSET);
  if (v1 < v0 || sHi - sLo <= 2 * r) {
    // No wider than the tool: one line through the middle covers it.
    const mid = (sLo + sHi) / 2;
    v0 = v1 = Math.min(Math.max(mid, aLo + EDGE_INSET), aHi - EDGE_INSET);
  }
  const n = Math.max(0, Math.ceil((v1 - v0) / s - 1e-9));
  if (n > MAX_LINES) {
    return err('invalid-input', `the stepover of ${s} mm makes more than ${MAX_LINES} lines.`);
  }
  const spacing = n === 0 ? s : (v1 - v0) / n;

  const lines: FacingChord[][] = [];
  for (let k = 0; k <= n; k++) {
    const v = n === 0 ? v0 : v0 + k * spacing;
    const o: Vec2 = [across[0] * v, across[1] * v];
    const ts = crossings(area, o, dir).sort((x, y) => x - y);
    const at = (t: number): Vec2 => [o[0] + dir[0] * t, o[1] + dir[1] * t];
    const chords: FacingChord[] = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i]!;
      const t1 = ts[i + 1]!;
      if (t1 - t0 <= EPS) continue;
      if (!pointInLoops(at((t0 + t1) / 2), polys)) continue;
      const last = chords[chords.length - 1];
      const a = at(t0);
      if (last && dist2(last.b, a) <= EPS) chords[chords.length - 1] = { a: last.a, b: at(t1) };
      else chords.push({ a, b: at(t1) });
    }
    if (chords.length > 0) lines.push(chords);
  }
  return ok({ area, dir, lines, spacing });
}

// ---------------------------------------------------------------------------------------------
// The generator

/**
 * Generates a facing operation's toolpath (registered as the `facing` generator). One IR `pass`
 * per depth level from `top` down to `bottom` in equal steps of at most `stepdown`; each level
 * runs every raster line, in the order the level before ended, so the next level starts where the
 * tool already is.
 */
export async function generateFacing(
  input: FacingInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const op = input as FacingOperation;
  const problem = checkInput(op);
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  if (op.loops.length === 0) return err('invalid-input', `${op.id}: the facing has no loops.`);

  const r = op.tool.diameter / 2;
  const margin = op.margin ?? r;
  const zigzag = (op.pattern ?? 'zigzag') === 'zigzag';
  const raster = facingRaster(op.loops, {
    toolRadius: r,
    stepover: op.stepover * op.tool.diameter,
    angle: op.angle,
    margin,
  });
  if (!raster.ok) return err(raster.error.code, `${op.id}: ${raster.error.message}`);
  const { area, lines } = raster.value;
  if (lines.length === 0) return err('invalid-input', `${op.id}: the area to face is empty.`);

  const warnings: CamWarning[] = [];
  const { top, bottom } = op.depth;
  if (top - bottom > op.tool.fluteLength) {
    warnings.push(
      warn(
        'depth-exceeds-flutes',
        `The facing is ${top - bottom} mm deep but the tool's flutes are ${op.tool.fluteLength} mm long.`,
      ),
    );
  }
  if (margin < r) {
    warnings.push(
      warn(
        'margin-small',
        `The margin of ${margin} mm is less than the tool radius: the tool stops short of the edges at the line ends, and the edges may not be faced cleanly.`,
      ),
    );
  }

  const heights = context.setup.heights;
  const retractZ = Math.max(heights.retract, top + FACING_SAFE_ABOVE);
  const clearanceZ = Math.max(heights.clearance, retractZ);
  const polys = area.map((l) => flattenSegments(l.segments, true, INSIDE_TOLERANCE));
  const em = new Emitter(op.id, op.feeds, [0, 0, clearanceZ]);
  let start: Vec3 | undefined;

  /** Over `xy` and down to just above `cleared` (the floor already cut there), by rapids. */
  const moveAbove = (xy: Vec2, cleared: number): void => {
    const feedFrom = Math.min(retractZ, cleared + FACING_SAFE_ABOVE);
    if (!start) {
      start = [xy[0], xy[1], clearanceZ];
      em.cur = start;
    }
    if (dist2(em.cur, xy) <= EPS && em.cur[2] <= feedFrom + EPS) return;
    if (em.cur[2] < retractZ) em.rapid([em.cur[0], em.cur[1], retractZ]);
    em.rapid([xy[0], xy[1], em.cur[2]]);
    em.rapid([xy[0], xy[1], feedFrom]);
  };

  /** A straight step-over at depth stays inside the grown area (the region being faced). */
  const linkInside = (a: Vec2, b: Vec2): boolean => {
    const n = Math.max(1, Math.ceil(dist2(a, b) / LINK_STEP));
    for (let k = 0; k <= n; k++) {
      const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      if (!pointInLoops(p, polys) && distToLoops(p, area) > LINK_TOLERANCE) return false;
    }
    return true;
  };

  const depths = levels(top, bottom, op.stepdown);
  if (!depths.ok) return err(depths.error.code, `${op.id}: ${depths.error.message}`);
  let order = lines.map((chords) => [...chords]);
  let previous = top;
  for (const z of depths.value) {
    await context.checkpoint();
    // Zigzag: the first chord runs from whichever end the tool is nearer to.
    let forward = true;
    if (zigzag && start) {
      const first = order[0]![0]!;
      forward = dist2(em.cur, first.a) <= dist2(em.cur, first.b);
    }
    for (const line of order) {
      await context.checkpoint();
      const chords = forward ? line : [...line].reverse();
      for (const chord of chords) {
        const from = forward ? chord.a : chord.b;
        const to = forward ? chord.b : chord.a;
        const here: Vec2 = [em.cur[0], em.cur[1]];
        if (start && Math.abs(em.cur[2] - z) <= EPS && zigzag && linkInside(here, from)) {
          em.linear([from[0], from[1], z], 'cut');
        } else if (start && Math.abs(em.cur[2] - previous) <= EPS && dist2(em.cur, from) <= EPS) {
          // Straight on down from the level before, where the tool already is.
          em.linear([from[0], from[1], z], 'plunge');
        } else {
          moveAbove(from, previous);
          em.linear([from[0], from[1], z], 'plunge');
        }
        em.linear([to[0], to[1], z], 'cut');
      }
      if (zigzag) forward = !forward;
    }
    previous = z;
    em.pass++;
    // The next level runs the lines the other way round, starting where this one ended.
    order = [...order].reverse();
  }
  em.pass = Math.max(0, em.pass - 1);
  em.rapid([em.cur[0], em.cur[1], clearanceZ]);
  const toolpath = { start: start ?? [0, 0, clearanceZ], entries: em.entries };
  return ok(warnings.length > 0 ? { toolpath, warnings } : { toolpath });
}
