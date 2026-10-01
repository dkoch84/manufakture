import type {
  OutlineAlign,
  OutlineSource,
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
export const FORMAT_VERSION = 10;
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

// Configuration ids (since version 5); the table itself is below the parts.
/** The document-level `nextIds` key for configuration parameter ids (`cp#n`). */
export const CONFIG_PARAMETER_COUNTER = 'cp';
/** The document-level `nextIds` key for configuration row ids (`cfg#n`). */
export const CONFIG_ROW_COUNTER = 'cfg';
/** A configuration parameter id: `cp#n`, counted by the document's `nextIds.cp`. */
export const CONFIG_PARAMETER_ID_PATTERN = /^cp#[1-9][0-9]*$/;
/** A configuration row id: `cfg#n`, counted by the document's `nextIds.cfg`. */
export const CONFIG_ROW_ID_PATTERN = /^cfg#[1-9][0-9]*$/;
export const ConfigParameterIdSchema = z
  .string()
  .regex(CONFIG_PARAMETER_ID_PATTERN, 'Expected a configuration parameter id like "cp#1"');
export const ConfigRowIdSchema = z
  .string()
  .regex(CONFIG_ROW_ID_PATTERN, 'Expected a configuration row id like "cfg#1"');

/** The document-level `nextIds` key for font ids (`font#n`). Since version 9. */
export const FONT_COUNTER = 'font';
/** A font id: `font#n` with at most 15 digits, counted by the document's `nextIds.font`. */
export const FONT_ID_PATTERN = /^font#[1-9][0-9]{0,14}$/;
export const FontIdSchema = z
  .string()
  .max(32, { abort: true })
  .regex(FONT_ID_PATTERN, 'Expected a font id like "font#1"');

/**
 * A body id: the id of the feature that made the body, alone (`extrude#3`) or followed by a
 * suffix naming one of its bodies (`pattern#2:i3`, `mirror#1:image`, and since version 6
 * `derived#1:from/<source body id>`). Since version 4.
 */
export const BODY_ID_PATTERN = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*(?::.+)?$/;
/**
 * The longest body id, in characters (4 KiB, like a face name), and the most entries a list of
 * body ids (a `scope`, a derived feature's `bodies`) or a part's `bodies` props may have. Real ids
 * are tens of characters; a part holds at most a few thousand bodies even with a full
 * `MAX_PATTERN_COUNT` pattern of several bodies. The caps bound what a crafted file costs to check.
 */
export const MAX_BODY_ID_LENGTH = 4096;
export const MAX_BODY_LIST = 10_000;

export const BodyIdSchema = z
  .string()
  .max(MAX_BODY_ID_LENGTH, { abort: true })
  .regex(BODY_ID_PATTERN, 'Expected a body id like "extrude#3" or "pattern#2:i3"');

/**
 * Which bodies a feature acts on, by body id. Absent means every body at that point in the
 * feature list, which is what a version 3 part (one compound) did. Since version 4.
 */
const scope = z.array(BodyIdSchema).min(1).max(MAX_BODY_LIST).exactOptional();

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

/**
 * The longest face name a reference may store, in characters (4 KiB), and the deepest nesting of
 * brackets in one. The longest name the kernel goldens, the M1 bracket and the regen integration
 * tests produce is 84 characters with one level of brackets; derived names add `<id>:from/` per
 * pinned level (at most `MAX_DERIVED_DEPTH`) and per corner member, which stays far inside both.
 * The caps refuse hostile input as a schema problem before any name is parsed.
 */
export const MAX_FACE_NAME_LENGTH = 4096;
export const MAX_FACE_NAME_DEPTH = 32;

/** How deeply brackets nest in `name` (an unclosed `(` still counts). */
export function nameDepth(name: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === 40) max = Math.max(max, ++depth);
    else if (c === 41 && depth > 0) depth--;
  }
  return max;
}

const topoName = z
  .string()
  .min(1)
  .max(MAX_FACE_NAME_LENGTH, { abort: true })
  .refine(
    (name) => nameDepth(name) <= MAX_FACE_NAME_DEPTH,
    `A face name nests brackets at most ${MAX_FACE_NAME_DEPTH} deep`,
  );
export const FaceRefSchema = z.strictObject({ face: topoName });
export const EdgeRefSchema = z.strictObject({
  /** The sorted names of the adjacent faces; a seam lists its one face. */
  faces: z.array(topoName).min(1).max(2),
  /** Present only when needed to be unique at pick time. */
  ends: z.array(topoName).min(1).optional(),
  /** Present only when faces and ends tie; 1-based, positional, always fragile. */
  ordinal: z.int().min(1).optional(),
});
/**
 * The most faces a vertex name may list. A vertex usually has three; the apex of a fine circular
 * pattern has one per copy, up to `MAX_PATTERN_COUNT`.
 */
export const MAX_VERTEX_FACES = 1024;
/**
 * A vertex, by the sorted names of the faces around it (the kernel's `vertexName`, joined by `&`
 * there). Only mate connectors reference vertices. Since version 7.
 */
