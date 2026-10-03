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
  camOperationTools,
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
  EdgeInfo,
  FaceInfo,
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
  Topology,
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
export const CAM_STAGE_VERSION = 3;

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

/**
 * The smallest 3D surfacing tolerance, drop-point sampling and slice cell, mm: what
 * `packages/cam`'s `generateSurface3d` accepts (the tolerance also at most 1 mm here: a coarser
 * one is a typing slip, not a finish).
 */
export const SURFACE3D_MIN_TOLERANCE = 1e-4;
export const SURFACE3D_MIN_SAMPLING = 1e-3;
export const SURFACE3D_MIN_SLICE_CELL = 0.01;

/**
 * The shallowest ramp or helix entry angle, radians (half a degree): `packages/cam`'s
 * `ENTRY_MIN_ANGLE`. A ramp's length and a helix's turns grow as 1 / tan(angle), so a vanishing
 * angle would ask for millions of moves.
 */
export const CAM_MIN_ENTRY_ANGLE = (0.5 * Math.PI) / 180;

/**
 * The most tabs a profile may ask for on one loop: `packages/cam`'s `PROFILE_MAX_TABS`. Far
 * above any real part; a larger count is a typing slip, and each tab costs work on every pass.
 */
export const CAM_MAX_TABS = 1000;

/**
 * The most pecks one hole may take: `packages/cam`'s `DRILL_MAX_PECKS`. A peck depth so small that
 * a hole needs more is refused here, measured over the hole's own depth; the generator checks it
 * again from the stock top, breakthrough included.
 */
export const CAM_DRILL_MAX_PECKS = 10000;

/**
 * The smallest tool diameter CAM accepts, mm. The finest micro end mills are about 0.1 mm; a
 * tool far below that makes rings, helix turns and passes without end (each operation's move
 * budget in `packages/cam` refuses what is left).
 */
export const CAM_MIN_TOOL_DIAMETER = 0.01;

/** An entry angle CAM accepts: at least `CAM_MIN_ENTRY_ANGLE` and at most 90 degrees. */
const entryAngleOk = (angle: number): boolean =>
  Number.isFinite(angle) && angle >= CAM_MIN_ENTRY_ANGLE - 1e-12 && angle <= Math.PI / 2;

/** Source heights further apart than this (mm) are reported as a `heights` warning. */
const HEIGHT_TOLERANCE = 1e-6;

/** Hole walls: axes and radii this close (mm) are one hole, Z ends this close one height. */
export const CAM_HOLE_TOLERANCE = 1e-4;

/**
 * A round hole's wall faces must go at least this fraction of the way round its axis at some
 * height (measured from the lengths of their end edges, so a sloped or chamfered mouth still
 * counts as whole): less is a slot's rounded end, a concave fillet or a hole cut open at the
 * part's edge.
 */
export const CAM_HOLE_MIN_COVER = 0.98;

/**
 * A plane at a hole's mouth faces up, and lets the tool in, when its normal is within this angle
 * (radians, 89 degrees) of the setup's +Z: anything short of a vertical or overhanging face.
 */
export const CAM_HOLE_MAX_MOUTH_TILT = (89 * Math.PI) / 180;

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
  /**
   * For a through hole whose exit opens onto material further down (a cavity's floor): the clear
   * height below the exit, mm, which a breakthrough must not exceed. Absent: nothing below.
   */
  readonly clearBelow?: number;
  /** How far the mouth's surface is tilted from square to the axis, radians; absent: square. */
  readonly entryTilt?: number;
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
      /** `packages/cam`'s `PocketExtras`, each absent for the generator's default. */
      readonly finishPass?: boolean;
      readonly finishStepdown?: number;
      readonly floorAllowance?: number;
      readonly floorPass?: boolean;
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
      /** `packages/cam`'s `VCarveExtras`, each absent for the generator's default. */
      readonly stepdown?: number;
      readonly flatStepover?: number;
      readonly clearing?: CamVCarveClearingValues;
    })
  | (OperationValuesBase & {
      readonly kind: 'surface3d';
      readonly stepover: number;
      readonly angle: number;
      readonly allowance: number;
      /** `packages/cam`'s `Surface3dExtras` (the boundary comes from the sources), each optional. */
      readonly strategy?: 'parallel' | 'zlevel';
      readonly tolerance?: number;
      readonly sampling?: number;
      readonly pattern?: 'zigzag' | 'oneway';
      readonly stepdown?: number;
      readonly entry?: CamEntryValues;
      readonly climb?: boolean;
      readonly sliceCell?: number;
    });

