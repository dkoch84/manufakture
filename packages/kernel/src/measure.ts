// Exact measurements from the B-rep, never from the mesh (T1.13): per face,
// edge or vertex its size and analytic geometry, between two of them the
// minimum distance (BRepExtrema_DistShapeShape) with its witness points and
// the angle, and for the whole body its mass properties (BRepGProp) and a
// tight bounding box. Runs in the kernel worker; everything it returns is
// plain data in millimetres and radians.
//
// Targets are named like the viewport names them: by the naming layer's name
// on a body made by feature operations, or by 1-based index (a body with no
// names, and vertices, which have no mesh name slots). A target may be on
// another body than the measured one (`MeasureBody`), in the same coordinates
// (the bodies of one part): the distance and angle between two targets work
// the same whichever bodies they are on.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex } from 'libcascade/single/init';
import { KernelError } from './errors';
import type { Matrix3 } from './inertia';
import type { NamedShape } from './kernel';
import { answersTo, edgeAliases, vertexName } from './naming';
import { cross, dot, mapShapes, norm, toVec3, type IndexedMap, type Oc, type Scope } from './occt';
import type { BoundingBox, ShapeId, SubShapeKind, Vec3 } from './types';

/** A face, edge or vertex of the measured body: by name, or by 1-based index. */
export type MeasureTarget =
  { kind: SubShapeKind; name: string } | { kind: SubShapeKind; index: number };

/** A body a target is on, other than the measured shape: its shape and names (null for none). */
export interface MeasureBody {
  shape: TopoDS_Shape;
  named: NamedShape | null;
}

/** A target, on the measured shape or, with `body`, on another body in the same coordinates. */
export type BodyMeasureTarget = MeasureTarget & { body?: MeasureBody };

/** `Kernel.measure`'s target: on the measured shape or, with `shape`, on that live body. */
export type ShapeMeasureTarget = MeasureTarget & { shape?: ShapeId };

export interface MeasureOptions {
  /** Also measure the whole body: volume, area, centre of mass, volume inertia, bounding box. */
  body?: boolean;
}

/** A line or axis in space; `direction` is unit length. */
export interface MeasureAxis {
  origin: Vec3;
  direction: Vec3;
}

export interface MeasuredVertex {
  kind: 'vertex';
  index: number;
  /** The target's name, or null when it was given by index. */
  name: string | null;
  point: Vec3;
}

export interface MeasuredEdge {
  kind: 'edge';
  index: number;
  name: string | null;
  /** Curve type in lower case: line, circle, ellipse, bsplinecurve, ..., or degenerated. */
  curve: string;
  length: number;
  /** End points in the edge's direction; null for a degenerated edge. A closed edge starts where it ends. */
  start: Vec3 | null;
  end: Vec3 | null;
  midpoint: Vec3;
  /** Lines: unit direction from `start` to `end`. */
  direction: Vec3 | null;
  /** Circles and arcs: centre, radius, the axis through the centre, and the angle the arc spans. */
  circle: { center: Vec3; radius: number; axis: Vec3; sweep: number } | null;
}

export interface MeasuredFace {
  kind: 'face';
  index: number;
  name: string | null;
  /** Surface type in lower case: plane, cylinder, cone, sphere, torus, bsplinesurface, ... */
  surface: string;
  area: number;
  centroid: Vec3;
  /** Planes: unit outward normal. */
  normal: Vec3 | null;
  /** Cylinders, cones and tori: the axis; spheres: the centre (as `origin`). */
  axis: MeasureAxis | null;
  /** Cylinders and spheres: the radius; tori: the major radius. */
  radius: number | null;
}

export type MeasuredItem = MeasuredVertex | MeasuredEdge | MeasuredFace;

/** One target: what was measured, or why it could not be found. */
export type MeasureItemReport =
  | ({ ok: true } & MeasuredItem)
  | { ok: false; kind: SubShapeKind; status: 'not-found' | 'ambiguous'; message: string };

export interface DistanceMeasure {
  /** The minimum distance, 0 when the two touch. */
  value: number;
  /** Witness points: where the minimum is reached on the first and the second target. */
  from: Vec3;
  to: Vec3;
  /** How many point pairs reach the minimum (parallel faces give several; one is reported). */
  solutions: number;
  /**
   * Two parallel planar faces only: the distance between their planes, measured along the
   * normal. It equals `value` when the faces overlap seen along the normal, and is less when
   * they are offset sideways (`value` then also counts the sideways offset). Null otherwise.
   */
  planes: number | null;
}