export const VertexRefSchema = z.strictObject({
  faces: z.array(topoName).min(1).max(MAX_VERTEX_FACES),
  /** Present only when faces tie (two vertices around the same faces); 1-based, fragile. */
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
export const VertexReferenceSchema = z.strictObject({
  id: ReferenceIdSchema,
  ref: VertexRefSchema,
  lastResolved,
});

// ---------------------------------------------------------------------------------------------
// Sketch data. The types are the sketch model of `@manufakture/sketch/model` (type-only imports),
// so a stored sketch is exactly what the solver loads; these schemas validate them at load time
// and are checked against those types at compile time. FreeCAD's model (ADR 0003 decision 6): lines own their endpoints. Coordinates are
// the last solved values, in millimetres, in the sketch plane's 2D frame. They seed the solver;
// the constraints define the sketch.

/**
 * The most code points the text of one outline may have, and all the outlines of one sketch
 * together. Layout and kerning cost grow with the text, and the string comes from the document,
 * so the caps bound what a crafted file costs to regenerate. A part label is tens of characters.
 */
export const MAX_OUTLINE_TEXT = 1000;
export const MAX_SKETCH_OUTLINE_TEXT = 10_000;

/** The number of code points in `s` (a lone surrogate counts as one). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export const OutlineAlignSchema = z.strictObject({
  horizontal: z.enum(['left', 'center', 'right']),
  vertical: z.enum(['baseline', 'middle', 'top']),
}) satisfies z.ZodType<OutlineAlign>;

/**
 * What an outline is drawn from (ADR 0012 decision 7). `text`: a string in a font of the
 * document, `size` its cap height (a length), `letterSpacing` a length, `lineSpacing` a multiple
 * of the font's line height (a plain number). M5 adds an `svg` source.
 */
export const OutlineSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z
      .string()
      // Two UTF-16 units per code point at most: the cheap bound first.
      .max(2 * MAX_OUTLINE_TEXT, { abort: true })
      .refine(
        (t) => codePointLength(t) <= MAX_OUTLINE_TEXT,
        `A text holds at most ${MAX_OUTLINE_TEXT} characters`,
      ),
    font: FontIdSchema,
    size: StoredExpressionSchema,
    align: OutlineAlignSchema,
    letterSpacing: StoredExpressionSchema.exactOptional(),
    lineSpacing: StoredExpressionSchema.exactOptional(),
  }),
]) satisfies z.ZodType<OutlineSource>;

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
  /**
   * Closed outlines from a source (text), placed at `anchor` and turned by `angle` (radians,
   * counter-clockwise) about it. The anchor is solved like a point; the rest is not. Since
   * version 9.
   */
  z.strictObject({
    id: EntityIdSchema,
    kind: z.literal('outline'),
    construction,
    anchor: Point2Schema,
    angle: finite,
    source: OutlineSourceSchema,
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
 * (`start`, `end`), a circle (`center`) or an arc (`start`, `end`, `center`), or the anchor
 * of an outline (`anchor`, since version 9).
 */
export const PointRefSchema = z.strictObject({
  entity: sketchRef,
  // `exactOptional`: absent, never `undefined`, as the sketch type says (exactOptionalPropertyTypes).
  at: z.enum(['start', 'end', 'center', 'anchor']).exactOptional(),
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

/**
 * A `scope` says which existing bodies an operation combines with, so a feature that makes a new
 * body (`new`) or keeps its solid aside (`reference`) has none.
 */
function checkScopeOperation<T extends { operation: string; scope?: readonly string[] }>(
  ctx: z.core.ParsePayload<T>,
): void {
  const { operation, scope } = ctx.value;
  if (scope !== undefined && (operation === 'new' || operation === 'reference')) {
    ctx.issues.push({
      code: 'custom',
      message: `a "${operation}" operation acts on no existing body, so it has no scope`,
      input: scope,
      path: ['scope'],
    });
  }
}

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

export const ExtrudeFeatureSchema = z
  .strictObject({
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
    /** The bodies the operation combines with; absent: every body. Not for a `new` extrude. */
    scope,
  })
  .check(checkScopeOperation);

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

export const RevolveFeatureSchema = z
  .strictObject({
    ...base('revolve'),
    profile: ProfileSchema,
    axis: RevolveAxisSchema,
    angle: StoredExpressionSchema,
    /** Split the angle evenly to both sides of the sketch plane. */
    symmetric: z.boolean(),
    operation: BooleanOperationSchema,
    /** The bodies the operation combines with; absent: every body. Not for a `new` revolve. */
    scope,
  })
  .check(checkScopeOperation);

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
  /** The bodies the holes are drilled into; absent: every body. */
  scope,
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
 * What a pattern or mirror repeats: the listed features, or with `body: true` the bodies (then
 * `features` is empty). `scope` narrows which bodies a body pattern copies, so only a body
 * pattern has one: copies of features act where the features did.
 */
function checkInstanceSource<
  T extends { features: string[]; body?: boolean; mode?: string; scope?: readonly string[] },
>(ctx: z.core.ParsePayload<T>): void {
  const { features, body, mode, scope } = ctx.value;
  if (body === true ? features.length > 0 : features.length === 0) {
    ctx.issues.push({
      code: 'custom',
      message: body === true ? 'a body pattern lists no features' : 'list at least one feature',
      input: features,
      path: ['features'],
    });
  }
  if (scope !== undefined && body !== true) {
    ctx.issues.push({
      code: 'custom',
      message: 'only a pattern or mirror of bodies has a scope',
      input: scope,
      path: ['scope'],
    });
  }
  if (mode !== undefined && body !== true) {
    ctx.issues.push({
      code: 'custom',
      message: 'only a pattern or mirror of bodies has a mode',
      input: mode,
      path: ['mode'],
    });
  }
}

/**
 * How the copies of a pattern or mirror of bodies join the part: `add` fuses each copy with the
 * body it touches (the default, and what an absent `mode` means, so older documents are
 * unchanged); `new` keeps every copy a body of its own. Since version 6.
 */
export const BodyCopyModeSchema = z.enum(['new', 'add']);

export const PatternFeatureSchema = z
  .strictObject({
    ...base('pattern'),
    features: z.array(featureId),
    /** Repeat the bodies instead of features. */
    body: z.boolean().exactOptional(),
    /** With `body: true`, the bodies to copy; absent: every body. */
    scope,
    /** With `body: true`, how the copies join the part; absent: `add`. Since version 6. */
    mode: BodyCopyModeSchema.exactOptional(),
    layout: PatternLayoutSchema,
  })
  .check(checkInstanceSource);

export const MirrorFeatureSchema = z
  .strictObject({
    ...base('mirror'),
    features: z.array(featureId),
    /** Mirror the bodies instead of features. */
    body: z.boolean().exactOptional(),
    /** With `body: true`, the bodies to mirror; absent: every body. */
    scope,
    /** With `body: true`, how the copies join the part; absent: `add`. Since version 6. */
    mode: BodyCopyModeSchema.exactOptional(),
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

/**
 * An imported file, kept in the document itself (README, "Imported geometry"): the file's bytes
 * as base64 `data`, with its `size` in bytes and the lower-case hex SHA-256 of the bytes, so a
 * later content-addressed blob store can move `data` out of the document by hash without
 * changing what the feature means.
 */
/**
 * The largest file an import may store, in bytes (20 MiB). The document holds the file as base64,
 * a third larger, in every saved copy, so the schema refuses a bigger one up front, before its
 * text is even scanned. The app's import limit is this value; the kernel's own STEP limit
 * (`MAX_STEP_BYTES`, 64 MiB) is higher, so every stored file is one the kernel accepts.
 */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_BASE64 = Math.ceil(MAX_IMPORT_BYTES / 3) * 4;

/** The check that base64 `data` holds exactly `size` bytes (imports, user fonts). */
function checkDataSize(ctx: z.core.ParsePayload<{ data: string; size: number }>): void {
  const { data, size } = ctx.value;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (data.length % 4 !== 0 || (data.length / 4) * 3 - padding !== size) {
    ctx.issues.push({
      code: 'custom',
      message: `data does not hold ${size} bytes`,
      input: data,
      path: ['data'],
    });
  }
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lower-case hex SHA-256');
const base64Schema = z
  .string()
  .max(MAX_IMPORT_BASE64, { abort: true })
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected base64 text');

export const ImportSourceSchema = z
  .strictObject({
    format: z.enum(['step', 'stl']),
    /** The file's name when it was imported, for display. */
    fileName: z.string().min(1).max(255),
    size: z.int().min(1).max(MAX_IMPORT_BYTES),
    sha256: sha256Schema,
    data: base64Schema,
  })
  .check(checkDataSize);

/**
 * How an import joins the part. `reference` keeps it aside as a reference body (shown, measured,
 * never part of the body); the others combine a STEP solid with the body like an extrusion.
 */
export const ImportOperationSchema = z.enum(['reference', 'new', 'add', 'cut', 'intersect']);

/**
 * Geometry read from a file. A STEP file gives a B-rep whose faces are named
 * `import#k:face:<n>` in the file's face order (fragile: imported topology has no history); an
 * STL file gives a mesh, which can only be a reference (display and measure, no B-rep features).
 * Since version 3.
 */
export const ImportFeatureSchema = z
  .strictObject({
    ...base('import'),
    source: ImportSourceSchema,
    operation: ImportOperationSchema,
    /** The bodies the operation combines with; absent: every body. Not for `new` or `reference`. */
    scope,
  })
  .check(checkScopeOperation)
  .check((ctx) => {
    if (ctx.value.source.format === 'stl' && ctx.value.operation !== 'reference') {
      ctx.issues.push({
        code: 'custom',
        message: 'an STL import is a mesh: it can only be a reference',
        input: ctx.value.operation,
        path: ['operation'],
      });
    }
  });

// ---------------------------------------------------------------------------------------------
// Fonts (since version 9; ADR 0011, ADR 0012 decision 8)

/** The most fonts a document may hold; bounds what a crafted file costs to check. */
export const MAX_FONTS = 1000;
/**
 * The most bytes the user fonts of one document may hold in all (64 MiB, the sum of their
 * `size`): with `MAX_FONTS` alone, a document could claim 1000 fonts of up to 20 MiB each. A
 * family of a dozen styles takes a few MiB; this leaves room for several families and a
 * large CJK font or two.
 */
export const MAX_FONT_TOTAL_BYTES = 64 * 1024 * 1024;

/** The bytes the user fonts of a font list hold in all (bundled fonts hold none). */
export function fontBytes(fonts: readonly { source: { kind: string; size?: number } }[]): number {
  let total = 0;
  for (const f of fonts) if (f.source.kind === 'file') total += f.source.size ?? 0;
  return total;
}
/** A bundled font's id in `packages/text` (`inter-bold`): lower-case letters, digits and `-`. */
export const BUNDLED_FONT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Where a font's bytes are. `bundled`: a font that ships with the app, by its stable id and the
 * SHA-256 of the file the text was made with; no bytes, and a different file under that id is
 * detected (a warning, and a cache miss), never a silent change of geometry. `file`: a TTF or
 * OTF file the user added, stored like an imported file (base64 `data`, moved to a blob by
 * persistence), with its `fileName`, `size` (at most `MAX_IMPORT_BYTES`) and SHA-256.
 */
export const FontSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('bundled'),
    id: z.string().regex(BUNDLED_FONT_ID_PATTERN, 'Expected a bundled font id like "inter-bold"'),
    sha256: sha256Schema,
  }),
  z
    .strictObject({
      kind: z.literal('file'),
      fileName: z.string().min(1).max(255),
      size: z.int().min(1).max(MAX_IMPORT_BYTES),
      sha256: sha256Schema,
      data: base64Schema,
    })
    .check(checkDataSize),
]);

/**
 * A font of the document: an id outlines name it by (`font#n`, never reused), the family and
 * style read from the font when it was added (for display), and where its bytes are.
 */
export const FontSchema = z.strictObject({
  id: FontIdSchema,
  family: z.string().min(1).max(200),
  style: z.string().min(1).max(200),
  source: FontSourceSchema,
});

/**
 * The largest pinned source a derived feature may store: the UTF-8 length of `source.data`, in
 * bytes (64 MiB). The source holds its own imports inline, so this is above `MAX_IMPORT_BYTES`
 * in base64 with room for the rest of the document. The schema checks the text length first
 * (a UTF-8 length is never less), before counting bytes.
 */
export const MAX_DERIVED_BYTES = 64 * 1024 * 1024;

/**
 * How deeply derived features may nest: a part deriving from a source that derives from another,
 * and so on. A pin is an immutable snapshot, so a chain can never loop back on itself; the cap
 * bounds the cost of regenerating one. Regen checks it while it opens the sources (the nested
 * documents are not validated at load).
 */
export const MAX_DERIVED_DEPTH = 8;

/** The UTF-8 length of `s` in bytes, without encoding it. A lone surrogate counts as U+FFFD (3). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * The pinned source of a derived feature (README, "Derived parts"): which document, version and
 * part it is, for display and for updating the pin, and the document itself. `data` is the
 * canonical JSON text (`serialize`) of the source document at that version, its imports inline,
 * so the pin is self-contained like an import's bytes. `size` is the UTF-8 length of `data` and
 * `sha256` the lower-case hex SHA-256 of those bytes. Only this envelope is checked at load; the
 * nested document is regen's to open and check. Since version 6.
 */
export const DerivedSourceSchema = z
  .strictObject({
    documentId: z.string().min(1),
    /** The source document's name when the pin was made, for display. */
    documentName: z.string(),
    /** A named version of the source (its id is permanent). */
    versionId: z.string().min(1),
    /** The version's name when the pin was made, for display. */
    versionName: z.string(),
    /** The part of the source document whose bodies are derived. */
    partId: z.string().min(1),
    /** A row of the source's configuration table to build it in; absent: as it is. */
    configuration: ConfigRowIdSchema.exactOptional(),
    size: z.int().min(1).max(MAX_DERIVED_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lower-case hex SHA-256'),
    data: z.string().min(1).max(MAX_DERIVED_BYTES, { abort: true }),
  })
  .check((ctx) => {
    const { data, size } = ctx.value;
    if (utf8Length(data) !== size) {
      ctx.issues.push({
        code: 'custom',
        message: `data is not ${size} bytes of UTF-8`,
        input: size,
        path: ['size'],
      });
    }
  });

/**
 * Where derived bodies go: a translation (lengths) and a rotation (angles about the fixed x, y
 * and z axes, applied in that order, about the origin), both expressions. The rotation is applied
 * first, then the translation.
 */
export const DerivedPlacementSchema = z.strictObject({
  translation: z.tuple([StoredExpressionSchema, StoredExpressionSchema, StoredExpressionSchema]),
  rotation: z.tuple([StoredExpressionSchema, StoredExpressionSchema, StoredExpressionSchema]),
});

/**
 * Bodies of a part of another document (or of another version of this one), pinned to a version
 * and carried inside the document. Its bodies are `<id>:from/<source body id>`, and its faces are
 * named `<id>:from/<source face name>`: everything after `:from/` is a name in the source
 * document, never read for this part's feature ids. Since version 6.
 */
export const DerivedFeatureSchema = z
  .strictObject({
    ...base('derived'),
    source: DerivedSourceSchema,
    /** The source part's bodies to derive, by their ids in the source; absent: every body. */
    bodies: z.array(BodyIdSchema).min(1).max(MAX_BODY_LIST).exactOptional(),
    placement: DerivedPlacementSchema,
    operation: BooleanOperationSchema,
    /** The bodies the operation combines with; absent: every body. Not for a `new` feature. */
    scope,
  })
  .check(checkScopeOperation);

// ---------------------------------------------------------------------------------------------
// Threads (since version 10; ADR 0012 decision 9)

/** The thread standards: ISO metric coarse and UNC (the kernel's `THREAD_SIZES`). */
export const ThreadSystemSchema = z.enum(['iso-metric', 'unc']);
export const ThreadHandSchema = z.enum(['right', 'left']);
/** `modelled`: real helical geometry; `cosmetic`: the cylinder resized, the thread only drawn. */
export const ThreadRepresentationSchema = z.enum(['modelled', 'cosmetic']);
/** The longest thread size name (`M6`, `#10-24`, `1/4-20`). */
export const MAX_THREAD_SIZE_LENGTH = 32;

/**
 * A thread on a cylindrical face: a shaft (external) or a hole (internal), told apart by which
 * side of the face the material is on. It acts on the body that owns the face, like a fillet,
 * so it has no scope. The size is a name of the kernel's thread table; regen refuses one it does
 * not know, so adding sizes never changes the format. Since version 10.
 */
export const ThreadFeatureSchema = z
  .strictObject({
    ...base('thread'),
    /** The cylinder to thread. */
    face: FaceReferenceSchema,
    /**
     * A circular edge of the face: the end the thread starts from. Absent: the end nearer the
     * face's first neighbour by name (`cap:end` before `cap:start`: a lone extruded cylinder starts
     * at its top).
     */
    start: EdgeReferenceSchema.exactOptional(),
    /** How far along the face the thread runs from its start; `full`: the whole face. */
    length: z.union([StoredExpressionSchema, z.literal('full')]),
    standard: z.strictObject({
      system: ThreadSystemSchema,
      size: z.string().min(1).max(MAX_THREAD_SIZE_LENGTH),
    }),
    hand: ThreadHandSchema,
    /**
     * Diametral printing clearance, like the fit variables (`#fit_slip`): the thread is this much
     * smaller across (external) or larger (internal) than the basic profile.
     */
    clearance: StoredExpressionSchema,
    representation: ThreadRepresentationSchema,
  })
  .check((ctx) => {
    const { face, start } = ctx.value;
    if (start !== undefined && !start.ref.faces.includes(face.ref.face)) {
      ctx.issues.push({
        code: 'custom',
        message: 'the start edge must be an edge of the threaded face',
        input: start,
        path: ['start'],
      });
    }
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
  ImportFeatureSchema,
  DerivedFeatureSchema,
  ThreadFeatureSchema,
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
  'import',
  'derived',
  'thread',
] as const;

// ---------------------------------------------------------------------------------------------
// Document

export const VariableSchema = z.strictObject({
  name: z.string(),
  expression: StoredExpressionSchema,
});

export const MaterialIdSchema = z.enum(MATERIAL_IDS);

/** A display colour: `#rrggbb`, lower-case hex, so equal colours are equal text. */
export const ColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, 'Expected a lower-case colour like "#1f77b4"');

/** What a user can set on one body. Every field is optional; absent means the default. */
export const BodyPropsFieldsSchema = z.strictObject({
  name: featureName.exactOptional(),
  color: ColorSchema.exactOptional(),
  /** Overrides the part's `material` for this body. */
  material: MaterialIdSchema.exactOptional(),
});

/**
 * The user's settings for one body of a part, by body id (README, "Bodies"). Only bodies the
 * user has named, coloured or given a material have an entry, so an entry sets at least one of
 * them. Which bodies exist, and their solids, is derived by regen. Since version 4.
 */
export const BodyPropsSchema = z
  .strictObject({ id: BodyIdSchema, ...BodyPropsFieldsSchema.shape })
  .check((ctx) => {
    const { name, color, material } = ctx.value;
    if (name === undefined && color === undefined && material === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a body entry sets a name, a colour or a material',
        input: ctx.value,
        path: [],
      });
    }
  });

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
   * What the part's bodies are made of: a built-in material id (`MATERIALS`). Absent: not set.
   * A body with its own `material` in `bodies` uses that instead. Since version 2.
   */
  material: MaterialIdSchema.exactOptional(),
  /** Per-body names, colours and materials, for the bodies that have any. Since version 4. */
  bodies: z.array(BodyPropsSchema).max(MAX_BODY_LIST),
});

