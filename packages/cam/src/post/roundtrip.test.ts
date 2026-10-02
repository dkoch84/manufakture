import Toolpath from 'gcode-toolpath';
import { describe, expect, it } from 'vitest';
import { arcLength, arcSweep, radiusAbout } from '../arc';
import type { ArcMove, IrEntry, Move, Toolpath as IrToolpath } from '../ir';
import { isMove } from '../ir';
import { sampleToolpath } from '../test-helpers';
import type { Vec3 } from '../types';
import type { Dialect, PostUnits } from './dialect';
import { testDialect } from './test-helpers';
import { DEFAULT_POST_TOLERANCE, postProcess } from './writer';
import type { PostOptions } from './writer';

// Round trip (T5.4a acceptance): parse the engine's output with `gcode-toolpath` (cncjs, MIT), a
// parser we did not write, and compare every position it reports with the IR, within the output
// rounding. Each parsed move must be one of: the IR move in hand (a rapid to its target, a line
// along it, an arc about its centre in its direction, or chords of an arc written as lines), or a
// move of the engine's safe start (a rapid to the clearance height, and the first rapid split
// into vertical and horizontal parts). Every IR move must be reached, in order.

const CLEARANCE = 15;

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Parsed {
  readonly motion: string;
  readonly start: Point;
  readonly end: Point;
  readonly center?: Point;
}

/** Every move `gcode-toolpath` reports for `text`, in millimetres. */
function parse(text: string): Parsed[] {
  const out: Parsed[] = [];
  const toolpath = new Toolpath({
    addLine: (modal, start, end) => out.push({ motion: modal.motion, start, end }),
    addArcCurve: (modal, start, end, center) =>
      out.push({ motion: modal.motion, start, end, center }),
  });
  toolpath.loadFromStringSync(text);
  return out;
}

/** The IR's moves with the position each starts from. */
function irMoves(tp: IrToolpath): { move: Move; from: Vec3 }[] {
  const list: { move: Move; from: Vec3 }[] = [];
  let pos = tp.start;
  for (const e of tp.entries) {
    if (!isMove(e)) continue;
    list.push({ move: e, from: pos });
    pos = e.to;
  }
  return list;
}

/**
 * Compare the parsed moves of `files` with the IR. `half` is half an output step in mm: how far a
 * written coordinate may be from the IR's.
 */
function compare(tp: IrToolpath, files: readonly string[], units: PostUnits): number {
  const half = (units === 'inch' ? 0.0001 * 25.4 : 0.001) / 2 + 1e-9;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= half;
  const same = (p: Point, q: Vec3): boolean =>
    near(p.x, q[0]) && near(p.y, q[1]) && near(p.z, q[2]);
  const moves = irMoves(tp);
  let i = 0;
  let checked = 0;
  for (const text of files) {
    for (const seg of parse(text)) {
      const { start, end } = seg;
      if (start.x === end.x && start.y === end.y && start.z === end.z && !seg.center) continue;
      // IR moves that round to where the tool already is were dropped by the engine.
      while (i < moves.length && same(start, moves[i]!.move.to) && !hasLength(moves[i]!, half)) {
        i++;
      }
      const current = moves[i];
      const label = `${seg.motion} to (${end.x}, ${end.y}, ${end.z}) at IR move ${i}`;
      const vertical = start.x === end.x && start.y === end.y;
      checked++;

      if (seg.motion === 'G0') {
        if (current?.move.kind === 'rapid' && same(end, current.move.to)) {
          i++;
          continue;
        }
        // The engine's own rapids, and nothing else: straight up or down to the clearance (a safe
        // start, or a retract before a tool change or the footer), and the two halves of the
        // first rapid after a safe start (across at the clearance to the rapid's XY, or straight
        // up to the rapid's Z when that is above the clearance).
        const toClearance = vertical && near(end.z, CLEARANCE);
        const target = current?.move.kind === 'rapid' ? current.move.to : undefined;
        const across =
          target !== undefined &&
          near(start.z, CLEARANCE) &&
          near(end.z, CLEARANCE) &&
          near(end.x, target[0]) &&
          near(end.y, target[1]);
        const upFirst =
          target !== undefined && vertical && target[2] >= CLEARANCE && near(end.z, target[2]);
        expect(toClearance || across || upFirst, label).toBe(true);
        continue;
      }

      expect(current, label).toBeDefined();
      if (!current) return checked;
      const { move, from } = current;
      expect(move.kind, label).not.toBe('rapid');
      const reached = same(end, move.to);
      if (move.kind === 'linear') {
        expect(seg.motion, label).toBe('G1');
        expect(distanceToSegment(end, from, move.to), label).toBeLessThanOrEqual(half * 2);
      } else if (move.kind === 'arc' && seg.motion === 'G1') {
        // An arc written as chords: each end on the circle, each middle within the tolerance.
        const r = radiusAbout(move.center, from);
        const slack = DEFAULT_POST_TOLERANCE + 2 * half;
        expect(Math.abs(radiusAbout(move.center, [end.x, end.y]) - r), label).toBeLessThan(slack);
        const mid: [number, number] = [(start.x + end.x) / 2, (start.y + end.y) / 2];
        expect(r - radiusAbout(move.center, mid), label).toBeLessThan(slack);
        expect(between(end.z, from[2], move.to[2], half), label).toBe(true);
      } else if (move.kind === 'arc') {
        // An arc (or half of a full circle) about the IR's centre, in the IR's direction.
        expect(seg.motion, label).toBe(move.direction === 'cw' ? 'G2' : 'G3');
        const c = seg.center!;
        expect(Math.abs(c.x - move.center[0]), label).toBeLessThanOrEqual(3 * half);
        expect(Math.abs(c.y - move.center[1]), label).toBeLessThanOrEqual(3 * half);
        const r = radiusAbout(move.center, from);
        expect(Math.abs(radiusAbout(move.center, [end.x, end.y]) - r), label).toBeLessThan(
          4 * half,
        );
        // An arc ending where it starts is a full turn to every controller: only an intended full
        // circle may be written so.
        if (start.x === end.x && start.y === end.y) {
          expect(move.fullCircle, `${label}: an unintended full circle`).toBe(true);
        }
        // No more turning than the IR arc has.
        const written = arcSweep({
          start: [start.x, start.y, start.z],
          end: [end.x, end.y, end.z],
          center: [c.x, c.y],
          direction: move.direction,
          fullCircle: start.x === end.x && start.y === end.y,
        });
        const meant = arcSweep({
          start: from,
          end: move.to,
          center: move.center,
          direction: move.direction,
          fullCircle: move.fullCircle,
        });
        // Rounding moves each end by up to half * sqrt(2) and the written centre by up to
        // 2 * half * sqrt(2), so the sweep may grow by about 8.5 * half / r.
        expect(written, label).toBeLessThanOrEqual(meant + (10 * half) / r + 1e-9);
        expect(between(end.z, from[2], move.to[2], half), label).toBe(true);
      }
      if (reached) i++;
    }
  }
  while (i < moves.length && i > 0 && same(pointOf(moves[i - 1]!.move.to), moves[i]!.move.to)) i++;
  expect(i, 'every IR move is reached').toBe(moves.length);
  return checked;
}

