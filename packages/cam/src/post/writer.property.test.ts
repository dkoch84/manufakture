import { describe, expect, it } from 'vitest';
import type { IrEntry, Toolpath } from '../ir';
import { validateToolpath } from '../validate';
import type { Vec2, Vec3 } from '../types';
import { MM_PER_INCH } from '@manufakture/units';
import {
  GRBL_CHECK_OFFSETS,
  GRBL_TRAVEL_EPSILON,
  grblArcCheck,
  grblRadiusAllowance,
} from './grbl-arc';
import { testDialect } from './test-helpers';
import { DEFAULT_POST_TOLERANCE, MIN_ARC_CHORD_STEPS, postProcess } from './writer';
import type { PostUnits } from './dialect';

// Property test (T5.4a acceptance): random arcs, written by the engine, read back from the text
// alone. Every G2/G3 line must pass Grbl's radius rule and give the angular travel its geometry
// means, after rounding, at every work offset; every arc must end where the IR ends; and every
// arc written as lines must stay within the tolerance of the IR circle.

/** A small seeded generator (mulberry32), so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  readonly center: Vec2;
  readonly r: number;
  readonly a0: number;
  readonly sweep: number;
  readonly ccw: boolean;
  readonly full: boolean;
  readonly z0: number;
  readonly z1: number;
  readonly units: PostUnits;
  readonly single: boolean;
}

function randomCase(next: () => number): Case {
  const pick = next();
  const full = pick < 0.1;
  let sweep: number;
  if (full) sweep = 2 * Math.PI;
  else if (pick < 0.3)
    sweep = 10 ** (-7 + 5 * next()); // tiny: 1e-7 to 1e-2 rad
  else if (pick < 0.4)
    sweep = 2 * Math.PI - 10 ** (-6 + 4 * next()); // all but a sliver
  else sweep = 0.01 + (2 * Math.PI - 0.02) * next();
  const z0 = -1;
  return {
    center: [(next() - 0.5) * 1000, (next() - 0.5) * 1000],
    r: 10 ** (-3 + 5.7 * next()), // 0.001 to 500 mm
    a0: (next() - 0.5) * 2 * Math.PI,
    sweep,
    ccw: next() < 0.5,
    full,
    z0,
    z1: next() < 0.5 ? z0 : z0 - 3 * next(),
    units: next() < 0.5 ? 'mm' : 'inch',
    single: next() < 0.5,
  };
}

const op = 'pocket#1';

function toolpathOf(c: Case): { toolpath: Toolpath; start: Vec3; end: Vec3 } {
  const at = (a: number, z: number): Vec3 => [
    c.center[0] + c.r * Math.cos(a),
    c.center[1] + c.r * Math.sin(a),
    z,
  ];
  const start = at(c.a0, c.z0);
  const end = c.full
    ? ([start[0], start[1], c.z1] as Vec3)
    : at(c.a0 + (c.ccw ? 1 : -1) * c.sweep, c.z1);
  const entries: IrEntry[] = [
    { kind: 'toolChange', tool: 'tool#1', number: 1, name: 'flat', op },
    { kind: 'spindle', state: 'cw', rpm: 18000, op },
    { kind: 'rapid', to: [start[0], start[1], 5], op, pass: 0 },
    { kind: 'linear', to: start, feed: 300, feedClass: 'plunge', op, pass: 0 },
    {
      kind: 'arc',
      to: end,
      center: c.center,
      direction: c.ccw ? 'ccw' : 'cw',
      fullCircle: c.full,
      feed: 1000,
      feedClass: 'cut',
      op,
      pass: 0,
    },
    { kind: 'rapid', to: [end[0], end[1], 10], op, pass: 0 },
    { kind: 'spindle', state: 'off', op },
  ];
  return { toolpath: { start: [0, 0, 10], entries }, start, end };
}

/** The words of a line, by letter. */
function words(line: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const w of line.split(' ')) m.set(w[0]!, w.slice(1));
  return m;
}

/** CCW angle from `u` to `v` in (0, 2 pi], or 0 for parallel vectors (equal points). */
function ccwAngle(u: Vec2, v: Vec2): number {
  const a = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
  return a <= 0 ? a + 2 * Math.PI : a;
}

