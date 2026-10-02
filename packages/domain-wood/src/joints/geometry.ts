// How two boards lie relative to each other, from their frames alone (M4 plan T4.2b): board B's
// blank expressed in board A's frame, the overlap of the two blanks, and tool primitives placed
// in A's frame. Everything a joint cuts is a box or a cylinder whose position comes from here.
//
// Coordinates "in A" are along A's frame axes from A's blank corner: index 0 along the length,
// 1 along the width, 2 along the thickness, so A's blank is `[0, size]` on each axis. B must be
// square to A (each of its axes parallel to one of A's, either way): boards at odd angles (a
// splayed leg) are refused, since the contact of such boards is not a box.

import type { ToolItem, Vec3 } from '@manufakture/kernel';
import type { BoardFrame } from '../board';

/** Two lengths closer than this (mm) are the same: a flush face, a touching contact. */
export const LINEAR_TOL = 1e-6;
/** How far from 1 the cosine between two axes may be for them to count as parallel. */
export const PARALLEL_TOL = 1e-9;

export type V3 = [number, number, number];
/** A frame axis index: 0 length, 1 width, 2 thickness. */
export type AxisIndex = 0 | 1 | 2;
export const AXES: readonly AxisIndex[] = [0, 1, 2];
export const AXIS_NAMES = ['length', 'width', 'thickness'] as const;

/** A board as a joint reads it: its body id and frame. */
export interface Board {
  id: string;
  origin: V3;
  /** Unit axes: length, width, thickness. */
  axes: [V3, V3, V3];
  size: V3;
}

