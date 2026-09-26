// Plain data types of the kernel API (ADR 0001, extended by ADR 0007 decision
// 9). Nothing here refers to an OCCT object: every value is structured-clone
// safe, so it can cross the worker boundary unchanged.

declare const shapeIdBrand: unique symbol;

/**
 * A shape in the kernel's arena. Ids are never reused, not even across an
 * instance recycle, so a stale id fails with `unknown-shape` instead of
 * silently addressing another shape.
 */
export type ShapeId = number & { readonly [shapeIdBrand]: true };

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export type SubShapeKind = 'face' | 'edge' | 'vertex';

/** A sub-shape of one given shape, by 1-based index in `TopExp.MapShapes` order. */
export interface SubShapeRef {
  kind: SubShapeKind;
  index: number;
}

/**
 * What an operation did to one face, edge or vertex of one input (ADR 0007,
 * decision 9). Every sub-shape of every operand gets an entry, including
 * inputs with no output at all.
 */
export interface HistoryEntry {
  /** Which input: 0 = the shape (or profile), 1 = the first tool, ... */
  operand: number;
  /** A face, edge or vertex of that input. */
  input: SubShapeRef;
  /** Index of the same sub-shape (same kind) in the result when untouched, else 0. */
  kept: number;
  /** Result sub-shapes this input became (OCCT Modified). */
  modified: SubShapeRef[];
  /** Result sub-shapes it gave rise to (OCCT Generated). */
  generated: SubShapeRef[];
  /**
   * Informational only; never use it for naming. Fillet's `IsDeleted`
   * returns true for edges the fillet did not touch (T0.5).
   */
  deleted: boolean;
}

export interface OperationResult {
  shape: ShapeId;
  /** Empty when the operation was called with `{ history: false }`. */
  history: HistoryEntry[];
}

export interface OperationOptions {
  /** Collect the sub-shape history (default true). */
  history?: boolean;
}

export interface ExtrudeResult extends OperationResult {
  /** Result face index of the cap at the profile. */
  capStart: number;
  /** Result face index of the far cap. */
  capEnd: number;
  /** Per profile loop, the result face each entity generated, in loop order. */
  sides: number[][];
}

/**
 * A right-handed placement for a planar profile. Profile coordinates (u, v)
 * map to `origin + u * xDir + v * yDir` with `yDir = normal x xDir`.
 */
export interface Frame {
  origin: Vec3;
  xDir: Vec3;
  normal: Vec3;
}

/**
 * One entity of a closed profile loop, in frame coordinates. In a loop of
 * several entities each one must end where the next starts. A circle is a
 * loop on its own. Arcs run counter-clockwise about the frame normal from
 * `start` to `end` unless `clockwise` is set.
 */
export type ProfileEntity =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; center: Vec2; start: Vec2; end: Vec2; clockwise?: boolean }
  | { kind: 'circle'; center: Vec2; radius: number };

/**
 * A closed loop. In a profile the first loop is the outer boundary and every
 * further loop is a hole; the kernel orients them itself, whatever the
 * direction the entities are given in.
 */
export interface ProfileLoop {
  entities: readonly ProfileEntity[];
}

export interface FaceInfo {
  index: number;
  /** Surface type in lower case: plane, cylinder, cone, sphere, torus, bsplinesurface, ... */
  surface: string;
  centroid: Vec3;
  area: number;
  /** Outward normal, planes only. */
  normal: Vec3 | null;
  /** Axis direction, cylinders only. */
  axis: Vec3 | null;
  /** Cylinders only. */
  radius: number | null;
}

export interface EdgeInfo {
  index: number;
  /** Adjacent faces, unique, ascending. A seam lists its one face once. */
  faces: number[];
  seam: boolean;
  /** Curve type in lower case: line, circle, ellipse, bsplinecurve, ... */
  curve: string;
  midpoint: Vec3;
  length: number;
  /** Vertex indices; one for a closed edge. */
  vertices: number[];
}

export interface VertexInfo {
  index: number;
  point: Vec3;
  /** Faces around the vertex, unique, ascending. */
  faces: number[];
}

export interface Topology {
  faces: FaceInfo[];
  edges: EdgeInfo[];
  vertices: VertexInfo[];
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export interface ShapeProperties {
  volume: number;
  area: number;
  /** Null for an empty shape. */
  boundingBox: BoundingBox | null;
  /** `BRepCheck_Analyzer` verdict. */
  valid: boolean;
  faces: number;
  edges: number;
  vertices: number;
}

export interface Deflection {
  /** Absolute chordal deflection in model units (mm). */
  linear: number;
  /** Angular deflection in radians. */
  angular: number;
}

/** Name slot value for a face or edge the regen engine has not named. */
export const UNNAMED = 0xffffffff;

/**
 * A tessellated body. All arrays are fresh, owned by nobody else, and meant to
 * be transferred (see `collectTransferables`).
 *
 * Face `i` (1-based, `TopExp.MapShapes` order, the same numbering as history
 * and topology) is slot `i - 1` of `faceRanges`, `faceNames` and
 * `faceFragile`. Edge `i` is slot `i - 1` of `edgeRanges`, `edgeNames` and
 * `edgeFragile`. Vertices are not shared between faces.
 */
export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit outward normal per vertex. */
  normals: Float32Array;
  /** Triangle vertex indices, counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** Per face: [firstIndex, indexCount] into `indices` (three.js group layout). */
  faceRanges: Uint32Array;
  /** Per triangle: its 1-based face index. */
  triangleFaces: Uint32Array;
  /** xyz per polyline point, all edges concatenated. */
  edgePositions: Float32Array;
  /** Per edge: [firstPoint, pointCount] into `edgePositions` (points, not floats). A degenerate edge has 0 points. */
  edgeRanges: Uint32Array;
  /** Per face: index into the reply's name table, `UNNAMED` until the regen engine names it. */
  faceNames: Uint32Array;
  /** Per face: 1 when its name is positional (ADR 0007, decision 7). */
  faceFragile: Uint8Array;
  /** Per edge: index into the reply's name table, or `UNNAMED`. */
  edgeNames: Uint32Array;
  /** Per edge: 1 when its name is positional. */
  edgeFragile: Uint8Array;
}

/** Where a live shape came from, for leak reports. */
export interface ShapeRecord {
  id: ShapeId;
  /** The kernel operation that created it. */
  operation: string;
  featureId?: string;
  generation?: number;
  /** `performance.now()` in the kernel's context when it was created. */
  createdAt: number;
  /** Creation stack, only in debug mode. */
  stack?: string;
}