export interface AngleMeasure {
  /** Between the two lines, the two planes, or a line and a plane: 0 to pi/2. */
  value: number;
  between: 'lines' | 'planes' | 'line-plane';
  /** Two planar faces only: the angle between their outward normals, 0 to pi. */
  normals: number | null;
}

export interface BodyMeasure {
  /** mm3. */
  volume: number;
  /** mm2. */
  area: number;
  /** Of the volume, at uniform density. Null for a body without volume. */
  centerOfMass: Vec3 | null;
  /**
   * mm⁵: the inertia tensor of the volume at unit density, about `centerOfMass`, along X, Y and Z
   * (moments on the diagonal, minus the products of inertia off it). Times a density it is a mass
   * moment of inertia (`bodyMassProperties` in ./inertia). Null for a body without volume.
   */
  volumeInertia: Matrix3 | null;
  /** Tight (not enlarged by tolerances); null for an empty shape. */
  boundingBox: BoundingBox | null;
}

export interface MeasureResult {
  items: MeasureItemReport[];
  /** Exactly two targets, both found: their minimum distance. */
  distance: DistanceMeasure | null;
  /** Exactly two targets with a direction (line edges, planar faces, cylinder or cone axes). */
  angle: AngleMeasure | null;
  /** With `body: true`. */
  body: BodyMeasure | null;
}

/** Parallel within this (radians) counts as parallel. */
const ANGLE_TOL = 1e-9;

/**
 * The one number a distance between two targets stands for: between two parallel planar faces
 * the distance between their planes (`DistanceMeasure.planes`), otherwise the minimum distance
 * (0 when they touch). Null unless both targets were found. What a `distance(...)` of two faces
 * in an expression reads.
 */
export function measuredDistance(result: MeasureResult): number | null {
  const d = result.distance;
  return d === null ? null : (d.planes ?? d.value);
}

/**
 * Measure `targets` on `shape` (whose names, if any, are `named`), each on its own `body` when
 * it gives one. Everything is owned by `s`.
 */
export function measureShape(
  oc: Oc,
  s: Scope,
  shape: TopoDS_Shape,
  named: NamedShape | null,
  targets: readonly BodyMeasureTarget[],
  options: MeasureOptions = {},
): MeasureResult {
  type Maps = Record<SubShapeKind, IndexedMap>;
  const mapsOf = new Map<TopoDS_Shape, Maps>();
  const maps = (on: TopoDS_Shape): Maps => {
    let m = mapsOf.get(on);
    if (m === undefined) {
      m = {
        face: mapShapes(oc, s, on, 'face'),
        edge: mapShapes(oc, s, on, 'edge'),
        vertex: mapShapes(oc, s, on, 'vertex'),
      };
      mapsOf.set(on, m);
    }
    return m;
  };
  const found: { item: MeasuredItem; shape: TopoDS_Shape }[] = [];
  const items = targets.map((t): MeasureItemReport => {
    const on = t.body ?? { shape, named };
    const target = plain(t);
    const map = maps(on.shape)[target.kind];
    const located = locate(map.Extent(), on.named, target);
    if (!located.ok) return { ok: false, kind: target.kind, ...located.failure };
    const sub = s.own(map.FindKey(located.index));
    const item = measureItem(oc, s, target.kind, sub, located.index, located.name);
    found.push({ item, shape: sub });
    return { ok: true, ...item };
  });
  const pair = targets.length === 2 && found.length === 2 ? found : null;
  const between = pair ? angle(pair[0]!.item, pair[1]!.item) : null;
  return {
    items,
    distance: pair
      ? {
          ...distance(oc, s, pair[0]!.shape, pair[1]!.shape),
          planes: planeGap(pair[0]!.item, pair[1]!.item, between),
        }
      : null,
    angle: between,
    body: options.body ? bodyMeasure(oc, s, shape) : null,
  };
}

/** The target without its body: what `locate` reads. */
function plain(t: BodyMeasureTarget): MeasureTarget {
  return 'name' in t ? { kind: t.kind, name: t.name } : { kind: t.kind, index: t.index };
}

