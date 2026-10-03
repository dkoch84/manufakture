// Toolpath IR to line geometry for the preview (M5 plan, T5.3b). Pure: no three.js, no DOM.
//
// A job can hold hundreds of thousands of moves, so the preview never makes an object per move.
// Every move's segments go into one flat buffer per operation and move class (cuts, plunges,
// ramps, rapids), in program order, with the index of the move each segment belongs to beside it;
// the playback draws a prefix of each buffer (`segmentsBefore`) instead of rebuilding anything.
// Arcs (helices included) are tessellated so that no chord strays more than `tolerance` from the
// true arc.
//
// Everything here is in machine (WCS) coordinates; the scene places the whole group on the part
// with the WCS frame. Moves are numbered in program order; nothing assumes that an operation's
// `pass` numbers increase (reordered drill holes keep their own).

import {
  angleAbout,
  arcFrom,
  arcLength,
  arcSweep,
  radiusAbout,
  type ArcMove,
  type Box3,
  type IrEntry,
  type Move,
  type Toolpath,
  type Vec3,
} from '@manufakture/cam';

/** How far a tessellated arc's chords may stray from the arc, mm. */
export const PREVIEW_ARC_TOLERANCE = 0.01;

/** The largest angle one chord of an arc spans, radians, however loose the tolerance. */
export const PREVIEW_MAX_ARC_STEP = Math.PI / 8;

/** The most chords one arc gets: a bound for absurd radius-to-tolerance ratios. */
export const PREVIEW_MAX_ARC_SEGMENTS = 4096;

/** How a move is drawn: cuts (and leads) in the operation's colour, the rest by class. */
export type MoveClass = 'cut' | 'plunge' | 'ramp' | 'rapid';

export const MOVE_CLASSES: readonly MoveClass[] = ['cut', 'plunge', 'ramp', 'rapid'];

export function moveClassOf(move: Move): MoveClass {
  if (move.kind === 'rapid') return 'rapid';
  if (move.feedClass === 'plunge') return 'plunge';
  if (move.feedClass === 'ramp') return 'ramp';
  return 'cut';
}

/** One operation's moves of one class, as line segments. */
export interface PreviewBuffer {
  /** The operation id (`profile#1`), or the job's `link`. */
  readonly op: string;
  readonly moveClass: MoveClass;
  /** Two points (six numbers) per segment, machine coordinates. */
  readonly positions: Float32Array;
  /** Per segment, the index of its move in the program; never decreasing. */
  readonly moves: Uint32Array;
  /** Rapids only: per point, its distance along its segment (0, then the length), for dashes. */
  readonly lineDistances?: Float32Array;
}

/** A program as the preview draws and plays it. */
export interface PreviewPath {
  /** Where the tool is before the first move. */
  readonly start: Vec3;
  readonly moveCount: number;
  /** Per move, where it ends: x, y, z. */
  readonly ends: Float64Array;
  /** Per move, its operation's index in `ops`. */
  readonly opOf: Int32Array;
  readonly ops: readonly string[];
  /** Per move, the index in `tools` of the tool loaded for it (the last tool change), or -1. */
  readonly toolOf: Int32Array;
  readonly tools: readonly string[];
  /** Per move, the estimated minutes from the program start to its end (`toolpathStats` rules). */
  readonly minutes: Float64Array;
  readonly buffers: readonly PreviewBuffer[];
  /** Every point drawn, the start included. */
  readonly bounds: Box3;
}

export interface PreviewOptions {
  /** The machine's rapid rate, mm/min, for the time line. */
  readonly rapidRate: number;
  /** Chord tolerance for arcs, mm; default `PREVIEW_ARC_TOLERANCE`. */
  readonly tolerance?: number;
}

/**
 * How many chords an arc of `radius` and `sweep` needs so that none strays more than `tolerance`
 * from it: a chord spanning angle t is off by r (1 - cos(t / 2)) at its middle.
 */
export function arcSegmentCount(radius: number, sweep: number, tolerance: number): number {
  if (!(sweep > 0) || !Number.isFinite(sweep)) return 1;
  let step = PREVIEW_MAX_ARC_STEP;
  if (radius > tolerance && tolerance > 0) {
    step = Math.min(step, 2 * Math.acos(1 - tolerance / radius));
  }
  return Math.min(PREVIEW_MAX_ARC_SEGMENTS, Math.max(1, Math.ceil(sweep / step - 1e-9)));
}

/**
 * The points of an arc move from `from`, after the start: chords within `tolerance`, the last
 * point exactly the move's `to`. Z runs linearly with the angle (a helix), and so does the radius
 * when the end's differs a little from the start's.
 */
export function tessellateArc(from: Vec3, move: ArcMove, tolerance: number): Vec3[] {
  const arc = arcFrom(from, move);
  const sweep = arcSweep(arc);
  const r0 = radiusAbout(move.center, from);
  const r1 = radiusAbout(move.center, move.to);
  const n = arcSegmentCount(Math.max(r0, r1), sweep, tolerance);
  const a0 = angleAbout(move.center, from);
  const sign = move.direction === 'ccw' ? 1 : -1;
  const points: Vec3[] = [];
  for (let k = 1; k < n; k++) {
    const f = k / n;
    const a = a0 + sign * sweep * f;
    const r = r0 + (r1 - r0) * f;
    points.push([
      move.center[0] + r * Math.cos(a),
      move.center[1] + r * Math.sin(a),
      from[2] + (move.to[2] - from[2]) * f,
    ]);
  }
  points.push([move.to[0], move.to[1], move.to[2]]);
  return points;
}

