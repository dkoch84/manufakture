// Threads: the standard sizes (ISO metric coarse, UNC) and helical thread geometry.
//
// Tables. Plain data in millimetres (inch sizes converted with 25.4 mm/in exactly). Every
// diameter is computed from the basic profile of ISO 68-1 (for UN threads ASME B1.1 uses the same
// 60 degree profile), so the tables hold only what the standards choose: the nominal (basic
// major) diameter, the pitch and the tap drill.
//
// - ISO metric coarse, M2 to M20: ISO 261:1998 (the sizes and coarse pitches: first choice, plus
//   the second-choice M3.5, M14 and M18), basic diameters per ISO 724 (D2 = D - 0.649519 P,
//   D1 = D - 1.082532 P, from ISO 68-1's H = sqrt(3)/2 P). The computed D1 and D2 were checked
//   against the ISO 724 tables reproduced at
//   https://www.engineersedge.com/hardware/metric_threads_iso_724_13176.htm and
//   https://mechahandbook.com/en/tools/metric-thread-chart/ (secondary sources, not the standard
//   text; the first prints M18's D1 as 15.394, a typo for 15.294, which the second and the
//   formula give). Tap drills are ISO 2306's for 6H nuts (D - P, rounded to a stock drill: 6.8
//   for M8, 10.2 for M12), as the second chart lists them.
// - UNC, #4 to 1/2": ASME B1.1 (basic major diameter and threads per inch; the basic minor
//   diameter, D - 1.082532 P, is what B1.1 tabulates). Tap drills are the usual 75% thread
//   drills. Checked against the chart reproduced at https://threadspec.org/unc/ (#4 to #12) and
//   the table at https://en.wikipedia.org/wiki/List_of_drill_and_tap_sizes (1/4" to 1/2"),
//   secondary sources.
//
// Geometry. A modelled thread is cut from the body as a helical groove (M3 plan, decision 9): an
// external thread from a shaft, an internal thread from a hole. `Kernel.thread` builds the tools
// (`buildThread` below) and `threadSolid` names their faces; the `thread` feature
// (`applyFeature`) subtracts them from the bodies in scope. See the README, "Threads", for the
// construction and what was tried first.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'libcascade/single/init';
import { KernelError } from './errors';
import type { Kernel } from './kernel';
import { threadFace, type FaceName } from './naming';
import { Scope, eachInList, mapShapes, type Oc } from './occt';
import type { Axis, ShapeId, Topology, Vec3 } from './types';

// Tables --------------------------------------------------------------------------------------

export type ThreadSystem = 'iso-metric' | 'unc';

export interface ThreadStandardSize {
  system: ThreadSystem;
  /** `M6`, `#10-24`, `1/4-20`. */
  size: string;
  /** Basic major diameter (the nominal diameter), mm. */
  major: number;
  /** Pitch, mm. */
  pitch: number;
  /** Threads per inch (UNC), or null. */
  tpi: number | null;
  /** Basic pitch diameter, D - 0.649519 P, mm. */
  pitchDiameter: number;
  /** Basic minor diameter (of the internal thread, D1 = D - 1.082532 P), mm. */
  minor: number;
  /** Tap drill diameter, mm: the hole a cosmetic internal thread is sized to. */
  tapDrill: number;
  /** The drill's name for inch sizes (`#7`, `F`, `27/64`), or null. */
  tapDrillName: string | null;
  /** ISO 261 choice (1 or 2) for metric sizes; null for UNC. */
  choice: 1 | 2 | null;
}

const IN = 25.4;
/** H / P for the 60 degree basic profile (ISO 68-1). */
const H_PER_P = Math.sqrt(3) / 2;

/** D - D2 and D - D1 per unit pitch: 2 x 3/8 H and 2 x 5/8 H. */
const PITCH_DEPTH = (2 * 3 * H_PER_P) / 8;
const MINOR_DEPTH = (2 * 5 * H_PER_P) / 8;

