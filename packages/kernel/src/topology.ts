// The topology query (ADR 0007, decision 9; T0.5 recommendation 3). Goes
// through embind per sub-shape; ADR 0002 moves it into a C++ helper later.

import type {
  BRepAdaptor_Surface,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Vertex,
} from 'libcascade/single/init';
import {
  cross,
  dot,
  mapShapes,
  Scope,
  shapeEnum,
  toVec3,
  withScope,
  type Oc,
  type ShapeList,
} from './occt';
import type { EdgeInfo, FaceInfo, SubShapeKind, Topology, Vec3, VertexInfo } from './types';

export function topologyOf(oc: Oc, s: Scope, body: TopoDS_Shape): Topology {
  const faceMap = mapShapes(oc, s, body, 'face');
  const edgeMap = mapShapes(oc, s, body, 'edge');
  const vertexMap = mapShapes(oc, s, body, 'vertex');
  const ancestors = (kind: SubShapeKind) => {
    const m = s.own(
      new oc.NCollection_IndexedDataMap_TopoDS_Shape_NCollection_List_TopoDS_Shape_TopTools_ShapeMapHasher(),
    );
    oc.TopExp.MapShapesAndAncestors(body, shapeEnum(oc, kind), oc.TopAbs_ShapeEnum.TopAbs_FACE, m);
    return m;
  };
  const edgeFaces = ancestors('edge');
  const vertexFaces = ancestors('vertex');
  // `FindFromIndex` returns a copy of the ancestor list, which the caller
  // owns; it is drained here.
  const faceIndices = (ls: Scope, list: ShapeList): { unique: number[]; total: number } => {
    const out = new Set<number>();
    let total = 0;
    while (list.Size() > 0) {
      out.add(faceMap.FindIndex(ls.own(list.First())));
      total++;
      list.RemoveFirst();
    }
    return { unique: [...out].sort((p, q) => p - q), total };
  };

  const faces: FaceInfo[] = [];
  for (let i = 1; i <= faceMap.Extent(); i++) {
    withScope(oc, (fs) => {
      const face: TopoDS_Face = fs.own(oc.TopoDS.Face(fs.own(faceMap.FindKey(i))));
      const props = fs.own(new oc.GProp_GProps());
      oc.BRepGProp.SurfaceProperties(face, props, false, false);
      const adaptor = fs.own(new oc.BRepAdaptor_Surface(face, true));
      const type = adaptor.GetType();
      const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      let normal: Vec3 | null = null;
      let axis: Vec3 | null = null;
      let radius: number | null = null;
      let axisOrigin: Vec3 | null = null;
      let hole: boolean | null = null;
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        // The surface normal is XDirection ^ YDirection of the plane's frame:
        // the axis for a right-handed frame, its opposite for a left-handed
        // one (a mirrored plane). A reversed face flips it once more.
        const plane = fs.own(adaptor.Plane());
        const d = toVec3(fs.own(fs.own(plane.Axis()).Direction()));
        const sign = (reversed ? -1 : 1) * (plane.Direct() ? 1 : -1);
        normal = [sign * d[0], sign * d[1], sign * d[2]];
      } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
        const cyl = fs.own(adaptor.Cylinder());
        const ax1 = fs.own(cyl.Axis());
        axis = toVec3(fs.own(ax1.Direction()));
        axisOrigin = toVec3(fs.own(ax1.Location()));
        radius = cyl.Radius();
        hole = cylinderIsHole(fs, adaptor, axisOrigin, axis, cyl.Direct(), reversed);
      }
      faces.push({
        index: i,
        surface: type.replace('GeomAbs_', '').toLowerCase(),
        centroid: toVec3(fs.own(props.CentreOfMass())),
        area: props.Mass(),
        normal,
        axis,
        radius,
        axisOrigin,
        hole,
      });
    });
  }

  const edges: EdgeInfo[] = [];
  for (let i = 1; i <= edgeMap.Extent(); i++) {
    withScope(oc, (es) => {
      const edge: TopoDS_Edge = es.own(oc.TopoDS.Edge(es.own(edgeMap.FindKey(i))));
      const adjacent = faceIndices(es, es.own(edgeFaces.FindFromIndex(edgeFaces.FindIndex(edge))));
      const first: TopoDS_Vertex = es.own(oc.TopExp.FirstVertex(edge, false));
      const last: TopoDS_Vertex = es.own(oc.TopExp.LastVertex(edge, false));
      const vertices = [vertexMap.FindIndex(first), vertexMap.FindIndex(last)];
      let curveType = 'degenerated';
      let midpoint: Vec3;
      let length = 0;
      if (oc.BRep_Tool.Degenerated(edge)) {
        // A collapsed edge (a cone apex, a sphere pole) has no 3D curve.
        midpoint = toVec3(es.own(oc.BRep_Tool.Pnt(first)));
      } else {
        const curve = es.own(new oc.BRepAdaptor_Curve(edge));
        const mid = (curve.FirstParameter() + curve.LastParameter()) / 2;
        const props = es.own(new oc.GProp_GProps());
        oc.BRepGProp.LinearProperties(edge, props, false, false);
        curveType = curve.GetType().replace('GeomAbs_', '').toLowerCase();
        midpoint = toVec3(es.own(curve.Value(mid)));
        length = props.Mass();
      }
      edges.push({
        index: i,
        faces: adjacent.unique,
        seam: adjacent.unique.length < adjacent.total,
        curve: curveType,
        midpoint,
        length,
        vertices: [...new Set(vertices.filter((v) => v > 0))],
      });
    });
  }

  const vertices: VertexInfo[] = [];
  for (let i = 1; i <= vertexMap.Extent(); i++) {
    withScope(oc, (vs) => {
      const vertex: TopoDS_Vertex = vs.own(oc.TopoDS.Vertex(vs.own(vertexMap.FindKey(i))));
      vertices.push({
        index: i,
        point: toVec3(vs.own(oc.BRep_Tool.Pnt(vertex))),
        faces: faceIndices(vs, vs.own(vertexFaces.FindFromIndex(vertexFaces.FindIndex(vertex))))
          .unique,
      });
    });
  }
  return { faces, edges, vertices };
}

/**
 * Whether a cylindrical face is a hole: its outward normal points toward the axis. The surface
 * normal of a cylinder is radial, outward from the axis for a right-handed frame and inward for a
 * left-handed one (a mirrored cylinder); a reversed face flips it once more, as for planes. The
 * result is checked against the surface itself: at the middle of the face's parameter range, the
 * normal `D1U x D1V` (flipped for a reversed face) is compared with the direction from the axis
 * to the point. The two agree for every valid cylinder; when the evaluation is degenerate (a
 * zero radius), the frame rule alone decides.
 */
function cylinderIsHole(
  s: Scope,
  adaptor: BRepAdaptor_Surface,
  origin: Vec3,
  axis: Vec3,
  direct: boolean,
  reversed: boolean,
): boolean {
  const outwardFromAxis = direct !== reversed;
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2;
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2;
  const d1 = adaptor.EvalD1(u, v);
  const point = toVec3(s.own(d1.Point));
  const n = cross(toVec3(s.own(d1.D1U)), toVec3(s.own(d1.D1V)));
  const rel: Vec3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const along = dot(rel, axis) / dot(axis, axis);
  const radial: Vec3 = [
    rel[0] - along * axis[0],
    rel[1] - along * axis[1],
    rel[2] - along * axis[2],
  ];
  const side = dot(n, radial) * (reversed ? -1 : 1);
  if (!Number.isFinite(side) || side === 0) return !outwardFromAxis;
  return side < 0;
}
