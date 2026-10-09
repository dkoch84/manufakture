// Input and output schemas of the tools, in zod (the MCP SDK sends them as JSON Schema and checks
// every call's arguments against them before a tool runs). Inputs are strict: unknown fields are
// refused, strings and lists are bounded, numbers finite. Commands are checked by core inside
// the session (their full schemas are `get_schema`'s); here a command is an object whose `type`
// is one of core's command types.
//
// These schemas are a public contract (ADR 0016 decision 7): tools.golden.json holds them, and a
// change that does more than add fails its test.

import { PoseSchema, STANDARD_VIEW_NAMES, type StandardViewName } from '@manufakture/core';
import { MAX_IMAGE_SIDE, MAX_IMAGES_PER_CALL } from '@manufakture/render';
import { MAX_VIEW_POSES } from '@manufakture/review';
import {
  DEFAULT_LIMITS,
  MAX_GEOMETRY_RESULTS,
  MAX_LABEL,
  MAX_MEASURE_ITEMS,
  MAX_NOTE,
  schemaIndex,
} from '@manufakture/session';
import { z } from 'zod';

// -----------------------------------------------------------------------------------------------
// Pieces

/** A document, branch or session id: as the library stores them (`isStorableId`). */
export const StorableId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
  .describe('An id as the library stores it: letters, digits, _ and -, at most 128.');

/** A core id or name from the model (`part#1`, `extrude#2`, `extrude#1:side:e3`). */
export const ModelId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/)
  .describe('An id or name from the model, as get_tree and find_geometry give them.');

const Finite = z.number().min(-1e9).max(1e9);
export const Vec3 = z.tuple([Finite, Finite, Finite]);
const Placement = PoseSchema.describe(
  'A rigid placement: translation in mm and rotation as a unit quaternion [x, y, z, w].',
);

const ViewName = z.enum(
  STANDARD_VIEW_NAMES as unknown as [StandardViewName, ...StandardViewName[]],
);
const Pattern = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\x21-\x7e]+$/);
const Patterns = z.array(Pattern).max(256);

const Framing = {
  fit: Patterns.optional().describe('Frame these names instead of everything drawn.'),
  extent: z
    .number()
    .positive()
    .max(1e9)
    .optional()
    .describe('Millimetres across the shorter side of the image, instead of a fit.'),
};

export const Camera = z.union([
  ViewName,
  z.strictObject({ view: ViewName, ...Framing }),
  z.strictObject({ direction: Vec3, up: Vec3.optional(), ...Framing }),
  z.strictObject({ position: Vec3, target: Vec3, up: Vec3.optional(), ...Framing }),
]);

const Section = z.strictObject({ origin: Vec3, normal: Vec3 });

/** An assembly to draw instead of the part studio, and at what. */
const atMost = <T extends z.ZodType>(record: T) =>
  record.refine((o) => Object.keys(o as object).length <= MAX_VIEW_POSES, {
    message: `At most ${MAX_VIEW_POSES} entries.`,
  });
const AssemblyAt = z
  .strictObject({
    assemblyId: ModelId,
    mates: atMost(z.record(ModelId, Finite))
      .optional()
      .describe(
        `Slider distances (mm) and revolute angles (degrees) to hold, by mate id (at most ${MAX_VIEW_POSES}): one solve from the solved poses, every other mate kept. A value past a mate's limits is drawn, with a warning. Refused while the assembly's solve conflicts or is invalid.`,
      ),
    poses: atMost(z.record(ModelId, Placement))
      .optional()
      .describe(
        `Instances placed by hand after that solve (the rest as solved), at most ${MAX_VIEW_POSES}, each checked against its mates: warnings for a pose past a limit or off a mate.`,
      ),
  })
  .describe(
    "Draw this assembly instead of the part studio: each instance's bodies at the solved poses, or at these. Names also match qualified with an instance (inst#2/extrude#1, inst#2/*).",
  );

