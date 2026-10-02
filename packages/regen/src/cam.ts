// The CAM geometry stage (M5 plan T5.1f; ADR 0014 decisions 5 to 7): a setup of the document's
// `cam` section turned into plain data the CAM worker (`packages/cam`) can cut from. Never part of
// a regen: the CAM workspace and export ask for one setup at a time (`RegenEngine.camGeometry`),
// at the client's current generation, on the regen chain, with the part built through the cache.
//
// What it does, per setup:
// - picks the setup's body (its `body`, or the part's only body) and measures its bounds from a
//   mesh at the CAM tolerance (`CAM_MESH_DEFLECTION`), which is also the `surface3d` mesh;
// - resolves the WCS up direction (a model axis, or a planar face by name on the final body);
// - evaluates the setup's, its tools' and its operations' expressions with the document's
//   variables (the same evaluation and dimension check as features, `values.ts`), fills absent
//   stepdowns, stepovers and feeds from the tool's preset for the stock's material, and turns
//   depths into machine Z ranges (blind: below the top of the operation's geometry; through: the
//   stock's bottom less `extra`);
// - resolves each geometry source: a face by the kernel's `resolve` op, then its loops by
//   `faceLoops` in a frame whose normal is the setup's up direction; a sketch region from the
//   sketch regen solved (`selectRegions`), whether or not a feature consumes the sketch; a hole
//   feature from its translated kernel input (points, the through-hole diameter and depth).
//
// Loops, points and the mesh stay in model coordinates: turning them into machine coordinates
// is `packages/cam`'s (`planarLoopsToMachine`, `drillPointToMachine`), which this package does
// not depend on. The types here are structurally those of `packages/cam` (`PlanarLoops`,
// `DrillPoint`, `Tool`, `Feeds`, `WcsUp`, the operation inputs without their geometry), so the app
// passes them on as they are. Machine Z (depths, heights of sources) needs only the up direction
// and the stock's Z range, computed here as `packages/cam`'s `boundsInSetup` and `stockFromBounds`
// / `stockFromSize` do.
//
// Caching: bounds and meshes by body key, face resolutions by body key and name, face loops by
// body key, face index and up direction, and whole results by a key over everything they read
// (`CamGeometryResult.key`). An unchanged setup on an unchanged body sends no kernel op.

