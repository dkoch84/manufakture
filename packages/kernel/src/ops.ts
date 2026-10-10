// The worker protocol's operations: plain-data descriptions of kernel calls,
// submitted in batches (ADR 0007, decision 3). An op can take the shape made
// by an earlier op of the same batch, so a whole chain (profile, extrude,
// cut, fillet, tessellate) is one round trip.

import {
  arrayOf,
  bool,
  either,
  isObject,
  num,
  oneOf,
  shape,
  shapeRef,
  str,
  vec3,
  frame,
  loop,
  type Check,
} from './checks';
import { KernelError, type KernelFailure } from './errors';
import type { StepAssemblyLayout } from './exchange';
import {
  applyFeature,
  connectorFrame,
  pickReference,
  pickVertex,
  resolveReferences,
  type ConnectorInference,
  type ConnectorOrigin,
  type ConnectorReport,
  type FeatureBody,
  type FeatureInput,
  type FeatureOutcome,
  type ReferenceReport,
  type VertexRef,
} from './features';
import { DEFAULT_DEFLECTION, type BooleanKind, type Kernel } from './kernel';
import type { FaceLoopsReport, FaceLoopsTarget, SectionLoops } from './loops';
import type { MeasureResult, MeasureTarget, ShapeMeasureTarget } from './measure';
import type { OrientedBox } from './obb';
import type { ProjectOptions, ProjectResult, ProjectView } from './project';
import { applyNames, type NameTable } from './names';
import { isUnnamed, type TopoRef } from './naming';
import type {
  Deflection,
  ExtrudeResult,
  Frame,
  InterferenceOptions,
  InterferenceResult,
  MeshData,
  OperationResult,
  Placement,
  ProfileLoop,
  ShapeId,
  ShapeProperties,
  Topology,
  Vec3,
} from './types';
import type { HoleWall } from './walls';

/**
 * A live shape id, or the shape made by op number `result` earlier in the
 * same batch. For a `feature` op, `body` picks one of its bodies by id; without
 * it the feature must have left exactly one body.
 */
export type ShapeRef = ShapeId | { result: number; body?: string };

/**
 * A part's bodies for a `feature` op: listed (each shape by `ShapeRef`), or
 * `{ result }` for the bodies after an earlier `feature` op of the batch,
 * whatever it merged, made or passed through.
 */
export type BodySetRef = readonly { id: string; shape: ShapeRef }[] | { result: number };

interface OpCommon {
  /** Echoed in the result and in any failure, and stamped on the shapes the op makes. */
  featureId?: string;
  /**
   * Keep the shape this op makes after the batch (default true). With false,
   * it is released when the batch ends: an intermediate result.
   */
  keep?: boolean;
}

export type BoxOp = OpCommon & { op: 'box'; size: Vec3; at?: Vec3 };
export type CylinderOp = OpCommon & {
  op: 'cylinder';
  radius: number;
  height: number;
  at?: Vec3;
  axis?: Vec3;
};
export type ProfileOp = OpCommon & { op: 'profile'; frame: Frame; loops: readonly ProfileLoop[] };
export type ExtrudeOp = OpCommon & {
  op: 'extrude';
  profile: ShapeRef;
  /** Along the profile normal (negative for the other side), or a vector. */
  distance: number | Vec3;
  history?: boolean;
};
export type BooleanOp = OpCommon & {
  op: 'boolean';
  kind: BooleanKind;
  shape: ShapeRef;
  tools: readonly ShapeRef[];
  simplify?: boolean;
  history?: boolean;
};
export type FilletOp = OpCommon & {
  op: 'fillet';
  shape: ShapeRef;
  /** 1-based edge indices of `shape`. */
  edges: readonly number[];
  radius: number;
  history?: boolean;
};
export type TessellateOp = OpCommon & {
  op: 'tessellate';
  shape: ShapeRef;
  deflection?: Partial<Deflection>;
};
export type TopologyOp = OpCommon & { op: 'topology'; shape: ShapeRef };
export type PropertiesOp = OpCommon & { op: 'properties'; shape: ShapeRef };
export type ReleaseOp = OpCommon & { op: 'release'; shapes: readonly ShapeRef[] };
/**
 * Apply one part feature to a part's bodies (none before the first feature):
 * see `applyFeature`. The value's `bodies` are the bodies after the feature,
 * the input bodies themselves when the feature failed or changed nothing, so
 * a later op of the batch can take `{ result }` either way. Only the shapes
 * of bodies the feature made or changed are owned by the batch (`keep:
 * false` releases them).
 */
