// HLR over libcascade 3.0.2: the prototype of the kernel's `project` op (T4.4b).
//
// - `projectExact`: HLRBRep_Algo + HLRBRep_HLRToShape. Each result edge is read through
//   BRepAdaptor_Curve and turned into a line, circular arc, elliptical arc or polyline in view
//   coordinates (model millimetres; x right, y up on paper).
// - `projectPoly`: HLRBRep_PolyAlgo + HLRBRep_PolyHLRToShape on a triangulation made here.
// - Classes: `sharp` (HLRBRep_Sharp), `smooth` (Rg1Line: tangent-continuous edges, fillet
//   boundaries), `sewn` (RgNLine: edges of higher continuity, in practice the seams of closed
//   faces) and `outline` (OutLine: silhouettes, which are not model edges), each visible or hidden.
// - With `source: true`, the same classes are also read in 3D (`CompoundOfEdges(..., In3d)`) and
//   each 2D edge gets the 3D pieces whose projection it is (matched by geometry: the two readings
//   are not one to one). `source.ts` matches those pieces to model edges.
//
// Memory: every object is owned by the kernel's Scope (release before delete, T0.2). The HLR
// classes' own rules are in `releaseHlr` (see memory.test.ts for what each one buys).

import type { Kernel } from '../../../packages/kernel/src/kernel';
import { mapShapes, Scope, type Oc } from '../../../packages/kernel/src/occt';
import type { ShapeId } from '../../../packages/kernel/src/types';
import { distToPolys } from './compare';

// libcascade's types, through the kernel (the spike has no dependency of its own on libcascade).
type TopoDS_Shape = InstanceType<Oc['TopoDS_Shape']>;
import { frameOf, project, type Vec2, type Vec3, type View, type ViewFrame } from './views';

export type EdgeClass = 'sharp' | 'smooth' | 'sewn' | 'outline';
export const EDGE_CLASSES: readonly EdgeClass[] = ['sharp', 'smooth', 'sewn', 'outline'];

/** 2D geometry in view coordinates. Arcs and elliptical arcs run counter-clockwise from start to end. */
export type Curve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; center: Vec2; radius: number; start: number; end: number }
  | {
      kind: 'ellipseArc';
      center: Vec2;
      major: number;
      minor: number;
      /** Angle of the major axis from view x. */
      rotation: number;
      /** Eccentric-anomaly parameters. */
      start: number;
      end: number;
    }
  | { kind: 'polyline'; points: Vec2[] };

export interface ProjectedEdge {
  cls: EdgeClass;
  visible: boolean;
  curve: Curve2;
  /** OCCT's curve type of the 2D result edge (GeomAbs_*, without the prefix). */
  occtType: string;
  /** Points along the curve (for comparisons and picking), within the deflection. */
  points: Vec2[];
  /** Index of the shape in the input list, when the result was read per shape. */
  item?: number;
  /** With `source`: the 3D pieces of model geometry this edge is the image of, as points. */
  source3d?: Vec3[][];
}

export interface ProjectOptions {
  algorithm?: 'exact' | 'poly';
  /** Read the classes per input shape (`CompoundOfEdges(S, ...)`) and tag edges with `item`. */
  perItem?: boolean;
  /** Also read every class in 3D and attach `source3d`. */
  source?: boolean;
  /** Chord deflection for polylines and sample points, mm (default 0.05). */
  deflection?: number;
  /** Poly algorithm: mesh deflection, mm (default 0.1), and angular deflection (default 0.5). */
  meshDeflection?: number;
  classes?: readonly EdgeClass[];
  /** Spike only: skip the release rules (`releaseHlr`, `BRepTools.Clean`) to measure what they buy. */
  release?: boolean;
}

export interface ProjectResult {
  edges: ProjectedEdge[];
  ms: { hide: number; extract: number; total: number };
}

/** The OCCT shape behind a kernel shape id (the arena is private; this is a spike). */
export function shapeOf(k: Kernel, id: ShapeId): TopoDS_Shape {
  return (k as unknown as { get(id: ShapeId, op: string): TopoDS_Shape }).get(id, 'hlr');
}