/** A V-carve's floor clearing: its end mill, feeds and steps, evaluated (`VCarveClearing`). */
export interface CamVCarveClearingValues {
  readonly tool: CamToolValues;
  readonly feeds: CamFeedValues;
  readonly stepdown: number;
  /** Fraction of the clearing tool's diameter. */
  readonly stepover: number;
  readonly entry?: CamEntryValues;
}

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
  | 'source-errors'
  /**
   * A drill with no geometry found round walls it does not drill: closed above (not reachable
   * from this setup), an undercut below a narrower hole, or a wall in pieces that is not whole.
   */
  | 'holes'
  /** For information: the wider steps of a stepped hole (a counterbore) that are left to a pocket. */
  | 'hole-steps'
  /** A V-carve's clearing tool with no maximum depth: there may be no flat floor to clear. */
  | 'clearing';

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
  | { readonly source: number; readonly kind: 'hole'; readonly points: readonly CamDrillPoint[] }
  | {
      /** No geometry source: found on the body (`holeWallPoints`), for a drill with none picked. */
      readonly source: 'body';
      readonly kind: 'holeWalls';
      readonly points: readonly CamDrillPoint[];
    };

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
  /** `topology` ops sent (hole walls for drills with no geometry). */
  topologyOps: number;
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
  /** Bodies whose topology (for a drill's hole walls) is kept. */
  topology?: number;
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
  const diameter = get('diameter');
  if (diameter !== undefined && positive(diameter)) {
    check(
      errors,
      diameter >= CAM_MIN_TOOL_DIAMETER,
      ['tool', 'diameter'],
      `${tool.id}: the diameter must be at least ${CAM_MIN_TOOL_DIAMETER} mm`,
    );
  }
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
  // Faces and regions bound a 3D surfacing in XY (none: the default boundary).
  surface3d: ['face', 'region'],
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
  readonly stats: CamStats = {
    tessellateOps: 0,
    resolveOps: 0,
    faceLoopsOps: 0,
    topologyOps: 0,
    resultHits: 0,
  };
  readonly #bounds: Lru<CamBox>;
  readonly #meshes: Lru<CamMesh>;
  readonly #resolved: Lru<Resolved>;
  readonly #loops: Lru<FaceLoopsReport | { ok: false; status: 'kernel'; message: string }>;
  readonly #topology: Lru<Topology | { message: string }>;
  readonly #results: Lru<Omit<CamGeometryResult, 'generation' | 'mesh' | 'cached' | 'ms'>>;
  /** Why the last tessellation of a body key failed, until the caller reads it (never cached). */
  readonly #failures = new Map<string, string>();

  constructor(sizes: CamStageSizes = {}) {
    this.#bounds = new Lru(sizes.bounds ?? 256);
    this.#meshes = new Lru(sizes.meshes ?? 4);
    this.#resolved = new Lru(sizes.faces ?? 1024);
    this.#loops = new Lru(sizes.faces ?? 1024);
    this.#topology = new Lru(sizes.topology ?? 64);
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
      tools: [...new Set(setup.operations.flatMap(camOperationTools))].map(
        (id) => tools.get(id) ?? id,
      ),
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
        ...(op.kind === 'vcarve' && op.clearing
          ? { clearingTool: tools.get(op.clearing.tool) ?? op.clearing.tool }
          : {}),
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
    // A drill with nothing picked drills every round hole of the body along the setup's Z.
    if (op.kind === 'drill' && op.geometry.length === 0) {
      await this.#holeWallsSource(host, ctx, op.id, sources, errors, warnings);
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
    const heights = sources.flatMap((s) =>
      s.kind === 'hole' || s.kind === 'holeWalls' ? [] : [s.z],
    );
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
    const entryOf = (e: CamEntry, at: readonly string[] = []): CamEntryValues => {
      if (e.kind === 'plunge') return { kind: 'plunge' };
      const angle = get(...at, 'entry', 'angle')!;
      check(
        errors,
        entryAngleOk(angle),
        [...at, 'entry', 'angle'],
        'The entry angle must be at least 0.5 and at most 90 degrees',
      );
      if (e.kind === 'ramp') return { kind: 'ramp', angle };
      const radius = get(...at, 'entry', 'radius')!;
      check(
        errors,
        positive(radius),
        [...at, 'entry', 'radius'],
        'The helix radius must be greater than zero',
      );
      return { kind: 'helix', angle, radius };
    };
    /** An optional length that must be greater than zero (or zero or more). */
    const optionalLength = (k: string, what: string, zero = false): number | undefined => {
      const v = get(k);
      if (v !== undefined) {
        check(
          errors,
          zero ? nonNegative(v) : positive(v),
          [k],
          `The ${what} must be ${zero ? 'zero or more' : 'greater than zero'}`,
        );
      }
      return v;
    };
    /** `o` without its undefined fields (the values type has exact optional fields). */
    const defined = <T extends Record<string, unknown>>(
      o: T,
    ): { [K in keyof T]?: Exclude<T[K], undefined> } =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
        [K in keyof T]?: Exclude<T[K], undefined>;
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
            !(tabs.count > CAM_MAX_TABS),
            ['tabs', 'count'],
            `The tab count must be at most ${CAM_MAX_TABS}`,
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
        const finishStepdown = optionalLength('finishStepdown', 'finishing stepdown');
        const floorAllowance = optionalLength('floorAllowance', 'floor allowance', true);
        if (floorAllowance !== undefined) {
          check(
            errors,
            floorAllowance < depth.top - depth.bottom,
            ['floorAllowance'],
            'The floor allowance must be less than the pocket depth',
          );
        }
        values = {
          ...head,
          kind: 'pocket',
          depth,
          stepdown,
          stepover,
          finishAllowance,
          entry: entryOf(op.entry),
          climb: op.climb,
          ...defined({
            finishPass: op.finishPass,
            finishStepdown,
            floorAllowance,
            floorPass: op.floorPass,
          }),
        };
        break;
      }
      case 'drill': {
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
          // A depth past a hole's modelled bottom or exit, where material lies (a blind hole's
          // floor, a cavity's floor under a through hole's exit), cuts it: warn, naming them.
          const deeper: string[] = [];
          for (const [j, s] of sources.entries()) {
            if (s.kind !== 'hole' && s.kind !== 'holeWalls') continue;
            sources[j] = {
              ...s,
              points: s.points.map((p) => {
                // The modelled clear height under the exit no longer applies to the new depth.
                const { through: _t, clearBelow: _c, ...rest } = p;
                void _t;
                void _c;
                const top = dot(p.position, ctx.z) - ctx.originZ;
                const next =
                  blind !== undefined
                    ? { ...rest, depth: blind }
                    : { ...rest, depth: top - (ctx.values.stockZ.bottom - extra), through: true };
                const solidBelow = p.through !== true || p.clearBelow !== undefined;
                if (solidBelow && (next.depth > p.depth + HEIGHT_TOLERANCE || 'through' in next)) {
                  const at = p.position.map((v) => String(Math.round(v * 1000) / 1000 + 0));
                  deeper.push(`(${at.join(', ')})`);
                }
                return next;
              }),
            };
          }
          if (deeper.length > 0) {
            warnings.push({
              code: 'holes',
              message: `The operation's depth goes past the modelled bottom or exit of ${deeper.length === 1 ? 'the hole' : `${deeper.length} holes`} at ${deeper.join(', ')} and cuts the material below ${deeper.length === 1 ? 'it' : 'them'}`,
            });
          }
        }
        if (peck !== undefined && positive(peck)) {
          let deepest = 0;
          for (const src of sources) {
            if (src.kind !== 'hole' && src.kind !== 'holeWalls') continue;
            for (const pt of src.points) if (pt.depth > deepest) deepest = pt.depth;
          }
          const pecks = Math.ceil(deepest / peck);
          check(
            errors,
            pecks <= CAM_DRILL_MAX_PECKS,
            ['peck'],
            `The peck depth is too small: the deepest hole (${Math.round(deepest * 1000) / 1000} mm) would take ${pecks} pecks, and at most ${CAM_DRILL_MAX_PECKS} are allowed`,
          );
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
        const stepdown = optionalLength('stepdown', 'stepdown');
        const flatStepover = optionalLength('flatStepover', 'floor stepover');
        let clearing: CamVCarveClearingValues | undefined;
        if (op.clearing !== undefined) {
          clearing = this.#clearing(op.clearing, tools, material, host.variables, get, errors);
          if (clearing && maxDepth === undefined) {
            warnings.push({
              code: 'clearing',
              message: `${op.id} has a clearing tool but no maximum depth: a V-carve has a flat floor to clear only where the maximum depth (or the bit's size) stops it`,
            });
          }
        }
        values = {
          ...head,
          kind: 'vcarve',
          top: geometryTop,
          ...defined({ maxDepth, stepdown, flatStepover, clearing }),
        };
        break;
      }
      case 'surface3d': {
        const stepover = get('stepover')!;
        check(errors, positive(stepover), ['stepover'], 'The stepover must be greater than zero');
        check(
          errors,
          !(stepover > tool.tool.diameter),
          ['stepover'],
          'The stepover must be at most the tool diameter',
        );
        const allowance = get('allowance') ?? 0;
        check(errors, nonNegative(allowance), ['allowance'], 'The allowance must be zero or more');
        const tolerance = get('tolerance');
        if (tolerance !== undefined) {
          check(
            errors,
            Number.isFinite(tolerance) && tolerance >= SURFACE3D_MIN_TOLERANCE && tolerance <= 1,
            ['tolerance'],
            `The tolerance must be at least ${SURFACE3D_MIN_TOLERANCE} mm and at most 1 mm`,
          );
        }
        const sampling = get('sampling');
        if (sampling !== undefined) {
          check(
            errors,
            Number.isFinite(sampling) && sampling >= SURFACE3D_MIN_SAMPLING,
            ['sampling'],
            `The sampling must be at least ${SURFACE3D_MIN_SAMPLING} mm`,
          );
        }
        const sliceCell = get('sliceCell');
        if (sliceCell !== undefined) {
          check(
            errors,
            Number.isFinite(sliceCell) && sliceCell >= SURFACE3D_MIN_SLICE_CELL,
            ['sliceCell'],
            `The slice cell must be at least ${SURFACE3D_MIN_SLICE_CELL} mm`,
          );
        }
        const stepdown = optionalLength('stepdown', 'stepdown');
        values = {
          ...head,
          kind: 'surface3d',
          stepover,
          angle: get('angle')!,
          allowance,
          ...defined({
            strategy: op.strategy,
            tolerance,
            sampling,
            pattern: op.pattern,
            stepdown,
            entry: op.entry ? entryOf(op.entry) : undefined,
            climb: op.climb,
            sliceCell,
          }),
        };
        break;
      }
    }
    return out(values);
  }

  /**
   * A V-carve's floor clearing: its end mill (a flat or bull tool), the feeds from the operation's
   * overrides or that tool's preset for the stock's material, and the steps, at `clearing.*`.
   * Null (with errors) when it does not evaluate.
   */
  #clearing(
    c: NonNullable<Extract<CamOperation, { kind: 'vcarve' }>['clearing']>,
    tools: ReadonlyMap<string, CamTool>,
    material: string | undefined,
    variables: VariableValues,
    get: (...path: (string | number)[]) => number | undefined,
    errors: CamStageError[],
  ): CamVCarveClearingValues | undefined {
    const def = tools.get(c.tool);
    if (def === undefined) {
      errors.push({
        code: 'invalid',
        field: ['clearing', 'tool'],
        message: `The document has no tool ${c.tool}`,
      });
      return undefined;
    }
    if (def.kind !== 'flat' && def.kind !== 'bull') {
      errors.push({
        code: 'invalid',
        field: ['clearing', 'tool'],
        message: `The clearing tool must be a flat or bull end mill, not a ${def.kind} tool`,
      });
      return undefined;
    }
    const evaluated = evaluateTool(def, material, variables);
    errors.push(
      ...evaluated.errors.map((e) => ({
        ...e,
        ...(e.field ? { field: ['clearing', ...e.field] } : {}),
      })),
    );
    if (evaluated.tool === null) return undefined;
    const preset = evaluated.preset;
    const noPreset =
      material === undefined
        ? 'the stock has no material'
        : `${def.id} has no preset for ${material}`;
    let ok = true;
    const value = (
      path: readonly string[],
      from: number | undefined,
      what: string,
      valid: (v: number) => boolean,
      rule: string,
    ): number => {
      const v = get(...path) ?? from;
      if (v === undefined) {
        errors.push({
          code: 'feeds',
          field: [...path],
          message: `No ${what} for the clearing: set one on the operation (${noPreset})`,
        });
        ok = false;
        return 0;
      }
      if (!valid(v)) {
        errors.push({ code: 'invalid', field: [...path], message: `The clearing ${what} ${rule}` });
        ok = false;
      }
      return v;
    };
    const above = (v: number) => positive(v);
    const gt0 = 'must be greater than zero';
    const spindle = value(
      ['clearing', 'feeds', 'spindle'],
      preset?.spindle,
      'spindle speed',
      above,
      gt0,
    );
    const cut = value(['clearing', 'feeds', 'cut'], preset?.feed, 'cutting feed', above, gt0);
    const plunge = value(
      ['clearing', 'feeds', 'plunge'],
      preset?.plunge,
      'plunge feed',
      above,
      gt0,
    );
    const ramp = get('clearing', 'feeds', 'ramp');
    const lead = get('clearing', 'feeds', 'lead');
    for (const [k, v] of [
      ['ramp', ramp],
      ['lead', lead],
    ] as const) {
      if (v !== undefined && !positive(v)) {
        errors.push({
          code: 'invalid',
          field: ['clearing', 'feeds', k],
          message: `The clearing ${k} feed ${gt0}`,
        });
        ok = false;
      }
    }
    const stepdown = value(['clearing', 'stepdown'], preset?.stepdown, 'stepdown', above, gt0);
    const stepover = value(
      ['clearing', 'stepover'],
      preset?.stepover,
      'stepover',
      (v) => positive(v) && v <= 1,
      'must be a fraction of the tool diameter, more than 0 and at most 1',
    );
    let entry: CamEntryValues | undefined;
    if (c.entry !== undefined && c.entry.kind !== 'plunge') {
      const angle = get('clearing', 'entry', 'angle')!;
      if (!entryAngleOk(angle)) {
        errors.push({
          code: 'invalid',
          field: ['clearing', 'entry', 'angle'],
          message: 'The clearing entry angle must be at least 0.5 and at most 90 degrees',
        });
        ok = false;
      }
      if (c.entry.kind === 'ramp') entry = { kind: 'ramp', angle };
      else {
        const radius = get('clearing', 'entry', 'radius')!;
        if (!positive(radius)) {
          errors.push({
            code: 'invalid',
            field: ['clearing', 'entry', 'radius'],
            message: `The clearing helix radius ${gt0}`,
          });
          ok = false;
        }
        entry = { kind: 'helix', angle, radius };
      }
    } else if (c.entry !== undefined) {
      entry = { kind: 'plunge' };
    }
    if (!ok) return undefined;
    return {
      tool: evaluated.tool,
      feeds: {
        spindle,
        cut,
        plunge,
        ...(ramp === undefined ? {} : { ramp }),
        ...(lead === undefined ? {} : { lead }),
      },
      stepdown,
      stepover,
      ...(entry === undefined ? {} : { entry }),
    };
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

  /** Every round hole of the body along the setup's Z, from its topology (cached by body key). */
  async #holeWallsSource(
    host: CamHost,
    ctx: SetupContext,
    opId: string,
    sources: CamSourceResult[],
    errors: CamStageError[],
    warnings: CamStageWarning[],
  ): Promise<void> {
    let topology = this.#topology.get(ctx.body.key);
    if (topology === undefined) {
      const results = await host.run([{ op: 'topology', shape: ctx.body.shape }], [ctx.body]);
      this.stats.topologyOps++;
      const r = results[0]!;
      topology = r.ok ? (r.value as Topology) : { message: r.error.message };
      // A kernel failure may not repeat: not cached.
      if (r.ok) this.#topology.set(ctx.body.key, topology);
    }
    if ('message' in topology) {
      errors.push({
        code: 'kernel',
        message: `Reading the holes of ${ctx.body.id} failed: ${topology.message}`,
      });
      return;
    }
    const mesh = await this.#tessellate(host, ctx.body);
    this.#failures.delete(ctx.body.key);
    if (mesh === null || mesh.indices.length === 0) {
      // Without the mesh the column above each hole cannot be checked: fail closed.
      errors.push({
        code: 'kernel',
        message: `${opId} drills nothing: the CAM mesh of ${ctx.body.id} is not available, so the material above its holes cannot be checked; pick hole features instead`,
      });
      return;
    }
    const found = holeWallPoints(topology, ctx.z, ctx.originZ, ctx.bodyZ.bottom, mesh);
    for (const message of found.warnings) warnings.push({ code: 'holes', message });
    for (const message of found.notes) warnings.push({ code: 'hole-steps', message });
    const points = found.points;
    if (points.length === 0) {
      errors.push({
        code: 'invalid',
        field: ['geometry'],
        message: `${opId} has no holes: ${ctx.body.id} has no round hole along the setup's Z axis; pick a hole feature`,
      });
      return;
    }
    sources.push({ source: 'body', kind: 'holeWalls', points });
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

// ---------------------------------------------------------------------------------------------
// Hole walls

/** What `holeWallPoints` found. */
export interface HoleWalls {
  readonly points: readonly CamDrillPoint[];
  /** Why round walls are not drilled, or are drilled with a limit. */
  readonly warnings: readonly string[];
  /** For information: the steps of stepped holes left to a pocket. */
  readonly notes: readonly string[];
}

/** Rays against the mesh start this far past the hole's end, mm (the mesh is single precision). */
const HOLE_RAY_START = 1e-3;

/** The column tested above and below a hole is this much narrower than the hole, mm. */
const HOLE_COLUMN_INSET = 0.05;

/** The mesh is binned into at most this many cells along each side for the column checks. */
const HOLE_GRID = 64;

/**
 * The body's mesh projected once along `z` and binned in a coarse grid over its XY extent, for
 * the column checks: `facets(centre, r)` is the machine Z range (low, high, and the facet plane's
 * highest point over the disk, at most high) of every facet whose projection
 * overlaps the disk about the hole's axis just inside its wall (radius `r` less
 * `HOLE_COLUMN_INSET`, at least half of `r`), so the wall's own facets never count. The test is
 * exact (the centre inside the triangle, a vertex inside the disk, or an edge within the radius of
 * the centre), so a rib of any width across the column is found. Facets along the axis (vertical
 * walls) project to nothing and are left out.
 */
function meshColumns(
  mesh: CamMesh,
  frame: { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3; readonly originZ: number },
): (centre: Vec3, r: number) => [number, number, number][] {
  const { x, y, z, originZ } = frame;
  const P = mesh.positions;
  const I = mesh.indices;
  const n = P.length / 3;
  const U = new Float64Array(n);
  const V = new Float64Array(n);
  const W = new Float64Array(n);
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];
    U[i] = dot(p, x);
    V[i] = dot(p, y);
    W[i] = dot(p, z) - originZ;
    u0 = Math.min(u0, U[i]!);
    v0 = Math.min(v0, V[i]!);
    u1 = Math.max(u1, U[i]!);
    v1 = Math.max(v1, V[i]!);
  }
  const size = Math.max(u1 - u0, v1 - v0, 1e-6) / HOLE_GRID;
  const cols = Math.max(1, Math.ceil((u1 - u0) / size) + 1);
  const rows = Math.max(1, Math.ceil((v1 - v0) / size) + 1);
  const cell = (value: number, origin: number, count: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((value - origin) / size)));
  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t]!;
    const b = I[t + 1]!;
    const c = I[t + 2]!;
    const det = (U[b]! - U[a]!) * (V[c]! - V[a]!) - (U[c]! - U[a]!) * (V[b]! - V[a]!);
    if (Math.abs(det) < 1e-12) continue;
    const ia = cell(Math.min(U[a]!, U[b]!, U[c]!), u0, cols);
    const ib = cell(Math.max(U[a]!, U[b]!, U[c]!), u0, cols);
    const ja = cell(Math.min(V[a]!, V[b]!, V[c]!), v0, rows);
    const jb = cell(Math.max(V[a]!, V[b]!, V[c]!), v0, rows);
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) grid[j * cols + i]!.push(t);
  }
  /** Distance from (pu, pv) to the segment from vertex a to vertex b, projected. */
  const toEdge = (pu: number, pv: number, a: number, b: number): number => {
    const du = U[b]! - U[a]!;
    const dv = V[b]! - V[a]!;
    const l2 = du * du + dv * dv;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((pu - U[a]!) * du + (pv - V[a]!) * dv) / l2)) : 0;
    return Math.hypot(pu - U[a]! - t * du, pv - V[a]! - t * dv);
  };
  return (centre, r) => {
    const cu = dot(centre, x);
    const cv = dot(centre, y);
    const disk = Math.max(r - HOLE_COLUMN_INSET, r / 2);
    const seen = new Set<number>();
    const out: [number, number, number][] = [];
    for (let j = cell(cv - r, v0, rows); j <= cell(cv + r, v0, rows); j++) {
      for (let i = cell(cu - r, u0, cols); i <= cell(cu + r, u0, cols); i++) {
        for (const t of grid[j * cols + i]!) {
          if (seen.has(t)) continue;
          seen.add(t);
          const a = I[t]!;
          const b = I[t + 1]!;
          const c = I[t + 2]!;
          const det = (U[b]! - U[a]!) * (V[c]! - V[a]!) - (U[c]! - U[a]!) * (V[b]! - V[a]!);
          const l1 = ((cu - U[a]!) * (V[c]! - V[a]!) - (U[c]! - U[a]!) * (cv - V[a]!)) / det;
          const l2 = ((U[b]! - U[a]!) * (cv - V[a]!) - (cu - U[a]!) * (V[b]! - V[a]!)) / det;
          const inside = l1 >= 0 && l2 >= 0 && l1 + l2 <= 1;
          const overlaps =
            inside ||
            toEdge(cu, cv, a, b) < disk ||
            toEdge(cu, cv, b, c) < disk ||
            toEdge(cu, cv, c, a) < disk;
          if (!overlaps) continue;
          // The facet plane's highest point over the disk: its Z at the centre plus its slope
          // times the disk's radius, never above its highest vertex.
          const wb = W[b]! - W[a]!;
          const wc = W[c]! - W[a]!;
          const du = (wb * (V[c]! - V[a]!) - wc * (V[b]! - V[a]!)) / det;
          const dv = ((U[b]! - U[a]!) * wc - (U[c]! - U[a]!) * wb) / det;
          const high = Math.max(W[a]!, W[b]!, W[c]!);
          const overDisk = W[a]! + l1 * wb + l2 * wc + Math.hypot(du, dv) * disk;
          out.push([Math.min(W[a]!, W[b]!, W[c]!), high, Math.min(high, overDisk)]);
        }
      }
    }
    return out;
  };
}