/** Two parallel planar faces: the distance between their planes, along the first's normal. */
function planeGap(a: MeasuredItem, b: MeasuredItem, between: AngleMeasure | null): number | null {
  if (a.kind !== 'face' || b.kind !== 'face' || a.normal === null || b.normal === null) return null;
  if (between === null || between.between !== 'planes' || between.value !== 0) return null;
  const d: Vec3 = [
    b.centroid[0] - a.centroid[0],
    b.centroid[1] - a.centroid[1],
    b.centroid[2] - a.centroid[2],
  ];
  return Math.abs(dot(a.normal, d));
}

export type Located =
  | { ok: true; index: number; name: string | null }
  | { ok: false; failure: { status: 'not-found' | 'ambiguous'; message: string } };

/** Find a target among `count` sub-shapes of its kind: by index, or by name on a named body. */
export function locate(count: number, named: NamedShape | null, target: MeasureTarget): Located {
  if ('index' in target) {
    if (!Number.isInteger(target.index) || target.index < 1 || target.index > count) {
      return notFound(`the body has no ${target.kind} ${target.index}`);
    }
    return { ok: true, index: target.index, name: null };
  }
  if (named === null) return notFound(`the body has no names, so ${target.name} is not on it`);
  const candidates: number[] = [];
  // A name, or a former name of a face renamed since (`FaceName.aliases`), and the edge and
  // vertex names built from former face names.
  const faces = named.names.faces;
  const former = faces.map((f) => ({ ...f, name: f.aliases?.[0] ?? f.name }));
  const renamed = faces.some((f) => f.aliases !== undefined);
  if (target.kind === 'face') {
    faces.forEach((f, i) => answersTo(f, target.name) && candidates.push(i + 1));
  } else if (target.kind === 'edge') {
    named.names.edges.forEach(
      (e, i) =>
        (e.name === target.name || (renamed && edgeAliases(faces, e).includes(target.name))) &&
        candidates.push(i + 1),
    );
  } else {
    for (let v = 1; v <= named.topology.vertices.length; v++) {
      if (
        vertexName(faces, named.topology, v) === target.name ||
        (renamed && vertexName(former, named.topology, v) === target.name)
      )
        candidates.push(v);
    }
  }
  if (candidates.length === 0) return notFound(`no ${target.kind} is named ${target.name}`);
  if (candidates.length > 1) {
    return {
      ok: false,
      failure: {
        status: 'ambiguous',
        message: `${candidates.length} ${target.kind}s are named ${target.name}`,
      },
    };
  }
  return { ok: true, index: candidates[0]!, name: target.name };
}

function notFound(message: string): Located {
  return { ok: false, failure: { status: 'not-found', message } };
}