const TYPE: Record<EdgeClass, string> = {
  sharp: 'HLRBRep_Sharp',
  smooth: 'HLRBRep_Rg1Line',
  sewn: 'HLRBRep_RgNLine',
  outline: 'HLRBRep_OutLine',
};

function ax2(oc: Oc, s: Scope, frame: ViewFrame) {
  const [ox, oy, oz] = frame.origin;
  return s.own(
    new oc.gp_Ax2(
      s.own(new oc.gp_Pnt(ox, oy, oz)),
      s.own(new oc.gp_Dir(frame.z[0], frame.z[1], frame.z[2])),
      s.own(new oc.gp_Dir(frame.x[0], frame.x[1], frame.x[2])),
    ),
  );
}

/**
 * Release what the HLR objects hold before delete. `Remove(i)` drops each loaded shape (its
 * outliner and the B-rep it references) and the algorithm's data structure.
 */
export function releaseHlr(algo: { NbShapes(): number; Remove(i: number): void }): void {
  for (let i = algo.NbShapes(); i >= 1; i--) algo.Remove(i);
}

/** Exact HLR of `shapes` (already placed) in `view`. */
export function projectExact(
  oc: Oc,
  shapes: readonly TopoDS_Shape[],
  view: View,
  options: ProjectOptions = {},
): ProjectResult {
  const s = new Scope(oc);
  const t0 = performance.now();
  const algo = new oc.HLRBRep_Algo();
  try {
    for (const shape of shapes) algo.Add(shape, 0);
    const projector = s.own(new oc.HLRAlgo_Projector(ax2(oc, s, frameOf(view))));
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    const t1 = performance.now();
    const toShape = s.own(new oc.HLRBRep_HLRToShape(algo));
    const edges: ProjectedEdge[] = [];
    const pieces: { visible: boolean; item: number; points: Vec3[] }[] = [];
    const classes = options.classes ?? EDGE_CLASSES;
    const deflection = options.deflection ?? 0.05;
    const items = options.perItem ? shapes.map((sh, i) => [sh, i] as const) : [[null, -1] as const];
    for (const [shape, item] of items) {
      for (const cls of classes) {
        for (const visible of [true, false]) {
          const type = (oc.HLRBRep_TypeOfResultingEdge as Record<string, unknown>)[TYPE[cls]];
          const read = (in3d: boolean): TopoDS_Shape =>
            s.own(
              shape === null
                ? toShape.CompoundOfEdges(type as never, visible, in3d)
                : toShape.CompoundOfEdges(shape, type as never, visible, in3d),
            );
          for (const e of readEdges(oc, s, read(false), deflection)) {
            const edge: ProjectedEdge = { cls, visible, ...e };
            if (item >= 0) edge.item = item;
            edges.push(edge);
          }
          if (options.source) {
            for (const points of readPieces(oc, s, read(true), deflection)) {
              pieces.push({ visible, item, points });
            }
          }
        }
      }
    }
    if (options.source) {
      // The 3D reading is not one to one with the 2D one: where edges coincide in the view, the
      // 2D reading keeps one (a seam on a silhouette comes out once, as sharp) and the 3D reading
      // both. So pieces are matched by geometry: a piece belongs to a 2D edge when its projection
      // lies on the edge, or the edge on its projection.
      const frame = frameOf(view);
      const tol = 2 * deflection + 1e-6;
      const flat = pieces.map((p) => ({ ...p, at: p.points.map((q) => project(frame, q).at) }));
      for (const e of edges) {
        e.source3d = flat
          .filter(
            (p) =>
              p.visible === e.visible &&
              p.item === (e.item ?? -1) &&
              (p.at.every((q) => distToPolys(q, [e.points]) <= tol) ||
                e.points.every((q) => distToPolys(q, [p.at]) <= tol)),
          )
          .map((p) => p.points);
      }
    }
    const t2 = performance.now();
    return { edges, ms: { hide: t1 - t0, extract: t2 - t1, total: t2 - t0 } };
  } finally {
    try {
      if (options.release !== false) releaseHlr(algo);
    } finally {
      algo.delete();
      s.dispose();
    }
  }
}

