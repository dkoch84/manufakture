import type {
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchPlacement,
  StoredExpression,
  Vec2,
  Vec3,
} from '@manufakture/sketch/model';
import { z } from 'zod';
import { FEATURE_ID_PATTERN, isSubId } from './ids';
import { MATERIAL_IDS } from './materials';

/**
 * The document schema, current file format version (ADR 0004). Everything here is plain JSON
 * data. Objects are strict: an unknown key makes a document invalid rather than being dropped,
 * so a newer file can never lose data by passing through an older schema.
 *
 * This file checks shape only. Rules that span several objects (ids unique and allocated,
 * dependencies earlier in the list, expressions parse, variables acyclic) are in `validate.ts`.
 *
 * The sketch data types (entities, constraints, `PointRef`, `SketchPlacement`, `StoredExpression`,
 * `Vec2`, `Vec3`) are defined once, in `@manufakture/sketch/model`, and only imported as types
 * here: core never loads sketch code at runtime. The zod schemas for them are tied to those types
 * with `satisfies z.ZodType<T>` (every value the schema accepts is a valid `T`), and
 * `sketch-model.test.ts` asserts the other direction (the inferred type equals `T`), so drift in
 * either package fails typecheck.
 */

/** The file format version this code reads and writes. Bump it only together with a migration. */
export const FORMAT_VERSION = 2;
/** The topological naming scheme version (T0.5) that stored references are written in. */
export const NAMING_SCHEME = 1;
export const FORMAT_TAG = 'manufakture';

// ---------------------------------------------------------------------------------------------
// Primitives

const finite = z.number();
// Readonly, like the sketch model's `Vec2` and `Vec3`.
export const Vec3Schema = z.tuple([finite, finite, finite]).readonly() satisfies z.ZodType<Vec3>;
export const Point2Schema = z.tuple([finite, finite]).readonly() satisfies z.ZodType<Vec2>;

const featureId = z.string().regex(FEATURE_ID_PATTERN, 'Expected a feature id like "extrude#1"');
const subId = (prefix: 'e' | 'k' | 'r', example: string) =>
  z.string().refine((s) => isSubId(s, prefix), `Expected an id like "${example}"`);
export const EntityIdSchema = subId('e', 'e1');
export const ConstraintIdSchema = subId('k', 'k1');
export const ReferenceIdSchema = subId('r', 'r1');
export const FeatureIdSchema = featureId;

export const LengthUnitSchema = z.enum(['mm', 'cm', 'm', 'in', 'ft']);
export const AngleUnitSchema = z.enum(['deg', 'rad']);

/**
 * A number as the user typed it: source text in the `@manufakture/units` syntax, plus the units
 * a bare number meant at the time (ADR 0004 decision 7, ADR 0005 decision 5). Under the `ft-in`
 * and `in-fraction` display formats `lengthUnit` is `'in'`.
 */
export const StoredExpressionSchema = z.strictObject({
  source: z.string(),
  lengthUnit: LengthUnitSchema,
  angleUnit: AngleUnitSchema,
}) satisfies z.ZodType<StoredExpression>;

// ---------------------------------------------------------------------------------------------
// Display units (ADR 0005 decision 3). Shapes match `LengthFormat` and `AngleFormat` in units.

const decimals = z.int().min(0).max(12);
export const LengthDisplaySchema = z.discriminatedUnion('unit', [
  z.strictObject({ unit: LengthUnitSchema, decimals: decimals.optional() }),
  z.strictObject({
    unit: z.enum(['ft-in', 'in-fraction']),
    denominator: z
      .union(
        [1, 2, 4, 8, 16, 32, 64, 128].map((d) => z.literal(d)) as [
          z.ZodLiteral<1>,
          z.ZodLiteral<2>,
          z.ZodLiteral<4>,
          z.ZodLiteral<8>,
          z.ZodLiteral<16>,
          z.ZodLiteral<32>,
          z.ZodLiteral<64>,
          z.ZodLiteral<128>,
        ],
      )
      .optional(),
  }),
]);
export const AngleDisplaySchema = z.strictObject({
  unit: AngleUnitSchema,
  decimals: decimals.optional(),
});
export const DisplayUnitsSchema = z.strictObject({
  length: LengthDisplaySchema,
  angle: AngleDisplaySchema,
});

