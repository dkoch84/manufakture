// Views of placed bodies (M4 plan, T4.4b): hidden-line removal with OCCT's exact algorithm
// (`HLRBRep_Algo`), and the result turned into classified 2D curves a drawing can use. The spike
// (docs/spikes/T4.4a-hlr.md) set the rules this file follows:
//
// - Exact HLR only. The poly algorithm draws hidden edges as visible where boards touch (the
//   bookshelf's back in its rabbets), so it is not offered, not even as a fallback.
// - Every item of a view goes into ONE run, and the result is read per item
//   (`CompoundOfEdges(S, ...)`): projecting items alone and merging loses the occlusion between
//   them (up to 72 % of a cabinet run's visible length wrong). Per-item reading is exact and costs
//   about the same as reading the whole view.
// - The view frame is `gp_Ax2(origin, -direction, normalize(up x -direction))`: a point p lands
//   at (dot(p - o, x), dot(p - o, y)) with y = z x x. `viewFrame` and `projectPoint` compute the
//   same thing in plain TypeScript (tested equal), so dimensions are projected without the kernel.
// - Curves: lines, circles and ellipses become `line`, `arc` and `ellipseArc` records; anything
//   else is sampled within the deflection and becomes a `line` when it is straight (a circle seen
//   edge on comes back from HLR as a B-spline) or a `polyline`.
// - Memory: the algorithm keeps every loaded shape alive through `HLRBRep_HLRToShape`, whose
//   destructor is empty, so `releaseOwned` removes the shapes (`Remove(i)`) before `delete()`
//   (640 KiB a projection down to 70 on the spike's 40-hole board). Points are read with `D0`
//   into one reused `gp_Pnt`: `gp_Pnt`'s destructor is empty, a `Value(u)` per point would leak.
//
// Sections: with `section: { origin, normal }`, every item is first cut by a large box covering
// the side of the plane the normal points AWAY from, so the half space `dot(p - origin, normal)
// >= 0` is kept. The normal is the direction of sight of the section (the way the arrows on a
// cutting-plane line point): for a section seen in the view, pass the view's `direction`. The faces
// of the cut bodies that lie on the plane are the section, returned per item as closed loops for
// hatching.

import type { BRepAdaptor_Curve, gp_Pnt, TopoDS_Face, TopoDS_Shape } from 'libcascade/single/init';
import { KernelError } from './errors';
import { placed, placementProblem } from './interference';
import { cross, dot, mapShapes, norm, Scope, toVec3, withScope, type Oc } from './occt';
import type { Placement, ShapeId, Vec2, Vec3 } from './types';

/** One body in a view. */
export interface ProjectItem {
  shape: ShapeId;
  /** Where the body sits in the view's model space (an assembly instance's pose). Absent: as it is. */
  transform?: Placement;
  /** The caller's name for the item (a body id, an instance path); echoed in `keys`. Unique. */
  key: string;
}

/** An orthographic view. */
export interface ProjectView {
  /** From the viewer into the scene. */
  direction: Vec3;
  /** Up on paper; must not be parallel to `direction`. */
  up: Vec3;
  /** The frame's origin (default the world origin); it only shifts the 2D output. */
  origin?: Vec3;
}

/** A cutting plane: the half space `dot(p - origin, normal) >= 0` is kept (see the file comment). */
export interface SectionPlane {
  origin: Vec3;
  normal: Vec3;
}

export interface ProjectOptions {
  /** Return hidden edges (default true). With false, they are not even read. */
  hidden?: boolean;
  /** Tangent edges between G1-continuous faces (`Rg1Line`, fillet boundaries); default true. */
  smooth?: boolean;
  /** Edges of higher continuity (`RgNLine`, in practice the seams of closed faces); default false. */
  sewn?: boolean;
  /** Chord deflection of polylines (freeform curves), model mm; default 0.05. */
  deflection?: number;
  /** Cut every item by this plane first and return its section faces. */
  section?: SectionPlane;
}

