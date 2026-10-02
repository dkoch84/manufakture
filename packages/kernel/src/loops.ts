// Planar loops for CAM (M5 plan, T5.1e): the outline of a planar face, and the section of a body
// by a plane, as exact lines and arcs in a frame's 2D coordinates.
//
// - `faceLoops`: a face by name (the naming layer's) or by 1-based index, as `measure` finds its
//   targets. The wires are read in order with `BRepTools.OuterWire` and `BRepTools_WireExplorer`
//   (which follows the edges of a wire end to end on the face), and each segment is tagged with
//   its edge: index, and name on a named body, so a toolpath can say which edge it follows.
// - `sectionLoops`: `BRepAlgoAPI_Section` of the body and the frame's plane at a height. Its
//   edges come back unordered, so they are chained end to end here and nested into regions (an
//   outer loop and its holes) by containment. Each segment is tagged with the body face it lies on
//   when OCCT can say (`HasAncestorFaceOn1`).
//
// Segments: a `line`, an `arc` (BRepAdaptor_Curve types line and circle, the circle in a plane
// parallel to the frame), or a `polyline` for anything else, flattened within the deflection with
// `GCPnts_TangentialDeflection`. Every loop is closed and chained (each segment starts where the
// one before ends); outer loops run counter-clockwise about the frame normal and holes clockwise,
// whatever the orientation of the face, since the direction is fixed from the loop's signed area.
//
// Memory: shapes are owned by scopes and nullified before delete (`releaseOwned`); the section
// algorithm is cleared with empty argument and tool lists, the wire explorer is cleared. Points are
// read with `D0` into one reused `gp_Pnt`, since `gp_Pnt`'s destructor is empty.

import type {
  BRepAdaptor_Curve,
  GCPnts_TangentialDeflection,
  gp_Pnt,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
} from 'libcascade/single/init';
import { KernelError } from './errors';
import type { NamedShape } from './kernel';
import { locate } from './measure';
import { isUnnamed } from './naming';
import { cross, dot, mapShapes, norm, toVec3, withScope, type Oc, type Scope } from './occt';
import type { Frame, Vec2, Vec3 } from './types';

/** The default chord deflection of flattened curves, mm. */
export const DEFAULT_LOOP_DEFLECTION = 0.01;

/** A face by the naming layer's name (on a named body) or by 1-based index. */
export type FaceLoopsTarget = { name: string } | { index: number };

/** The edge or face a segment comes from: its 1-based index on the body, and its name if any. */
export interface LoopSource {
  index: number;
  name: string | null;
}

/**
 * One piece of a loop, in frame coordinates (mm). An `arc` turns about `center` by `sweep`
 * radians from `start` to `end`: positive counter-clockwise about the frame normal, negative
 * clockwise; a whole circle has `|sweep| = 2 pi` and `start` equal to `end`.
 *
 * `edge` is set by `faceLoops` (the face's edge the segment follows); `face` by `section` (the
 * body face the section edge lies on, when OCCT knows it).
 */
export type LoopSegment = { edge?: LoopSource; face?: LoopSource } & (
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; start: Vec2; end: Vec2; center: Vec2; radius: number; sweep: number }
  | { kind: 'polyline'; points: Vec2[] }
);

/** A closed chain of segments. `area` is signed: positive when it runs counter-clockwise. */
export interface Loop {
  segments: LoopSegment[];
  area: number;
}

/** An outer loop (counter-clockwise) and the holes in it (clockwise). */
export interface LoopRegion {
  outer: Loop;
  holes: Loop[];
}

export type FaceLoopsReport =
  | {
      ok: true;
      face: LoopSource;
      /** The face's plane along the frame normal: dot(point on plane - frame origin, normal). */
      height: number;
      /** Whether the face's outward normal points along the frame normal (false: against it). */
      facing: boolean;
      outer: Loop;
      holes: Loop[];
    }
  | {
      ok: false;
      status: 'not-found' | 'ambiguous' | 'not-planar' | 'not-parallel';
      message: string;
    };

