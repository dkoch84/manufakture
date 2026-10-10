import type {
  OutlineAlign,
  OutlineSource,
  PathCommand,
  SvgOutlinePath,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchPlacement,
  StoredExpression,
  Vec2,
  Vec3,
} from '@manufakture/sketch/model';
import { z } from 'zod';
import { FEATURE_ID_PATTERN, hasTombstoneSubId, isSubId } from './ids';
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
export const FORMAT_VERSION = 18;
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

/** The document-level `nextIds` key for script ids (`script#n`). Since version 16. */
export const SCRIPT_COUNTER = 'script';
/** A script id: `script#n` with at most 15 digits, counted by the document's `nextIds.script`. */
export const SCRIPT_ID_PATTERN = /^script#[1-9][0-9]{0,14}$/;
export const ScriptIdSchema = z
  .string()
  .max(32, { abort: true })
  .regex(SCRIPT_ID_PATTERN, 'Expected a script id like "script#1"');

/** An extension feature's type: a namespace and one or more dotted names (`wood.board`). */
export const EXTENSION_TYPE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/**
 * A domain namespace (ADR 0013 decision 3): the first segment of an extension type (`wood` of
 * `wood.board`), the key of a `domains` entry. Since version 11.
 */
export const DOMAIN_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/** The longest domain namespace, in characters. */
export const MAX_DOMAIN_NAMESPACE_LENGTH = 64;
/** The most `domains` entries a document may hold; bounds what a crafted file costs to check. */
export const MAX_DOMAINS = 1000;
/**
 * How deeply a domain entry's `data` may nest arrays and objects (a scalar is 0, `{}` is 1). Far
 * beyond any setting, and it keeps parsing iterative-safe: deeper data is a schema error, never a
 * stack overflow, and a whole document stays inside the 64 levels the app's file store walks.
 */
export const MAX_DOMAIN_DATA_DEPTH = 32;

/**
 * Whether `value` nests arrays and objects more than `max` levels deep. Iterative, so a crafted
 * value cannot overflow the stack, and it stops at `max + 1`, so a cyclic value ends too.
 */
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth + 1 > max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

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
/** The denominators a fraction may be shown with. */
export const FractionDenominatorSchema = z.union(
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
);
export const LengthDisplaySchema = z.discriminatedUnion('unit', [
  z.strictObject({ unit: LengthUnitSchema, decimals: decimals.optional() }),
  z.strictObject({
    unit: z.enum(['ft-in', 'in-fraction']),
    denominator: FractionDenominatorSchema.optional(),
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
  )
  .refine(
    (name) => !hasTombstoneSubId(name),
    'A face name names a sub-id of a dropped command (a sync tombstone); the reference was lost',
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
 * The most path commands one SVG outline may have (checked here and again by
 * `@manufakture/sketch`'s `svgOutlineRegions`, with the same value), and all the SVG outlines of
 * one sketch together (checked here only, by `validate.ts`). The paths come from the document,
 * so the caps bound what a crafted file costs to load and to regenerate. A sign's lettering is a
 * few thousand.
 */
export const MAX_SVG_OUTLINE_COMMANDS = 100_000;
export const MAX_SKETCH_SVG_COMMANDS = 100_000;
/** The most paths (shapes of the file) one SVG outline may have. */
export const MAX_SVG_OUTLINE_PATHS = 20_000;

export const PathCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('moveTo'), to: Point2Schema }),
  z.strictObject({ kind: z.literal('lineTo'), to: Point2Schema }),
  z.strictObject({ kind: z.literal('quadTo'), control: Point2Schema, to: Point2Schema }),
  z.strictObject({
    kind: z.literal('cubicTo'),
    control1: Point2Schema,
    control2: Point2Schema,
    to: Point2Schema,
  }),
  z.strictObject({ kind: z.literal('close') }),
]) satisfies z.ZodType<PathCommand>;

export const SvgOutlinePathSchema = z.strictObject({
  fillRule: z.enum(['nonzero', 'evenodd']),
  commands: z.array(PathCommandSchema).max(MAX_SVG_OUTLINE_COMMANDS, { abort: true }),
}) satisfies z.ZodType<SvgOutlinePath>;

/**
 * What an outline is drawn from (ADR 0012 decision 7). `text`: a string in a font of the
 * document, `size` its cap height (a length), `letterSpacing` a length, `lineSpacing` a multiple
 * of the font's line height (a plain number). `svg` (since version 13, M5 T5.8): an SVG file's
 * shapes as paths of lines and Beziers in millimetres in the outline's frame, each with its fill
 * rule, the file's name for display, and `scale` a plain number (absent: 1).
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
  z.strictObject({
    kind: z.literal('svg'),
    fileName: z.string().max(255),
    paths: z
      .array(SvgOutlinePathSchema)
      .max(MAX_SVG_OUTLINE_PATHS, { abort: true })
      .refine(
        (paths) => svgCommandCount(paths) <= MAX_SVG_OUTLINE_COMMANDS,
        `SVG artwork holds at most ${MAX_SVG_OUTLINE_COMMANDS} path commands`,
      ),
    scale: StoredExpressionSchema.exactOptional(),
  }),
]) satisfies z.ZodType<OutlineSource>;

/** Path commands of an SVG outline's paths, in all. */
export function svgCommandCount(paths: readonly { commands: readonly unknown[] }[]): number {
  let n = 0;
  for (const p of paths) n += p.commands.length;
  return n;
}

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

/**
 * What a hole is for when it is not a clearance hole for a screw: `heat-set-insert`, a hole sized
 * for a heat-set threaded insert of `standard.size` (packages/print's `HEAT_SET_INSERTS`, served to
 * agents in the tables resource). Since version 18.
 */
export const HOLE_PURPOSES = ['heat-set-insert'] as const;
export const HolePurposeSchema = z.enum(HOLE_PURPOSES);

/**
 * The standard a hole was sized from: a clearance hole for a screw (`size` and `fit`, from the
 * kernel's `HOLE_SIZES`), or, since version 18, a hole for something the screw goes into (`size`
 * and `purpose`: `{ size: 'M3', purpose: 'heat-set-insert' }`, from the insert table).
 */
export const HoleStandardSchema = z
  .strictObject({
    size: z.string().min(1),
    /** A clearance hole's fit; absent with a `purpose`. */
    fit: HoleFitSchema.exactOptional(),
    /** What the hole is for instead of a clearance fit. Since version 18. */
    purpose: HolePurposeSchema.exactOptional(),
  })
  .check((ctx) => {
    const { fit, purpose } = ctx.value;
    if ((fit === undefined) === (purpose === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message:
          fit === undefined
            ? 'a hole standard needs a fit (a clearance hole) or a purpose'
            : 'a hole standard has a fit (a clearance hole) or a purpose, not both',
        input: ctx.value,
        path: fit === undefined ? ['fit'] : ['purpose'],
      });
    }
  });

export const HoleFeatureSchema = z.strictObject({
  ...base('hole'),
  /** The sketch whose points place the holes, drilled along its normal. */
  sketch: featureId,
  points: z.array(EntityIdSchema).min(1),
  diameter: StoredExpressionSchema,
  /**
   * How deep: `blind` to `depth` (to the shoulder, where the wall ends), or `throughAll`. A blind
   * hole ends in a drill point of `tipAngle` (an angle, more than 0 and at most 180 deg; absent:
   * 118 deg); 180 deg is a flat bottom, as for a heat-set insert. `tipAngle` since version 18.
   */
  extent: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('blind'),
      depth: StoredExpressionSchema,
      tipAngle: StoredExpressionSchema.exactOptional(),
    }),
    z.strictObject({ type: z.literal('throughAll') }),
  ]),
  head: HoleHeadSchema,
  /**
   * What the hole was sized for: a screw's clearance hole (`{ size, fit }`: `M6`, `#10`, `1/4`
   * from the kernel's `HOLE_SIZES`), or since version 18 a heat-set insert (`{ size,
   * purpose: 'heat-set-insert' }`: `M2` to `M5` from packages/print's `HEAT_SET_INSERTS`, whose
   * hole is the diameter, whose length is the least depth, and whose minimum wall goes with the
   * size). Informational: `diameter`, the depth and the head sizes are what regen uses, so a
   * standard hole can still be edited by hand.
   */
  standard: HoleStandardSchema.exactOptional(),
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
 * An extension's `scope` (ADR 0013 decision 6): an extension may change bodies with no
 * `operation` of its own (a joint cuts each board through inputs that name them), so unlike
 * `checkScopeOperation` a scope is refused only when the extension makes a `new` body.
 */
