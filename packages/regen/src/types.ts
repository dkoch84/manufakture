// What a regen reports: per feature a status, errors, warnings, how its
// references resolved and what it cost; per part its final bodies (each with
// its arena id, and its mesh when it changed). Everything is plain data, so a reply can
// cross the worker boundary (ADR 0007); mesh buffers are transferred.

import type {
  AssemblyIssue,
  AssemblyWarning,
  MateGroup,
  MateStatus,
  Outcome,
  Residual,
} from '@manufakture/assembly';
import type { BodyPropsFields, DomainData, FeatureKind, Pose, Vec3 } from '@manufakture/core';
import type { MeshData, ShapeId, ThreadReport, Topology, Via } from '@manufakture/kernel';
import type { OutlineShape, RegionDiagnosticCode, SketchPlacement } from '@manufakture/sketch';
import type { UnitsError } from '@manufakture/units';
import type { ExplodedViewResult } from './explode';
import type { MemberMeshUpdate, MemberSetResult } from './members';

/**
 * - `ok`: built (possibly with warnings);
 * - `error`: the feature failed and was skipped; the body passes through it unchanged;
 * - `upstream-error`: a feature it depends on failed, is suppressed or was skipped, so it was
 *   not attempted;
 * - `suppressed`: the user suppressed it;
 * - `rolled-back`: after the rollback bar, not regenerated.
 */
export type FeatureStatus = 'ok' | 'error' | 'upstream-error' | 'suppressed' | 'rolled-back';

/** A path inside a feature, as core's `featureExpressions` gives it: `['extent', 'distance']`. */
export type FieldPath = readonly (string | number)[];

/** The re-pick hint a core reference may carry. */
export interface LastResolved {
  point: Vec3;
  direction: Vec3;
}

/**
 * Why a feature failed. Kernel codes are mapped to ADR 0007's names (kernel README, the table
 * under Part features): `lost` becomes `reference-lost`, `ambiguous` `reference-ambiguous`,
 * `unnamed` `unnamed-face`; the others keep their kernel code. `expression`, `sketch` and
 * `upstream` are regen's own and never come from the kernel.
 */
export type RegenError =
  | {
      code: 'reference-lost';
      message: string;
      /** The core reference id (`r3`), or for sketch geometry the field: `profile`, `axis`, `points`. */
      referenceId: string;
      /** Names (or sketch entity ids) that no longer exist; empty when the faces exist but no longer meet. */
      missing: string[];
      target?: string;
      lastResolved?: LastResolved;
    }
  | {
      code: 'reference-ambiguous';
      message: string;
      referenceId: string;
      /** What it matches now, sorted: the re-pick prompt offers these. */
      candidates: string[];
      target?: string;
      lastResolved?: LastResolved;
    }
  | { code: 'unnamed-face'; message: string }
  | { code: 'kernel'; message: string; occtMessage?: string; occtType?: string }
  | {
      /**
       * `unsupported`: also an extension whose type no registered domain builds, or whose
       * `schemaVersion` (or domain data's) is newer than this build reads (ADR 0013 decision 4).
       * `extension`: a domain's code threw or returned something malformed; the domain has a bug.
       */
      code: 'invalid' | 'invalid-shape' | 'no-body' | 'empty' | 'unsupported' | 'extension';
      message: string;
      referenceId?: string;
      field?: FieldPath;
    }
  | {
      code: 'expression';
      message: string;
      field: FieldPath;
      /** The units error; its range is in the source of the expression at `field`. */
      error: UnitsError;
      /** Set when the problem is in a variable the expression reads, not in the expression itself. */
      variable?: string;
    }
  | {
      code: 'sketch';
      message: string;
      /** Conflicting constraint ids, from the solver's lists (ADR 0007 decision 5). */
      conflicting: string[];
      redundant: string[];
    }
  | { code: 'upstream'; message: string; upstream: string[] }
  | {
      /**
       * A font an outline uses could not be read: damaged or hostile, or reading it timed out or
       * ran out of memory in the text worker (ADR 0011's amendment). The text is not built.
       */
      code: 'font';
      message: string;
      /** The font's id in the document. */
      fontId: string;
      /** The outline's `source.font`. */
      field: FieldPath;
    }
  | {
      /**
       * A derived part's pinned source cannot be built: its data does not match its SHA-256, it
       * is not a readable document, it was saved by a newer version, it has no such part, or it
       * nests derived parts deeper than `MAX_DERIVED_DEPTH`. `field` is the part of `source` at
       * fault (`['source', 'sha256']`, `['source', 'data']`, `['source', 'partId']`, or `['source']`
       * for the depth).
       */
      code: 'source';
      message: string;
      field: FieldPath;
    };

