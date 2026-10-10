// Limits and input validation. A shared document or an agent can ask for an analysis, so every
// count, size and number is checked here, before anything is allocated or meshed (ADR 0017
// decisions 13 and 16). Validation returns a typed error naming the offending field.

import type { MeshedModel } from './solve';
import type { FeaError, FeaFixture, FeaLimits, FeaLoad, FeaMaterial, FeaRequest } from './types';

/** The ceilings no request can raise. */
export const HARD_LIMITS: FeaLimits = {
  maxDof: 500_000,
  warnDof: 500_000,
  memoryBytes: 4 * 1024 ** 3,
  timeMs: 600_000,
};

/** The defaults: the spike's recommendation (cap 500k DOF, warn above 200k). */
export const DEFAULT_LIMITS: FeaLimits = {
  maxDof: 500_000,
  warnDof: 200_000,
  memoryBytes: 1.5 * 1024 ** 3,
  timeMs: 300_000,
};

/** The DOF a default mesh aims at (ADR 0017 decision 13: 150k to 200k). */
export const DEFAULT_TARGET_DOF = 175_000;

/** Structural limits on the request itself. */
export const REQUEST_LIMITS = {
  bodies: 16,
  stepBytesPerBody: 32 * 1024 * 1024,
  stepBytesTotal: 64 * 1024 * 1024,
  fixtures: 1_000,
  loads: 1_000,
  refinements: 1_000,
  /** Face references across all refinements (each is sampled by gmsh's distance field). */
  refinedFaces: 500,
  /** Face references per fixture, load or refinement. */
  facesPerItem: 10_000,
  /** Face references across all fixtures and loads together. */
  faceRefs: 10_000,
  /** Faces a body may have (gmsh surfaces after import). */
  facesPerBody: 100_000,
  /** Largest absolute force (N), traction or pressure (Pa) or modulus (Pa). */
  magnitude: 1e15,
  /** Elements per circle for curvature refinement. */
  curvature: 100,
  /** The smallest element may not be finer than size / this. */
  sizeRatio: 50,
  /** Smallest element size accepted, mm (0.1 µm: below it STEP's tolerances dominate). */
  minSize: 1e-4,
  /** Largest element size accepted, mm (100 m). */
  maxSize: 1e5,
  /** A prebuilt mesh may have at most this many elements per node (TET10 meshes have under 1). */
  elementsPerNode: 2,
} as const;

/**
 * Bytes the solver's arrays take per DOF at their peak, by its own account (the matrix, the AMG
 * hierarchy, the vectors and the mesh): about 2.1 KiB measured from 150k to 330k DOF.
 */
export const SOLVER_BYTES_PER_DOF = 2_200;

/**
 * The DOF of gmsh's TET10 meshes (HXT, curvature refinement on) fit as
 * `DOF_PER_UNIT_VOLUME * volume / size³ + DOF_PER_UNIT_AREA * surface / size²`: the surface term
 * is the boundary layer of elements, which dominates thin bodies. Fit on the benchmark solids
 * and the bracket from 20k to 330k DOF to within about 6 % (README, "DOF estimate").
 */
export const DOF_PER_UNIT_VOLUME = 15;
export const DOF_PER_UNIT_AREA = 16;

/** A refinement holds its size out to this many of its sizes from its faces... */
export const REFINE_INNER = 2;
/** ...then grows linearly to the element size over this many times the difference. */
export const REFINE_GROWTH = 2.5;
/** Points per parametric direction gmsh's distance field samples on each refined face. */
export const REFINE_SAMPLING = 40;

/** The distances, mm, over which a refinement holds its size and then grows to `size`. */
export function refineBand(local: number, size: number): { inner: number; outer: number } {
  const inner = REFINE_INNER * local;
  return { inner, outer: inner + REFINE_GROWTH * Math.max(0, size - local) };
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);

const bad = (path: string, message: string): FeaError => ({
  code: 'invalid-input',
  message,
  path,
});