/**
 * - `sharp`: an edge between faces that meet at an angle (and a seam that lies on a silhouette,
 *   which HLR reports once, as sharp);
 * - `smooth`: a tangent edge;
 * - `sewn`: a seam;
 * - `outline`: a silhouette of a curved face, which is not a model edge.
 */
export type EdgeClass = 'sharp' | 'smooth' | 'sewn' | 'outline';

/**
 * 2D geometry in view coordinates, model mm: x right, y up on paper. Arcs and elliptical arcs run
 * counter-clockwise from `start` to `end` (radians, `start` in [0, 2 pi), `end > start`).
 */
export type Curve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; center: Vec2; radius: number; start: number; end: number }
  | {
      kind: 'ellipseArc';
      center: Vec2;
      /** Semi-axes, `major >= minor`. */
      major: number;
      minor: number;
      /** Angle of the major axis from view x, in (-pi, pi]. */
      rotation: number;
      /** Eccentric anomaly: the point is center + R(rotation) (major cos t, minor sin t). */
      start: number;
      end: number;
    }
  | { kind: 'polyline'; points: Vec2[] };

export interface ProjectedEdge {
  /** Index into the items (and `keys`). */
  item: number;
  cls: EdgeClass;
  visible: boolean;
  curve: Curve2;
}

/** One planar face of a section, in view coordinates. */
export interface SectionFace {
  /**
   * The outer loop, then `holes`: each a closed chain of curves, every curve meeting the next at
   * one of its ends. Lines and polylines run along the loop; arcs always run counter-clockwise, so
   * one may run against it.
   */
  outer: Curve2[];
  holes: Curve2[][];
  /** The face's true area, mm2. */
  area: number;
}

export interface ItemSection {
  item: number;
  /** Empty when the plane misses the item, or the item lies wholly on the removed side. */
  faces: SectionFace[];
}

export interface Bounds2 {
  min: Vec2;
  max: Vec2;
}

export interface ProjectResult {
  /** The items' keys, in item order. */
  keys: string[];
  /** Per item, then per class (sharp, smooth, sewn, outline), visible before hidden. */
  edges: ProjectedEdge[];
  /** The 2D box of every returned edge and section loop; null when there are none. */
  bounds: Bounds2 | null;
  /** With `section`: one entry per item, in item order. */
  sections?: ItemSection[];
}

/** The view frame: x right and y up on paper, z toward the viewer. */
export interface ViewFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const DEFAULT_PROJECT_DEFLECTION = 0.05;

/** An item for `projectView`: its OCCT shape (the arena's) and placement. */
export interface ProjectInput {
  shape: TopoDS_Shape;
  transform?: Placement;
  key: string;
}

const OP = 'project';
/** `up` closer than this to `direction` (sine of the angle between them) is parallel. */
const PARALLEL = 1e-9;
/** Directions within this (1 - |cos|) of each other are parallel. */
const ALIGNED = 1e-9;
/** A face whose plane is within this of the section plane (mm) lies on it. */
const ON_PLANE = 1e-6;
/** A sampled curve is straight when every point is within this fraction of its chord (at least 1 mm). */
const STRAIGHT = 1e-6;
const TWO_PI = 2 * Math.PI;

const TYPES: Record<
  EdgeClass,
  'HLRBRep_Sharp' | 'HLRBRep_Rg1Line' | 'HLRBRep_RgNLine' | 'HLRBRep_OutLine'
> = {
  sharp: 'HLRBRep_Sharp',
  smooth: 'HLRBRep_Rg1Line',
  sewn: 'HLRBRep_RgNLine',
  outline: 'HLRBRep_OutLine',
};

const unit = (v: Vec3): Vec3 => {
  const n = norm(v);
  return [v[0] / n, v[1] / n, v[2] / n];
};

const finiteVec = (v: Vec3): boolean =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

function invalid(message: string): KernelError {
  return new KernelError(OP, message, { code: 'invalid-argument' });
}

/**
 * The frame of `view`: z = -direction, x = up x z, y = z x x, all unit. Throws `invalid-argument`
 * for a zero or non-finite direction or up, or an up parallel to the direction.
 */