export type RegenErrorCode = RegenError['code'];

/** Something to look at; the feature still built. */
export type RegenWarning =
  | {
      /** A resolution that is not exact, or rests on a positional name (ADR 0004 decision 6). */
      code: 'reference';
      message: string;
      referenceId: string;
      target: string;
      via: Via;
      fragile: boolean;
    }
  | { code: 'missed'; message: string; instances: string[] }
  /** An added solid touched no body, so the kernel made it a body of its own (M2 plan, decision 2). */
  | { code: 'detached'; message: string; bodies: string[] }
  | { code: 'direction'; message: string; referenceId: string; target: string }
  | {
      /** A sketch region diagnostic of warning severity (open profile, touching loops, ...). */
      code: 'sketch';
      message: string;
      diagnostic: RegionDiagnosticCode;
      entityIds: string[];
    }
  | { code: 'redundant'; message: string; constraints: string[] }
  /**
   * No longer emitted: regen builds extensions through their domain's translator, and one it
   * cannot build fails with `unsupported` (ADR 0013 decision 4). Kept so older consumers of the
   * union still compile.
   */
  | { code: 'extension'; message: string }
  /** An import kept aside as a reference body (display and measure only): no geometry change. */
  | { code: 'reference-body'; message: string }
  /**
   * Features of a derived part's source failed (or could not be built) at that version: the
   * derived bodies are what the source built without them. `features` lists them in order.
   */
  | { code: 'derived-source'; message: string; features: string[] }
  /** An instance shows its part as regenerated, and the part's rollback bar is not at its end. */
  | { code: 'rollback'; message: string; partId: string }
  /**
   * A text built with something to look at: characters its font has no glyph for (`missing`,
   * left out), kerning that could not be read, glyph loops that touch at a point. Also SVG
   * artwork's (an outline with an `svg` source): contours left open, loops that touch.
   */
  | { code: 'text'; message: string; entityId: string; missing?: string[] }
  /**
   * A bundled font is not the file the document's text was made with (an app update changed
   * it): the text is built with the font this build ships, and may look different.
   */
  | { code: 'font-changed'; message: string; fontId: string }
  /**
   * A layout warning a domain's member stage reported on this feature while framing `group`
   * (ADR 0015 decision 7): `domainCode` is the domain's own code, `member` a full member id.
   */
  | { code: 'members'; message: string; group: string; domainCode?: string; member?: string };

/** How one reference of a feature resolved (ADR 0004 decision 6: recomputed, never stored). */
export interface ReferenceResolution {
  referenceId: string;
  target: string;
  via: Via;
  fragile: boolean;
}

export interface FeatureResult {
  featureId: string;
  kind: FeatureKind;
  /** Position in the part's feature list. */
  index: number;
  status: FeatureStatus;
  errors: RegenError[];
  warnings: RegenWarning[];
  references: ReferenceResolution[];
  /**
   * Served from the cache: no kernel op and no solve ran for it in this regen. False for
   * features that were not built (suppressed, rolled back, upstream errors, input errors).
   */
  cached: boolean;
  /** Milliseconds spent on it in this regen: translation plus solve or kernel op. */
  ms: number;
  /**
   * The feature's cache key (ADR 0004 decision 8), for sketches and kernel features that got as
   * far as building: equal keys, equal results. The app compares it to tell when a sketch or hole
   * a CAM source names changed although no body did (ADR 0014 decisions 7 and 8).
   */
  key?: string;
  /**
   * Sketches only: where the sketch lies in this regen (a face sketch's plane is resolved on the
   * body before it), so the app can draw and edit it in the frame regen solved it in.
   */
  placement?: SketchPlacement;
  /**
   * Sketches with outline entities only: the loops of every outline (text), construction ones
   * too, placed in the sketch, so the app draws text as regen built it (T3.2d).
   */
  outlines?: OutlineShape[];
  /**
   * Threads only, when built: what the kernel built (the body, the axis from the start, the
   * cylinder's radius after it, length, pitch, hand, representation), so the app can draw a
   * cosmetic thread's helix and the tree can show the size.
   */
  thread?: ThreadReport;
  /**
   * Extensions only, when built: the metadata their translator returned next to its kernel
   * inputs (a board's frame, ADR 0013 decision 7), for the domain's derived models. Recomputed
   * on every regen, never stored.
   */
  metadata?: DomainData['data'];
}

