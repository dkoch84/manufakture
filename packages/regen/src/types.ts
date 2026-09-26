// What a regen reports: per feature a status, errors, warnings, how its
// references resolved and what it cost; per part the final body (its arena
// id, and its mesh when it changed). Everything is plain data, so a reply can
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

export interface PartResult {
  partId: string;
  features: FeatureResult[];
  /** Features the edit could have changed, in order (the dirty subgraph); everything on a first regen. */
  dirty: string[];
  /**
   * The final body in the kernel arena, for pick and resolve ops. Valid until a later regen
   * evicts it or the kernel recycles. Null when the part has no body.
   */
  shape: ShapeId | null;
  /** Cache key of the final body; equal keys mean identical bodies. */
  bodyKey: string | null;
  /** The body differs from the one the last completed regen reported. */
  meshChanged: boolean;
  /** The body's mesh when `meshChanged` (name slots index `RegenResult.names`); null otherwise or without a body. */
  mesh: MeshData | null;
  /**
   * The body's topology (faces with their planes, edges with their faces, vertices), sent with
   * the mesh: face and edge `index` is the mesh's 1-based face and edge numbering.
   */
  topology: Topology | null;
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