function unit(v: Vec3): Vec3 {
  const n = norm(v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : v;
}

function measureItem(
  oc: Oc,
  s: Scope,
  kind: SubShapeKind,
  sub: TopoDS_Shape,
  index: number,
  name: string | null,
): MeasuredItem {
  if (kind === 'vertex') {
    const vertex: TopoDS_Vertex = s.own(oc.TopoDS.Vertex(sub));
    return { kind, index, name, point: toVec3(s.own(oc.BRep_Tool.Pnt(vertex))) };
  }
  if (kind === 'edge') return measureEdge(oc, s, s.own(oc.TopoDS.Edge(sub)), index, name);
  return measureFace(oc, s, s.own(oc.TopoDS.Face(sub)), index, name);
}

function measureEdge(
  oc: Oc,
  s: Scope,
  edge: TopoDS_Edge,
  index: number,
  name: string | null,
): MeasuredEdge {
  const first: TopoDS_Vertex = s.own(oc.TopExp.FirstVertex(edge, true));
  const last: TopoDS_Vertex = s.own(oc.TopExp.LastVertex(edge, true));
  if (oc.BRep_Tool.Degenerated(edge)) {
    return {
      kind: 'edge',
      index,
      name,
      curve: 'degenerated',
      length: 0,
      start: null,
      end: null,
      midpoint: toVec3(s.own(oc.BRep_Tool.Pnt(first))),
      direction: null,
      circle: null,
    };
  }
  const curve = s.own(new oc.BRepAdaptor_Curve(edge));
  const props = s.own(new oc.GProp_GProps());
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const t0 = curve.FirstParameter();
  const t1 = curve.LastParameter();
  const start = toVec3(s.own(oc.BRep_Tool.Pnt(first)));
  const end = toVec3(s.own(oc.BRep_Tool.Pnt(last)));
  const type = curve.GetType();
  let direction: Vec3 | null = null;
  let circle: MeasuredEdge['circle'] = null;
  if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
    direction = unit([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
  } else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const c = s.own(curve.Circle());
    const ax = s.own(c.Axis());
    circle = {
      center: toVec3(s.own(c.Location())),
      radius: c.Radius(),
      axis: unit(toVec3(s.own(ax.Direction()))),
      sweep: Math.abs(t1 - t0),
    };
  }
  return {
    kind: 'edge',
    index,
    name,
    curve: type.replace('GeomAbs_', '').toLowerCase(),
    length: props.Mass(),
    start,
    end,
    midpoint: toVec3(s.own(curve.Value((t0 + t1) / 2))),
    direction,
    circle,
  };
}

function measureFace(
  oc: Oc,
  s: Scope,
  face: TopoDS_Face,
  index: number,
  name: string | null,
): MeasuredFace {
  const props = s.own(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(face, props, false, false);
  const adaptor = s.own(new oc.BRepAdaptor_Surface(face, true));
  const type = adaptor.GetType();
  const T = oc.GeomAbs_SurfaceType;
  const axisOf = (ax: { Location(): unknown; Direction(): unknown }): MeasureAxis => ({
    origin: toVec3(s.own(ax.Location() as InstanceType<Oc['gp_Pnt']>)),
    direction: unit(toVec3(s.own(ax.Direction() as InstanceType<Oc['gp_Dir']>))),
  });
  let normal: Vec3 | null = null;
  let axis: MeasureAxis | null = null;
  let radius: number | null = null;
  if (type === T.GeomAbs_Plane) {
    // As in topology.ts: the plane's axis, flipped for a left-handed frame
    // and again for a reversed face, is the outward normal.
    const plane = s.own(adaptor.Plane());
    const d = toVec3(s.own(s.own(plane.Axis()).Direction()));
    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const sign = (reversed ? -1 : 1) * (plane.Direct() ? 1 : -1);
    normal = unit([sign * d[0], sign * d[1], sign * d[2]]);
  } else if (type === T.GeomAbs_Cylinder) {
    const cyl = s.own(adaptor.Cylinder());
    axis = axisOf(s.own(cyl.Axis()));
    radius = cyl.Radius();
  } else if (type === T.GeomAbs_Cone) {
    axis = axisOf(s.own(s.own(adaptor.Cone()).Axis()));
  } else if (type === T.GeomAbs_Sphere) {
    const sphere = s.own(adaptor.Sphere());
    axis = axisOf(s.own(sphere.Position()));
    radius = sphere.Radius();
  } else if (type === T.GeomAbs_Torus) {
    const torus = s.own(adaptor.Torus());
    axis = axisOf(s.own(torus.Axis()));
    radius = torus.MajorRadius();
  }
  return {
    kind: 'face',
    index,
    name,
    surface: type.replace('GeomAbs_', '').toLowerCase(),
    area: props.Mass(),
    centroid: toVec3(s.own(props.CentreOfMass())),
    normal,
    axis,
    radius,
  };
}

function distance(
  oc: Oc,
  s: Scope,
  a: TopoDS_Shape,
  b: TopoDS_Shape,
): Omit<DistanceMeasure, 'planes'> {
  // Released before delete by `releaseOwned`, which unloads both shapes.
  const extrema = s.own(new oc.BRepExtrema_DistShapeShape(a, b));
  if (!extrema.IsDone() || extrema.NbSolution() < 1) {
    throw new KernelError('measure', 'the minimum distance could not be computed');
  }
  const pairs: [Vec3, Vec3][] = [];
  for (let i = 1; i <= extrema.NbSolution(); i++) {
    pairs.push([toVec3(s.own(extrema.PointOnShape1(i))), toVec3(s.own(extrema.PointOnShape2(i)))]);
  }
  // Parallel faces reach the minimum along a whole region; show the pair
  // nearest the middle of all of them, not whichever OCCT found first.
  const mid = (p: [Vec3, Vec3]): Vec3 => [
    (p[0][0] + p[1][0]) / 2,
    (p[0][1] + p[1][1]) / 2,
    (p[0][2] + p[1][2]) / 2,
  ];
  const centre = [0, 0, 0];
  for (const p of pairs) {
    const m = mid(p);
    for (let c = 0; c < 3; c++) centre[c]! += m[c]! / pairs.length;
  }
  let best = pairs[0]!;
  let bestD = Infinity;
  for (const p of pairs) {
    const m = mid(p);
    const d = Math.hypot(m[0] - centre[0]!, m[1] - centre[1]!, m[2] - centre[2]!);
    if (d < bestD - 1e-9) {
      best = p;
      bestD = d;
    }
  }
  return { value: extrema.Value(), from: best[0], to: best[1], solutions: pairs.length };
}

/** A direction an item contributes to an angle: a line (or axis), or a plane's normal. */
function orientation(item: MeasuredItem): { line: Vec3 } | { plane: Vec3; face: boolean } | null {
  if (item.kind === 'edge' && item.direction) return { line: item.direction };
  if (item.kind === 'face' && item.normal) return { plane: item.normal, face: true };
  if (
    item.kind === 'face' &&
    item.axis &&
    (item.surface === 'cylinder' || item.surface === 'cone')
  ) {
    return { line: item.axis.direction };
  }
  return null;
}

function angle(a: MeasuredItem, b: MeasuredItem): AngleMeasure | null {
  const oa = orientation(a);
  const ob = orientation(b);
  if (oa === null || ob === null) return null;
  const clampAcos = (c: number) => Math.acos(Math.max(-1, Math.min(1, c)));
  const acute = (u: Vec3, v: Vec3) => {
    // atan2 of |u x v| and |u . v| keeps precision near 0 and near 90 degrees.
    const value = Math.atan2(norm(cross(u, v)), Math.abs(dot(u, v)));
    return value < ANGLE_TOL ? 0 : value;
  };
  if ('line' in oa && 'line' in ob) {
    return { value: acute(oa.line, ob.line), between: 'lines', normals: null };
  }
  if ('plane' in oa && 'plane' in ob) {
    return {
      value: acute(oa.plane, ob.plane),
      between: 'planes',
      normals: clampAcos(dot(oa.plane, ob.plane)),
    };
  }
  const line = 'line' in oa ? oa.line : (ob as { line: Vec3 }).line;
  const plane = 'plane' in oa ? oa.plane : (ob as { plane: Vec3 }).plane;
  // The angle between a line and a plane is 90 degrees less the angle to its normal.
  return { value: Math.PI / 2 - acute(line, plane), between: 'line-plane', normals: null };
}

/** The relative error the volume integration aims for. */
const VOLUME_EPS = 1e-7;

function matrix(m: { Value(row: number, col: number): number }): Matrix3 {
  const row = (r: number): Vec3 => [m.Value(r, 1), m.Value(r, 2), m.Value(r, 3)];
  return [row(1), row(2), row(3)];
}

function bodyMeasure(oc: Oc, s: Scope, shape: TopoDS_Shape): BodyMeasure {
  const vprops = s.own(new oc.GProp_GProps());
  // The adaptive overload with a tolerance: the plain one can be far off on long B-spline faces
  // (a helical thread groove), and the inertia needs the second moments right too.
  oc.BRepGProp.VolumeProperties(shape, vprops, VOLUME_EPS, false, false);
  const sprops = s.own(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(shape, sprops, false, false);
  const box = s.own(new oc.Bnd_Box());
  // Optimal: from the exact geometry, not enlarged by the shape's tolerance.
  oc.BRepBndLib.AddOptimal(shape, box, false, false);
  const volume = vprops.Mass();
  return {
    volume,
    area: sprops.Mass(),
    centerOfMass: Math.abs(volume) > 0 ? toVec3(s.own(vprops.CentreOfMass())) : null,
    volumeInertia: Math.abs(volume) > 0 ? matrix(s.own(vprops.MatrixOfInertia())) : null,
    boundingBox: box.IsVoid()
      ? null
      : { min: toVec3(s.own(box.CornerMin())), max: toVec3(s.own(box.CornerMax())) },
  };
}