export type FeatureOp = OpCommon & {
  op: 'feature';
  bodies: BodySetRef;
  feature: FeatureInput;
};
/** Resolve stored references on a named body. */
export type ResolveOp = OpCommon & { op: 'resolve'; shape: ShapeRef; refs: readonly TopoRef[] };
/**
 * Mate connector frames on a named body (`connectorFrame`): one report per connector, in order.
 * An origin that does not resolve is a report, not a failed op.
 */
export type ConnectorOp = OpCommon & {
  op: 'connector';
  shape: ShapeRef;
  connectors: readonly { origin: ConnectorOrigin; inference: ConnectorInference }[];
};
/**
 * The reference a click on face, edge or vertex `index` of a named body is stored as: a
 * `FaceRef`, an `EdgeRef`, or for a vertex the `VertexRef` a mate connector stores.
 */
export type PickOp = OpCommon & {
  op: 'pick';
  shape: ShapeRef;
  kind: 'face' | 'edge' | 'vertex';
  index: number;
};

/**
 * Exact measurements on a body: every target (a face, edge or vertex by name,
 * or by 1-based index), the distance and angle between exactly two, and with
 * `body` the body's volume, area, centre of mass and bounding box. A target
 * with a `shape` is on that body instead (another body of the same part, in the
 * same coordinates): the distance and angle between faces of two bodies.
 */
export type MeasureOp = OpCommon & {
  op: 'measure';
  shape: ShapeRef;
  targets: readonly MeasureOpTarget[];
  body?: boolean;
};

/** A measure op's target: on the op's shape, or with `shape` on that body. */
export type MeasureOpTarget = MeasureTarget & { shape?: ShapeRef };

/**
 * The oriented bounding box of a body: centre, unit axes and sizes, longest first
 * (`Kernel.orientedBox`). `optimal` (default true) is OCCT's optimal mode. Makes no shapes.
 */
export type ObbOp = OpCommon & { op: 'obb'; shape: ShapeRef; optimal?: boolean };

/**
 * One AP214 STEP file of the shapes, each a named top-level product; with `assembly`, an
 * assembly of them instead: each part (bodies by index in `bodies`) once, each instance a
 * placed component (see exchange.ts).
 */
export type ExportStepOp = OpCommon & {
  op: 'exportStep';
  bodies: readonly { shape: ShapeRef; name: string }[];
  assembly?: StepAssemblyLayout;
};
/** Read a STEP file (bytes, or base64 text) into a new, unnamed shape. */
export type ImportStepOp = OpCommon & { op: 'importStep'; data: Uint8Array | string };
/**
 * Which pairs of items (assembly instances: their bodies at a placement) overlap, and by how much
 * (`Kernel.interference`). Makes no shapes.
 */
export type InterferenceOp = OpCommon &
  InterferenceOptions & {
    op: 'interference';
    items: readonly { shapes: readonly ShapeRef[]; transform?: Placement }[];
  };

/**
 * A view of placed bodies by hidden-line removal (`Kernel.project`): every item in one run, its
 * edges classified and in view coordinates; with `section`, cut first and the section faces
 * returned as loops. Makes no shapes.
 */
export type ProjectOp = OpCommon &
  ProjectOptions & {
    op: 'project';
    items: readonly { shape: ShapeRef; transform?: Placement; key: string }[];
    view: ProjectView;
  };

/**
 * The loops of one planar face in a frame's 2D coordinates (`Kernel.faceLoops`): the face by name
 * on a named body or by 1-based index; `deflection` (mm) for curves that are not lines or circles.
 * Makes no shapes.
 */
export type FaceLoopsOp = OpCommon & {
  op: 'faceLoops';
  shape: ShapeRef;
  target: FaceLoopsTarget;
  frame: Frame;
  deflection?: number;
};

/**
 * The thinnest wall around the wall faces of hole features (`Kernel.holeWalls`): `holes` are
 * feature ids; rays reach `range` mm (default 10). Makes no shapes.
 */
export type HoleWallsOp = OpCommon & {
  op: 'holeWalls';
  shape: ShapeRef;
  holes: readonly string[];
  range?: number;
};

/**
 * The section of a body by a frame's plane, moved `height` (default 0) along its normal, as nested
 * loops in the frame's 2D coordinates (`Kernel.section`). Makes no shapes.
 */
export type SectionOp = OpCommon & {
  op: 'section';
  shape: ShapeRef;
  frame: Frame;
  height?: number;
  deflection?: number;
};

