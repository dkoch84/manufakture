// Part features as kernel operations with stable names (T0.5 naming scheme).
//
// One call per feature: `applyFeature(kernel, bodies, input)` takes the part's
// bodies before the feature (named shapes with body ids, in creator order;
// none before the first feature) and a plain-data feature input, and returns
// the bodies after it with every face and edge named, plus per-feature errors
// and warnings. It never throws for a feature that fails: a lost reference, an
// OCCT refusal (common with fillets and shells) or an invalid result becomes a
// `FeatureError`, and the input bodies pass through unchanged so the features
// after it still regenerate. Only a wasm trap (`fatal`) propagates, since the
// instance is gone.
//
// A body's id is the id of the feature that made it (M2 plan, decision 1).
// Each body is combined on its own: `new` adds a body, `add` fuses the tool
// with every body in scope it touches (merged under the first of them), cuts
// and intersections act on each body in scope the tool reaches, and blends
// act on the body that owns their references. Bodies a feature does not touch
// keep their shape ids. A `derive` copies bodies of another part (a derived
// part's source, built by regen in the same kernel) under `<id>:from/` names
// and combines them like an import.
//
// Inputs are evaluated, resolved plain data: numbers in millimetres and
// radians, sketch profiles as loops of entities tagged with their sketch edge
// ids (`@manufakture/sketch`'s `regionProfile`), and references to the model
// as names (`FaceRef`, `EdgeRef`), which are resolved here, in the worker,
// against the names of all the input bodies. The kernel has no runtime
// dependency on the sketch or core packages; the regen engine translates core
// features into these inputs.
//
// Names are attached to each body in the kernel's arena (`Kernel.named`), so
// a later feature, a tessellation or a pick can use them.

import { KernelError } from './errors';
import type { Kernel, NamedShape } from './kernel';
import {
  bornFace,
  deriveFaces,
  describeFailure,
  edgeFacesName,
  importedFace,
  invalidFeatureId,
  invalidSketchId,
  isUnnamed,
  nameShape,
  nameSweep,
  pickEdge,
  pickFace,
  prefixFaces,
  propagateFaces,
  refName,
  resolve,
  vertexName,
  type EdgeRef,
  type FaceName,
  type FaceRef,
  type GeneratedNamer,
  type Names,
  type Resolution,
  type TopoRef,
  type Via,
} from './naming';
import type {
  Axis,
  ChamferSize,
  Frame,
  HistoryEntry,
  Plane,
  ProfileLoop,
  ShapeId,
  SubShapeGeometry,
  Topology,
  Transform,
  Vec2,
  Vec3,
} from './types';

// Inputs --------------------------------------------------------------------------

/**
 * How a feature's new solid combines with the part's bodies: `new` makes it a
 * body of its own, `add` fuses it with the bodies it touches, `subtract` and
 * `intersect` act on each body it reaches.
 */
export type ResultMode = 'new' | 'add' | 'subtract' | 'intersect';

/**
 * A body of the part: its id (the id of the feature that made it, or an
 * instance of one: `extrude#3`, `pattern#2:i3`) and its named shape.
 */
export interface FeatureBody {
  id: string;
  shape: ShapeId;
}

/** What features that combine with bodies share. */
interface Scoped {
  /**
   * The ids of the bodies the feature combines with (or, for a body pattern
   * or mirror, copies). Absent: every body at that point.
   */
  scope?: readonly string[];
}

/** What features that can make a body share. */
interface MakesBody extends Scoped {
  /**
   * The id of the body a `new` feature makes, or an `add` whose tool touches
   * no body. Default: the feature id.
   */
  body?: string;
}

/**
 * A resolved sketch region: the kernel's `profile` input. Every entity must
 * carry its sketch edge id (`e2`, a sketch split `e2#a`, or a region piece
 * `e2#1`), which names the face it sweeps.
 */
export interface SketchProfile {
  frame: Frame;
  loops: readonly ProfileLoop[];
}

export type ExtrudeExtent =
  | { type: 'blind'; distance: number }
  /** `distance` is the total depth, centred on the sketch plane. */
  | { type: 'symmetric'; distance: number }
  /** Far enough to leave the body, from the sketch plane; needs a body. */
  | { type: 'throughAll' }
  /** To the plane of a planar face of the body. */
  | { type: 'upToFace'; face: FaceRef };

export interface ExtrudeInput extends MakesBody {
  kind: 'extrude';
  /** The feature id, `kind#n`; every name the feature gives starts with it. */
  id: string;
  profile: SketchProfile;
  extent: ExtrudeExtent;
  /** Extrude against the sketch normal. */
  reverse?: boolean;
  /**
   * Draft angle in radians: positive tapers the sides inward along the
   * extrusion direction, negative outward. The neutral plane is the sketch
   * plane.
   */
  draft?: number;
  mode: ResultMode;
}

export interface RevolveInput extends MakesBody {
  kind: 'revolve';
  id: string;
  profile: SketchProfile;
  /**
   * An axis in model space (a sketch line, converted), or a straight edge of
   * the body. The revolve turns right-handed about the axis direction. An
   * edge runs the way `orientedGeometry` documents and `flip` turns it
   * round; a model-space axis needs no flag, since the caller sets its
   * direction (regen negates a sketch line's direction for core's `flip`).
   */
  axis: Axis | { edge: EdgeRef; flip?: boolean };
  /** Radians, up to 2 pi for a full revolution. */
  angle: number;
  /** Split the angle evenly to both sides of the sketch plane. */
  symmetric?: boolean;
  mode: ResultMode;
}

/** A reference a feature holds, with its own id (`r1`); faces made from it are named by it. */
export interface EdgeReference {
  id: string;
  ref: EdgeRef;
}

export interface FaceReference {
  id: string;
  ref: FaceRef;
}

export interface FilletInput {
  kind: 'fillet';
  id: string;
  radius: number;
  edges: readonly EdgeReference[];
}

export interface ChamferInput {
  kind: 'chamfer';
  id: string;
  size: ChamferSize;
  /**
   * `face`: the face asymmetric sizes measure `distance` on. When absent, the
   * edge's adjacent face whose name sorts first.
   */
  edges: readonly (EdgeReference & { face?: FaceRef })[];
}

export interface ShellInput {
  kind: 'shell';
  id: string;
  thickness: number;
  /** Faces to remove; none makes a closed hollow (a solid with an inner void). */
  faces: readonly FaceReference[];
  /** Grow the wall outward instead of inward. */
  outward?: boolean;
}

export type HoleHead =
  | { type: 'simple' }
  | { type: 'counterbore'; diameter: number; depth: number }
  /** `angle` is the included angle of the cone, radians (90 degrees for ISO 10642). */
  | { type: 'countersink'; diameter: number; angle: number };

export interface HoleInput extends Scoped {
  kind: 'hole';
  id: string;
  /** The sketch plane; holes are drilled against its normal (into a face it lies on). */
  frame: Frame;
  /** Sketch points, by sketch entity id, in frame coordinates. */
  points: readonly { id: string; at: Vec2 }[];
  diameter: number;
  /**
   * `blind`: `depth` to the shoulder, plus a drill point of `tipAngle`
   * (default 118 degrees). `throughAll`: through the whole body, flat bottom.
   */
  extent: { type: 'blind'; depth: number; tipAngle?: number } | { type: 'throughAll' };
  head: HoleHead;
  /** Drill along the sketch normal instead. */
  reverse?: boolean;
}

/** Features that make a tool solid: what patterns and mirrors can repeat. */
export type ToolInput = ExtrudeInput | RevolveInput | HoleInput;

/**
 * What a pattern or mirror repeats: the tools of some features (rebuilt, moved,
 * and combined with each feature's own mode and scope), or the bodies in the
 * pattern's scope. Copies of bodies are fused with the bodies they touch
 * (`add`, the default: what a one-body part did) or become bodies of their
 * own (`new`).
 */
export type InstanceSource =
  { type: 'features'; features: readonly ToolInput[] } | { type: 'body'; mode?: 'new' | 'add' };

/** The most instances a pattern may have, the original included. Core validates the same limit. */
export const MAX_PATTERN_COUNT = 1000;

export type PatternLayout =
  | {
      type: 'linear';
      /**
       * A vector, or a straight edge or planar face (its outward normal) of the
       * body. An edge runs the way `orientedGeometry` documents; `flip` turns
       * a referenced direction round.
       */
      direction: Vec3 | { ref: TopoRef; flip?: boolean };
      /** Instances including the original, 1 to `MAX_PATTERN_COUNT`. */
      count: number;
      /** Distance between neighbouring instances, mm. */
      spacing: number;
    }
  | {
      type: 'circular';
      /**
       * An axis, or a straight or circular edge or a cylindrical or conical
       * face, oriented as `orientedGeometry` documents (it matters for a
       * partial angle); `flip` turns a referenced axis round.
       */
      axis: Axis | { ref: TopoRef; flip?: boolean };
      count: number;
      /**
       * The angle the instances spread over, radians. A full turn (2 pi)
       * spaces them evenly round it; less puts the last instance at `angle`.
       */
      angle: number;
    };

export interface PatternInput extends Scoped {
  kind: 'pattern';
  id: string;
  source: InstanceSource;
  layout: PatternLayout;
}

export interface MirrorInput extends Scoped {
  kind: 'mirror';
  id: string;
  source: InstanceSource;
  /** A plane, or a planar face of the body. */
  plane: Plane | FaceRef;
}

/**
 * A shape read from a STEP file, combined with the body by `mode` like an
 * extrusion. Its faces are named `<id>:face:<n>` in the file's face order:
 * imported topology has no history, so every such name is fragile.
 */
export interface ImportInput extends MakesBody {
  kind: 'import';
  id: string;
  /** The STEP file: its bytes, or base64 text of them (as the document stores it). */
  step: Uint8Array | string;
  mode: ResultMode;
}

/**
 * Bodies of another part (a derived part's source, which regen builds first in this same
 * kernel), copied into this one and combined by `mode` like an import. Each copy is rotated by
 * `rotation` (angles in radians about the fixed x, y and z axes, in that order, about the
 * origin), then moved by `translation`. A copy's body id is `<id>:from/<source body id>`, and
 * every face name and lineage entry is read through `derivedName` (`<id>:from/<source name>`).
 * The sources are not bodies of this part: they are read, never changed or released.
 */
export interface DeriveInput extends Scoped {
  kind: 'derive';
  id: string;
  /** The source bodies, in the order to derive them: their ids in the source and live named shapes. */
  sources: readonly FeatureBody[];
  rotation: Vec3;
  translation: Vec3;
  mode: ResultMode;
}

export type FeatureInput =
  | ExtrudeInput
  | RevolveInput
  | FilletInput
  | ChamferInput
  | ShellInput
  | HoleInput
  | PatternInput
  | MirrorInput
  | ImportInput
  | DeriveInput;

export type FeatureKind = FeatureInput['kind'];

// Outcome -------------------------------------------------------------------------

export type FeatureErrorCode =
  /** A reference no longer resolves: `missing` lists the names that are gone. */
  | 'lost'
  /** A reference matches several faces or edges: `candidates` lists them. */
  | 'ambiguous'
  /** The input is malformed or out of range. */
  | 'invalid'
  /** The feature needs a body and there is none (or the body has no names). */
  | 'no-body'
  /** OCCT refused the operation. */
  | 'kernel'
  /** OCCT returned a shape that fails `BRepCheck_Analyzer`. */
  | 'invalid-shape'
  /** The result has no solid left (a cut or intersection removed everything). */
  | 'empty'
  /** A result face that no history reached: the naming scheme cannot name it. */
  | 'unnamed'
  /** The feature cannot do this (yet). */
  | 'unsupported';