/**
 * The round holes of a body that a drill can reach down the setup's Z (`z`, unit, model
 * coordinates), from its topology: cylinder faces with the material outside (`FaceInfo.hole`)
 * along `z`, grouped by axis and radius (a wall split in several faces, such as the two halves a
 * two-arc circle makes, is one hole). Round walls along another direction are counted in one
 * warning.
 *
 * - **Whole.** At some height the group's faces must go at least `CAM_HOLE_MIN_COVER` of the way
 *   round, each face's share measured from its end edges (a face with a seam goes all the way), and
 *   their Z ranges must leave no gap. A single partial face (a slot's rounded end, a concave
 *   fillet, a hole cut open at the edge) is dropped silently; several faces that are not whole
 *   (same-radius walls with a gap between them) are dropped with a warning.
 * - **Open above.** Each face meeting a top edge of the hole's walls, other than the hole's own
 *   faces, must let the tool in: a plane facing up (within `CAM_HOLE_MAX_MOUTH_TILT`: the top
 *   face, a sloped top, a pocket or counterbore floor), a cone or torus widening above the mouth
 *   (a countersink, a chamfer, a fillet) or a wider coaxial hole wall. A downward plane (a hole
 *   opening on the bottom face, an internal void, the wide part of an undercut) or a narrowing
 *   cone (a drill point) closes it; any other surface leaves its top unclassified. Both are
 *   skipped with a warning naming the hole. Against the body's `mesh`, the column above the mouth
 *   up to the body's top must also be clear (no facet overlapping the disk just inside the wall
 *   reaches above the mouth): a hole in a floor under overhanging material, however thin, is
 *   skipped with a warning.
 * - **Narrowest.** Of coaxial walls of different radii only the narrowest is drilled. A wider wall
 *   above it (a counterbore) is left to a pocket, in `notes`; one below it is an undercut and gets
 *   a warning.
 * - **Through.** A hole is `through` when every face meeting its walls' bottom edges is a plane
 *   facing down (within `CAM_HOLE_MAX_MOUTH_TILT` of -Z), or when it reaches the body's bottom
 *   (`bodyBottom`, machine Z). Material in the mesh under the exit (a cavity's floor) sets
 *   `clearBelow`, the clear height there.
 *
 * Each point's `position` is on the axis at the wall's top, `axis` is `-z`, `entryTilt` the
 * largest tilt of an upward plane at the mouth when above zero; `originZ` is the setup-frame Z of
 * the machine origin. Points in face order.
 */