// ---------------------------------------------------------------------------------------------
// Configurations (since version 5). The id schemas are with the primitives, above.

/**
 * One column of the configuration table: what a row can override. A `variable` parameter
 * overrides the expression of a document variable; a `suppression` parameter overrides the
 * `suppressed` flag of one feature.
 */
export const ConfigParameterSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: ConfigParameterIdSchema,
    name: featureName,
    kind: z.literal('variable'),
    /** The name of the variable whose expression a row overrides. */
    variable: z.string().min(1),
  }),
  z.strictObject({
    id: ConfigParameterIdSchema,
    name: featureName,
    kind: z.literal('suppression'),
    partId: z.string().min(1),
    featureId: featureId,
  }),
]);

/** A row's value for one parameter: an expression for a variable, a flag for a suppression. */
export const ConfigValueSchema = z.union([StoredExpressionSchema, z.boolean()]);

/**
 * One variant: a value per parameter id. A parameter with no value in a row keeps the
 * document's own value (the variable's expression, the feature's `suppressed`) in that row.
 */
export const ConfigRowSchema = z.strictObject({
  id: ConfigRowIdSchema,
  name: featureName,
  values: z.record(ConfigParameterIdSchema, ConfigValueSchema),
});

/** The configuration table (README, "Configurations"). Since version 5. */
export const ConfigurationsSchema = z.strictObject({
  parameters: z.array(ConfigParameterSchema),
  rows: z.array(ConfigRowSchema),
  /** The row the document is shown and built in; `null`: none, the document as it is. */
  active: ConfigRowIdSchema.nullable(),
});

