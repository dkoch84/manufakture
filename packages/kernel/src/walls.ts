// The wall around a hole (#1210): how much material there is radially outside a hole's wall,
// measured on the exact B-rep by casting rays, never on the mesh.
//
// Which faces: every cylindrical face of the body whose lineage holds `<hole>:wall:<point>`, or
// that name in a pattern instance or mirror image (`pattern#7:i2/<hole>:wall:<point>`), so a wall
// split or merged by a later feature is still found, and each piece is measured. Faces that are not
// holes (their material inside, toward the axis) are left out.
//
// How: from points on the wall, a ray goes radially outward, away from the axis, through the
// material, and the distance to the first face it reaches is the wall there. Points: a grid over
// the face's parameters, `ANGLES` around and `STATIONS` along the axis (the stations at the ends
// `END_OFFSET` in, so a ray does not run along the face that closes the hole), then a golden
// section search around the thinnest one, in angle and then along the axis, twice. A grid point
// that is not on the face (a wall trimmed by a later cut) is passed over. The result is the
// thinnest of every ray cast, so it is never thinner than the material along a ray. It is exact for
// a wall whose outside is a coaxial cylinder or a plane parallel to the axis.
//
// What the rays do not measure, and so the error is always toward missing a warning:
// - A ray that leaves the material through a face sharing an edge with the wall (the face the hole
//   opens into, its bottom or drill point, a countersink, a counterbore floor) measures nothing.
//   Those faces close the hole rather than wall it in; where the face the hole was drilled into is
//   curved or sloped (a radial hole in a rod, a hole in a slope or a fillet), rays from just under
//   its edge on the side where the surface falls away would otherwise leave through it after about
//   0 mm. So a hole drilled into a rod is not checked against the rod's own surface.
// - Rays are square to the axis, so against an outside that is not parallel to the axis (a cone,
//   a slanted face) they read the distance across, which is more than the true, slanted, minimum.
//
// A hole that breaks out of the body (through a plate's edge, a boss's side, another parallel hole)
// meets that face in edges along its axis: it reads `wall: 0` and `breakout: true`, naming the face.
// A breakout into a face that is not parallel to the axis (a slanted pocket wall) looks like a face
// closing the hole and is missed; so is the wall of a domed boss whose top and side are one face,
// which reads null like the rod.
//
// Rays reach `range` mm at most: a wall thicker than that reads as null. Each face of the body gets
// its own `IntCurvesFace_Intersector` (a handle type, which libcascade frees; the shape-wide
// intersector keeps about 1.6 KB a face it cannot free), and a ray only tries the faces whose box
// it crosses within range.

import type { TopoDS_Face, TopoDS_Shape } from 'libcascade/single/init';
import { KernelError } from './errors';
import type { NamedShape } from './kernel';
import { mapShapes, toVec3, withScope, type Oc, type Scope } from './occt';
import { cylinderIsHole } from './topology';
import type { Vec3 } from './types';

/** Parallel within this (the sine of the angle), and on the same line or radius within this (mm). */
const PARALLEL = 1e-6;
const SAME = 1e-6;

/** Default reach of the rays, mm. */
export const DEFAULT_WALL_RANGE = 10;
/** Most hole wall faces one call measures; the rest are reported with `wall: null, skipped: true`. */
export const MAX_WALL_FACES = 256;
/** Grid of rays per face: around the axis, and along it. */
const ANGLES = 36;
const STATIONS = 5;
/** How far in from the ends of a face the end stations are, mm (or a quarter of a short face). */
const END_OFFSET = 0.01;
/** A hit within this of the ray's start is the wall itself, mm. */
const ON_FACE = 1e-4;
/** Golden section iterations per search, and rounds of (angle, axial) searches. */
const GOLDEN_STEPS = 14;
const ROUNDS = 2;
const INTERSECT_TOLERANCE = 1e-6;

export interface HoleWallOptions {
  /** mm; default `DEFAULT_WALL_RANGE`. */
  range?: number;
}