export function holeWallPoints(
  topology: Topology,
  z: Vec3,
  originZ: number,
  bodyBottom: number,
  mesh: CamMesh,
): HoleWalls {
  const tol = CAM_HOLE_TOLERANCE;
  const machineZ = (p: Vec3) => dot(p, z) - originZ;
  const onAxis = (p: Vec3) => add3(p, scale(z, -dot(p, z)));
  const faces = new Map(topology.faces.map((f) => [f.index, f]));
  const vertexAt = new Map(topology.vertices.map((v) => [v.index, v.point]));
  const edgesByFace = new Map<number, EdgeInfo[]>();
  for (const e of topology.edges) {
    for (const f of e.faces) {
      const list = edgesByFace.get(f);
      if (list === undefined) edgesByFace.set(f, [e]);
      else list.push(e);
    }
  }
  const edgesOf = (face: number): readonly EdgeInfo[] => edgesByFace.get(face) ?? [];
  /** An edge's vertices and its midpoint. */
  const pointsOf = (e: EdgeInfo): Vec3[] => [
    ...e.vertices.flatMap((v) => {
      const p = vertexAt.get(v);
      return p === undefined ? [] : [p];
    }),
    e.midpoint,
  ];
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000 + 0);
  const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
  const radialOf = (axisAt: Vec3, p: Vec3) => {
    const d = onAxis(p);
    return Math.hypot(d[0] - axisAt[0], d[1] - axisAt[1], d[2] - axisAt[2]);
  };
  const roundWall = (f: FaceInfo): boolean =>
    f.surface === 'cylinder' &&
    f.hole === true &&
    f.axis !== null &&
    f.radius !== null &&
    f.radius > 0 &&
    f.axisOrigin !== undefined &&
    f.axisOrigin !== null;
  const alongZ = (f: FaceInfo): boolean =>
    Math.abs(dot(unit(f.axis!), z)) >= Math.cos(CAM_PARALLEL_TOLERANCE);
  const holeAxis = (f: FaceInfo): Vec3 | null =>
    roundWall(f) && alongZ(f) ? onAxis(f.axisOrigin!) : null;
  const sameHole = (n: FaceInfo, axisAt: Vec3, r: number): boolean => {
    const other = holeAxis(n);
    return other !== null && near(other, axisAt) && Math.abs(n.radius! - r) <= tol;
  };
  const upCos = Math.cos(CAM_HOLE_MAX_MOUTH_TILT);

  /** What face `n`, just above the mouth of a wall about `axisAt` of radius `r` at `top`, makes of it. */
  type Mouth = 'open' | 'closed' | 'unknown';
  const mouthOf = (n: FaceInfo, axisAt: Vec3, r: number, top: number): Mouth => {
    if (n.surface === 'plane') {
      if (n.normal === null) return 'unknown';
      return dot(unit(n.normal), z) > upCos ? 'open' : 'closed';
    }
    if (n.surface === 'cone' || n.surface === 'torus') {
      // A countersink, chamfer or fillet widens above the mouth; a drill point's cone narrows.
      const widens = edgesOf(n.index).some((e) =>
        pointsOf(e).some((p) => machineZ(p) > top + tol && radialOf(axisAt, p) > r + tol),
      );
      return widens ? 'open' : 'closed';
    }
    if (n.surface === 'cylinder') {
      const other = holeAxis(n);
      return other !== null && near(other, axisAt) && n.radius! > r + tol ? 'open' : 'closed';
    }
    return 'unknown';
  };

  interface Wall {
    face: number;
    /** The axis's point at setup-frame Z 0 along `z`. */
    axisAt: Vec3;
    radius: number;
    top: number;
    bottom: number;
    /** How far round the axis the face goes, 0 to 1. */
    share: number;
    /** What the faces above its top edges (not the hole's own) make of it; null: none. */
    mouth: Mouth | null;
    /** The surfaces that left its mouth unclassified. */
    unknown: string[];
    /** The largest tilt of an upward plane at its mouth, radians. */
    tilt: number;
    /** Whether every face under its bottom edges (not the hole's own) faces down; null: none. */
    exitDown: boolean | null;
  }
  const walls: Wall[] = [];
  let across = 0;
  for (const f of topology.faces) {
    if (roundWall(f) && !alongZ(f)) across++;
    const axisAt = holeAxis(f);
    if (axisAt === null) continue;
    const r = f.radius!;
    const edges = edgesOf(f.index);
    const zs = edges.flatMap((e) => pointsOf(e).map(machineZ));
    if (zs.length === 0) continue;
    const top = Math.max(...zs);
    const bottom = Math.min(...zs);
    if (!(top - bottom > tol)) continue;
    const mid = (top + bottom) / 2;
    // End edges: not seams, not the lines along the axis between the pieces of a split wall, and
    // wholly above (or below) the wall's middle.
    const ends = edges.filter((e) => !e.seam && e.curve !== 'line');
    const tops = ends.filter((e) => pointsOf(e).every((p) => machineZ(p) > mid + tol));
    const bottoms = ends.filter((e) => pointsOf(e).every((p) => machineZ(p) < mid - tol));
    const turn = 2 * Math.PI * r;
    const shares = [tops, bottoms]
      .filter((list) => list.length > 0)
      .map((list) => list.reduce((sum, e) => sum + e.length, 0) / turn);
    const share = edges.some((e) => e.seam)
      ? 1
      : shares.length > 0
        ? Math.min(1, ...shares)
        : f.area / (turn * (top - bottom));
    /** The faces across `list` from this wall, not the hole's own; undefined for a missing one. */
    const across_ = (list: readonly EdgeInfo[]) =>
      list.flatMap((e) =>
        e.faces
          .filter((i) => i !== f.index)
          .map((i) => faces.get(i) ?? i)
          .filter((n) => typeof n === 'number' || !sameHole(n, axisAt, r)),
      );
    const mouths: Mouth[] = [];
    const unknown: string[] = [];
    let tilt = 0;
    for (const n of across_(tops)) {
      if (typeof n === 'number') {
        mouths.push('unknown');
        unknown.push(`#${n}`);
        continue;
      }
      const m = mouthOf(n, axisAt, r, top);
      mouths.push(m);
      if (m === 'unknown') unknown.push(`a ${n.surface} face #${n.index}`);
      if (m === 'open' && n.surface === 'plane') {
        tilt = Math.max(tilt, Math.acos(Math.min(1, dot(unit(n.normal!), z))));
      }
    }
    const mouth: Mouth | null =
      mouths.length === 0
        ? null
        : mouths.includes('closed')
          ? 'closed'
          : mouths.includes('unknown')
            ? 'unknown'
            : 'open';
    const below = across_(bottoms);
    const exitDown =
      below.length === 0
        ? null
        : below.every(
            (n) =>
              typeof n !== 'number' &&
              n.surface === 'plane' &&
              n.normal !== null &&
              dot(unit(n.normal), z) < -upCos,
          );
    walls.push({
      face: f.index,
      axisAt,
      radius: r,
      top,
      bottom,
      share,
      mouth,
      unknown,
      tilt,
      exitDown,
    });
  }

  interface Hole {
    walls: Wall[];
    axisAt: Vec3;
    radius: number;
    top: number;
    bottom: number;
  }
  const holes: Hole[] = [];
  for (const w of walls) {
    const h = holes.find((x) => near(x.axisAt, w.axisAt) && Math.abs(x.radius - w.radius) <= tol);
    if (h === undefined) {
      holes.push({ walls: [w], axisAt: w.axisAt, radius: w.radius, top: w.top, bottom: w.bottom });
    } else {
      h.walls.push(w);
      h.top = Math.max(h.top, w.top);
      h.bottom = Math.min(h.bottom, w.bottom);
    }
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  if (across > 0) {
    warnings.push(
      `${across === 1 ? '1 round wall is' : `${across} round walls are`} not along this setup's Z axis and ${across === 1 ? 'is' : 'are'} not drilled`,
    );
  }
  const name = (h: Hole) => {
    const top = add3(h.axisAt, scale(z, h.top + originZ));
    const faceList = h.walls.map((w) => `#${w.face}`).join(', ');
    return `the ${fmt(2 * h.radius)} mm hole at (${top.map(fmt).join(', ')}) (face ${faceList})`;
  };
  // Whole: no gap in Z, and all the way round at some height.
  const whole = holes.filter((h) => {
    const ends = [...new Set(h.walls.flatMap((w) => [w.top, w.bottom]))].sort((a, b) => a - b);
    const cover: number[] = [];
    for (let k = 0; k + 1 < ends.length; k++) {
      if (ends[k + 1]! - ends[k]! <= tol) continue;
      const m = (ends[k]! + ends[k + 1]!) / 2;
      cover.push(h.walls.reduce((sum, w) => (w.bottom < m && m < w.top ? sum + w.share : sum), 0));
    }
    const gap = cover.some((c) => c <= 0);
    const most = Math.max(0, ...cover);
    if (!gap && most >= CAM_HOLE_MIN_COVER) return true;
    if (h.walls.length > 1) {
      warnings.push(
        gap
          ? `${name(h)} is in pieces with a gap between them: it is not drilled`
          : `${name(h)} is in pieces that go only ${fmt(100 * most)} % of the way round: it is not drilled`,
      );
    }
    return false;
  });
  // Open above: every wall whose mouth meets other faces is open there.
  const reachable: Hole[] = [];
  const closed: Hole[] = [];
  const unclassified: Hole[] = [];
  for (const h of whole) {
    const mouths = h.walls.flatMap((w) => (w.mouth === null ? [] : [w.mouth]));
    if (mouths.length > 0 && mouths.every((m) => m === 'open')) reachable.push(h);
    else if (mouths.includes('closed')) closed.push(h);
    else unclassified.push(h);
  }
  const narrowest = reachable.filter(
    (h) => !reachable.some((o) => o !== h && near(o.axisAt, h.axisAt) && o.radius < h.radius - tol),
  );
  for (const h of closed) {
    const under = narrowest.find(
      (k) => near(k.axisAt, h.axisAt) && k.radius < h.radius - tol && h.top <= k.top + tol,
    );
    warnings.push(
      under !== undefined
        ? `${name(h)} is an undercut below ${name(under)}: it is not reachable from this setup, and only the narrow hole is drilled`
        : `${name(h)} is not reachable from this setup: it is closed above; it is not drilled`,
    );
  }
  for (const h of unclassified) {
    const what = [...new Set(h.walls.flatMap((w) => w.unknown))];
    warnings.push(
      `${name(h)} is not drilled: the top could not be classified${what.length > 0 ? ` (${what.join(', ')} above it)` : ''}`,
    );
  }
  for (const h of reachable) {
    if (narrowest.includes(h)) continue;
    const narrow = narrowest.find((k) => near(k.axisAt, h.axisAt) && k.radius < h.radius - tol)!;
    // A wider wall above the narrow one is a step left to a pocket (a counterbore); one reaching
    // below the narrow one's top is an undercut.
    if (h.bottom < narrow.top - tol) {
      warnings.push(
        `${name(h)} reaches below the top of ${name(narrow)} (an undercut): only the narrow hole is drilled`,
      );
    } else {
      notes.push(
        `The ${fmt(2 * h.radius)} mm step of ${name(narrow)} is left to a pocket: only the ${fmt(2 * narrow.radius)} mm hole is drilled`,
      );
    }
  }
  // Clear above, and what lies below the exit, from the mesh.
  const columns =
    narrowest.length > 0
      ? meshColumns(mesh, { x: perpendicular(z), y: cross(z, perpendicular(z)), z, originZ })
      : undefined;
  const kept: { hole: Hole; clearBelow?: number }[] = [];
  for (const h of narrowest) {
    const facets = columns!(h.axisAt, h.radius);
    const above = facets.filter(([, high]) => high > h.top + HOLE_RAY_START);
    if (above.length > 0) {
      warnings.push(
        `${name(h)} is not reachable from this setup: there is material above it (from ${fmt(Math.min(...above.map(([low]) => Math.max(low, h.top))))} mm); it is not drilled`,
      );
      continue;
    }
    // Conservative: a facet's highest point is its height.
    // Every facet reaching below the exit is floor, at the highest it can be inside the disk
    // (capped at the exit): a sloped floor rising past the exit outside the disk still counts.
    const under = facets
      .filter(([low]) => low < h.bottom - HOLE_RAY_START)
      .map(([, , overDisk]) => Math.min(overDisk, h.bottom));
    kept.push(
      under.length > 0 ? { hole: h, clearBelow: h.bottom - Math.max(...under) } : { hole: h },
    );
  }
  kept.sort((a, b) => a.hole.walls[0]!.face - b.hole.walls[0]!.face);
  const points = kept.map(({ hole: h, clearBelow }): CamDrillPoint => {
    const exits = h.walls.flatMap((w) => (w.exitDown === null ? [] : [w.exitDown]));
    const through = h.bottom <= bodyBottom + tol || (exits.length > 0 && exits.every((d) => d));
    const tilt = Math.max(...h.walls.map((w) => w.tilt));
    return {
      position: add3(h.axisAt, scale(z, h.top + originZ)),
      axis: [0 - z[0], 0 - z[1], 0 - z[2]],
      diameter: 2 * h.radius,
      depth: h.top - h.bottom,
      ...(through ? { through } : {}),
      ...(through && clearBelow !== undefined ? { clearBelow } : {}),
      ...(tilt > 1e-6 ? { entryTilt: tilt } : {}),
    };
  });
  return { points, warnings, notes };
}