// ---------------------------------------------------------------------------------------------
// Assemblies (since version 7): instances of parts placed by mates between mate connectors. The
// mates are the solver's (ADR 0008, `packages/assembly`); core only stores them.

/** The document-level `nextIds` key for assembly ids (`assembly#n`). */
export const ASSEMBLY_COUNTER = 'assembly';
/** Assembly-level `nextIds` keys: instances (`inst#n`), mates (`mate#n`), connectors (`mc#n`). */
export const INSTANCE_COUNTER = 'inst';
export const MATE_COUNTER = 'mate';
export const CONNECTOR_COUNTER = 'mc';
/**
 * Assembly, instance, mate and connector ids: `<counter>#n` with at most 15 digits, so every `n`
 * and the counter past it stay exact integers. Connector references use `ReferenceIdSchema`
 * (`r<n>`), as feature references do.
 */
export const ASSEMBLY_ID_PATTERN = /^assembly#[1-9][0-9]{0,14}$/;
export const INSTANCE_ID_PATTERN = /^inst#[1-9][0-9]{0,14}$/;
export const MATE_ID_PATTERN = /^mate#[1-9][0-9]{0,14}$/;
export const CONNECTOR_ID_PATTERN = /^mc#[1-9][0-9]{0,14}$/;
/**
 * The most assemblies a document, and instances or mates an assembly, may hold. The solver is
 * budgeted for hundreds of instances (T2.3a); the caps bound what a crafted file costs to check.
 */