function metric(size: number, pitch: number, drill: number, choice: 1 | 2): ThreadStandardSize {
  return {
    system: 'iso-metric',
    size: `M${size}`,
    major: size,
    pitch,
    tpi: null,
    pitchDiameter: size - PITCH_DEPTH * pitch,
    minor: size - MINOR_DEPTH * pitch,
    tapDrill: drill,
    tapDrillName: null,
    choice,
  };
}

function unc(
  size: string,
  major: number,
  tpi: number,
  drill: [string, number],
): ThreadStandardSize {
  const pitch = IN / tpi;
  return {
    system: 'unc',
    size: `${size}-${tpi}`,
    major: major * IN,
    pitch,
    tpi,
    pitchDiameter: major * IN - PITCH_DEPTH * pitch,
    minor: major * IN - MINOR_DEPTH * pitch,
    tapDrill: drill[1] * IN,
    tapDrillName: drill[0],
    choice: null,
  };
}

/** The supported sizes, metric then UNC, each in increasing size. */
export const THREAD_SIZES: readonly ThreadStandardSize[] = [
  metric(2, 0.4, 1.6, 1),
  metric(2.5, 0.45, 2.05, 1),
  metric(3, 0.5, 2.5, 1),
  metric(3.5, 0.6, 2.9, 2),
  metric(4, 0.7, 3.3, 1),
  metric(5, 0.8, 4.2, 1),
  metric(6, 1, 5, 1),
  metric(8, 1.25, 6.8, 1),
  metric(10, 1.5, 8.5, 1),
  metric(12, 1.75, 10.2, 1),
  metric(14, 2, 12, 2),
  metric(16, 2, 14, 1),
  metric(18, 2.5, 15.5, 2),
  metric(20, 2.5, 17.5, 1),
  unc('#4', 0.112, 40, ['#43', 0.089]),
  unc('#5', 0.125, 40, ['#38', 0.1015]),
  unc('#6', 0.138, 32, ['#36', 0.1065]),
  unc('#8', 0.164, 32, ['#29', 0.136]),
  unc('#10', 0.19, 24, ['#25', 0.1495]),
  unc('#12', 0.216, 24, ['#16', 0.177]),
  unc('1/4', 0.25, 20, ['#7', 0.201]),
  unc('5/16', 0.3125, 18, ['F', 0.257]),
  unc('3/8', 0.375, 16, ['5/16', 0.3125]),
  unc('7/16', 0.4375, 14, ['U', 0.368]),
  unc('1/2', 0.5, 13, ['27/64', 0.4219]),
];

/**
 * A standard size by system and name, or undefined. UNC sizes are found with or without their
 * threads per inch (`1/4` and `1/4-20` are the same size).
 */
export function threadSize(system: ThreadSystem, size: string): ThreadStandardSize | undefined {
  return THREAD_SIZES.find(
    (s) =>
      s.system === system && (s.size === size || (s.tpi !== null && s.size === `${size}-${s.tpi}`)),
  );
}

// Geometry ------------------------------------------------------------------------------------

export type ThreadSide = 'external' | 'internal';
export type ThreadHand = 'right' | 'left';

/**
 * How the thread meets an end of its length. `open`: the groove runs out through the end (the
 * cylinder must end there, at a free face of the body, since the tools reach one pitch beyond
 * it). `chamfer`: open, plus a 45 degree chamfer from the root diameter, so the first turn
 * starts without a feather edge and prints cleanly. `closed`: the groove stops within the
 * length with a flat end face, and the cylinder may go on.
 */
export type ThreadEnd = 'open' | 'chamfer' | 'closed';

/**
 * A thread, as plain geometry: what the `thread` feature and `Kernel.thread` take. Lengths in
 * millimetres, angles in radians.
 */
