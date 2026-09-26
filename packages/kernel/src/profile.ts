// Planar profiles from solved sketch loops (ADR 0001 `profile(plane, loops)`).

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Vertex, TopoDS_Wire } from 'libcascade/single/init';
import { KernelError } from './errors';
import { cross, dot, norm, type Oc, type Scope } from './occt';
import type { Frame, ProfileEntity, ProfileLoop, Vec2, Vec3 } from './types';

/** Relative tolerance for "this entity ends where the next starts". */
const CLOSURE_TOLERANCE = 1e-7;

export interface BuiltProfile {
  /** Owned by the caller (not by the scope). */
  face: TopoDS_Face;
  /** Per loop, the edge each entity became, in entity order. Owned by the caller. */
  loops: TopoDS_Edge[][];
  normal: Vec3;
}

function invalid(message: string): KernelError {
  return new KernelError('profile', message, { code: 'invalid-argument' });
}

function unit(v: Vec3, what: string): Vec3 {
  const n = norm(v);
  if (!(n > 1e-12)) throw invalid(`${what} is a zero vector`);
  return [v[0] / n, v[1] / n, v[2] / n];
}

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function startOf(e: ProfileEntity): Vec2 | null {
  return e.kind === 'circle' ? null : e.start;
}

function endOf(e: ProfileEntity): Vec2 | null {
  return e.kind === 'circle' ? null : e.end;
}

/** Sample points along a loop in order, for its signed area. */
function samples(loop: ProfileLoop): Vec2[] {
  const out: Vec2[] = [];
  for (const e of loop.entities) {
    if (e.kind === 'line') {
      out.push(e.start);
    } else if (e.kind === 'circle') {
      // Built counter-clockwise about the frame normal.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI;
        out.push([e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)]);
      }
    } else {
      const [a0, a1] = arcAngles(e);
      for (let k = 0; k < 8; k++) {
        const a = a0 + ((a1 - a0) * k) / 8;
        const r = dist2(e.center, e.start);
        out.push([e.center[0] + r * Math.cos(a), e.center[1] + r * Math.sin(a)]);
      }
    }
  }
  return out;
}

/** Start and end angle of an arc, with end reached by turning in the arc's sense. */
function arcAngles(e: Extract<ProfileEntity, { kind: 'arc' }>): [number, number] {
  const a0 = Math.atan2(e.start[1] - e.center[1], e.start[0] - e.center[0]);
  let a1 = Math.atan2(e.end[1] - e.center[1], e.end[0] - e.center[0]);
  if (e.clockwise) {
    while (a1 >= a0) a1 -= 2 * Math.PI;
  } else {
    while (a1 <= a0) a1 += 2 * Math.PI;
  }
  return [a0, a1];
}

