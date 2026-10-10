// The plain data that crosses the FEA worker boundary (ADR 0007): the request, the result, the
// progress events and the typed errors. No class instances, no functions, no wasm pointers.
//
// Units: lengths and displacements in millimetres (the document's and the kernel's STEP unit),
// forces in newtons, stresses, pressures and moduli in pascals (SI, as core's materials and
// packages/calc). Inside, the solver works in mm, N and MPa (N/mm²); the conversion happens once
// at each end.

/** A face of one body: `face` is the kernel's face index, which is gmsh's surface order (T9.0a). */
export interface FaceRef {
  /** Index into `FeaRequest.bodies`. */
  body: number;
  /** The kernel's face index within that body (0-based). */
  face: number;
}

/** Isotropic linear elastic material. */
export interface FeaMaterial {
  /** Elastic (Young's) modulus, Pa. */
  elasticModulus: number;
  /** Poisson's ratio. */
  poissonRatio: number;
}

/** One body: its geometry as STEP bytes, as `Kernel.exportStep` writes it, and its material. */
export interface FeaBody {
  step: Uint8Array;
  material: FeaMaterial;
  /**
   * The kernel's face count for this body. When given, the mesher's surface count after import
   * must equal it, or the analysis stops with a `face-mapping` error instead of loading the
   * wrong faces.
   */
  faceCount?: number;
}

/** Local refinement: elements no larger than `size` on these faces. */
export interface FeaRefinement {
  faces: FaceRef[];
  /** Element size on the faces, mm. */
  size: number;
}

export interface FeaMeshOptions {
  /**
   * Target element size, mm (the largest element edge). Default: the size that gives about
   * 175,000 DOF for the bodies' volume and surface (ADR 0017 decision 13: 150k to 200k).
   */
  size?: number;
  /** Smallest element size gmsh may use anywhere, mm (default `size / 10`). */
  sizeMin?: number;
  /**
   * Elements per full circle on curved faces, refining holes and fillets automatically
   * (default 12; 0 turns it off). Never below `sizeMin`.
   */
  curvature?: number;
  refine?: FeaRefinement[];
  /** gmsh's 3D algorithm (default 'hxt', T9.0a). */
  algorithm?: 'hxt' | 'delaunay';
}

/** Displacement held at zero on a face, for the components given (default all three). */
export interface FeaFixture {
  kind: 'fixed';
  faces: FaceRef[];
  /** Which of x, y, z are held (default [true, true, true]). */
  components?: [boolean, boolean, boolean];
}

/** A load on faces. */
export type FeaLoad =
  /** A total force, N, spread uniformly over the faces' area. */
  | { kind: 'force'; faces: FaceRef[]; force: [number, number, number] }
  /** A traction, Pa (force per area), the same everywhere on the faces. */
  | { kind: 'traction'; faces: FaceRef[]; traction: [number, number, number] }
  /** A pressure, Pa, normal to the faces and into the body (negative pulls). */
  | { kind: 'pressure'; faces: FaceRef[]; pressure: number };

/** Resource limits of one analysis. Each may be lowered; none may exceed `HARD_LIMITS`. */
export interface FeaLimits {
  /** Degrees of freedom (3 per node). Default and hard cap 500,000 (ADR 0017 decision 13). */
  maxDof: number;
  /** Above this many DOF the result carries a warning (default 200,000). */
  warnDof: number;
  /**
   * Memory the analysis may use, bytes: the solver's arrays by its own account, plus gmsh's heap
   * while meshing. gmsh's heap may grow to half of this (at most 1 GiB) and no further, so an
   * analysis that meshes needs at least 256 MiB (`memory-limit` otherwise; a prebuilt mesh has
   * no such floor). The JavaScript engine's own overhead is not counted.
   */
  memoryBytes: number;
  /** Wall time from the start of the analysis, ms. */
  timeMs: number;
}

export interface FeaRequest {
  bodies: FeaBody[];
  mesh: FeaMeshOptions;
  fixtures: FeaFixture[];
  loads: FeaLoad[];
  limits?: Partial<FeaLimits>;
  /** Relative residual conjugate gradients stops at (default 1e-8). */
  tolerance?: number;
}