/** Mesh-based HLR. Meshes the shapes at `meshDeflection` and cleans the triangulation afterwards. */
export function projectPoly(
  oc: Oc,
  shapes: readonly TopoDS_Shape[],
  view: View,
  options: ProjectOptions = {},
): ProjectResult {
  const s = new Scope(oc);
  const t0 = performance.now();
  const compound = s.own(new oc.TopoDS_Compound());
  const builder = s.own(new oc.BRep_Builder());
  builder.MakeCompound(compound);
  for (const shape of shapes) builder.Add(compound, shape);
  const linear = options.meshDeflection ?? 0.1;
  s.own(new oc.BRepMesh_IncrementalMesh(compound, linear, false, 0.5, false));
  const algo = new oc.HLRBRep_PolyAlgo(compound);
  try {
    const projector = s.own(new oc.HLRAlgo_Projector(ax2(oc, s, frameOf(view))));
    algo.Projector(projector);
    algo.Update();
    const toShape = s.own(new oc.HLRBRep_PolyHLRToShape());
    toShape.Update(algo);
    const t1 = performance.now();
    const edges: ProjectedEdge[] = [];
    const method: Record<EdgeClass, [string, string]> = {
      sharp: ['VCompound', 'HCompound'],
      smooth: ['Rg1LineVCompound', 'Rg1LineHCompound'],
      sewn: ['RgNLineVCompound', 'RgNLineHCompound'],
      outline: ['OutLineVCompound', 'OutLineHCompound'],
    };
    for (const cls of options.classes ?? EDGE_CLASSES) {
      for (const visible of [true, false]) {
        const name = method[cls][visible ? 0 : 1];
        const flat = s.own((toShape as unknown as Record<string, () => TopoDS_Shape>)[name]!());
        for (const e of readEdges(oc, s, flat, options.deflection ?? 0.05)) {
          edges.push({ cls, visible, ...e });
        }
      }
    }
    const t2 = performance.now();
    return { edges, ms: { hide: t1 - t0, extract: t2 - t1, total: t2 - t0 } };
  } finally {
    try {
      if (options.release !== false) {
        releaseHlr(algo);
        oc.BRepTools.Clean(compound, true);
      }
    } finally {
      algo.delete();
      s.dispose();
    }
  }
}

type Read = Omit<ProjectedEdge, 'cls' | 'visible' | 'item'>;

function eachEdge(
  oc: Oc,
  s: Scope,
  compound: TopoDS_Shape,
  fn: (curve: InstanceType<Oc['BRepAdaptor_Curve']>, inner: Scope) => void,
) {
  if (compound.IsNull()) return;
  const map = mapShapes(oc, s, compound, 'edge');
  for (let i = 1; i <= map.Extent(); i++) {
    const inner = new Scope(oc);
    try {
      const edge = inner.own(oc.TopoDS.Edge(inner.own(map.FindKey(i))));
      if (oc.BRep_Tool.Degenerated(edge)) continue;
      fn(inner.own(new oc.BRepAdaptor_Curve(edge)), inner);
    } finally {
      inner.dispose();
    }
  }
}

/**
 * Sample a curve uniformly in parameter. One gp_Pnt is reused through `D0`: gp_Pnt's delete()
 * frees nothing (empty destructor), so a `Value(u)` per point would leak one object per point.
 */
function sample(
  oc: Oc,
  curve: InstanceType<Oc['BRepAdaptor_Curve']>,
  s: Scope,
  count: number,
): Vec3[] {
  const f = curve.FirstParameter();
  const l = curve.LastParameter();
  const out: Vec3[] = [];
  const p = s.own(new oc.gp_Pnt(0, 0, 0));
  for (let i = 0; i < count; i++) {
    curve.D0(f + ((l - f) * i) / (count - 1), p);
    out.push([p.X(), p.Y(), p.Z()]);
  }
  return out;
}

/** Points along a curve within `deflection`: halve parameter steps until every midpoint is close. */
function adaptive(
  oc: Oc,
  curve: InstanceType<Oc['BRepAdaptor_Curve']>,
  s: Scope,
  deflection: number,
): Vec3[] {
  let n = 9;
  for (;;) {
    const pts = sample(oc, curve, s, 2 * n - 1);
    let worst = 0;
    for (let i = 1; i < pts.length - 1; i += 2) {
      worst = Math.max(worst, distToSegment3(pts[i]!, pts[i - 1]!, pts[i + 1]!));
    }
    if (worst <= deflection || n > 4096) return pts;
    n = 2 * n - 1;
  }
}

