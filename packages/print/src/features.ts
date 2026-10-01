// Small holes, pins and horizontal holes from the B-rep's topology (plan T3.1c, ADR 0012
// decision 5): exact radii, axes and sides from `FaceInfo` (`radius`, `axis`, `axisOrigin`,
// `hole`), never from the mesh.
//
// Grouping. A slot or cross hole that cuts a bore splits its cylinder into several faces, so
// cylindrical faces that share an axis and a radius and face the same way (all holes, or all
// pins) are one hole or pin. Axes are compared as lines: two directions match when the angle
// between the lines, ignoring sign, is at most AXIS_ANGLE_TOLERANCE (computed as
// atan2(|a x b|, |a . b|), accurate near zero), and two axes coincide when one face's
// `axisOrigin` lies within AXIS_DISTANCE_TOLERANCE of the other's axis line. Radii match within
// RADIUS_TOLERANCE. Grouping looks only at the axis, the radius and the side, so two separate
// bores in line with the same radius (two holes on either side of a gap) are one hole: the
// grouping cannot tell them apart without adjacency, and every check gives both the same answer.
//
// Threads. A face whose name contains the `:thread:` segment of T3.2e's naming rule
// (`<id>:thread:<part>`, also under a pattern or mirror prefix) is never a hole or pin itself,
// and a group whose axis coincides with the axis of a cylindrical `:thread:` face is a threaded
// hole (or threaded shaft) and is left out of the checks. T3.2e's goldens show that a modelled
// thread always has cylindrical faces on its axis (the root of every turn, and the crest when a
// trim made one), so this axis rule is the one in use. Names are not in `Topology`: they come
// from the mesh's `faceNames` slots and the reply's name table.
//
// Partial cylinders. A fillet round, a rounded corner or the end of a slot is a cylinder too,
// but not a hole or a pin: a concave fillet in an inside corner even reads as a hole (its normal
// points toward its axis). When the topology has its edges and vertices, a group counts only
// when its faces go more than half way round the axis: a face with a seam edge goes all the way
// round, and otherwise the angles about the axis of the points on the group's boundary (edge
// midpoints and vertices) leave no gap of half a turn or more. A hole split by a slot keeps
// enough of its circle; a fillet (a quarter) and a slot end (a half) do not. Such groups are
// listed as `partial` and not checked. A topology of faces only (no edges) cannot tell, and
// every group counts.
//
// Checks, on hole groups only:
// - `smallHole`: diameter below the minimum hole (default two nozzle diameters); a diameter
//   within DIAMETER_TOLERANCE of the minimum is at it and not flagged;
// - `teardrop`: a horizontal hole (axis within HORIZONTAL_TOLERANCE of the bed plane, after the
//   item's orientation) whose diameter is above the teardrop size (default 3 mm) by more than
//   DIAMETER_TOLERANCE: its top needs a teardrop or support. Its top is an overhang anyway,
//   which the overhang check shows; this flag says what to do about it.

import type { EdgeInfo, FaceInfo, Topology } from '@manufakture/kernel';
import { cross, dot, length, rotateDirection, type Placement, type Vec3 } from './geometry';
import { printThresholds, type PrintThresholds } from './thresholds';

/** Two axis directions match when the lines are at most this far apart in angle (radians). */
export const AXIS_ANGLE_TOLERANCE = 1e-9;
/** Two axes coincide when one's origin is at most this far from the other's line (mm). */
export const AXIS_DISTANCE_TOLERANCE = 1e-6;
/** Radii within this many mm are equal. */
export const RADIUS_TOLERANCE = 1e-6;
/** Diameters within this many mm of a threshold count as at it (mm). */
export const DIAMETER_TOLERANCE = 1e-6;
/** A hole is horizontal when its axis is within this angle of the bed plane (1 degree). */
export const HORIZONTAL_TOLERANCE = Math.PI / 180;
/** The name segment of a thread face (T3.2e). */
export const THREAD_SEGMENT = ':thread:';

/** Face names next to a topology: the mesh's per-face slots and the reply's name table. */
export interface FaceNameSource {
  /** Per face (slot i for face i + 1): an index into `names`, or `UNNAMED` (0xffffffff). */
  faceNames: ArrayLike<number>;
  names: readonly string[];
}