export interface SectionLoops {
  /** The cutting plane along the frame normal, as given. */
  height: number;
  /** Closed loops nested into regions: an island in a hole is a region of its own. */
  regions: LoopRegion[];
  /** Chains that do not close (only for shapes that are not closed solids); empty for a solid. */
  open: LoopSegment[][];
}

/** A frame made unit and right-handed: x and y in the plane, n its normal. */
interface Axes {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  n: Vec3;
}

/** Directions within this (1 - |cos|) of each other are parallel. */
const PARALLEL = 1e-9;
/** End points closer than this (mm) are the same point when chaining section edges. */
const JOIN = 1e-4;
/** Angular deflection of flattened curves, radians; the chord deflection is the caller's. */
const ANGULAR = 0.2;
const TWO_PI = 2 * Math.PI;

function invalid(operation: string, message: string): KernelError {
  return new KernelError(operation, message, { code: 'invalid-argument' });
}

const finiteVec = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

const unit = (v: Vec3): Vec3 => {
  const l = norm(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The frame's unit axes; `invalid-argument` for a degenerate frame. */
export function frameAxes(operation: string, frame: Frame): Axes {
  if (!finiteVec(frame?.origin)) throw invalid(operation, 'frame.origin must be three numbers');
  if (!finiteVec(frame.xDir)) throw invalid(operation, 'frame.xDir must be three numbers');
  if (!finiteVec(frame.normal)) throw invalid(operation, 'frame.normal must be three numbers');
  if (!(norm(frame.normal) > 1e-12)) throw invalid(operation, 'frame.normal is a zero vector');
  const n = unit(frame.normal);
  const along = dot(frame.xDir, n);
  const inPlane: Vec3 = [
    frame.xDir[0] - along * n[0],
    frame.xDir[1] - along * n[1],
    frame.xDir[2] - along * n[2],
  ];
  if (!(norm(inPlane) > 1e-9 * Math.max(1, norm(frame.xDir)))) {
    throw invalid(operation, 'frame.xDir must not be parallel to frame.normal');
  }
  const x = unit(inPlane);
  return { origin: frame.origin, x, y: cross(n, x), n };
}

function checkDeflection(operation: string, deflection: number): void {
  if (typeof deflection !== 'number' || !Number.isFinite(deflection) || !(deflection > 0)) {
    throw invalid(operation, 'deflection must be a positive finite number');
  }
}

const to2 = (a: Axes, p: Vec3): Vec2 => {
  const d: Vec3 = [p[0] - a.origin[0], p[1] - a.origin[1], p[2] - a.origin[2]];
  return [dot(d, a.x), dot(d, a.y)];
};

const heightOf = (a: Axes, p: Vec3): number =>
  dot([p[0] - a.origin[0], p[1] - a.origin[1], p[2] - a.origin[2]], a.n);

// Face loops ----------------------------------------------------------------------------------

/** The loops of one planar face of `shape` (names, if any, in `named`). Owned by `s`. */
export function faceLoopsOf(
  oc: Oc,
  s: Scope,
  shape: TopoDS_Shape,
  named: NamedShape | null,
  target: FaceLoopsTarget,
  frame: Frame,
  deflection: number,
): FaceLoopsReport {
  const op = 'faceLoops';
  const axes = frameAxes(op, frame);
  checkDeflection(op, deflection);
  const faces = mapShapes(oc, s, shape, 'face');
  const located = locate(faces.Extent(), named, { kind: 'face', ...target });
  if (!located.ok) return { ok: false, ...located.failure };
  const source: LoopSource = { index: located.index, name: faceName(named, located.index) };
  const label = source.name ?? `face ${source.index}`;
  const face: TopoDS_Face = s.own(oc.TopoDS.Face(s.own(faces.FindKey(located.index))));

  const surface = s.own(new oc.BRepAdaptor_Surface(face, true));
  if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
    return { ok: false, status: 'not-planar', message: `${label} is not planar` };
  }
  const plane = s.own(surface.Plane());
  const axis = s.own(plane.Axis());
  const d = toVec3(s.own(axis.Direction()));
  const cos = dot(d, axes.n);
  if (1 - Math.abs(cos) > PARALLEL) {
    return {
      ok: false,
      status: 'not-parallel',
      message: `${label} is not parallel to the frame's plane`,
    };
  }
  // As in measure.ts: the plane's axis, flipped for a left-handed frame and again for a reversed
  // face, is the outward normal.
  const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  const outward = (reversed ? -1 : 1) * (plane.Direct() ? 1 : -1) * cos;
  const height = heightOf(axes, toVec3(s.own(axis.Location())));

  const edges = mapShapes(oc, s, shape, 'edge');
  const point = s.own(new oc.gp_Pnt(0, 0, 0));
  const flat = new Flattener(oc, s);
  const outerWire = s.own(oc.BRepTools.OuterWire(face));
  const wires = s.own(new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher());
  oc.TopExp.MapShapes(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, wires);
  let outer: Loop | null = null;
  const holes: Loop[] = [];
  for (let w = 1; w <= wires.Extent(); w++) {
    withScope(oc, (ws) => {
      const wire = ws.own(oc.TopoDS.Wire(ws.own(wires.FindKey(w))));
      const segments: LoopSegment[] = [];
      const explorer = ws.own(new oc.BRepTools_WireExplorer(wire, face));
      for (; explorer.More(); explorer.Next()) {
        withScope(oc, (es) => {
          const edge: TopoDS_Edge = es.own(explorer.Current());
          if (oc.BRep_Tool.Degenerated(edge)) return;
          const back = explorer.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
          const index = edges.FindIndex(edge);
          const segment = segmentOf(oc, es, edge, back, axes, deflection, point, flat);
          if (segment === null) return;
          segment.edge = { index, name: edgeName(named, index) };
          segments.push(segment);
        });
      }
      if (segments.length === 0) return;
      const isOuter = !outerWire.IsNull() && wire.IsSame(outerWire);
      const loop = closedLoop(segments);
      if (loop === null) {
        throw new KernelError(op, `a wire of ${label} does not close`);
      }
      if (isOuter) outer = oriented(loop, true);
      else holes.push(oriented(loop, false));
    });
  }
  if (outer === null) throw new KernelError(op, `${label} has no outer wire`);
  return { ok: true, face: source, height, facing: outward > 0, outer, holes };
}

function faceName(named: NamedShape | null, index: number): string | null {
  const name = named?.names.faces[index - 1]?.name;
  return name === undefined || isUnnamed(name) ? null : name;
}

function edgeName(named: NamedShape | null, index: number): string | null {
  const name = named?.names.edges[index - 1]?.name;
  return name === undefined || isUnnamed(name) ? null : name;
}

// Sections ------------------------------------------------------------------------------------

/** The section of `shape` by the frame's plane at `height` along its normal. Owned by `s`. */
export function sectionLoopsOf(
  oc: Oc,
  s: Scope,
  shape: TopoDS_Shape,
  named: NamedShape | null,
  frame: Frame,
  height: number,
  deflection: number,
): SectionLoops {
  const op = 'section';
  const axes = frameAxes(op, frame);
  checkDeflection(op, deflection);
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    throw invalid(op, 'height must be a finite number');
  }
  const o = axes.origin;
  const at: Vec3 = [
    o[0] + height * axes.n[0],
    o[1] + height * axes.n[1],
    o[2] + height * axes.n[2],
  ];
  const pln = s.own(
    new oc.gp_Pln(
      s.own(
        new oc.gp_Ax3(
          s.own(new oc.gp_Pnt(...at)),
          s.own(new oc.gp_Dir(...axes.n)),
          s.own(new oc.gp_Dir(...axes.x)),
        ),
      ),
    ),
  );
  // Released before delete by `releaseOwned`: cleared, with empty argument and tool lists.
  const algo = s.own(new oc.BRepAlgoAPI_Section(shape, pln, false));
  algo.Approximation(true);
  algo.Build();
  if (!algo.IsDone() || algo.HasErrors()) throw new KernelError(op, 'the section failed');
  const result = s.own(algo.Shape());
  const faces = mapShapes(oc, s, shape, 'face');
  const edges = mapShapes(oc, s, result, 'edge');
  const point = s.own(new oc.gp_Pnt(0, 0, 0));
  const flat = new Flattener(oc, s);
  const segments: LoopSegment[] = [];
  for (let i = 1; i <= edges.Extent(); i++) {
    withScope(oc, (es) => {
      const edge: TopoDS_Edge = es.own(oc.TopoDS.Edge(es.own(edges.FindKey(i))));
      if (oc.BRep_Tool.Degenerated(edge)) return;
      const segment = segmentOf(oc, es, edge, false, axes, deflection, point, flat);
      if (segment === null) return;
      const ancestor = es.own(new oc.TopoDS_Shape());
      if (algo.HasAncestorFaceOn1(edge, ancestor)) {
        const index = faces.FindIndex(ancestor);
        if (index > 0) segment.face = { index, name: faceName(named, index) };
      }
      segments.push(segment);
    });
  }
  const { closed, open } = chainAll(segments);
  return { height, regions: nest(closed), open };
}