/** One view to render (`@manufakture/render`'s options, bounded). */
export const View = z.strictObject({
  camera: Camera.optional().describe('Default isometric. Every camera is orthographic.'),
  width: z.int().min(64).max(MAX_IMAGE_SIDE).optional().describe('Pixels, default 1024.'),
  height: z.int().min(64).max(MAX_IMAGE_SIDE).optional().describe('Pixels, default 768.'),
  highlight: Patterns.optional().describe(
    'Bodies, members, faces or edges drawn highlighted; a trailing * matches any suffix.',
  ),
  hide: Patterns.optional().describe('Bodies and members not drawn.'),
  only: z.enum(['bodies', 'members']).optional(),
  section: Section.optional().describe(
    'Cuts away the side the normal points to and fills the cut.',
  ),
  supersample: z.int().min(1).max(3).optional(),
  edges: z.boolean().optional(),
  outlines: z.boolean().optional(),
  assembly: AssemblyAt.optional(),
});

/** A view asked for in the review bundle, besides its fixed four. */
export const ReviewViewInput = z.strictObject({
  name: z.string().min(1).max(64).describe('Shown with the images.'),
  camera: Camera.optional(),
  highlight: Patterns.optional(),
  hide: Patterns.optional(),
  only: z.enum(['bodies', 'members']).optional(),
  section: Section.optional(),
  assembly: AssemblyAt.optional().describe(
    'As in render: the assembly drawn at a pose on both sides. Here its ids are at most 120 characters.',
  ),
});

const COMMAND_TYPES = schemaIndex().commands as [string, ...string[]];
const FEATURE_KINDS = schemaIndex().features as [string, ...string[]];

/** A command: its type from core; the rest is checked by core (get_schema has each schema). */
export const CommandInput = z.looseObject({ type: z.enum(COMMAND_TYPES) });

export const ObjectQuery = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('document') }),
  z.strictObject({ kind: z.literal('part'), partId: ModelId }),
  z.strictObject({ kind: z.literal('feature'), partId: ModelId, featureId: ModelId }),
  z.strictObject({ kind: z.literal('variable'), name: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('assembly'), assemblyId: ModelId }),
  z.strictObject({ kind: z.literal('instance'), assemblyId: ModelId, instanceId: ModelId }),
  z.strictObject({ kind: z.literal('mate'), assemblyId: ModelId, mateId: ModelId }),
  z.strictObject({ kind: z.literal('camSetup'), setupId: ModelId }),
  z.strictObject({ kind: z.literal('drawing'), drawingId: ModelId }),
  z.strictObject({ kind: z.literal('configurations') }),
  z.strictObject({ kind: z.literal('domain'), namespace: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal('script'), scriptId: ModelId }),
  z
    .strictObject({
      kind: z.literal('members'),
      partId: ModelId,
      owner: ModelId.describe('A construction wall, opening, floor or roof.'),
    })
    .describe(
      'The framing members the feature owns in the last regen, and the status of each override its params hold: answered as members, not object.',
    ),
]);

export const GeometryQuery = z.strictObject({
  kind: z.enum(['face', 'edge']).optional().describe('Faces, edges, or both by default.'),
  partId: ModelId.optional(),
  bodyId: ModelId.optional(),
  name: ModelId.optional().describe('A face or edge name exactly.'),
  bornBy: ModelId.optional().describe('Made by this feature (the name starts with its id).'),
  normal: Vec3.optional().describe('Planar faces with this outward normal.'),
  radius: z.number().min(0).max(1e9).optional().describe('Cylinders (circles) of this radius, mm.'),
  coaxialWith: ModelId.optional().describe(
    "Cylindrical faces whose axis line coincides with this cylindrical face's (itself included), on any body of its part: within tolerance mm and angleTolerance degrees.",
  ),
  nearest: Vec3.optional().describe('Sorted by distance from this point, mm.'),
  tolerance: z.number().min(0).max(1e6).optional().describe('mm, default 0.01.'),
  angleTolerance: z.number().min(0).max(180).optional().describe('Degrees, default 0.5.'),
  limit: z.int().min(1).max(MAX_GEOMETRY_RESULTS).optional().describe('Default 50.'),
});

const BodyRef = { partId: ModelId, bodyId: ModelId };
const Target = z.union([
  z.strictObject({ kind: z.enum(['face', 'edge', 'vertex']), name: ModelId }),
  z.strictObject({ kind: z.enum(['face', 'edge', 'vertex']), index: z.int().min(1).max(1e7) }),
]);