function checkExtensionScopeOperation<T extends { operation?: string; scope?: readonly string[] }>(
  ctx: z.core.ParsePayload<T>,
): void {
  const { operation, scope } = ctx.value;
  if (scope !== undefined && operation === 'new') {
    ctx.issues.push({
      code: 'custom',
      message: 'a "new" operation acts on no existing body, so it has no scope',
      input: scope,
      path: ['scope'],
    });
  }
}

/**
 * The extension point for domain features (woodworking, construction; ADR 0013). `extension` is
 * a dotted, namespaced type (`wood.board`) with its own `schemaVersion`, owned by the domain
 * package. Core understands only the generic parts: feature dependencies, geometry references,
 * expressions, and since version 11 `operation` and `scope`, which it validates like any other
 * feature's. `params` is opaque JSON.
 */
export const ExtensionFeatureSchema = z
  .strictObject({
    ...base('extension'),
    extension: z
      .string()
      .regex(EXTENSION_TYPE_PATTERN, 'Expected a namespaced type like "wood.board"'),
    schemaVersion: z.int().min(1),
    dependsOn: z.array(featureId),
    references: z.array(ReferenceSchema),
    expressions: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), StoredExpressionSchema),
    params: z.record(z.string(), z.json()),
    /**
     * How the extension's solid combines with the part, as for an extrude: with `new` or `add`
     * the extension creates bodies (`extension#n`, or `extension#n:<key>` for several). Absent:
     * it makes no solid of its own to combine. Since version 11.
     */
    operation: BooleanOperationSchema.exactOptional(),
    /**
     * Every body the extension combines with or changes; absent: every body. Allowed without an
     * `operation`, refused with `new`. Since version 11.
     */
    scope,
  })
  .check(checkExtensionScopeOperation);

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

// ---------------------------------------------------------------------------------------------
// Scripts and scripted features (since version 16; ADR 0010 decisions 3, 6, 8 and 9)

/** The languages a script may be written in: TypeScript is erased before it runs (decision 7). */
export const SCRIPT_LANGUAGES = ['js', 'ts'] as const;
export const ScriptLanguageSchema = z.enum(SCRIPT_LANGUAGES);
/** The longest script name, in characters. */
export const MAX_SCRIPT_NAME = 200;
/**
 * The largest script source, as UTF-8 bytes (256 KiB). A scripted feature's script is a page or
 * two; the cap bounds what a crafted file costs to hash, erase and compile on every regen. The
 * schema checks the text length first (a UTF-8 length is never less) before counting bytes.
 */
export const MAX_SCRIPT_SOURCE_BYTES = 256 * 1024;
/** The most scripts a document may hold. */
export const MAX_SCRIPTS = 256;
/** The most source bytes the scripts of one document may hold in all (4 MiB). */
export const MAX_SCRIPT_TOTAL_BYTES = 4 * 1024 * 1024;
/**
 * The largest script API version a script may name. API versions are small integers from 1; the
 * cap only keeps the value a plain, safe number. Which versions exist is regen's to know: a
 * version it does not have is a feature error there, never a load error, so a newer API never
 * makes a file unreadable.
 */
export const MAX_SCRIPT_API_VERSION = 1_000_000;

/** The UTF-8 bytes the sources of a script list hold in all. */
export function scriptBytes(scripts: readonly { source: string }[]): number {
  let total = 0;
  for (const s of scripts) total += utf8Length(s.source);
  return total;
}

/**
 * A script of the document's library: a permanent id scripted features name it by (`script#n`,
 * never reused), a display name, its language, the script API version it was written against
 * and its source as the user typed it. A script runs unchanged, with the same results, under its
 * `apiVersion` forever (ADR 0010 amendment, item 12), so the version is stored, never inferred.
 */
export const ScriptSchema = z
  .strictObject({
    id: ScriptIdSchema,
    name: z.string().trim().min(1).max(MAX_SCRIPT_NAME),
    language: ScriptLanguageSchema,
    apiVersion: z.int().min(1).max(MAX_SCRIPT_API_VERSION),
    source: z.string().max(MAX_SCRIPT_SOURCE_BYTES, { abort: true }),
  })
  .check((ctx) => {
    const bytes = utf8Length(ctx.value.source);
    if (bytes > MAX_SCRIPT_SOURCE_BYTES) {
      ctx.issues.push({
        code: 'custom',
        message: `the source is ${bytes} bytes of UTF-8; at most ${MAX_SCRIPT_SOURCE_BYTES} are allowed`,
        input: bytes,
        path: ['source'],
      });
    }
  });

/** A script parameter's name: an identifier, as the script declares it. */
export const SCRIPT_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** The most parameter values one scripted feature may hold. */
export const MAX_SCRIPT_PARAMS = 256;
/** The most references one reference parameter may hold. */
export const MAX_SCRIPT_PARAM_REFERENCES = 1000;
/** The longest `choice` value, in characters. */
export const MAX_SCRIPT_CHOICE = 200;
/** The largest `seed`: seeds are unsigned 32-bit integers. */
export const MAX_SCRIPT_SEED = 0xffff_ffff;

/**
 * One parameter value of a scripted feature (ADR 0010 decision 6). The script declares its
 * parameters (`length`, `angle`, `number`, `boolean`, `choice`, `reference`); the feature stores
 * the values: an expression for the numeric kinds (variables and units like every other field),
 * a boolean, a choice by its value, or geometry references (`r<n>` ids of the part, face or edge
 * names). Whether a value fits the declaration is regen's to check, by running the script.
 */
export const ScriptParamValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('expression'), expression: StoredExpressionSchema }),
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('choice'), value: z.string().max(MAX_SCRIPT_CHOICE) }),
  z.strictObject({
    kind: z.literal('reference'),
    references: z.array(ReferenceSchema).max(MAX_SCRIPT_PARAM_REFERENCES),
  }),
]);

/**
 * A feature whose geometry a script of the document's library computes (ADR 0010 decision 8).
 * `script` names the script; `params` holds the parameter values by name; `seed` seeds the
 * script's `Math.random` together with the source hash (decision 3), never the feature id, so a
 * remap or a merge never changes geometry; `dependsOn` lists features the script reads by id,
 * as an extension's does. Faces it makes are named `<id>:<operation id>/<name>` (decision 6).
 * Since version 16.
 */