// ---------------------------------------------------------------------------------------------
// References (ADR 0004 decision 5, T0.5)

const topoName = z.string().min(1);
export const FaceRefSchema = z.strictObject({ face: topoName });
export const EdgeRefSchema = z.strictObject({
  /** The sorted names of the adjacent faces; a seam lists its one face. */
  faces: z.array(topoName).min(1).max(2),
  /** Present only when needed to be unique at pick time. */
  ends: z.array(topoName).min(1).optional(),
  /** Present only when faces and ends tie; 1-based, positional, always fragile. */
  ordinal: z.int().min(1).optional(),
});
const lastResolved = z.strictObject({ point: Vec3Schema, direction: Vec3Schema }).optional();

export const ReferenceSchema = z.strictObject({
  id: ReferenceIdSchema,
  ref: z.union([FaceRefSchema, EdgeRefSchema]),
  lastResolved,
});
export const FaceReferenceSchema = z.strictObject({
  id: ReferenceIdSchema,
  ref: FaceRefSchema,
  lastResolved,
});
export const EdgeReferenceSchema = z.strictObject({
  id: ReferenceIdSchema,
  ref: EdgeRefSchema,
  lastResolved,
});

// ---------------------------------------------------------------------------------------------
// Sketch data. The types are the sketch model of `@manufakture/sketch/model` (type-only imports),
// so a stored sketch is exactly what the solver loads; these schemas validate them at load time
// and are checked against those types at compile time. FreeCAD's model (ADR 0003 decision 6): lines own their endpoints. Coordinates are
// the last solved values, in millimetres, in the sketch plane's 2D frame. They seed the solver;
// the constraints define the sketch.

const construction = z.boolean();

export const SketchEntitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: EntityIdSchema,
    kind: z.literal('point'),
    construction,
    position: Point2Schema,
  }),
  z.strictObject({
    id: EntityIdSchema,
    kind: z.literal('line'),
    construction,
    start: Point2Schema,
    end: Point2Schema,
  }),
  z.strictObject({
    id: EntityIdSchema,
    kind: z.literal('circle'),
    construction,
    center: Point2Schema,
    radius: z.number().positive(),
  }),
  /** Counter-clockwise from `start` to `end` around `center`; radius and angles are derived. */
  z.strictObject({
    id: EntityIdSchema,
    kind: z.literal('arc'),
    construction,
    center: Point2Schema,
    start: Point2Schema,
    end: Point2Schema,
  }),
]) satisfies z.ZodType<SketchEntity>;

/** Fixed geometry every sketch can reference. The `@` keeps them apart from entity ids. */
export const SKETCH_ORIGIN = '@origin';
export const SKETCH_X_AXIS = '@x-axis';
export const SKETCH_Y_AXIS = '@y-axis';
export const SKETCH_BUILTINS = [SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS] as const;

/** An entity of the same sketch, or a built-in. */
const sketchRef = z.union([EntityIdSchema, z.enum(SKETCH_BUILTINS)]);

/**
 * A point of the sketch: a point entity or the origin (no `at`), or a vertex of a line
 * (`start`, `end`), a circle (`center`) or an arc (`start`, `end`, `center`).
 */
export const PointRefSchema = z.strictObject({
  entity: sketchRef,
  // `exactOptional`: absent, never `undefined`, as the sketch type says (exactOptionalPropertyTypes).
  at: z.enum(['start', 'end', 'center']).exactOptional(),
}) satisfies z.ZodType<PointRef>;

const id = ConstraintIdSchema;
const value = StoredExpressionSchema;
const pointRef = PointRefSchema;
const kind = <K extends string>(k: K) => z.literal(k);