export function viewFrame(view: ProjectView): ViewFrame {
  const origin = view.origin ?? [0, 0, 0];
  if (!finiteVec(view.direction)) throw invalid('view.direction must be three finite numbers');
  if (!finiteVec(view.up)) throw invalid('view.up must be three finite numbers');
  if (!finiteVec(origin)) throw invalid('view.origin must be three finite numbers');
  if (!(norm(view.direction) > 1e-12)) throw invalid('view.direction is a zero vector');
  if (!(norm(view.up) > 1e-12)) throw invalid('view.up is a zero vector');
  const z = unit([-view.direction[0], -view.direction[1], -view.direction[2]]);
  const side = cross(unit(view.up), z);
  if (!(norm(side) > PARALLEL)) throw invalid('view.up must not be parallel to view.direction');
  const x = unit(side);
  return { origin, x, y: cross(z, x), z };
}

/** A 3D point in view coordinates: (dot(p - o, x), dot(p - o, y)), as HLR projects it. */
export function projectPoint(frame: ViewFrame, p: Vec3): Vec2 {
  const d: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
  return [dot(d, frame.x), dot(d, frame.y)];
}

/** HLR's 2D output lies in its own z = 0 plane: reading it is projecting with this frame. */
const PAPER: ViewFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function checkOptions(items: readonly ProjectInput[], options: ProjectOptions): number {
  const deflection = options.deflection ?? DEFAULT_PROJECT_DEFLECTION;
  if (typeof deflection !== 'number' || !Number.isFinite(deflection) || !(deflection > 0)) {
    throw invalid('deflection must be a positive finite number');
  }
  const keys = new Set<string>();
  items.forEach((item, i) => {
    if (typeof item.key !== 'string') throw invalid(`items[${i}].key must be a string`);
    if (keys.has(item.key))
      throw invalid(`items[${i}].key ${JSON.stringify(item.key)} is repeated`);
    keys.add(item.key);
    const problem = item.transform === undefined ? null : placementProblem(item.transform);
    if (problem !== null) throw invalid(`items[${i}].${problem}`);
  });
  const section = options.section;
  if (section !== undefined) {
    if (!finiteVec(section.origin)) throw invalid('section.origin must be three finite numbers');
    if (!finiteVec(section.normal)) throw invalid('section.normal must be three finite numbers');
    if (!(norm(section.normal) > 1e-12)) throw invalid('section.normal is a zero vector');
  }
  return deflection;
}

/**
 * Hidden-line removal of `items` in `view` (see the file comment). Everything is owned by `s`.
 * `fail` turns an error thrown by a section cut into a `KernelError` (decoding OCCT's exception).
 */