export const MeasureQuery = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('body'), ...BodyRef }),
  z.strictObject({
    kind: z.literal('targets'),
    ...BodyRef,
    targets: z.array(Target).min(1).max(MAX_MEASURE_ITEMS),
  }),
  z.strictObject({
    kind: z.literal('clearance'),
    bodies: z
      .array(z.strictObject({ ...BodyRef, placement: Placement.optional() }))
      .min(2)
      .max(MAX_MEASURE_ITEMS),
  }),
  z.strictObject({
    kind: z.literal('interference'),
    assemblyId: ModelId,
    poses: z
      .record(ModelId, Placement)
      .optional()
      .describe(
        'Instances placed by hand (the rest at their solved poses), each checked against the mates: warnings for a pose past a limit or off a mate.',
      ),
    travel: z
      .strictObject({
        mateId: ModelId.describe('A slider or revolute mate.'),
        from: z.number().min(-1e9).max(1e9).optional().describe("Default the mate's minimum."),
        to: z.number().min(-1e9).max(1e9).optional().describe("Default the mate's maximum."),
        step: z
          .number()
          .positive()
          .max(1e9)
          .optional()
          .describe('Default a twentieth of the range.'),
      })
      .optional()
      .describe(
        "Sweep a slider's distance (mm) or a revolute's angle (degrees) from `from` to `to`, the other mates kept, checking each step for pairs with an instance that moves: the first colliding value and its pairs, every colliding value, the values checked (at most 101, within one kernel call's time budget), pairs of instances that never move checked once as staticPairs, and warnings for values past the limits. Not with poses; refused while the assembly's solve conflicts or is invalid.",
      ),
  }),
]);

export const EXPORT_FORMATS = [
  'step',
  'stl',
  'stl-each',
  '3mf',
  'cut-list-csv',
  'bom-csv',
  'cut-list-pdf',
  'takeoff-csv',
  'takeoff-pdf',
  'drawing-pdf',
  'drawing-dxf',
  'drawing-svg',
  'gcode',
  'laser-dxf',
  'laser-svg',
  'mfk',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const LaserSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('face'),
    face: ModelId.describe('A planar face name (find_geometry).'),
    label: z.string().min(1).max(200),
    layer: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9 _-]+$/),
  }),
  z.strictObject({
    kind: z.literal('region'),
    sketch: ModelId.describe("A sketch feature's id: its closed regions."),
    label: z.string().min(1).max(200),
    layer: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9 _-]+$/),
  }),
]);

/** A file name the agent may give: no directory part, no leading dot. */
export const FileBase = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}$/)
  .describe(
    'The file name without its extension: no directories; letters, digits, space . _ ( ) + -',
  );

// -----------------------------------------------------------------------------------------------
// Inputs, one per tool

const session = { sessionId: StorableId.describe('From open_session.') };

