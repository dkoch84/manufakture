// The worker protocol's operations: plain-data descriptions of kernel calls,
// submitted in batches (ADR 0007, decision 3). An op can take the shape made
// by an earlier op of the same batch, so a whole chain (profile, extrude,
// cut, fillet, tessellate) is one round trip.

import { KernelError, type KernelFailure } from './errors';
import { DEFAULT_DEFLECTION, type BooleanKind, type Kernel } from './kernel';
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
  | ReleaseOp;

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
]);

// Validation ----------------------------------------------------------------------
//
// Ops arrive by structured clone, so their static types prove nothing. Shape
// errors are reported as `invalid-op`; range errors (a negative radius) are
// left to the kernel, which reports them as `invalid-argument`.

type Check = (value: unknown, path: string) => string | null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num: Check = (v, p) => (typeof v === 'number' ? null : `${p} must be a number`);
const bool: Check = (v, p) => (typeof v === 'boolean' ? null : `${p} must be a boolean`);
const str: Check = (v, p) => (typeof v === 'string' ? null : `${p} must be a string`);
const vec2: Check = (v, p) =>
  Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'number')
    ? null
    : `${p} must be [number, number]`;
const vec3: Check = (v, p) =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number')
    ? null
    : `${p} must be [number, number, number]`;
const shapeRef: Check = (v, p) =>
  (typeof v === 'number' && Number.isInteger(v)) ||
  (isObject(v) && typeof v.result === 'number' && Number.isInteger(v.result))
    ? null
    : `${p} must be a shape id or { result: <op index> }`;
const arrayOf =
  (item: Check, nonEmpty = false): Check =>
  (v, p) => {
    if (!Array.isArray(v)) return `${p} must be an array`;
    if (nonEmpty && v.length === 0) return `${p} must not be empty`;
    for (let i = 0; i < v.length; i++) {
      const e = item(v[i], `${p}[${i}]`);
      if (e) return e;
    }
    return null;
  };
const oneOf =
  (...values: string[]): Check =>
  (v, p) =>
    typeof v === 'string' && values.includes(v) ? null : `${p} must be one of ${values.join(', ')}`;
const either =
  (a: Check, b: Check, what: string): Check =>
  (v, p) =>
    a(v, p) === null || b(v, p) === null ? null : `${p} must be ${what}`;
const shape =
  (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v, p) => {
    if (!isObject(v)) return `${p} must be an object`;
    for (const [k, check] of Object.entries(fields)) {
      const e = check(v[k], `${p}.${k}`);
      if (e) return e;
    }
    for (const [k, check] of Object.entries(optional)) {
      if (v[k] === undefined) continue;
      const e = check(v[k], `${p}.${k}`);
      if (e) return e;
    }
    return null;
  };

const entity: Check = (v, p) => {
  if (!isObject(v)) return `${p} must be an object`;
  switch (v.kind) {
    case 'line':
      return shape({ start: vec2, end: vec2 }, { id: str })(v, p);
    case 'arc':
      return shape({ center: vec2, start: vec2, end: vec2 }, { clockwise: bool, id: str })(v, p);
    case 'circle':
      return shape({ center: vec2, radius: num }, { id: str })(v, p);
    default:
      return `${p}.kind must be line, arc or circle`;
  }
};

const frame = shape({ origin: vec3, xDir: vec3, normal: vec3 });
const loop = shape({ entities: arrayOf(entity, true) });

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

/** Resolves `ShapeRef`s against the results of the batch so far. */
export type ResolveShape = (ref: ShapeRef, operation: string) => ShapeId;

/** Run one validated op on the kernel. Throws KernelError. */
export function executeOp(kernel: Kernel, op: KernelOp, resolve: ResolveShape): OpValues[OpName] {
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
    case 'tessellate':
      return kernel.mesh(resolve(op.shape, 'tessellate'), {
        linear: op.deflection?.linear ?? DEFAULT_DEFLECTION.linear,
        angular: op.deflection?.angular ?? DEFAULT_DEFLECTION.angular,
      });
    case 'topology':
      return kernel.topology(resolve(op.shape, 'topology'));
    case 'properties':
      return kernel.properties(resolve(op.shape, 'properties'));
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