export function projectView(
  oc: Oc,
  s: Scope,
  items: readonly ProjectInput[],
  view: ProjectView,
  options: ProjectOptions,
  fail: (error: unknown) => KernelError,
): ProjectResult {
  const frame = viewFrame(view);
  const deflection = checkOptions(items, options);
  const keys = items.map((item) => item.key);
  const shapes: (TopoDS_Shape | null)[] = items.map((item) =>
    placed(oc, s, item.shape, item.transform),
  );
  const point = s.own(new oc.gp_Pnt(0, 0, 0));
  const result: ProjectResult = { keys, edges: [], bounds: null };

  if (options.section !== undefined) {
    const plane: SectionPlane = {
      origin: options.section.origin,
      normal: unit(options.section.normal),
    };
    const cutter = halfSpaceBox(oc, s, shapes, plane);
    result.sections = shapes.map((shape, item) => {
      if (shape === null || cutter === null) return { item, faces: [] };
      let cut: TopoDS_Shape;
      try {
        cut = cutBy(oc, s, shape, cutter);
      } catch (error) {
        const e = fail(error);
        if (e.code === 'fatal') throw e;
        throw new KernelError(
          OP,
          `the section could not cut item ${item} (${keys[item]}): ${e.detail}`,
          {
            ...(e.occtType === undefined ? {} : { occtType: e.occtType }),
            ...(e.occtMessage === undefined ? {} : { occtMessage: e.occtMessage }),
          },
        );
      }
      const empty = mapShapes(oc, s, cut, 'face').Extent() === 0;
      shapes[item] = empty ? null : cut;
      return {
        item,
        faces: empty ? [] : sectionFaces(oc, s, cut, plane, frame, deflection, point),
      };
    });
  }

  const loaded = shapes.filter((x): x is TopoDS_Shape => x !== null);
  if (loaded.length > 0) {
    // Owned, so `releaseOwned` removes the loaded shapes before delete (see occt.ts).
    const algo = s.own(new oc.HLRBRep_Algo());
    for (const shape of loaded) algo.Add(shape, 0);
    const ax2 = s.own(
      new oc.gp_Ax2(
        s.own(new oc.gp_Pnt(...frame.origin)),
        s.own(new oc.gp_Dir(...frame.z)),
        s.own(new oc.gp_Dir(...frame.x)),
      ),
    );
    algo.Projector(s.own(new oc.HLRAlgo_Projector(ax2)));
    algo.Update();
    algo.Hide();
    // Holds a handle on the algorithm and frees nothing on delete: one per view, never in a loop.
    const toShape = s.own(new oc.HLRBRep_HLRToShape(algo));
    const classes: EdgeClass[] = ['sharp'];
    if (options.smooth !== false) classes.push('smooth');
    if (options.sewn === true) classes.push('sewn');
    classes.push('outline');
    const visibility = options.hidden === false ? [true] : [true, false];
    shapes.forEach((shape, item) => {
      if (shape === null) return;
      for (const cls of classes) {
        for (const visible of visibility) {
          withScope(oc, (rs) => {
            const type = oc.HLRBRep_TypeOfResultingEdge[TYPES[cls]];
            const compound = rs.own(toShape.CompoundOfEdges(shape, type, visible, false));
            if (compound.IsNull()) return;
            eachCurve(oc, rs, compound, (curve) => {
              const c = readCurve(oc, curve, PAPER, deflection, point);
              if (c !== null) result.edges.push({ item, cls, visible, curve: c });
            });
          });
        }
      }
    });
  }

  const curves = result.edges.map((e) => e.curve);
  for (const section of result.sections ?? []) {
    for (const face of section.faces) curves.push(...face.outer, ...face.holes.flat());
  }
  result.bounds = boundsOf(curves);
  return result;
}

// Sections ----------------------------------------------------------------------------------

/**
 * A box covering the removed side of `plane` (`dot(p - origin, normal) < 0`) far enough to hold
 * every placed shape, or null when there is nothing to cut.
 */
function halfSpaceBox(
  oc: Oc,
  s: Scope,
  shapes: readonly (TopoDS_Shape | null)[],
  plane: SectionPlane,
): TopoDS_Shape | null {
  const box = s.own(new oc.Bnd_Box());
  for (const shape of shapes) if (shape !== null) oc.BRepBndLib.Add(shape, box, false);
  if (box.IsVoid()) return null;
  const min = toVec3(s.own(box.CornerMin()));
  const max = toVec3(s.own(box.CornerMax()));
  let reach = 1;
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    reach = Math.max(
      reach,
      norm([c[0] - plane.origin[0], c[1] - plane.origin[1], c[2] - plane.origin[2]]),
    );
  }
  // Twice the farthest corner, so the box's own faces stay well clear of every shape.
  const L = 2 * reach + 10;
  const z: Vec3 = [-plane.normal[0], -plane.normal[1], -plane.normal[2]];
  const helper: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = unit(cross(helper, z));
  const y = cross(z, x);
  const o = plane.origin;
  const corner: Vec3 = [
    o[0] - L * (x[0] + y[0]),
    o[1] - L * (x[1] + y[1]),
    o[2] - L * (x[2] + y[2]),
  ];
  const ax2 = s.own(
    new oc.gp_Ax2(
      s.own(new oc.gp_Pnt(...corner)),
      s.own(new oc.gp_Dir(...z)),
      s.own(new oc.gp_Dir(...x)),
    ),
  );
  const maker = s.own(new oc.BRepPrimAPI_MakeBox(ax2, 2 * L, 2 * L, L));
  maker.Build();
  if (!maker.IsDone()) throw new Error('the section box could not be made');
  return s.own(maker.Shape());
}