export const ScriptedFeatureSchema = z
  .strictObject({
    ...base('scripted'),
    script: ScriptIdSchema,
    params: z.record(
      z.string().regex(SCRIPT_PARAM_NAME_PATTERN, 'Expected a parameter name like "width"'),
      ScriptParamValueSchema,
    ),
    seed: z.int().min(0).max(MAX_SCRIPT_SEED),
    dependsOn: z.array(featureId),
  })
  .check((ctx) => {
    const count = Object.keys(ctx.value.params).length;
    if (count > MAX_SCRIPT_PARAMS) {
      ctx.issues.push({
        code: 'custom',
        message: `a scripted feature holds at most ${MAX_SCRIPT_PARAMS} parameter values, not ${count}`,
        input: count,
        path: ['params'],
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
  ScriptedFeatureSchema,
]);

/** Every feature `kind`, in schema order (featureKinds.ts, kept apart for the name parser). */
export { FEATURE_KINDS } from './featureKinds';

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

/**
 * The part `nextIds` counter for body group ids (`group#n`). Since version 17. It shares the part's
 * counters with the feature kinds, so `group` is reserved: no feature kind may be named `group`.
 */
export const BODY_GROUP_COUNTER = 'group';
export const BODY_GROUP_ID_PATTERN = /^group#[1-9][0-9]{0,14}$/;
export const BodyGroupIdSchema = z
  .string()
  .max(32, { abort: true })
  .regex(BODY_GROUP_ID_PATTERN, 'Expected a body group id like "group#1"');

/** The most body groups one part may have. */
export const MAX_BODY_GROUPS = 1000;

/**
 * A named group of a part's bodies, to show, hide and isolate them together (the seat, the pedal
 * box of a rig). It describes the model like a body name, so it is document data; whether a group
 * is hidden is view state, like a body's (M2 plan decision 5). `bodies` lists body ids in the
 * user's order and may be empty. A body is in at most one group of its part. A member whose body
 * no longer exists (its feature was deleted, or it merged into another body) stays listed and is
 * simply not shown: body ids are never reused, so it can never pick up another body, and it is
 * back in its group when the body comes back (an undo, the rollback bar, an unsuppress). Since
 * version 17.
 */
export const BodyGroupSchema = z.strictObject({
  id: BodyGroupIdSchema,
  name: featureName,
  bodies: z.array(BodyIdSchema).max(MAX_BODY_LIST),
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
  /** Next number per id counter (feature kind, `e`, `k`, `r`, or `group`). Only ever increases. */
  nextIds: z.record(z.string(), z.int().min(1)),
  /**
   * What the part's bodies are made of: a built-in material id (`MATERIALS`). Absent: not set.
   * A body with its own `material` in `bodies` uses that instead. Since version 2.
   */
  material: MaterialIdSchema.exactOptional(),
  /** Per-body names, colours and materials, for the bodies that have any. Since version 4. */
  bodies: z.array(BodyPropsSchema).max(MAX_BODY_LIST),
  /** Body groups, in list order; absent when the part has none. Since version 17. */
  bodyGroups: z.array(BodyGroupSchema).min(1).max(MAX_BODY_GROUPS).exactOptional(),
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

// Exploded views (since version 12; M4 plan decision 9): named, ordered steps that move instances
// for display, on top of the solved poses, never changing them.

/** Assembly-level `nextIds` keys for exploded views (`explode#n`) and their steps (`step#n`). */
export const EXPLODED_VIEW_COUNTER = 'explode';
export const EXPLODE_STEP_COUNTER = 'step';
export const EXPLODED_VIEW_ID_PATTERN = /^explode#[1-9][0-9]{0,14}$/;
export const EXPLODE_STEP_ID_PATTERN = /^step#[1-9][0-9]{0,14}$/;
export const ExplodedViewIdSchema = counted(EXPLODED_VIEW_ID_PATTERN, 'explode#1');
export const ExplodeStepIdSchema = counted(EXPLODE_STEP_ID_PATTERN, 'step#1');

const nonZeroVec3 = Vec3Schema.check((ctx) => {
  if (!nonZero(ctx.value)) {
    ctx.issues.push({ code: 'custom', message: 'a direction must not be zero', input: ctx.value });
  }
});

/**
 * Which way a step moves its instances. `vector`: a direction in the assembly's frame (any
 * length but zero; only its direction counts). `edge` or `face`: the direction of a named line
 * edge, or the normal of a planar face or the axis of a cylindrical face, of `instance` (an
 * instance of the same assembly) at its solved pose, in that instance's part's names, as a mate
 * connector's origin; `flip` turns it round. Resolving a reference is regen's (T4.5a): a lost one
 * is a warning on the step, never a load error.
 */
export const ExplodeDirectionSchema = z.union([
  z.strictObject({ vector: nonZeroVec3 }),
  z.strictObject({
    instance: InstanceIdSchema,
    edge: EdgeRefSchema,
    flip: z.literal(true).exactOptional(),
  }),
  z.strictObject({
    instance: InstanceIdSchema,
    face: FaceRefSchema,
    flip: z.literal(true).exactOptional(),
  }),
]);

/** One step: move `instances` along `direction` by `distance` (a length expression). */
export const ExplodeStepSchema = z.strictObject({
  id: ExplodeStepIdSchema,
  /** Instances of the same assembly, each once. */
  instances: z.array(InstanceIdSchema).min(1).max(MAX_ASSEMBLY_ITEMS),
  direction: ExplodeDirectionSchema,
  distance: StoredExpressionSchema,
});

/**
 * An exploded view of an assembly. Steps apply in order and add up: an instance moved by two
 * steps ends up at the sum of both moves, each along its direction as resolved at the solved
 * poses.
 */
export const ExplodedViewSchema = z.strictObject({
  id: ExplodedViewIdSchema,
  name: featureName,
  steps: z.array(ExplodeStepSchema).max(MAX_ASSEMBLY_ITEMS),
});

/** An assembly (README, "Assemblies"). Since version 7. */
export const AssemblySchema = z.strictObject({
  id: AssemblyIdSchema,
  name: featureName,
  instances: z.array(InstanceSchema).max(MAX_ASSEMBLY_ITEMS),
  /** In creation order: the last is the newest. */
  mates: z.array(MateSchema).max(MAX_ASSEMBLY_ITEMS),
  /**
   * Exploded views, in display order; absent when the assembly has none, never empty. Since
   * version 12.
   */
  explodedViews: z.array(ExplodedViewSchema).min(1).max(MAX_ASSEMBLY_ITEMS).exactOptional(),
  /**
   * Next number per id counter (`inst`, `mate`, `mc`, `r`, `explode`, `step`). Only ever
   * increases.
   */
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

// ---------------------------------------------------------------------------------------------
// Drawings (since version 12; M4 plan decision 7, T4.4a spike "the dimension model"). Document
// state, not features: a drawing changes no geometry. Views are computed by regen on request and
// never stored; a dimension stores model references, never drawing geometry.

/** The document-level `nextIds` key for drawing ids (`drawing#n`). */
export const DRAWING_COUNTER = 'drawing';
/** Drawing-level `nextIds` keys: sheets, views, dimensions and notes. */
export const SHEET_COUNTER = 'sheet';
export const VIEW_COUNTER = 'view';
export const DIMENSION_COUNTER = 'dim';
export const NOTE_COUNTER = 'note';
export const DRAWING_ID_PATTERN = /^drawing#[1-9][0-9]{0,14}$/;
export const SHEET_ID_PATTERN = /^sheet#[1-9][0-9]{0,14}$/;
export const VIEW_ID_PATTERN = /^view#[1-9][0-9]{0,14}$/;
export const DIMENSION_ID_PATTERN = /^dim#[1-9][0-9]{0,14}$/;
export const NOTE_ID_PATTERN = /^note#[1-9][0-9]{0,14}$/;
export const DrawingIdSchema = counted(DRAWING_ID_PATTERN, 'drawing#1');
export const SheetIdSchema = counted(SHEET_ID_PATTERN, 'sheet#1');
export const ViewIdSchema = counted(VIEW_ID_PATTERN, 'view#1');
export const DimensionIdSchema = counted(DIMENSION_ID_PATTERN, 'dim#1');
export const NoteIdSchema = counted(NOTE_ID_PATTERN, 'note#1');

/**
 * The most drawings a document, sheets a drawing, and views, dimensions or notes a sheet may hold.
 * A real drawing has a few sheets of tens of views; the caps bound what a crafted file costs.
 */
export const MAX_DRAWING_ITEMS = 10_000;
/**
 * The farthest any paper coordinate or offset may be from the sheet's corner, in millimetres
 * (1 km). Far beyond A0; it keeps a crafted value from wrecking layout arithmetic.
 */
export const MAX_PAPER_COORDINATE = 1e6;
/** The most code points a note's text, or a dimension's text override, may have. */
export const MAX_NOTE_TEXT = 10_000;
/** The most fields a title block may have, and the longest label and value, in code points. */
export const MAX_TITLE_FIELDS = 100;
export const MAX_TITLE_LABEL = 100;
export const MAX_TITLE_VALUE = 1000;
/** The longest instance path a dimension reference may store. Assemblies do not nest yet. */
export const MAX_INSTANCE_PATH = 32;

/** A string of `min` to `max` code points (the cheap UTF-16 bound first). */
const codePoints = (max: number, what: string, min = 0) =>
  z
    .string()
    .min(min)
    .max(2 * max, { abort: true })
    .refine((t) => codePointLength(t) <= max, `${what} holds at most ${max} characters`);

const paperNumber = z.number().min(-MAX_PAPER_COORDINATE).max(MAX_PAPER_COORDINATE);
/** A point or offset on the paper, in millimetres. */
export const PaperPointSchema = z.tuple([paperNumber, paperNumber]).readonly();

/** The standard sheet sizes (ISO 216 A0 to A4; US letter and tabloid). */
export const SHEET_SIZES = ['A4', 'A3', 'A2', 'A1', 'A0', 'letter', 'tabloid'] as const;
/** Each standard size's sides in millimetres, the shorter first. */
export const SHEET_SIZE_MM: Readonly<
  Record<(typeof SHEET_SIZES)[number], readonly [number, number]>
> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
  letter: [215.9, 279.4],
  tabloid: [279.4, 431.8],
};
export const SheetSizeSchema = z.union([
  z.enum(SHEET_SIZES),
  /** A custom size: the two sides, as length expressions. */
  z.strictObject({ width: StoredExpressionSchema, height: StoredExpressionSchema }),
]);

export const TitleBlockSchema = z.strictObject({
  /** Label and value pairs, in display order (`Title`, `Drawn by`, `Material`). */
  fields: z
    .array(
      z.strictObject({
        label: codePoints(MAX_TITLE_LABEL, 'A title block label', 1),
        value: codePoints(MAX_TITLE_VALUE, 'A title block value'),
      }),
    )
    .max(MAX_TITLE_FIELDS),
});

/** How deeply a domain view's `params` may nest arrays and objects (a scalar is 0, `{}` is 1). */
export const MAX_VIEW_PARAMS_DEPTH = 8;
/** The longest a domain view's `params` may be as JSON, in UTF-16 code units. */
export const MAX_VIEW_PARAMS_LENGTH = 16_384;

/**
 * A domain view's params (since version 15): opaque JSON owned by the domain, nested at most
 * `MAX_VIEW_PARAMS_DEPTH` levels and at most `MAX_VIEW_PARAMS_LENGTH` long as JSON. Both are
 * checked before `z.json()` walks it, without recursion, so a crafted value is a schema error.
 */
const ViewParamsSchema = z
  .unknown()
  .check((ctx) => {
    const v = ctx.value;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      ctx.issues.push({ code: 'custom', message: 'view params are a JSON object', input: v });
    } else if (nestsDeeperThan(v, MAX_VIEW_PARAMS_DEPTH)) {
      ctx.issues.push({
        code: 'custom',
        message: `view params may nest at most ${MAX_VIEW_PARAMS_DEPTH} levels`,
        input: v,
      });
    } else {
      // JSON.stringify throws on a BigInt (an in-memory command can hold anything).
      let length: number;
      try {
        length = JSON.stringify(v)?.length ?? 0;
      } catch {
        ctx.issues.push({ code: 'custom', message: 'view params are not plain JSON', input: v });
        return;
      }
      if (length > MAX_VIEW_PARAMS_LENGTH) {
        ctx.issues.push({
          code: 'custom',
          message: `view params are at most ${MAX_VIEW_PARAMS_LENGTH} characters as JSON`,
          input: v,
        });
      }
    }
  })
  .pipe(z.record(z.string(), z.json()));

/**
 * What a view shows: a part studio of this document (all its bodies, or the listed ones, by body
 * id in that part), or an assembly of this document, assembled or as one of its exploded views,
 * or (since version 15) a domain view of a part: a view a domain draws from its own data (a
 * construction floor plan or framing elevation, ADR 0015 decision 9). `domain` names the domain
 * by namespace; `params` (its own, at its own `schemaVersion`) say what it draws, and the domain
 * chooses the view's frame and section from them. Core checks only this envelope and the part.
 */
export const ViewSourceSchema = z.union([
  z.strictObject({
    part: z.string().min(1).max(MAX_PART_ID_LENGTH),
    bodies: z.array(BodyIdSchema).min(1).max(MAX_BODY_LIST).exactOptional(),
  }),
  z.strictObject({
    assembly: AssemblyIdSchema,
    explodedView: ExplodedViewIdSchema.exactOptional(),
  }),
  z.strictObject({
    domain: z
      .string()
      .max(MAX_DOMAIN_NAMESPACE_LENGTH, { abort: true })
      .regex(DOMAIN_NAMESPACE_PATTERN, 'Expected a domain namespace like "construction"'),
    part: z.string().min(1).max(MAX_PART_ID_LENGTH),
    schemaVersion: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    params: ViewParamsSchema,
  }),
]);

/** The named standard views (third-angle, Z up), with their directions in `STANDARD_VIEWS`. */
export const STANDARD_VIEW_NAMES = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
  'isometric',
] as const;
export type StandardViewName = (typeof STANDARD_VIEW_NAMES)[number];

const S3 = 1 / Math.sqrt(3);
/**
 * Each standard view's `direction` (the way the viewer looks, from the eye into the model) and
 * `up` (the model direction that points up on the paper), for a Z-up model: front looks along +Y,
 * right along -X, top down -Z; isometric looks down from the front right. As in the T4.4a spike.
 */
export const STANDARD_VIEWS: Readonly<
  Record<StandardViewName, { readonly direction: Vec3; readonly up: Vec3 }>
> = {
  front: { direction: [0, 1, 0], up: [0, 0, 1] },
  back: { direction: [0, -1, 0], up: [0, 0, 1] },
  left: { direction: [1, 0, 0], up: [0, 0, 1] },
  right: { direction: [-1, 0, 0], up: [0, 0, 1] },
  top: { direction: [0, 0, -1], up: [0, 1, 0] },
  bottom: { direction: [0, 0, 1], up: [0, -1, 0] },
  isometric: { direction: [-S3, S3, -S3], up: [0, 0, 1] },
};

/**
 * A view direction: a standard view by name, or a custom one (`direction` the way the viewer
 * looks, `up` the model direction shown upwards; both non-zero, not parallel; in the frame of the
 * view's part or assembly). Orthographic only.
 */
export const ViewDirectionSchema = z.union([
  z.enum(STANDARD_VIEW_NAMES),
  z.strictObject({ direction: nonZeroVec3, up: nonZeroVec3 }).check((ctx) => {
    const { direction: d, up: u } = ctx.value;
    const cross = Math.hypot(
      d[1] * u[2] - d[2] * u[1],
      d[2] * u[0] - d[0] * u[2],
      d[0] * u[1] - d[1] * u[0],
    );
    if (nonZero(d) && nonZero(u) && cross / (Math.hypot(...d) * Math.hypot(...u)) < 1e-9) {
      ctx.issues.push({
        code: 'custom',
        message: 'up must not be parallel to the view direction',
        input: u,
        path: ['up'],
      });
    }
  }),
]);

/**
 * A view's scale, paper length to model length, both length expressions: `1:5` is `paper` 1 and
 * `model` 5 (any one unit), `1-1/2" = 1'` is `paper` 1-1/2" and `model` 1'. How it is written on
 * the sheet is `packages/drawing`'s; the ratio is what the expressions evaluate to.
 */
export const ViewScaleSchema = z.strictObject({
  paper: StoredExpressionSchema,
  model: StoredExpressionSchema,
});

/** How a view is drawn. */
export const ViewOptionsSchema = z.strictObject({
  /** Draw hidden edges (dashed). */
  hidden: z.boolean(),
  /** Draw smooth edges (where tangent faces meet). */
  smooth: z.boolean(),
  /**
   * A section view: the model is cut by the plane at signed distance `offset` (a length) from
   * the model origin along `normal`, and the part on the side `normal` points to is removed.
   * Absent: no section.
   */
  section: z.strictObject({ normal: nonZeroVec3, offset: StoredExpressionSchema }).exactOptional(),
});

export const ViewSchema = z.strictObject({
  id: ViewIdSchema,
  /** A caption (`SECTION A-A`); absent: none. */
  label: codePoints(MAX_TITLE_LABEL, 'A view label', 1).exactOptional(),
  source: ViewSourceSchema,
  direction: ViewDirectionSchema,
  scale: ViewScaleSchema,
  /**
   * Where the projection of the model origin (the part's or assembly's) lands on the sheet, in
   * paper millimetres from the sheet's bottom-left corner. Anchored to the origin, not to the
   * projected geometry, so a model edit never moves a view.
   */
  position: PaperPointSchema,
  options: ViewOptionsSchema,
});

const refTarget = {
  /** The body the reference is on, by body id in the view's part (or in the instance's part). */
  body: BodyIdSchema,
  /**
   * Assembly views only: the instance path from the view's assembly to the part, today one
   * instance id (assemblies do not nest). Absent in a part view.
   */
  instance: z.array(InstanceIdSchema).min(1).max(MAX_INSTANCE_PATH).exactOptional(),
};

/**
 * A model reference a dimension measures (T4.4a): a vertex (the kernel's `vertexName`), an edge
 * (ADR 0004's `EdgeRef`) or a face (`FaceRef`: planes, and cylinders for radius, diameter and
 * silhouettes), on one body, by name. Regen resolves it like a feature's reference.
 */
export const DimensionRefSchema = z.union([
  z.strictObject({ vertex: VertexRefSchema, ...refTarget }),
  z.strictObject({ edge: EdgeRefSchema, ...refTarget }),
  z.strictObject({ face: FaceRefSchema, ...refTarget }),
]);
/** An edge or a face reference: what a radius, diameter or angle dimension can measure. */
const EdgeOrFaceRefSchema = z.union([
  z.strictObject({ edge: EdgeRefSchema, ...refTarget }),
  z.strictObject({ face: FaceRefSchema, ...refTarget }),
]);

export const LINEAR_DIMENSION_KINDS = ['horizontal', 'vertical', 'aligned'] as const;
export const DIMENSION_KIND_NAMES = [
  ...LINEAR_DIMENSION_KINDS,
  'radius',
  'diameter',
  'angle',
] as const;

const dimensionBase = {
  id: DimensionIdSchema,
  /** The view on the same sheet the dimension is drawn in, and whose projection places it. */
  view: ViewIdSchema,
  /** Replaces the shown value; `<>` in it stands for the value. Absent: the value alone. */
  text: codePoints(MAX_NOTE_TEXT, 'A dimension text', 1).exactOptional(),
  /** Decimal places when the value shows as a decimal (lengths in mm, cm, m, in, ft; angles). */
  decimals: z.int().min(0).max(12).exactOptional(),
  /** The fraction denominator when the length shows in `ft-in` or `in-fraction`. */
  denominator: FractionDenominatorSchema.exactOptional(),
};

/**
 * A dimension (README, "Drawings"). Values are never stored: regen measures the references on the
 * current model at every use, so the dimension follows model edits, and is `lost` when a
 * reference is.
 *
 * - Linear (`horizontal`, `vertical`, `aligned`): two references. Each anchors at a point: a
 *   vertex; a line edge's midpoint or a circular edge's centre; a planar face is a plane. Between
 *   a point and a plane, or two parallel planes, the distance is measured along the (first) plane's
 *   normal: two planar faces store both face references and nothing else. `offset` is the signed
 *   distance, in paper mm, from the first anchor to the dimension line, measured along the
 *   measuring direction turned a quarter turn counter-clockwise (for `horizontal`: upwards).
 * - `radius`, `diameter`: one circular edge or cylindrical face. `at` is where the value's text
 *   sits, in paper mm from the projected centre (a circle seen face on) or from the midpoint of
 *   the projected axis (a cylinder seen across, drawn between its two silhouettes): the leader's
 *   direction and length both come from it.
 * - `angle`: two line edges or planar faces (a plane seen edge on is a line). The arc is centred
 *   where the two projected lines meet; `at` is a point on the arc, in paper mm from there, so it
 *   gives the arc's radius and which of the four angles is meant (the one containing `at`).
 */
export const DimensionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...dimensionBase,
    kind: z.enum(LINEAR_DIMENSION_KINDS),
    refs: z.tuple([DimensionRefSchema, DimensionRefSchema]),
    offset: paperNumber,
  }),
  z.strictObject({
    ...dimensionBase,
    kind: z.enum(['radius', 'diameter']),
    refs: z.tuple([EdgeOrFaceRefSchema]),
    at: PaperPointSchema,
  }),
  z.strictObject({
    ...dimensionBase,
    kind: z.literal('angle'),
    refs: z.tuple([EdgeOrFaceRefSchema, EdgeOrFaceRefSchema]),
    at: PaperPointSchema,
  }),
]);