export const Inputs = {
  list_documents: z.strictObject({}),
  open_session: z.strictObject({
    documentId: StorableId.describe('From list_documents.'),
    branch: StorableId.optional().describe(
      'Resume this agent branch (review state open or changes-requested) instead of making a new one. Never main.',
    ),
    clientName: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "What the client calls itself, shown with the branch. Default: the client's own name.",
      ),
  }),
  close_session: z.strictObject(session),
  get_tree: z.strictObject(session),
  get_object: z.strictObject({ ...session, query: ObjectQuery }),
  get_schema: z.strictObject({
    command: z.enum(COMMAND_TYPES).optional().describe('A command type.'),
    feature: z.enum(FEATURE_KINDS).optional().describe('A feature kind.'),
  }),
  find_geometry: z.strictObject({ ...session, query: GeometryQuery }),
  measure: z.strictObject({ ...session, query: MeasureQuery }),
  render: z.strictObject({
    ...session,
    views: z
      .array(View)
      .min(1)
      .max(MAX_IMAGES_PER_CALL)
      .optional()
      .describe('Default: one isometric view.'),
    compare: z
      .boolean()
      .optional()
      .describe("Also draw the branch's base version at the same camera (two images per view)."),
  }),
  get_quantities: z.strictObject(session),
  get_errors: z.strictObject(session),
  get_history: z.strictObject(session),
  apply: z.strictObject({
    ...session,
    label: z
      .string()
      .min(1)
      .max(MAX_LABEL)
      .describe('One line for the history: what this batch does.'),
    commands: z
      .array(CommandInput)
      .min(1)
      .max(DEFAULT_LIMITS.commandsPerBatch)
      .describe('Core commands, applied as one batch. Ids may be symbolic: extrude#$boss.'),
    dryRun: z.boolean().optional().describe('Apply and regenerate, then put everything back.'),
  }),
  undo: z.strictObject(session),
  update_from_main: z.strictObject(session),
  submit_for_review: z.strictObject({
    ...session,
    note: z.string().max(MAX_NOTE).optional().describe('A note to the reviewer.'),
    views: z
      .array(ReviewViewInput)
      .max(4)
      .optional()
      .describe('Views besides the fixed isometric, front, top and right.'),
  }),
  get_review: z.strictObject({
    sessionId: StorableId.optional().describe("This session's branch."),
    documentId: StorableId.optional().describe(
      'With branch: an agent branch with no open session.',
    ),
    branch: StorableId.optional(),
  }),
  export: z.strictObject({
    ...session,
    format: z.enum(EXPORT_FORMATS),
    fileName: FileBase.optional().describe(
      'The file name without extension; files of a multi-file export get -1, -2, ... Default: from the document.',
    ),
    overwrite: z.boolean().optional().describe('Replace files of the same name. Default false.'),
    partId: ModelId.optional().describe(
      'step, stl, stl-each, 3mf: only this part (with its framing members). takeoff-*: the part studio. laser-*: required.',
    ),
    bodyId: ModelId.optional().describe('laser-*: the body, when the part has several.'),
    assemblyId: ModelId.optional().describe('cut-list-*, bom-csv: count through this assembly.'),
    drawingId: ModelId.optional().describe('drawing-*: required.'),
    sheetId: ModelId.optional().describe(
      'drawing-dxf, drawing-svg: the sheet (default the first).',
    ),
    setupId: ModelId.optional().describe('gcode: the CAM setup, required.'),
    sources: z
      .array(LaserSource)
      .min(1)
      .max(64)
      .optional()
      .describe('laser-*: what to cut, required.'),
    kerf: z.number().min(0).max(10).optional().describe('laser-*: kerf in mm, default 0.'),
  }),
} as const;

export type ToolName = keyof typeof Inputs;

// -----------------------------------------------------------------------------------------------
// Outputs: `{ ok, error?, truncated?, ...fields }`; every data field is optional, since a refusal
// carries only `error`. Deep data from the model is open (its shape follows core's).

const Any = z.unknown();

const ErrorOut = z
  .looseObject({
    kind: z.string(),
    code: z.string().optional(),
    message: z.string().optional(),
    limit: z.number().optional(),
    details: z.array(z.string()).optional(),
  })
  .describe(
    "Why the call was refused: kind 'session' (a session's typed error), 'core' (core refused a command: see error) or 'server' (this server's own).",
  );

const TruncatedOut = z.strictObject({
  limit: z.number().describe('The JSON limit, bytes.'),
  cuts: z.array(
    z.strictObject({
      path: z.string().describe('JSON Pointer of the list or text that was cut.'),
      kept: z.number(),
      total: z.number(),
    }),
  ),
});

const ConnectorFrameOut = z
  .looseObject({
    connectorId: z.string(),
    instanceId: z.string(),
    origin: z.array(z.number()),
    x: z.array(z.number()),
    y: z.array(z.number()),
    z: z.array(z.number()),
  })
  .describe(
    "A connector's frame in world coordinates at the solved poses (mm, unit axes), after flip, rotate and offset; null when it did not resolve.",
  );

const SpanOut = z.looseObject({ from: z.number(), to: z.number() });