export const SketchConstraintSchema = z.union([
  z.strictObject({ id, kind: kind('coincident'), a: pointRef, b: pointRef }),
  z.strictObject({ id, kind: kind('horizontal'), line: sketchRef }),
  z.strictObject({ id, kind: kind('horizontal'), a: pointRef, b: pointRef }),
  z.strictObject({ id, kind: kind('vertical'), line: sketchRef }),
  z.strictObject({ id, kind: kind('vertical'), a: pointRef, b: pointRef }),
  z.strictObject({ id, kind: kind('parallel'), a: sketchRef, b: sketchRef }),
  z.strictObject({ id, kind: kind('perpendicular'), a: sketchRef, b: sketchRef }),
  /** With `at`, an endpoint-to-endpoint tangency (includes the coincidence). */
  z.strictObject({
    id,
    kind: kind('tangent'),
    a: sketchRef,
    b: sketchRef,
    at: z
      .tuple([z.enum(['start', 'end']), z.enum(['start', 'end'])])
      .readonly()
      .exactOptional(),
  }),
  z.strictObject({ id, kind: kind('equal'), a: sketchRef, b: sketchRef }),
  z.strictObject({ id, kind: kind('distance'), value, a: pointRef, b: pointRef }),
  z.strictObject({ id, kind: kind('distance'), value, point: pointRef, line: sketchRef }),
  /** Signed: `b.x - a.x = value`. */
  z.strictObject({ id, kind: kind('horizontalDistance'), a: pointRef, b: pointRef, value }),
  /** Signed: `b.y - a.y = value`. */
  z.strictObject({ id, kind: kind('verticalDistance'), a: pointRef, b: pointRef, value }),
  /** Counter-clockwise from line `a` to line `b`. */
  z.strictObject({ id, kind: kind('angle'), a: sketchRef, b: sketchRef, value }),
  z.strictObject({ id, kind: kind('radius'), entity: sketchRef, value }),
  z.strictObject({ id, kind: kind('diameter'), entity: sketchRef, value }),
  z.strictObject({ id, kind: kind('fix'), point: pointRef }),
  z.strictObject({ id, kind: kind('midpoint'), point: pointRef, line: sketchRef }),
  z.strictObject({ id, kind: kind('pointOnObject'), point: pointRef, on: sketchRef }),
  z.strictObject({ id, kind: kind('symmetric'), a: pointRef, b: pointRef, line: sketchRef }),
  z.strictObject({ id, kind: kind('symmetric'), a: pointRef, b: pointRef, center: pointRef }),
]) satisfies z.ZodType<SketchConstraint>;

/** Dimensional constraint kinds and what their `value` must evaluate to. */
export const DIMENSION_KINDS = {
  distance: 'length',
  horizontalDistance: 'length',
  verticalDistance: 'length',
  angle: 'angle',
  radius: 'length',
  diameter: 'length',
} as const;

function nonZero(v: readonly number[]): boolean {
  return Math.hypot(...v) > 1e-12;
}

/** An explicit sketch plane: the sketch model's `SketchPlacement`. */
export const SketchPlacementSchema = z.strictObject({
  origin: Vec3Schema,
  normal: Vec3Schema,
  xDir: Vec3Schema,
}) satisfies z.ZodType<SketchPlacement>;

/**
 * Where a sketch lies. An explicit plane gives the origin, the normal and the sketch x axis in
 * model space (millimetres); `xDir` must be perpendicular to `normal`. A face placement puts the
 * sketch on a planar face, found by reference at every regen.
 */
export const SketchPlaneSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('plane'), ...SketchPlacementSchema.shape }).check((ctx) => {
    const { normal, xDir } = ctx.value;
    if (!nonZero(normal)) {
      ctx.issues.push({
        code: 'custom',
        message: 'normal must not be zero',
        input: normal,
        path: ['normal'],
      });
      return;
    }
    if (!nonZero(xDir)) {
      ctx.issues.push({
        code: 'custom',
        message: 'xDir must not be zero',
        input: xDir,
        path: ['xDir'],
      });
      return;
    }
    const dot = normal[0] * xDir[0] + normal[1] * xDir[1] + normal[2] * xDir[2];
    if (Math.abs(dot) / (Math.hypot(...normal) * Math.hypot(...xDir)) > 1e-9) {
      ctx.issues.push({
        code: 'custom',
        message: 'xDir must be perpendicular to normal',
        input: xDir,
        path: ['xDir'],
      });
    }
  }),
  z.strictObject({ type: z.literal('face'), face: FaceReferenceSchema }),
]);

// ---------------------------------------------------------------------------------------------
// Features. Every feature has `id`, `kind`, a display `name` and `suppressed`; the kind adds its
// own inputs. References to other features are feature ids; references to geometry are
// `Reference`s holding names (never indices).