export interface FeatureError {
  featureId: string;
  code: FeatureErrorCode;
  message: string;
  /** The reference that failed: its id (`r1`), or the field that holds it (`extent`, `axis`). */
  ref?: string;
  /** The reference as a readable name. */
  target?: string;
  missing?: string[];
  candidates?: string[];
  occtMessage?: string;
}

/** A reference that resolved, and how. */
export interface ResolvedRef {
  ref: string;
  target: string;
  kind: 'face' | 'edge';
  index: number;
  via: Via;
  fragile: boolean;
}

/**
 * Something the user should look at; the feature still succeeded.
 *
 * - `reference`: a resolution that is anything but an exact, non-fragile
 *   match (T0.5 recommendation 3). `via: 'ends'` means the end faces
 *   changed; `fragile` means the choice rests on a positional name or ordinal.
 * - `missed`: pattern instances or a mirror image of a subtracting feature
 *   that do not touch the body, so they changed nothing (`instances` lists
 *   their prefixes, `pattern#3:i4`, `mirror#2:image`).
 * - `direction`: no naming rule could orient the direction of a reference
 *   (a symmetric case), so OCCT's order chose it and an edit may flip it;
 *   set `flip` if it points the wrong way.
 * - `detached`: an added solid touches no body in scope, so it became a body
 *   of its own (`bodies` lists their ids).
 */
export type FeatureWarning =
  | (ResolvedRef & { featureId: string; code: 'reference'; message: string })
  | { featureId: string; code: 'missed'; message: string; instances: string[] }
  | { featureId: string; code: 'direction'; message: string; ref: string; target: string }
  | { featureId: string; code: 'detached'; message: string; bodies: string[] };

/** A body after a feature. */
export interface OutcomeBody extends FeatureBody {
  /**
   * Names of `shape`, indexed like its topology. Null only when an input
   * body was not a live named shape (the feature then fails with `no-body`).
   */
  names: Names | null;
  /** How many solids the body holds: a cut can leave it in several pieces. */
  solids: number;
}

export interface FeatureOutcome {
  featureId: string;
  kind: string;
  ok: boolean;
  /**
   * The part's bodies after the feature, in creator order: a new body comes
   * last, a merged body keeps the place of the first body merged into it.
   * The input bodies, unchanged, when the feature failed.
   */
  bodies: OutcomeBody[];
  /** Ids of the bodies this feature made. */
  created: string[];
  /** Ids of existing bodies this feature gave a new shape. */
  changed: string[];
  /** Ids of input bodies merged into another one: they end here. */
  consumed: string[];
  errors: FeatureError[];
  warnings: FeatureWarning[];
  resolved: ResolvedRef[];
}

// Engine --------------------------------------------------------------------------

interface Body extends NamedShape {
  id: string;
  shape: ShapeId;
}

/** A shape with names for its faces, not yet attached. */
interface Made {
  shape: ShapeId;
  faces: FaceName[];
  topology: Topology;
  unnamed: number[];
}

interface Tool extends Made {
  mode: ResultMode;
}

/** A tool, with the id of the body it becomes when it stays on its own (`new`, or a detached `add`). */
interface Placed extends Made {
  bodyId: string;
}

/** A body while a feature runs. */
interface Slot {
  body: Body;
  /** The body's new shape, not yet attached; null while it is the input body, unchanged. */
  made: Made | null;
  /** Made by this feature. */
  created: boolean;
}

class FeatureFailed extends Error {
  constructor(readonly errors: FeatureError[]) {
    super(errors.map((e) => e.message).join('; '));
  }
}

interface Box {
  min: Vec3;
  max: Vec3;
}

interface Ctx {
  k: Kernel;
  id: string;
  /** Shapes to release when the feature is done (never the result). */
  temps: ShapeId[];
  resolved: ResolvedRef[];
  warnings: FeatureWarning[];
  /** Bounding boxes and solid counts by shape id, computed once per feature. */
  boxes: Map<ShapeId, Box | null>;
  solids: Map<ShapeId, number>;
}

const TWO_PI = 2 * Math.PI;

/**
 * Apply one feature to the part's `bodies` (none before the first feature),
 * in creator order. Never throws for a failing feature; see `FeatureOutcome`.
 * Throws `KernelError` with code `fatal` only when the wasm instance is lost.
 */