// Segments ------------------------------------------------------------------------------------

/**
 * One reused `GCPnts_TangentialDeflection`: re-initialised per curve, so its point sequences are
 * replaced rather than left in instances whose delete may free nothing.
 */
class Flattener {
  private algo: GCPnts_TangentialDeflection | null = null;
  constructor(
    private readonly oc: Oc,
    private readonly s: Scope,
  ) {}

  parameters(curve: BRepAdaptor_Curve, f: number, l: number, deflection: number): number[] {
    if (this.algo === null) this.algo = this.s.own(new this.oc.GCPnts_TangentialDeflection());
    this.algo.Initialize(curve, f, l, ANGULAR, deflection, 2, 1e-9, 1e-7);
    const out: number[] = [];
    for (let i = 1; i <= this.algo.NbPoints(); i++) out.push(this.algo.Parameter(i));
    return out;
  }
}

/** The curve's point at `u`, through the one reused `gp_Pnt`. */
function pointAt(curve: BRepAdaptor_Curve, u: number, p: gp_Pnt): Vec3 {
  curve.D0(u, p);
  return [p.X(), p.Y(), p.Z()];
}

/** One edge as a segment in frame coordinates, run backwards when `back`; null with no length. */
function segmentOf(
  oc: Oc,
  s: Scope,
  edge: TopoDS_Edge,
  back: boolean,
  axes: Axes,
  deflection: number,
  p: gp_Pnt,
  flat: Flattener,
): LoopSegment | null {
  const curve = s.own(new oc.BRepAdaptor_Curve(edge));
  const T = oc.GeomAbs_CurveType;
  const type = curve.GetType();
  const f = curve.FirstParameter();
  const l = curve.LastParameter();
  const a = to2(axes, pointAt(curve, f, p));
  const b = to2(axes, pointAt(curve, l, p));
  const [start, end] = back ? [b, a] : [a, b];
  if (type === T.GeomAbs_Line) {
    return start[0] === end[0] && start[1] === end[1] ? null : { kind: 'line', start, end };
  }
  if (type === T.GeomAbs_Circle) {
    const circle = s.own(curve.Circle());
    const position = s.own(circle.Position());
    const facing = dot(toVec3(s.own(position.Direction())), axes.n);
    if (1 - Math.abs(facing) <= PARALLEL) {
      // Increasing parameter turns counter-clockwise about the circle's axis.
      const sweep = (l - f) * (facing > 0 ? 1 : -1) * (back ? -1 : 1);
      return {
        kind: 'arc',
        start,
        end,
        center: to2(axes, toVec3(s.own(position.Location()))),
        radius: circle.Radius(),
        sweep,
      };
    }
  }
  const points = flat
    .parameters(curve, f, l, deflection)
    .map((u) => to2(axes, pointAt(curve, u, p)));
  if (back) points.reverse();
  if (points.length < 2) return null;
  // The ends exactly as the vertices give them, so the chain closes.
  points[0] = start;
  points[points.length - 1] = end;
  return { kind: 'polyline', points };
}