const featureName = z.string().trim().min(1).max(200);
const base = <K extends string>(kind: K) => ({
  id: featureId,
  kind: z.literal(kind),
  name: featureName,
  suppressed: z.boolean(),
});

/** How a new solid combines with the part: a new body, a union, a cut or an intersection. */
export const BooleanOperationSchema = z.enum(['new', 'add', 'cut', 'intersect']);

/**
 * The regions of a sketch to use. `entities` lists the sketch entities bounding the chosen
 * regions; when it is absent, every closed region of the sketch is used.
 */
export const ProfileSchema = z.strictObject({
  sketch: featureId,
  entities: z.array(EntityIdSchema).min(1).optional(),
});

export const SketchFeatureSchema = z.strictObject({
  ...base('sketch'),
  plane: SketchPlaneSchema,
  entities: z.array(SketchEntitySchema),
  constraints: z.array(SketchConstraintSchema),
});

export const ExtrudeExtentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('blind'), distance: StoredExpressionSchema }),
  /** `distance` is the total depth, centred on the sketch plane. */
  z.strictObject({ type: z.literal('symmetric'), distance: StoredExpressionSchema }),
  z.strictObject({ type: z.literal('throughAll') }),
  z.strictObject({ type: z.literal('upToFace'), face: FaceReferenceSchema }),
]);

export const ExtrudeFeatureSchema = z.strictObject({
  ...base('extrude'),
  profile: ProfileSchema,
  operation: BooleanOperationSchema,
  extent: ExtrudeExtentSchema,
  /** Extrude against the sketch normal. */
  reverse: z.boolean(),
  /**
   * Draft angle: positive tapers the sides inward along the extrusion, negative outward. The
   * neutral plane is the sketch plane. Absent means no draft.
   */
  draft: StoredExpressionSchema.exactOptional(),
});

export const RevolveAxisSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('sketchLine'),
    /** A line of the profile's sketch; the axis runs from its start to its end. */
    entity: EntityIdSchema,
    /** Turn the axis round (end to start), so the revolve goes the other way. */
    flip: z.boolean().exactOptional(),
  }),
  z.strictObject({
    type: z.literal('edge'),
    /** A straight edge, oriented by the names of its faces (kernel README, Directions). */
    edge: EdgeReferenceSchema,
    /** Turn the edge's direction round, so the revolve goes the other way. */
    flip: z.boolean().exactOptional(),
  }),
]);

export const RevolveFeatureSchema = z.strictObject({
  ...base('revolve'),
  profile: ProfileSchema,
  axis: RevolveAxisSchema,
  angle: StoredExpressionSchema,
  /** Split the angle evenly to both sides of the sketch plane. */
  symmetric: z.boolean(),
  operation: BooleanOperationSchema,
});

export const FilletFeatureSchema = z.strictObject({
  ...base('fillet'),
  edges: z.array(EdgeReferenceSchema).min(1),
  radius: StoredExpressionSchema,
});

export const ChamferFeatureSchema = z
  .strictObject({
    ...base('chamfer'),
    edges: z.array(EdgeReferenceSchema).min(1),
    /**
     * Along the reference face of each edge: the adjacent face whose name sorts first (T1.8).
     * Equal chamfers measure it on both faces.
     */
    distance: StoredExpressionSchema,
    /** Unequal chamfer: the distance along the other face. Absent means equal distances. */
    secondDistance: StoredExpressionSchema.exactOptional(),
    /** Distance-angle chamfer: the angle from the reference face. Excludes `secondDistance`. */
    angle: StoredExpressionSchema.exactOptional(),
  })
  .check((ctx) => {
    if (ctx.value.secondDistance !== undefined && ctx.value.angle !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a chamfer has a second distance or an angle, not both',
        input: ctx.value.angle,
        path: ['angle'],
      });
    }
  });

export const ShellFeatureSchema = z.strictObject({
  ...base('shell'),
  /** Faces to remove (open the shell); may be empty for a closed hollow. */
  faces: z.array(FaceReferenceSchema),
  thickness: StoredExpressionSchema,
  /** Grow the wall outward instead of inward. */
  outward: z.boolean(),
});