export type FeaPhase =
  'load-mesher' | 'import' | 'mesh' | 'prepare' | 'assemble' | 'precondition' | 'solve' | 'stress';

export interface FeaProgress {
  phase: FeaPhase;
  /** ms since the analysis started. */
  elapsedMs: number;
  /** Conjugate gradient iteration and relative residual, during 'solve'. */
  iteration?: number;
  residual?: number;
  /** Mesh size once known. */
  dof?: number;
}

/** Expected failures: data, never exceptions (ADR 0007 decision 5). */
export type FeaError =
  | { code: 'invalid-input'; message: string; path: string }
  | {
      code: 'dof-limit';
      message: string;
      dof: number;
      limit: number;
      /** True when refused from the estimate, before any mesh was built. */
      estimated: boolean;
    }
  | { code: 'memory-limit'; message: string; bytes: number; limit: number }
  | { code: 'time-limit'; message: string; elapsedMs: number; limit: number }
  | { code: 'cancelled'; message: string }
  | { code: 'mesher-unavailable'; message: string }
  | { code: 'mesh-failed'; message: string; detail?: string }
  | { code: 'face-mapping'; message: string; body: number; expected?: number; found?: number }
  | { code: 'invalid-element'; message: string; element: number }
  | { code: 'unconstrained'; message: string; bodies: number[] }
  | { code: 'not-converged'; message: string; iterations: number; residual: number }
  | { code: 'worker-failed'; message: string }
  /** Another analysis is running on this runner: one at a time (ADR 0017 decision 13). */
  | { code: 'busy'; message: string };

export type FeaErrorCode = FeaError['code'];

export interface FeaWarning {
  code: 'large-model' | 'poor-elements' | 'load-off-mesh';
  message: string;
}

/** Per-phase wall times, ms. */
export interface FeaTimings {
  loadMesher: number;
  import: number;
  mesh: number;
  prepare: number;
  assemble: number;
  precondition: number;
  solve: number;
  stress: number;
  total: number;
}

/** A node index with where it is. */
export interface FeaPeak {
  value: number;
  node: number;
  at: [number, number, number];
  body: number;
}

export interface FeaResult {
  /** x, y, z per node, mm. */
  nodes: Float64Array;
  /** 10 node indices per element (corners 0..3, then edge nodes 01 12 02 03 13 23). */
  elements: Uint32Array;
  /** Body index per element. */
  elementBody: Uint16Array;
  /**
   * Boundary triangles for display: 6 node indices each (corners, then edge nodes 01 12 02), and
   * per triangle the body and kernel face it lies on (`triangleFace[2k]`, `triangleFace[2k + 1]`).
   */
  triangles: Uint32Array;
  triangleFace: Uint32Array;
  /** Displacement per node, mm (x, y, z). */
  displacement: Float64Array;
  /** Stress per node, Pa, Voigt order xx yy zz yz xz xy, averaged over the elements at the node. */
  stress: Float64Array;
  /** Von Mises stress per node, Pa. */
  vonMises: Float64Array;
  /** Principal stresses per node, Pa, largest first (s1 s2 s3). */
  principal: Float64Array;
  summary: FeaSummary;
}

export interface FeaSummary {
  nodes: number;
  elements: number;
  dof: number;
  /** Before meshing, from the volume and the element sizes. */
  estimatedDof: number;
  iterations: number;
  relativeResidual: number;
  maxVonMises: FeaPeak;
  maxDisplacement: FeaPeak;
  /** The applied loads summed, N. */
  appliedForce: [number, number, number];
  /** The smallest ratio of an element's smallest to largest Jacobian over its Gauss points. */
  worstElementQuality: number;
  /** Bytes of the solver's arrays at their peak, and gmsh's heap after meshing. */
  solverBytes: number;
  mesherBytes: number;
  timings: FeaTimings;
  warnings: FeaWarning[];
}

export type FeaOutcome = { ok: true; result: FeaResult } | { ok: false; error: FeaError };