function startOf(c: LoopSegment): Vec2 {
  return c.kind === 'polyline' ? c.points[0]! : c.start;
}

function endOf(c: LoopSegment): Vec2 {
  return c.kind === 'polyline' ? c.points[c.points.length - 1]! : c.end;
}

function withStart(c: LoopSegment, q: Vec2): LoopSegment {
  if (c.kind === 'polyline') return { ...c, points: [q, ...c.points.slice(1)] };
  return { ...c, start: q };
}

function reversedSegment(c: LoopSegment): LoopSegment {
  if (c.kind === 'polyline') return { ...c, points: [...c.points].reverse() };
  if (c.kind === 'line') return { ...c, start: c.end, end: c.start };
  return { ...c, start: c.end, end: c.start, sweep: -c.sweep };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Twice the signed area under the chord a-b (shoelace term). */
const shoelace = (a: Vec2, b: Vec2) => a[0] * b[1] - b[0] * a[1];

function signedArea(segments: readonly LoopSegment[]): number {
  let twice = 0;
  for (const c of segments) {
    if (c.kind === 'polyline') {
      for (let i = 1; i < c.points.length; i++) twice += shoelace(c.points[i - 1]!, c.points[i]!);
    } else {
      twice += shoelace(c.start, c.end);
      // The circular segment between the chord and the arc, on the side the arc turns.
      if (c.kind === 'arc') twice += c.radius * c.radius * (c.sweep - Math.sin(c.sweep));
    }
  }
  return twice / 2;
}

/**
 * The segments as one closed loop: in the order given when they already chain (the wire
 * explorer's order), else chained end to end. Each segment then starts exactly where the one
 * before ends. Null when they do not close.
 */
function closedLoop(segments: readonly LoopSegment[]): Loop | null {
  const chained = segments.every((c, i) => {
    const next = segments[(i + 1) % segments.length]!;
    return dist(endOf(c), startOf(next)) <= JOIN;
  });
  let ordered: LoopSegment[];
  if (chained) {
    ordered = [...segments];
  } else {
    const { closed } = chainAll(segments);
    if (closed.length !== 1) return null;
    ordered = closed[0]!;
  }
  const snapped = ordered.map((c, i) => (i === 0 ? c : withStart(c, endOf(ordered[i - 1]!))));
  snapped[0] = withStart(snapped[0]!, endOf(snapped[snapped.length - 1]!));
  return { segments: snapped, area: signedArea(snapped) };
}

/** The loop turned to run counter-clockwise (`ccw`) or clockwise. */
function oriented(loop: Loop, ccw: boolean): Loop {
  if (loop.area > 0 === ccw || loop.area === 0) return loop;
  const segments = [...loop.segments].reverse().map(reversedSegment);
  return { segments, area: -loop.area };
}

/**
 * Chain unordered segments end to end: closed loops (each snapped shut) and open chains. A
 * segment that closes on itself (a whole circle) is a loop of its own.
 */
function chainAll(segments: readonly LoopSegment[]): {
  closed: LoopSegment[][];
  open: LoopSegment[][];
} {
  const left = [...segments];
  const closed: LoopSegment[][] = [];
  const open: LoopSegment[][] = [];
  while (left.length > 0) {
    const chain = [left.shift()!];
    // Grow at the end, then at the start, until the chain closes or nothing joins it.
    for (const atEnd of [true, false]) {
      for (;;) {
        const head = startOf(chain[0]!);
        const tail = endOf(chain[chain.length - 1]!);
        if (dist(head, tail) <= JOIN && (chain.length > 1 || selfClosed(chain[0]!))) break;
        const at = atEnd ? tail : head;
        let best = -1;
        let bestDistance = JOIN;
        let flip = false;
        left.forEach((c, i) => {
          const ds = dist(startOf(c), at);
          const de = dist(endOf(c), at);
          // At the end the next segment should start at `at`; at the start, end there.
          const [same, other] = atEnd ? [ds, de] : [de, ds];
          if (same <= bestDistance) [best, bestDistance, flip] = [i, same, false];
          if (other < bestDistance) [best, bestDistance, flip] = [i, other, true];
        });
        if (best < 0) break;
        const [next] = left.splice(best, 1);
        const turned = flip ? reversedSegment(next!) : next!;
        if (atEnd) chain.push(turned);
        else chain.unshift(turned);
      }
    }
    const shut = dist(startOf(chain[0]!), endOf(chain[chain.length - 1]!)) <= JOIN;
    (shut ? closed : open).push(chain);
  }
  return { closed, open };
}

function selfClosed(c: LoopSegment): boolean {
  return c.kind === 'arc'
    ? Math.abs(c.sweep) > Math.PI
    : c.kind === 'polyline' && c.points.length > 2;
}

/** Points along a loop (arcs sampled), for containment tests. */
function polygonOf(segments: readonly LoopSegment[]): Vec2[] {
  const out: Vec2[] = [];
  for (const c of segments) {
    if (c.kind === 'line') out.push(c.start);
    else if (c.kind === 'polyline') out.push(...c.points.slice(0, -1));
    else {
      const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
      const n = Math.max(4, Math.ceil((Math.abs(c.sweep) / TWO_PI) * 64));
      for (let i = 0; i < n; i++) {
        const t = a0 + (c.sweep * i) / n;
        out.push([c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)]);
      }
    }
  }
  return out;
}