export const HoleHeadSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('simple') }),
  z.strictObject({
    type: z.literal('counterbore'),
    diameter: StoredExpressionSchema,
    depth: StoredExpressionSchema,
  }),
  z.strictObject({
    type: z.literal('countersink'),
    diameter: StoredExpressionSchema,
    angle: StoredExpressionSchema,
  }),
]);

/** Clearance fits of the standard hole tables (ISO 273 fine / medium / coarse, ASME B18.2.8). */
export const HoleFitSchema = z.enum(['close', 'normal', 'loose']);

export const HoleFeatureSchema = z.strictObject({
  ...base('hole'),
  /** The sketch whose points place the holes, drilled along its normal. */
  sketch: featureId,
  points: z.array(EntityIdSchema).min(1),
  diameter: StoredExpressionSchema,
  extent: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('blind'), depth: StoredExpressionSchema }),
    z.strictObject({ type: z.literal('throughAll') }),
  ]),
  head: HoleHeadSchema,
  /**
   * The screw size and fit the hole was sized for (`M6`, `#10`, `1/4`), from the kernel's
   * `HOLE_SIZES`. Informational: `diameter` and the head sizes are what regen uses, so a
   * standard hole can still be edited by hand.
   */
  standard: z.strictObject({ size: z.string().min(1), fit: HoleFitSchema }).exactOptional(),
});

/**
 * The most instances a pattern may have, the original included. The schema does not check it:
 * the kernel does at regen, for a count written as a plain number and one computed by an
 * expression alike, so an out-of-range count fails that pattern at regen instead of refusing to
 * load the whole document.
 */
export const MAX_PATTERN_COUNT = 1000;

export const PatternLayoutSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('linear'),
    /**
     * An edge or a planar face; the direction is the edge's tangent, oriented by the names of
     * its faces (kernel README, Directions), or the face's outward normal.
     */
    direction: ReferenceSchema,
    /** Turn the direction round. */
    flip: z.boolean().exactOptional(),
    /** Instances including the original, 1 to `MAX_PATTERN_COUNT` (checked at regen). */
    count: StoredExpressionSchema,
    spacing: StoredExpressionSchema,
  }),
  z.strictObject({
    type: z.literal('circular'),
    /** A straight or circular edge or a cylindrical face, oriented like a linear direction. */
    axis: ReferenceSchema,
    /** Turn the axis round; it matters when the angle is less than a full turn. */
    flip: z.boolean().exactOptional(),
    count: StoredExpressionSchema,
    /** Total angle the instances are spread over. */
    angle: StoredExpressionSchema,
  }),
]);

/**
 * What a pattern or mirror repeats: the listed features, or with `body: true` the whole body
 * (then `features` is empty).
 */
function checkInstanceSource<T extends { features: string[]; body?: boolean }>(
  ctx: z.core.ParsePayload<T>,
): void {
  const { features, body } = ctx.value;
  if (body === true ? features.length > 0 : features.length === 0) {
    ctx.issues.push({
      code: 'custom',
      message: body === true ? 'a body pattern lists no features' : 'list at least one feature',
      input: features,
      path: ['features'],
    });
  }
}

export const PatternFeatureSchema = z
  .strictObject({
    ...base('pattern'),
    features: z.array(featureId),
    /** Repeat the whole body instead of features. */
    body: z.boolean().exactOptional(),
    layout: PatternLayoutSchema,
  })
  .check(checkInstanceSource);

export const MirrorFeatureSchema = z
  .strictObject({
    ...base('mirror'),
    features: z.array(featureId),
    /** Mirror the whole body instead of features. */
    body: z.boolean().exactOptional(),
    plane: FaceReferenceSchema,
  })
  .check(checkInstanceSource);

/**
 * The extension point for later domain features (printing, CAM, woodworking). `extension` is a
 * dotted, namespaced type (`print.brim`) with its own `schemaVersion`, owned by the domain
 * package. Core understands only the generic parts: feature dependencies, geometry references and
 * expressions, which it validates like any other feature's. `params` is opaque JSON.
 */
export const ExtensionFeatureSchema = z.strictObject({
  ...base('extension'),
  extension: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'Expected a namespaced type like "print.brim"'),
  schemaVersion: z.int().min(1),
  dependsOn: z.array(featureId),
  references: z.array(ReferenceSchema),
  expressions: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), StoredExpressionSchema),
  params: z.record(z.string(), z.json()),
});