function distToSegment3(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, (ap[0]! * ab[0]! + ap[1]! * ab[1]! + ap[2]! * ab[2]!) / len2));
  return Math.hypot(ap[0]! - t * ab[0]!, ap[1]! - t * ab[1]!, ap[2]! - t * ab[2]!);
}

const flat2 = (p: Vec3): Vec2 => [p[0], p[1]];

function readEdges(oc: Oc, s: Scope, compound: TopoDS_Shape, deflection: number): Read[] {
  const out: Read[] = [];
  const T = oc.GeomAbs_CurveType;
  eachEdge(oc, s, compound, (curve, inner) => {
    const type = curve.GetType();
    const occtType = String(type).replace('GeomAbs_', '');
    if (type === T.GeomAbs_Line) {
      const [a, b] = sample(oc, curve, inner, 2);
      out.push({
        occtType,
        curve: { kind: 'line', a: flat2(a!), b: flat2(b!) },
        points: [flat2(a!), flat2(b!)],
      });
      return;
    }
    if (type === T.GeomAbs_Circle || type === T.GeomAbs_Ellipse) {
      const circle = type === T.GeomAbs_Circle;
      const g = inner.own(circle ? curve.Circle() : curve.Ellipse());
      const pos = inner.own(g.Position());
      const c = inner.own(pos.Location());
      const xd = inner.own(pos.XDirection());
      const zd = inner.own(pos.Direction());
      const sign = zd.Z() >= 0 ? 1 : -1;
      const f = curve.FirstParameter();
      const l = curve.LastParameter();
      const rotation = Math.atan2(xd.Y(), xd.X());
      const [start, end] = sign > 0 ? [f, l] : [-l, -f];
      const center: Vec2 = [c.X(), c.Y()];
      const points = adaptive(oc, curve, inner, deflection).map(flat2);
      if (circle) {
        const r = (g as InstanceType<Oc['gp_Circ']>).Radius();
        out.push({
          occtType,
          curve: { kind: 'arc', center, radius: r, start: rotation + start, end: rotation + end },
          points,
        });
      } else {
        const e = g as InstanceType<Oc['gp_Elips']>;
        out.push({
          occtType,
          curve: {
            kind: 'ellipseArc',
            center,
            major: e.MajorRadius(),
            minor: e.MinorRadius(),
            rotation,
            start,
            end,
          },
          points,
        });
      }
      return;
    }
    // Anything else (in practice B-splines: a circle seen edge on comes back as one). A straight
    // one becomes a line, the rest a polyline.
    const pts3 = adaptive(oc, curve, inner, deflection);
    const a = pts3[0]!;
    const b = pts3.at(-1)!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const straight =
      len > 0 && pts3.every((p) => distToSegment3(p, a, b) <= 1e-6 * Math.max(1, len));
    const points = pts3.map(flat2);
    out.push({
      occtType,
      curve: straight ? { kind: 'line', a: flat2(a), b: flat2(b) } : { kind: 'polyline', points },
      points: straight ? [flat2(a), flat2(b)] : points,
    });
  });
  return out;
}

function readPieces(oc: Oc, s: Scope, compound: TopoDS_Shape, deflection: number): Vec3[][] {
  const out: Vec3[][] = [];
  eachEdge(oc, s, compound, (curve, inner) => {
    const isLine = curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    out.push(isLine ? sample(oc, curve, inner, 3) : adaptive(oc, curve, inner, deflection));
  });
  return out;
}

/** Summary counts of a result: per class and visibility, and per OCCT curve type. */
export function summarize(edges: readonly ProjectedEdge[]) {
  const byClass: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const e of edges) {
    const key = `${e.visible ? 'visible' : 'hidden'}.${e.cls}`;
    byClass[key] = (byClass[key] ?? 0) + 1;
    byType[e.occtType] = (byType[e.occtType] ?? 0) + 1;
    byKind[e.curve.kind] = (byKind[e.curve.kind] ?? 0) + 1;
  }
  return { edges: edges.length, byClass, byType, byKind };
}