export type KernelOp =
  | BoxOp
  | CylinderOp
  | ProfileOp
  | ExtrudeOp
  | BooleanOp
  | FilletOp
  | TessellateOp
  | TopologyOp
  | PropertiesOp
  | ReleaseOp
  | FeatureOp
  | ResolveOp
  | ConnectorOp
  | PickOp
  | MeasureOp
  | ObbOp
  | ExportStepOp
  | ImportStepOp
  | InterferenceOp
  | ProjectOp
  | FaceLoopsOp
  | SectionOp
  | HoleWallsOp;

export type OpName = KernelOp['op'];

export interface ReleaseResult {
  released: ShapeId[];
  /** Ids that were not live (released twice, or never issued). */
  unknown: ShapeId[];
}

/** What each op returns on success. */
export interface OpValues {
  box: { shape: ShapeId };
  cylinder: { shape: ShapeId };
  profile: { shape: ShapeId };
  extrude: ExtrudeResult;
  boolean: OperationResult;
  fillet: OperationResult;
  tessellate: MeshData;
  topology: Topology;
  properties: ShapeProperties;
  release: ReleaseResult;
  feature: FeatureOutcome;
  resolve: { results: ReferenceReport[] };
  connector: { results: ConnectorReport[] };
  pick: { ref: TopoRef | VertexRef | null };
  measure: MeasureResult;
  obb: OrientedBox;
  /** `data` is transferred. */
  exportStep: { data: Uint8Array };
  importStep: { shape: ShapeId };
  /** Overlap meshes are transferred. */
  interference: InterferenceResult;
  project: ProjectResult;
  faceLoops: FaceLoopsReport;
  section: SectionLoops;
  holeWalls: { walls: HoleWall[] };
}

export type OpValue<O extends { op: OpName }> = OpValues[O['op']];

export type OpResult<O extends KernelOp = KernelOp> =
  | { ok: true; op: O['op']; featureId?: string; value: OpValue<O>; ms: number }
  | { ok: false; op: string; featureId?: string; error: KernelFailure; ms: number };

/** Results of a batch, typed per op when the ops are a tuple literal. */
export type OpResults<T extends readonly KernelOp[]> = { [K in keyof T]: OpResult<T[K]> };

const OP_NAMES: ReadonlySet<string> = new Set<OpName>([
  'box',
  'cylinder',
  'profile',
  'extrude',
  'boolean',
  'fillet',
  'tessellate',
  'topology',
  'properties',
  'release',
  'feature',
  'resolve',
  'connector',
  'pick',
  'measure',
  'obb',
  'exportStep',
  'importStep',
  'interference',
  'project',
  'faceLoops',
  'section',
  'holeWalls',
]);

// Validation ----------------------------------------------------------------------
//
// Ops arrive by structured clone, so their static types prove nothing. Shape
// errors are reported as `invalid-op`; range errors (a negative radius) are
// left to the kernel, which reports them as `invalid-argument`.

/** A stored reference: `{ face }` or `{ faces, ends?, ordinal? }` with names. */
const topoRef: Check = (v, p) =>
  isObject(v) && 'face' in v
    ? shape({ face: str })(v, p)
    : shape({ faces: arrayOf(str, true) }, { ends: arrayOf(str), ordinal: num })(v, p);

/** A measure target: `{ kind, name }` or `{ kind, index }`. */
const measureTarget: Check = (v, p) => {
  const kind = oneOf('face', 'edge', 'vertex');
  return isObject(v) && 'name' in v
    ? shape({ kind, name: str }, { shape: shapeRef })(v, p)
    : shape({ kind, index: num }, { shape: shapeRef })(v, p);
};

/** A face target: `{ name }` or `{ index }`. */
const faceTarget: Check = (v, p) =>
  isObject(v) && 'name' in v ? shape({ name: str })(v, p) : shape({ index: num })(v, p);

/** A placement: `{ translation: [x, y, z], rotation: [x, y, z, w] }`. */
const placement: Check = (v, p) => {
  const e = shape({ translation: vec3, rotation: arrayOf(num, true) })(v, p);
  if (e !== null) return e;
  return (v as { rotation: unknown[] }).rotation.length === 4
    ? null
    : `${p}.rotation must be a quaternion [x, y, z, w]`;
};

/** An item pair: `[i, j]`. */
const pair: Check = (v, p) =>
  Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'number')
    ? null
    : `${p} must be [number, number]`;