export const FeatureSchema = z.discriminatedUnion('kind', [
  SketchFeatureSchema,
  ExtrudeFeatureSchema,
  RevolveFeatureSchema,
  FilletFeatureSchema,
  ChamferFeatureSchema,
  ShellFeatureSchema,
  HoleFeatureSchema,
  PatternFeatureSchema,
  MirrorFeatureSchema,
  ExtensionFeatureSchema,
]);

export const FEATURE_KINDS = [
  'sketch',
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'pattern',
  'mirror',
  'extension',
] as const;

// ---------------------------------------------------------------------------------------------
// Document

export const VariableSchema = z.strictObject({
  name: z.string(),
  expression: StoredExpressionSchema,
});

export const MaterialIdSchema = z.enum(MATERIAL_IDS);

export const PartSchema = z.strictObject({
  id: z.string().min(1),
  name: featureName,
  /** Regen order. */
  features: z.array(FeatureSchema),
  /**
   * The rollback bar: how many features, from the start, are regenerated. `null` means all of
   * them. New features are inserted at the bar.
   */
  rollbackIndex: z.int().min(0).nullable(),
  /** Next number per id counter (feature kind, or `e`, `k`, `r`). Only ever increases. */
  nextIds: z.record(z.string(), z.int().min(1)),
  /**
   * What the part's body is made of: a built-in material id (`MATERIALS`). Absent: not set. A
   * part has one body until multi-body parts (M2), so this is the body's material. Since
   * version 2.
   */
  material: MaterialIdSchema.exactOptional(),
});

export const DocumentSchema = z.strictObject({
  format: z.literal(FORMAT_TAG),
  version: z.literal(FORMAT_VERSION),
  namingScheme: z.literal(NAMING_SCHEME),
  id: z.string().min(1),
  name: z.string(),
  units: DisplayUnitsSchema,
  variables: z.array(VariableSchema),
  parts: z.array(PartSchema).min(1),
});

// ---------------------------------------------------------------------------------------------
// Types

// The sketch data types come from the sketch model (type-only; see the note at the top).
export type {
  ArcEntity,
  CircleEntity,
  ConstraintKind,
  EndPosition,
  LineEntity,
  PointEntity,
  PointPosition,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchPlacement,
  StoredExpression,
  Vec2,
  Vec3,
} from '@manufakture/sketch/model';
/** A 2D point in the sketch plane: the sketch model's `Vec2`. */
export type Point2 = Vec2;
export type DisplayUnits = z.infer<typeof DisplayUnitsSchema>;
export type LengthDisplay = z.infer<typeof LengthDisplaySchema>;
export type AngleDisplay = z.infer<typeof AngleDisplaySchema>;
export type FaceRef = z.infer<typeof FaceRefSchema>;
export type EdgeRef = z.infer<typeof EdgeRefSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type FaceReference = z.infer<typeof FaceReferenceSchema>;
export type EdgeReference = z.infer<typeof EdgeReferenceSchema>;
export type SketchPlane = z.infer<typeof SketchPlaneSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type BooleanOperation = z.infer<typeof BooleanOperationSchema>;
export type SketchFeature = z.infer<typeof SketchFeatureSchema>;
export type ExtrudeFeature = z.infer<typeof ExtrudeFeatureSchema>;
export type RevolveFeature = z.infer<typeof RevolveFeatureSchema>;
export type FilletFeature = z.infer<typeof FilletFeatureSchema>;
export type ChamferFeature = z.infer<typeof ChamferFeatureSchema>;
export type ShellFeature = z.infer<typeof ShellFeatureSchema>;
export type HoleFeature = z.infer<typeof HoleFeatureSchema>;
export type HoleFit = z.infer<typeof HoleFitSchema>;
export type PatternFeature = z.infer<typeof PatternFeatureSchema>;
export type MirrorFeature = z.infer<typeof MirrorFeatureSchema>;
export type ExtensionFeature = z.infer<typeof ExtensionFeatureSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureKind = Feature['kind'];
export type Variable = z.infer<typeof VariableSchema>;
export type Part = z.infer<typeof PartSchema>;
export type ManufaktureDocument = z.infer<typeof DocumentSchema>;