/** Effective limits: the request's, never above the hard caps. Invalid values are an error. */
export function resolveLimits(limits: Partial<FeaLimits> | undefined): FeaLimits | FeaError {
  const out: FeaLimits = { ...DEFAULT_LIMITS };
  if (limits === undefined) return out;
  if (typeof limits !== 'object' || limits === null)
    return bad('limits', 'limits must be an object');
  for (const key of ['maxDof', 'warnDof', 'memoryBytes', 'timeMs'] as const) {
    const v = limits[key];
    if (v === undefined) continue;
    if (!finite(v) || v <= 0) return bad(`limits.${key}`, `${key} must be a positive number`);
    if (v > HARD_LIMITS[key]) {
      return bad(`limits.${key}`, `${key} may not exceed ${HARD_LIMITS[key]}`);
    }
    out[key] = v;
  }
  out.warnDof = Math.min(out.warnDof, out.maxDof);
  return out;
}

function checkVector(v: unknown, path: string): FeaError | null {
  if (!Array.isArray(v) || v.length !== 3) return bad(path, 'expected three numbers');
  for (let i = 0; i < 3; i++) {
    const c = v[i] as unknown;
    if (!finite(c) || Math.abs(c) > REQUEST_LIMITS.magnitude) {
      return bad(`${path}[${i}]`, `must be a finite number of magnitude at most 1e15`);
    }
  }
  return null;
}

function checkFaces(faces: unknown, bodies: number, path: string): FeaError | null {
  if (!Array.isArray(faces) || faces.length === 0) return bad(path, 'expected at least one face');
  if (faces.length > REQUEST_LIMITS.facesPerItem) {
    return bad(path, `at most ${REQUEST_LIMITS.facesPerItem} faces`);
  }
  // A face named twice would be held twice and, in a force, count its area twice.
  const seen = new Set<number>();
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i] as { body?: unknown; face?: unknown } | null;
    if (typeof f !== 'object' || f === null) return bad(`${path}[${i}]`, 'expected { body, face }');
    if (!isInt(f.body) || f.body < 0 || f.body >= bodies) {
      return bad(`${path}[${i}].body`, 'not a body of this request');
    }
    if (!isInt(f.face) || f.face < 0 || f.face >= REQUEST_LIMITS.facesPerBody) {
      return bad(`${path}[${i}].face`, 'must be a non-negative integer face index');
    }
    const key = f.body * REQUEST_LIMITS.facesPerBody + f.face;
    if (seen.has(key))
      return bad(`${path}[${i}]`, `face ${f.face} of body ${f.body} is named twice`);
    seen.add(key);
  }
  return null;
}

const STEP_MAGIC = 'ISO-10303-21';