/** `shape` less `tool`, owned by `s`; the arena's shape is left untouched. */
function cutBy(oc: Oc, s: Scope, shape: TopoDS_Shape, tool: TopoDS_Shape): TopoDS_Shape {
  const builder = s.own(new oc.BRepAlgoAPI_Cut());
  builder.SetArguments(s.own(new oc.NCollection_List_TopoDS_Shape([shape])));
  builder.SetTools(s.own(new oc.NCollection_List_TopoDS_Shape([tool])));
  builder.SetNonDestructive(true);
  builder.SetToFillHistory(false);
  builder.Build();
  if (!builder.IsDone() || builder.HasErrors()) throw new Error('the cut failed');
  return s.own(builder.Shape());
}

/** The faces of `cut` that lie on the plane, as loops in view coordinates. */
function sectionFaces(
  oc: Oc,
  s: Scope,
  cut: TopoDS_Shape,
  plane: SectionPlane,
  frame: ViewFrame,
  deflection: number,
  point: gp_Pnt,
): SectionFace[] {
  const faces: SectionFace[] = [];
  const map = mapShapes(oc, s, cut, 'face');
  for (let i = 1; i <= map.Extent(); i++) {
    withScope(oc, (fs) => {
      const face: TopoDS_Face = fs.own(oc.TopoDS.Face(fs.own(map.FindKey(i))));
      const adaptor = fs.own(new oc.BRepAdaptor_Surface(face, true));
      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return;
      const pln = fs.own(adaptor.Plane());
      const axis = fs.own(pln.Axis());
      const d = toVec3(fs.own(axis.Direction()));
      const at = toVec3(fs.own(axis.Location()));
      if (1 - Math.abs(dot(d, plane.normal)) > ALIGNED) return;
      const offset = dot(
        [at[0] - plane.origin[0], at[1] - plane.origin[1], at[2] - plane.origin[2]],
        plane.normal,
      );
      if (Math.abs(offset) > ON_PLANE) return;
      // Every face on the plane is a section face: whatever lay on the other side was cut away.
      const props = fs.own(new oc.GProp_GProps());
      oc.BRepGProp.SurfaceProperties(face, props, false, false);
      const outerWire = fs.own(oc.BRepTools.OuterWire(face));
      const wires = fs.own(new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher());
      oc.TopExp.MapShapes(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, wires);
      let outer: Curve2[] = [];
      const holes: Curve2[][] = [];
      for (let w = 1; w <= wires.Extent(); w++) {
        const wire = fs.own(wires.FindKey(w));
        const curves: Curve2[] = [];
        eachCurve(oc, fs, wire, (curve) => {
          const c = readCurve(oc, curve, frame, deflection, point);
          if (c !== null) curves.push(c);
        });
        const loop = chain(curves);
        if (!outerWire.IsNull() && wire.IsSame(outerWire)) outer = loop;
        else holes.push(loop);
      }
      faces.push({ outer, holes, area: props.Mass() });
    });
  }
  return faces;
}

/** Order curves into one chain, end to end; lines and polylines are turned to follow it. */
function chain(curves: readonly Curve2[]): Curve2[] {
  if (curves.length <= 1) return [...curves];
  const left = [...curves];
  const out: Curve2[] = [left.shift()!];
  let at = endsOf(out[0]!)[1];
  while (left.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    let bestReversed = false;
    left.forEach((c, i) => {
      const [a, b] = endsOf(c);
      const da = Math.hypot(a[0] - at[0], a[1] - at[1]);
      const db = Math.hypot(b[0] - at[0], b[1] - at[1]);
      if (da < bestDistance) [best, bestDistance, bestReversed] = [i, da, false];
      if (db < bestDistance) [best, bestDistance, bestReversed] = [i, db, true];
    });
    const [next] = left.splice(best, 1);
    const turned = bestReversed ? reversed(next!) : next!;
    out.push(turned);
    // An arc cannot be turned: when it runs against the chain, the chain goes on from its start.
    const [a, b] = endsOf(turned);
    at = bestReversed && (turned.kind === 'arc' || turned.kind === 'ellipseArc') ? a : b;
  }
  return out;
}