/**
 * Text on a sheet. With `view`, `position` is relative to the view's `position`, so the note
 * moves with the view; without, it is from the sheet's bottom-left corner. Paper mm.
 */
export const NoteSchema = z.strictObject({
  id: NoteIdSchema,
  view: ViewIdSchema.exactOptional(),
  position: PaperPointSchema,
  text: codePoints(MAX_NOTE_TEXT, 'A note', 1),
});

export const SheetSchema = z.strictObject({
  id: SheetIdSchema,
  name: featureName,
  size: SheetSizeSchema,
  /** Landscape: the longer side runs across; portrait: up. For a custom size too. */
  orientation: z.enum(['landscape', 'portrait']),
  /** Absent: no title block. */
  titleBlock: TitleBlockSchema.exactOptional(),
  views: z.array(ViewSchema).max(MAX_DRAWING_ITEMS),
  /** In drawing order. */
  dimensions: z.array(DimensionSchema).max(MAX_DRAWING_ITEMS),
  notes: z.array(NoteSchema).max(MAX_DRAWING_ITEMS),
});

/** A drawing: sheets of views, dimensions and notes (README, "Drawings"). Since version 12. */
export const DrawingSchema = z.strictObject({
  id: DrawingIdSchema,
  name: featureName,
  /** In page order. */
  sheets: z.array(SheetSchema).max(MAX_DRAWING_ITEMS),
  /** Next number per id counter (`sheet`, `view`, `dim`, `note`). Only ever increases. */
  nextIds: z.record(z.string(), z.int().min(1)),
});