/** One hole or pin: cylindrical faces on one axis, of one radius, facing one way. */
export interface CylinderGroup {
  side: 'hole' | 'pin';
  /** 1-based face indices, ascending. */
  faces: number[];
  radius: number;
  diameter: number;
  /** Unit axis direction of the first face, in model coordinates (its sign carries no meaning). */
  axis: Vec3;
  /** A point on the axis (the first face's `axisOrigin`), in model coordinates. */
  origin: Vec3;
  /** True when the axis is within `HORIZONTAL_TOLERANCE` of the bed plane, after the placement. */
  horizontal: boolean;
}

export type HoleIssue =
  | {
      kind: 'smallHole';
      faces: number[];
      diameter: number;
      /** The minimum hole diameter it is below. */
      minimum: number;
    }
  | {
      kind: 'teardrop';
      faces: number[];
      diameter: number;
      /** The teardrop size it is above. */
      teardrop: number;
    };

export interface HoleReport {
  /** Holes and pins, threaded ones left out; in order of their first face. */
  groups: CylinderGroup[];
  /** Groups on the axis of a cylindrical `:thread:` face: threaded holes and shafts, not checked. */
  threaded: CylinderGroup[];
  /** Groups that go half way round or less (fillet rounds, rounded corners, slot ends), not checked. */
  partial: CylinderGroup[];
  issues: HoleIssue[];
}

export interface HoleOptions {
  /** The item's orientation on the bed, for "horizontal"; default the model as it is. */
  placement?: Placement;
  /** Default: `printThresholds(0.4)`. */
  thresholds?: Pick<PrintThresholds, 'minHole' | 'teardrop'>;
  /** Face names, for the thread rule; without them no face counts as a thread face. */
  names?: FaceNameSource;
}

const UNNAMED = 0xffffffff;

/** The angle between two lines with these directions, ignoring sign: atan2(|a x b|, |a . b|). */
export function lineAngle(a: Vec3, b: Vec3): number {
  return Math.atan2(length(cross(a, b)), Math.abs(dot(a, b)));
}

/** Distance from point `p` to the line through `o` along `d` (any length but zero). */
export function pointLineDistance(p: Vec3, o: Vec3, d: Vec3): number {
  const l = length(d);
  const r: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return length(cross(r, d)) / l;
}

/** True when two axes are the same line, within the tolerances above. */
export function sameLine(o1: Vec3, d1: Vec3, o2: Vec3, d2: Vec3): boolean {
  return (
    lineAngle(d1, d2) <= AXIS_ANGLE_TOLERANCE &&
    pointLineDistance(o2, o1, d1) <= AXIS_DISTANCE_TOLERANCE
  );
}

/** The name of face `index` (1-based), or null. */
function faceName(names: FaceNameSource | undefined, index: number): string | null {
  if (!names) return null;
  const slot = names.faceNames[index - 1];
  if (slot === undefined || slot === UNNAMED) return null;
  return names.names[slot] ?? null;
}

/** True for a face named by a thread (the `:thread:` segment, under any prefix). */
export function isThreadFace(name: string | null): boolean {
  return name !== null && name.includes(THREAD_SEGMENT);
}

type Cylinder = FaceInfo & { axis: Vec3; axisOrigin: Vec3; radius: number; hole: boolean };

function isCylinder(f: FaceInfo): f is Cylinder {
  return (
    f.surface === 'cylinder' &&
    f.axis != null &&
    f.axisOrigin != null &&
    f.radius != null &&
    typeof f.hole === 'boolean'
  );
}