export const MAX_ASSEMBLY_ITEMS = 10_000;
/**
 * The farthest an instance may be placed from the origin along any axis, in millimetres (1,000 km).
 * Far beyond any real assembly; it keeps a crafted pose from wrecking the solver's precision.
 */
export const MAX_POSE_TRANSLATION = 1e9;
/** Longest instance name (as for features). */
export const MAX_INSTANCE_NAME = 200;

/** The longest part id an instance source may name (part ids are free-form before version 4). */
export const MAX_PART_ID_LENGTH = 4096;

const counted = (pattern: RegExp, example: string) =>
  z.string().max(32, { abort: true }).regex(pattern, `Expected an id like "${example}"`);
export const AssemblyIdSchema = counted(ASSEMBLY_ID_PATTERN, 'assembly#1');
export const InstanceIdSchema = counted(INSTANCE_ID_PATTERN, 'inst#1');
export const MateIdSchema = counted(MATE_ID_PATTERN, 'mate#1');
export const ConnectorIdSchema = counted(CONNECTOR_ID_PATTERN, 'mc#1');

/** A unit quaternion `[x, y, z, w]` (three.js order), as the solver's `Quat`. */
export const QuaternionSchema = z.tuple([finite, finite, finite, finite]).readonly();

/**
 * A rigid placement: `p_world = R p_local + translation`, with `rotation` a unit quaternion
 * (checked to 1e-6, so a stored pose is a rotation and nothing else) and each translation
 * component within `MAX_POSE_TRANSLATION`. Lengths in millimetres. The
 * same shape as the solver's `Pose`, which core does not import.
 */