// ---------------------------------------------------------------------------------------------
// CAM (since version 14; ADR 0014). Document state, not features: a setup and its operations
// change no geometry, so they are outside every feature list and never dirty a regen. Nothing
// derived (loops, toolpaths, G-code) is stored.

/**
 * `cam.nextIds` keys: tools (`tool#n`), setups (`setup#n`), one per operation kind
 * (`profile#n`, `pocket#n`, ...), and `r` for face references (`r<n>`). The ids are unique
 * across the whole `cam` section and a namespace separate from every part's and from `print`'s.
 */
export const CAM_TOOL_COUNTER = 'tool';
export const CAM_SETUP_COUNTER = 'setup';
/** The CAM operation kinds, each also the `cam.nextIds` key of its ids. */
export const CAM_OPERATION_KINDS = [
  'facing',
  'profile',
  'pocket',
  'drill',
  'vcarve',
  'surface3d',
] as const;
export type CamOperationKind = (typeof CAM_OPERATION_KINDS)[number];
/** Every key `cam.nextIds` may hold. */
export const CAM_COUNTERS: readonly string[] = [
  CAM_TOOL_COUNTER,
  CAM_SETUP_COUNTER,
  ...CAM_OPERATION_KINDS,
  'r',
];
export const CAM_TOOL_ID_PATTERN = /^tool#[1-9][0-9]{0,14}$/;
export const CAM_SETUP_ID_PATTERN = /^setup#[1-9][0-9]{0,14}$/;
/** An operation id of any kind: `<kind>#n`. Each kind's schema accepts its own prefix only. */
export const CAM_OPERATION_ID_PATTERN = new RegExp(
  `^(?:${CAM_OPERATION_KINDS.join('|')})#[1-9][0-9]{0,14}$`,
);
/**
 * A CAM table id: a machine (`shapeoko-5-pro-4x4`), a post (`grbl`), a feed preset's material
 * category (`plywood`), a tool library and a tool in it. Lower-case letters, digits, `.`, `_` and
 * `-`, at most 64 characters. The tables are data in `packages/cam` (ADR 0014 decision 11),
 * checked when a setup is used, never here: they grow without a format change, and a document
 * naming a machine or post this build does not know still loads (ADR 0014 decision 6).
 */
export const CAM_TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Bounds on what a crafted file costs to check: tools, setups, operations (in the whole
 * section), geometry sources per operation and in the whole section, feed presets per tool, and
 * entities a region source lists. A real job has a handful of each.
 */
export const MAX_CAM_TOOLS = 1000;
export const MAX_CAM_SETUPS = 1000;
export const MAX_CAM_OPERATIONS = 10_000;
export const MAX_CAM_SOURCES = 1000;
export const MAX_CAM_TOTAL_SOURCES = 100_000;
export const MAX_CAM_PRESETS = 100;
export const MAX_CAM_REGION_ENTITIES = 10_000;
/** The longest source text of a CAM expression, in UTF-16 units. */
export const MAX_CAM_EXPRESSION = 10_000;
/** The largest tool number a post writes (`T<n>`), and the most flutes a tool may have. */
export const MAX_CAM_TOOL_NUMBER = 99_999;
export const MAX_CAM_FLUTES = 32;
/** The longest entity id a region source may list (split pieces included). */
const MAX_CAM_ENTITY_ID = 256;

export const CamToolIdSchema = counted(CAM_TOOL_ID_PATTERN, 'tool#1');
export const CamSetupIdSchema = counted(CAM_SETUP_ID_PATTERN, 'setup#1');
export const CamOperationIdSchema = counted(CAM_OPERATION_ID_PATTERN, 'profile#1');
export const CamTableIdSchema = z
  .string()
  .max(64, { abort: true })
  .regex(CAM_TABLE_ID_PATTERN, 'Expected an id like "shapeoko-5-pro-4x4"');