const FIELDS: Record<OpName, [Record<string, Check>, Record<string, Check>]> = {
  box: [{ size: vec3 }, { at: vec3 }],
  cylinder: [
    { radius: num, height: num },
    { at: vec3, axis: vec3 },
  ],
  profile: [{ frame, loops: arrayOf(loop, true) }, {}],
  extrude: [
    { profile: shapeRef, distance: either(num, vec3, 'a number or a vector') },
    { history: bool },
  ],
  boolean: [
    { kind: oneOf('fuse', 'cut', 'common'), shape: shapeRef, tools: arrayOf(shapeRef, true) },
    { simplify: bool, history: bool },
  ],
  fillet: [{ shape: shapeRef, edges: arrayOf(num, true), radius: num }, { history: bool }],
  tessellate: [{ shape: shapeRef }, { deflection: shape({}, { linear: num, angular: num }) }],
  topology: [{ shape: shapeRef }, {}],
  properties: [{ shape: shapeRef }, {}],
  release: [{ shapes: arrayOf(shapeRef) }, {}],
  // The feature itself is checked by `applyFeature`, which reports a
  // malformed feature as that feature's error and passes the body through.
  feature: [
    {
      bodies: (v, p) =>
        Array.isArray(v)
          ? arrayOf(shape({ id: str, shape: shapeRef }))(v, p)
          : isObject(v) && typeof v.result === 'number' && Number.isInteger(v.result)
            ? null
            : `${p} must be a list of { id, shape } or { result: <op index> }`,
      feature: shape({ id: str, kind: str }),
    },
    {},
  ],
  resolve: [{ shape: shapeRef, refs: arrayOf(topoRef) }, {}],
  connector: [
    {
      shape: shapeRef,
      connectors: arrayOf(
        shape({ origin: topoRef, inference: oneOf('centroid', 'centre', 'midpoint', 'vertex') }),
      ),
    },
    {},
  ],
  pick: [{ shape: shapeRef, kind: oneOf('face', 'edge', 'vertex'), index: num }, {}],
  measure: [{ shape: shapeRef, targets: arrayOf(measureTarget) }, { body: bool }],
  obb: [{ shape: shapeRef }, { optimal: bool }],
  // The assembly's parts and instances are checked by the kernel (`stepAssemblyProblem`).
  exportStep: [
    { bodies: arrayOf(shape({ shape: shapeRef, name: str }), true) },
    { assembly: (v, p) => (isObject(v) ? null : `${p} must be an object`) },
  ],
  importStep: [
    {
      data: (v, p) =>
        typeof v === 'string' || v instanceof Uint8Array
          ? null
          : `${p} must be a Uint8Array or base64 text`,
    },
    {},
  ],
  interference: [
    { items: arrayOf(shape({ shapes: arrayOf(shapeRef) }, { transform: placement })) },
    {
      pairs: arrayOf(pair),
      tolerance: num,
      mesh: bool,
      deflection: shape({}, { linear: num, angular: num }),
      prefilterOnly: bool,
    },
  ],
  // Degenerate frames and deflections are the kernel's to refuse (`invalid-argument`).
  faceLoops: [{ shape: shapeRef, target: faceTarget, frame }, { deflection: num }],
  section: [
    { shape: shapeRef, frame },
    { height: num, deflection: num },
  ],
  holeWalls: [{ shape: shapeRef, holes: arrayOf(str) }, { range: num }],
  // Ranges (a zero direction, an up parallel to it, repeated keys) are the kernel's to refuse.
  project: [
    {
      items: arrayOf(shape({ shape: shapeRef, key: str }, { transform: placement })),
      view: shape({ direction: vec3, up: vec3 }, { origin: vec3 }),
    },
    {
      hidden: bool,
      smooth: bool,
      sewn: bool,
      deflection: num,
      section: shape({ origin: vec3, normal: vec3 }),
    },
  ],
};

/** Why `value` is not a valid op, or null. */
export function validateOp(value: unknown): string | null {
  if (!isObject(value)) return 'an op must be an object';
  if (typeof value.op !== 'string' || !OP_NAMES.has(value.op)) {
    return `unknown op ${JSON.stringify(value.op)}`;
  }
  const [required, optional] = FIELDS[value.op as OpName];
  const common = shape({}, { featureId: str, keep: bool })(value, 'op');
  return common ?? shape(required, optional)(value, 'op');
}

// Execution -----------------------------------------------------------------------

/** What ops share within one batch. */
export interface BatchContext {
  /** The reply's name table: tessellating a named body fills its mesh's name slots from it. */
  names: NameTable;
  /** Resolves `{ result }` body sets; without it, a `feature` op takes listed bodies only. */
  resolveBodies?: ResolveBodies;
}