describe('postProcess: random arcs (property)', () => {
  it('every written arc passes Grbl after rounding, and every arc ends where the IR ends', () => {
    const next = rng(20261002);
    const counts = { cases: 0, refused: 0, arcLines: 0, asLines: 0 };
    for (let n = 0; n < 3000; n++) {
      const c = randomCase(next);
      const { toolpath, end } = toolpathOf(c);
      const result = postProcess(
        { toolpath, job: 'property', heights: { clearance: 15, retract: 5 } },
        testDialect({ fullCircles: c.single ? 'single' : 'halves' }),
        { units: c.units },
      );
      const ir = validateToolpath(toolpath);
      if (ir.length > 0) {
        // Arcs the IR itself rejects (a tiny sweep whose ends coincide) are refused, never written.
        expect(result.ok, JSON.stringify(c)).toBe(false);
        counts.refused++;
        continue;
      }
      expect(result.ok, JSON.stringify(c)).toBe(true);
      if (!result.ok) continue;
      counts.cases++;
      counts.asLines += result.value.stats.arcsAsLines;

      const k = c.units === 'inch' ? MM_PER_INCH : 1; // file units to mm
      const step = c.units === 'inch' ? 1e-4 : 1e-3;
      const lines = result.value.files[0]!.lines;
      const first = lines.findIndex((l) => l.startsWith('G1 '));
      const last = lines.findIndex((l, n) => n > first && l.startsWith('G0 '));
      // The plunge sets the written start of the arc.
      const pos = { X: '', Y: '', Z: '' };
      for (const l of lines.slice(0, first + 1)) {
        for (const [letter, value] of words(l)) {
          if (letter === 'X' || letter === 'Y' || letter === 'Z') pos[letter] = value;
        }
      }
      const where = (): Vec3 => [Number(pos.X) * k, Number(pos.Y) * k, Number(pos.Z) * k];
      const r = c.r;
      // How far a written point may sit from the IR circle: the tolerance plus rounding.
      const slack = DEFAULT_POST_TOLERANCE + step * k * Math.SQRT2 + 1e-9;
      let motion = 'G1';
      for (const l of lines.slice(first + 1, last)) {
        const w = words(l);
        const g = l.startsWith('G') ? l.split(' ')[0]! : motion;
        motion = g;
        const before = { ...pos };
        for (const letter of ['X', 'Y', 'Z'] as const) {
          const v = w.get(letter);
          if (v !== undefined) pos[letter] = v;
        }
        const p = where();
        // Every written point lies on the IR circle, within the slack.
        expect(Math.abs(Math.hypot(p[0] - c.center[0], p[1] - c.center[1]) - r)).toBeLessThan(
          slack,
        );
        if (g === 'G1') {
          // The chord's middle stays within the tolerance of the arc too.
          const m: Vec2 = [
            ((Number(before.X) + Number(pos.X)) / 2) * k,
            ((Number(before.Y) + Number(pos.Y)) / 2) * k,
          ];
          expect(r - Math.hypot(m[0] - c.center[0], m[1] - c.center[1])).toBeLessThan(slack);
          continue;
        }
        expect(g === 'G2' || g === 'G3', l).toBe(true);
        counts.arcLines++;
        const ij: [string, string] = [w.get('I')!, w.get('J')!];
        const start: [string, string] = [before.X, before.Y];
        const stop: [string, string] = [pos.X, pos.Y];
        const same = start[0] === stop[0] && start[1] === stop[1];
        // Only an intended full circle, written as one arc, may end where it starts.
        if (same) expect(c.full && c.single, l).toBe(true);
        else {
          const chord = Math.hypot(
            Number(stop[0]) - Number(start[0]),
            Number(stop[1]) - Number(start[1]),
          );
          expect(chord).toBeGreaterThanOrEqual(MIN_ARC_CHORD_STEPS * step - 1e-12);
        }
        // Grbl's radius rule on the written numbers, in exact arithmetic, in mm.
        const i = Number(ij[0]) * k;
        const j = Number(ij[1]) * k;
        const sx = Number(start[0]) * k;
        const sy = Number(start[1]) * k;
        const r0 = Math.hypot(i, j);
        const r1 = Math.hypot(Number(stop[0]) * k - sx - i, Number(stop[1]) * k - sy - j);
        expect(Math.abs(r1 - r0), l).toBeLessThanOrEqual(grblRadiusAllowance(r0));
        // The travel Grbl computes is the sweep the written geometry means.
        const u: Vec2 = [-i, -j];
        const v: Vec2 = [Number(stop[0]) * k - sx - i, Number(stop[1]) * k - sy - j];
        const ccw = g === 'G3';
        let meant = ccw ? ccwAngle(u, v) : ccwAngle(v, u);
        if (same) meant = 2 * Math.PI;
        let travel = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
        if (!ccw && travel >= -GRBL_TRAVEL_EPSILON) travel -= 2 * Math.PI;
        if (ccw && travel <= GRBL_TRAVEL_EPSILON) travel += 2 * Math.PI;
        expect(Math.abs(Math.abs(travel) - meant), l).toBeLessThan(0.5);
        // And no piece is a full turn unless a full circle was meant.
        if (!c.full) expect(Math.abs(travel)).toBeLessThan(c.sweep + 0.5);
        // The engine's own single precision check agrees, at every offset.
        const check = grblArcCheck(
          {
            start,
            end: stop,
            ij,
            inches: c.units === 'inch',
            direction: ccw ? 'ccw' : 'cw',
            sweep: meant,
          },
          GRBL_CHECK_OFFSETS,
        );
        expect(check.ok, l).toBe(true);
      }
      // The arc ends at the IR end, rounded.
      const p = where();
      expect(Math.abs(p[0] - end[0])).toBeLessThanOrEqual((step / 2) * k + 1e-9);
      expect(Math.abs(p[1] - end[1])).toBeLessThanOrEqual((step / 2) * k + 1e-9);
      expect(Math.abs(p[2] - end[2])).toBeLessThanOrEqual((step / 2) * k + 1e-9);
    }
    // The generator covers both paths: arcs written as arcs, and arcs written as lines.
    expect(counts.cases).toBeGreaterThan(2000);
    expect(counts.arcLines).toBeGreaterThan(1500);
    expect(counts.asLines).toBeGreaterThan(300);
    expect(counts.refused).toBeGreaterThan(10);
  });
});