import {
  camExpressions,
  camSetupOwnExpressions,
  camToolExpressions,
  type CamDepth,
  type CamEntry,
  type CamLead,
  type CamOperation,
  type CamSetup,
  type CamTool,
  type FaceReference,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from '@manufakture/core';
import type {
  FaceLoopsReport,
  FeatureInput,
  HoleInput,
  KernelOp,
  Loop,
  LoopSegment,
  MeshData,
  OpResult,
  ReferenceReport,
  ShapeId,
  Vec2,
  Vec3,
} from '@manufakture/kernel';
import type { Region, RegionCurve, RegionLoop } from '@manufakture/sketch';
import { cacheKey, type KeyVersions } from './cache';
import { selectRegions, type SketchResult } from './sketches';
import { faceRef } from './translate';
import type { FeatureResult, FieldPath, LastResolved, ReferenceResolution } from './types';
import { evaluateField, pathKey, type VariableValues } from './values';

/** Bump with any change that can change the stage's output for the same inputs. */
export const CAM_STAGE_VERSION = 1;

/**
 * The chordal and angular tolerance of the CAM mesh (ADR 0014 decision 7): finer than the
 * export's 0.02 mm, the values T5.0b's 99,200-triangle part was measured at. The bounds come from
 * this mesh too, so they may fall short of a curved extreme by at most `linear`.
 */
export const CAM_MESH_DEFLECTION = { linear: 0.004, angular: 0.06 } as const;

/** Chord deflection of face loop edges that are not lines or circles, and of sketch Beziers, mm. */
export const CAM_LOOP_DEFLECTION = 0.01;

/** A plane or axis within this angle (radians) of the setup's is parallel (`packages/cam`'s). */
export const CAM_PARALLEL_TOLERANCE = 1e-6;

/** Source heights further apart than this (mm) are reported as a `heights` warning. */
const HEIGHT_TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------------------------
// Types (structurally `packages/cam`'s where they share a name)

/** An axis-aligned box in model coordinates. */
export interface CamBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Where a segment came from: a body edge (its name, else `#<index>`), a sketch entity, a hole. */
export type CamSourceTag =
  | { readonly kind: 'edge'; readonly edge: string }
  | { readonly kind: 'sketch'; readonly sketch: string; readonly entity: string }
  | { readonly kind: 'hole'; readonly feature: string };

export type CamSegment =
  | {
      readonly kind: 'line';
      readonly start: Vec2;
      readonly end: Vec2;
      readonly source?: CamSourceTag;
    }
  | {
      readonly kind: 'arc';
      readonly start: Vec2;
      readonly end: Vec2;
      readonly center: Vec2;
      readonly ccw: boolean;
      readonly fullCircle?: boolean;
      readonly source?: CamSourceTag;
    };

/** A closed loop: outer loops counter-clockwise, holes clockwise, about the plane's normal. */
export interface CamLoop {
  readonly segments: readonly CamSegment[];
}

/** Loops on a plane in model coordinates: (u, v) is `origin + u * xDir + v * (normal x xDir)`. */
export interface CamPlanarLoops {
  readonly origin: Vec3;
  readonly xDir: Vec3;
  readonly normal: Vec3;
  readonly loops: readonly CamLoop[];
}

/** A hole to drill, model coordinates: `position` the top of the through-hole, `axis` into it. */
export interface CamDrillPoint {
  readonly position: Vec3;
  readonly axis: Vec3;
  /** The through-hole's diameter, never a counterbore's or countersink's. */
  readonly diameter: number;
  /** Along `axis` from `position`, mm. */
  readonly depth: number;
  readonly through?: boolean;
  readonly source?: CamSourceTag;
}

export type CamUpAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** The resolved WCS up direction (`packages/cam`'s `WcsUp`). */
export type CamWcsUp =
  | { readonly kind: 'axis'; readonly axis: CamUpAxis }
  | { readonly kind: 'face'; readonly normal: Vec3 };

/** A Z interval in machine coordinates. */
export interface CamDepthRange {
  readonly top: number;
  readonly bottom: number;
}

/** A tool with its expressions evaluated (`packages/cam`'s `Tool`). */
export interface CamToolValues {
  readonly id: string;
  readonly name: string;
  readonly kind: CamTool['kind'];
  readonly number?: number;
  readonly diameter: number;
  readonly fluteLength: number;
  readonly flutes: number;
  readonly cornerRadius?: number;
  readonly angle?: number;
  readonly tipDiameter?: number;
}

/** Feeds and speed (`packages/cam`'s `Feeds`): rpm and mm/min. */
export interface CamFeedValues {
  readonly spindle: number;
  readonly cut: number;
  readonly plunge: number;
  readonly ramp?: number;
  readonly lead?: number;
}

export type CamEntryValues =
  | { readonly kind: 'plunge' }
  | { readonly kind: 'ramp'; readonly angle: number }
  | { readonly kind: 'helix'; readonly angle: number; readonly radius: number };

export type CamLeadValues =
  | { readonly kind: 'none' }
  | { readonly kind: 'line'; readonly length: number }
  | { readonly kind: 'arc'; readonly radius: number };

interface OperationValuesBase {
  readonly id: string;
  readonly name: string;
  readonly tool: CamToolValues;
  readonly feeds: CamFeedValues;
}

/**
 * An operation's numbers, as `packages/cam`'s operation inputs take them, without the geometry
 * (loops and points), which the app converts from the sources into machine coordinates. Depths
 * are machine Z.
 */
export type CamOperationValues =
  | (OperationValuesBase & {
      readonly kind: 'facing';
      readonly depth: CamDepthRange;
      readonly stepdown: number;
      readonly stepover: number;
      readonly angle: number;
    })
  | (OperationValuesBase & {
      readonly kind: 'profile';
      readonly side: 'outside' | 'inside' | 'on';
      readonly depth: CamDepthRange;
      readonly stepdown: number;
      readonly finishAllowance: number;
      readonly tabs?: { readonly count: number; readonly width: number; readonly height: number };
      readonly entry: CamEntryValues;
      readonly leadIn: CamLeadValues;
      readonly leadOut: CamLeadValues;
      readonly climb: boolean;
      /**
       * `packages/cam`'s `ProfileExtras`, which core does not store yet: a finishing pass when
       * there is an allowance, in one step when the whole depth fits the flutes, else at
       * `stepdown`. `tabSpacing` and `tabMinInsideSize` are left to the generator's defaults.
       */
      readonly finishPass: boolean;
      readonly finishStepdown: number;
    })
  | (OperationValuesBase & {
      readonly kind: 'pocket';
      readonly depth: CamDepthRange;
      readonly stepdown: number;
      readonly stepover: number;
      readonly finishAllowance: number;
      readonly entry: CamEntryValues;
      readonly climb: boolean;
    })
  | (OperationValuesBase & {
      readonly kind: 'drill';
      readonly peck?: number;
      readonly dwell?: number;
    })
  | (OperationValuesBase & {
      readonly kind: 'vcarve';
      /** Machine Z of the surface carved into: the top of the operation's geometry. */
      readonly top: number;
      readonly maxDepth?: number;
    })
  | (OperationValuesBase & {
      readonly kind: 'surface3d';
      readonly stepover: number;
      readonly angle: number;
      readonly allowance: number;
    });

/** The setup's own numbers. */
export interface CamSetupValues {
  readonly machine: string;
  readonly post: string;
  readonly stock:
    | {
        readonly kind: 'fromBody';
        readonly margins: {
          readonly xMin: number;
          readonly xMax: number;
          readonly yMin: number;
          readonly yMax: number;
          readonly top: number;
          readonly bottom: number;
        };
        readonly material?: string;
      }
    | {
        readonly kind: 'explicit';
        readonly size: Vec3;
        readonly offset: Vec3;
        readonly material?: string;
      };
  readonly wcs: { readonly up: CamWcsUp; readonly origin: CamSetup['wcs']['origin'] };
  readonly heights: { readonly clearance: number; readonly retract: number };
  /** The stock's top and bottom in machine Z (the top is 0 for an origin on the top). */
  readonly stockZ: CamDepthRange;
}

/** How a CAM reference resolved: a geometry source's face (its index) or the WCS face. */
export interface CamReference extends ReferenceResolution {
  readonly source: number | 'wcs';
}

export type CamStageErrorCode =
  /** A face, sketch, sketch entity or hole feature that is not there any more: re-pick it. */
  | 'reference-lost'
  /** A face name that matches several faces: re-pick it. */
  | 'reference-ambiguous'
  /** An expression that does not evaluate or is not of the kind its field expects. */
  | 'expression'
  /** A source kind the operation does not take. */
  | 'unsupported'
  /** A plane or hole axis that is not parallel to the setup's XY plane or Z axis. */
  | 'not-parallel'
  /** A value out of range, a face that is not planar, a sketch with no closed region. */
  | 'invalid'
  /** No feeds: neither the operation nor the tool's preset for the stock's material sets them. */
  | 'feeds'
  /** The setup's part or body is not there, or the part has several bodies and none is chosen. */
  | 'no-body'
  /** A sketch or hole feature a source names failed, is suppressed or was not built. */
  | 'upstream'
  /** The setup failed (no body, WCS lost, its own expressions): nothing of it can be cut. */
  | 'setup'
  /** A kernel op failed as a whole. */
  | 'kernel';

export interface CamStageError {
  readonly code: CamStageErrorCode;
  readonly message: string;
  /** The geometry source (index into the operation's `geometry`) at fault. */
  readonly source?: number;
  /** The field at fault, from the operation, setup or (`['tool', ...]`) tool. */
  readonly field?: FieldPath;
  readonly referenceId?: string;
  readonly target?: string;
  readonly missing?: readonly string[];
  readonly candidates?: readonly string[];
  readonly lastResolved?: LastResolved;
  /** For `expression`: the units error (its range is in the expression at `field`). */
  readonly error?: unknown;
  readonly variable?: string;
}

export type CamStageWarningCode =
  /** A reference that resolved by `descendant`, `ancestor`, `ends`, ordinal, or by position. */
  | 'reference'
  /** The operation's sources lie at different heights; its depth is from the highest. */
  | 'heights'
  /** Features of the part failed: the setup machines what was built without them. */
  | 'source-errors';

export interface CamStageWarning {
  readonly code: CamStageWarningCode;
  readonly message: string;
  readonly source?: number;
  readonly referenceId?: string;
  readonly target?: string;
  readonly via?: ReferenceResolution['via'];
  readonly fragile?: boolean;
  readonly features?: readonly string[];
}

/** One geometry source, resolved, in model coordinates. `source` is its index in `geometry`. */
export type CamSourceResult =
  | {
      readonly source: number;
      readonly kind: 'face';
      /** The face's plane in machine Z. */
      readonly z: number;
      /** Whether its outward normal points up the setup's Z axis (false: down). */
      readonly facing: boolean;
      readonly planar: CamPlanarLoops;
    }
  | {
      readonly source: number;
      readonly kind: 'region';
      readonly z: number;
      readonly planar: CamPlanarLoops;
    }
  | { readonly source: number; readonly kind: 'hole'; readonly points: readonly CamDrillPoint[] };

export interface CamOperationResult {
  readonly operationId: string;
  readonly kind: CamOperation['kind'];
  /**
   * Changes whenever anything the operation's geometry and numbers come from changes: the
   * operation (but not its name), its tool, the setup's own fields, the variables, the body's key
   * and the regen keys of the sketches and holes it names. The CAM worker's toolpath key chains it.
   */
  readonly key: string;
  readonly status: 'ok' | 'error' | 'suppressed';
  readonly errors: readonly CamStageError[];
  readonly warnings: readonly CamStageWarning[];
  readonly references: readonly CamReference[];
  /** The sources that resolved, in `geometry` order. */
  readonly sources: readonly CamSourceResult[];
  /** Null when the operation failed or is suppressed. */
  readonly values: CamOperationValues | null;
}

/** A triangle mesh in model coordinates (`packages/cam`'s `Mesh`), at `CAM_MESH_DEFLECTION`. */
export interface CamMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface CamGeometryResult {
  readonly generation: number;
  readonly setupId: string;
  readonly partId: string;
  /** The body machined, or null when there is none to machine. */
  readonly bodyId: string | null;
  readonly bodyKey: string | null;
  /** The whole result's key: equal keys, equal results. */
  readonly key: string;
  /** `error` when the setup itself failed; operations report their own outcome either way. */
  readonly status: 'ok' | 'error';
  readonly errors: readonly CamStageError[];
  readonly warnings: readonly CamStageWarning[];
  /** The WCS face's resolution, when the WCS is up from a face. */
  readonly references: readonly CamReference[];
  /** The body's bounds in model coordinates (from the CAM mesh). */
  readonly bounds: CamBox | null;
  readonly setup: CamSetupValues | null;
  readonly operations: readonly CamOperationResult[];
  /** With `mesh: true`, or when an unsuppressed operation is `surface3d`. A copy: transfer it. */
  readonly mesh?: CamMesh;
  /** Served from the stage's result cache. */
  readonly cached: boolean;
  readonly ms: number;
}

export interface CamGeometryOptions {
  /**
   * The client's current generation (`latestGeneration`): never a new one, or the kernel would
   * cancel the regen in flight. A generation newer than any seen is treated as the newest seen.
   */
  generation?: number;
  /** As for `RegenOptions.stored`. */
  stored?: ManufaktureDocument;
  /** Send the body's CAM mesh (for the simulation) even without a `surface3d` operation. */
  mesh?: boolean;
}

/** Counters, for tests and the stats. */
export interface CamStats {
  /** `tessellate` ops sent (bounds and meshes). */
  tessellateOps: number;
  /** `resolve` ops sent (source faces and WCS faces). */
  resolveOps: number;
  /** `faceLoops` ops sent. */
  faceLoopsOps: number;
  /** Results served whole from the cache. */
  resultHits: number;
}

// ---------------------------------------------------------------------------------------------
// The host: what the engine gives the stage for one attempt of one request

/** A final body of a part, as the engine holds it. */
export interface CamBody {
  readonly id: string;
  readonly shape: ShapeId;
  readonly key: string;
  readonly instance: number | null;
}

/** A part built through the cache. */
export interface CamPartBuild {
  readonly part: Part;
  readonly bodies: readonly CamBody[];
  readonly sketches: ReadonlyMap<string, SketchResult>;
  readonly inputs: ReadonlyMap<string, FeatureInput>;
  readonly results: ReadonlyMap<string, FeatureResult>;
}

export interface CamHost {
  readonly generation: number;
  readonly versions: KeyVersions;
  readonly variables: VariableValues;
  /** The part built through the cache; undefined when the document has no such part. */
  part(partId: string): Promise<CamPartBuild | undefined>;
  /** Run kernel ops on `bodies`' shapes (null when there are none). */
  run(ops: KernelOp[], bodies: readonly CamBody[]): Promise<readonly OpResult[]>;
}

// ---------------------------------------------------------------------------------------------
// Caches

class Lru<V> {
  readonly #map = new Map<string, V>();
  constructor(readonly limit: number) {}
  get(key: string): V | undefined {
    const v = this.#map.get(key);
    if (v !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): V {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value!);
    return value;
  }
  get size(): number {
    return this.#map.size;
  }
}

export interface CamStageSizes {
  /** Bodies whose bounds are kept. */
  bounds?: number;
  /** Bodies whose CAM mesh is kept (meshes are large). */
  meshes?: number;
  /** Face resolutions and face loops kept. */
  faces?: number;
  /** Whole results kept. */
  results?: number;
}

type Resolved =
  | {
      ok: true;
      index: number;
      via: ReferenceResolution['via'];
      fragile: boolean;
      normal: Vec3 | null;
    }
  | { ok: false; error: Omit<CamStageError, 'source'> };

// ---------------------------------------------------------------------------------------------
// Small vector helpers

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

const AXES: Record<CamUpAxis, Vec3> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

/** A unit direction perpendicular to unit `z`: model X projected onto its plane, else model Y. */
function perpendicular(z: Vec3): Vec3 {
  const e: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(add3(e, scale(z, -dot(e, z))));
}

/** Box corners' extent along unit `z`. */
function extentAlong(box: CamBox, z: Vec3): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const w of [box.min[2], box.max[2]]) {
        const t = dot([x, y, w], z);
        min = Math.min(min, t);
        max = Math.max(max, t);
      }
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------------------------
// Loops

const TWO_PI = 2 * Math.PI;

/** A kernel face loop as a CAM loop: polylines become lines, arcs keep their turn. */
function camLoop(loop: Loop): CamLoop {
  const segments: CamSegment[] = [];
  const tag = (s: LoopSegment): CamSourceTag | undefined =>
    s.edge ? { kind: 'edge', edge: s.edge.name ?? `#${s.edge.index}` } : undefined;
  for (const s of loop.segments) {
    const source = tag(s);
    const extra = source ? { source } : {};
    if (s.kind === 'line') segments.push({ kind: 'line', start: s.start, end: s.end, ...extra });
    else if (s.kind === 'arc') {
      const full = Math.abs(Math.abs(s.sweep) - TWO_PI) < 1e-9;
      segments.push({
        kind: 'arc',
        start: s.start,
        end: full ? s.start : s.end,
        center: s.center,
        ccw: s.sweep > 0,
        ...(full ? { fullCircle: true } : {}),
        ...extra,
      });
    } else {
      for (let i = 0; i + 1 < s.points.length; i++) {
        segments.push({ kind: 'line', start: s.points[i]!, end: s.points[i + 1]!, ...extra });
      }
    }
  }
  return { segments };
}

/** Points along a Bezier (control points `p`) within `tolerance` of it, the ends included. */
function flattenBezier(p: readonly Vec2[], tolerance: number): Vec2[] {
  const degree = p.length - 1;
  // The chord error of n equal steps is at most max|B''| / (8 n^2), and |B''| is at most
  // degree (degree - 1) times the largest second difference of the control points.
  let d2 = 0;
  for (let i = 0; i + 2 < p.length; i++) {
    d2 = Math.max(
      d2,
      Math.hypot(
        p[i]![0] - 2 * p[i + 1]![0] + p[i + 2]![0],
        p[i]![1] - 2 * p[i + 1]![1] + p[i + 2]![1],
      ),
    );
  }
  const n = Math.max(1, Math.ceil(Math.sqrt((degree * (degree - 1) * d2) / (8 * tolerance))));
  const out: Vec2[] = [p[0]!];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    // de Casteljau.
    let q = p.map((v) => [v[0], v[1]] as [number, number]);
    while (q.length > 1) {
      q = q
        .slice(1)
        .map((v, i) => [q[i]![0] + (v[0] - q[i]![0]) * t, q[i]![1] + (v[1] - q[i]![1]) * t]);
    }
    out.push(q[0]!);
  }
  out.push(p[p.length - 1]!);
  return out;
}