/** Resolves `ShapeRef`s against the results of the batch so far. */
export type ResolveShape = (ref: ShapeRef, operation: string) => ShapeId;

/** Resolves a `{ result }` body set against the results of the batch so far. */
export type ResolveBodies = (ref: { result: number }, operation: string) => FeatureBody[];

/** Run one validated op on the kernel. Throws KernelError. */
export function executeOp(
  kernel: Kernel,
  op: KernelOp,
  resolve: ResolveShape,
  context?: BatchContext,
): OpValues[OpName] {
  const history = (o: { history?: boolean }) => (o.history === false ? { history: false } : {});
  switch (op.op) {
    case 'box':
      return { shape: kernel.box(op.size[0], op.size[1], op.size[2], op.at) };
    case 'cylinder':
      return { shape: kernel.cylinder(op.radius, op.height, op.at, op.axis) };
    case 'profile':
      return { shape: kernel.profile(op.frame, op.loops) };
    case 'extrude':
      return kernel.extrude(resolve(op.profile, 'extrude'), op.distance, history(op));
    case 'boolean':
      return kernel.boolean(
        op.kind,
        resolve(op.shape, op.kind),
        op.tools.map((t) => resolve(t, op.kind)),
        { ...history(op), ...(op.simplify === undefined ? {} : { simplify: op.simplify }) },
      );
    case 'fillet':
      return kernel.fillet(resolve(op.shape, 'fillet'), op.edges, op.radius, history(op));
    case 'tessellate': {
      const id = resolve(op.shape, 'tessellate');
      const mesh = kernel.mesh(id, {
        linear: op.deflection?.linear ?? DEFAULT_DEFLECTION.linear,
        angular: op.deflection?.angular ?? DEFAULT_DEFLECTION.angular,
      });
      const named = kernel.named(id);
      if (named !== null && context !== undefined) {
        // A body made by feature operations: every slot gets its name.
        const { faces, edges } = named.names;
        applyNames(
          mesh,
          context.names,
          (i) => {
            const f = faces[i - 1];
            return f && !isUnnamed(f.name) ? { name: f.name, fragile: f.fragile } : null;
          },
          (i) => {
            const e = edges[i - 1];
            return e ? { name: e.name, fragile: e.fragile } : null;
          },
        );
      }
      return mesh;
    }
    case 'topology':
      return kernel.topology(resolve(op.shape, 'topology'));
    case 'properties':
      return kernel.properties(resolve(op.shape, 'properties'));
    case 'feature': {
      let bodies: FeatureBody[];
      if (Array.isArray(op.bodies)) {
        bodies = (op.bodies as Extract<BodySetRef, readonly unknown[]>).map((b) => ({
          id: b.id,
          shape: resolve(b.shape, 'feature'),
        }));
      } else if (context?.resolveBodies !== undefined) {
        bodies = context.resolveBodies(op.bodies as { result: number }, 'feature');
      } else {
        throw new KernelError('feature', 'no earlier ops to take { result } bodies from', {
          code: 'invalid-op',
        });
      }
      return applyFeature(kernel, bodies, op.feature);
    }
    case 'resolve':
      return { results: resolveReferences(kernel, resolve(op.shape, 'resolve'), op.refs) };
    case 'connector': {
      const id = resolve(op.shape, 'connector');
      return {
        results: op.connectors.map((c) => connectorFrame(kernel, id, c.origin, c.inference)),
      };
    }
    case 'pick': {
      const id = resolve(op.shape, 'pick');
      if (op.kind !== 'vertex') return { ref: pickReference(kernel, id, op.kind, op.index) };
      const named = kernel.has(id) ? kernel.named(id) : null;
      return { ref: named === null ? null : pickVertex(named.names, named.topology, op.index) };
    }
    case 'measure':
      return kernel.measure(
        resolve(op.shape, 'measure'),
        op.targets.map((t): ShapeMeasureTarget => {
          const { shape, ...target } = t;
          return shape === undefined ? target : { ...target, shape: resolve(shape, 'measure') };
        }),
        op.body === undefined ? {} : { body: op.body },
      );
    case 'obb':
      return kernel.orientedBox(
        resolve(op.shape, 'obb'),
        op.optimal === undefined ? {} : { optimal: op.optimal },
      );
    case 'exportStep':
      return {
        data: kernel.exportStep(
          op.bodies.map((b) => ({ shape: resolve(b.shape, 'exportStep'), name: b.name })),
          op.assembly,
        ),
      };
    case 'importStep':
      return { shape: kernel.importStep(op.data) };
    case 'interference': {
      const options: InterferenceOptions = {};
      if (op.pairs !== undefined) options.pairs = op.pairs;
      if (op.tolerance !== undefined) options.tolerance = op.tolerance;
      if (op.mesh !== undefined) options.mesh = op.mesh;
      if (op.deflection !== undefined) options.deflection = op.deflection;
      if (op.prefilterOnly !== undefined) options.prefilterOnly = op.prefilterOnly;
      return kernel.interference(
        op.items.map((item) => {
          const out: { shapes: ShapeId[]; transform?: Placement } = {
            shapes: item.shapes.map((ref) => resolve(ref, 'interference')),
          };
          if (item.transform !== undefined) out.transform = item.transform;
          return out;
        }),
        options,
      );
    }
    case 'project': {
      const options: ProjectOptions = {};
      if (op.hidden !== undefined) options.hidden = op.hidden;
      if (op.smooth !== undefined) options.smooth = op.smooth;
      if (op.sewn !== undefined) options.sewn = op.sewn;
      if (op.deflection !== undefined) options.deflection = op.deflection;
      if (op.section !== undefined) options.section = op.section;
      return kernel.project(
        op.items.map((item) => {
          const out: { shape: ShapeId; transform?: Placement; key: string } = {
            shape: resolve(item.shape, 'project'),
            key: item.key,
          };
          if (item.transform !== undefined) out.transform = item.transform;
          return out;
        }),
        op.view,
        options,
      );
    }
    case 'faceLoops':
      return kernel.faceLoops(
        resolve(op.shape, 'faceLoops'),
        op.target,
        op.frame,
        ...(op.deflection === undefined ? [] : [op.deflection]),
      );
    case 'section':
      return kernel.section(
        resolve(op.shape, 'section'),
        op.frame,
        op.height ?? 0,
        ...(op.deflection === undefined ? [] : [op.deflection]),
      );
    case 'holeWalls':
      return {
        walls: kernel.holeWalls(
          resolve(op.shape, 'holeWalls'),
          op.holes,
          op.range === undefined ? {} : { range: op.range },
        ),
      };
    case 'release': {
      // Like every other op on a lost kernel: fatal, not a list of unknown ids.
      const lost = kernel.lostReason;
      if (lost !== null) {
        throw new KernelError('release', `the kernel instance is gone (${lost})`, {
          code: 'fatal',
        });
      }
      const out: ReleaseResult = { released: [], unknown: [] };
      for (const ref of op.shapes) {
        const id = resolve(ref, 'release');
        (kernel.release(id) ? out.released : out.unknown).push(id);
      }
      return out;
    }
  }
}