export function applyFeature(
  k: Kernel,
  bodies: readonly FeatureBody[],
  input: FeatureInput,
): FeatureOutcome {
  const featureId = typeof input?.id === 'string' ? input.id : '';
  const kind = typeof input?.kind === 'string' ? input.kind : '';
  const ctx: Ctx = {
    k,
    id: featureId,
    temps: [],
    resolved: [],
    warnings: [],
    boxes: new Map(),
    solids: new Map(),
  };
  const given = Array.isArray(bodies) ? bodies : [];
  const pass = (errors: FeatureError[]): FeatureOutcome => ({
    featureId,
    kind,
    ok: errors.length === 0,
    bodies: given.map((b) => {
      const named = typeof b?.shape === 'number' && k.has(b.shape) ? k.named(b.shape) : null;
      return {
        id: b?.id,
        shape: b?.shape,
        names: named?.names ?? null,
        solids: named === null ? 0 : solidsOf(ctx, b.shape),
      };
    }),
    created: [],
    changed: [],
    consumed: [],
    errors,
    warnings: ctx.warnings,
    resolved: ctx.resolved,
  });

  const invalid = validateFeature(input) ?? validateBodies(bodies);
  if (invalid !== null) return pass([{ featureId, code: 'invalid', message: invalid }]);
  const slots: Slot[] = [];
  for (const b of given) {
    const named = k.has(b.shape) ? k.named(b.shape) : null;
    if (named === null) {
      return pass([
        {
          featureId,
          code: 'no-body',
          message: k.has(b.shape)
            ? `body ${b.id} (shape ${b.shape}) has no names: bodies must come from feature operations`
            : `unknown shape id ${b.shape} (body ${b.id})`,
        },
      ]);
    }
    slots.push({ body: { id: b.id, shape: b.shape, ...named }, made: null, created: false });
  }

  const keep = new Set<ShapeId>();
  try {
    const after = run(ctx, slots, input) ?? slots;
    for (const slot of after) {
      if (slot.made === null) continue;
      // A placeholder can be carried (and prefixed) by later steps of the
      // feature, so the names are checked as well as the list: `?` is reserved
      // in ids, so a name containing it was never given by a feature.
      const made = slot.made;
      const placeholders = made.faces.flatMap((f, i) => (isUnnamed(f.name) ? [i + 1] : []));
      if (made.unnamed.length > 0 || placeholders.length > 0) {
        const count = Math.max(made.unnamed.length, placeholders.length);
        const where = placeholders.length > 0 ? ` (faces ${placeholders.join(', ')})` : '';
        const of = after.length > 1 ? ` of ${slot.body.id}` : '';
        throw new FeatureFailed([
          {
            featureId,
            code: 'unnamed',
            message: `the result${of} has ${count} face(s) no history named${where}`,
          },
        ]);
      }
    }
    const out: OutcomeBody[] = after.map((slot) => {
      const { id, shape } = slot.body;
      if (slot.made !== null) {
        k.setNames(shape, { names: slot.body.names, topology: slot.body.topology });
      }
      return { id, shape, names: slot.body.names, solids: solidsOf(ctx, shape) };
    });
    // The results are the shapes that are not released.
    for (const slot of after) if (slot.made !== null) keep.add(slot.made.shape);
    const ids = new Set(after.map((s) => s.body.id));
    return {
      featureId,
      kind,
      ok: true,
      bodies: out,
      created: after.filter((s) => s.created).map((s) => s.body.id),
      changed: after.filter((s) => !s.created && s.made !== null).map((s) => s.body.id),
      consumed: given.filter((b) => !ids.has(b.id)).map((b) => b.id),
      errors: [],
      warnings: ctx.warnings,
      resolved: ctx.resolved,
    };
  } catch (error) {
    keep.clear();
    if (error instanceof FeatureFailed) return pass(error.errors);
    if (error instanceof KernelError) {
      if (error.code === 'fatal') throw error;
      const e: FeatureError = {
        featureId,
        code: error.code === 'invalid-argument' ? 'invalid' : 'kernel',
        message: error.message,
      };
      if (error.occtMessage !== undefined) e.occtMessage = error.occtMessage;
      return pass([e]);
    }
    return pass([
      {
        featureId,
        code: 'kernel',
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  } finally {
    if (k.lostReason === null) {
      for (const id of new Set(ctx.temps)) if (!keep.has(id)) k.release(id);
    }
  }
}

/** Why a body set is malformed, or null. */
function validateBodies(bodies: unknown): string | null {
  if (!Array.isArray(bodies)) return 'bodies must be an array';
  const seen = new Set<string>();
  for (const [i, b] of (bodies as unknown[]).entries()) {
    if (!isObj(b) || typeof b.id !== 'string' || b.id.length === 0) {
      return `bodies[${i}] must have a non-empty id`;
    }
    if (typeof b.shape !== 'number' || !Number.isInteger(b.shape)) {
      return `bodies[${i}] (${b.id}) must have a shape id`;
    }
    if (seen.has(b.id)) return `body id ${b.id} is used twice`;
    seen.add(b.id);
  }
  return null;
}

function run(ctx: Ctx, slots: readonly Slot[], input: FeatureInput): Slot[] | null {
  switch (input.kind) {
    case 'extrude':
    case 'revolve': {
      const scoped = inScope(ctx, slots, input.scope);
      const tool = buildTool(ctx, slots, scoped, input);
      return combine(ctx, slots, scoped, [{ ...tool, bodyId: input.body ?? input.id }], tool.mode);
    }
    case 'hole': {
      const scoped = needBodies(ctx, inScope(ctx, slots, input.scope));
      const tool = buildTool(ctx, slots, scoped, input);
      const after = combine(ctx, slots, scoped, [{ ...tool, bodyId: input.id }], 'subtract');
      missedHoles(ctx, input, after);
      return after;
    }
    case 'fillet':
      return fillet(ctx, needBodies(ctx, slots), input);
    case 'chamfer':
      return chamfer(ctx, needBodies(ctx, slots), input);
    case 'shell':
      return shell(ctx, needBodies(ctx, slots), input);
    case 'pattern':
      return pattern(ctx, needBodies(ctx, slots), input);
    case 'mirror':
      return mirror(ctx, needBodies(ctx, slots), input);
    case 'import': {
      const scoped = inScope(ctx, slots, input.scope);
      const tool = importTool(ctx, input);
      return combine(ctx, slots, scoped, [{ ...tool, bodyId: input.body ?? input.id }], input.mode);
    }
    case 'derive': {
      const scoped = inScope(ctx, slots, input.scope);
      return combine(ctx, slots, scoped, deriveTools(ctx, input), input.mode);
    }
  }
}

/**
 * The derived copies: each source body transformed by the placement, its names carried through
 * the transform's history and then prefixed (`deriveFaces`). A source that is not a live named
 * shape fails the feature with `no-body` on `sources`: regen reads that as a shape lost to a
 * recycle, never as a missing body of the part.
 */
function deriveTools(ctx: Ctx, input: DeriveInput): Placed[] {
  const { k } = ctx;
  const motions: Transform[] = [];
  const axes: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  input.rotation.forEach((angle, i) => {
    if (angle !== 0) {
      motions.push({ kind: 'rotate', axis: { origin: [0, 0, 0], direction: axes[i]! }, angle });
    }
  });
  // Always last, even when zero: the copy is a new shape, so the source keeps its own names.
  motions.push({ kind: 'translate', vector: input.translation });
  return input.sources.map((source) => {
    const named = k.has(source.shape) ? k.named(source.shape) : null;
    if (named === null) {
      fail(
        ctx,
        'no-body',
        k.has(source.shape)
          ? `source body ${source.id} (shape ${source.shape}) has no names`
          : `unknown shape id ${source.shape} (source body ${source.id})`,
        { ref: 'sources', target: source.id },
      );
    }
    let made: Made = {
      shape: source.shape,
      faces: named.names.faces,
      topology: named.topology,
      unnamed: [],
    };
    for (const motion of motions) {
      const moved = temp(ctx, k.transform(made.shape, motion));
      made = propagated(ctx, moved.shape, [made.faces], moved.history);
    }
    return {
      ...made,
      faces: deriveFaces(made.faces, input.id),
      bodyId: `${input.id}:from/${source.id}`,
    };
  });
}

/** The imported shape, every face named by its position in the file. */
function importTool(ctx: Ctx, input: ImportInput): Made {
  const { k } = ctx;
  const shape = temp(ctx, { shape: k.importStep(input.step) }).shape;
  const topology = k.topology(shape);
  if (topology.faces.length === 0) fail(ctx, 'invalid', 'the STEP file has no faces');
  return {
    shape,
    faces: topology.faces.map((f) => importedFace(input.id, f.index)),
    topology,
    unnamed: [],
  };
}

function fail(
  ctx: Ctx,
  code: FeatureErrorCode,
  message: string,
  extra: Partial<FeatureError> = {},
): never {
  throw new FeatureFailed([{ featureId: ctx.id, code, message, ...extra }]);
}

function needBodies<T>(ctx: Ctx, bodies: readonly T[]): readonly T[] {
  if (bodies.length === 0) fail(ctx, 'no-body', `${ctx.id} needs a body`);
  return bodies;
}

/** The bodies a feature's scope names, in creator order; every body when it has none. */
function inScope(ctx: Ctx, slots: readonly Slot[], scope: readonly string[] | undefined): Slot[] {
  if (scope === undefined) return [...slots];
  const missing = scope.filter((id) => !slots.some((s) => s.body.id === id));
  if (missing.length > 0) {
    fail(
      ctx,
      'lost',
      `${ctx.id} acts on ${missing.join(', ')}, which ${missing.length === 1 ? 'is not a body' : 'are not bodies'} at this point`,
      { ref: 'scope', target: missing.join(', '), missing },
    );
  }
  return slots.filter((s) => scope.includes(s.body.id));
}

function bodiesOf(slots: readonly Slot[]): Body[] {
  return slots.map((s) => s.body);
}

function temp<T extends { shape: ShapeId }>(ctx: Ctx, made: T): T {
  ctx.temps.push(made.shape);
  return made;
}

/** A made shape as a body: named, not yet attached. */
function bodyOf(id: string, made: Made): Body {
  return {
    id,
    shape: made.shape,
    names: nameShape(made.faces, made.topology),
    topology: made.topology,
  };
}

function changedSlot(slot: Slot, made: Made): Slot {
  return { body: bodyOf(slot.body.id, made), made, created: slot.created };
}

function boxOf(ctx: Ctx, shape: ShapeId): Box | null {
  let box = ctx.boxes.get(shape);
  if (box === undefined) {
    box = ctx.k.properties(shape).boundingBox;
    ctx.boxes.set(shape, box);
  }
  return box;
}

function solidsOf(ctx: Ctx, shape: ShapeId): number {
  let n = ctx.solids.get(shape);
  if (n === undefined) {
    n = ctx.k.solids(shape);
    ctx.solids.set(shape, n);
  }
  return n;
}

/** Whether two bounding boxes meet: shapes whose boxes do not can never touch. */
function overlaps(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return false;
  const tol = 1e-6;
  return [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! + tol && b.min[i]! <= a.max[i]! + tol);
}

// References ------------------------------------------------------------------------

interface Hit {
  body: Body;
  index: number;
}

/**
 * Resolve references against the names of every body; every failure is
 * collected, then they all fail the feature together. Names are unique
 * across a part's bodies, so a reference finds at most one body; one whose
 * names lie on two bodies (an edge between faces of different bodies) is
 * `invalid`.
 */
function resolveAll(
  ctx: Ctx,
  bodies: readonly Body[],
  refs: readonly { id: string; ref: TopoRef }[],
): Hit[] {
  const errors: FeatureError[] = [];
  const out: Hit[] = [];
  for (const { id, ref } of refs) {
    const target = refName(ref);
    const r = resolveOnBodies(bodies, ref);
    if ('spans' in r) {
      errors.push({
        featureId: ctx.id,
        code: 'invalid',
        message: `${target} spans bodies ${r.spans.join(' and ')}: a reference must lie on one body`,
        ref: id,
        target,
      });
      continue;
    }
    if (!r.resolution.ok) {
      errors.push(refError(ctx, id, target, r.resolution));
      continue;
    }
    record(ctx, id, target, 'face' in ref ? 'face' : 'edge', r.resolution);
    out.push({ body: r.body!, index: r.resolution.index });
  }
  if (errors.length > 0) throw new FeatureFailed(errors);
  return out;
}

function resolveOnBodies(
  bodies: readonly Body[],
  ref: TopoRef,
): { resolution: Resolution; body?: Body } | { spans: string[] } {
  const results = bodies.map((body) => ({ body, r: resolve(body.names, body.topology, ref) }));
  const found = results.filter((x) => x.r.ok);
  const exact = found.filter((x) => x.r.ok && x.r.via === 'exact');
  const pick = found.length === 1 ? found[0] : exact.length === 1 ? exact[0] : undefined;
  if (pick !== undefined) return { resolution: pick.r, body: pick.body };
  if (found.length > 1) {
    const kind = 'face' in ref ? 'faces' : 'edges';
    const candidates = found
      .map((x) => (x.r.ok ? (x.body.names[kind][x.r.index - 1]?.name ?? '') : ''))
      .sort();
    return { resolution: { ok: false, status: 'ambiguous', candidates } };
  }
  const ambiguous = results.flatMap((x) => (!x.r.ok && x.r.status === 'ambiguous' ? [x.r] : []));
  if (ambiguous.length > 0) {
    const candidates = [...new Set(ambiguous.flatMap((a) => a.candidates))].sort();
    return { resolution: { ok: false, status: 'ambiguous', candidates } };
  }
  const lost = results.map((x) => (!x.r.ok && x.r.status === 'lost' ? x.r.missing : []));
  if (lost.length === 0) {
    return { resolution: { ok: false, status: 'lost', missing: refNames(ref) } };
  }
  // Names missing from every body are gone; when each body has some of them
  // but none has all, the reference spans bodies.
  const gone = lost.reduce((a, m) => a.filter((n) => m.includes(n)));
  if (gone.length === 0 && lost.every((m) => m.length > 0) && bodies.length > 1) {
    const owners = results.filter((_, i) => lost[i]!.length < refNames(ref).length);
    return { spans: owners.map((x) => x.body.id) };
  }
  return { resolution: { ok: false, status: 'lost', missing: gone } };
}

/** The names a reference is written in. */
function refNames(ref: TopoRef): string[] {
  return 'face' in ref ? [ref.face] : [...ref.faces, ...(ref.ends ?? [])];
}

function resolveOne(ctx: Ctx, bodies: readonly Body[], id: string, ref: TopoRef): Hit {
  return resolveAll(ctx, bodies, [{ id, ref }])[0]!;
}

function refError(
  ctx: Ctx,
  id: string,
  target: string,
  r: Extract<Resolution, { ok: false }>,
): FeatureError {
  const e: FeatureError = {
    featureId: ctx.id,
    code: r.status,
    message: describeFailure(target, r),
    ref: id,
    target,
  };
  if (r.status === 'lost') e.missing = r.missing;
  else e.candidates = r.candidates;
  return e;
}

function record(
  ctx: Ctx,
  id: string,
  target: string,
  kind: 'face' | 'edge',
  r: Extract<Resolution, { ok: true }>,
): void {
  const resolved: ResolvedRef = {
    ref: id,
    target,
    kind,
    index: r.index,
    via: r.via,
    fragile: r.fragile,
  };
  ctx.resolved.push(resolved);
  if (r.via === 'exact' && !r.fragile) return;
  const how: Record<Via, string> = {
    exact: 'by name',
    descendant: 'to a piece or merge of what it named',
    ancestor: 'to the whole face of the piece it named',
    ends: 'by its end faces, which changed',
    ordinal: 'by position among equal edges',
  };
  const note = r.fragile ? '; the name is positional, so an edit can move it' : '';
  ctx.warnings.push({
    ...resolved,
    featureId: ctx.id,
    code: 'reference',
    message: `${target} resolved ${how[r.via]}${note}: check it still points at the intended geometry`,
  });
}

/**
 * The geometry of a referenced face or edge of any body, its direction
 * oriented by names (`orientedGeometry`) and turned round when `flip` is set.
 * `directed`: the caller uses which way it points, so a direction no rule
 * could orient is worth a warning.
 */
function geometryOf(
  ctx: Ctx,
  bodies: readonly Body[],
  id: string,
  ref: TopoRef,
  accept: readonly SubShapeGeometry['kind'][],
  options: { flip?: boolean; directed?: boolean } = {},
): SubShapeGeometry {
  const { body, index } = resolveOne(ctx, needBodies(ctx, bodies), id, ref);
  const kind = 'face' in ref ? 'face' : 'edge';
  const raw = ctx.k.geometry(body.shape, { kind, index });
  if (raw === null || !accept.includes(raw.kind)) {
    fail(ctx, 'invalid', `${refName(ref)} is not a ${accept.join(' or ')} ${kind}`, {
      ref: id,
      target: refName(ref),
    });
  }
  const oriented = orientedGeometry(body.names, body.topology, kind, index, raw);
  if (oriented === null && options.directed) {
    ctx.warnings.push({
      featureId: ctx.id,
      code: 'direction',
      ref: id,
      target: refName(ref),
      message: `no naming rule orients ${refName(ref)}, so an edit may turn its direction round: check it, and set flip if it points the wrong way`,
    });
  }
  const g = oriented ?? raw;
  return options.flip ? { ...g, direction: scale(g.direction, -1) } : g;
}

const ORIENT_TOL = 1e-6;

/**
 * Orient the direction of a face's or edge's geometry by names, so it never
 * depends on the order OCCT stores faces and edges in, which an unrelated
 * upstream edit (a sketch started at another corner, a hole) changes:
 *
 * - a straight edge between two planar faces that are not parallel runs
 *   along `nA x nB`, the outward normals of its faces, A being the face whose
 *   name sorts first (a block's top front edge, `cap:end|side:e1`, runs
 *   `+z x -y = +x`);
 * - any other straight edge (a seam, an edge on a curved face, tangent
 *   faces) runs toward the end vertex of the first end face by name that
 *   touches only one end (end faces: at a vertex of the edge, not on it);
 * - a circle edge's normal points toward the first of its faces, by name,
 *   whose centroid lies off the circle's plane;
 * - a cylinder's or cone's axis points toward the first neighbouring face,
 *   by name, at one of its ends: every vertex and midpoint of the edges the
 *   neighbour shares with it lies on one side of the plane through the face's
 *   centroid square to the axis (a hole wall's axis points to whichever of its
 *   rims' faces sorts first; a fillet round's to the first of the faces at its
 *   ends, never to the faces it is tangent to, which run its whole length);
 * - a plane's normal is its outward normal, which needs no rule.
 *
 * Names compare by code unit. Returns null when no rule decides (every
 * candidate is symmetric about the edge or face); the caller falls back to
 * OCCT's direction.
 */
export function orientedGeometry(
  names: Names,
  topology: Topology,
  kind: 'face' | 'edge',
  index: number,
  g: SubShapeGeometry,
): SubShapeGeometry | null {
  const nameOf = (f: number) => names.faces[f - 1]?.name ?? '';
  const byName = (faces: Iterable<number>) =>
    [...new Set(faces)].sort((p, q) =>
      nameOf(p) < nameOf(q) ? -1 : nameOf(p) > nameOf(q) ? 1 : 0,
    );
  const toward = (t: number): SubShapeGeometry =>
    t > 0 ? g : { ...g, direction: scale(g.direction, -1) };
  const byCentroid = (faces: readonly number[], origin: Vec3): SubShapeGeometry | null => {
    for (const f of faces) {
      const t = dot(sub(topology.faces[f - 1]!.centroid, origin), g.direction);
      if (Math.abs(t) > ORIENT_TOL) return toward(t);
    }
    return null;
  };
  if (kind === 'edge') {
    const edge = topology.edges[index - 1];
    if (edge === undefined) return null;
    if (g.kind === 'circle') return byCentroid(byName(edge.faces), g.origin);
    if (g.kind !== 'line') return g;
    if (edge.faces.length === 2) {
      const [a, b] = byName(edge.faces);
      const na = topology.faces[a! - 1]!.normal;
      const nb = topology.faces[b! - 1]!.normal;
      if (na !== null && nb !== null) {
        const c = cross(na, nb);
        if (norm(c) > ORIENT_TOL) return toward(dot(c, g.direction));
      }
    }
    const own = new Set(edge.faces);
    const around = (v: number) => topology.vertices[v - 1]!.faces;
    const ends = byName(edge.vertices.flatMap(around).filter((f) => !own.has(f)));
    for (const f of ends) {
      const at = edge.vertices.filter((v) => around(v).includes(f));
      if (at.length !== 1) continue;
      const t = dot(sub(topology.vertices[at[0]! - 1]!.point, edge.midpoint), g.direction);
      if (Math.abs(t) > ORIENT_TOL) return toward(t);
    }
    return null;
  }
  if (g.kind !== 'cylinder' && g.kind !== 'cone') return g;
  // Only a neighbour at one end of the face decides: every vertex and
  // midpoint of the edges it shares with the face lies on one side of the
  // plane through the face's centroid square to the axis. A neighbour along
  // the face's length (a face a fillet round is tangent to) straddles that
  // plane, and its centroid moves with unrelated edits.
  const centre = topology.faces[index - 1]!.centroid;
  const own = topology.edges.filter((e) => e.faces.includes(index));
  const neighbours = byName(own.flatMap((e) => e.faces).filter((f) => f !== index));
  for (const f of neighbours) {
    const points = own
      .filter((e) => e.faces.includes(f))
      .flatMap((e) => [e.midpoint, ...e.vertices.map((v) => topology.vertices[v - 1]!.point)]);
    const ts = points.map((p) => dot(sub(p, centre), g.direction));
    if (ts.every((t) => t > ORIENT_TOL)) return toward(1);
    if (ts.every((t) => t < -ORIENT_TOL)) return toward(-1);
  }
  return null;
}

// Tools: extrude, revolve, hole ------------------------------------------------------

/**
 * Build a feature's tool solid where the feature puts it. References resolve
 * on any body; lengths measured against the body (through all) are measured
 * against the bodies in the feature's scope. `motion`: the tool is for a
 * pattern instance or mirror image that `motion` will move, so those lengths
 * are measured from where the copy will be, not from the original.
 */
function buildTool(
  ctx: Ctx,
  slots: readonly Slot[],
  scoped: readonly Slot[],
  input: ToolInput,
  motion?: Transform,
): Tool {
  const all = bodiesOf(slots);
  const targets = bodiesOf(scoped);
  switch (input.kind) {
    case 'extrude':
      return extrudeTool(ctx, all, targets, input, motion);
    case 'revolve':
      return revolveTool(ctx, all, input);
    case 'hole':
      return holeTool(ctx, targets, input, motion);
  }
}

function extrudeTool(
  ctx: Ctx,
  all: readonly Body[],
  scoped: readonly Body[],
  input: ExtrudeInput,
  motion?: Transform,
): Tool {
  const { k } = ctx;
  const frame = input.profile.frame;
  const n = unit(frame.normal);
  const dir: Vec3 = input.reverse ? scale(n, -1) : n;
  // Where the tool will be: its start and direction after `motion`.
  const at = motion ? movePoint(frame.origin, motion) : frame.origin;
  const toward = motion ? moveVector(dir, motion) : dir;
  let start = frame.origin;
  let length: number;
  const extent = input.extent;
  switch (extent.type) {
    case 'blind':
      length = extent.distance;
      break;
    case 'symmetric':
      length = extent.distance;
      start = add(frame.origin, scale(dir, -extent.distance / 2));
      break;
    case 'throughAll':
      length = throughLength(ctx, needBodies(ctx, scoped), at, toward, 'extent');
      break;
    case 'upToFace': {
      const plane = geometryOf(ctx, all, 'extent', extent.face, ['plane']);
      const along = dot(toward, plane.direction);
      if (Math.abs(along) < 1e-9) {
        fail(ctx, 'invalid', `${extent.face.face} is parallel to the extrusion direction`, {
          ref: 'extent',
          target: extent.face.face,
        });
      }
      length = dot(sub(plane.origin, at), plane.direction) / along;
      if (!(length > 1e-9)) {
        fail(ctx, 'invalid', `${extent.face.face} is not ahead of the sketch plane`, {
          ref: 'extent',
          target: extent.face.face,
        });
      }
      break;
    }
  }
  if (!(length > 0)) fail(ctx, 'invalid', 'the extrusion distance must be positive');
  const profile = temp(ctx, { shape: k.profile({ ...frame, origin: start }, input.profile.loops) });
  const prism = temp(ctx, k.extrude(profile.shape, scale(dir, length)));
  const topology = k.topology(prism.shape);
  const born = nameSweep(input.id, prism, topology);
  let made: Made = { shape: prism.shape, faces: born.faces, topology, unnamed: born.unnamed };
  if (input.draft !== undefined && input.draft !== 0) {
    const sides = Object.values(prism.sideIds);
    const drafted = temp(
      ctx,
      k.draft(prism.shape, sides, dir, input.draft, { origin: frame.origin, normal: dir }),
    );
    const after = propagated(ctx, drafted.shape, [made.faces], drafted.history);
    // Faces the sweep could not name stay unnamed through the draft.
    made = { ...after, unnamed: [...after.unnamed, ...made.unnamed] };
  }
  return { ...made, mode: input.mode };
}

function revolveTool(ctx: Ctx, all: readonly Body[], input: RevolveInput): Tool {
  const { k } = ctx;
  let axis: Axis;
  if ('edge' in input.axis) {
    const g = geometryOf(ctx, all, 'axis', input.axis.edge, ['line'], {
      flip: input.axis.flip === true,
      directed: input.angle < TWO_PI - 1e-9,
    });
    axis = { origin: g.origin, direction: g.direction };
  } else {
    axis = input.axis;
  }
  let frame = input.profile.frame;
  if (input.symmetric) frame = rotateFrame(frame, axis, -Math.min(input.angle, TWO_PI) / 2);
  const profile = temp(ctx, { shape: k.profile(frame, input.profile.loops) });
  const made = temp(ctx, k.revolve(profile.shape, axis, input.angle));
  const topology = k.topology(made.shape);
  const born = nameSweep(input.id, made, topology);
  return {
    shape: made.shape,
    faces: born.faces,
    topology,
    unnamed: born.unnamed,
    mode: input.mode,
  };
}

const DEFAULT_TIP = (118 * Math.PI) / 180;

/**
 * One revolved tool per point, from a half cross-section in the plane of the
 * axis. Faces are named `<hole>:<part>:<point id>`: `wall`, `tip` or
 * `bottom`, `cbore` and `cbore-floor`, `csink`, and `top` (on the sketch
 * plane; a cut removes it).
 */
function holeTool(ctx: Ctx, scoped: readonly Body[], input: HoleInput, motion?: Transform): Tool {
  const { k } = ctx;
  const frame = input.frame;
  const n = unit(frame.normal);
  const d: Vec3 = input.reverse ? n : scale(n, -1);
  const x = unit(frame.xDir);
  const y = cross(n, x);
  const r = input.diameter / 2;
  if (!(r > 0)) fail(ctx, 'invalid', 'the hole diameter must be positive');
  const head = input.head;
  // Half section in (u radial, v depth along d), from the axis at the surface.
  const section = (depth: number): { at: Vec2; id: string }[] => {
    const pts: { at: Vec2; id: string }[] = [];
    if (head.type === 'counterbore') {
      const R = head.diameter / 2;
      if (!(R > r)) fail(ctx, 'invalid', 'the counterbore must be wider than the hole');
      if (!(head.depth > 0 && head.depth < depth)) {
        fail(ctx, 'invalid', 'the counterbore depth must be positive and less than the hole depth');
      }
      pts.push({ at: [0, 0], id: 'top' }, { at: [R, 0], id: 'cbore' });
      pts.push({ at: [R, head.depth], id: 'cbore-floor' });
      pts.push({ at: [r, head.depth], id: 'wall' });
    } else if (head.type === 'countersink') {
      const R = head.diameter / 2;
      if (!(R > r)) fail(ctx, 'invalid', 'the countersink must be wider than the hole');
      if (!(head.angle > 0 && head.angle < Math.PI)) {
        fail(ctx, 'invalid', 'the countersink angle must be between 0 and pi');
      }
      const sink = (R - r) / Math.tan(head.angle / 2);
      if (!(sink < depth)) fail(ctx, 'invalid', 'the countersink is deeper than the hole');
      pts.push({ at: [0, 0], id: 'top' }, { at: [R, 0], id: 'csink' });
      pts.push({ at: [r, sink], id: 'wall' });
    } else {
      pts.push({ at: [0, 0], id: 'top' }, { at: [r, 0], id: 'wall' });
    }
    return pts;
  };
  let depth: number;
  let tip = 0;
  if (input.extent.type === 'blind') {
    depth = input.extent.depth;
    if (!(depth > 0)) fail(ctx, 'invalid', 'the hole depth must be positive');
    const angle = input.extent.tipAngle ?? DEFAULT_TIP;
    if (!(angle > 0 && angle < Math.PI))
      fail(ctx, 'invalid', 'the tip angle must be between 0 and pi');
    tip = r / Math.tan(angle / 2);
  } else {
    depth = throughLength(
      ctx,
      needBodies(ctx, scoped),
      motion ? movePoint(frame.origin, motion) : frame.origin,
      motion ? moveVector(d, motion) : d,
      'extent',
    );
  }

  const tools: Made[] = [];
  for (const point of input.points) {
    const origin = add(frame.origin, add(scale(x, point.at[0]), scale(y, point.at[1])));
    const pts = section(depth);
    if (tip > 0) {
      pts.push({ at: [r, depth], id: 'tip' });
      pts.push({ at: [0, depth + tip], id: 'axis' });
    } else {
      pts.push({ at: [r, depth], id: 'bottom' });
      pts.push({ at: [0, depth], id: 'axis' });
    }
    const entities = pts.map((p, i) => ({
      kind: 'line' as const,
      id: p.id,
      start: p.at,
      end: pts[(i + 1) % pts.length]!.at,
    }));
    // The section's plane holds the axis: x radial, y = normal x x = d.
    const sectionFrame: Frame = { origin, xDir: x, normal: cross(x, d) };
    const profile = temp(ctx, { shape: k.profile(sectionFrame, [{ entities }]) });
    const made = temp(ctx, k.revolve(profile.shape, { origin, direction: d }, TWO_PI));
    const topology = k.topology(made.shape);
    const faces: (FaceName | undefined)[] = new Array(topology.faces.length);
    for (const [role, index] of Object.entries(made.sideIds)) {
      faces[index - 1] = bornFace(input.id, role, point.id);
    }
    const unnamed: number[] = [];
    tools.push({
      shape: made.shape,
      topology,
      faces: faces.map((f, i) => {
        if (f) return f;
        unnamed.push(i + 1);
        return bornFace(input.id, `?face${i + 1}`);
      }),
      unnamed,
    });
  }
  if (tools.length === 1) return { ...tools[0]!, mode: 'subtract' };
  // Several points: one compound tool, so the hole combines in one boolean.
  const joined = temp(ctx, k.compound(tools.map((t) => t.shape)));
  const made = propagated(
    ctx,
    joined.shape,
    tools.map((t) => t.faces),
    joined.history,
  );
  return {
    ...made,
    unnamed: [...made.unnamed, ...tools.flatMap((t) => t.unnamed)],
    mode: 'subtract',
  };
}

/** A hole that left no face in any body missed it: an error, not a silent no-op. */
function missedHoles(ctx: Ctx, input: HoleInput, slots: readonly Slot[]): void {
  const lineage = new Set(slots.flatMap((s) => s.made?.faces.flatMap((f) => f.lineage) ?? []));
  const missed = input.points.filter(
    (p) => !HOLE_ROLES.some((role) => lineage.has(`${input.id}:${role}:${p.id}`)),
  );
  if (missed.length > 0) {
    fail(
      ctx,
      'invalid',
      `the hole at ${missed.map((p) => p.id).join(', ')} does not touch the body`,
    );
  }
}

const HOLE_ROLES = ['wall', 'tip', 'bottom', 'cbore', 'cbore-floor', 'csink'];

/**
 * How far from `origin` along `dir` a tool must reach to leave the bodies:
 * past the farthest corner of their bounding box, plus 1 mm. (Offsets within
 * the sketch plane do not change the distance along its normal.)
 */
function throughLength(
  ctx: Ctx,
  bodies: readonly Body[],
  origin: Vec3,
  dir: Vec3,
  field: string,
): number {
  let far = -Infinity;
  for (const body of bodies) {
    const box = boxOf(ctx, body.shape);
    if (box === null) continue;
    for (const cx of [box.min[0], box.max[0]]) {
      for (const cy of [box.min[1], box.max[1]]) {
        for (const cz of [box.min[2], box.max[2]]) {
          far = Math.max(far, dot(sub([cx, cy, cz], origin), dir));
        }
      }
    }
  }
  if (far === -Infinity) fail(ctx, 'no-body', 'the body is empty', { ref: field });
  if (!(far > 1e-9)) {
    fail(ctx, 'invalid', 'the body lies entirely behind the sketch plane', { ref: field });
  }
  return far + 1;
}

// Combining with the bodies ----------------------------------------------------------------

/** The result of an operation on `operands`, with face names carried through its history. */
function propagated(
  ctx: Ctx,
  shape: ShapeId,
  operands: readonly (readonly FaceName[])[],
  history: readonly HistoryEntry[],
  namer?: GeneratedNamer,
): Made {
  const topology = ctx.k.topology(shape);
  const p = propagateFaces(operands, history, topology, namer);
  return { shape, faces: p.faces, topology, unnamed: p.unnamed };
}

/** One boolean of `base` with `tools`, names carried; the tools' unnamed faces stay counted. */
function booleanOf(
  ctx: Ctx,
  kind: 'fuse' | 'cut' | 'common',
  base: { shape: ShapeId; faces: readonly FaceName[] },
  tools: readonly Made[],
): Made {
  const result = temp(
    ctx,
    ctx.k.boolean(
      kind,
      base.shape,
      tools.map((t) => t.shape),
    ),
  );
  const made = propagated(
    ctx,
    result.shape,
    [base.faces, ...tools.map((t) => t.faces)],
    result.history,
  );
  return { ...made, unnamed: [...made.unnamed, ...tools.flatMap((t) => t.unnamed)] };
}

/**
 * Combine tools with the bodies by mode. `new`: each tool becomes a body of
 * its own. `add`: each tool fuses with every body in scope it touches, and
 * bodies one tool joins merge under the id of the first of them; a tool that
 * touches none becomes a body of its own (`detached`). `subtract` and
 * `intersect`: each body in scope a tool reaches is cut, or cut down to the
 * common part. Bodies whose bounding box no tool meets stay out of every
 * boolean and keep their shapes.
 */
function combine(
  ctx: Ctx,
  slots: readonly Slot[],
  scoped: readonly Slot[],
  tools: readonly Placed[],
  mode: ResultMode,
): Slot[] {
  if (mode === 'new') {
    const out = [...slots];
    for (const tool of tools) {
      if (out.some((s) => s.body.id === tool.bodyId)) {
        fail(ctx, 'invalid', `${ctx.id} would make body ${tool.bodyId}, which already exists`);
      }
      out.push({ body: bodyOf(tool.bodyId, tool), made: tool, created: true });
    }
    return out;
  }
  if (scoped.length === 0) fail(ctx, 'no-body', `${ctx.id} (${mode}) needs a body`);
  return mode === 'add'
    ? fuseTools(ctx, slots, scoped, tools)
    : cutTools(ctx, slots, scoped, tools, mode);
}

function fuseTools(
  ctx: Ctx,
  slots: readonly Slot[],
  scoped: readonly Slot[],
  tools: readonly Placed[],
): Slot[] {
  const { k } = ctx;
  const n = scoped.length;
  // Scoped bodies are nodes 0..n-1, tools n..; a tool that touches a body (or
  // a tool that does) joins them.
  const parent = Array.from({ length: n + tools.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const unite = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // The common case, one tool whose box meets one body: that fuse, with
  // history, is the result, so it costs one boolean as a one-body part did.
  let reuse: { shape: ShapeId; history: HistoryEntry[] } | null = null;
  for (const [j, tool] of tools.entries()) {
    const box = boxOf(ctx, tool.shape);
    const near = scoped.flatMap((s, i) => (overlaps(boxOf(ctx, s.body.shape), box) ? [i] : []));
    const once = tools.length === 1 && near.length === 1;
    for (const i of near) {
      const body = scoped[i]!.body;
      const fused = temp(
        ctx,
        k.boolean('fuse', body.shape, [tool.shape], once ? {} : { history: false }),
      );
      // Touching solids fuse into fewer solids than they were.
      if (k.solids(fused.shape) < solidsOf(ctx, body.shape) + solidsOf(ctx, tool.shape)) {
        unite(i, n + j);
        if (once) reuse = fused;
      }
    }
  }
  // Tools that touch each other stay together (a row of overlapping copies);
  // pairs already joined through a body need no test.
  const touch = (a: ShapeId, b: ShapeId): boolean => {
    const fused = temp(ctx, k.boolean('fuse', a, [b], { history: false }));
    return k.solids(fused.shape) < solidsOf(ctx, a) + solidsOf(ctx, b);
  };
  for (let a = 0; a < tools.length; a++) {
    for (let b = a + 1; b < tools.length; b++) {
      if (find(n + a) === find(n + b)) continue;
      if (!overlaps(boxOf(ctx, tools[a]!.shape), boxOf(ctx, tools[b]!.shape))) continue;
      if (touch(tools[a]!.shape, tools[b]!.shape)) unite(n + a, n + b);
    }
  }

  const out: (Slot | null)[] = [...slots];
  const detached: Slot[] = [];
  const groups = new Map<number, { bodies: number[]; tools: number[] }>();
  for (let i = 0; i < n + tools.length; i++) {
    const root = find(i);
    const g = groups.get(root) ?? { bodies: [], tools: [] };
    if (i < n) g.bodies.push(i);
    else g.tools.push(i - n);
    groups.set(root, g);
  }
  for (const g of groups.values()) {
    if (g.tools.length === 0) continue;
    if (g.bodies.length === 0) {
      // Touching no body: one body of its own, under the first tool's id.
      const [tool, ...others] = g.tools.map((j) => tools[j]!);
      const id = tool!.bodyId;
      if (out.some((s) => s?.body.id === id) || detached.some((s) => s.body.id === id)) {
        fail(ctx, 'invalid', `${ctx.id} would make body ${id}, which already exists`);
      }
      let made: Made = tool!;
      if (others.length > 0) {
        // `booleanOf` counts the others' unnamed faces, not its base's.
        const fused = booleanOf(ctx, 'fuse', tool!, others);
        made = { ...fused, unnamed: [...fused.unnamed, ...tool!.unnamed] };
      }
      detached.push({ body: bodyOf(id, made), made, created: true });
      continue;
    }
    // Bodies in creator order, then the tools: the first body's id survives.
    const [first, ...rest] = g.bodies.map((i) => scoped[i]!);
    const operands = [
      ...rest.map((s) => ({ ...s.body, faces: s.body.names.faces, unnamed: [] })),
      ...g.tools.map((j) => tools[j]!),
    ];
    const base = { shape: first!.body.shape, faces: first!.body.names.faces };
    let made: Made;
    const once = reuse as { shape: ShapeId; history: HistoryEntry[] } | null;
    if (once !== null && operands.length === 1) {
      const p = propagated(ctx, once.shape, [base.faces, operands[0]!.faces], once.history);
      made = { ...p, unnamed: [...p.unnamed, ...operands[0]!.unnamed] };
    } else {
      made = booleanOf(ctx, 'fuse', base, operands);
    }
    out[slots.indexOf(first!)] = changedSlot(first!, made);
    for (const s of rest) out[slots.indexOf(s)] = null;
  }
  if (detached.length > 0) {
    const ids = detached.map((s) => s.body.id);
    const one = ids.length === 1;
    ctx.warnings.push({
      featureId: ctx.id,
      code: 'detached',
      bodies: ids,
      message: `${one ? 'the added solid' : 'added solids'} ${ids.join(', ')} ${one ? 'touches' : 'touch'} no body, so ${one ? 'it is a body' : 'they are bodies'} of ${one ? 'its' : 'their'} own`,
    });
  }
  return [...out.filter((s): s is Slot => s !== null), ...detached];
}

function cutTools(
  ctx: Ctx,
  slots: readonly Slot[],
  scoped: readonly Slot[],
  tools: readonly Placed[],
  mode: 'subtract' | 'intersect',
): Slot[] {
  const out = [...slots];
  const toolNames = new Set(tools.flatMap((t) => t.faces.map((f) => f.name)));
  let reached = 0;
  for (const slot of scoped) {
    const body = slot.body;
    const box = boxOf(ctx, body.shape);
    const near = tools.filter((t) => overlaps(box, boxOf(ctx, t.shape)));
    if (near.length === 0) continue;
    const made = booleanOf(
      ctx,
      mode === 'subtract' ? 'cut' : 'common',
      { shape: body.shape, faces: body.names.faces },
      near,
    );
    const faces = made.topology.faces.length;
    if (mode === 'intersect') {
      if (faces === 0) continue;
    } else {
      // A cut that reached the body left a tool face in it, or took a whole solid away.
      const hit =
        faces !== body.topology.faces.length ||
        made.faces.some((f) => f.lineage.some((name) => toolNames.has(name)));
      if (!hit) continue;
      if (faces === 0) fail(ctx, 'empty', `${ctx.id} leaves nothing of ${body.id}`);
    }
    reached++;
    out[slots.indexOf(slot)] = changedSlot(slot, made);
  }
  if (mode === 'intersect' && reached === 0) {
    fail(ctx, 'empty', `${ctx.id} leaves nothing of ${scoped.map((s) => s.body.id).join(', ')}`);
  }
  return out;
}

/** Check a result with `BRepCheck_Analyzer`; an invalid one fails the feature. */
function checked(ctx: Ctx, made: Made): Made {
  if (!ctx.k.isValid(made.shape)) {
    fail(ctx, 'invalid-shape', `${ctx.id} made an invalid solid; OCCT could not do this cleanly`);
  }
  return made;
}

// Fillet, chamfer, shell ----------------------------------------------------------------

/**
 * Name faces a blend generated: from a referenced edge by its reference id,
 * from another edge (OCCT continues a blend along tangent edges) by that
 * edge's two faces, from a vertex (a corner blend) by the faces around it.
 */
function blendNamer(
  ctx: Ctx,
  body: Body,
  role: string,
  refOfEdge: Map<number, string>,
): GeneratedNamer {
  return (entry) => {
    if (entry.input.kind === 'edge') {
      const ref = refOfEdge.get(entry.input.index);
      return `${ctx.id}:${role}:${ref ?? edgeFacesName(body.names.faces, body.topology, entry.input.index)}`;
    }
    if (entry.input.kind === 'vertex') {
      return `${ctx.id}:corner:${vertexName(body.names.faces, body.topology, entry.input.index)}`;
    }
    return null;
  };
}

/**
 * The referenced edges of each body that owns some, by body id: edge index to
 * reference id, in reference order.
 */
function edgesByBody(
  ctx: Ctx,
  slots: readonly Slot[],
  edges: readonly EdgeReference[],
): Map<string, Map<number, string>> {
  const hits = resolveAll(ctx, bodiesOf(slots), edges);
  const out = new Map<string, Map<number, string>>();
  hits.forEach((hit, i) => {
    const id = edges[i]!.id;
    const refOfEdge = out.get(hit.body.id) ?? new Map<number, string>();
    const other = refOfEdge.get(hit.index);
    if (other !== undefined) {
      fail(ctx, 'invalid', `references ${other} and ${id} resolve to the same edge`, { ref: id });
    }
    refOfEdge.set(hit.index, id);
    out.set(hit.body.id, refOfEdge);
  });
  return out;
}

function fillet(ctx: Ctx, slots: readonly Slot[], input: FilletInput): Slot[] {
  const byBody = edgesByBody(ctx, slots, input.edges);
  return slots.map((slot) => {
    const refOfEdge = byBody.get(slot.body.id);
    if (refOfEdge === undefined) return slot;
    const body = slot.body;
    const result = temp(ctx, ctx.k.fillet(body.shape, [...refOfEdge.keys()], input.radius));
    return changedSlot(
      slot,
      checked(
        ctx,
        propagated(
          ctx,
          result.shape,
          [body.names.faces],
          result.history,
          blendNamer(ctx, body, 'round', refOfEdge),
        ),
      ),
    );
  });
}

function chamfer(ctx: Ctx, slots: readonly Slot[], input: ChamferInput): Slot[] {
  const byBody = edgesByBody(ctx, slots, input.edges);
  const byRef = new Map(input.edges.map((e) => [e.id, e]));
  return slots.map((slot) => {
    const refOfEdge = byBody.get(slot.body.id);
    if (refOfEdge === undefined) return slot;
    const body = slot.body;
    const edges = [...refOfEdge].map(([edge, refId]) => {
      if (input.size.kind === 'distance') return { edge };
      const e = byRef.get(refId)!;
      const adjacent = body.topology.edges[edge - 1]!.faces;
      let face: number;
      if (e.face) {
        face = resolveOne(ctx, [body], `${e.id}.face`, e.face).index;
        if (!adjacent.includes(face)) {
          fail(ctx, 'invalid', `${e.face.face} is not a face of ${refName(e.ref)}`, {
            ref: `${e.id}.face`,
            target: e.face.face,
          });
        }
      } else {
        face = [...adjacent].sort((p, q) =>
          body.names.faces[p - 1]!.name < body.names.faces[q - 1]!.name ? -1 : 1,
        )[0]!;
      }
      return { edge, face };
    });
    const result = temp(ctx, ctx.k.chamfer(body.shape, edges, input.size));
    return changedSlot(
      slot,
      checked(
        ctx,
        propagated(
          ctx,
          result.shape,
          [body.names.faces],
          result.history,
          blendNamer(ctx, body, 'bevel', refOfEdge),
        ),
      ),
    );
  });
}

/**
 * Shell: the kept faces keep their names, a removed face's name passes to
 * the rim OCCT makes in its place, and every wall face grown from face X is
 * `<shell>:offset:X`.
 */
function shell(ctx: Ctx, slots: readonly Slot[], input: ShellInput): Slot[] {
  const resolved = resolveAll(ctx, bodiesOf(slots), input.faces);
  // Each body that owns a removed face is shelled; with none, every body is hollowed.
  return slots.map((slot) => {
    const faces = resolved.filter((r) => r.body.id === slot.body.id).map((r) => r.index);
    if (input.faces.length > 0 && faces.length === 0) return slot;
    return changedSlot(slot, shellBody(ctx, slot.body, faces, input));
  });
}

function shellBody(ctx: Ctx, body: Body, faces: readonly number[], input: ShellInput): Made {
  if (new Set(faces).size !== faces.length) fail(ctx, 'invalid', 'a face is removed twice');
  if (faces.length >= body.topology.faces.length) {
    fail(ctx, 'invalid', 'a shell must keep at least one face');
  }
  const outward = input.outward ?? false;
  if (faces.length === 0) return hollow(ctx, body, input.thickness, outward);
  const result = temp(ctx, ctx.k.shell(body.shape, faces, input.thickness, outward));
  const namer: GeneratedNamer = (entry, face) => {
    if (face !== null) return `${ctx.id}:offset:${face.name}`;
    if (entry.input.kind === 'edge') {
      return `${ctx.id}:offset:${edgeFacesName(body.names.faces, body.topology, entry.input.index)}`;
    }
    return `${ctx.id}:offset:${vertexName(body.names.faces, body.topology, entry.input.index)}`;
  };
  const made = checked(
    ctx,
    propagated(ctx, result.shape, [body.names.faces], result.history, namer),
  );
  // OCCT returns the solid unchanged, and valid, when the wall is too thick
  // for the body (T1.8 known-hard corpus): every kept face must have grown a
  // wall, and the volume must have changed.
  const removed = new Set(faces);
  const walls = new Set(made.faces.map((f) => f.name));
  const missing = body.names.faces
    .filter((_, i) => !removed.has(i + 1))
    .filter((f) => !walls.has(`${ctx.id}:offset:${f.name}`))
    .map((f) => f.name);
  const before = ctx.k.properties(body.shape).volume;
  const after = ctx.k.properties(made.shape).volume;
  // The result is the wall alone, inward or outward, so it is never the input volume.
  const changed = Math.abs(after - before) > 1e-9 * Math.max(1, before);
  if (missing.length > 0 || !changed) {
    fail(
      ctx,
      'invalid-shape',
      missing.length > 0
        ? `OCCT could not grow a ${input.thickness} mm wall behind ${missing.join(', ')}: the wall is probably too thick`
        : `OCCT left the body unchanged: a ${input.thickness} mm wall is probably too thick`,
    );
  }
  return made;
}

/**
 * A closed hollow (a shell removing no face): the body minus its inward
 * offset, or the outward offset minus the body. The offset faces are named
 * `<shell>:offset:X` after the face X they were moved from.
 *
 * OCCT's offset can fail silently on filleted bodies (an enlarged solid with
 * no void, or a collapsed sliver, both reported valid), so the offset must
 * grow (outward) or shrink (inward) the volume, its bounding box must contain
 * the body's (inward: be contained by it), and the result's volume must be
 * the difference of the two.
 */
function hollow(ctx: Ctx, body: Body, thickness: number, outward: boolean): Made {
  const { k } = ctx;
  if (!(thickness > 0)) fail(ctx, 'invalid', 'thickness must be positive');
  const refuse = (why: string, extra: Partial<FeatureError> = {}): never =>
    fail(
      ctx,
      'invalid-shape',
      `OCCT could not hollow the body with a ${thickness} mm wall: ${why}`,
      extra,
    );
  // OCCT's offset and the cut after it fail outright on some filleted bodies
  // (T1.8 known-hard corpus): say what to try rather than just "cut failed".
  const occt = <T>(step: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof KernelError) || error.code === 'fatal') throw error;
      return refuse(
        `${step} failed (${error.message}); try another wall thickness, or hollow the body before filleting it`,
        error.occtMessage === undefined ? {} : { occtMessage: error.occtMessage },
      );
    }
  };
  const off = occt(`its ${outward ? 'outward' : 'inward'} offset`, () =>
    temp(ctx, k.offset(body.shape, outward ? thickness : -thickness)),
  );
  const moved = propagated(ctx, off.shape, [body.names.faces], off.history);
  const walls: Made = {
    ...moved,
    faces: moved.faces.map((f) => {
      // A placeholder stays one: the name keeps its `?`.
      const name = `${ctx.id}:offset:${f.name}`;
      return { name, lineage: [name], fragile: f.fragile };
    }),
  };
  const b = k.properties(body.shape);
  const o = k.properties(off.shape);
  if (outward ? !(o.volume > b.volume) : !(o.volume < b.volume && o.volume > 0)) {
    refuse(`its ${outward ? 'outward' : 'inward'} offset did not ${outward ? 'grow' : 'shrink'}`);
  }
  const [outer, inner] = outward ? [o.boundingBox, b.boundingBox] : [b.boundingBox, o.boundingBox];
  if (outer === null || inner === null || !contains(outer, inner, 1e-3)) {
    refuse(`its offset does not ${outward ? 'enclose' : 'fit inside'} the body`);
  }
  const original: Made = { ...body, faces: body.names.faces, unnamed: [] };
  const made = occt(
    `subtracting ${outward ? 'the body from its outward offset' : 'its inward offset'}`,
    () =>
      outward
        ? booleanOf(ctx, 'cut', walls, [original])
        : booleanOf(ctx, 'cut', { shape: body.shape, faces: body.names.faces }, [walls]),
  );
  if (made.topology.faces.length === 0)
    fail(ctx, 'empty', `${ctx.id} leaves nothing of ${body.id}`);
  // `booleanOf` counts only its tools' unnamed faces; outward, the walls are its base.
  const result: Made = outward ? { ...made, unnamed: [...made.unnamed, ...walls.unnamed] } : made;
  const expected = Math.abs(o.volume - b.volume);
  const after = k.properties(result.shape).volume;
  if (!(Math.abs(after - expected) <= 1e-6 * Math.max(o.volume, b.volume))) {
    refuse(
      `the wall's volume is ${after.toPrecision(6)} mm3, not the ${expected.toPrecision(6)} mm3 between the body and its offset`,
    );
  }
  return checked(ctx, result);
}

function contains(
  outer: { min: Vec3; max: Vec3 },
  inner: { min: Vec3; max: Vec3 },
  tol: number,
): boolean {
  return [0, 1, 2].every(
    (i) => outer.min[i]! <= inner.min[i]! + tol && outer.max[i]! >= inner.max[i]! - tol,
  );
}

// Patterns and mirrors ----------------------------------------------------------------------

/**
 * Instances of a pattern are named `<pattern>:i<k>/<source name>` (k from 2;
 * instance 1 is the original, which keeps its names); a mirror image is
 * `<mirror>:image/<source name>`. A copy that becomes a body of its own is
 * named after its instance (`pattern#2:i3`, `mirror#1:image`), followed by
 * `/<source id>` when the pattern copies several bodies or features.
 */
function instances(
  ctx: Ctx,
  slots: readonly Slot[],
  input: PatternInput | MirrorInput,
  motions: readonly { prefix: string; motion: Transform }[],
): Slot[] | null {
  const { k } = ctx;
  if (motions.length === 0) return null;
  const source = input.source;
  if (source.type === 'body') {
    const scoped = needBodies(ctx, inScope(ctx, slots, input.scope));
    const copies: Placed[] = [];
    for (const { prefix, motion } of motions) {
      for (const slot of scoped) {
        const body = slot.body;
        const moved = temp(ctx, k.transform(body.shape, motion));
        const made = propagated(ctx, moved.shape, [body.names.faces], moved.history);
        copies.push({
          ...made,
          faces: prefixFaces(made.faces, prefix),
          bodyId: scoped.length === 1 ? prefix : `${prefix}/${body.id}`,
        });
      }
    }
    return combine(ctx, slots, scoped, copies, source.mode ?? 'add');
  }
  let current: Slot[] = [...slots];
  for (const feature of source.features) {
    if (feature.kind !== 'hole' && feature.mode === 'intersect') {
      fail(
        ctx,
        'unsupported',
        `${feature.id} intersects; only new, add and subtract features can be repeated`,
      );
    }
    const scoped = inScope(ctx, current, feature.scope);
    const copies: Placed[] = [];
    let mode: ResultMode = 'add';
    for (const { prefix, motion } of motions) {
      // Rebuilt per copy: a through-all or up-to-face length is measured from
      // where this copy will be.
      const tool = buildTool(ctx, current, scoped, feature, motion);
      mode = tool.mode;
      const moved = temp(ctx, k.transform(tool.shape, motion));
      const made = propagated(ctx, moved.shape, [tool.faces], moved.history);
      copies.push({
        ...made,
        faces: prefixFaces(made.faces, prefix),
        unnamed: [...made.unnamed, ...tool.unnamed],
        bodyId: source.features.length === 1 ? prefix : `${prefix}/${feature.id}`,
      });
    }
    current = combine(ctx, current, scoped, copies, mode);
    if (mode === 'subtract') missedCopies(ctx, feature, motions, current);
  }
  return current;
}

/**
 * A subtracted copy that left no face in any body missed it and changed
 * nothing: a warning, not an error, since a pattern running partly off the
 * body is often meant (unlike a hole, whose every point is placed by hand).
 * Added copies that touch no body become bodies of their own (`detached`).
 */
function missedCopies(
  ctx: Ctx,
  feature: ToolInput,
  motions: readonly { prefix: string }[],
  slots: readonly Slot[],
): void {
  const lineage = slots.flatMap((s) => s.made?.faces.flatMap((f) => f.lineage) ?? []);
  const missed = motions
    .map((m) => m.prefix)
    .filter((prefix) => !lineage.some((n) => n.includes(`${prefix}/${feature.id}:`)));
  if (missed.length === 0) return;
  ctx.warnings.push({
    featureId: ctx.id,
    code: 'missed',
    instances: missed,
    message: `${missed.join(', ')} of ${feature.id} ${missed.length === 1 ? 'does' : 'do'} not touch the body and ${missed.length === 1 ? 'changes' : 'change'} nothing`,
  });
}

function pattern(ctx: Ctx, slots: readonly Slot[], input: PatternInput): Slot[] | null {
  const all = bodiesOf(slots);
  const layout = input.layout;
  if (!Number.isInteger(layout.count) || layout.count < 1 || layout.count > MAX_PATTERN_COUNT) {
    fail(
      ctx,
      'invalid',
      `the instance count must be a whole number from 1 to ${MAX_PATTERN_COUNT}`,
    );
  }
  const motions: { prefix: string; motion: Transform }[] = [];
  if (layout.type === 'linear') {
    let dir: Vec3;
    if (Array.isArray(layout.direction)) {
      dir = layout.direction as Vec3;
    } else {
      const { ref, flip } = layout.direction as { ref: TopoRef; flip?: boolean };
      const g = geometryOf(ctx, all, 'direction', ref, 'face' in ref ? ['plane'] : ['line'], {
        flip: flip === true,
        directed: true,
      });
      dir = g.direction;
    }
    if (!(norm(dir) > 1e-12)) fail(ctx, 'invalid', 'the pattern direction is a zero vector');
    const u = unit(dir);
    for (let i = 2; i <= layout.count; i++) {
      motions.push({
        prefix: `${input.id}:i${i}`,
        motion: { kind: 'translate', vector: scale(u, (i - 1) * layout.spacing) },
      });
    }
  } else {
    const full = Math.abs(layout.angle - TWO_PI) < 1e-9;
    let axis: Axis;
    if ('ref' in layout.axis) {
      const ref = layout.axis.ref;
      const g = geometryOf(
        ctx,
        all,
        'axis',
        ref,
        'face' in ref ? ['cylinder', 'cone'] : ['line', 'circle'],
        { flip: layout.axis.flip === true, directed: !full },
      );
      axis = { origin: g.origin, direction: g.direction };
    } else {
      axis = layout.axis;
    }
    const step = full ? layout.angle / layout.count : layout.angle / Math.max(1, layout.count - 1);
    for (let i = 2; i <= layout.count; i++) {
      motions.push({
        prefix: `${input.id}:i${i}`,
        motion: { kind: 'rotate', axis, angle: (i - 1) * step },
      });
    }
  }
  return instances(ctx, slots, input, motions);
}

function mirror(ctx: Ctx, slots: readonly Slot[], input: MirrorInput): Slot[] | null {
  let plane: Plane;
  if ('face' in input.plane) {
    const g = geometryOf(ctx, bodiesOf(slots), 'plane', input.plane, ['plane']);
    plane = { origin: g.origin, normal: g.direction };
  } else {
    plane = input.plane;
  }
  return instances(ctx, slots, input, [
    { prefix: `${input.id}:image`, motion: { kind: 'mirror', plane } },
  ]);
}

// Queries for the regen engine and the UI -------------------------------------------------

/** How a stored reference resolves on a body now, with its geometry when it has one. */
export type ReferenceReport =
  | (Extract<Resolution, { ok: true }> & { geometry: SubShapeGeometry | null })
  | Extract<Resolution, { ok: false }>
  | { ok: false; status: 'no-body'; message: string };

/** Resolve references on a named body (for sketch placement, highlighting, re-pick prompts). */
export function resolveReferences(
  k: Kernel,
  body: ShapeId,
  refs: readonly TopoRef[],
): ReferenceReport[] {
  const named = k.has(body) ? k.named(body) : null;
  return refs.map((ref): ReferenceReport => {
    if (named === null) {
      return { ok: false, status: 'no-body', message: `shape ${body} has no names` };
    }
    const r = resolve(named.names, named.topology, ref);
    if (!r.ok) return r;
    const kind = 'face' in ref ? 'face' : 'edge';
    // Oriented like the features orient it, so the UI shows the direction they use.
    const raw = k.geometry(body, { kind, index: r.index });
    const geometry =
      raw === null
        ? null
        : (orientedGeometry(named.names, named.topology, kind, r.index, raw) ?? raw);
    return { ...r, geometry };
  });
}

/** The reference a click on a face or edge of a named body is stored as; null when it cannot be named. */
export function pickReference(
  k: Kernel,
  body: ShapeId,
  kind: 'face' | 'edge',
  index: number,
): TopoRef | null {
  const named = k.has(body) ? k.named(body) : null;
  if (named === null) return null;
  return kind === 'face' ? pickFace(named.names, index) : pickEdge(named.names, index);
}

/**
 * A deterministic sketch frame on a plane: origin is the world origin
 * projected onto the plane, x is world X projected (world Y when the plane
 * faces X), normal is the plane's normal (a face's outward normal).
 */
export function frameOnPlane(point: Vec3, normal: Vec3): Frame {
  const n = unit(normal);
  const dd = dot(point, n);
  const origin: Vec3 = scale(n, dd);
  const project = (v: Vec3): Vec3 => sub(v, scale(n, dot(v, n)));
  let x = project([1, 0, 0]);
  if (norm(x) < 1e-6) x = project([0, 1, 0]);
  return { origin, xDir: unit(x), normal: n };
}

/** The sketch frame on a planar face of a named body, by reference. */
export function sketchFrame(
  k: Kernel,
  body: ShapeId,
  ref: FaceRef,
):
  | { ok: true; frame: Frame; resolution: Extract<Resolution, { ok: true }> }
  | Exclude<ReferenceReport, { ok: true }>
  | { ok: false; status: 'not-planar'; message: string } {
  const [report] = resolveReferences(k, body, [ref]);
  if (!report!.ok) return report!;
  const g = report!.geometry;
  if (g === null || g.kind !== 'plane') {
    return { ok: false, status: 'not-planar', message: `${ref.face} is not planar` };
  }
  const { geometry: _geometry, ...resolution } = report!;
  void _geometry;
  return { ok: true, frame: frameOnPlane(g.origin, g.direction), resolution };
}

// Validation --------------------------------------------------------------------------------

const MODES: readonly string[] = ['new', 'add', 'subtract', 'intersect'];

/** Why a feature input is malformed, or null. Ranges are left to the operations. */
export function validateFeature(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return 'a feature must be an object';
  const f = input as Record<string, unknown>;
  const idError = invalidFeatureId(f.id);
  if (idError) return idError;
  const num = (v: unknown, name: string) =>
    typeof v === 'number' && Number.isFinite(v) ? null : `${name} must be a finite number`;
  const faceRef = (v: unknown, name: string) =>
    isObj(v) && typeof v.face === 'string' && v.face.length > 0 && !isUnnamed(v.face)
      ? null
      : `${name} must be a face reference with a real name`;
  const edgeRef = (v: unknown, name: string) =>
    isObj(v) &&
    Array.isArray(v.faces) &&
    v.faces.length >= 1 &&
    v.faces.length <= 2 &&
    v.faces.every((n) => typeof n === 'string' && n.length > 0 && !isUnnamed(n)) &&
    (v.ends === undefined ||
      (Array.isArray(v.ends) && v.ends.every((n) => typeof n === 'string'))) &&
    (v.ordinal === undefined || (Number.isInteger(v.ordinal) && (v.ordinal as number) >= 1))
      ? null
      : `${name} must be an edge reference with real names`;
  const topoRef = (v: unknown, name: string) =>
    isObj(v) && 'face' in v ? faceRef(v, name) : edgeRef(v, name);
  const vec3 = (v: unknown, name: string) =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((c) => typeof c === 'number' && Number.isFinite(c))
      ? null
      : `${name} must be [number, number, number]`;
  const frame = (v: unknown, name: string) =>
    isObj(v)
      ? (vec3(v.origin, `${name}.origin`) ??
        vec3(v.xDir, `${name}.xDir`) ??
        vec3(v.normal, `${name}.normal`))
      : `${name} must be a frame`;
  const axis = (v: unknown, name: string) =>
    isObj(v)
      ? (vec3(v.origin, `${name}.origin`) ?? vec3(v.direction, `${name}.direction`))
      : `${name} must be an axis`;
  const flip = (v: unknown, name: string) =>
    v === undefined || typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const mode = (v: unknown) =>
    typeof v === 'string' && MODES.includes(v) ? null : `mode must be one of ${MODES.join(', ')}`;
  const bodyId = (v: unknown, name: string) =>
    typeof v === 'string' && v.length > 0 ? null : `${name} must be a non-empty body id`;
  // Which bodies a feature acts on, and the id of the body it makes.
  const targets = (v: Record<string, unknown>, makes: boolean): string | null => {
    if (v.scope !== undefined) {
      if (!Array.isArray(v.scope)) return 'scope must be an array of body ids';
      for (const [i, id] of (v.scope as unknown[]).entries()) {
        const bad = bodyId(id, `scope[${i}]`);
        if (bad) return bad;
      }
      if (new Set(v.scope).size !== v.scope.length) return 'scope names a body twice';
    }
    if (v.body !== undefined)
      return makes ? bodyId(v.body, 'body') : 'only a feature that makes a body has a body id';
    return null;
  };
  const refList = (
    v: unknown,
    name: string,
    check: (x: unknown, n: string) => string | null,
    nonEmpty: boolean,
  ) => {
    if (!Array.isArray(v)) return `${name} must be an array`;
    if (nonEmpty && v.length === 0) return `${name} must not be empty`;
    const seen = new Set<string>();
    for (let i = 0; i < v.length; i++) {
      const item = v[i] as unknown;
      if (!isObj(item)) return `${name}[${i}] must be an object`;
      const e = invalidSketchId(item.id, false) ?? check(item.ref, `${name}[${i}].ref`);
      if (e) return `${name}[${i}]: ${e}`;
      if (seen.has(item.id as string))
        return `${name}[${i}]: reference id '${String(item.id)}' is used twice`;
      seen.add(item.id as string);
    }
    return null;
  };
  const profile = (v: unknown) => {
    if (!isObj(v)) return 'profile must be an object';
    const e = frame(v.frame, 'profile.frame');
    if (e) return e;
    if (!Array.isArray(v.loops) || v.loops.length === 0)
      return 'profile.loops must be a non-empty array';
    for (const [li, loop] of (v.loops as unknown[]).entries()) {
      if (!isObj(loop) || !Array.isArray(loop.entities) || loop.entities.length === 0) {
        return `profile.loops[${li}] must have entities`;
      }
      for (const [i, entity] of (loop.entities as unknown[]).entries()) {
        const bad = isObj(entity) ? invalidSketchId(entity.id) : 'an entity must be an object';
        if (bad) return `profile.loops[${li}].entities[${i}]: ${bad}`;
      }
    }
    return null;
  };
  const tool = (v: Record<string, unknown>): string | null =>
    targets(v, v.kind !== 'hole') ?? toolShape(v);
  const toolShape = (v: Record<string, unknown>): string | null => {
    switch (v.kind) {
      case 'extrude': {
        const e =
          profile(v.profile) ??
          mode(v.mode) ??
          (v.draft === undefined ? null : num(v.draft, 'draft'));
        if (e) return e;
        const x = v.extent;
        if (!isObj(x)) return 'extent must be an object';
        if (x.type === 'blind' || x.type === 'symmetric') return num(x.distance, 'extent.distance');
        if (x.type === 'upToFace') return faceRef(x.face, 'extent.face');
        if (x.type !== 'throughAll') {
          return 'extent.type must be blind, symmetric, throughAll or upToFace';
        }
        return null;
      }
      case 'revolve': {
        const e = profile(v.profile) ?? mode(v.mode) ?? num(v.angle, 'angle');
        if (e) return e;
        return isObj(v.axis) && 'edge' in v.axis
          ? (edgeRef(v.axis.edge, 'axis.edge') ?? flip(v.axis.flip, 'axis.flip'))
          : axis(v.axis, 'axis');
      }
      case 'hole': {
        const e = frame(v.frame, 'frame') ?? num(v.diameter, 'diameter');
        if (e) return e;
        if (!Array.isArray(v.points) || v.points.length === 0)
          return 'points must be a non-empty array';
        for (const [i, p] of (v.points as unknown[]).entries()) {
          if (!isObj(p)) return `points[${i}] must be an object`;
          const bad = invalidSketchId(p.id, false);
          if (bad) return `points[${i}]: ${bad}`;
          if (
            !Array.isArray(p.at) ||
            p.at.length !== 2 ||
            !p.at.every((c) => typeof c === 'number')
          ) {
            return `points[${i}].at must be [number, number]`;
          }
        }
        if (new Set((v.points as { id: string }[]).map((p) => p.id)).size !== v.points.length) {
          return 'a point is used twice';
        }
        const x = v.extent;
        if (!isObj(x) || (x.type !== 'blind' && x.type !== 'throughAll'))
          return 'extent.type must be blind or throughAll';
        if (x.type === 'blind') {
          const bad = num(x.depth, 'extent.depth');
          if (bad) return bad;
        }
        const h = v.head;
        if (!isObj(h) || !['simple', 'counterbore', 'countersink'].includes(h.type as string)) {
          return 'head.type must be simple, counterbore or countersink';
        }
        return null;
      }
      default:
        return `kind ${JSON.stringify(v.kind)} cannot be repeated by a pattern or mirror`;
    }
  };
  const source = (v: unknown): string | null => {
    if (!isObj(v)) return 'source must be an object';
    if (v.type === 'body') {
      return v.mode === undefined || v.mode === 'new' || v.mode === 'add'
        ? null
        : 'source.mode must be new or add';
    }
    if (v.type !== 'features' || !Array.isArray(v.features) || v.features.length === 0) {
      return 'source must be { type: "body" } or { type: "features", features: [...] }';
    }
    for (const [i, s] of (v.features as unknown[]).entries()) {
      const e = validateFeature(s) ?? (isObj(s) ? tool(s) : null);
      if (e) return `source.features[${i}]: ${e}`;
    }
    return null;
  };
  switch (f.kind) {
    case 'extrude':
    case 'revolve':
    case 'hole':
      return tool(f);
    case 'fillet':
      return num(f.radius, 'radius') ?? refList(f.edges, 'edges', edgeRef, true);
    case 'chamfer': {
      const e = refList(f.edges, 'edges', edgeRef, true);
      if (e) return e;
      for (const [i, item] of (f.edges as Record<string, unknown>[]).entries()) {
        if (item.face !== undefined) {
          const bad = faceRef(item.face, `edges[${i}].face`);
          if (bad) return bad;
        }
      }
      const s = f.size;
      if (!isObj(s) || !['distance', 'distances', 'distance-angle'].includes(s.kind as string)) {
        return 'size.kind must be distance, distances or distance-angle';
      }
      return (
        num(s.distance, 'size.distance') ??
        (s.kind === 'distances' ? num(s.distance2, 'size.distance2') : null) ??
        (s.kind === 'distance-angle' ? num(s.angle, 'size.angle') : null)
      );
    }
    case 'shell':
      return num(f.thickness, 'thickness') ?? refList(f.faces, 'faces', faceRef, false);
    case 'pattern': {
      const e = targets(f, false) ?? source(f.source);
      if (e) return e;
      const l = f.layout;
      if (!isObj(l)) return 'layout must be an object';
      if (l.type === 'linear') {
        return (
          num(l.count, 'layout.count') ??
          num(l.spacing, 'layout.spacing') ??
          (Array.isArray(l.direction)
            ? vec3(l.direction, 'layout.direction')
            : isObj(l.direction)
              ? (topoRef(l.direction.ref, 'layout.direction.ref') ??
                flip(l.direction.flip, 'layout.direction.flip'))
              : 'layout.direction must be a vector or { ref }')
        );
      }
      if (l.type === 'circular') {
        return (
          num(l.count, 'layout.count') ??
          num(l.angle, 'layout.angle') ??
          (isObj(l.axis) && 'ref' in l.axis
            ? (topoRef(l.axis.ref, 'layout.axis.ref') ?? flip(l.axis.flip, 'layout.axis.flip'))
            : axis(l.axis, 'layout.axis'))
        );
      }
      return 'layout.type must be linear or circular';
    }
    case 'derive': {
      const e =
        targets(f, false) ??
        mode(f.mode) ??
        vec3(f.rotation, 'rotation') ??
        vec3(f.translation, 'translation');
      if (e) return e;
      if (!Array.isArray(f.sources) || f.sources.length === 0) {
        return 'sources must be a non-empty array';
      }
      const seen = new Set<string>();
      for (const [i, b] of (f.sources as unknown[]).entries()) {
        if (!isObj(b)) return `sources[${i}] must be an object`;
        const bad = bodyId(b.id, `sources[${i}].id`);
        if (bad) return bad;
        if (typeof b.shape !== 'number' || !Number.isInteger(b.shape)) {
          return `sources[${i}] (${String(b.id)}) must have a shape id`;
        }
        if (seen.has(b.id as string)) return `source body ${String(b.id)} is listed twice`;
        seen.add(b.id as string);
      }
      return null;
    }
    case 'import':
      return typeof f.step === 'string' || f.step instanceof Uint8Array
        ? (targets(f, true) ?? mode(f.mode))
        : 'step must be the bytes of a STEP file or base64 text of them';
    case 'mirror': {
      const e = targets(f, false) ?? source(f.source);
      if (e) return e;
      const p = f.plane;
      if (isObj(p) && 'face' in p) return faceRef(p, 'plane');
      return isObj(p)
        ? (vec3(p.origin, 'plane.origin') ?? vec3(p.normal, 'plane.normal'))
        : 'plane must be a plane or a face reference';
    }
    default:
      return `unknown feature kind ${JSON.stringify(f.kind)}`;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Vectors -------------------------------------------------------------------------------------

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function unit(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : a;
}

/** Where `motion` takes point `p`. */
function movePoint(p: Vec3, motion: Transform): Vec3 {
  switch (motion.kind) {
    case 'translate':
      return add(p, motion.vector);
    case 'rotate':
      return rotatePoint(p, motion.axis, motion.angle);
    case 'mirror': {
      const n = unit(motion.plane.normal);
      return sub(p, scale(n, 2 * dot(sub(p, motion.plane.origin), n)));
    }
  }
}

/** Where `motion` turns direction `v` (translations leave it). */
function moveVector(v: Vec3, motion: Transform): Vec3 {
  switch (motion.kind) {
    case 'translate':
      return v;
    case 'rotate':
      return rotatePoint(v, motion.axis, motion.angle, true);
    case 'mirror': {
      const n = unit(motion.plane.normal);
      return sub(v, scale(n, 2 * dot(v, n)));
    }
  }
}

/** Rotate `p` about `axis` by `angle` (Rodrigues). */
function rotatePoint(p: Vec3, axis: Axis, angle: number, isVector = false): Vec3 {
  const k = unit(axis.direction);
  const v = isVector ? p : sub(p, axis.origin);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const r = add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
  return isVector ? r : add(r, axis.origin);
}

function rotateFrame(frame: Frame, axis: Axis, angle: number): Frame {
  return {
    origin: rotatePoint(frame.origin, axis, angle),
    xDir: rotatePoint(frame.xDir, axis, angle, true),
    normal: rotatePoint(frame.normal, axis, angle, true),
  };
}