/** Holes and pins of a body, with the small-hole and teardrop checks. */
export function analyzeHoles(
  topology: Pick<Topology, 'faces'> & Partial<Pick<Topology, 'edges' | 'vertices'>>,
  options: HoleOptions = {},
): HoleReport {
  const { minHole, teardrop } = options.thresholds ?? printThresholds(0.4);
  const cylinders: Cylinder[] = [];
  const threadAxes: Cylinder[] = [];
  for (const f of topology.faces) {
    if (!isCylinder(f)) continue;
    if (isThreadFace(faceName(options.names, f.index))) threadAxes.push(f);
    else cylinders.push(f);
  }

  // Union-find over the cylinders: same side, same radius, same line.
  const parent = cylinders.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < cylinders.length; i++) {
    const a = cylinders[i]!;
    for (let j = i + 1; j < cylinders.length; j++) {
      const b = cylinders[j]!;
      if (a.hole !== b.hole || Math.abs(a.radius - b.radius) > RADIUS_TOLERANCE) continue;
      if (!sameLine(a.axisOrigin, a.axis, b.axisOrigin, b.axis)) continue;
      const ra = find(i),
        rb = find(j);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
  const members = new Map<number, Cylinder[]>();
  cylinders.forEach((c, i) => {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(c);
    else members.set(r, [c]);
  });

  const groups: CylinderGroup[] = [];
  const threaded: CylinderGroup[] = [];
  const partial: CylinderGroup[] = [];
  const issues: HoleIssue[] = [];
  const around = halfTurnTest(topology);
  const sinTolerance = Math.sin(HORIZONTAL_TOLERANCE);
  for (const list of members.values()) {
    const first = list[0]!;
    const faces = list.map((c) => c.index).sort((p, q) => p - q);
    const l = length(first.axis);
    const axis: Vec3 = [first.axis[0] / l, first.axis[1] / l, first.axis[2] / l];
    const placed = options.placement ? rotateDirection(options.placement, axis) : axis;
    // Angle from the bed plane: asin(|z|) of the unit placed axis; compare the sine.
    const horizontal = Math.abs(placed[2]) / length(placed) <= sinTolerance;
    const group: CylinderGroup = {
      side: first.hole ? 'hole' : 'pin',
      faces,
      radius: first.radius,
      diameter: 2 * first.radius,
      axis,
      origin: first.axisOrigin,
      horizontal,
    };
    const isThreaded = threadAxes.some((t) =>
      list.some((c) => sameLine(t.axisOrigin, t.axis, c.axisOrigin, c.axis)),
    );
    if (isThreaded) {
      threaded.push(group);
      continue;
    }
    if (around && !around(faces, axis, first.axisOrigin)) {
      partial.push(group);
      continue;
    }
    groups.push(group);
    if (group.side !== 'hole') continue;
    if (group.diameter < minHole - DIAMETER_TOLERANCE) {
      issues.push({ kind: 'smallHole', faces, diameter: group.diameter, minimum: minHole });
    }
    if (horizontal && group.diameter > teardrop + DIAMETER_TOLERANCE) {
      issues.push({ kind: 'teardrop', faces, diameter: group.diameter, teardrop });
    }
  }
  return { groups, threaded, partial, issues };
}

/**
 * A test of whether faces go more than half way round an axis, from the topology's edges and
 * vertices; null when the topology has none.
 */
function halfTurnTest(
  topology: Partial<Pick<Topology, 'edges' | 'vertices'>>,
): ((faces: readonly number[], axis: Vec3, origin: Vec3) => boolean) | null {
  const { edges, vertices } = topology;
  if (!edges || !vertices || edges.length === 0) return null;
  const byFace = new Map<number, EdgeInfo[]>();
  for (const e of edges) {
    for (const f of e.faces) {
      const list = byFace.get(f);
      if (list) list.push(e);
      else byFace.set(f, [e]);
    }
  }
  return (faces, axis, origin) => {
    const own = faces.flatMap((f) => byFace.get(f) ?? []);
    if (own.some((e) => e.seam)) return true;
    // A basis square to the axis, and the angle of each boundary point about it.
    const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = cross(axis, helper);
    const lu = length(u);
    const e1: Vec3 = [u[0] / lu, u[1] / lu, u[2] / lu];
    const e2 = cross(axis, e1);
    const angles: number[] = [];
    const add = (p: Vec3) => {
      const r: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
      const x = dot(r, e1),
        y = dot(r, e2);
      if (Math.hypot(x, y) > 0) angles.push(Math.atan2(y, x));
    };
    for (const e of own) {
      add(e.midpoint);
      for (const v of e.vertices) {
        const vertex = vertices[v - 1];
        if (vertex) add(vertex.point);
      }
    }
    if (angles.length < 2) return false;
    angles.sort((p, q) => p - q);
    let gap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
    for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i]! - angles[i - 1]!);
    return gap < Math.PI - 1e-9;
  };
}