export interface ThreadGeometry {
  /** `external` on a shaft (material inside the cylinder), `internal` in a hole. */
  side: ThreadSide;
  /**
   * `origin`: where the thread starts, on the axis (at the start end of the cylinder);
   * `direction`: along the thread's length.
   */
  axis: Axis;
  /** The radius of the cylinder the thread is cut into. */
  radius: number;
  /** Basic major diameter of the standard (`ThreadStandardSize.major`). */
  major: number;
  pitch: number;
  length: number;
  hand?: ThreadHand;
  /**
   * Radial printing clearance (default 0): the whole profile moves this far away from the
   * mating part (an external thread inward, an internal one outward). Two mating threads with
   * clearance c each have a gap of c on the flanks in the axial section (2 c sin 30 degrees),
   * slightly less in space where the flanks lean with the helix (0.1498 for c = 0.15 on M6),
   * and 2 c at crest and root.
   */
  clearance?: number;
  /** Default `chamfer`. */
  start?: ThreadEnd;
  /** Default `closed`. */
  end?: ThreadEnd;
  /**
   * Where the helix starts round the axis, radians from the reference direction (world X
   * projected square to the axis, or world Y when the axis runs along X). Default 0: an external
   * thread's groove (its root) is centred there at the start, an internal thread's crest, so
   * two threads with the same axis, start and phase mate.
   */
  phase?: number;
}

/**
 * The faces a thread's tools have. `root`, `opening`, `flank-a` (the groove's side toward the
 * start) and `flank-b` come per turn; the rest once.
 *
 * - `root`: the groove's bottom, a cylinder at the root diameter (with the clearance);
 * - `opening`: the groove's open side, a cylinder just outside the material (never in a result);
 * - `start`, `end`: the flat ends of a `closed` groove;
 * - `crest`: the cylinder a crest trim leaves, when the cylinder's radius is beyond the crest
 *   the standard and clearance allow (a shaft at the nominal diameter with clearance, a hole
 *   smaller than the minor diameter); `crest-outer`, `crest-start`, `crest-end` are the trim's
 *   other faces (outside the material, or its shoulders at a closed end);
 * - `chamfer-start`, `chamfer-end`: the 45 degree cones of chamfered ends; `chamfer-*-outer` and
 *   `chamfer-*-back` are their tools' faces outside the material.
 */
export type ThreadPart =
  | 'root'
  | 'opening'
  | 'flank-a'
  | 'flank-b'
  | 'start'
  | 'end'
  | 'crest'
  | 'crest-outer'
  | 'crest-start'
  | 'crest-end'
  | 'chamfer-start'
  | 'chamfer-start-outer'
  | 'chamfer-start-back'
  | 'chamfer-end'
  | 'chamfer-end-outer'
  | 'chamfer-end-back';

export interface ThreadFacePart {
  part: ThreadPart;
  /**
   * The turn a per-turn face belongs to, counted from the start: turn n spans the groove's
   * centre line from (n - 1) to n pitches along the axis (0 is the run-in before an open start),
   * so a length change never renumbers the turns before the end. Null for the other parts.
   */
  turn: number | null;
}

/** `Kernel.thread`'s result: the tool solids to subtract, each with the part of every face. */
export interface ThreadTools {
  tools: { shape: ShapeId; faces: ThreadFacePart[] }[];
}

/** The basic profile of a thread with its clearance, in radii from the axis. */
export interface ThreadProfile {
  /** Root radius: the groove's bottom. */
  root: number;
  /** Axial width of the groove at the root. */
  rootWidth: number;
  /** The radius the thread leaves the crest at: the cylinder's, or the trim's. */
  crest: number;
  /** Whether a crest trim is needed (the cylinder is beyond the crest the standard allows). */
  trim: boolean;
  /** Radius of the groove's open side, just outside the material. */
  opening: number;
  /** Axial width of the groove there. */
  openingWidth: number;
  /** How far the trim and chamfer tools reach, just outside the cylinder. */
  far: number;
}

/** The range of cylinder radii a thread can be cut into, mm. */
export interface ThreadLimits {
  min: number;
  max: number;
  /**
   * The crest radius the standard allows with this clearance: an external thread on a larger
   * shaft, or an internal one in a smaller hole, trims the crest to it.
   */
  crest: number;
}

const TAN30 = Math.tan(Math.PI / 6);
/** How far the groove and tools reach past the material, per unit pitch. */
const MARGIN = 0.05;
/** How far past the allowed crest a cylinder may be before a crest trim cuts it, mm. */
const TRIM_TOLERANCE = 0.01;
/** Sewing tolerance for the groove's faces, mm (their shared edges are built from the same curves). */
const SEW_TOLERANCE = 1e-5;
/** The shallowest thread allowed, as a fraction of the basic depth (5/8 H). */
const MIN_DEPTH = 0.25;