function reversed(c: Curve2): Curve2 {
  if (c.kind === 'line') return { kind: 'line', a: c.b, b: c.a };
  if (c.kind === 'polyline') return { kind: 'polyline', points: [...c.points].reverse() };
  return c;
}

/** The start and end points of a curve, in its own direction. */
export function endsOf(c: Curve2): [Vec2, Vec2] {
  switch (c.kind) {
    case 'line':
      return [c.a, c.b];
    case 'polyline':
      return [c.points[0]!, c.points.at(-1)!];
    case 'arc':
      return [arcPoint(c, c.start), arcPoint(c, c.end)];
    case 'ellipseArc':
      return [ellipsePoint(c, c.start), ellipsePoint(c, c.end)];
  }
}

function arcPoint(c: Extract<Curve2, { kind: 'arc' }>, t: number): Vec2 {
  return [c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)];
}

function ellipsePoint(c: Extract<Curve2, { kind: 'ellipseArc' }>, t: number): Vec2 {
  const u = c.major * Math.cos(t);
  const v = c.minor * Math.sin(t);
  const cr = Math.cos(c.rotation);
  const sr = Math.sin(c.rotation);
  return [c.center[0] + u * cr - v * sr, c.center[1] + u * sr + v * cr];
}

// Reading curves ------------------------------------------------------------------------------

/** Call `fn` with an adaptor on every non-degenerated edge of `shape`, each in its own scope. */
function eachCurve(
  oc: Oc,
  s: Scope,
  shape: TopoDS_Shape,
  fn: (curve: BRepAdaptor_Curve) => void,
): void {
  const map = mapShapes(oc, s, shape, 'edge');
  for (let i = 1; i <= map.Extent(); i++) {
    withScope(oc, (es) => {
      const edge = es.own(oc.TopoDS.Edge(es.own(map.FindKey(i))));
      if (oc.BRep_Tool.Degenerated(edge)) return;
      fn(es.own(new oc.BRepAdaptor_Curve(edge)));
    });
  }
}

/** The curve's point at `u`, through the one reused `gp_Pnt`. */
function at(curve: BRepAdaptor_Curve, u: number, p: gp_Pnt): Vec3 {
  curve.D0(u, p);
  return [p.X(), p.Y(), p.Z()];
}