export const PoseSchema = z
  .strictObject({ translation: Vec3Schema, rotation: QuaternionSchema })
  .check((ctx) => {
    ctx.value.translation.forEach((x, i) => {
      if (Math.abs(x) > MAX_POSE_TRANSLATION) {
        ctx.issues.push({
          code: 'custom',
          message: `translation is at most ${MAX_POSE_TRANSLATION} mm from the origin on each axis`,
          input: x,
          path: ['translation', i],
        });
      }
    });
    if (Math.abs(Math.hypot(...ctx.value.rotation) - 1) > 1e-6) {
      ctx.issues.push({
        code: 'custom',
        message: 'rotation must be a unit quaternion',
        input: ctx.value.rotation,
        path: ['rotation'],
      });
    }
  });

/** An instance of a part studio of this document, optionally in a configuration row. */
export const PartInstanceSourceSchema = z.strictObject({
  part: z.string().min(1).max(MAX_PART_ID_LENGTH),
  /** A row of this document's configuration table to build the part in; absent: as it is. */
  configuration: ConfigRowIdSchema.exactOptional(),
});

/**
 * What an instance shows: a part of this document (`{ part, configuration? }`), or a part of a
 * pinned version of another document, carried inside the document exactly like a derived
 * feature's source (`DerivedSourceSchema`, which has `configuration?` too). `configuration` is
 * read by T2.4c; regen checks it against the source, not the load.
 */
export const InstanceSourceSchema = z.union([PartInstanceSourceSchema, DerivedSourceSchema]);

/**
 * One placed copy of a part. `pose` is the last solved pose: it seeds the solver and picks among
 * solutions; the mates define where the instance really is (ADR 0008 decision 3).
 */
export const InstanceSchema = z.strictObject({
  id: InstanceIdSchema,
  name: featureName,
  source: InstanceSourceSchema,
  /** The source part's bodies to show, by body id in that part; absent: every body. */
  bodies: z.array(BodyIdSchema).min(1).max(MAX_BODY_LIST).exactOptional(),
  /** A fixed instance never moves; fixed instances are the roots of the mate graph. */
  fixed: z.boolean(),
  suppressed: z.boolean(),
  pose: PoseSchema,
});

/**
 * A move of a connector frame in its own coordinates: a rotation by `rotation` (angles about the
 * frame's fixed x, y and z axes, in that order) and then a translation by `translation`
 * (lengths), all expressions, like a derived feature's placement.
 */
export const ConnectorOffsetSchema = z.strictObject({
  translation: z.tuple([StoredExpressionSchema, StoredExpressionSchema, StoredExpressionSchema]),
  rotation: z.tuple([StoredExpressionSchema, StoredExpressionSchema, StoredExpressionSchema]),
});

const connector = {
  id: ConnectorIdSchema,
  /** The instance of the same assembly the connector sits on. */
  instance: InstanceIdSchema,
  /** Turn the frame's z axis round (a half turn about its x axis). */
  flip: z.boolean().exactOptional(),
  /** Quarter turns of the frame about its z axis, 1 to 3; absent: none. */
  rotate: z.union([z.literal(1), z.literal(2), z.literal(3)]).exactOptional(),
  /** Applied after `flip` and `rotate`. Absent: none. */
  offset: ConnectorOffsetSchema.exactOptional(),
};

/**
 * A mate connector: a frame on an instance, found at every regen from a named face, edge or
 * vertex of the instance's part (`origin`) and a rule picking the point on it (`inference`):
 * a face's `centroid`, the `centre` of a circular edge or of a cylindrical, conical or spherical
 * face, an edge's `midpoint`, or a `vertex`. The frame's orientation follows the kernel's rules
 * (T2.3c); `flip`, `rotate` and `offset` adjust it. Names are those of the instance's part (or of
 * its pinned source), so they are never read for this document's feature ids.
 */
export const MateConnectorSchema = z.discriminatedUnion('inference', [
  z.strictObject({ ...connector, inference: z.literal('centroid'), origin: FaceReferenceSchema }),
  z.strictObject({
    ...connector,
    inference: z.literal('centre'),
    origin: z.union([FaceReferenceSchema, EdgeReferenceSchema]),
  }),
  z.strictObject({ ...connector, inference: z.literal('midpoint'), origin: EdgeReferenceSchema }),
  z.strictObject({ ...connector, inference: z.literal('vertex'), origin: VertexReferenceSchema }),
]);

/**
 * The mate kinds, as the solver names them (`packages/assembly`, `MateKind`): what each leaves
 * free between connector a and connector b. Fastened: nothing; revolute: a turn about z; slider:
 * a move along z; planar: x, y and a turn about z; cylindrical: a move along and a turn about z;
 * ball: any turn about the origin.
 */
export const MATE_KINDS = [
  'fastened',
  'revolute',
  'slider',
  'planar',
  'cylindrical',
  'ball',
] as const;
export const MateKindSchema = z.enum(MATE_KINDS);

/**
 * Bounds on a revolute's angle or a slider's distance, as expressions (angles and lengths). At
 * least one bound; whether `min` is below `max` is known once they are evaluated, so regen
 * reports it (the solver's `invalid-limits`).
 */