function rootOf(side: ThreadSide, major: number, pitch: number, clearance: number) {
  return side === 'external'
    ? { root: (major - MINOR_DEPTH * pitch) / 2 - clearance, rootWidth: pitch / 4 }
    : { root: major / 2 + clearance, rootWidth: pitch / 8 };
}

/**
 * The cylinder radii a thread can be cut into. External: from a quarter of the basic depth
 * above the root up to one pitch over the major radius (beyond the crest radius, the crest is
 * trimmed). Internal: from half a pitch under the minor radius (trimmed up to the crest radius)
 * to a quarter of the basic depth below the root.
 */
export function threadLimits(
  side: ThreadSide,
  major: number,
  pitch: number,
  clearance = 0,
): ThreadLimits {
  const { root } = rootOf(side, major, pitch, clearance);
  const depth = MINOR_DEPTH * pitch * 0.5;
  if (side === 'external') {
    return { min: root + MIN_DEPTH * depth, max: major / 2 + pitch, crest: root + depth };
  }
  return {
    min: Math.max(root - depth - pitch / 2, 2 * MARGIN * pitch),
    max: root - MIN_DEPTH * depth,
    crest: root - depth,
  };
}

/** Why a thread's geometry cannot be built, or null. */
export function threadProblem(g: ThreadGeometry): string | null {
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);
  if (g.side !== 'external' && g.side !== 'internal') return 'side must be external or internal';
  if (
    typeof g.axis !== 'object' ||
    g.axis === null ||
    !vec(g.axis.origin) ||
    !vec(g.axis.direction)
  )
    return 'axis must be { origin, direction } with three numbers each';
  const [dx, dy, dz] = g.axis.direction;
  if (!(Math.hypot(dx, dy, dz) > 1e-12)) return 'axis.direction is a zero vector';
  for (const key of ['radius', 'major', 'pitch', 'length'] as const) {
    if (!finite(g[key]) || !(g[key] > 0)) return `${key} must be a positive number`;
  }
  if (g.clearance !== undefined && (!finite(g.clearance) || g.clearance < 0))
    return 'clearance must be a number of at least 0';
  if (g.phase !== undefined && !finite(g.phase)) return 'phase must be a finite number';
  if (g.hand !== undefined && g.hand !== 'right' && g.hand !== 'left')
    return 'hand must be right or left';
  for (const key of ['start', 'end'] as const) {
    const e = g[key];
    if (e !== undefined && e !== 'open' && e !== 'chamfer' && e !== 'closed')
      return `${key} must be open, chamfer or closed`;
  }
  if (g.pitch > g.major / 2) return 'the pitch is too coarse for the diameter';
  const limits = threadLimits(g.side, g.major, g.pitch, g.clearance ?? 0);
  if (!(g.radius >= limits.min - 1e-9 && g.radius <= limits.max + 1e-9)) {
    return (
      `a ${g.side} thread of ${fmt(g.major)} x ${fmt(g.pitch)} mm needs a cylinder ` +
      `${fmt(2 * limits.min)} to ${fmt(2 * limits.max)} mm across; this one is ${fmt(2 * g.radius)}`
    );
  }
  const { lo, hi } = centreLine(g, threadProfile(g));
  if (hi - lo < 0.25) return 'the thread is too short for its pitch: it needs a quarter turn';
  return null;
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** The profile of a thread: root, crest and the groove's extent. Assumes valid input. */
export function threadProfile(g: ThreadGeometry): ThreadProfile {
  const c = g.clearance ?? 0;
  const { root, rootWidth } = rootOf(g.side, g.major, g.pitch, c);
  const limits = threadLimits(g.side, g.major, g.pitch, c);
  const out = g.side === 'external' ? 1 : -1;
  // Within TRIM_TOLERANCE of the allowed crest, the cylinder is left as it is (a hole drilled
  // at the minor diameter as ISO 724 rounds it, 4.917 for M6, is 0.0003 mm under the exact one):
  // a trim that thin would only make a sliver.
  const beyond = out > 0 ? g.radius - limits.crest : limits.crest - g.radius;
  const crest = beyond > TRIM_TOLERANCE ? limits.crest : g.radius;
  const margin = MARGIN * g.pitch;
  const opening = crest + out * margin;
  return {
    root,
    rootWidth,
    crest,
    trim: Math.abs(crest - g.radius) > TRIM_TOLERANCE,
    opening,
    openingWidth: rootWidth + 2 * Math.abs(opening - root) * TAN30,
    far: g.radius + out * margin,
  };
}