/** One body of a part after the last feature (M2 plan, decision 1: named after its creator). */
export interface BodyResult {
  /** The body id: the id of the feature that made it (`extrude#3`), or of its copy (`pattern#2:i3`). */
  bodyId: string;
  /** The feature that made it. */
  creator: string;
  /**
   * The body in the kernel arena, for pick, resolve and measure ops. Valid until a later regen
   * evicts it or the kernel recycles.
   */
  shape: ShapeId;
  /** Cache key of the body; equal keys mean identical bodies. */
  bodyKey: string;
  /** How many solids it holds: a cut can leave a body in several disjoint pieces. */
  solids: number;
  /** The body differs from the one the last completed regen reported under this id. */
  meshChanged: boolean;
  /** The body's mesh when `meshChanged` (name slots index `RegenResult.names`); null otherwise. */
  mesh: MeshData | null;
  /**
   * The body's topology (faces with their planes, edges with their faces, vertices), sent with
   * the mesh: face and edge `index` is the mesh's 1-based face and edge numbering.
   */
  topology: Topology | null;
  /**
   * Bodies a derived feature made (`derived#1:from/<source body id>`): the name, colour and
   * material the body has in its source (its own, else the source part's material), for each of
   * them this part does not set for the body itself. Absent when nothing carries over. The body's
   * own settings (`Part.bodies`) win, then these, then this part's material.
   */
  inherited?: BodyPropsFields;
}

/** A body that ended in a merge: an `add` fused it into another body. */
export interface ConsumedBody {
  bodyId: string;
  /** The feature that merged it away. */
  featureId: string;
}

export interface PartResult {
  partId: string;
  features: FeatureResult[];
  /** Features the edit could have changed, in order (the dirty subgraph); everything on a first regen. */
  dirty: string[];
  /**
   * The part's bodies after its last feature, in creator order (a merged body in the place of
   * the first body merged into it). Empty when the part has no body, or when the kernel failed
   * as a whole during the part.
   */
  bodies: BodyResult[];
  /** Bodies that ended in a merge during the part, in feature order. */
  consumed: ConsumedBody[];
  /**
   * The part's framing member sets (ADR 0015 decision 5), one per group a domain's member stage
   * framed, in domain then group order. Absent when there are none: a group missing from a
   * completed regen is gone.
   */
  members?: MemberSetResult[];
}