/**
 * The shape an op's value carries, if any: its `shape`, or with `body` the
 * shape of that body of a feature outcome (without it, of its one body).
 */
export function shapeOf(value: unknown, body?: string): ShapeId | null {
  if (!isObject(value)) return null;
  if (Array.isArray(value.bodies)) {
    const bodies = value.bodies as FeatureBody[];
    const b =
      body === undefined
        ? bodies.length === 1
          ? bodies[0]
          : undefined
        : bodies.find((x) => x.id === body);
    return b === undefined ? null : b.shape;
  }
  return body === undefined && typeof value.shape === 'number' ? (value.shape as ShapeId) : null;
}

/** Every shape an op's value carries: its `shape`, or the shapes of a feature outcome's bodies. */
export function shapesOf(value: unknown): ShapeId[] {
  if (isObject(value) && Array.isArray(value.bodies)) {
    return (value.bodies as FeatureBody[]).map((b) => b.shape);
  }
  const one = shapeOf(value);
  return one === null ? [] : [one];
}

/** The bodies of a feature outcome, or null when the value is not one. */
export function bodiesOf(value: unknown): FeatureBody[] | null {
  if (!isObject(value) || !Array.isArray(value.bodies)) return null;
  return (value.bodies as FeatureBody[]).map((b) => ({ id: b.id, shape: b.shape }));
}

export function failureOf(error: unknown, operation: string, featureId?: string): KernelFailure {
  if (error instanceof KernelError) return error.toFailure(featureId);
  const failure: KernelFailure = {
    code: 'kernel',
    operation,
    message: error instanceof Error ? error.message : String(error),
  };
  if (featureId !== undefined) failure.featureId = featureId;
  return failure;
}