function signedArea(points: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function checkLoop(loop: ProfileLoop, index: number): void {
  const entities = loop.entities;
  if (entities.length === 0) throw invalid(`loop ${index} is empty`);
  if (entities.some((e) => e.kind === 'circle') && entities.length > 1) {
    throw invalid(`loop ${index}: a circle must be a loop on its own`);
  }
  let scale = 0;
  for (const e of entities) {
    if (e.kind === 'circle') {
      if (!(e.radius > 0)) throw invalid(`loop ${index}: circle radius must be positive`);
      scale = Math.max(scale, e.radius);
    } else {
      scale = Math.max(scale, Math.abs(e.start[0]), Math.abs(e.start[1]), dist2(e.start, e.end));
      if (dist2(e.start, e.end) === 0 && e.kind === 'line') {
        throw invalid(`loop ${index}: zero-length line`);
      }
      if (e.kind === 'arc') {
        const r0 = dist2(e.center, e.start);
        const r1 = dist2(e.center, e.end);
        if (!(r0 > 0)) throw invalid(`loop ${index}: arc radius must be positive`);
        if (Math.abs(r0 - r1) > CLOSURE_TOLERANCE * Math.max(1, r0) * 100) {
          throw invalid(`loop ${index}: arc start and end are not on one circle`);
        }
      }
    }
  }
  const tol = CLOSURE_TOLERANCE * Math.max(1, scale);
  for (let i = 0; i < entities.length && entities.length > 1; i++) {
    const end = endOf(entities[i]!)!;
    const next = startOf(entities[(i + 1) % entities.length]!)!;
    if (dist2(end, next) > tol) {
      throw invalid(
        `loop ${index}: entity ${i} does not end where entity ${(i + 1) % entities.length} starts`,
      );
    }
  }
  if (entities.length === 1 && entities[0]!.kind !== 'circle') {
    throw invalid(`loop ${index}: a single ${entities[0]!.kind} cannot close a loop`);
  }
}

/**
 * Build a planar face from loops in `frame`. The first loop is the outer
 * boundary, the rest are holes. Every entity becomes exactly one edge, and
 * the edges are returned in entity order so that extrude can report which
 * side face each entity generated.
 */
export function buildProfile(
  oc: Oc,
  s: Scope,
  frame: Frame,
  loops: readonly ProfileLoop[],
): BuiltProfile {
  if (loops.length === 0) throw invalid('a profile needs at least one loop');
  const normal = unit(frame.normal, 'frame normal');
  const x0 = unit(frame.xDir, 'frame xDir');
  if (Math.abs(dot(normal, x0)) > 1e-9)
    throw invalid('frame xDir is not perpendicular to the normal');
  const x = x0;
  const y = cross(normal, x);
  const [ox, oy, oz] = frame.origin;
  const at = (p: Vec2): Vec3 => [
    ox + p[0] * x[0] + p[1] * y[0],
    oy + p[0] * x[1] + p[1] * y[1],
    oz + p[0] * x[2] + p[1] * y[2],
  ];
  const pnt = (p: Vec3) => s.own(new oc.gp_Pnt(p[0], p[1], p[2]));
  const dir = (d: Vec3) => s.own(new oc.gp_Dir(d[0], d[1], d[2]));
  loops.forEach(checkLoop);

  // Edges are handed to the caller, so they are not owned by the scope; on
  // failure they are released here.
  const built: TopoDS_Edge[][] = [];
  const release = () => {
    for (const loop of built) for (const e of loop) s.free(e);
  };
  try {
    const wires: TopoDS_Wire[] = [];
    loops.forEach((loop, li) => {
      const edges: TopoDS_Edge[] = [];
      built.push(edges);
      const entities = loop.entities;
      // One vertex per entity start, shared with the previous entity's end.
      // (A circle has no start and makes no vertex of its own.)
      const vertices: Array<TopoDS_Vertex | null> = entities.map((e) => {
        const start = startOf(e);
        return start === null
          ? null
          : s.own(s.own(new oc.BRepBuilderAPI_MakeVertex(pnt(at(start)))).Vertex());
      });
      entities.forEach((e, i) => {
        let maker: InstanceType<Oc['BRepBuilderAPI_MakeEdge']>;
        if (e.kind === 'line') {
          maker = s.own(
            new oc.BRepBuilderAPI_MakeEdge(vertices[i]!, vertices[(i + 1) % vertices.length]!),
          );
        } else if (e.kind === 'circle') {
          const ax2 = s.own(new oc.gp_Ax2(pnt(at(e.center)), dir(normal), dir(x)));
          maker = s.own(new oc.BRepBuilderAPI_MakeEdge(s.own(new oc.gp_Circ(ax2, e.radius))));
        } else {
          const axis: Vec3 = e.clockwise ? [-normal[0], -normal[1], -normal[2]] : normal;
          const ax2 = s.own(new oc.gp_Ax2(pnt(at(e.center)), dir(axis), dir(x)));
          const circ = s.own(new oc.gp_Circ(ax2, dist2(e.center, e.start)));
          maker = s.own(
            new oc.BRepBuilderAPI_MakeEdge(
              circ,
              vertices[i]!,
              vertices[(i + 1) % vertices.length]!,
            ),
          );
        }
        if (!maker.IsDone())
          throw invalid(`loop ${li}: entity ${i} (${e.kind}) did not make an edge`);
        edges.push(maker.Edge());
      });
      const wireMaker = s.own(new oc.BRepBuilderAPI_MakeWire());
      for (const e of edges) wireMaker.Add(e);
      if (!wireMaker.IsDone()) throw invalid(`loop ${li} does not make a wire`);
      let wire = s.own(wireMaker.Wire());
      // The outer loop runs counter-clockwise about the normal, holes clockwise.
      const ccw = signedArea(samples(loop)) > 0;
      if (ccw !== (li === 0)) wire = s.own(oc.TopoDS.Wire(s.own(wire.Reversed())));
      wires.push(wire);
    });

    const plane = s.own(
      new oc.gp_Pln(s.own(new oc.gp_Ax3(pnt(frame.origin), dir(normal), dir(x)))),
    );
    const faceMaker = s.own(new oc.BRepBuilderAPI_MakeFace(plane, wires[0]!, true));
    for (const hole of wires.slice(1)) faceMaker.Add(hole);
    if (!faceMaker.IsDone()) throw invalid('the loops do not make a face');
    return { face: faceMaker.Face(), loops: built, normal };
  } catch (error) {
    release();
    throw error;
  }
}