export const MateLimitsSchema = z
  .strictObject({
    min: StoredExpressionSchema.exactOptional(),
    max: StoredExpressionSchema.exactOptional(),
  })
  .check((ctx) => {
    if (ctx.value.min === undefined && ctx.value.max === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'limits set a minimum, a maximum or both',
        input: ctx.value,
        path: [],
      });
    }
  });

/**
 * A mate between two connectors on two different instances. Mates are kept in creation order:
 * the solver blames the newest mate of a redundant or conflicting group.
 */
export const MateSchema = z
  .strictObject({
    id: MateIdSchema,
    name: featureName,
    kind: MateKindSchema,
    a: MateConnectorSchema,
    b: MateConnectorSchema,
    suppressed: z.boolean(),
    /** Revolute and slider only. */
    limits: MateLimitsSchema.exactOptional(),
  })
  .check((ctx) => {
    const { kind, limits } = ctx.value;
    if (limits !== undefined && kind !== 'revolute' && kind !== 'slider') {
      ctx.issues.push({
        code: 'custom',
        message: `a ${kind} mate has no limits; only a revolute or a slider has`,
        input: limits,
        path: ['limits'],
      });
    }
  });

/** An assembly (README, "Assemblies"). Since version 7. */
export const AssemblySchema = z.strictObject({
  id: AssemblyIdSchema,
  name: featureName,
  instances: z.array(InstanceSchema).max(MAX_ASSEMBLY_ITEMS),
  /** In creation order: the last is the newest. */
  mates: z.array(MateSchema).max(MAX_ASSEMBLY_ITEMS),
  /** Next number per id counter (`inst`, `mate`, `mc`, `r`). Only ever increases. */
  nextIds: z.record(z.string(), z.int().min(1)),
});

// ---------------------------------------------------------------------------------------------
// Print setups (since version 8; ADR 0012 decisions 1 and 2). Document state, not features: a
// setup changes no geometry, so it is outside every feature list and never dirties a regen.

/** Document print-level `nextIds` keys: setups (`print#n`) and items (`item#n`); references use `r`. */
export const PRINT_SETUP_COUNTER = 'print';
export const PRINT_ITEM_COUNTER = 'item';
/**
 * Setup and item ids: `<counter>#n` with at most 15 digits, so every `n` and the counter past it
 * stay exact integers. Their face references use `ReferenceIdSchema` (`r<n>`), counted by the
 * print section's own `nextIds.r`, a namespace separate from every part's.
 */
export const PRINT_SETUP_ID_PATTERN = /^print#[1-9][0-9]{0,14}$/;
export const PRINT_ITEM_ID_PATTERN = /^item#[1-9][0-9]{0,14}$/;
/**
 * A printer id: lower-case letters, digits, `.`, `_` and `-`, at most 64 characters
 * (`bambu-a1-mini`). It names a row of the printer table in `packages/print`, which is checked
 * when a setup is used, never here: the table grows without a format change, and a document
 * naming a printer this build does not know still loads (ADR 0012 decision 2).
 */
export const PRINTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The most setups a document, and items a setup, may hold; bounds what a crafted file costs. */
export const MAX_PRINT_ITEMS = 10_000;
/** The most copies of one item. */
export const MAX_PRINT_COPIES = 1000;
/**
 * The largest nozzle, in millimetres. Real FDM nozzles are 0.2 to 1.2 mm; the bound only keeps a
 * crafted value sane. Whether the printer is sold with that nozzle is checked at use.
 */
export const MAX_NOZZLE = 10;

export const PrintSetupIdSchema = counted(PRINT_SETUP_ID_PATTERN, 'print#1');
export const PrintItemIdSchema = counted(PRINT_ITEM_ID_PATTERN, 'item#1');
export const PrinterIdSchema = z
  .string()
  .regex(PRINTER_ID_PATTERN, 'Expected a printer id like "bambu-a1-mini"');

/**
 * Printability thresholds, as expressions. `overhang` is an angle from vertical (ADR 0012
 * decision 6: 60 degrees from vertical is OrcaSlicer's 30 from horizontal); the others are
 * lengths: the thinnest wall, the narrowest gap, the smallest hole, and the diameter above which
 * a horizontal hole is flagged for a teardrop. Each one absent takes its default from the printer
 * and nozzle; an entry sets at least one (no thresholds at all is an absent `thresholds`).
 */
export const PrintThresholdsSchema = z
  .strictObject({
    overhang: StoredExpressionSchema.exactOptional(),
    minWall: StoredExpressionSchema.exactOptional(),
    minGap: StoredExpressionSchema.exactOptional(),
    minHole: StoredExpressionSchema.exactOptional(),
    teardrop: StoredExpressionSchema.exactOptional(),
  })
  .check((ctx) => {
    if (Object.values(ctx.value).every((v) => v === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'thresholds set at least one value; leave them out for the defaults',
        input: ctx.value,
        path: [],
      });
    }
  });

/**
 * How an item sits on the bed. `asModelled`: as it is in the part. `layFlat`: the planar face
 * `face` turned down onto the bed, then a turn about z by `turn` (absent: none). `rotate`: angles
 * about the fixed x, y and z axes, in that order (`packages/print` documents the convention).
 * The bed placement after that (lowest point to z = 0) is computed, never stored.
 */
export const PrintOrientationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('asModelled') }),
  z.strictObject({
    kind: z.literal('layFlat'),
    face: FaceReferenceSchema,
    turn: StoredExpressionSchema.exactOptional(),
  }),
  z.strictObject({
    kind: z.literal('rotate'),
    x: StoredExpressionSchema,
    y: StoredExpressionSchema,
    z: StoredExpressionSchema,
  }),
]);