/** A `StoredExpression` whose source is at most `MAX_CAM_EXPRESSION` units long. */
const camExpression = z.strictObject({
  source: z.string().max(MAX_CAM_EXPRESSION, { abort: true }),
  lengthUnit: LengthUnitSchema,
  angleUnit: AngleUnitSchema,
}) satisfies z.ZodType<StoredExpression>;

/**
 * Feeds and speeds for one material category, as expressions: `spindle` a spindle speed
 * (`18000rpm`), `feed` and `plunge` feed rates (`1000mm/min`), `stepdown` a length, `stepover`
 * a fraction of the tool diameter (a plain number, `0.4`).
 */
export const CamFeedPresetSchema = z.strictObject({
  material: CamTableIdSchema,
  spindle: camExpression,
  feed: camExpression,
  plunge: camExpression,
  stepdown: camExpression,
  stepover: camExpression,
});

export const CAM_TOOL_KINDS = ['flat', 'ball', 'bull', 'vbit', 'drill', 'engraver'] as const;

/**
 * A cutting tool, copied into the document from a library (ADR 0014 decision 11). Lengths are
 * expressions, so `1/4"` is a valid diameter in a millimetre document. `cornerRadius` belongs to
 * (and is required by) a `bull` tool; `angle` (the included angle) is required by a `vbit` and
 * allowed on a `drill` (its point angle); `tipDiameter` (a flat tip) is a `vbit`'s only.
 */
export const CamToolSchema = z
  .strictObject({
    id: CamToolIdSchema,
    name: featureName,
    kind: z.enum(CAM_TOOL_KINDS),
    /** The tool number a post writes with `T` (and `M6`); absent: none written. */
    number: z.int().min(0).max(MAX_CAM_TOOL_NUMBER).exactOptional(),
    diameter: camExpression,
    fluteLength: camExpression,
    flutes: z.int().min(1).max(MAX_CAM_FLUTES),
    cornerRadius: camExpression.exactOptional(),
    angle: camExpression.exactOptional(),
    tipDiameter: camExpression.exactOptional(),
    /** One per material category, each category once. */
    presets: z.array(CamFeedPresetSchema).max(MAX_CAM_PRESETS),
    /** Where the tool was copied from; absent: made in this document. */
    source: z.strictObject({ library: CamTableIdSchema, id: CamTableIdSchema }).exactOptional(),
  })
  .check((ctx) => {
    const t = ctx.value;
    const issue = (message: string, path: string) =>
      ctx.issues.push({ code: 'custom', message, input: t, path: [path] });
    if (t.kind === 'bull' && t.cornerRadius === undefined) {
      issue('a bull nose tool has a corner radius', 'cornerRadius');
    }
    if (t.kind !== 'bull' && t.cornerRadius !== undefined) {
      issue(`a ${t.kind} tool has no corner radius`, 'cornerRadius');
    }
    if (t.kind === 'vbit' && t.angle === undefined) issue('a V-bit has an included angle', 'angle');
    if (t.kind !== 'vbit' && t.kind !== 'drill' && t.angle !== undefined) {
      issue(`a ${t.kind} tool has no angle`, 'angle');
    }
    if (t.kind !== 'vbit' && t.tipDiameter !== undefined) {
      issue(`a ${t.kind} tool has no tip diameter`, 'tipDiameter');
    }
    const seen = new Set<string>();
    t.presets.forEach((p, i) => {
      if (seen.has(p.material)) {
        ctx.issues.push({
          code: 'custom',
          message: `the tool has two presets for "${p.material}"`,
          input: p.material,
          path: ['presets', i, 'material'],
        });
      }
      seen.add(p.material);
    });
  });

/**
 * The stock, as a box in the setup frame (ADR 0014 decision 2; `packages/cam`'s
 * `stockFromBounds` and `stockFromSize`). `fromBody`: the body's bounds grown by `margins` (each
 * a length, zero or more: `xMin` to `yMax` on the sides, `top` above, `bottom` below).
 * `explicit`: a box of `size`, placed so the body's minimum corner sits `offset` in from the
 * stock's minimum corner. `material` is a material category for feed presets and the setup
 * sheet (a CAM table id, checked at use); absent: not set.
 */
export const CamStockSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fromBody'),
    margins: z.strictObject({
      xMin: camExpression,
      xMax: camExpression,
      yMin: camExpression,
      yMax: camExpression,
      top: camExpression,
      bottom: camExpression,
    }),
    material: CamTableIdSchema.exactOptional(),
  }),
  z.strictObject({
    kind: z.literal('explicit'),
    size: z.strictObject({ x: camExpression, y: camExpression, z: camExpression }),
    offset: z.strictObject({ x: camExpression, y: camExpression, z: camExpression }),
    material: CamTableIdSchema.exactOptional(),
  }),
]);

/** The model axes a setup can turn to machine +Z. */
export const CAM_UP_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
/** Where the WCS origin sits in XY on the stock, seen from above with the operator in front. */
export const CAM_WCS_CORNERS = [
  'front-left',
  'front-right',
  'back-left',
  'back-right',
  'centre',
] as const;

/**
 * The work coordinate system. `up`: a model axis, or a planar face (its outward normal becomes
 * machine +Z), resolved on the setup's final body like an operation's face (ADR 0014 decision 5).
 * `origin`: a corner or the centre of the stock in XY, its top or bottom in Z.
 */
export const CamWcsSchema = z.strictObject({
  up: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('axis'), axis: z.enum(CAM_UP_AXES) }),
    z.strictObject({ kind: z.literal('face'), face: FaceReferenceSchema }),
  ]),
  origin: z.strictObject({
    xy: z.enum(CAM_WCS_CORNERS),
    z: z.enum(['top', 'bottom']),
  }),
});

/** A region source's entity id (`e3`, a split piece `e3#a`). */
const camEntityId = z
  .string()
  .max(MAX_CAM_ENTITY_ID, { abort: true })
  .refine((s) => isSubId(s, 'e'), 'Expected an id like "e1"');

/**
 * Where an operation's geometry comes from, by name (ADR 0014 decisions 2, 4 and 5): a planar
 * face of the setup's body (a `FaceReference`, `r<n>` from `cam.nextIds`), a sketch region
 * (`sketch` a sketch feature of the setup's part; `entities` the entities bounding the chosen
 * regions, absent: every closed region), or a hole feature (its axis points and through-hole
 * diameter). Whether they still exist is a CAM workspace result (`reference-lost`), never a load
 * or command error (ADR 0014 decision 6).
 */
export const CamGeometrySourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('face'), face: FaceReferenceSchema }),
  z.strictObject({
    kind: z.literal('region'),
    sketch: counted(/^sketch#[1-9][0-9]{0,14}$/, 'sketch#1'),
    entities: z.array(camEntityId).min(1).max(MAX_CAM_REGION_ENTITIES).exactOptional(),
  }),
  z.strictObject({
    kind: z.literal('hole'),
    feature: counted(/^hole#[1-9][0-9]{0,14}$/, 'hole#1'),
  }),
]);

/**
 * How deep a cut goes. `blind`: `depth` (a length) below the top of the operation's geometry.
 * `through`: through the stock's bottom, and `extra` (a length; absent: zero) below it.
 */
export const CamDepthSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('blind'), depth: camExpression }),
  z.strictObject({ kind: z.literal('through'), extra: camExpression.exactOptional() }),
]);

/** How a pass enters the material: straight down, on a ramp, or on a helix (angles, lengths). */
export const CamEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plunge') }),
  z.strictObject({ kind: z.literal('ramp'), angle: camExpression }),
  z.strictObject({ kind: z.literal('helix'), angle: camExpression, radius: camExpression }),
]);

/** A lead-in or lead-out move, tangent to the cut. */
export const CamLeadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('line'), length: camExpression }),
  z.strictObject({ kind: z.literal('arc'), radius: camExpression }),
]);

/**
 * An operation's own feeds and speed, each overriding the tool's preset for the stock's material:
 * `spindle` a spindle speed; `cut`, `plunge`, `ramp`, `lead` feed rates. Sets at least one; no
 * overrides at all is an absent `feeds`.
 */