/** A sketch region loop as a CAM loop in the sketch's 2D coordinates. */
function regionLoop(loop: RegionLoop, sketch: string): CamLoop {
  const segments: CamSegment[] = [];
  for (const c of loop.curves as RegionCurve[]) {
    const source: CamSourceTag = { kind: 'sketch', sketch, entity: c.entityId };
    switch (c.kind) {
      case 'line':
        segments.push({ kind: 'line', start: c.start, end: c.end, source });
        break;
      case 'arc':
        segments.push({
          kind: 'arc',
          start: c.start,
          end: c.end,
          center: c.center,
          ccw: !c.reversed,
          source,
        });
        break;
      case 'circle':
        segments.push({
          kind: 'arc',
          start: c.start,
          end: c.start,
          center: c.center,
          ccw: !c.reversed,
          fullCircle: true,
          source,
        });
        break;
      case 'bezier': {
        const pts = flattenBezier(c.points, CAM_LOOP_DEFLECTION);
        for (let i = 0; i + 1 < pts.length; i++) {
          segments.push({ kind: 'line', start: pts[i]!, end: pts[i + 1]!, source });
        }
        break;
      }
    }
  }
  return { segments };
}

function regionLoops(regions: readonly Region[], sketch: string): CamLoop[] {
  return regions.flatMap((r) => [r.outer, ...r.holes].map((l) => regionLoop(l, sketch)));
}

// ---------------------------------------------------------------------------------------------
// Expressions

/** Evaluated expressions of one tool, setup or operation, by `pathKey`. */
interface Evaluated {
  values: Map<string, number>;
  errors: CamStageError[];
}

function evaluateSites(
  sites: readonly { path: FieldPath; expression: StoredExpression; expected: string }[],
  variables: VariableValues,
  prefix: FieldPath = [],
): Evaluated {
  const values = new Map<string, number>();
  const errors: CamStageError[] = [];
  for (const site of sites) {
    const field = [...prefix, ...site.path];
    const r = evaluateField(
      site.expression,
      site.expected as Parameters<typeof evaluateField>[1],
      field,
      variables,
    );
    if (r.ok) values.set(pathKey(site.path), r.value);
    else {
      const e = r.error as {
        message: string;
        field?: FieldPath;
        error?: unknown;
        variable?: string;
      };
      errors.push({
        code: 'expression',
        message: e.message,
        field,
        ...(e.error === undefined ? {} : { error: e.error }),
        ...(e.variable === undefined ? {} : { variable: e.variable }),
      });
    }
  }
  return { values, errors };
}

/** Records an `invalid` error on `field` unless `ok`. */
function check(errors: CamStageError[], ok: boolean, field: FieldPath, message: string): void {
  if (!ok) errors.push({ code: 'invalid', field, message });
}

const positive = (v: number | undefined): boolean => v !== undefined && Number.isFinite(v) && v > 0;
const nonNegative = (v: number | undefined): boolean =>
  v !== undefined && Number.isFinite(v) && v >= 0;

interface ToolEvaluation {
  tool: CamToolValues | null;
  /** The preset for the stock's material, if the tool has one. */
  preset: {
    spindle?: number;
    feed?: number;
    plunge?: number;
    stepdown?: number;
    stepover?: number;
  } | null;
  errors: CamStageError[];
}

