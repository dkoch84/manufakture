// What a regen reports: per feature a status, errors, warnings, how its
// references resolved and what it cost; per part its final bodies (each with
// its arena id, and its mesh when it changed). Everything is plain data, so a reply can
// cross the worker boundary (ADR 0007); mesh buffers are transferred.

import type { FeatureKind, Vec3 } from '@manufakture/core';
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
  | { code: 'upstream'; message: string; upstream: string[] };

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
  | { code: 'reference-body'; message: string };

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
  counters: RegenCounters;
  ms: number;
}
