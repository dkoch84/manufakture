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
import {
  applyFeature,
  pickReference,
  resolveReferences,
  type FeatureInput,
  type FeatureOutcome,
  type ReferenceReport,
} from './features';
import { DEFAULT_DEFLECTION, type BooleanKind, type Kernel } from './kernel';
import type { MeasureResult, MeasureTarget } from './measure';
import { applyNames, type NameTable } from './names';
import { isUnnamed, type TopoRef } from './naming';
import type {
  Deflection,
  ExtrudeResult,
  Frame,
  MeshData,
  OperationResult,
  ProfileLoop,
  ShapeId,
  ShapeProperties,
  Topology,
  Vec3,
} from './types';

/** A live shape id, or the shape made by op number `result` earlier in the same batch. */
export type ShapeRef = ShapeId | { result: number };

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
 * Apply one part feature to a body (null before the first feature): see
 * `applyFeature`. The value's `shape` is the body after the feature, which is
 * the input body itself when the feature failed or changed nothing, so a
 * later op of the batch can take `{ result }` either way. Only a new body is
 * owned by the batch (`keep: false` releases it).
 */
export type FeatureOp = OpCommon & {
  op: 'feature';
  body: ShapeRef | null;
  feature: FeatureInput;
};
/** Resolve stored references on a named body. */
export type ResolveOp = OpCommon & { op: 'resolve'; shape: ShapeRef; refs: readonly TopoRef[] };
/** The reference a click on face or edge `index` of a named body is stored as. */
export type PickOp = OpCommon & {
  op: 'pick';
  shape: ShapeRef;
  kind: 'face' | 'edge';
  index: number;
};

/**
 * Exact measurements on a body: every target (a face, edge or vertex by name,
 * or by 1-based index), the distance and angle between exactly two, and with
 * `body` the body's volume, area, centre of mass and bounding box.
 */
export type MeasureOp = OpCommon & {
  op: 'measure';
  shape: ShapeRef;
  targets: readonly MeasureTarget[];
  body?: boolean;
};

/** One AP214 STEP file of the shapes, each a named top-level product. */
export type ExportStepOp = OpCommon & {
  op: 'exportStep';
  bodies: readonly { shape: ShapeRef; name: string }[];
};
/** Read a STEP file (bytes, or base64 text) into a new, unnamed shape. */
export type ImportStepOp = OpCommon & { op: 'importStep'; data: Uint8Array | string };

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
  | PickOp
  | MeasureOp
  | ExportStepOp
  | ImportStepOp;

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
  pick: { ref: TopoRef | null };
  measure: MeasureResult;
  /** `data` is transferred. */
  exportStep: { data: Uint8Array };
  importStep: { shape: ShapeId };
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
  'pick',
  'measure',
  'exportStep',
  'importStep',
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
    ? shape({ kind, name: str })(v, p)
    : shape({ kind, index: num })(v, p);
};

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
      body: (v, p) => (v === null ? null : shapeRef(v, p)),
      feature: shape({ id: str, kind: str }),
    },
    {},
  ],
  resolve: [{ shape: shapeRef, refs: arrayOf(topoRef) }, {}],
  pick: [{ shape: shapeRef, kind: oneOf('face', 'edge'), index: num }, {}],
  measure: [{ shape: shapeRef, targets: arrayOf(measureTarget) }, { body: bool }],
  exportStep: [{ bodies: arrayOf(shape({ shape: shapeRef, name: str }), true) }, {}],
  importStep: [
    {
      data: (v, p) =>
        typeof v === 'string' || v instanceof Uint8Array
          ? null
          : `${p} must be a Uint8Array or base64 text`,
    },
    {},
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
}

/** Resolves `ShapeRef`s against the results of the batch so far. */
export type ResolveShape = (ref: ShapeRef, operation: string) => ShapeId;

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
    case 'feature':
      return applyFeature(
        kernel,
        op.body === null ? null : resolve(op.body, 'feature'),
        op.feature,
      );
    case 'resolve':
      return { results: resolveReferences(kernel, resolve(op.shape, 'resolve'), op.refs) };
    case 'pick':
      return { ref: pickReference(kernel, resolve(op.shape, 'pick'), op.kind, op.index) };
    case 'measure':
      return kernel.measure(
        resolve(op.shape, 'measure'),
        op.targets,
        op.body === undefined ? {} : { body: op.body },
      );
    case 'exportStep':
      return {
        data: kernel.exportStep(
          op.bodies.map((b) => ({ shape: resolve(b.shape, 'exportStep'), name: b.name })),
        ),
      };
    case 'importStep':
      return { shape: kernel.importStep(op.data) };
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

/** The shape an op's value carries, if any. */
export function shapeOf(value: unknown): ShapeId | null {
  return isObject(value) && typeof value.shape === 'number' ? (value.shape as ShapeId) : null;
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