export interface RegenCounters {
  /** `feature` ops sent to the kernel. */
  featureOps: number;
  /** Other kernel ops (`resolve` for face sketches, `tessellate`). */
  otherOps: number;
  batches: number;
  solves: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface RegenResult {
  generation: number;
  /** Name table for every mesh in this result (ADR 0007 decision 7). */
  names: string[];
  parts: PartResult[];
  /** Per assembly, in document order: instance transforms and mate diagnostics (empty without). */
  assemblies: AssemblyResult[];
  /**
   * Parts that instances show other than as the document's own parts are built: pinned parts of
   * other documents, and parts of this document in another configuration row. With their bodies
   * (and meshes, as for parts); empty when no instance shows one.
   */
  sources: SourceResult[];
  /**
   * Member shape meshes new to the main thread and those no member uses any more (worker-wide,
   * every part's sets together). Absent when neither changed.
   */
  memberMeshes?: MemberMeshUpdate;
  counters: RegenCounters;
  ms: number;
}

// Assemblies -------------------------------------------------------------------------------

/** Where an instance's bodies are in a result: a part of this document, or a pinned source. */
export type InstanceSourceRef = { part: string } | { source: string };

export interface InstanceResult {
  instanceId: string;
  /** `error`: its source could not be built, or bodies it lists are gone; see `errors`. */
  status: 'ok' | 'error' | 'suppressed';
  /** The `PartResult` (by part id) or `SourceResult` (by key) whose bodies it shows. */
  source: InstanceSourceRef;
  /** The body ids it shows, in the source's creator order; their meshes are the source's. */
  bodies: string[];
  /** The solved pose (instance coordinates to world); the stored pose when suppressed. */
  transform: Pose;
  /** The solved pose differs from the pose stored in the document. */
  moved: boolean;
  errors: RegenError[];
  warnings: RegenWarning[];
}

/** One connector of a mate, as regen found it. */
export interface ConnectorResult {
  connectorId: string;
  instanceId: string;
  /** In the instance's coordinates, with flip, rotate and offset applied; null when not found. */
  frame: Pose | null;
  /** How its origin resolved; null when it did not. */
  reference: ReferenceResolution | null;
}

export interface MateResult {
  mateId: string;
  /**
   * The solver's status, or `error` when regen could not give it to the solver (a connector
   * that does not resolve, an expression that does not evaluate, an instance that failed): the
   * mate is left out, so its instances are free of it, and `errors` says why.
   */
  status: MateStatus | 'error';
  /** Free coordinates: revolute [angle], slider [distance], ...; empty when not solved. */
  coordinates: number[];
  /** Between the two connectors after the solve; null when not solved. */
  residual: Residual | null;
  connectors: [ConnectorResult, ConnectorResult];
  errors: RegenError[];
  warnings: RegenWarning[];
  /** The solver's message for anything but `ok`. */
  message?: string;
}

export interface AssemblyResult {
  assemblyId: string;
  /** The solver's outcome over the mates that reached it. */
  outcome: Outcome;
  /** Remaining degrees of freedom; null while mates conflict. */
  dof: number | null;
  /** In the assembly's order. */
  instances: InstanceResult[];
  /** In creation order. */
  mates: MateResult[];
  redundant: MateGroup[];
  conflicting: MateGroup[];
  issues: AssemblyIssue[];
  warnings: AssemblyWarning[];
  message?: string;
  /**
   * The assembly's exploded views resolved at the solved poses (T4.5a), in the assembly's order:
   * what `explodedOffsets` turns into display offsets. Absent when the assembly has none.
   */
  explodedViews?: ExplodedViewResult[];
  /** Milliseconds for connectors and the solve. */
  ms: number;
}

/**
 * A part that instances show, built apart from the document's own parts: a pinned part of another
 * document (keyed `source:<sha256>:<part id>`, plus `:row:<row id>` when the instance names a row),
 * or a part of this document in a configuration row other than the active one
 * (`part:<part id>:row:<row id>`).
 */
export interface SourceResult {
  /** `InstanceResult.source.source`. */
  key: string;
  /** The pinned document and version; empty strings for a part of this document. */
  documentId: string;
  documentName: string;
  versionId: string;
  versionName: string;
  partId: string;
  /** The part's name in its document. */
  partName: string;
  /** The configuration row it is built in; absent: the document as it is. */
  row?: { id: string; name: string };
  /** Every body of the part at that version, as for a part of this document. */
  bodies: BodyResult[];
}

/** One step of a drag (`dragInstance`). */
export interface DragResult {
  generation: number;
  assemblyId: string;
  instanceId: string;
  outcome: Outcome;
  /** Every solved instance's pose after the step (suppressed instances are not solved). */
  transforms: Record<string, Pose>;
  /** Instances whose pose now differs from the document's: what `setPoses` commits on release. */
  moved: string[];
  /** How far the dragged instance ended from the target. */
  target: Residual & { reached: boolean };
  dof: number | null;
  warnings: AssemblyWarning[];
  message?: string;
}

// Interference -------------------------------------------------------------------------------

/** Two instances whose bodies overlap (`interference`). */
export interface InstanceInterference {
  /** Instance ids, in the assembly's order (`a` before `b`). */
  a: string;
  b: string;
  /** The overlap's volume in mm3 (over every pair of bodies of the two). */
  volume: number;
  /**
   * The overlap's tessellation in world coordinates, as the instances were placed for the check,
   * when asked for; null otherwise, and in the final report when the pairs were streamed (the
   * streamed pair carried it).
   */
  mesh: MeshData | null;
}

/** One interference check of an assembly, on demand (never part of a regen). */
export interface InterferenceReport {
  generation: number;
  assemblyId: string;
  /** Instances checked: every instance placed with bodies, unsuppressed, in the assembly's order. */
  instances: string[];
  /** Overlapping pairs found, in the order they were checked (the assembly's order). */
  pairs: InstanceInterference[];
  /** Pairs whose bounding boxes overlap: the only ones that cost a boolean. */
  candidates: number;
  /** `common` booleans run, one per candidate pair of bodies. */
  booleans: number;
  /** Pairs the kernel could not check (the boolean failed): neither reported nor ruled out. */
  failures: { a: string; b: string; message: string }[];
  /**
   * `cancelled`: stopped by `cancelInterference` before every candidate was checked (`pairs` are
   * the ones found so far). `stale`: the bodies were lost to a kernel recycle; check again after
   * the next regen.
   */
  status: 'done' | 'cancelled' | 'stale';
  ms: number;
}

// Member B-reps ------------------------------------------------------------------------------

/** One member's B-rep as `memberBodies` built it. */
export interface MemberBodyResult {
  /** The full member id. */
  id: string;
  ok: boolean;
  /** Its volume in mm3, when asked for and built. */
  volume?: number;
  /** Why it could not be built. */
  error?: string;
}

/** Member B-reps built on request (STEP export, drawings), used and released at once. */
export interface MemberBodiesResult {
  generation: number;
  partId: string;
  /** In request order, the ids that were found. */
  bodies: MemberBodyResult[];
  /** Ids the last completed regen has no member for. */
  missing: string[];
  /** One AP214 STEP file of every member built, each named by its full id, when asked for. */
  step: Uint8Array | null;
  /** Kernel batches: one per owner, plus the export. */
  batches: number;
  ms: number;
}
