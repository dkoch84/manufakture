// Evaluated CAM inputs (M5 plan, T5.1c; ADR 0014 decision 1). Everything here is plain data in
// internal units: millimetres, radians, millimetres per minute and rpm. The caller evaluates the
// document's expressions and resolves its references first, so nothing in this package ever sees
// a StoredExpression, a face name or a document.

/** A 2D point or vector, millimetres. */
export type Vec2 = readonly [number, number];

/** A 3D point or vector, millimetres (or unitless for directions). */
export type Vec3 = readonly [number, number, number];

/** An axis-aligned box. `min` is less than or equal to `max` on every axis. */
export interface Box3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Every fallible function in this package returns a `CamResult` rather than throwing. */
export type CamResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CamError };

export type CamErrorCode =
  /** A number that must be finite, positive or non-negative is not. */
  | 'invalid-input'
  /** A plane or axis that is not parallel to the setup's XY plane or Z axis (ADR 0014 decision 5). */
  | 'not-parallel'
  /** An explicit stock that does not contain the body. */
  | 'stock-too-small';

export interface CamError {
  readonly code: CamErrorCode;
  readonly message: string;
}

export function ok<T>(value: T): CamResult<T> {
  return { ok: true, value };
}

export function err<T = never>(code: CamErrorCode, message: string): CamResult<T> {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------------------------
// Tools

export type ToolKind = 'flat' | 'ball' | 'bull' | 'vbit' | 'drill' | 'engraver';

/** An evaluated tool: a document `CamTool` with its expressions evaluated. */
export interface Tool {
  /** The document id, `tool#n`. */
  readonly id: string;
  readonly name: string;
  readonly kind: ToolKind;
  /** The tool number a post writes with `T` (and `M6` where the dialect has it). */
  readonly number?: number;
  /** Cutting diameter, mm. For a V-bit, the largest diameter it cuts at. */
  readonly diameter: number;
  /** Length of the cutting flutes, mm: the deepest a single pass may reach. */
  readonly fluteLength: number;
  readonly flutes: number;
  /** Bull nose corner radius, mm. */
  readonly cornerRadius?: number;
  /** V-bit included angle or drill point angle, radians. */
  readonly angle?: number;
  /** V-bit flat tip diameter, mm. */
  readonly tipDiameter?: number;
}

/** Evaluated feeds and speed for one operation. */
export interface Feeds {
  /** Spindle speed, rpm. */
  readonly spindle: number;
  /** Feed for `cut` moves, mm/min. */
  readonly cut: number;
  /** Feed for `plunge` moves (straight down into material), mm/min. */
  readonly plunge: number;
  /** Feed for `ramp` moves (ramps and helical entries); `cut` when absent. */
  readonly ramp?: number;
  /** Feed for `lead` moves (lead-in and lead-out); `cut` when absent. */
  readonly lead?: number;
}

// ---------------------------------------------------------------------------------------------
// Stock and WCS

/**
 * The stock: a box in the setup frame (model coordinates turned so the WCS up direction is +Z,
 * not yet moved to the WCS origin; see `setupRotation`). Built by `stockFromBounds` or
 * `stockFromSize`.
 */
export interface Stock {
  readonly min: Vec3;
  readonly max: Vec3;
  /** A core material category id (`plywood`, `mdf`, ...), for feed presets and the setup sheet. */
  readonly material?: string;
}

/** Stock margins around the body's bounds, mm, each zero or more. */
export interface StockMargins {
  /** Added on the -X, +X, -Y and +Y sides (in the setup frame). */
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  /** Added above the body's top (+Z) and below its bottom (-Z). */
  readonly top: number;
  readonly bottom: number;
}

/** A model axis that becomes machine +Z. */
export type UpAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** Which way is up: a model axis, or a resolved planar face (ADR 0014 decision 5). */
export type WcsUp =
  | { readonly kind: 'axis'; readonly axis: UpAxis }
  | {
      readonly kind: 'face';
      /** Unit direction in model coordinates that becomes machine +Z: the face's outward normal. */
      readonly normal: Vec3;
      /** Optional model direction for machine +X; projected onto the face's plane. */
      readonly xDir?: Vec3;
    };

/** Where the WCS origin sits in XY on the stock, seen from above with the operator in front. */
export type WcsCorner = 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'centre';

/** An evaluated work coordinate system. */
export interface Wcs {
  readonly up: WcsUp;
  readonly origin: {
    readonly xy: WcsCorner;
    /** Z zero on the stock's top face or on its bottom (the spoilboard). */
    readonly z: 'top' | 'bottom';
  };
}

/**
 * A resolved WCS: machine axes and origin in model coordinates. Machine coordinates of a model
 * point p are `[(p - origin) . xAxis, (p - origin) . yAxis, (p - origin) . zAxis]`. The axes are
 * orthonormal and right-handed. Built by `wcsFrame`.
 */
export interface WcsFrame {
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly zAxis: Vec3;
}

/** Setup heights, machine Z (relative to the WCS origin). */
export interface Heights {
  /** Safe height for rapids between operations and over clamps. */
  readonly clearance: number;
  /** Height rapids go to between passes inside one operation; at most `clearance`. */
  readonly retract: number;
}

/** An evaluated setup: everything an operation needs besides its own input. */
export interface Setup {
  /** The document id, `setup#n`. */
  readonly id: string;
  readonly name: string;
  readonly stock: Stock;
  readonly wcs: Wcs;
  readonly frame: WcsFrame;
  readonly heights: Heights;
  /** Machine table id (T5.1d); not interpreted here. */
  readonly machine: string;
  /** Post id (`grbl`, ...); not interpreted here. */
  readonly post: string;
  /** Operations in cut order. */
  readonly operations: readonly OperationInput[];
}

// ---------------------------------------------------------------------------------------------
// Geometry inputs

/** Where a segment came from, so toolpaths and messages can name it. */
export type SourceTag =
  | { readonly kind: 'edge'; readonly edge: string }
  | { readonly kind: 'sketch'; readonly sketch: string; readonly entity: string }
  | { readonly kind: 'hole'; readonly feature: string };

export interface LineSegment2 {
  readonly kind: 'line';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly source?: SourceTag;
}

/**
 * An arc on a circle about `center`, from `start` to `end`, counter-clockwise when `ccw`. Its
 * sweep is the angle from start to end in that direction, in (0, 2 pi). A full circle is never
 * implied by `start` equal to `end`: it is marked with `fullCircle: true` (ADR 0014 decision 12).
 */
export interface ArcSegment2 {
  readonly kind: 'arc';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly center: Vec2;
  readonly ccw: boolean;
  readonly fullCircle?: boolean;
  readonly source?: SourceTag;
}

export type Segment2 = LineSegment2 | ArcSegment2;

/**
 * A closed loop of lines and arcs, each segment starting where the previous one ends and the last
 * ending at the first's start. Outer loops run counter-clockwise, holes clockwise, seen from +Z.
 */
export interface Loop2 {
  readonly segments: readonly Segment2[];
}

/**
 * Loops on a plane in model coordinates, as the geometry stage extracts them: a face's loops or
 * a sketch region. 2D point (u, v) is `origin + u * xDir + v * (normal x xDir)`.
 */
export interface PlanarLoops {
  readonly origin: Vec3;
  readonly xDir: Vec3;
  readonly normal: Vec3;
  readonly loops: readonly Loop2[];
}

/** Loops in machine XY at one machine Z: the result of `planarLoopsToMachine`. */
export interface MachineLoops {
  readonly z: number;
  readonly loops: readonly Loop2[];
}

/** A Z interval in machine coordinates: `top` is greater than or equal to `bottom`. */
export interface DepthRange {
  readonly top: number;
  readonly bottom: number;
}

/** A hole to drill, in model coordinates, as the geometry stage gives it. */
export interface DrillPoint {
  /** Centre of the hole's top, model coordinates. */
  readonly position: Vec3;
  /** Unit direction into the material (down the hole), model coordinates. */
  readonly axis: Vec3;
  /** Through-hole diameter, mm (never a counterbore's or countersink's head). */
  readonly diameter: number;
  /** Hole depth along `axis`, mm. */
  readonly depth: number;
  readonly through?: boolean;
  readonly source?: SourceTag;
}

/** A hole in machine coordinates: the result of `drillPointToMachine`. */
export interface MachineDrillPoint {
  readonly at: Vec2;
  readonly depth: DepthRange;
  readonly diameter: number;
  readonly through?: boolean;
  readonly source?: SourceTag;
}

/**
 * A triangle mesh for 3D operations (T5.5a): xyz per vertex and three vertex indices per
 * triangle. Structurally a subset of the kernel's `MeshData`, so a `MeshData` can be passed.
 */
export interface Mesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

// ---------------------------------------------------------------------------------------------
// Operations. First cuts: the operation tasks (T5.2b to T5.2f, T5.5a) may add fields.

export type OperationKind = 'facing' | 'profile' | 'pocket' | 'drill' | 'vcarve' | 'surface3d';

interface OperationBase {
  /** The document id, `<kind>#n`. */
  readonly id: string;
  readonly name: string;
  readonly tool: Tool;
  readonly feeds: Feeds;
}

/** How a pass enters the material. */
export type Entry =
  | { readonly kind: 'plunge' }
  | { readonly kind: 'ramp'; readonly angle: number }
  | { readonly kind: 'helix'; readonly angle: number; readonly radius: number };

/** A lead-in or lead-out move, tangent to the cut. */
export type Lead =
  | { readonly kind: 'none' }
  | { readonly kind: 'line'; readonly length: number }
  | { readonly kind: 'arc'; readonly radius: number };

export interface FacingInput extends OperationBase {
  readonly kind: 'facing';
  /** The area to face, machine XY; usually the stock outline. */
  readonly loops: readonly Loop2[];
  readonly depth: DepthRange;
  readonly stepdown: number;
  /** Fraction of the tool diameter, in (0, 1]. */
  readonly stepover: number;
  /** Raster direction, radians from machine +X. */
  readonly angle: number;
}

export interface ProfileInput extends OperationBase {
  readonly kind: 'profile';
  readonly loops: readonly Loop2[];
  readonly side: 'outside' | 'inside' | 'on';
  readonly depth: DepthRange;
  readonly stepdown: number;
  /** Material left on the wall by the roughing passes, mm. */
  readonly finishAllowance: number;
  readonly tabs?: { readonly count: number; readonly width: number; readonly height: number };
  readonly entry: Entry;
  readonly leadIn: Lead;
  readonly leadOut: Lead;
  /** Climb milling when true, conventional when false. */
  readonly climb: boolean;
}

export interface PocketInput extends OperationBase {
  readonly kind: 'pocket';
  /** Outer loops and island loops, machine XY. */
  readonly loops: readonly Loop2[];
  readonly depth: DepthRange;
  readonly stepdown: number;
  /** Fraction of the tool diameter, in (0, 1]. */
  readonly stepover: number;
  readonly finishAllowance: number;
  readonly entry: Entry;
  readonly climb: boolean;
}

export interface DrillInput extends OperationBase {
  readonly kind: 'drill';
  readonly points: readonly MachineDrillPoint[];
  /** Peck depth, mm; absent for a single plunge. */
  readonly peck?: number;
  /** Dwell at the bottom, seconds. */
  readonly dwell?: number;
}

export interface VCarveInput extends OperationBase {
  readonly kind: 'vcarve';
  readonly loops: readonly Loop2[];
  /** Machine Z of the surface carved into. */
  readonly top: number;
  /** Deepest the carve may go below `top`, mm; absent for no limit. */
  readonly maxDepth?: number;
}

export interface Surface3dInput extends OperationBase {
  readonly kind: 'surface3d';
  /** The body's mesh in machine coordinates. */
  readonly mesh: Mesh;
  /** Distance between raster lines, mm. */
  readonly stepover: number;
  /** Raster direction, radians from machine +X. */
  readonly angle: number;
  /** Material left on the surface, mm. */
  readonly allowance: number;
}

export type OperationInput =
  FacingInput | ProfileInput | PocketInput | DrillInput | VCarveInput | Surface3dInput;