/** Whether an IR move ending where the tool already is (after rounding) still cuts a path. */
function hasLength({ move, from }: { move: Move; from: Vec3 }, half: number): boolean {
  if (move.kind !== 'arc') return false;
  const arc = {
    start: from,
    end: move.to,
    center: move.center,
    direction: move.direction,
    fullCircle: move.fullCircle,
  };
  return arcLength(arc) > 4 * half;
}

function pointOf(v: Vec3): Point {
  return { x: v[0], y: v[1], z: v[2] };
}

function between(z: number, a: number, b: number, slack: number): boolean {
  return z >= Math.min(a, b) - slack && z <= Math.max(a, b) + slack;
}

function distanceToSegment(p: Point, a: Vec3, b: Vec3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
  const t =
    len2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a[0]) * d[0]! + (p.y - a[1]) * d[1]! + (p.z - a[2]) * d[2]!) / len2),
        );
  return Math.hypot(p.x - a[0] - t * d[0]!, p.y - a[1] - t * d[1]!, p.z - a[2] - t * d[2]!);
}

function roundTrip(tp: IrToolpath, dialect: Dialect, options: PostOptions = {}): number {
  const r = postProcess(
    { toolpath: tp, job: 'Round trip', heights: { clearance: CLEARANCE, retract: 5 } },
    dialect,
    options,
  );
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return compare(
    tp,
    r.value.files.map((f) => f.text),
    options.units ?? 'mm',
  );
}

const op = 'pocket#1';