export function boardOf(id: string, frame: BoardFrame): Board {
  const v = (a: readonly number[]): V3 => [a[0]!, a[1]!, a[2]!];
  return {
    id,
    origin: v(frame.origin),
    axes: [v(frame.axes.length), v(frame.axes.width), v(frame.axes.thickness)],
    size: [frame.size.length, frame.size.width, frame.size.thickness],
  };
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Board B as seen from board A. */
export interface Pair {
  a: Board;
  b: Board;
  /** For each of B's axes (length, width, thickness): the A axis it lies along, and which way. */
  map: [
    { axis: AxisIndex; sign: 1 | -1 },
    { axis: AxisIndex; sign: 1 | -1 },
    { axis: AxisIndex; sign: 1 | -1 },
  ];
  /** B's blank in A: its low and high corner. */
  bLo: V3;
  bHi: V3;
  /** The overlap of the blanks in A (`lo > hi` on an axis where they are apart). */
  lo: V3;
  hi: V3;
}

/** B in A's frame, or why the boards cannot be joined (they are not square to each other). */
export function pairOf(
  a: Board,
  b: Board,
): { ok: true; pair: Pair } | { ok: false; message: string } {
  const map: { axis: AxisIndex; sign: 1 | -1 }[] = [];
  let worst = 0;
  for (const j of AXES) {
    let best: AxisIndex = 0;
    let bestDot = 0;
    for (const i of AXES) {
      const d = dot(b.axes[j], a.axes[i]);
      if (Math.abs(d) > Math.abs(bestDot)) {
        best = i;
        bestDot = d;
      }
    }
    worst = Math.max(worst, 1 - Math.abs(bestDot));
    map.push({ axis: best, sign: bestDot < 0 ? -1 : 1 });
  }
  if (worst > PARALLEL_TOL || new Set(map.map((m) => m.axis)).size !== 3) {
    const off = Math.acos(Math.min(1, 1 - worst));
    const degrees = Math.round(((off * 180) / Math.PI) * 10) / 10;
    return {
      ok: false,
      message: `${b.id} is not square to ${a.id} (about ${degrees}° off): joints in M4 join boards whose faces are parallel or square to each other, so a splayed or angled joint is not supported`,
    };
  }
  const o = toA(a, b.origin);
  const bLo: V3 = [...o];
  const bHi: V3 = [...o];
  map.forEach((m, j) => {
    const s = m.sign * b.size[j]!;
    bLo[m.axis] = Math.min(o[m.axis], o[m.axis] + s);
    bHi[m.axis] = Math.max(o[m.axis], o[m.axis] + s);
  });
  const lo: V3 = [0, 0, 0];
  const hi: V3 = [0, 0, 0];
  for (const i of AXES) {
    lo[i] = Math.max(0, bLo[i]);
    hi[i] = Math.min(a.size[i], bHi[i]);
  }
  return {
    ok: true,
    pair: { a, b, map: map as Pair['map'], bLo, bHi, lo, hi },
  };
}

/** A model point in A's coordinates. */
export function toA(a: Board, p: readonly number[]): V3 {
  const d = [p[0]! - a.origin[0], p[1]! - a.origin[1], p[2]! - a.origin[2]];
  return [dot(d, a.axes[0]), dot(d, a.axes[1]), dot(d, a.axes[2])];
}

/** A point in A's coordinates, in the model. */
export function pointOf(a: Board, c: readonly number[]): Vec3 {
  return clean([
    a.origin[0] + c[0]! * a.axes[0][0] + c[1]! * a.axes[1][0] + c[2]! * a.axes[2][0],
    a.origin[1] + c[0]! * a.axes[0][1] + c[1]! * a.axes[1][1] + c[2]! * a.axes[2][1],
    a.origin[2] + c[0]! * a.axes[0][2] + c[1]! * a.axes[1][2] + c[2]! * a.axes[2][2],
  ]);
}

/** A direction in A's coordinates, in the model. */
export function directionOf(a: Board, c: readonly number[]): Vec3 {
  return clean([
    c[0]! * a.axes[0][0] + c[1]! * a.axes[1][0] + c[2]! * a.axes[2][0],
    c[0]! * a.axes[0][1] + c[1]! * a.axes[1][1] + c[2]! * a.axes[2][1],
    c[0]! * a.axes[0][2] + c[1]! * a.axes[1][2] + c[2]! * a.axes[2][2],
  ]);
}

/** Exact zeros instead of -0, so inputs hash the same either way. */
function clean(v: readonly number[]): Vec3 {
  return [v[0] === 0 ? 0 : v[0]!, v[1] === 0 ? 0 : v[1]!, v[2] === 0 ? 0 : v[2]!];
}

/** The unit vector of A axis `i`, `sign` way, in A's coordinates. */
export function unitA(i: AxisIndex, sign: 1 | -1 = 1): V3 {
  const v: V3 = [0, 0, 0];
  v[i] = sign;
  return v;
}

/** The A axis that is neither `i` nor `j`. */
export function thirdAxis(i: AxisIndex, j: AxisIndex): AxisIndex {
  return (3 - i - j) as AxisIndex;
}

/**
 * A box tool from `lo` to `hi` in A's coordinates. Its frame is A's (x along A's length, y along
 * its width, normal along its thickness), so the roles `xmin` .. `zmax` are the faces at the low
 * and high ends of A's axes, whichever body it cuts.
 */
export function boxTool(
  a: Board,
  id: string,
  body: string,
  lo: readonly number[],
  hi: readonly number[],
  mode: ToolItem['mode'] = 'subtract',
): ToolItem {
  return {
    id,
    body,
    mode,
    primitive: {
      type: 'box',
      frame: { origin: pointOf(a, lo), xDir: a.axes[0], normal: a.axes[2] },
      size: [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!],
    },
  };
}

/** A cylinder tool from `origin` along `direction`, both in A's coordinates. */
export function cylinderTool(
  a: Board,
  id: string,
  body: string,
  origin: readonly number[],
  direction: readonly number[],
  radius: number,
  length: number,
  options: { step?: { radius: number; length: number }; mode?: ToolItem['mode'] } = {},
): ToolItem {
  return {
    id,
    body,
    mode: options.mode ?? 'subtract',
    primitive: {
      type: 'cylinder',
      axis: { origin: pointOf(a, origin), direction: directionOf(a, direction) },
      radius,
      length,
      ...(options.step === undefined ? {} : { step: options.step }),
    },
  };
}

/** Whether a box from `lo` to `hi` has some size on every axis. */
export function solid(lo: readonly number[], hi: readonly number[]): boolean {
  return AXES.every((i) => hi[i]! - lo[i]! > LINEAR_TOL);
}

/** A length in mm for messages: at most two decimals. */
export function mm(x: number): string {
  return `${Math.round(x * 100) / 100} mm`;
}

// How B meets A --------------------------------------------------------------------------------

/** B entering one face of A: the face and how deep. */
export interface Entry {
  /** The A axis B enters along. */
  axis: AxisIndex;
  /** The face of A it enters: at the low (-1) or high (1) end of that axis. */
  side: 1 | -1;
  /** How far B reaches into A along the axis. */
  depth: number;
  /** B reaches A's far face. */
  through: boolean;
}

/**
 * Where B enters A, for joints whose boards overlap (a dado, a rabbet, a tenon, a box joint's
 * fingers): B's blank must reach into A's (a board's blank includes its joinery, which is also
 * what the cut list reads), across exactly one face of A, and lie within A on the other two axes.
 */
export function entryOf(
  p: Pair,
  what: string,
): { ok: true; entry: Entry } | { ok: false; message: string } {
  const { a, b } = p;
  const extent = AXES.map((i) => p.hi[i] - p.lo[i]);
  if (extent.some((d) => d < -LINEAR_TOL)) {
    return {
      ok: false,
      message: `${b.id} does not meet ${a.id}: ${what} needs ${b.id} drawn into ${a.id} by the joint's depth`,
    };
  }
  if (extent.some((d) => d <= LINEAR_TOL)) {
    return {
      ok: false,
      message: `${b.id} only touches ${a.id}: ${what} needs ${b.id} drawn into ${a.id} by the joint's depth (a board's blank includes its joinery)`,
    };
  }
  const beyond = AXES.map((i) => ({
    low: p.bLo[i] < -LINEAR_TOL,
    high: p.bHi[i] > a.size[i] + LINEAR_TOL,
  }));
  const axes = AXES.filter((i) => beyond[i]!.low || beyond[i]!.high);
  if (axes.length === 0) {
    return {
      ok: false,
      message: `${b.id} lies inside ${a.id}: ${what} needs ${b.id} to enter ${a.id} through one of its faces`,
    };
  }
  if (axes.length > 1) {
    return {
      ok: false,
      message: `${b.id} enters ${a.id} across an edge or a corner: ${what} needs ${b.id} to enter one face of ${a.id} and lie within it otherwise`,
    };
  }
  const axis = axes[0]!;
  if (beyond[axis]!.low && beyond[axis]!.high) {
    return {
      ok: false,
      message: `${b.id} passes right through ${a.id}: ${what} needs ${b.id} to end inside ${a.id} or flush with its far face`,
    };
  }
  const depth = extent[axis]!;
  return {
    ok: true,
    entry: {
      axis,
      side: beyond[axis]!.high ? 1 : -1,
      depth,
      through: depth >= a.size[axis] - LINEAR_TOL,
    },
  };
}

/** The interval `[from, to]` of A along an axis from the entry face to a depth (clamped to A). */
export function fromFace(p: Pair, e: Entry, depth: number): [number, number] {
  const size = p.a.size[e.axis];
  const d = Math.min(depth, size);
  return e.side === 1 ? [size - d, size] : [0, d];
}

/** B's end, edge or face touching A: the plane and the rectangle of contact. */
export interface Contact {
  /** The A axis normal to the contact plane. */
  axis: AxisIndex;
  /** A lies on the low (-1) or high (1) side of the contact plane, along the axis. */
  aSide: 1 | -1;
  /** The plane's position along the axis, in A. */
  at: number;
}

/**
 * The contact of two boards that touch without overlapping (a dowel joint, a pocket screw): a
 * plane where B's end, edge or face lies against one of A's faces, with some area.
 */
export function contactOf(
  p: Pair,
  what: string,
): { ok: true; contact: Contact } | { ok: false; message: string } {
  const { a, b } = p;
  const extent = AXES.map((i) => p.hi[i] - p.lo[i]);
  const flat = AXES.filter((i) => Math.abs(extent[i]!) <= LINEAR_TOL);
  if (extent.every((d) => d > LINEAR_TOL)) {
    const overlap = extent.reduce((x, y) => x * y, 1);
    return {
      ok: false,
      message: `${b.id} overlaps ${a.id} (by ${Math.round(overlap)} mm³): ${what} joins boards that touch; draw ${b.id} up to ${a.id}'s face, or use a dado or a mortise and tenon`,
    };
  }
  if (flat.length !== 1 || extent.some((d) => d < -LINEAR_TOL)) {
    return {
      ok: false,
      message: `${b.id} does not lie against a face of ${a.id}: ${what} needs ${b.id}'s end, edge or face against ${a.id}`,
    };
  }
  const axis = flat[0]!;
  // A is on the side of the plane away from B.
  const at = (p.lo[axis] + p.hi[axis]) / 2;
  const bCentre = (p.bLo[axis] + p.bHi[axis]) / 2;
  return { ok: true, contact: { axis, aSide: bCentre > at ? -1 : 1, at } };
}

/**
 * Positions of a row of holes along `[lo, hi]`, `edge` in from each end: `count` of them evenly
 * from the first to the last (one: in the middle); or as many as fit at `spacing`, centred; or,
 * with neither, evenly from end to end at most `defaultSpacing` apart and at least `min` of them.
 */
export function rowOf(
  lo: number,
  hi: number,
  edge: number,
  options: { count?: number; spacing?: number; defaultSpacing: number; min: number },
): { ok: true; at: number[] } | { ok: false; message: string } {
  const span = hi - lo - 2 * edge;
  if (span < -LINEAR_TOL) {
    return {
      ok: false,
      message: `the row is ${mm(hi - lo)} long, less than twice the edge distance (${mm(edge)})`,
    };
  }
  let n: number;
  let pitch: number;
  if (options.count !== undefined) {
    n = options.count;
    pitch = n > 1 ? span / (n - 1) : 0;
  } else if (options.spacing !== undefined) {
    n = Math.floor(span / options.spacing + 1e-9) + 1;
    pitch = options.spacing;
  } else if (span > LINEAR_TOL) {
    n = Math.max(options.min, Math.ceil(span / options.defaultSpacing - 1e-9) + 1);
    pitch = span / (n - 1);
  } else {
    n = 1;
    pitch = 0;
  }
  if (n > 1 && !(span > LINEAR_TOL)) {
    return {
      ok: false,
      message: `there is no room for ${n} in a row ${mm(hi - lo)} long with ${mm(edge)} at each end`,
    };
  }
  const first = n === 1 ? (lo + hi) / 2 : lo + edge + (span - (n - 1) * pitch) / 2;
  return { ok: true, at: Array.from({ length: n }, (_, i) => first + i * pitch) };
}