function evaluateTool(
  tool: CamTool,
  material: string | undefined,
  variables: VariableValues,
): ToolEvaluation {
  const presetIndex =
    material === undefined ? -1 : tool.presets.findIndex((p) => p.material === material);
  // Only the preset in use matters: an error in another one is not this operation's problem.
  const sites = camToolExpressions(tool).filter(
    (s) => s.path[0] !== 'presets' || s.path[1] === presetIndex,
  );
  const { values, errors } = evaluateSites(sites, variables, ['tool']);
  const get = (k: string) => values.get(k);
  const size = (k: string, what: string) => {
    const v = get(k);
    if (v !== undefined)
      check(errors, positive(v), ['tool', k], `${tool.id}: the ${what} must be greater than zero`);
  };
  size('diameter', 'diameter');
  size('fluteLength', 'flute length');
  if (errors.length > 0) return { tool: null, preset: null, errors };
  const optional = (k: string) => (get(k) === undefined ? {} : { [k]: get(k)! });
  const out: CamToolValues = {
    id: tool.id,
    name: tool.name,
    kind: tool.kind,
    ...(tool.number === undefined ? {} : { number: tool.number }),
    diameter: get('diameter')!,
    fluteLength: get('fluteLength')!,
    flutes: tool.flutes,
    ...optional('cornerRadius'),
    ...optional('angle'),
    ...optional('tipDiameter'),
  };
  let preset: ToolEvaluation['preset'] = null;
  if (presetIndex >= 0) {
    preset = {};
    for (const k of ['spindle', 'feed', 'plunge', 'stepdown', 'stepover'] as const) {
      const v = get(pathKey(['presets', presetIndex, k]));
      if (v !== undefined) preset[k] = v;
    }
  }
  return { tool: out, preset, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// The stage

/** The kinds of source each operation kind takes (core's validation says the same). */
const TAKES: Record<CamOperation['kind'], readonly string[]> = {
  facing: ['face', 'region'],
  profile: ['face', 'region'],
  pocket: ['face', 'region'],
  vcarve: ['face', 'region'],
  drill: ['hole'],
  surface3d: [],
};

/** What resolving the setup gave: everything its operations read. */
interface SetupContext {
  build: CamPartBuild;
  body: CamBody;
  bounds: CamBox;
  z: Vec3;
  /** Setup-frame Z of the machine origin. */
  originZ: number;
  values: CamSetupValues;
  /** Body Z range in machine Z. */
  bodyZ: CamDepthRange;
}

export class CamStage {
  readonly stats: CamStats = { tessellateOps: 0, resolveOps: 0, faceLoopsOps: 0, resultHits: 0 };
  readonly #bounds: Lru<CamBox>;
  readonly #meshes: Lru<CamMesh>;
  readonly #resolved: Lru<Resolved>;
  readonly #loops: Lru<FaceLoopsReport | { ok: false; status: 'kernel'; message: string }>;
  readonly #results: Lru<Omit<CamGeometryResult, 'generation' | 'mesh' | 'cached' | 'ms'>>;
  /** Why the last tessellation of a body key failed, until the caller reads it (never cached). */
  readonly #failures = new Map<string, string>();

  constructor(sizes: CamStageSizes = {}) {
    this.#bounds = new Lru(sizes.bounds ?? 256);
    this.#meshes = new Lru(sizes.meshes ?? 4);
    this.#resolved = new Lru(sizes.faces ?? 1024);
    this.#loops = new Lru(sizes.faces ?? 1024);
    this.#results = new Lru(sizes.results ?? 32);
  }

  /** The geometry of one setup of `document`, built through `host`. */
  async geometry(
    host: CamHost,
    document: ManufaktureDocument,
    setup: CamSetup,
    options: CamGeometryOptions = {},
  ): Promise<CamGeometryResult> {
    const t0 = performance.now();
    const build = await host.part(setup.part);
    const base = {
      setupId: setup.id,
      partId: setup.part,
    };
    const wantMesh =
      options.mesh === true ||
      setup.operations.some((op) => op.kind === 'surface3d' && !op.suppressed);

    // The body.
    const setupErrors: CamStageError[] = [];
    const setupWarnings: CamStageWarning[] = [];
    let body: CamBody | undefined;
    if (build === undefined) {
      setupErrors.push({ code: 'no-body', message: `The document has no part ${setup.part}` });
    } else {
      const failed = build.part.features
        .filter((f) => {
          const s = build.results.get(f.id)?.status;
          return s === 'error' || s === 'upstream-error';
        })
        .map((f) => f.id);
      if (failed.length > 0) {
        setupWarnings.push({
          code: 'source-errors',
          features: failed,
          message: `${failed.length === 1 ? 'A feature' : `${failed.length} features`} of ${build.part.name} failed (${failed.join(', ')}): the setup machines what was built without ${failed.length === 1 ? 'it' : 'them'}`,
        });
      }
      if (setup.body !== undefined) {
        body = build.bodies.find((b) => b.id === setup.body);
        if (body === undefined) {
          setupErrors.push({
            code: 'no-body',
            missing: [setup.body],
            message: `${build.part.name} has no body ${setup.body} (merged into another, or never made): choose the body to machine`,
          });
        }
      } else if (build.bodies.length === 1) {
        body = build.bodies[0];
      } else if (build.bodies.length === 0) {
        setupErrors.push({ code: 'no-body', message: `${build.part.name} has no body to machine` });
      } else {
        setupErrors.push({
          code: 'no-body',
          candidates: build.bodies.map((b) => b.id),
          message: `${build.part.name} has ${build.bodies.length} bodies (${build.bodies.map((b) => b.id).join(', ')}): choose the body to machine`,
        });
      }
    }

    // The whole result's key: everything it reads.
    const tools = new Map(document.cam.tools.map((t) => [t.id, t]));
    const featureKey = (id: string) => {
      const r = build?.results.get(id);
      return r === undefined ? null : [r.status, r.key ?? null];
    };
    const named = new Set<string>();
    for (const op of setup.operations) {
      for (const g of op.geometry) {
        if (g.kind === 'region') named.add(g.sketch);
        if (g.kind === 'hole') named.add(g.feature);
      }
    }
    const { name: _setupName, operations: _ops, ...setupOwn } = setup;
    void _setupName;
    void _ops;
    const common = {
      stage: CAM_STAGE_VERSION,
      setup: setupOwn,
      variables: document.variables,
      body: body === undefined ? null : [body.id, body.key],
      bodies: build?.bodies.length ?? 0,
    };
    const key = cacheKey(host.versions, {
      ...common,
      operations: setup.operations,
      tools: [...new Set(setup.operations.map((op) => op.tool))].map((id) => tools.get(id) ?? id),
      features: [...named].sort().map((id) => [id, featureKey(id)]),
      warnings: setupWarnings.map((w) => w.message),
    });

    const finish = async (
      result: Omit<CamGeometryResult, 'generation' | 'mesh' | 'cached' | 'ms'>,
      cached: boolean,
    ): Promise<CamGeometryResult> => {
      const mesh = wantMesh && body !== undefined ? await this.#mesh(host, body) : undefined;
      return {
        ...result,
        generation: host.generation,
        cached,
        ms: performance.now() - t0,
        ...(mesh === undefined ? {} : { mesh }),
      };
    };

    const hit = this.#results.get(key);
    if (hit !== undefined) {
      this.stats.resultHits++;
      // A copy: a caller in the worker's thread must not change what the cache holds.
      return finish(structuredClone(hit), true);
    }

    const operationKey = (op: CamOperation) => {
      const { name: _n, ...rest } = op;
      void _n;
      const sources = op.geometry
        .filter((g) => g.kind !== 'face')
        .map((g) => (g.kind === 'region' ? g.sketch : g.feature));
      return cacheKey(host.versions, {
        ...common,
        operation: rest,
        tool: tools.get(op.tool) ?? op.tool,
        features: [...new Set(sources)].sort().map((id) => [id, featureKey(id)]),
      });
    };

    let context: SetupContext | null = null;
    const references: CamReference[] = [];
    if (build !== undefined && body !== undefined) {
      const resolved = await this.#setupContext(
        host,
        build,
        body,
        setup,
        setupErrors,
        setupWarnings,
        references,
      );
      context = resolved;
    }

    const operations: CamOperationResult[] = [];
    if (context !== null) await this.#prefetchFaces(host, context, setup);
    for (const op of setup.operations) {
      operations.push(
        op.suppressed
          ? {
              operationId: op.id,
              kind: op.kind,
              key: operationKey(op),
              status: 'suppressed',
              errors: [],
              warnings: [],
              references: [],
              sources: [],
              values: null,
            }
          : context === null
            ? {
                operationId: op.id,
                kind: op.kind,
                key: operationKey(op),
                status: 'error',
                errors: [{ code: 'setup', message: `${setup.id} failed: see the setup's errors` }],
                warnings: [],
                references: [],
                sources: [],
                values: null,
              }
            : await this.#operation(host, context, tools, op, operationKey(op)),
      );
    }

    const result = {
      ...base,
      bodyId: body?.id ?? null,
      bodyKey: body?.key ?? null,
      key,
      status: context === null ? ('error' as const) : ('ok' as const),
      errors: setupErrors,
      warnings: setupWarnings,
      references,
      bounds: context?.bounds ?? null,
      setup: context?.values ?? null,
      operations,
    };
    // A kernel failure may not repeat: not cached, so the next request tries again.
    if (!setupErrors.some((e) => e.code === 'kernel'))
      this.#results.set(key, structuredClone(result));
    return finish(result, false);
  }

  // Setup --------------------------------------------------------------------------------------

  async #setupContext(
    host: CamHost,
    build: CamPartBuild,
    body: CamBody,
    setup: CamSetup,
    errors: CamStageError[],
    warnings: CamStageWarning[],
    references: CamReference[],
  ): Promise<SetupContext | null> {
    const bounds = await this.#boundsOf(host, body);
    const failure = this.#failures.get(body.key);
    this.#failures.delete(body.key);
    if (failure !== undefined) {
      errors.push({
        code: 'kernel',
        message: `Meshing ${body.id} for CAM failed: ${failure}`,
      });
      return null;
    }
    if (bounds === null) {
      errors.push({ code: 'no-body', message: `${body.id} is empty: there is nothing to machine` });
      return null;
    }
    // The up direction.
    let up: CamWcsUp;
    let z: Vec3;
    if (setup.wcs.up.kind === 'axis') {
      up = { kind: 'axis', axis: setup.wcs.up.axis };
      z = AXES[setup.wcs.up.axis];
    } else {
      const face = setup.wcs.up.face;
      const r = await this.#resolve(host, body, face);
      if (!r.ok) {
        errors.push({ ...r.error, field: ['wcs', 'up', 'face'] });
        return null;
      }
      if (r.normal === null) {
        errors.push({
          code: 'invalid',
          field: ['wcs', 'up', 'face'],
          referenceId: face.id,
          target: face.ref.face,
          message: `The WCS face ${face.ref.face} is not planar: pick a flat face`,
        });
        return null;
      }
      references.push({
        source: 'wcs',
        referenceId: face.id,
        target: face.ref.face,
        via: r.via,
        fragile: r.fragile,
      });
      if (r.via !== 'exact' || r.fragile) {
        warnings.push({
          code: 'reference',
          referenceId: face.id,
          target: face.ref.face,
          via: r.via,
          fragile: r.fragile,
          message: `The WCS face ${face.ref.face} resolved ${r.fragile ? 'by position' : `by ${r.via}`}: check it`,
        });
      }
      z = unit(r.normal);
      up = { kind: 'face', normal: z };
    }

    // The setup's own numbers.
    const own = evaluateSites(camSetupOwnExpressions(setup), host.variables);
    if (own.errors.length > 0) {
      errors.push(...own.errors);
      return null;
    }
    const v = (...path: (string | number)[]) => own.values.get(pathKey(path))!;
    const invalid: CamStageError[] = [];
    const stock = setup.stock;
    const material = stock.material;
    const bodyAlong = extentAlong(bounds, z);
    let stockMin: number;
    let stockMax: number;
    let stockValues: CamSetupValues['stock'];
    if (stock.kind === 'fromBody') {
      const margins = {
        xMin: v('stock', 'margins', 'xMin'),
        xMax: v('stock', 'margins', 'xMax'),
        yMin: v('stock', 'margins', 'yMin'),
        yMax: v('stock', 'margins', 'yMax'),
        top: v('stock', 'margins', 'top'),
        bottom: v('stock', 'margins', 'bottom'),
      };
      for (const [k, m] of Object.entries(margins)) {
        check(
          invalid,
          nonNegative(m),
          ['stock', 'margins', k],
          `The stock margin ${k} must be zero or more`,
        );
      }
      stockMin = bodyAlong.min - margins.bottom;
      stockMax = bodyAlong.max + margins.top;
      stockValues = { kind: 'fromBody', margins, ...(material === undefined ? {} : { material }) };
    } else {
      const size: Vec3 = [
        v('stock', 'size', 'x'),
        v('stock', 'size', 'y'),
        v('stock', 'size', 'z'),
      ];
      const offset: Vec3 = [
        v('stock', 'offset', 'x'),
        v('stock', 'offset', 'y'),
        v('stock', 'offset', 'z'),
      ];
      size.forEach((s, i) =>
        check(
          invalid,
          positive(s),
          ['stock', 'size', 'xyz'[i]!],
          'The stock size must be greater than zero',
        ),
      );
      stockMin = bodyAlong.min - offset[2];
      stockMax = stockMin + size[2];
      if (
        invalid.length === 0 &&
        (stockMin > bodyAlong.min + 1e-9 || stockMax < bodyAlong.max - 1e-9)
      ) {
        invalid.push({
          code: 'invalid',
          field: ['stock'],
          message:
            'The stock does not contain the body along Z: make it taller or change its offset',
        });
      }
      stockValues = {
        kind: 'explicit',
        size,
        offset,
        ...(material === undefined ? {} : { material }),
      };
    }
    const heights = { clearance: v('heights', 'clearance'), retract: v('heights', 'retract') };
    check(
      invalid,
      Number.isFinite(heights.clearance),
      ['heights', 'clearance'],
      'The clearance height must be finite',
    );
    check(
      invalid,
      Number.isFinite(heights.retract),
      ['heights', 'retract'],
      'The retract height must be finite',
    );
    check(
      invalid,
      !(heights.retract > heights.clearance),
      ['heights', 'retract'],
      'The retract height must not be above the clearance height',
    );
    if (invalid.length > 0) {
      errors.push(...invalid);
      return null;
    }
    const originZ = setup.wcs.origin.z === 'top' ? stockMax : stockMin;
    return {
      build,
      body,
      bounds,
      z,
      originZ,
      bodyZ: { top: bodyAlong.max - originZ, bottom: bodyAlong.min - originZ },
      values: {
        machine: setup.machine,
        post: setup.post,
        stock: stockValues,
        wcs: { up, origin: setup.wcs.origin },
        heights,
        stockZ: { top: stockMax - originZ, bottom: stockMin - originZ },
      },
    };
  }

  // Operations ---------------------------------------------------------------------------------

  async #operation(
    host: CamHost,
    ctx: SetupContext,
    tools: ReadonlyMap<string, CamTool>,
    op: CamOperation,
    key: string,
  ): Promise<CamOperationResult> {
    const errors: CamStageError[] = [];
    const warnings: CamStageWarning[] = [];
    const references: CamReference[] = [];
    const sources: CamSourceResult[] = [];
    const out = (values: CamOperationValues | null): CamOperationResult => ({
      operationId: op.id,
      kind: op.kind,
      key,
      status: errors.length === 0 && values !== null ? 'ok' : 'error',
      errors,
      warnings,
      references,
      sources,
      values: errors.length === 0 ? values : null,
    });

    // Sources.
    for (const [i, g] of op.geometry.entries()) {
      if (!TAKES[op.kind].includes(g.kind)) {
        errors.push({
          code: 'unsupported',
          source: i,
          message: `A ${op.kind} operation does not take a ${g.kind} source`,
        });
        continue;
      }
      if (g.kind === 'face')
        await this.#faceSource(host, ctx, g.face, i, sources, errors, warnings, references);
      else if (g.kind === 'region')
        this.#regionSource(ctx, g.sketch, g.entities, i, sources, errors);
      else this.#holeSource(ctx, g.feature, i, sources, errors);
    }

    // Tool and feeds.
    const toolDef = tools.get(op.tool);
    if (toolDef === undefined) {
      errors.push({
        code: 'invalid',
        field: ['tool'],
        message: `The document has no tool ${op.tool}`,
      });
      return out(null);
    }
    const material = ctx.values.stock.material;
    const tool = evaluateTool(toolDef, material, host.variables);
    errors.push(...tool.errors);
    const own = evaluateSites(camExpressions(op), host.variables);
    errors.push(...own.errors);
    if (tool.tool === null || own.errors.length > 0) return out(null);
    const get = (...path: (string | number)[]) => own.values.get(pathKey(path));
    const preset = tool.preset;
    const noPreset =
      material === undefined
        ? 'the stock has no material'
        : `${toolDef.id} has no preset for ${material}`;

    const feed = (k: 'spindle' | 'cut' | 'plunge', from: number | undefined, what: string) => {
      const value = get('feeds', k) ?? from;
      if (value === undefined) {
        errors.push({
          code: 'feeds',
          field: ['feeds', k],
          message: `No ${what}: set one on the operation (${noPreset})`,
        });
        return 0;
      }
      check(errors, positive(value), ['feeds', k], `The ${what} must be greater than zero`);
      return value;
    };
    const spindle = feed('spindle', preset?.spindle, 'spindle speed');
    const cut = feed('cut', preset?.feed, 'cutting feed');
    const plunge = feed('plunge', preset?.plunge, 'plunge feed');
    const ramp = get('feeds', 'ramp');
    const lead = get('feeds', 'lead');
    if (ramp !== undefined)
      check(errors, positive(ramp), ['feeds', 'ramp'], 'The ramp feed must be greater than zero');
    if (lead !== undefined)
      check(errors, positive(lead), ['feeds', 'lead'], 'The lead feed must be greater than zero');
    const feeds: CamFeedValues = {
      spindle,
      cut,
      plunge,
      ...(ramp === undefined ? {} : { ramp }),
      ...(lead === undefined ? {} : { lead }),
    };
    const head = { id: op.id, name: op.name, tool: tool.tool, feeds };

    const fromPreset = (k: 'stepdown' | 'stepover', what: string): number => {
      const value = get(k) ?? preset?.[k];
      if (value === undefined) {
        errors.push({
          code: 'feeds',
          field: [k],
          message: `No ${what}: set one on the operation (${noPreset})`,
        });
        return 0;
      }
      return value;
    };
    const fraction = (value: number, field: FieldPath) =>
      check(
        errors,
        positive(value) && value <= 1,
        field,
        'The stepover must be a fraction of the tool diameter, more than 0 and at most 1',
      );

    // The top of the operation's geometry, machine Z.
    const heights = sources.flatMap((s) => (s.kind === 'hole' ? [] : [s.z]));
    const geometryTop = heights.length > 0 ? Math.max(...heights) : ctx.values.stockZ.top;
    if (heights.length > 1 && Math.max(...heights) - Math.min(...heights) > HEIGHT_TOLERANCE) {
      warnings.push({
        code: 'heights',
        message: `The sources of ${op.id} lie at different heights (${Math.min(...heights)} to ${Math.max(...heights)} mm): ${
          op.kind === 'pocket' && sources.some((x) => x.kind === 'face')
            ? 'a pocket on floor faces ends at the highest floor'
            : 'its depth is measured from the highest'
        }`,
      });
    }
    // Every cut starts at the stock top, so a generator's rapids (to `top` plus its safe height)
    // never run into uncut stock above a source lying lower; `depth` sets the bottom.
    const stockTop = ctx.values.stockZ.top;
    const depthRange = (depth: CamDepth): CamDepthRange => {
      let bottom: number;
      if (depth.kind === 'blind') {
        const d = get('depth', 'depth')!;
        check(errors, positive(d), ['depth', 'depth'], 'The depth must be greater than zero');
        bottom = geometryTop - d;
      } else {
        const extra = get('depth', 'extra') ?? 0;
        check(
          errors,
          nonNegative(extra),
          ['depth', 'extra'],
          'The extra depth must be zero or more',
        );
        bottom = ctx.values.stockZ.bottom - extra;
        check(
          errors,
          geometryTop > bottom,
          ['depth'],
          'The geometry is at or below the stock bottom: there is nothing to cut through',
        );
      }
      check(
        errors,
        stockTop > bottom,
        ['depth'],
        'The cut ends at or above the stock top: there is nothing to cut',
      );
      return { top: stockTop, bottom };
    };
    const needsGeometry = () => {
      if (op.geometry.length === 0) {
        errors.push({
          code: 'invalid',
          field: ['geometry'],
          message: `${op.id} has no geometry: pick a face or a sketch region`,
        });
      }
    };
    const entryOf = (e: CamEntry): CamEntryValues => {
      if (e.kind === 'plunge') return { kind: 'plunge' };
      const angle = get('entry', 'angle')!;
      check(
        errors,
        positive(angle) && angle <= Math.PI / 2,
        ['entry', 'angle'],
        'The entry angle must be more than 0 and at most 90 degrees',
      );
      if (e.kind === 'ramp') return { kind: 'ramp', angle };
      const radius = get('entry', 'radius')!;
      check(
        errors,
        positive(radius),
        ['entry', 'radius'],
        'The helix radius must be greater than zero',
      );
      return { kind: 'helix', angle, radius };
    };
    const leadOf = (k: 'leadIn' | 'leadOut', lead: CamLead): CamLeadValues => {
      if (lead.kind === 'none') return { kind: 'none' };
      if (lead.kind === 'line') {
        const length = get(k, 'length')!;
        check(errors, positive(length), [k, 'length'], 'The lead length must be greater than zero');
        return { kind: 'line', length };
      }
      const radius = get(k, 'radius')!;
      check(errors, positive(radius), [k, 'radius'], 'The lead radius must be greater than zero');
      return { kind: 'arc', radius };
    };

    let values: CamOperationValues | null = null;
    switch (op.kind) {
      case 'facing': {
        const depth = get('depth')!;
        check(errors, positive(depth), ['depth'], 'The facing depth must be greater than zero');
        const stepdown = fromPreset('stepdown', 'stepdown');
        const stepover = fromPreset('stepover', 'stepover');
        check(errors, positive(stepdown), ['stepdown'], 'The stepdown must be greater than zero');
        fraction(stepover, ['stepover']);
        const top = ctx.values.stockZ.top;
        values = {
          ...head,
          kind: 'facing',
          depth: { top, bottom: top - depth },
          stepdown,
          stepover,
          angle: get('angle')!,
        };
        break;
      }
      case 'profile': {
        needsGeometry();
        const depth = depthRange(op.depth);
        const stepdown = fromPreset('stepdown', 'stepdown');
        check(errors, positive(stepdown), ['stepdown'], 'The stepdown must be greater than zero');
        const finishAllowance = get('finishAllowance') ?? 0;
        check(
          errors,
          nonNegative(finishAllowance),
          ['finishAllowance'],
          'The finishing allowance must be zero or more',
        );
        let tabs: { count: number; width: number; height: number } | undefined;
        if (op.tabs !== undefined) {
          tabs = {
            count: get('tabs', 'count')!,
            width: get('tabs', 'width')!,
            height: get('tabs', 'height')!,
          };
          check(
            errors,
            Number.isInteger(tabs.count) && tabs.count >= 0,
            ['tabs', 'count'],
            'The tab count must be a whole number, zero or more',
          );
          check(
            errors,
            positive(tabs.width),
            ['tabs', 'width'],
            'The tab width must be greater than zero',
          );
          check(
            errors,
            positive(tabs.height),
            ['tabs', 'height'],
            'The tab height must be greater than zero',
          );
        }
        const whole = depth.top - depth.bottom;
        values = {
          ...head,
          kind: 'profile',
          side: op.side,
          depth,
          stepdown,
          finishAllowance,
          ...(tabs === undefined ? {} : { tabs }),
          entry: entryOf(op.entry),
          leadIn: leadOf('leadIn', op.leadIn),
          leadOut: leadOf('leadOut', op.leadOut),
          climb: op.climb,
          finishPass: finishAllowance > 0,
          finishStepdown: whole <= tool.tool.fluteLength ? whole : stepdown,
        };
        break;
      }
      case 'pocket': {
        needsGeometry();
        // A face is the pocket's floor: it ends there, whatever `depth` says. Blind and through
        // apply to sketch regions. One operation has one floor, so the two do not mix.
        const floors = sources.flatMap((s) => (s.kind === 'face' ? [s.z] : []));
        let depth: CamDepthRange;
        if (floors.length === 0) depth = depthRange(op.depth);
        else if (floors.length < sources.length) {
          errors.push({
            code: 'invalid',
            field: ['geometry'],
            message: `${op.id} mixes floor faces and sketch regions: a face is a floor, a region is cut to a depth; split them into two pockets`,
          });
          depth = { top: stockTop, bottom: stockTop };
        } else {
          // A face looking down the setup's Z is an underside (the part's bottom, below a
          // step): a floor there would clear real part material above it.
          for (const x of sources) {
            if (x.kind === 'face' && !x.facing) {
              errors.push({
                code: 'invalid',
                source: x.source,
                message: `The floor face of ${op.id} faces down: pick a face that faces up`,
              });
            }
          }
          const floor = Math.max(...floors);
          check(
            errors,
            stockTop > floor,
            ['geometry'],
            'The floor face is at or above the stock top: there is nothing to cut',
          );
          depth = { top: stockTop, bottom: floor };
        }
        const stepdown = fromPreset('stepdown', 'stepdown');
        const stepover = fromPreset('stepover', 'stepover');
        check(errors, positive(stepdown), ['stepdown'], 'The stepdown must be greater than zero');
        fraction(stepover, ['stepover']);
        const finishAllowance = get('finishAllowance') ?? 0;
        check(
          errors,
          nonNegative(finishAllowance),
          ['finishAllowance'],
          'The finishing allowance must be zero or more',
        );
        values = {
          ...head,
          kind: 'pocket',
          depth,
          stepdown,
          stepover,
          finishAllowance,
          entry: entryOf(op.entry),
          climb: op.climb,
        };
        break;
      }
      case 'drill': {
        if (op.geometry.length === 0) {
          errors.push({
            code: 'invalid',
            field: ['geometry'],
            message: `${op.id} has no holes: pick a hole feature`,
          });
        }
        const peck = get('peck');
        const dwell = get('dwell');
        if (peck !== undefined)
          check(errors, positive(peck), ['peck'], 'The peck depth must be greater than zero');
        if (dwell !== undefined)
          check(errors, nonNegative(dwell), ['dwell'], 'The dwell must be zero or more');
        // The operation's own depth replaces each hole's.
        if (op.depth !== undefined) {
          const depth = op.depth;
          const blind = depth.kind === 'blind' ? get('depth', 'depth')! : undefined;
          const extra = depth.kind === 'through' ? (get('depth', 'extra') ?? 0) : 0;
          if (blind !== undefined)
            check(
              errors,
              positive(blind),
              ['depth', 'depth'],
              'The depth must be greater than zero',
            );
          check(
            errors,
            nonNegative(extra),
            ['depth', 'extra'],
            'The extra depth must be zero or more',
          );
          for (const [j, s] of sources.entries()) {
            if (s.kind !== 'hole') continue;
            sources[j] = {
              ...s,
              points: s.points.map((p) => {
                if (blind !== undefined) {
                  const { through: _t, ...rest } = p;
                  void _t;
                  return { ...rest, depth: blind };
                }
                const top = dot(p.position, ctx.z) - ctx.originZ;
                return { ...p, depth: top - (ctx.values.stockZ.bottom - extra), through: true };
              }),
            };
          }
        }
        values = {
          ...head,
          kind: 'drill',
          ...(peck === undefined ? {} : { peck }),
          ...(dwell === undefined ? {} : { dwell }),
        };
        break;
      }
      case 'vcarve': {
        needsGeometry();
        const maxDepth = get('maxDepth');
        if (maxDepth !== undefined)
          check(
            errors,
            positive(maxDepth),
            ['maxDepth'],
            'The maximum depth must be greater than zero',
          );
        values = {
          ...head,
          kind: 'vcarve',
          top: geometryTop,
          ...(maxDepth === undefined ? {} : { maxDepth }),
        };
        break;
      }
      case 'surface3d': {
        const stepover = get('stepover')!;
        check(errors, positive(stepover), ['stepover'], 'The stepover must be greater than zero');
        const allowance = get('allowance') ?? 0;
        check(errors, nonNegative(allowance), ['allowance'], 'The allowance must be zero or more');
        values = { ...head, kind: 'surface3d', stepover, angle: get('angle')!, allowance };
        break;
      }
    }
    return out(values);
  }

  async #faceSource(
    host: CamHost,
    ctx: SetupContext,
    face: FaceReference,
    i: number,
    sources: CamSourceResult[],
    errors: CamStageError[],
    warnings: CamStageWarning[],
    references: CamReference[],
  ): Promise<void> {
    const target = face.ref.face;
    const r = await this.#resolve(host, ctx.body, face);
    if (!r.ok) {
      errors.push({ ...r.error, source: i });
      return;
    }
    references.push({ source: i, referenceId: face.id, target, via: r.via, fragile: r.fragile });
    if (r.via !== 'exact' || r.fragile) {
      warnings.push({
        code: 'reference',
        source: i,
        referenceId: face.id,
        target,
        via: r.via,
        fragile: r.fragile,
        message: `${target} resolved ${r.fragile ? 'by position' : `by ${r.via}`}: check it`,
      });
    }
    const loops = await this.#faceLoops(host, ctx, r.index);
    if (!loops.ok) {
      const code =
        loops.status === 'not-parallel'
          ? 'not-parallel'
          : loops.status === 'kernel'
            ? 'kernel'
            : 'invalid';
      errors.push({
        code,
        source: i,
        referenceId: face.id,
        target,
        message:
          loops.status === 'not-parallel'
            ? `${target} is not parallel to the setup's XY plane: it cannot be cut from above`
            : loops.status === 'not-planar'
              ? `${target} is not planar: pick a flat face`
              : loops.message,
      });
      return;
    }
    const xDir = perpendicular(ctx.z);
    sources.push({
      source: i,
      kind: 'face',
      z: loops.height - ctx.originZ,
      facing: loops.facing,
      planar: {
        origin: scale(ctx.z, loops.height),
        xDir,
        normal: ctx.z,
        loops: [loops.outer, ...loops.holes].map(camLoop),
      },
    });
  }

  #regionSource(
    ctx: SetupContext,
    sketchId: string,
    entities: readonly string[] | undefined,
    i: number,
    sources: CamSourceResult[],
    errors: CamStageError[],
  ): void {
    const feature = ctx.build.part.features.find((f) => f.id === sketchId);
    if (feature === undefined) {
      errors.push({
        code: 'reference-lost',
        source: i,
        referenceId: 'sketch',
        missing: [sketchId],
        message: `${ctx.build.part.name} has no ${sketchId} any more: re-pick the region`,
      });
      return;
    }
    const sketch = ctx.build.sketches.get(sketchId);
    if (sketch === undefined) {
      const status = ctx.build.results.get(sketchId)?.status ?? 'rolled-back';
      errors.push({
        code: 'upstream',
        source: i,
        message: `${sketchId} ${status === 'suppressed' ? 'is suppressed' : status === 'rolled-back' ? 'is after the rollback bar' : 'failed'}: its regions cannot be cut`,
      });
      return;
    }
    const picked = selectRegions(sketch, entities);
    if (!picked.ok) {
      const e = picked.error as { missing?: string[] };
      errors.push({
        code: 'reference-lost',
        source: i,
        referenceId: 'entities',
        missing: e.missing ?? [],
        message: `The region uses ${(e.missing ?? []).join(', ')}, which ${sketchId} no longer has: re-pick it`,
      });
      return;
    }
    if (picked.regions.length === 0) {
      errors.push({
        code: 'invalid',
        source: i,
        message: `${sketchId} has no closed region${entities ? ' bounded by the chosen entities' : ''}`,
      });
      return;
    }
    const { placement } = sketch;
    const n = unit(placement.normal);
    if (Math.abs(dot(n, ctx.z)) < Math.cos(CAM_PARALLEL_TOLERANCE)) {
      errors.push({
        code: 'not-parallel',
        source: i,
        message: `${sketchId} is not parallel to the setup's XY plane: its regions cannot be cut from above`,
      });
      return;
    }
    sources.push({
      source: i,
      kind: 'region',
      z: dot(placement.origin, ctx.z) - ctx.originZ,
      planar: {
        origin: placement.origin,
        xDir: placement.xDir,
        normal: placement.normal,
        loops: regionLoops(picked.regions, sketchId),
      },
    });
  }

  #holeSource(
    ctx: SetupContext,
    holeId: string,
    i: number,
    sources: CamSourceResult[],
    errors: CamStageError[],
  ): void {
    const feature = ctx.build.part.features.find((f) => f.id === holeId);
    if (feature === undefined) {
      errors.push({
        code: 'reference-lost',
        source: i,
        referenceId: 'feature',
        missing: [holeId],
        message: `${ctx.build.part.name} has no ${holeId} any more: re-pick the holes`,
      });
      return;
    }
    const status = ctx.build.results.get(holeId)?.status ?? 'rolled-back';
    const input = ctx.build.inputs.get(holeId);
    if (status !== 'ok' || input === undefined || input.kind !== 'hole') {
      errors.push({
        code: 'upstream',
        source: i,
        message: `${holeId} ${status === 'suppressed' ? 'is suppressed' : status === 'rolled-back' ? 'is after the rollback bar' : 'failed'}: its holes cannot be drilled`,
      });
      return;
    }
    const hole = input as HoleInput;
    const n = unit(hole.frame.normal);
    const axis = hole.reverse ? n : scale(n, -1);
    if (dot(axis, ctx.z) > -Math.cos(CAM_PARALLEL_TOLERANCE)) {
      errors.push({
        code: 'not-parallel',
        source: i,
        message: `The axis of ${holeId} does not point down the setup's Z axis: it cannot be drilled from above`,
      });
      return;
    }
    const x = unit(hole.frame.xDir);
    const y = cross(n, x);
    const r = hole.diameter / 2;
    // Where the through-hole starts below the sketch plane: under the head.
    const head =
      hole.head.type === 'counterbore'
        ? hole.head.depth
        : hole.head.type === 'countersink'
          ? (hole.head.diameter / 2 - r) / Math.tan(hole.head.angle / 2)
          : 0;
    const bottomZ = ctx.bodyZ.bottom;
    const points = hole.points.map((p): CamDrillPoint => {
      const surface = add3(hole.frame.origin, add3(scale(x, p.at[0]), scale(y, p.at[1])));
      const position = add3(surface, scale(axis, head));
      const source: CamSourceTag = { kind: 'hole', feature: holeId };
      if (hole.extent.type === 'blind') {
        return { position, axis, diameter: hole.diameter, depth: hole.extent.depth - head, source };
      }
      // Through the whole body: to the body's bottom along the setup's Z.
      const top = dot(position, ctx.z) - ctx.originZ;
      return {
        position,
        axis,
        diameter: hole.diameter,
        depth: top - bottomZ,
        through: true,
        source,
      };
    });
    sources.push({ source: i, kind: 'hole', points });
  }

  // Kernel -------------------------------------------------------------------------------------

  /** Resolve every face source and its loops not yet cached, in two batches for the setup. */
  async #prefetchFaces(host: CamHost, ctx: SetupContext, setup: CamSetup): Promise<void> {
    const faces = setup.operations
      .filter((op) => !op.suppressed)
      .flatMap((op) => op.geometry.flatMap((g) => (g.kind === 'face' ? [g.face] : [])));
    const unresolved = [
      ...new Map(
        faces
          .filter((f) => this.#resolved.get(resolveKey(ctx.body, f)) === undefined)
          .map((f) => [f.ref.face, f]),
      ).values(),
    ];
    if (unresolved.length > 0) await this.#resolveMany(host, ctx.body, unresolved);
    const indices = new Set<number>();
    for (const f of faces) {
      const r = this.#resolved.get(resolveKey(ctx.body, f));
      if (r?.ok && this.#loops.get(loopsKey(ctx.body, r.index, ctx.z)) === undefined)
        indices.add(r.index);
    }
    if (indices.size > 0) await this.#loopsMany(host, ctx, [...indices]);
  }

  async #resolve(host: CamHost, body: CamBody, face: FaceReference): Promise<Resolved> {
    const key = resolveKey(body, face);
    const hit = this.#resolved.get(key);
    if (hit !== undefined) return withHint(hit, face);
    await this.#resolveMany(host, body, [face]);
    return withHint(this.#resolved.get(key)!, face);
  }

  async #resolveMany(host: CamHost, body: CamBody, faces: readonly FaceReference[]): Promise<void> {
    const results = await host.run(
      [{ op: 'resolve', shape: body.shape, refs: faces.map((f) => faceRef(f.ref)) }],
      [body],
    );
    this.stats.resolveOps++;
    const r = results[0]!;
    faces.forEach((face, j) => {
      const target = face.ref.face;
      let value: Resolved;
      if (!r.ok) {
        value = { ok: false, error: { code: 'kernel', target, message: r.error.message } };
      } else {
        const report = (r.value as { results: ReferenceReport[] }).results[j]!;
        if (report.ok) {
          const g = report.geometry;
          value = {
            ok: true,
            index: report.index,
            via: report.via,
            fragile: report.fragile,
            normal: g !== null && g.kind === 'plane' ? g.direction : null,
          };
        } else if (report.status === 'lost') {
          value = {
            ok: false,
            error: {
              code: 'reference-lost',
              referenceId: face.id,
              target,
              missing: [...report.missing],
              message: `${target} is lost: re-pick it`,
            },
          };
        } else if (report.status === 'ambiguous') {
          value = {
            ok: false,
            error: {
              code: 'reference-ambiguous',
              referenceId: face.id,
              target,
              candidates: [...report.candidates],
              message: `${target} is ambiguous: re-pick it`,
            },
          };
        } else {
          value = {
            ok: false,
            error: { code: 'no-body', referenceId: face.id, target, message: report.message },
          };
        }
      }
      this.#resolved.set(resolveKey(body, face), value);
    });
  }

  async #faceLoops(host: CamHost, ctx: SetupContext, index: number) {
    const key = loopsKey(ctx.body, index, ctx.z);
    const hit = this.#loops.get(key);
    if (hit !== undefined) return hit;
    await this.#loopsMany(host, ctx, [index]);
    return this.#loops.get(key)!;
  }

  async #loopsMany(host: CamHost, ctx: SetupContext, indices: readonly number[]): Promise<void> {
    const frame = { origin: [0, 0, 0] as Vec3, xDir: perpendicular(ctx.z), normal: ctx.z };
    const results = await host.run(
      indices.map((index): KernelOp => ({
        op: 'faceLoops',
        shape: ctx.body.shape,
        target: { index },
        frame,
        deflection: CAM_LOOP_DEFLECTION,
      })),
      [ctx.body],
    );
    this.stats.faceLoopsOps += indices.length;
    indices.forEach((index, j) => {
      const r = results[j]!;
      this.#loops.set(
        loopsKey(ctx.body, index, ctx.z),
        r.ok
          ? (r.value as FaceLoopsReport)
          : { ok: false, status: 'kernel', message: r.error.message },
      );
    });
  }

  /** The body's CAM mesh, tessellated once per body key; null when it has no triangles. */
  async #tessellate(host: CamHost, body: CamBody): Promise<CamMesh | null> {
    const cached = this.#meshes.get(body.key);
    if (cached !== undefined) return cached;
    const results = await host.run(
      [{ op: 'tessellate', shape: body.shape, deflection: { ...CAM_MESH_DEFLECTION } }],
      [body],
    );
    this.stats.tessellateOps++;
    const r = results[0]!;
    if (!r.ok) {
      // Not cached: the next request tries again.
      this.#failures.set(body.key, r.error.message);
      return null;
    }
    const mesh = r.value as MeshData;
    const out: CamMesh = { positions: mesh.positions, indices: mesh.indices };
    const p = mesh.positions;
    if (p.length >= 3) {
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c]!, p[i + c]!);
          max[c] = Math.max(max[c]!, p[i + c]!);
        }
      }
      this.#bounds.set(body.key, { min, max });
    }
    this.#meshes.set(body.key, out);
    return p.length >= 3 ? out : null;
  }

  async #boundsOf(host: CamHost, body: CamBody): Promise<CamBox | null> {
    const hit = this.#bounds.get(body.key);
    if (hit !== undefined) return hit;
    await this.#tessellate(host, body);
    return this.#bounds.get(body.key) ?? null;
  }

  /** A copy of the body's CAM mesh, for the caller to transfer. */
  async #mesh(host: CamHost, body: CamBody): Promise<CamMesh | undefined> {
    const mesh = await this.#tessellate(host, body);
    this.#failures.delete(body.key);
    return mesh === null
      ? undefined
      : { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
  }
}

const resolveKey = (body: CamBody, face: FaceReference): string => `${body.key}\n${face.ref.face}`;
const loopsKey = (body: CamBody, index: number, z: Vec3): string =>
  `${body.key}\n${index}\n${z.join(',')}`;

/** A cached resolution with the reference's own id and re-pick hint. */
function withHint(r: Resolved, face: FaceReference): Resolved {
  if (r.ok) return r;
  const hint = face.lastResolved;
  return {
    ok: false,
    error: {
      ...r.error,
      referenceId: face.id,
      ...(hint === undefined
        ? {}
        : { lastResolved: { point: hint.point, direction: hint.direction } }),
    },
  };
}

/** The buffers of a result's mesh, for `Comlink.transfer`. */
export function camTransferables(result: CamGeometryResult): ArrayBuffer[] {
  return result.mesh
    ? [result.mesh.positions.buffer as ArrayBuffer, result.mesh.indices.buffer as ArrayBuffer]
    : [];
}