/**
 * Where the groove's centre line starts and ends, in turns (pitches along the axis from the
 * start): one turn before an open start and one past an open end, so the groove runs out of the
 * body; within the length at a closed end, so the whole groove stays inside it.
 */
function centreLine(g: ThreadGeometry, p: ThreadProfile): { lo: number; hi: number } {
  const half = p.openingWidth / 2 / g.pitch;
  const lo = (g.start ?? 'chamfer') === 'closed' ? half : -1;
  const hi = (g.end ?? 'closed') === 'closed' ? g.length / g.pitch - half : g.length / g.pitch + 1;
  return { lo, hi };
}

/**
 * The pieces the groove is built from: one per turn of the centre line, cut at whole turns, each
 * with its turn number. A last piece shorter than a tenth of a turn is merged: the last two
 * pieces then share their span equally (and keep their numbers).
 */
export function threadTurns(lo: number, hi: number): { from: number; to: number; turn: number }[] {
  const bounds = [lo];
  for (let n = Math.floor(lo) + 1; n < hi - 1e-9; n++) if (n > lo + 1e-9) bounds.push(n);
  bounds.push(hi);
  const turns = bounds.slice(1).map((b) => Math.ceil(b - 1e-9) || 0);
  const last = bounds.length - 1;
  if (last >= 2 && bounds[last]! - bounds[last - 1]! < 0.1) {
    bounds[last - 1] = (bounds[last - 2]! + bounds[last]!) / 2;
  }
  return turns.map((turn, i) => ({ from: bounds[i]!, to: bounds[i + 1]!, turn }));
}