/** A growable typed array of numbers. */
class Floats {
  data: Float64Array;
  length = 0;
  constructor(capacity = 64) {
    this.data = new Float64Array(capacity);
  }
  push(...values: number[]): void {
    if (this.length + values.length > this.data.length) {
      const next = new Float64Array(Math.max(this.data.length * 2, this.length + values.length));
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    for (const v of values) this.data[this.length++] = v;
  }
}

interface BufferBuilder {
  op: string;
  moveClass: MoveClass;
  positions: Floats;
  moves: Floats;
  distances: Floats | null;
}

/** The toolpath's moves as line buffers and a time line (see the module comment). */
export function previewGeometry(toolpath: Toolpath, options: PreviewOptions): PreviewPath {
  const tolerance = options.tolerance ?? PREVIEW_ARC_TOLERANCE;
  const rapidRate = options.rapidRate;
  const moves = toolpath.entries.filter(
    (e): e is Move => e.kind === 'rapid' || e.kind === 'linear' || e.kind === 'arc',
  ).length;
  const ends = new Float64Array(moves * 3);
  const opOf = new Int32Array(moves);
  const toolOf = new Int32Array(moves);
  const minutes = new Float64Array(moves);
  const ops: string[] = [];
  const opIndex = new Map<string, number>();
  const tools: string[] = [];
  const builders = new Map<string, BufferBuilder>();
  const min = [...toolpath.start];
  const max = [...toolpath.start];
  const grow = (p: Vec3) => {
    for (let i = 0; i < 3; i++) {
      if (p[i]! < min[i]!) min[i] = p[i]!;
      if (p[i]! > max[i]!) max[i] = p[i]!;
    }
  };

  let pos: Vec3 = toolpath.start;
  let tool = -1;
  let clock = 0;
  let index = 0;
  const visit = (e: IrEntry) => {
    if (e.kind === 'toolChange') {
      let t = tools.indexOf(e.tool);
      if (t < 0) t = tools.push(e.tool) - 1;
      tool = t;
      return;
    }
    if (e.kind === 'dwell') {
      clock += e.seconds / 60;
      return;
    }
    if (e.kind !== 'rapid' && e.kind !== 'linear' && e.kind !== 'arc') return;
    const moveClass = moveClassOf(e);
    let op = opIndex.get(e.op);
    if (op === undefined) {
      op = ops.push(e.op) - 1;
      opIndex.set(e.op, op);
    }
    const key = `${op}/${moveClass}`;
    let b = builders.get(key);
    if (!b) {
      b = {
        op: e.op,
        moveClass,
        positions: new Floats(),
        moves: new Floats(),
        distances: moveClass === 'rapid' ? new Floats() : null,
      };
      builders.set(key, b);
    }
    const points = e.kind === 'arc' ? tessellateArc(pos, e, tolerance) : [e.to];
    let prev = pos;
    for (const p of points) {
      b.positions.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
      b.moves.push(index);
      b.distances?.push(0, Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
      grow(p);
      prev = p;
    }
    if (e.kind === 'rapid') {
      clock += Math.hypot(e.to[0] - pos[0], e.to[1] - pos[1], e.to[2] - pos[2]) / rapidRate;
    } else {
      const length =
        e.kind === 'linear'
          ? Math.hypot(e.to[0] - pos[0], e.to[1] - pos[1], e.to[2] - pos[2])
          : arcLength(arcFrom(pos, e));
      clock += length / e.feed;
    }
    ends.set(e.to, index * 3);
    opOf[index] = op;
    toolOf[index] = tool;
    minutes[index] = clock;
    pos = e.to;
    index++;
  };
  for (const e of toolpath.entries) visit(e);

  const buffers: PreviewBuffer[] = [...builders.values()].map((b) => ({
    op: b.op,
    moveClass: b.moveClass,
    positions: Float32Array.from(b.positions.data.subarray(0, b.positions.length)),
    moves: Uint32Array.from(b.moves.data.subarray(0, b.moves.length)),
    ...(b.distances
      ? { lineDistances: Float32Array.from(b.distances.data.subarray(0, b.distances.length)) }
      : {}),
  }));
  return {
    start: [toolpath.start[0], toolpath.start[1], toolpath.start[2]],
    moveCount: moves,
    ends,
    opOf,
    ops,
    toolOf,
    tools,
    minutes,
    buffers,
    bounds: { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] },
  };
}

/** How many of the buffer's segments belong to the first `done` moves (binary search). */
export function segmentsBefore(buffer: PreviewBuffer, done: number): number {
  const moves = buffer.moves;
  let lo = 0;
  let hi = moves.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (moves[mid]! < done) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where the tool is once `done` moves have run: the start for 0, else move `done - 1`'s end. */
export function toolPositionAt(path: PreviewPath, done: number): Vec3 {
  const k = Math.min(Math.max(Math.round(done), 0), path.moveCount);
  if (k === 0) return path.start;
  const i = (k - 1) * 3;
  return [path.ends[i]!, path.ends[i + 1]!, path.ends[i + 2]!];
}

/** How many moves have finished `t` estimated minutes into the program. */
export function movesDoneAt(path: PreviewPath, t: number): number {
  const m = path.minutes;
  let lo = 0;
  let hi = m.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (m[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The estimated minutes at which `done` moves have run. */
export function minutesAt(path: PreviewPath, done: number): number {
  const k = Math.min(Math.max(Math.round(done), 0), path.moveCount);
  return k === 0 ? 0 : path.minutes[k - 1]!;
}