export const CamFeedsSchema = z
  .strictObject({
    spindle: camExpression.exactOptional(),
    cut: camExpression.exactOptional(),
    plunge: camExpression.exactOptional(),
    ramp: camExpression.exactOptional(),
    lead: camExpression.exactOptional(),
  })
  .check((ctx) => {
    if (Object.values(ctx.value).every((v) => v === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'feeds set at least one value; leave them out for the tool preset',
        input: ctx.value,
        path: [],
      });
    }
  });

/** The 3D surfacing strategies: parallel (raster) finishing and z-level roughing. */
export const CAM_SURFACE3D_STRATEGIES = ['parallel', 'zlevel'] as const;

/**
 * The flat-floor clearing of a V-carve: an end mill (a `flat` or `bull` tool of `cam.tools`, by
 * id; which kind is checked when toolpaths are generated) that clears the floor a `maxDepth`
 * leaves, before the V-bit. `stepdown` a length and `stepover` a fraction of its diameter, absent:
 * from its preset; `entry` absent: a 3 degree helix; `feeds` absent: its preset's.
 */
export const CamVCarveClearingSchema = z.strictObject({
  tool: CamToolIdSchema,
  stepdown: camExpression.exactOptional(),
  stepover: camExpression.exactOptional(),
  entry: CamEntrySchema.exactOptional(),
  feeds: CamFeedsSchema.exactOptional(),
});

const camOperationBase = <K extends CamOperationKind>(kind: K) => ({
  id: counted(new RegExp(`^${kind}#[1-9][0-9]{0,14}$`), `${kind}#1`),
  kind: z.literal(kind),
  name: featureName,
  suppressed: z.boolean(),
  /** A tool of `cam.tools`, by id. */
  tool: CamToolIdSchema,
  geometry: z.array(CamGeometrySourceSchema).max(MAX_CAM_SOURCES),
  /** Absent: every value from the tool's preset for the stock's material. */
  feeds: CamFeedsSchema.exactOptional(),
});

/**
 * One CAM operation (ADR 0014 decision 2), a first cut of each kind's fields (the operation
 * tasks may add fields, each with a format bump). Absent `stepdown`, `stepover` and feeds come
 * from the tool's preset. A `stepover` is a fraction of the tool diameter (a plain number), except
 * a `surface3d`'s, which is the distance between raster lines (a length). Angles are from machine
 * +X. Which geometry sources a kind takes is checked by validation: a drill takes hole features,
 * the others faces and sketch regions (a `facing` with none faces the whole stock top; a
 * `surface3d` machines the setup's body, and its faces and regions, when it has any, bound it in
 * XY).
 */
export const CamOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...camOperationBase('facing'),
    /** How much to remove from the stock top (a length). */
    depth: camExpression,
    stepdown: camExpression.exactOptional(),
    stepover: camExpression.exactOptional(),
    /** Raster direction (an angle). */
    angle: camExpression,
  }),
  z.strictObject({
    ...camOperationBase('profile'),
    side: z.enum(['outside', 'inside', 'on']),
    depth: CamDepthSchema,
    stepdown: camExpression.exactOptional(),
    /** Material left on the wall by the roughing passes (a length); absent: none. */
    finishAllowance: camExpression.exactOptional(),
    /** Absent: no tabs. `count` a plain number, `width` and `height` lengths. */
    tabs: z
      .strictObject({ count: camExpression, width: camExpression, height: camExpression })
      .exactOptional(),
    entry: CamEntrySchema,
    leadIn: CamLeadSchema,
    leadOut: CamLeadSchema,
    /** Climb milling when true, conventional when false. */
    climb: z.boolean(),
  }),
  z.strictObject({
    ...camOperationBase('pocket'),
    depth: CamDepthSchema,
    stepdown: camExpression.exactOptional(),
    stepover: camExpression.exactOptional(),
    finishAllowance: camExpression.exactOptional(),
    entry: CamEntrySchema,
    climb: z.boolean(),
    /**
     * A finishing pass along the walls after the clearing; absent: one when `finishAllowance` is
     * more than zero. False with an allowance leaves the walls oversize for a later operation.
     */
    finishPass: z.boolean().exactOptional(),
    /** Depth step of the finishing pass (a length); absent: the whole depth when it fits the flutes. */
    finishStepdown: camExpression.exactOptional(),
    /** Material the clearing leaves on the floor (a length); absent: none. */
    floorAllowance: camExpression.exactOptional(),
    /** One more pass at the bottom to clear the floor allowance; absent: one when there is one. */
    floorPass: z.boolean().exactOptional(),
  }),
  z.strictObject({
    ...camOperationBase('drill'),
    /** Absent: each hole's own depth. */
    depth: CamDepthSchema.exactOptional(),
    /** Peck depth (a length); absent: one plunge. */
    peck: camExpression.exactOptional(),
    /** Dwell at the bottom, in seconds (a plain number); absent: none. */
    dwell: camExpression.exactOptional(),
  }),
  z.strictObject({
    ...camOperationBase('vcarve'),
    /** The deepest the carve may go (a length); absent: as deep as the V-bit's geometry needs. */
    maxDepth: camExpression.exactOptional(),
    /** Depth step (a length): the carve is cut in levels no deeper than this; absent: one level. */
    stepdown: camExpression.exactOptional(),
    /**
     * Distance between the V-bit's rings on a flat floor (a length); absent: close enough to leave
     * ridges no higher than 0.2 mm.
     */
    flatStepover: camExpression.exactOptional(),
    /** An end mill that clears the flat floor before the V-bit carves (with `maxDepth`). */
    clearing: CamVCarveClearingSchema.exactOptional(),
  }),
  z.strictObject({
    ...camOperationBase('surface3d'),
    /** Distance between raster lines (a length). */
    stepover: camExpression,
    /** Raster direction (an angle). */
    angle: camExpression,
    /** Material left on the surface (a length); absent: none. */
    allowance: camExpression.exactOptional(),
    /** `parallel` (finishing) or `zlevel` (roughing); absent: `parallel`. */
    strategy: z.enum(CAM_SURFACE3D_STRATEGIES).exactOptional(),
    /** How far the posted path may stray from the cutter locations (a length); absent: 0.01 mm. */
    tolerance: camExpression.exactOptional(),
    /** Distance between drop points along a raster line (a length); absent: from the tool. */
    sampling: camExpression.exactOptional(),
    /** `parallel`: `zigzag` or `oneway`; absent: `zigzag`. */
    pattern: z.enum(['zigzag', 'oneway']).exactOptional(),
    /** `zlevel`: the most one slice goes below the one above (a length); absent: half the tool diameter. */
    stepdown: camExpression.exactOptional(),
    /** `zlevel`: how each slice is entered; absent: a 3 degree helix. */
    entry: CamEntrySchema.exactOptional(),
    /** `zlevel`: climb milling when true, conventional when false; absent: climb. */
    climb: z.boolean().exactOptional(),
    /** `zlevel`: the slice grid's cell (a length); absent: 0.2 mm. */
    sliceCell: camExpression.exactOptional(),
  }),
]);

/**
 * A setup (ADR 0014 decision 2): the body it machines, the stock, the WCS, the heights, the
 * machine and post, and the operations in cut order. `part` is a part of this document; `body` one
 * of its bodies, absent meaning its only body. Neither the body nor the machine and post ids are
 * checked here or by validation (ADR 0014 decision 6).
 */
export const CamSetupSchema = z.strictObject({
  id: CamSetupIdSchema,
  name: featureName,
  part: z.string().min(1).max(MAX_PART_ID_LENGTH),
  body: BodyIdSchema.exactOptional(),
  machine: CamTableIdSchema,
  post: CamTableIdSchema,
  stock: CamStockSchema,
  wcs: CamWcsSchema,
  /** Machine Z above the WCS origin: `clearance` for rapids, `retract` between passes (lengths). */
  heights: z.strictObject({ clearance: camExpression, retract: camExpression }),
  /** Cut order. */
  operations: z.array(CamOperationSchema).max(MAX_CAM_OPERATIONS),
});