/** Checks the request's shape and every number in it. Face indices are checked again after import. */
export function validateRequest(request: FeaRequest): FeaError | null {
  if (typeof request !== 'object' || request === null) return bad('', 'expected a request object');
  const { bodies, mesh, fixtures, loads } = request;
  if (!Array.isArray(bodies) || bodies.length === 0) return bad('bodies', 'at least one body');
  if (bodies.length > REQUEST_LIMITS.bodies) {
    return bad('bodies', `at most ${REQUEST_LIMITS.bodies} bodies`);
  }
  let total = 0;
  for (let b = 0; b < bodies.length; b++) {
    const body = bodies[b] as FeaRequest['bodies'][number] | null;
    const p = `bodies[${b}]`;
    if (typeof body !== 'object' || body === null) return bad(p, 'expected { step, material }');
    if (!(body.step instanceof Uint8Array) || body.step.length === 0) {
      return bad(`${p}.step`, 'expected STEP bytes');
    }
    if (body.step.length > REQUEST_LIMITS.stepBytesPerBody) {
      return bad(`${p}.step`, `at most ${REQUEST_LIMITS.stepBytesPerBody} bytes`);
    }
    total += body.step.length;
    let head = '';
    for (let i = 0; i < Math.min(body.step.length, 64); i++)
      head += String.fromCharCode(body.step[i]!);
    if (!head.trimStart().startsWith(STEP_MAGIC)) return bad(`${p}.step`, 'not a STEP file');
    if (body.faceCount !== undefined) {
      if (
        !isInt(body.faceCount) ||
        body.faceCount < 1 ||
        body.faceCount > REQUEST_LIMITS.facesPerBody
      ) {
        return bad(`${p}.faceCount`, `must be an integer from 1 to ${REQUEST_LIMITS.facesPerBody}`);
      }
    }
    const me = checkMaterial(body.material as FeaMaterial | null, `${p}.material`);
    if (me) return me;
  }
  if (total > REQUEST_LIMITS.stepBytesTotal) {
    return bad('bodies', `at most ${REQUEST_LIMITS.stepBytesTotal} bytes of STEP in total`);
  }

  if (typeof mesh !== 'object' || mesh === null) return bad('mesh', 'expected mesh options');
  const { size } = mesh;
  const sizeOk = (x: unknown): x is number =>
    finite(x) && x >= REQUEST_LIMITS.minSize && x <= REQUEST_LIMITS.maxSize;
  if (size !== undefined && !sizeOk(size)) {
    return bad(
      'mesh.size',
      `must be a number from ${REQUEST_LIMITS.minSize} to ${REQUEST_LIMITS.maxSize} mm`,
    );
  }
  if (mesh.sizeMin !== undefined) {
    const floor = size === undefined ? REQUEST_LIMITS.minSize : size / REQUEST_LIMITS.sizeRatio;
    if (
      !sizeOk(mesh.sizeMin) ||
      mesh.sizeMin < floor ||
      (size !== undefined && mesh.sizeMin > size)
    ) {
      return bad('mesh.sizeMin', `must be from size / ${REQUEST_LIMITS.sizeRatio} to size`);
    }
  }
  if (mesh.curvature !== undefined) {
    if (
      !finite(mesh.curvature) ||
      mesh.curvature < 0 ||
      mesh.curvature > REQUEST_LIMITS.curvature
    ) {
      return bad('mesh.curvature', `must be from 0 to ${REQUEST_LIMITS.curvature}`);
    }
  }
  if (mesh.algorithm !== undefined && mesh.algorithm !== 'hxt' && mesh.algorithm !== 'delaunay') {
    return bad('mesh.algorithm', "must be 'hxt' or 'delaunay'");
  }
  if (mesh.refine !== undefined) {
    if (!Array.isArray(mesh.refine)) return bad('mesh.refine', 'expected a list');
    if (mesh.refine.length > REQUEST_LIMITS.refinements) {
      return bad('mesh.refine', `at most ${REQUEST_LIMITS.refinements} refinements`);
    }
    const lowest = mesh.sizeMin ?? (size === undefined ? REQUEST_LIMITS.minSize : size / 10);
    let refinedFaces = 0;
    for (let i = 0; i < mesh.refine.length; i++) {
      const r = mesh.refine[i]!;
      const p = `mesh.refine[${i}]`;
      if (typeof r !== 'object' || r === null) return bad(p, 'expected { faces, size }');
      if (!sizeOk(r.size) || r.size < lowest || (size !== undefined && r.size > size)) {
        return bad(`${p}.size`, 'must be from the smallest element size to size');
      }
      const f = checkFaces(r.faces, bodies.length, `${p}.faces`);
      if (f) return f;
      refinedFaces += r.faces.length;
      if (refinedFaces > REQUEST_LIMITS.refinedFaces) {
        return bad(`${p}.faces`, `at most ${REQUEST_LIMITS.refinedFaces} refined faces in all`);
      }
    }
  }

  return checkSetup(fixtures, loads, request.tolerance, bodies.length);
}

/**
 * DOF estimate before meshing, from the volume and surface area (see `DOF_PER_UNIT_VOLUME`),
 * plus, for each refinement, the band around its faces (area times the integral of 1 / size³
 * through the band: constant out to `inner`, then growing linearly to the element size).
 * Curvature refinement of small holes is not estimated; the mesh's real size is checked again
 * before assembly.
 */
export function estimateDof(
  volume: number,
  size: number,
  refined: readonly { area: number; size: number }[] = [],
  surface = 0,
): number {
  let band = 0;
  for (const r of refined) {
    const h = Math.min(r.size, size);
    const { inner, outer } = refineBand(h, size);
    let perArea = inner / h ** 3;
    const slope = (size - h) / Math.max(outer - inner, 1e-12);
    if (slope > 0) perArea += (1 / (2 * slope)) * (1 / h ** 2 - 1 / size ** 2);
    band += r.area * perArea;
  }
  return Math.ceil(
    DOF_PER_UNIT_VOLUME * (volume / size ** 3 + band) + (DOF_PER_UNIT_AREA * surface) / size ** 2,
  );
}

