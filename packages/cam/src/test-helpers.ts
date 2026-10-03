// Shared fixtures for the package's tests.

import { angleAbout, arcSweep, radiusAbout } from './arc';
import type { IrEntry, Move, Toolpath } from './ir';
import { isMove } from './ir';
import type { Box3, Vec3 } from './types';

/**
 * A small valid program: tool change, spindle on, rapid down, plunge, a straight cut, a half
 * circle, a lead move, a ramp, a dwell, a helical full turn, rapid up, spindle off.
 */
export function sampleToolpath(): Toolpath {
  const op = 'profile#1';
  const entries: IrEntry[] = [
    { kind: 'comment', text: 'Profile', op },
    { kind: 'toolChange', tool: 'tool#1', number: 201, name: '1/4in flat', op },
    { kind: 'spindle', state: 'cw', rpm: 18000, op },
    { kind: 'rapid', to: [0, 0, 5], op, pass: 0 },
    { kind: 'linear', to: [0, 0, -1], feed: 300, feedClass: 'plunge', op, pass: 0 },
    { kind: 'linear', to: [30, 40, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
    // Half turn about (30, 30) from (30, 40) to (30, 20), counter-clockwise: through x = 20.
    {
      kind: 'arc',
      to: [30, 20, -1],
      center: [30, 30],
      direction: 'ccw',
      fullCircle: false,
      feed: 1000,
      feedClass: 'cut',
      op,
      pass: 0,
    },
    { kind: 'linear', to: [40, 20, -1], feed: 500, feedClass: 'lead', op, pass: 0 },
    { kind: 'linear', to: [50, 20, -2], feed: 400, feedClass: 'ramp', op, pass: 1 },
    { kind: 'dwell', seconds: 1.5, op },
    // A helical full turn of radius 2 about (48, 20), down 1 mm.
    {
      kind: 'arc',
      to: [50, 20, -3],
      center: [48, 20],
      direction: 'cw',
      fullCircle: true,
      feed: 400,
      feedClass: 'ramp',
      op,
      pass: 1,
    },
    { kind: 'rapid', to: [50, 20, 10], op, pass: 1 },
    { kind: 'spindle', state: 'off', op },
  ];
  return { start: [0, 0, 10], entries };
}

/** Each move of `tp` with the position it starts from. */
export function movesWithStarts(tp: Toolpath): { from: Vec3; move: Move }[] {
  let pos = tp.start;
  const out: { from: Vec3; move: Move }[] = [];
  for (const e of tp.entries) {
    if (!isMove(e)) continue;
    out.push({ from: pos, move: e });
    pos = e.to;
  }
  return out;
}

/** Points along a move about every `step` mm in XY (arcs along the arc, helices included). */
export function sampleMove(from: Vec3, m: Move, step = 0.1): Vec3[] {
  if (m.kind !== 'arc') {
    const len = Math.hypot(m.to[0] - from[0], m.to[1] - from[1]);
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

/** A rapid that ran into material: where, and how far below the material top. */
export interface RapidCollision {
  readonly index: number;
  readonly at: Vec3;
  readonly depth: number;
}

/**
 * A heightmap material-removal check of a whole program (flat-bottomed tools): the stock is a
 * box in machine coordinates, every cell starting at its top; each feed move lowers the cells
 * under the current tool's disk (its diameter from the last `toolChange`) to the tool tip. Every
 * rapid is checked against the material left at that moment, under a disk `graze` mm narrower
 * than the tool (so running along the edge of a cut does not count). Returns the rapids that ran
 * more than `tolerance` mm below the material, worst first.
 */
export function rapidCollisions(
  tp: Toolpath,
  stock: Box3,
  options: { cell?: number; graze?: number; tolerance?: number; step?: number } = {},
): RapidCollision[] {
  const cell = options.cell ?? 0.25;
  const graze = options.graze ?? 0.05;
  const tolerance = options.tolerance ?? 1e-6;
  const step = options.step ?? cell / 2;
  const [x0, y0] = stock.min;
  const nx = Math.ceil((stock.max[0] - x0) / cell) + 1;
  const ny = Math.ceil((stock.max[1] - y0) / cell) + 1;
  const h = new Float64Array(nx * ny).fill(stock.max[2]);
  const disk = (x: number, y: number, rr: number, f: (k: number) => void): void => {
    if (rr < 0) return;
    const i0 = Math.max(0, Math.floor((x - rr - x0) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((x + rr - x0) / cell));
    const j0 = Math.max(0, Math.floor((y - rr - y0) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((y + rr - y0) / cell));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cx = x0 + i * cell;
        const cy = y0 + j * cell;
        if ((cx - x) ** 2 + (cy - y) ** 2 <= rr * rr) f(i * ny + j);
      }
    }
  };
  let r = 0;
  let pos = tp.start;
  const out: RapidCollision[] = [];
  tp.entries.forEach((e, index) => {
    if (e.kind === 'toolChange') r = (e.diameter ?? 0) / 2;
    if (!isMove(e)) return;
    const pts = sampleMove(pos, e, step);
    pos = e.to;
    if (e.kind === 'rapid') {
      let worst: RapidCollision | undefined;
      for (const p of pts) {
        disk(p[0], p[1], r - graze, (k) => {
          const depth = h[k]! - p[2];
          if (depth > tolerance && (!worst || depth > worst.depth)) worst = { index, at: p, depth };
        });
      }
      if (worst) out.push(worst);
      return;
    }
    for (const p of pts) {
      disk(p[0], p[1], r, (k) => {
        if (h[k]! > p[2]) h[k] = p[2];
      });
    }
  });
  return out.sort((a, b) => b.depth - a.depth);
}

/** A small seeded random number generator (mulberry32): the same seed, the same numbers. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where an operation's rapids go wrong over stock whose top is at `stockTop`: a sideways rapid
 * below `stockTop + safeAbove`, or a rapid down below that before any feed move has gone below
 * it (a rapid plunge into stock nothing has cut yet). Empty when the rapids are safe.
 */
export function rapidsIntoStockTop(tp: Toolpath, stockTop: number, safeAbove: number): string[] {
  const floor = stockTop + safeAbove - 1e-9;
  const out: string[] = [];
  let lowestFed = Infinity;
  for (const { from, move } of movesWithStarts(tp)) {
    if (move.kind !== 'rapid') {
      lowestFed = Math.min(lowestFed, move.to[2]);
      continue;
    }
    const sideways = Math.hypot(move.to[0] - from[0], move.to[1] - from[1]) > 1e-9;
    if (sideways && Math.min(from[2], move.to[2]) < floor) {
      out.push(`sideways rapid at Z ${Math.min(from[2], move.to[2])}`);
    } else if (move.to[2] < floor && move.to[2] < lowestFed) {
      out.push(`rapid down to Z ${move.to[2]} into uncut stock`);
    }
  }
  return out;
}