/** The CAM section (README, "CAM"). Since version 14. */
export const CamDataSchema = z
  .strictObject({
    tools: z.array(CamToolSchema).max(MAX_CAM_TOOLS),
    setups: z.array(CamSetupSchema).max(MAX_CAM_SETUPS),
    /**
     * Next number per id counter (`tool`, `setup`, one per operation kind, `r`). Only ever
     * increases.
     */
    nextIds: z.record(z.string().max(32, { abort: true }), z.int().min(1)),
  })
  .check((ctx) => {
    const { setups, nextIds } = ctx.value;
    for (const key of Object.keys(nextIds)) {
      if (!CAM_COUNTERS.includes(key)) {
        ctx.issues.push({
          code: 'custom',
          message: `"${key}" is not a CAM id counter`,
          input: key,
          path: ['nextIds', key],
        });
      }
    }
    let operations = 0;
    let sources = 0;
    for (const s of setups) {
      operations += s.operations.length;
      for (const op of s.operations) sources += op.geometry.length;
    }
    if (operations > MAX_CAM_OPERATIONS) {
      ctx.issues.push({
        code: 'custom',
        message: `the CAM setups hold ${operations} operations; at most ${MAX_CAM_OPERATIONS} are allowed`,
        input: operations,
        path: ['setups'],
      });
    }
    if (sources > MAX_CAM_TOTAL_SOURCES) {
      ctx.issues.push({
        code: 'custom',
        message: `the CAM operations hold ${sources} geometry sources; at most ${MAX_CAM_TOTAL_SOURCES} are allowed`,
        input: sources,
        path: ['setups'],
      });
    }
  });

export const DomainNamespaceSchema = z
  .string()
  .max(MAX_DOMAIN_NAMESPACE_LENGTH, { abort: true })
  .regex(DOMAIN_NAMESPACE_PATTERN, 'Expected a domain namespace like "wood"');

/**
 * One domain's document-level data (ADR 0013 decision 3): settings, not model. Core checks only
 * this envelope; `data` is validated and migrated by the domain package that owns the namespace,
 * at its own `schemaVersion`. Since version 11.
 */
export const DomainDataSchema = z.strictObject({
  /** The domain's own version of `data`, from 1. */
  schemaVersion: z.int().min(1),
  /**
   * Any JSON, nested at most `MAX_DOMAIN_DATA_DEPTH` levels. The depth is checked first, without
   * recursion, so `z.json()` never sees data deep enough to overflow the stack.
   */
  data: z
    .unknown()
    .check((ctx) => {
      if (nestsDeeperThan(ctx.value, MAX_DOMAIN_DATA_DEPTH)) {
        ctx.issues.push({
          code: 'custom',
          message: `domain data may nest at most ${MAX_DOMAIN_DATA_DEPTH} levels`,
          input: ctx.value,
        });
      }
    })
    .pipe(z.json()),
});

/**
 * Domain data by namespace. Since version 11. Never empty: a document without domain data has
 * no `domains` key, so undo is exact and the saved text canonical.
 */
export const DomainsSchema = z.record(DomainNamespaceSchema, DomainDataSchema).check((ctx) => {
  const count = Object.keys(ctx.value).length;
  if (count === 0) {
    ctx.issues.push({
      code: 'custom',
      message: 'an empty domains record is not allowed; leave the key out instead',
      input: count,
    });
  }
  if (count > MAX_DOMAINS) {
    ctx.issues.push({
      code: 'custom',
      message: `the document holds ${count} domain entries; at most ${MAX_DOMAINS} are allowed`,
      input: count,
    });
  }
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
  /** CAM: tools, setups and their operations (ADR 0014). Since version 14. */
  cam: CamDataSchema,
  /**
   * The script library (ADR 0010 decision 8): scripts scripted features name, in library order;
   * absent when the document has none, never empty. Since version 16.
   */
  scripts: z
    .array(ScriptSchema)
    .min(1)
    .max(MAX_SCRIPTS)
    .check((ctx) => {
      const total = scriptBytes(ctx.value);
      if (total > MAX_SCRIPT_TOTAL_BYTES) {
        ctx.issues.push({
          code: 'custom',
          message: `the document's scripts hold ${total} bytes; at most ${MAX_SCRIPT_TOTAL_BYTES} are allowed`,
          input: total,
        });
      }
    })
    .exactOptional(),

  /**
   * Drawings of the document's parts and assemblies, in tab order; absent when the document has
   * none, never empty. Since version 12.
   */
  drawings: z.array(DrawingSchema).min(1).max(MAX_DRAWING_ITEMS).exactOptional(),
  /** The configuration table; absent when the document has none. Since version 5. */
  configurations: ConfigurationsSchema.exactOptional(),
  /**
   * Document-level domain data by namespace (`wood`, `stock`), opaque to core; absent when the
   * document has none. Since version 11.
   */
  domains: DomainsSchema.exactOptional(),
  /**
   * Next number per document-level id counter (`part`, giving `part#n`; `cp` and `cfg`, giving
   * configuration parameter and row ids; `assembly`, giving `assembly#n`; `font`, giving
   * `font#n`; `drawing`, giving `drawing#n`; `script`, giving `script#n`). Only ever increases,
   * so an id is never reused. Since version 4.
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
  PathCommand,
  PointEntity,
  PointPosition,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchPlacement,
  StoredExpression,
  SvgOutlinePath,
  SvgOutlineSource,
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
export type HolePurpose = z.infer<typeof HolePurposeSchema>;
export type HoleStandard = z.infer<typeof HoleStandardSchema>;
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
export type ScriptLanguage = z.infer<typeof ScriptLanguageSchema>;
export type Script = z.infer<typeof ScriptSchema>;
export type ScriptParamValue = z.infer<typeof ScriptParamValueSchema>;
export type ScriptedFeature = z.infer<typeof ScriptedFeatureSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureKind = Feature['kind'];
export type Variable = z.infer<typeof VariableSchema>;
export type BodyPropsFields = z.infer<typeof BodyPropsFieldsSchema>;
export type BodyProps = z.infer<typeof BodyPropsSchema>;
export type BodyGroup = z.infer<typeof BodyGroupSchema>;
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
export type CamFeedPreset = z.infer<typeof CamFeedPresetSchema>;
export type CamToolKind = (typeof CAM_TOOL_KINDS)[number];
export type CamTool = z.infer<typeof CamToolSchema>;
export type CamStock = z.infer<typeof CamStockSchema>;
export type CamWcs = z.infer<typeof CamWcsSchema>;
export type CamGeometrySource = z.infer<typeof CamGeometrySourceSchema>;
export type CamDepth = z.infer<typeof CamDepthSchema>;
export type CamEntry = z.infer<typeof CamEntrySchema>;
export type CamLead = z.infer<typeof CamLeadSchema>;
export type CamFeeds = z.infer<typeof CamFeedsSchema>;
export type CamVCarveClearing = z.infer<typeof CamVCarveClearingSchema>;
export type CamSurface3dStrategy = (typeof CAM_SURFACE3D_STRATEGIES)[number];
export type CamOperation = z.infer<typeof CamOperationSchema>;
export type CamSetup = z.infer<typeof CamSetupSchema>;
export type CamData = z.infer<typeof CamDataSchema>;
export type FontSource = z.infer<typeof FontSourceSchema>;
export type DocumentFont = z.infer<typeof FontSchema>;
export type ExplodeDirection = z.infer<typeof ExplodeDirectionSchema>;
export type ExplodeStep = z.infer<typeof ExplodeStepSchema>;
export type ExplodedView = z.infer<typeof ExplodedViewSchema>;
export type SheetSize = z.infer<typeof SheetSizeSchema>;
export type TitleBlock = z.infer<typeof TitleBlockSchema>;
export type ViewSource = z.infer<typeof ViewSourceSchema>;
/** A domain view's source (since version 15). */
export type DomainViewSource = Extract<ViewSource, { domain: string }>;
/** Whether a view's source is a domain view (it also has `part`, so test this first). */
export function isDomainViewSource(source: ViewSource): source is DomainViewSource {
  return 'domain' in source;
}
export type ViewDirection = z.infer<typeof ViewDirectionSchema>;
export type ViewScale = z.infer<typeof ViewScaleSchema>;
export type ViewOptions = z.infer<typeof ViewOptionsSchema>;
export type DrawingView = z.infer<typeof ViewSchema>;
export type DimensionRef = z.infer<typeof DimensionRefSchema>;
export type Dimension = z.infer<typeof DimensionSchema>;
export type DimensionKind = Dimension['kind'];
export type Note = z.infer<typeof NoteSchema>;
export type Sheet = z.infer<typeof SheetSchema>;
export type Drawing = z.infer<typeof DrawingSchema>;
export type DomainData = z.infer<typeof DomainDataSchema>;
export type Domains = z.infer<typeof DomainsSchema>;
export type ManufaktureDocument = z.infer<typeof DocumentSchema>;