/** The element size that gives about `targetDof` for a body (the default mesh), by bisection. */
export function sizeForDof(
  volume: number,
  surface: number,
  targetDof = DEFAULT_TARGET_DOF,
): number {
  if (!(volume > 0) || !(surface >= 0) || !(targetDof > 0)) return NaN;
  let lo: number = REQUEST_LIMITS.minSize,
    hi: number = REQUEST_LIMITS.maxSize;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (estimateDof(volume, mid, [], surface) > targetDof) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Fixtures, loads and the tolerance, for a request or a prebuilt mesh. */
function checkSetup(
  fixtures: unknown,
  loads: unknown,
  tolerance: unknown,
  bodies: number,
): FeaError | null {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return bad('fixtures', 'at least one fixture: a body that is not held cannot be solved');
  }
  if (fixtures.length > REQUEST_LIMITS.fixtures) {
    return bad('fixtures', `at most ${REQUEST_LIMITS.fixtures} fixtures`);
  }
  // Face references across fixtures and loads, counted before each item's faces are walked.
  let refs = 0;
  const tooMany = (path: string, faces: unknown): FeaError | null => {
    refs += Array.isArray(faces) ? faces.length : 0;
    return refs > REQUEST_LIMITS.faceRefs
      ? bad(path, `at most ${REQUEST_LIMITS.faceRefs} faces across all fixtures and loads`)
      : null;
  };
  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i] as FeaFixture;
    const p = `fixtures[${i}]`;
    if (typeof fx !== 'object' || fx === null || fx.kind !== 'fixed') {
      return bad(`${p}.kind`, "expected kind 'fixed'");
    }
    const f = tooMany(`${p}.faces`, fx.faces) ?? checkFaces(fx.faces, bodies, `${p}.faces`);
    if (f) return f;
    if (fx.components !== undefined) {
      const c = fx.components as unknown;
      if (!Array.isArray(c) || c.length !== 3 || c.some((x) => typeof x !== 'boolean')) {
        return bad(`${p}.components`, 'expected three booleans');
      }
      if (!c.some(Boolean)) return bad(`${p}.components`, 'holds no component');
    }
  }

  if (!Array.isArray(loads)) return bad('loads', 'expected a list');
  if (loads.length > REQUEST_LIMITS.loads)
    return bad('loads', `at most ${REQUEST_LIMITS.loads} loads`);
  for (let i = 0; i < loads.length; i++) {
    const l = loads[i] as FeaLoad;
    const p = `loads[${i}]`;
    if (typeof l !== 'object' || l === null) return bad(p, 'expected a load');
    let e: FeaError | null;
    if (l.kind === 'force') e = checkVector(l.force, `${p}.force`);
    else if (l.kind === 'traction') e = checkVector(l.traction, `${p}.traction`);
    else if (l.kind === 'pressure') {
      e =
        finite(l.pressure) && Math.abs(l.pressure) <= REQUEST_LIMITS.magnitude
          ? null
          : bad(`${p}.pressure`, 'must be a finite number of magnitude at most 1e15');
    } else e = bad(`${p}.kind`, "expected 'force', 'traction' or 'pressure'");
    if (e) return e;
    const f = tooMany(`${p}.faces`, l.faces) ?? checkFaces(l.faces, bodies, `${p}.faces`);
    if (f) return f;
  }

  if (tolerance !== undefined) {
    if (!finite(tolerance) || tolerance < 1e-12 || tolerance > 1e-3) {
      return bad('tolerance', 'must be from 1e-12 to 1e-3');
    }
  }
  return null;
}

/** A material's numbers. */
function checkMaterial(m: FeaMaterial | null, p: string): FeaError | null {
  if (typeof m !== 'object' || m === null) return bad(p, 'expected a material');
  const E = m.elasticModulus;
  if (!finite(E) || E <= 0 || E > REQUEST_LIMITS.magnitude) {
    return bad(`${p}.elasticModulus`, 'must be a positive finite modulus in Pa');
  }
  const nu = m.poissonRatio;
  // Above about 0.495 a displacement formulation locks; below -1 the material is not stable.
  if (!finite(nu) || nu <= -0.99 || nu > 0.495) {
    return bad(`${p}.poissonRatio`, "Poisson's ratio must be in (-0.99, 0.495]");
  }
  return null;
}

/**
 * Checks a prebuilt mesh and its setup (`analyseMesh`): array shapes, every index in range,
 * every coordinate finite, and the materials, fixtures and loads as for a request.
 */