const MembersOut = z
  .looseObject({
    owner: z.string(),
    kind: z.enum(['wall', 'opening', 'floor', 'roof']),
    wall: z.string().optional().describe("An opening's host wall."),
    segment: z.number().optional().describe("An opening's segment of its host wall, 1-based."),
    group: z.string().describe('The framing group: the wall, for its openings too.'),
    framed: z
      .boolean()
      .describe('False when the last regen has no members for the group (it failed).'),
    count: z.number().describe('Members the feature owns.'),
    omitted: z.number().describe('Members not listed past the limit.'),
    members: z.array(
      z.looseObject({
        id: z.string().describe('Full id, <owner>:<local>: what render and takeoff sources use.'),
        local: z.string().describe('Local id: what an override names (s4, king-l, top1:2).'),
        role: z.string(),
        stock: z.looseObject({ id: z.string(), name: z.string() }),
        length: z.number().describe('Blank length, mm.'),
        centre: z.array(z.number()).describe('Centre of the blank, world mm.'),
        along: SpanOut.extend({ segment: z.number(), centre: z.number() })
          .nullable()
          .describe(
            "Wall and opening members: extent and centre along the wall segment, mm from the segment's first point (as an opening's position); null for floors and roofs.",
          ),
        above: SpanOut.nullable().describe(
          "Wall and opening members: extent above the wall's base, mm (as an opening's sill).",
        ),
      }),
    ),
    overrides: z.array(
      z.looseObject({
        n: z.number().describe('1-based; the expression move_<n> nudges it.'),
        id: z.string().describe('The local member id it names.'),
        member: z.string().describe('The full member id it names.'),
        status: z
          .string()
          .describe(
            "'applied' (it found the member it names), 'moved' (it records at, and after a layout change it applied to the member now there, appliedTo) or 'lost' (it found none). More values may be added later: read any other as not applied as written.",
          ),
        appliedTo: z
          .string()
          .optional()
          .describe("Status 'moved' only: the full id of the member it applied to."),
        at: z
          .number()
          .optional()
          .describe(
            "Where its member was when it was made: the member's along.centre, mm, less any nudge. A wall's layout stud or block override with at is matched by position, not id.",
          ),
        delete: z.boolean().optional(),
        stock: z.string().optional().describe('The stock id it changes the member to.'),
        move: z.number().optional().describe('How far it moves the member, mm.'),
      }),
    ),
  })
  .describe(
    "Query kind members only: the feature's framing members, sorted along the wall, and its overrides in params order.",
  );

function envelope(fields: Record<string, z.ZodType>) {
  const optional: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(fields)) optional[k] = v.optional();
  return z.looseObject({
    ok: z.boolean(),
    error: ErrorOut.optional(),
    truncated: TruncatedOut.optional(),
    ...optional,
  });
}

const Review = z.enum(['open', 'submitted', 'changes-requested', 'approved', 'rejected']);

const BranchOut = z.looseObject({
  id: z.string(),
  name: z.string(),
  fromVersion: z.string().nullable(),
  createdAt: z.string(),
  agent: z
    .looseObject({
      sessionId: z.string(),
      clientName: z.string(),
      review: Review,
      comment: z.boolean(),
    })
    .nullable(),
});

const SessionOut = {
  sessionId: z.string(),
  documentId: z.string(),
  branch: z.string(),
  branchName: z.string(),
  baseVersion: z.string(),
  revision: z.number(),
  review: Review,
};

const BatchReportOut = {
  label: z.string(),
  dryRun: z.boolean(),
  revision: z.number(),
  symbols: z.record(z.string(), z.string()),
  created: Any,
  statusChanges: z.array(Any),
  errors: z.array(Any),
  measured: z.array(Any),
  regenMs: z.number(),
  review: Review,
};

