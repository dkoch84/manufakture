// A minimal feature tree and regen engine: enough to replay the T0.5
// scenarios through the kernel and the naming layer.
//
// Feature ids (`extrude#1`, `cut#2`, `fillet#3`) are assigned once, when a
// feature is created, and never change: they are not positions in the tree,
// so reordering features does not rename anything. Every reference a feature
// holds (sketch plane, fillet edges) is a name, resolved again on every regen.
// A reference that does not resolve is reported and the feature is skipped;
// nothing is ever picked by index or by proximity.

import type { Frame, HistoryEntry, Kernel, Loop, ShapeId, Topology, Vec3 } from './kernel.ts';
import {
  type EdgeRef,
  type FaceName,
  type FaceRef,
  type Names,
  type Resolution,
  type Via,
  edgeRefName,
  nameExtrusion,
  nameShape,
  propagateFaces,
  resolveEdge,
  resolveFace,
  vertexName,
} from './naming.ts';

/** Where a sketch lies: the world XY plane, an explicit frame, or a planar face of the body. */
export type PlaneRef =
  { kind: 'xy' } | { kind: 'frame'; frame: Frame } | { kind: 'face'; face: FaceRef };

/**
 * A closed sketch loop with the sketcher's stable entity ids. Polygon edge i
 * (point i to point i + 1) has id `ids[i]`. A sketcher that splits edge `e2`
 * names the pieces `e2#a` and `e2#b`, in order along the original edge.
 */
export type SketchLoop =
  | { kind: 'polygon'; points: Array<readonly [number, number]>; ids: string[] }
  | { kind: 'circle'; center: readonly [number, number]; radius: number; id: string };

export interface ExtrudeFeature {
  kind: 'extrude';
  id: string;
  plane: PlaneRef;
  loop: SketchLoop;
  /** Start and end of the sweep along the sketch normal. */
  from: number;
  to: number;
  operation: 'new' | 'fuse' | 'cut';
  /** Unify same-domain faces after the boolean (merges coplanar faces). */
  simplify?: boolean;
}

export interface FilletFeature {
  kind: 'fillet';
  id: string;
  radius: number;
  /** Each edge reference has its own id, used to name the face it produces. */
  edges: Array<{ id: string; ref: EdgeRef }>;
}

export type Feature = ExtrudeFeature | FilletFeature;

/** A body with its names and topology. */
export interface Body {
  shape: ShapeId;
  topology: Topology;
  names: Names;
}

export type ReferenceFailure = Extract<Resolution, { ok: false }>;

export interface FeatureError {
  feature: string;
  /** `plane`, or the id of the fillet edge reference. */
  ref: string;
  /** The reference as a readable name. */
  target: string;
  failure: ReferenceFailure | { status: 'kernel'; message: string };
}

export interface ResolvedRef {
  feature: string;
  ref: string;
  index: number;
  via: Via;
  /** The choice rested on position; see `Resolution`. Always reported. */
  fragile: boolean;
}

/** One topology-changing step, kept for inspection by tests. */
export interface Step {
  feature: string;
  operation: 'extrude' | 'cut' | 'fuse' | 'fillet';
  history: HistoryEntry[];
  /** Face names of the operands before the step (body first, then tool). */
  operands: Array<{ names: Names; topology: Topology }>;
  unnamed: number[];
}

export interface Regen {
  body: Body | null;
  errors: FeatureError[];
  resolved: ResolvedRef[];
  steps: Step[];
}

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