/**
 * One thing to print: a part of this document, one of its bodies or all of them, oriented, and
 * how many copies. The body and the face are names regen resolves; whether they still exist is a
 * print workspace result (`reference-lost`), never a load or command error (ADR 0012 decision 2).
 */
export const PrintItemSchema = z.strictObject({
  id: PrintItemIdSchema,
  /** A part id of this document. */
  part: z.string().min(1).max(MAX_PART_ID_LENGTH),
  /** A body id of that part; absent: every body of the part. */
  body: BodyIdSchema.exactOptional(),
  orientation: PrintOrientationSchema,
  /** Absent: one. */
  copies: z.int().min(1).max(MAX_PRINT_COPIES).exactOptional(),
});

/** A print setup: a printer, a nozzle, optional thresholds and the items to print. */
export const PrintSetupSchema = z.strictObject({
  id: PrintSetupIdSchema,
  name: featureName,
  printer: PrinterIdSchema,
  /** The nozzle diameter, in millimetres. */
  nozzle: z.number().positive().max(MAX_NOZZLE),
  /** Absent: every threshold from the printer and nozzle defaults. */
  thresholds: PrintThresholdsSchema.exactOptional(),
  items: z.array(PrintItemSchema).max(MAX_PRINT_ITEMS),
});

/** The print section (README, "Print setups"). Since version 8. */
export const PrintDataSchema = z.strictObject({
  setups: z.array(PrintSetupSchema).max(MAX_PRINT_ITEMS),
  /** Next number per id counter (`print`, `item`, `r`). Only ever increases. */
  nextIds: z.record(z.string(), z.int().min(1)),
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
  /** Assemblies of this document's parts and of pinned parts, in tab order. Since version 7. */
  assemblies: z.array(AssemblySchema).max(MAX_ASSEMBLY_ITEMS),
  /** Print setups: what to print, on which printer, oriented how. Since version 8. */
  print: PrintDataSchema,
  /** The fonts the document's outlines use, bundled or added by the user. Since version 9. */
  fonts: z
    .array(FontSchema)
    .max(MAX_FONTS)
    .check((ctx) => {
      const total = fontBytes(ctx.value);
      if (total > MAX_FONT_TOTAL_BYTES) {
        ctx.issues.push({
          code: 'custom',
          message: `the document's fonts hold ${total} bytes; at most ${MAX_FONT_TOTAL_BYTES} are allowed`,
          input: total,
        });
      }
    }),
  /** The configuration table; absent when the document has none. Since version 5. */
  configurations: ConfigurationsSchema.exactOptional(),
  /**
   * Next number per document-level id counter (`part`, giving `part#n`; `cp` and `cfg`, giving
   * configuration parameter and row ids; `assembly`, giving `assembly#n`; `font`, giving
   * `font#n`). Only ever increases, so an id is never reused. Since version 4.
   */
  nextIds: z.record(z.string(), z.int().min(1)),
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
  OutlineAlign,
  OutlineEntity,
  OutlineSource,
  PointEntity,
  PointPosition,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchPlacement,
  StoredExpression,
  TextOutlineSource,
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
export type ImportSource = z.infer<typeof ImportSourceSchema>;
export type ImportOperation = z.infer<typeof ImportOperationSchema>;
export type ImportFeature = z.infer<typeof ImportFeatureSchema>;
export type DerivedSource = z.infer<typeof DerivedSourceSchema>;
export type DerivedPlacement = z.infer<typeof DerivedPlacementSchema>;
export type DerivedFeature = z.infer<typeof DerivedFeatureSchema>;
export type BodyCopyMode = z.infer<typeof BodyCopyModeSchema>;
export type ThreadSystem = z.infer<typeof ThreadSystemSchema>;
export type ThreadHand = z.infer<typeof ThreadHandSchema>;
export type ThreadRepresentation = z.infer<typeof ThreadRepresentationSchema>;
export type ThreadFeature = z.infer<typeof ThreadFeatureSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureKind = Feature['kind'];
export type Variable = z.infer<typeof VariableSchema>;
export type BodyPropsFields = z.infer<typeof BodyPropsFieldsSchema>;
export type BodyProps = z.infer<typeof BodyPropsSchema>;
export type Part = z.infer<typeof PartSchema>;
export type ConfigParameter = z.infer<typeof ConfigParameterSchema>;
export type ConfigValue = z.infer<typeof ConfigValueSchema>;
export type ConfigRow = z.infer<typeof ConfigRowSchema>;
export type Configurations = z.infer<typeof ConfigurationsSchema>;
export type VertexRef = z.infer<typeof VertexRefSchema>;
export type VertexReference = z.infer<typeof VertexReferenceSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type PartInstanceSource = z.infer<typeof PartInstanceSourceSchema>;
export type InstanceSource = z.infer<typeof InstanceSourceSchema>;
export type Instance = z.infer<typeof InstanceSchema>;
export type ConnectorOffset = z.infer<typeof ConnectorOffsetSchema>;
export type MateConnector = z.infer<typeof MateConnectorSchema>;
export type ConnectorInference = MateConnector['inference'];
export type MateKind = z.infer<typeof MateKindSchema>;
export type MateLimits = z.infer<typeof MateLimitsSchema>;
export type Mate = z.infer<typeof MateSchema>;
export type Assembly = z.infer<typeof AssemblySchema>;
export type PrintThresholds = z.infer<typeof PrintThresholdsSchema>;
export type PrintOrientation = z.infer<typeof PrintOrientationSchema>;
export type PrintItem = z.infer<typeof PrintItemSchema>;
export type PrintSetup = z.infer<typeof PrintSetupSchema>;
export type PrintData = z.infer<typeof PrintDataSchema>;
export type FontSource = z.infer<typeof FontSourceSchema>;
export type DocumentFont = z.infer<typeof FontSchema>;
export type ManufaktureDocument = z.infer<typeof DocumentSchema>;
