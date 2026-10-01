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
import type { BodyPropsFields, FeatureKind, Pose, Vec3 } from '@manufakture/core';
import type { MeshData, ShapeId, Topology, Via } from '@manufakture/kernel';
import type { RegionDiagnosticCode, SketchPlacement } from '@manufakture/sketch';
import type { UnitsError } from '@manufakture/units';

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
      code: 'invalid' | 'invalid-shape' | 'no-body' | 'empty' | 'unsupported';
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
  /** An instance names a configuration row, which regen does not apply yet (T2.4c). */
  | { code: 'configuration'; message: string; row: string };

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
   * Sketches only: where the sketch lies in this regen (a face sketch's plane is resolved on the
   * body before it), so the app can draw and edit it in the frame regen solved it in.
   */
  placement?: SketchPlacement;
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
   * Pinned parts of other documents that instances show, with their bodies (and meshes, as for
   * parts); empty when no instance shows one.
   */
  sources: SourceResult[];
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
  /** Milliseconds for connectors and the solve. */
  ms: number;
}

/** A pinned part of another document that instances show. */
export interface SourceResult {
  /** `InstanceResult.source.source`. */
  key: string;
  documentId: string;
  documentName: string;
  versionId: string;
  versionName: string;
  partId: string;
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