/** Replay `features` in order on `kernel`. Shapes other than the final body are released. */
export function regenerate(kernel: Kernel, features: Feature[]): Regen {
  const out: Regen = { body: null, errors: [], resolved: [], steps: [] };
  const replace = (next: Body) => {
    if (out.body) kernel.release(out.body.shape);
    out.body = next;
  };

  for (const feature of features) {
    try {
      if (feature.kind === 'extrude') extrude(kernel, feature, out, replace);
      else fillet(kernel, feature, out, replace);
    } catch (error) {
      out.errors.push({
        feature: feature.id,
        ref: '',
        target: '',
        failure: {
          status: 'kernel',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return out;
}

function extrude(
  kernel: Kernel,
  feature: ExtrudeFeature,
  out: Regen,
  replace: (b: Body) => void,
): void {
  let frame: Frame;
  if (feature.plane.kind === 'xy') {
    frame = XY;
  } else if (feature.plane.kind === 'frame') {
    frame = feature.plane.frame;
  } else {
    const target = feature.plane.face.face;
    const body = out.body;
    const resolution: Resolution = body
      ? resolveFace(body.names, feature.plane.face)
      : { ok: false, status: 'lost', missing: [target] };
    if (!resolution.ok) {
      out.errors.push({ feature: feature.id, ref: 'plane', target, failure: resolution });
      return;
    }
    out.resolved.push({
      feature: feature.id,
      ref: 'plane',
      index: resolution.index,
      via: resolution.via,
      fragile: resolution.fragile,
    });
    const face = body!.topology.faces[resolution.index - 1]!;
    if (!face.normal) {
      out.errors.push({
        feature: feature.id,
        ref: 'plane',
        target,
        failure: { status: 'kernel', message: `${target} is not planar` },
      });
      return;
    }
    frame = frameOnPlane(face.centroid, face.normal);
  }

  const loop: Loop =
    feature.loop.kind === 'polygon'
      ? { kind: 'polygon', points: feature.loop.points }
      : { kind: 'circle', center: feature.loop.center, radius: feature.loop.radius };
  const ids = feature.loop.kind === 'polygon' ? feature.loop.ids : [feature.loop.id];
  const made = kernel.extrude(frame, loop, feature.from, feature.to);
  const topology = kernel.topology(made.shape);
  const toolNames = nameShape(nameExtrusion(feature.id, ids, made, topology), topology);

  if (feature.operation === 'new') {
    if (out.body) throw new Error('a part has one body; use fuse');
    out.steps.push({
      feature: feature.id,
      operation: 'extrude',
      history: [],
      operands: [],
      unnamed: [],
    });
    replace({ shape: made.shape, topology, names: toolNames });
    return;
  }
  const body = out.body;
  if (!body) {
    kernel.release(made.shape);
    throw new Error(`${feature.operation} needs a body`);
  }
  try {
    const result = kernel.boolean(feature.operation, body.shape, made.shape, {
      simplify: feature.simplify ?? false,
    });
    const resultTopology = kernel.topology(result.shape);
    const propagated = propagateFaces(
      [body.names.faces, toolNames.faces],
      result.history,
      resultTopology,
    );
    out.steps.push({
      feature: feature.id,
      operation: feature.operation,
      history: result.history,
      operands: [
        { names: body.names, topology: body.topology },
        { names: toolNames, topology },
      ],
      unnamed: propagated.unnamed,
    });
    replace({
      shape: result.shape,
      topology: resultTopology,
      names: nameShape(propagated.faces, resultTopology),
    });
  } finally {
    kernel.release(made.shape);
  }
}

function fillet(
  kernel: Kernel,
  feature: FilletFeature,
  out: Regen,
  replace: (b: Body) => void,
): void {
  const body = out.body;
  if (!body) throw new Error('fillet needs a body');
  const indices: number[] = [];
  const refOfEdge = new Map<number, string>();
  let failed = false;
  for (const { id, ref } of feature.edges) {
    const resolution = resolveEdge(body.names, body.topology, ref);
    if (!resolution.ok) {
      out.errors.push({
        feature: feature.id,
        ref: id,
        target: edgeRefName(ref),
        failure: resolution,
      });
      failed = true;
      continue;
    }
    out.resolved.push({
      feature: feature.id,
      ref: id,
      index: resolution.index,
      via: resolution.via,
      fragile: resolution.fragile,
    });
    indices.push(resolution.index);
    refOfEdge.set(resolution.index, id);
  }
  if (failed) return;

  const result = kernel.fillet(body.shape, feature.radius, indices);
  const topology = kernel.topology(result.shape);
  const propagated = propagateFaces([body.names.faces], result.history, topology, (entry) => {
    if (entry.input.kind === 'edge') {
      const ref = refOfEdge.get(entry.input.index);
      return ref ? `${feature.id}:round:${ref}` : null;
    }
    if (entry.input.kind === 'vertex') {
      return `${feature.id}:corner:${vertexName(body.names.faces, body.topology, entry.input.index)}`;
    }
    return null;
  });
  out.steps.push({
    feature: feature.id,
    operation: 'fillet',
    history: result.history,
    operands: [{ names: body.names, topology: body.topology }],
    unnamed: propagated.unnamed,
  });
  replace({ shape: result.shape, topology, names: nameShape(propagated.faces, topology) });
}

/**
 * A deterministic sketch frame on a plane: origin is the world origin
 * projected onto the plane, x is world X projected (world Y when the plane
 * faces X), normal is the face's outward normal.
 */
export function frameOnPlane(point: Vec3, normal: Vec3): Frame {
  const d = dot(point, normal);
  const origin: Vec3 = [normal[0] * d, normal[1] * d, normal[2] * d];
  const project = (v: Vec3): Vec3 => {
    const k = dot(v, normal);
    return [v[0] - k * normal[0], v[1] - k * normal[1], v[2] - k * normal[2]];
  };
  let x = project([1, 0, 0]);
  if (Math.hypot(...x) < 1e-6) x = project([0, 1, 0]);
  const len = Math.hypot(...x);
  return { origin, xDir: [x[0] / len, x[1] / len, x[2] / len], normal };
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Every face name of a body, for display and for comparing regens. */
export function faceNames(body: Body): string[] {
  return body.names.faces.map((f: FaceName) => f.name);
}