/** Two tools, arcs of every kind the engine treats differently, rapids above and below clearance. */
function mixedToolpath(): IrToolpath {
  const arc = (to: Vec3, center: [number, number], extra: Partial<ArcMove> = {}): ArcMove => ({
    kind: 'arc',
    to,
    center,
    direction: 'ccw',
    fullCircle: false,
    feed: 900,
    feedClass: 'cut',
    op,
    pass: 0,
    ...extra,
  });
  const r = Math.hypot(5, 0.0004);
  const a = Math.atan2(-0.0004, 5);
  const entries: IrEntry[] = [
    { kind: 'toolChange', tool: 'tool#1', number: 1, name: '6mm flat', op },
    { kind: 'spindle', state: 'cw', rpm: 16000, op },
    { kind: 'rapid', to: [10, 0.0004, 20], op, pass: 0 },
    { kind: 'rapid', to: [10, 0.0004, 2], op, pass: 0 },
    { kind: 'linear', to: [10, 0.0004, -1], feed: 300, feedClass: 'plunge', op, pass: 0 },
    // All but a sliver of a turn: written as chords.
    arc([5 + r * Math.cos(a), r * Math.sin(a), -1], [5, 0]),
    { kind: 'linear', to: [10, 0, -1.2], feed: 900, feedClass: 'cut', op, pass: 0 },
    // A helical full turn, a clockwise half and a tiny arc that becomes one line.
    arc([10, 0, -2.2], [7, 0], { fullCircle: true }),
    arc([4, 0, -2.2], [7, 0], { direction: 'cw' }),
    arc([4 + 10 * (Math.cos(0.0008) - 1), 10 * Math.sin(0.0008), -2.2], [14, 0], {
      direction: 'ccw',
    }),
    { kind: 'dwell', seconds: 0.5, op },
    { kind: 'rapid', to: [4, 0, 10], op, pass: 0 },
    { kind: 'spindle', state: 'off', op },
    { kind: 'comment', text: 'Second tool', op: 'drill#1' },
    { kind: 'toolChange', tool: 'tool#2', number: 2, name: '3mm drill', op: 'drill#1' },
    { kind: 'spindle', state: 'cw', rpm: 12000, op: 'drill#1' },
    { kind: 'rapid', to: [30.1234, -12.3456, 3], op: 'drill#1', pass: 0 },
    {
      kind: 'linear',
      to: [30.1234, -12.3456, -6],
      feed: 200,
      feedClass: 'plunge',
      op: 'drill#1',
      pass: 0,
    },
    { kind: 'rapid', to: [30.1234, -12.3456, 3], op: 'drill#1', pass: 0 },
    { kind: 'rapid', to: [40.5, 7.25, 3], op: 'drill#1', pass: 1 },
    {
      kind: 'linear',
      to: [40.5, 7.25, -6],
      feed: 200,
      feedClass: 'plunge',
      op: 'drill#1',
      pass: 1,
    },
    { kind: 'rapid', to: [40.5, 7.25, 10], op: 'drill#1', pass: 1 },
    { kind: 'spindle', state: 'off', op: 'drill#1' },
  ];
  return { start: [0, 0, 10], entries };
}

describe('round trip through gcode-toolpath', () => {
  it('reads the sample program back onto the IR, in millimetres and inches', () => {
    for (const units of ['mm', 'inch'] as const) {
      for (const fullCircles of ['halves', 'single'] as const) {
        expect(
          roundTrip(sampleToolpath(), testDialect({ fullCircles }), { units }),
        ).toBeGreaterThan(8);
      }
    }
  });

  it('reads a two-tool job back in every file mode and tool change style', () => {
    const tp = mixedToolpath();
    const m6 = testDialect({ mCodes: ['M0', 'M3', 'M5', 'M6', 'M30'] });
    for (const units of ['mm', 'inch'] as const) {
      expect(roundTrip(tp, testDialect(), { units })).toBeGreaterThan(10);
      expect(
        roundTrip(tp, testDialect(), { units, splitPerTool: false, toolChange: 'm0-pause' }),
      ).toBeGreaterThan(10);
      expect(roundTrip(tp, m6, { units, splitPerTool: false, toolChange: 'm6' })).toBeGreaterThan(
        20,
      );
      expect(roundTrip(tp, testDialect({ fullCircles: 'single' }), { units })).toBeGreaterThan(10);
    }
  });

  it('reads random arcs back onto their IR arcs', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let cases = 0;
    for (let n = 0; n < 400; n++) {
      const center: [number, number] = [(next() - 0.5) * 600, (next() - 0.5) * 600];
      const r = 10 ** (-1.5 + 4 * next());
      const a0 = (next() - 0.5) * 2 * Math.PI;
      const full = next() < 0.15;
      const sweep = full ? 2 * Math.PI : 0.001 + (2 * Math.PI - 0.002) * next();
      const ccw = next() < 0.5;
      const z1 = next() < 0.5 ? -1 : -1 - 2 * next();
      const start: Vec3 = [center[0] + r * Math.cos(a0), center[1] + r * Math.sin(a0), -1];
      const a1 = a0 + (ccw ? sweep : -sweep);
      const end: Vec3 = full
        ? [start[0], start[1], z1]
        : [center[0] + r * Math.cos(a1), center[1] + r * Math.sin(a1), z1];
      const tp: IrToolpath = {
        start: [0, 0, 10],
        entries: [
          { kind: 'toolChange', tool: 'tool#1', number: 1, name: 'flat', op },
          { kind: 'spindle', state: 'cw', rpm: 18000, op },
          { kind: 'rapid', to: [start[0], start[1], 5], op, pass: 0 },
          { kind: 'linear', to: start, feed: 300, feedClass: 'plunge', op, pass: 0 },
          {
            kind: 'arc',
            to: end,
            center,
            direction: ccw ? 'ccw' : 'cw',
            fullCircle: full,
            feed: 1000,
            feedClass: 'cut',
            op,
            pass: 0,
          },
          { kind: 'rapid', to: [end[0], end[1], 10], op, pass: 0 },
          { kind: 'spindle', state: 'off', op },
        ],
      };
      const units: PostUnits = next() < 0.5 ? 'mm' : 'inch';
      const dialect = testDialect({ fullCircles: next() < 0.5 ? 'single' : 'halves' });
      roundTrip(tp, dialect, { units });
      cases++;
    }
    expect(cases).toBe(400);
  });
});