/** The thread's frame: unit axis, and the reference direction rotated by the phase. */
function frameOf(g: ThreadGeometry): { o: Vec3; n: Vec3; e1: Vec3; e2: Vec3 } {
  const d = g.axis.direction;
  const len = Math.hypot(d[0], d[1], d[2]);
  const n: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const project = (v: Vec3): Vec3 | null => {
    const k = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    const p: Vec3 = [v[0] - k * n[0], v[1] - k * n[1], v[2] - k * n[2]];
    const l = Math.hypot(p[0], p[1], p[2]);
    return l > 1e-6 ? [p[0] / l, p[1] / l, p[2] / l] : null;
  };
  const x = project([1, 0, 0]) ?? project([0, 1, 0])!;
  const y = cross3(n, x);
  // An internal thread's groove takes the external one's tooth: half a turn round (the same as
  // half a pitch along), so the two mate.
  const a = (g.phase ?? 0) + (g.side === 'internal' ? Math.PI : 0);
  const e1: Vec3 = [
    Math.cos(a) * x[0] + Math.sin(a) * y[0],
    Math.cos(a) * x[1] + Math.sin(a) * y[1],
    Math.cos(a) * x[2] + Math.sin(a) * y[2],
  ];
  return { o: g.axis.origin, n, e1, e2: cross3(n, e1) };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

interface BuiltTool {
  /** Owned by the scope; the caller stores a copy. */
  shape: TopoDS_Shape;
  faces: ThreadFacePart[];
}

/**
 * Build the tools of a thread (for `Kernel.thread`), every OCCT object owned by `s`:
 *
 * 1. The groove: a closed helical solid of trapezoidal section, from the root to just past the
 *    crest. Built face by face, one piece per turn: per piece, a band on the root cylinder and
 *    one on the opening cylinder (each a `Geom_CylindricalSurface` of its own, whose frame is
 *    turned and lifted to the piece's start, so every band's parameters lie within one period),
 *    bounded by helices made as `Geom2d_Line`s on the surface; the two flanks are ruled faces
 *    between the root and opening helices (`BRepFill.Face`, exactly the helicoid of the
 *    straight flank swept along the helix, up to the helix approximation). Planar ends close
 *    it. The faces are sewn, made a solid and oriented.
 * 2. A crest trim, when needed: a revolved ring from the crest radius to just outside the cylinder.
 * 3. A 45 degree chamfer per chamfered end: a revolved triangle.
 */
export function buildThread(oc: Oc, s: Scope, g: ThreadGeometry): BuiltTool[] {
  const problem = threadProblem(g);
  if (problem !== null) throw new KernelError('thread', problem, { code: 'invalid-argument' });
  const p = threadProfile(g);
  const f = frameOf(g);
  const h = g.hand === 'left' ? -1 : 1;
  const P = g.pitch;
  const k = P / (2 * Math.PI);
  const at = (r: number, tau: number, dz: number): Vec3 => {
    const t = h * 2 * Math.PI * tau;
    const c = r * Math.cos(t);
    const si = r * Math.sin(t);
    const z = P * tau + dz;
    return [0, 1, 2].map(
      (i) => f.o[i]! + z * f.n[i]! + c * f.e1[i]! + si * f.e2[i]!,
    ) as unknown as Vec3;
  };
  const pnt = (v: Vec3) => s.own(new oc.gp_Pnt(v[0], v[1], v[2]));
  const dir = (v: Vec3) => s.own(new oc.gp_Dir(v[0], v[1], v[2]));
  const toolsOut: BuiltTool[] = [];

  // 1. The groove.
  const { lo, hi } = centreLine(g, p);
  const parts: { face: TopoDS_Face; part: ThreadFacePart }[] = [];
  const sew = s.own(new oc.BRepBuilderAPI_Sewing(SEW_TOLERANCE, true, true, true, false));
  for (const piece of threadTurns(lo, hi)) {
    const du = 2 * Math.PI * (piece.to - piece.from);
    const a = h * 2 * Math.PI * piece.from;
    const x: Vec3 = [0, 1, 2].map(
      (i) => Math.cos(a) * f.e1[i]! + Math.sin(a) * f.e2[i]!,
    ) as unknown as Vec3;
    const base: Vec3 = [0, 1, 2].map((i) => f.o[i]! + P * piece.from * f.n[i]!) as unknown as Vec3;
    const ax3 = s.own(new oc.gp_Ax3(pnt(base), dir(f.n), dir(x)));
    if (h < 0) ax3.YReverse();
    const slope = Math.sqrt(1 + k * k);
    const band = (
      r: number,
      w: number,
    ): { face: TopoDS_Face; lo: TopoDS_Edge; hi: TopoDS_Edge } => {
      const surf = s.own(new oc.Geom_CylindricalSurface(ax3, r));
      const edge = (u: number, v: number, du2: number, dv: number, t1: number): TopoDS_Edge => {
        const line = s.own(
          new oc.Geom2d_Line(s.own(new oc.gp_Pnt2d(u, v)), s.own(new oc.gp_Dir2d(du2, dv))),
        );
        const maker = s.own(new oc.BRepBuilderAPI_MakeEdge(line, surf, 0, t1));
        if (!maker.IsDone()) throw new Error('thread: a helix edge failed');
        const e = s.own(maker.Edge());
        if (!oc.BRepLib.BuildCurves3d(e)) throw new Error('thread: a helix approximation failed');
        return e;
      };
      const eLo = edge(0, -w / 2, 1, k, du * slope);
      const eHi = edge(0, w / 2, 1, k, du * slope);
      const eEnd = edge(du, k * du - w / 2, 0, 1, w);
      const eStart = edge(0, -w / 2, 0, 1, w);
      const wire = s.own(new oc.BRepBuilderAPI_MakeWire());
      for (const e of [eLo, eEnd, eHi, eStart]) wire.Add(e);
      if (!wire.IsDone()) throw new Error('thread: a band wire failed');
      const maker = s.own(new oc.BRepBuilderAPI_MakeFace(surf, s.own(wire.Wire()), true));
      if (!maker.IsDone()) throw new Error('thread: a band face failed');
      return { face: s.own(maker.Face()), lo: eLo, hi: eHi };
    };
    const root = band(p.root, p.rootWidth);
    const open = band(p.opening, p.openingWidth);
    const flankA = s.own(oc.BRepFill.Face(root.lo, open.lo));
    const flankB = s.own(oc.BRepFill.Face(root.hi, open.hi));
    const turn = piece.turn;
    parts.push(
      { face: root.face, part: { part: 'root', turn } },
      { face: open.face, part: { part: 'opening', turn } },
      { face: flankA, part: { part: 'flank-a', turn } },
      { face: flankB, part: { part: 'flank-b', turn } },
    );
  }
  const cap = (tau: number, part: 'start' | 'end') => {
    const poly = s.own(
      new oc.BRepBuilderAPI_MakePolygon(
        pnt(at(p.root, tau, -p.rootWidth / 2)),
        pnt(at(p.opening, tau, -p.openingWidth / 2)),
        pnt(at(p.opening, tau, p.openingWidth / 2)),
        pnt(at(p.root, tau, p.rootWidth / 2)),
        true,
      ),
    );
    const maker = s.own(new oc.BRepBuilderAPI_MakeFace(s.own(poly.Wire()), true));
    if (!maker.IsDone()) throw new Error('thread: an end face failed');
    parts.push({ face: s.own(maker.Face()), part: { part, turn: null } });
  };
  cap(lo, 'start');
  cap(hi, 'end');
  for (const { face } of parts) sew.Add(face);
  sew.Perform(s.own(new oc.Message_ProgressRange()));
  if (sew.NbFreeEdges() > 0 || sew.NbMultipleEdges() > 0) {
    throw new Error(`thread: the groove did not close (${sew.NbFreeEdges()} free edges)`);
  }
  const sewn = s.own(sew.SewedShape());
  if (sewn.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
    throw new Error('thread: the groove faces did not sew into one shell');
  }
  const solidMaker = s.own(new oc.BRepBuilderAPI_MakeSolid(s.own(oc.TopoDS.Shell(sewn))));
  if (!solidMaker.IsDone()) throw new Error('thread: the groove is not a solid');
  const solid = s.own(solidMaker.Solid());
  oc.BRepLib.OrientClosedSolid(solid);
  const faceMap = mapShapes(oc, s, solid, 'face');
  const grooveFaces: (ThreadFacePart | undefined)[] = Array.from(
    { length: faceMap.Extent() },
    () => undefined,
  );
  for (const { face, part } of parts) {
    const index = faceMap.FindIndex(s.own(sew.Modified(face)));
    if (index === 0 || grooveFaces[index - 1])
      throw new Error('thread: lost track of a groove face');
    grooveFaces[index - 1] = part;
  }
  if (grooveFaces.some((x) => x === undefined))
    throw new Error('thread: a groove face has no part');
  toolsOut.push({ shape: solid, faces: grooveFaces as ThreadFacePart[] });

  // 2 and 3. Revolved tools: a section in the plane (radius, height along the axis).
  const revolved = (section: { r: number; z: number; part: ThreadPart }[]): BuiltTool => {
    const xyz = (r: number, z: number): Vec3 =>
      [0, 1, 2].map((i) => f.o[i]! + z * f.n[i]! + r * f.e1[i]!) as unknown as Vec3;
    const edges = section.map((q, i) => {
      const next = section[(i + 1) % section.length]!;
      const maker = s.own(
        new oc.BRepBuilderAPI_MakeEdge(pnt(xyz(q.r, q.z)), pnt(xyz(next.r, next.z))),
      );
      if (!maker.IsDone()) throw new Error('thread: a section edge failed');
      return s.own(maker.Edge());
    });
    const wire = s.own(new oc.BRepBuilderAPI_MakeWire());
    for (const e of edges) wire.Add(e);
    if (!wire.IsDone()) throw new Error('thread: a section wire failed');
    const face = s.own(new oc.BRepBuilderAPI_MakeFace(s.own(wire.Wire()), true));
    if (!face.IsDone()) throw new Error('thread: a section face failed');
    const section2d = s.own(face.Face());
    const ax1 = s.own(new oc.gp_Ax1(pnt(f.o), dir(f.n)));
    const maker = s.own(new oc.BRepPrimAPI_MakeRevol(section2d, ax1, true));
    maker.Build();
    if (!maker.IsDone()) throw new Error('thread: a revolved tool failed');
    const shape = s.own(maker.Shape());
    const map = mapShapes(oc, s, shape, 'face');
    const faces: (ThreadFacePart | undefined)[] = Array.from(
      { length: map.Extent() },
      () => undefined,
    );
    // The wire may hold copies of the edges made above, so each of the face's edges is matched
    // to its section edge by its midpoint.
    const mids = section.map((q, i) => {
      const next = section[(i + 1) % section.length]!;
      return xyz((q.r + next.r) / 2, (q.z + next.z) / 2);
    });
    const edgeMap = mapShapes(oc, s, section2d, 'edge');
    for (let j = 1; j <= edgeMap.Extent(); j++) {
      const e = s.own(oc.TopoDS.Edge(s.own(edgeMap.FindKey(j))));
      const curve = s.own(new oc.BRepAdaptor_Curve(e));
      const m = s.own(curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2));
      const i = mids.findIndex(
        (c) => Math.hypot(c[0] - m.X(), c[1] - m.Y(), c[2] - m.Z()) < 1e-7 * (1 + g.major),
      );
      if (i < 0) throw new Error('thread: a section edge was lost');
      eachInList(oc, s, s.own(maker.Generated(e)), (item) => {
        const index = map.FindIndex(item);
        if (index > 0) faces[index - 1] = { part: section[i]!.part, turn: null };
      });
    }
    if (faces.some((x) => x === undefined)) throw new Error('thread: a revolved face has no part');
    return { shape, faces: faces as ThreadFacePart[] };
  };
  const startOpen = (g.start ?? 'chamfer') !== 'closed';
  const endOpen = (g.end ?? 'closed') !== 'closed';
  if (p.trim) {
    const z0 = startOpen ? -P : 0;
    const z1 = endOpen ? g.length + P : g.length;
    // Edge i of a section runs from point i to point i + 1 and names the face it sweeps.
    toolsOut.push(
      revolved([
        { r: p.crest, z: z0, part: 'crest-start' },
        { r: p.far, z: z0, part: 'crest-outer' },
        { r: p.far, z: z1, part: 'crest-end' },
        { r: p.crest, z: z1, part: 'crest' },
      ]),
    );
  }
  const chamfer = (z: number, inward: 1 | -1, end: 'start' | 'end') => {
    // From the root at the end plane, 45 degrees into the material, to just past the cylinder.
    const t = Math.abs(p.far - p.root);
    toolsOut.push(
      revolved([
        { r: p.root, z, part: `chamfer-${end}` },
        { r: p.far, z: z + inward * t, part: `chamfer-${end}-outer` },
        { r: p.far, z: z - inward * P, part: `chamfer-${end}-back` },
      ]),
    );
  };
  if ((g.start ?? 'chamfer') === 'chamfer') chamfer(0, 1, 'start');
  if (g.end === 'chamfer') chamfer(g.length, -1, 'end');
  return toolsOut;
}

// Names ---------------------------------------------------------------------------------------

/** A thread's tool solid with its faces named. */
export interface ThreadTool {
  shape: ShapeId;
  faces: FaceName[];
  topology: Topology;
}

/**
 * The kernel-level thread API: build the tools of thread `id` (`Kernel.thread`) and name every
 * face `<id>:thread:<part>`, with `:<turn>` for the per-turn parts (`thread#5:thread:root:3`).
 * The caller owns the shapes. Throws `KernelError` (`invalid-argument` for a bad geometry).
 */
export function threadSolid(k: Kernel, id: string, g: ThreadGeometry): ThreadTool[] {
  const { tools } = k.thread(g);
  try {
    return tools.map((t) => ({
      shape: t.shape,
      topology: k.topology(t.shape),
      faces: t.faces.map((part) => threadFace(id, part.part, part.turn)),
    }));
  } catch (error) {
    for (const t of tools) k.release(t.shape);
    throw error;
  }
}