/** Angle in [0, 2 pi). */
function angle0(t: number): number {
  const a = t % TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Angle in (-pi, pi]. */
function anglePi(t: number): number {
  const a = angle0(t);
  return a > Math.PI ? a - TWO_PI : a;
}

/**
 * One edge as a 2D curve in `frame`, or null when it has no length. Conics whose plane faces the
 * viewer are exact records; the rest is sampled within `deflection`.
 */
function readCurve(
  oc: Oc,
  curve: BRepAdaptor_Curve,
  frame: ViewFrame,
  deflection: number,
  p: gp_Pnt,
): Curve2 | null {
  const T = oc.GeomAbs_CurveType;
  const type = curve.GetType();
  const f = curve.FirstParameter();
  const l = curve.LastParameter();
  if (type === T.GeomAbs_Line) {
    const a = projectPoint(frame, at(curve, f, p));
    const b = projectPoint(frame, at(curve, l, p));
    return a[0] === b[0] && a[1] === b[1] ? null : { kind: 'line', a, b };
  }
  if (type === T.GeomAbs_Circle || type === T.GeomAbs_Ellipse) {
    const conic = withScope(oc, (cs) => {
      const circle = type === T.GeomAbs_Circle;
      const g = cs.own(circle ? curve.Circle() : curve.Ellipse());
      const pos = cs.own(g.Position());
      const axis = toVec3(cs.own(pos.Direction()));
      const facing = dot(axis, frame.z);
      if (1 - Math.abs(facing) > ALIGNED) return null;
      const xd = toVec3(cs.own(pos.XDirection()));
      const center = projectPoint(frame, toVec3(cs.own(pos.Location())));
      const rotation = Math.atan2(dot(xd, frame.y), dot(xd, frame.x));
      // Seen from behind (axis away from the viewer) the curve runs clockwise on paper: its
      // parameter range [f, l] is [-l, -f] counter-clockwise.
      const [t0, t1] = facing > 0 ? [f, l] : [-l, -f];
      const sweep = t1 - t0;
      if (circle) {
        const start = angle0(rotation + t0);
        const radius = (g as { Radius(): number }).Radius();
        return { kind: 'arc', center, radius, start, end: start + sweep } as Curve2;
      }
      const e = g as { MajorRadius(): number; MinorRadius(): number };
      const start = angle0(t0);
      return {
        kind: 'ellipseArc',
        center,
        major: e.MajorRadius(),
        minor: e.MinorRadius(),
        rotation: anglePi(rotation),
        start,
        end: start + sweep,
      } as Curve2;
    });
    if (conic !== null) return conic;
  }
  // Anything else (in practice B-splines and Beziers) or a conic seen at an angle.
  const points3 = adaptive(curve, f, l, deflection, p);
  const points = points3.map((q) => projectPoint(frame, q));
  const a = points[0]!;
  const b = points.at(-1)!;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const straight =
    length > 0 && points.every((q) => distToSegment(q, a, b) <= STRAIGHT * Math.max(1, length));
  if (straight) return { kind: 'line', a, b };
  if (points.every((q) => q[0] === a[0] && q[1] === a[1])) return null;
  return { kind: 'polyline', points };
}

/** Points along the curve within `deflection`: parameter steps halved until every midpoint is close. */
function adaptive(
  curve: BRepAdaptor_Curve,
  f: number,
  l: number,
  deflection: number,
  p: gp_Pnt,
): Vec3[] {
  let n = 9;
  for (;;) {
    const count = 2 * n - 1;
    const pts: Vec3[] = [];
    for (let i = 0; i < count; i++) pts.push(at(curve, f + ((l - f) * i) / (count - 1), p));
    let worst = 0;
    for (let i = 1; i < pts.length - 1; i += 2) {
      worst = Math.max(worst, distToSegment3(pts[i]!, pts[i - 1]!, pts[i + 1]!));
    }
    if (worst <= deflection || n > 4096) {
      // The odd points were only there to measure: keep them, they are within the deflection too.
      return pts;
    }
    n = count;
  }
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return distToSegment3([p[0], p[1], 0], [a[0], a[1], 0], [b[0], b[1], 0]);
}

function distToSegment3(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(ap, ab) / len2));
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}

// Bounds ------------------------------------------------------------------------------------

/** Whether angle `t` falls in [start, end] (an arc's range, `end > start`). */
function within(t: number, start: number, end: number): boolean {
  let u = t;
  while (u < start) u += TWO_PI;
  while (u - TWO_PI >= start) u -= TWO_PI;
  return u <= end;
}

/** The exact 2D box of `curves`, or null when there are none. */
export function boundsOf(curves: readonly Curve2[]): Bounds2 | null {
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  const add = (q: Vec2) => {
    for (let i = 0; i < 2; i++) {
      min[i] = Math.min(min[i]!, q[i]!);
      max[i] = Math.max(max[i]!, q[i]!);
    }
  };
  for (const c of curves) {
    for (const q of endsOf(c)) add(q);
    if (c.kind === 'polyline') c.points.forEach(add);
    else if (c.kind === 'arc') {
      for (let k = 0; k < 4; k++) {
        const t = (k * Math.PI) / 2;
        if (within(t, c.start, c.end)) add(arcPoint(c, t));
      }
    } else if (c.kind === 'ellipseArc') {
      const cr = Math.cos(c.rotation);
      const sr = Math.sin(c.rotation);
      // Where dx/dt = 0 and dy/dt = 0, each twice a turn.
      const tx = Math.atan2(-c.minor * sr, c.major * cr);
      const ty = Math.atan2(c.minor * cr, c.major * sr);
      for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) {
        if (within(t, c.start, c.end)) add(ellipsePoint(c, t));
      }
    }
  }
  return min[0] === Infinity ? null : { min: [min[0]!, min[1]!], max: [max[0]!, max[1]!] };
}