export const Outputs: Record<ToolName, z.ZodType> = {
  list_documents: envelope({
    documents: z.array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        revision: z.number(),
        savedAt: z.string(),
        damaged: z.boolean(),
        branches: z.array(BranchOut),
      }),
    ),
    omitted: z.number().describe('Documents not listed past the limit.'),
  }),
  open_session: envelope({ ...SessionOut, resumed: z.boolean(), outline: Any }),
  close_session: envelope({ closed: z.boolean(), branch: z.string() }),
  get_tree: envelope({ tree: Any }),
  get_object: envelope({
    object: Any,
    members: MembersOut,
    frames: z
      .looseObject({
        a: ConnectorFrameOut.nullable(),
        b: ConnectorFrameOut.nullable(),
        motion: z.array(
          z.looseObject({
            coordinate: z.string().describe("The coordinate's name, as get_tree gives it."),
            axis: z.enum(['x', 'y', 'z']).describe("The axis of connector a's frame."),
            angular: z.boolean().describe('Turns about the axis (true) or runs along it.'),
          }),
        ),
      })
      .nullable()
      .describe(
        'Mates only: where the last regen resolved the connectors; null before a regen has the mate.',
      ),
  }),
  get_schema: envelope({
    schema: Any,
    index: z.looseObject({ commands: z.array(z.string()), features: z.array(z.string()) }),
  }),
  find_geometry: envelope({ hits: z.array(Any) }),
  measure: envelope({ measurement: Any }),
  render: envelope({
    images: z.array(
      z.looseObject({
        view: z.number().describe('Index into views.'),
        side: z.enum(['head', 'base']),
        content: z.number().describe('Index of the image in the content list.'),
        width: z.number(),
        height: z.number(),
        mmPerPixel: z.number(),
        unmatched: z.array(z.string()),
        bytes: z.number(),
        assembly: z
          .looseObject({
            assemblyId: z.string(),
            mates: z.array(
              z.looseObject({
                mateId: z.string(),
                kind: z.string(),
                coordinates: z.array(
                  z.looseObject({
                    name: z.string(),
                    value: z.number(),
                    unit: z.enum(['mm', 'deg']),
                  }),
                ),
              }),
            ),
            warnings: z.array(
              z.looseObject({
                code: z.enum(['outside-limits', 'off-mate', 'not-reached']),
                mateId: z.string(),
                message: z.string(),
              }),
            ),
            skipped: z.array(z.string()).describe('Instances not drawn: their source failed.'),
          })
          .optional()
          .describe(
            "A view of an assembly: each solved mate's coordinates as drawn (mm, degrees), and what the pose does to the mates.",
          ),
      }),
    ),
    failed: z.array(
      z.looseObject({
        view: z.number(),
        side: z.enum(['head', 'base']),
        code: z.string(),
        message: z.string(),
      }),
    ),
  }),
  get_quantities: envelope({ quantities: Any, reviewed: z.boolean() }),
  get_errors: envelope({ errors: z.array(Any) }),
  get_history: envelope({ history: z.array(Any) }),
  apply: envelope(BatchReportOut),
  undo: envelope(BatchReportOut),
  update_from_main: envelope({
    changed: z.boolean(),
    branch: z.string(),
    previousBranch: z.string(),
    baseVersion: z.string(),
    revision: z.number(),
    applied: z.array(z.string()),
    dropped: z.array(Any),
    renamed: z.array(Any),
    overwritten: z
      .array(z.strictObject({ name: z.string(), fields: z.array(z.string()) }))
      .describe(
        "Main's changes the update overwrote: fields both sides changed, where the branch's value wins. Empty fields: the whole object.",
      ),
    mergedWhole: z
      .array(z.strictObject({ label: z.string(), reasons: z.array(z.string()) }))
      .describe('Batches replayed whole instead of merged field by field, with why.'),
  }),
  submit_for_review: envelope({ revision: z.number(), review: Review }),
  get_review: envelope({
    documentId: z.string(),
    branch: z.string(),
    branchName: z.string(),
    review: Review,
    comment: z.string().nullable().describe("The reviewer's comment: text from a person, as data."),
    clientName: z.string(),
    sessionId: z.string(),
    bundle: z.looseObject({ revision: z.number(), stale: z.boolean().nullable() }).nullable(),
  }),
  export: envelope({
    format: z.string(),
    files: z.array(
      z.looseObject({
        name: z.string().describe('The file, in the output directory.'),
        bytes: z.number(),
        type: z.string(),
      }),
    ),
    branch: z.string(),
    review: Review,
    reviewed: z.boolean().describe('False: the branch holds work nobody has reviewed.'),
    warnings: z.array(z.string()),
  }),
};