/** The thinnest wall around one hole wall face. */
export interface HoleWall {
  /** The hole feature. */
  hole: string;
  /** The sketch point the hole was drilled at (the `<point>` of `<hole>:wall:<point>`). */
  point: string;
  /** The wall face's name on the body (a piece of a split wall, a pattern copy). */
  face: string;
  /** The wall's radius, mm. */
  radius: number;
  /** The thinnest material radially outside the wall, mm; null when none is within `range`. */
  wall: number | null;
  /** Where: on the hole wall, and where the material ends; null with `wall` null. */
  from: Vec3 | null;
  to: Vec3 | null;
  /** The face the material ends at, by name (null with `wall` null). */
  toFace: string | null;
  /** True when the face was not measured because the call had `MAX_WALL_FACES` already. */
  skipped?: true;
  /**
   * True when the hole breaks out of the body through `toFace` (it shares an edge with the wall
   * and runs along the axis): `wall` is 0, `from` and `to` a point on that edge.
   */
  breakout?: true;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
/** Whether `d` (any length) is parallel to unit `z`. */
const alongAxis = (d: Vec3, z: Vec3) => {
  const n = len3(d);
  if (n === 0) return false;
  const c = dot3(d, z) / n;
  return Math.sqrt(Math.max(0, 1 - c * c)) < PARALLEL;
};

/**
 * The faces sharing an edge with wall face `wall`, sorted out:
 * - the same cylinder going on (a wall split into adjacent pieces): nothing;
 * - a face that runs along the axis (a plane parallel to it, a cylinder on a parallel axis, or one
 *   meeting the wall in a straight edge along the axis): the hole breaks out of the body through it,
 *   so there is no wall there at all;
 * - any other face closes the hole (the face it opens into, its bottom or drill point, a
 *   countersink, a counterbore floor): a ray leaving through one measures nothing.
 */
function neighbours(
  named: NamedShape,
  wall: number,
  c: { origin: Vec3; z: Vec3; radius: number },
): { closing: Set<number>; breakout: { face: number; at: Vec3 } | null } {
  const t = named.topology;
  const closing = new Set<number>();
  let breakout: { face: number; at: Vec3 } | null = null;
  const distanceToAxis = (p: Vec3) => {
    const r = sub(p, c.origin);
    const along = dot3(r, c.z);
    return len3([r[0] - along * c.z[0], r[1] - along * c.z[1], r[2] - along * c.z[2]]);
  };
  for (const e of t.edges) {
    if (!e.faces.includes(wall)) continue;
    const straight =
      e.curve === 'line' &&
      e.vertices.length === 2 &&
      alongAxis(
        sub(t.vertices[e.vertices[1]! - 1]!.point, t.vertices[e.vertices[0]! - 1]!.point),
        c.z,
      );
    for (const n of e.faces) {
      if (n === wall) continue;
      const f = t.faces[n - 1];
      if (f === undefined) continue;
      const cylinder = f.surface === 'cylinder' && f.axis !== null && alongAxis(f.axis, c.z);
      if (
        cylinder &&
        f.axisOrigin != null &&
        distanceToAxis(f.axisOrigin) < SAME &&
        Math.abs((f.radius ?? 0) - c.radius) < SAME
      ) {
        continue;
      }
      const plane =
        f.surface === 'plane' && f.normal !== null && Math.abs(dot3(f.normal, c.z)) < PARALLEL;
      if (plane || cylinder || straight) {
        breakout ??= { face: n, at: e.midpoint };
        continue;
      }
      closing.add(n);
    }
  }
  return { closing, breakout };
}

/**
 * `<hole>:wall:<point>`, alone or behind pattern and mirror prefixes (`pattern#7:i2/`). A piece of
 * a split wall (`<hole>:wall:p1#1`, `<hole>:wall:p1{K}`) has the whole wall's name further down
 * its lineage: the first name without such a piece suffix gives the point.
 */
function wallPoint(
  lineage: readonly string[],
  holes: ReadonlySet<string>,
): [string, string] | null {
  let piece: [string, string] | null = null;
  for (const n of lineage) {
    const m = /^(?:[a-z][a-z-]*#[0-9]+:(?:i[0-9]+|image)\/)*([a-z][a-z-]*#[0-9]+):wall:(.+)$/.exec(
      n,
    );
    if (m === null || !holes.has(m[1]!)) continue;
    if (!/(#[0-9]+|\{[^{}]*\})$/.test(m[2]!)) return [m[1]!, m[2]!];
    piece ??= [m[1]!, m[2]!];
  }
  return piece;
}

type Intersector = InstanceType<Oc['IntCurvesFace_Intersector']>;

/** A face of the body as rays meet it: its intersector and its box. */
interface Target {
  index: number;
  intersector: Intersector;
  min: Vec3;
  max: Vec3;
}

/** Every face of the body, with an intersector and a box each, owned by `s`. */
function targetsOf(oc: Oc, s: Scope, faceMap: ReturnType<typeof mapShapes>): Target[] {
  const box = s.own(new oc.Bnd_Box());
  const out: Target[] = [];
  for (let i = 1; i <= faceMap.Extent(); i++) {
    const face: TopoDS_Face = s.own(oc.TopoDS.Face(s.own(faceMap.FindKey(i))));
    box.SetVoid();
    oc.BRepBndLib.AddOptimal(face, box, false, false);
    if (box.IsVoid()) continue;
    const e = 1e-6;
    const lo = toVec3(s.own(box.CornerMin()));
    const hi = toVec3(s.own(box.CornerMax()));
    out.push({
      index: i,
      intersector: s.own(new oc.IntCurvesFace_Intersector(face, INTERSECT_TOLERANCE, true, true)),
      min: [lo[0] - e, lo[1] - e, lo[2] - e],
      max: [hi[0] + e, hi[1] + e, hi[2] + e],
    });
  }
  return out;
}

/** Whether the segment from `p` along unit `d` for `t` in [t0, t1] meets the box (slab test). */
function crosses(p: Vec3, d: Vec3, t0: number, t1: number, min: Vec3, max: Vec3): boolean {
  let lo = t0;
  let hi = t1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-15) {
      if (p[k]! < min[k]! || p[k]! > max[k]!) return false;
      continue;
    }
    let a = (min[k]! - p[k]!) / d[k]!;
    let b = (max[k]! - p[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
    if (lo > hi) return false;
  }
  return true;
}

/**
 * The thinnest wall around every wall face of the hole features `holes` on `shape` (a body with
 * names): one entry per face, in face order. Everything is owned by `s`.
 */
export function holeWallsOf(
  oc: Oc,
  s: Scope,
  shape: TopoDS_Shape,
  named: NamedShape | null,
  holes: readonly string[],
  options: HoleWallOptions = {},
): HoleWall[] {
  const range = options.range ?? DEFAULT_WALL_RANGE;
  if (!(range > 0) || !Number.isFinite(range)) {
    throw new KernelError('holeWalls', 'the range must be a positive number of millimetres', {
      code: 'invalid-argument',
    });
  }
  if (named === null || holes.length === 0) return [];
  const wanted = new Set(holes);
  const faceMap = mapShapes(oc, s, shape, 'face');
  const faceName = (i: number) => named.names.faces[i - 1]?.name ?? `face ${i}`;
  const out: HoleWall[] = [];
  let targets: Target[] | null = null;
  let line: InstanceType<Oc['gp_Lin']> | null = null;
  for (let i = 1; i <= faceMap.Extent(); i++) {
    const f = named.names.faces[i - 1];
    if (f === undefined) continue;
    const at = wallPoint(f.lineage, wanted);
    if (at === null) continue;
    const measured = withScope(oc, (fs) => {
      const face: TopoDS_Face = fs.own(oc.TopoDS.Face(fs.own(faceMap.FindKey(i))));
      const adaptor = fs.own(new oc.BRepAdaptor_Surface(face, true));
      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return null;
      const cyl = fs.own(adaptor.Cylinder());
      const ax3 = fs.own(cyl.Position());
      const origin = toVec3(fs.own(ax3.Location()));
      const z = toVec3(fs.own(ax3.Direction()));
      const x = toVec3(fs.own(ax3.XDirection()));
      const y = toVec3(fs.own(ax3.YDirection()));
      const radius = cyl.Radius();
      const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      if (!cylinderIsHole(fs, adaptor, origin, z, cyl.Direct(), reversed)) return null;
      const base = { hole: at[0], point: at[1], face: f.name, radius };
      if (out.length >= MAX_WALL_FACES) {
        return { ...base, wall: null, from: null, to: null, toFace: null, skipped: true as const };
      }
      const { closing, breakout } = neighbours(named, i, { origin, z, radius });
      if (breakout !== null) {
        const p = breakout.at;
        return {
          ...base,
          wall: 0,
          from: p,
          to: p,
          toFace: faceName(breakout.face),
          breakout: true as const,
        };
      }
      targets ??= targetsOf(oc, s, faceMap);
      line ??= s.own(new oc.gp_Lin(s.own(new oc.gp_Pnt(0, 0, 0)), s.own(new oc.gp_Dir(1, 0, 0))));
      const ray = rayCaster(oc, fs, line, targets, i, closing, range, {
        origin,
        x,
        y,
        z,
        radius,
      });
      const best = search(ray, {
        u0: adaptor.FirstUParameter(),
        u1: adaptor.LastUParameter(),
        v0: adaptor.FirstVParameter(),
        v1: adaptor.LastVParameter(),
        periodic: adaptor.IsUPeriodic(),
      });
      return best === null
        ? { ...base, wall: null, from: null, to: null, toFace: null }
        : { ...base, wall: best.wall, from: best.from, to: best.to, toFace: faceName(best.face) };
    });
    if (measured !== null) out.push(measured);
  }
  return out;
}

interface Hit {
  wall: number;
  from: Vec3;
  to: Vec3;
  /** 1-based face index the material ends at. */
  face: number;
}

/** One ray from the wall at (u, v), radially outward: the hit, or null (off the face, nothing in range). */
type Ray = (u: number, v: number) => Hit | null;

/**
 * The rays from wall face `wall` (1-based). One point, direction and line serve every ray:
 * libcascade cannot free small values (their delete() is empty), so every object made per ray
 * would stay behind.
 */
function rayCaster(
  oc: Oc,
  s: Scope,
  line: InstanceType<Oc['gp_Lin']>,
  targets: readonly Target[],
  wall: number,
  closing: ReadonlySet<number>,
  range: number,
  c: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3; radius: number },
): Ray {
  const pnt = s.own(new oc.gp_Pnt(0, 0, 0));
  const dir = s.own(new oc.gp_Dir(1, 0, 0));
  return (u, v) => {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const d: Vec3 = [
      cu * c.x[0] + su * c.y[0],
      cu * c.x[1] + su * c.y[1],
      cu * c.x[2] + su * c.y[2],
    ];
    // A cylinder's point at (u, v): location + v along the axis + radius toward u.
    const p: Vec3 = [
      c.origin[0] + v * c.z[0] + c.radius * d[0],
      c.origin[1] + v * c.z[1] + c.radius * d[1],
      c.origin[2] + v * c.z[2] + c.radius * d[2],
    ];
    pnt.SetCoord(p[0], p[1], p[2]);
    dir.SetCoord(d[0], d[1], d[2]);
    line.SetLocation(pnt);
    line.SetDirection(dir);
    let onFace = false;
    let thinnest = Infinity;
    let at = 0;
    for (const t of targets) {
      if (!crosses(p, d, -ON_FACE, Math.min(range, thinnest), t.min, t.max)) continue;
      t.intersector.Perform(line, -ON_FACE, range);
      if (!t.intersector.IsDone()) continue;
      for (let i = 1; i <= t.intersector.NbPnt(); i++) {
        const w = t.intersector.WParameter(i);
        if (Math.abs(w) <= ON_FACE) {
          // The ray's start, on the wall face itself (the intersector keeps to the face's
          // boundaries, so a point of its parameter box a later cut trimmed away is not on it).
          if (t.index === wall) onFace = true;
          continue;
        }
        if (w > ON_FACE && w < thinnest) {
          thinnest = w;
          at = t.index;
        }
      }
    }
    // Off the face, nothing in range, or out through a face that closes the hole: no wall here.
    if (!onFace || !Number.isFinite(thinnest) || closing.has(at)) return null;
    return {
      wall: thinnest,
      from: p,
      to: [p[0] + thinnest * d[0], p[1] + thinnest * d[1], p[2] + thinnest * d[2]],
      face: at,
    };
  };
}

/** The thinnest hit of a grid over the face's parameters, refined by golden section searches. */
function search(
  ray: Ray,
  box: { u0: number; u1: number; v0: number; v1: number; periodic: boolean },
): Hit | null {
  const full = box.periodic && box.u1 - box.u0 >= 2 * Math.PI - 1e-9;
  const length = box.v1 - box.v0;
  const end = Math.min(END_OFFSET, length / 4);
  const vMin = box.v0 + end;
  const vMax = box.v1 - end;
  const du = (box.u1 - box.u0) / (full ? ANGLES : ANGLES - 1);
  // A partial face's angle grid stays off its ends too, as its stations do.
  const uMin = full ? -Infinity : box.u0 + Math.min(du / 4, 1e-3);
  const uMax = full ? Infinity : box.u1 - Math.min(du / 4, 1e-3);
  const at: { best: Hit | null; u: number; v: number } = { best: null, u: 0, v: 0 };
  const tryAt = (u: number, v: number): number => {
    const h = ray(u, v);
    if (h === null) return Infinity;
    if (at.best === null || h.wall < at.best.wall) {
      at.best = h;
      at.u = u;
      at.v = v;
    }
    return h.wall;
  };
  for (let j = 0; j < STATIONS; j++) {
    const v = vMin + ((vMax - vMin) * j) / (STATIONS - 1);
    for (let i = 0; i < ANGLES; i++) {
      const u = full ? box.u0 + i * du : Math.min(uMax, Math.max(uMin, box.u0 + i * du));
      tryAt(u, v);
    }
  }
  if (at.best === null) return null;
  const dv = (vMax - vMin) / (STATIONS - 1);
  for (let round = 0; round < ROUNDS; round++) {
    const v = at.v;
    golden((u) => tryAt(u, v), Math.max(uMin, at.u - du), Math.min(uMax, at.u + du));
    const u = at.u;
    golden((w) => tryAt(u, w), Math.max(vMin, at.v - dv), Math.min(vMax, at.v + dv));
  }
  return at.best;
}

/** A golden section search for the least of `f` on [a, b]; `f` keeps track of the best itself. */
function golden(f: (t: number) => number, a: number, b: number): void {
  if (!(b > a)) return;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < GOLDEN_STEPS; i++) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
}