export function validateMeshInput(
  model: MeshedModel,
  input: {
    materials: readonly FeaMaterial[];
    fixtures: unknown;
    loads: unknown;
    tolerance?: unknown;
  },
  maxDof: number,
): FeaError | null {
  if (
    typeof model !== 'object' ||
    model === null ||
    typeof model.mesh !== 'object' ||
    model.mesh === null
  ) {
    return bad('model', 'expected a meshed model');
  }
  const { nodes, tets, tetBody } = model.mesh;
  if (!(nodes instanceof Float64Array) || nodes.length % 3 !== 0 || nodes.length === 0) {
    return bad('model.mesh.nodes', 'expected x, y, z per node');
  }
  const n = nodes.length / 3;
  if (3 * n > maxDof) {
    return {
      code: 'dof-limit',
      message: `The mesh has ${3 * n} degrees of freedom, more than the limit of ${maxDof}.`,
      dof: 3 * n,
      limit: maxDof,
      estimated: false,
    };
  }
  for (let i = 0; i < nodes.length; i++) {
    if (!Number.isFinite(nodes[i]!))
      return bad('model.mesh.nodes', 'every coordinate must be finite');
  }
  if (!(tets instanceof Uint32Array) || tets.length % 10 !== 0 || tets.length === 0) {
    return bad('model.mesh.tets', 'expected 10 node indices per element');
  }
  const ne = tets.length / 10;
  if (ne > REQUEST_LIMITS.elementsPerNode * n) {
    return bad(
      'model.mesh.tets',
      `at most ${REQUEST_LIMITS.elementsPerNode} elements per node (${ne} elements, ${n} nodes)`,
    );
  }
  // Every node must belong to an element: a free node has no stiffness, and would leave the
  // system singular with no body to name as unconstrained.
  const used = new Uint8Array(n);
  for (let i = 0; i < tets.length; i++) {
    if (tets[i]! >= n)
      return bad('model.mesh.tets', 'an element refers to a node the mesh does not have');
    used[tets[i]!] = 1;
  }
  const free = used.indexOf(0);
  if (free >= 0) return bad('model.mesh.nodes', `node ${free} belongs to no element`);
  const materials = input.materials;
  if (
    !Array.isArray(materials) ||
    materials.length === 0 ||
    materials.length > REQUEST_LIMITS.bodies
  ) {
    return bad('materials', `one to ${REQUEST_LIMITS.bodies} materials`);
  }
  for (let b = 0; b < materials.length; b++) {
    const e = checkMaterial(materials[b] as FeaMaterial, `materials[${b}]`);
    if (e) return e;
  }
  if (!(tetBody instanceof Uint16Array) || tetBody.length !== tets.length / 10) {
    return bad('model.mesh.tetBody', 'expected a body per element');
  }
  for (let e = 0; e < tetBody.length; e++) {
    if (tetBody[e]! >= materials.length)
      return bad('model.mesh.tetBody', 'an element names a body with no material');
  }
  if (
    !Array.isArray(model.faces) ||
    !Array.isArray(model.faceCounts) ||
    model.faceCounts.length !== materials.length
  ) {
    return bad('model.faces', 'expected faces and a face count per body');
  }
  if (model.faces.length > REQUEST_LIMITS.facesPerBody * materials.length) {
    return bad('model.faces', `at most ${REQUEST_LIMITS.facesPerBody} faces per body`);
  }
  // A boundary triangle is a face of an element, and each element has four.
  let triangles = 0;
  for (let k = 0; k < model.faces.length; k++) {
    const f = model.faces[k]!;
    if (typeof f !== 'object' || f === null) return bad(`model.faces[${k}]`, 'expected a face');
    if (!(f.corners instanceof Uint32Array) || f.corners.length % 3 !== 0) {
      return bad(`model.faces[${k}].corners`, 'expected 3 corners per triangle');
    }
    triangles += f.corners.length / 3;
    if (triangles > 4 * ne) {
      return bad(`model.faces[${k}].corners`, 'more triangles than the elements have faces');
    }
    if (
      !isInt(f.body) ||
      f.body < 0 ||
      f.body >= materials.length ||
      !isInt(f.face) ||
      f.face < 0 ||
      f.face >= REQUEST_LIMITS.facesPerBody
    ) {
      return bad(`model.faces[${k}]`, 'not a face of a body of this mesh');
    }
    for (let i = 0; i < f.corners.length; i++) {
      if (f.corners[i]! >= n)
        return bad(
          `model.faces[${k}].corners`,
          'a triangle refers to a node the mesh does not have',
        );
    }
  }
  return checkSetup(input.fixtures, input.loads, input.tolerance, materials.length);
}