function inside(p: Vec2, polygon: readonly Vec2[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      hit = !hit;
    }
  }
  return hit;
}

/** A point of the loop away from its vertices: the middle of its first segment. */
function probeOf(segments: readonly LoopSegment[]): Vec2 {
  const c = segments[0]!;
  if (c.kind === 'line') return [(c.start[0] + c.end[0]) / 2, (c.start[1] + c.end[1]) / 2];
  if (c.kind === 'polyline') {
    const i = Math.floor(c.points.length / 2);
    const a = c.points[i - 1] ?? c.points[0]!;
    const b = c.points[i]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  const t = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]) + c.sweep / 2;
  return [c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)];
}

/**
 * Nest closed loops into regions by containment: a loop inside an even number of others is an
 * outer loop (counter-clockwise), inside an odd number a hole (clockwise) of the smallest loop
 * around it. Regions are sorted by their outer loop's lowest corner (y, then x).
 */
function nest(chains: readonly LoopSegment[][]): LoopRegion[] {
  const loops = chains.map((segments) => {
    const loop = closedLoop(segments)!;
    const polygon = polygonOf(loop.segments);
    return { loop, polygon, size: Math.abs(loop.area), probe: probeOf(loop.segments) };
  });
  const parent = loops.map((l, i) => {
    let best = -1;
    loops.forEach((m, j) => {
      if (j === i || m.size <= l.size) return;
      if (inside(l.probe, m.polygon) && (best < 0 || m.size < loops[best]!.size)) best = j;
    });
    return best;
  });
  const depth = (i: number): number => (parent[i]! < 0 ? 0 : 1 + depth(parent[i]!));
  const regions = new Map<number, LoopRegion>();
  loops.forEach((l, i) => {
    if (depth(i) % 2 === 0) regions.set(i, { outer: oriented(l.loop, true), holes: [] });
  });
  loops.forEach((l, i) => {
    if (depth(i) % 2 === 1) regions.get(parent[i]!)!.holes.push(oriented(l.loop, false));
  });
  const corner = (r: LoopRegion): Vec2 => {
    const pts = polygonOf(r.outer.segments);
    return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))];
  };
  return [...regions.values()].sort((r, q) => {
    const a = corner(r);
    const b = corner(q);
    return a[1] - b[1] || a[0] - b[0];
  });
}
