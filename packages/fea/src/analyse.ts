// One analysis, start to finish, inside whatever thread calls it (the FEA worker, in the app and
// in a session): validate, load the mesher, mesh, release the mesher, solve, recover stresses.
// Every expected failure comes back as a typed error (ADR 0007 decision 5).

import { FeaAbort, mib, RunContext } from './context';
import { instantiateGmsh, MesherUnavailable } from './gmsh';
import { resolveLimits, validateMeshInput, validateRequest } from './limits';
import { meshBodies } from './mesher';
import { emptyTimings, type MeshedModel, type SolveInput, solveModel } from './solve';
import type { FeaError, FeaLimits, FeaOutcome, FeaProgress, FeaRequest } from './types';

export interface AnalyseOptions {
  /** A SharedArrayBuffer-backed flag the host sets to cancel; checked between phases and iterations. */
  cancel?: Int32Array | null;
  onProgress?: (p: FeaProgress) => void;
}

/** gmsh's share of the memory limit: half of it, never above 1 GiB (far past the DOF cap). */
export function mesherMemory(limits: FeaLimits): number {
  return Math.min(1024 ** 3, limits.memoryBytes / 2);
}

/** The least memory gmsh is given: its initial heap (64 MiB) and room to mesh small bodies. */
export const MESHER_MIN_BYTES = 128 * 1024 ** 2;

function failure(error: unknown, ctx: RunContext | null): FeaError {
  if (error instanceof FeaAbort) return error.error;
  if (error instanceof MesherUnavailable)
    return { code: 'mesher-unavailable', message: error.message };
  if (
    error instanceof RangeError &&
    /allocat|memory|Invalid typed array length/i.test(error.message)
  ) {
    const limit = ctx?.limits.memoryBytes ?? 0;
    return {
      code: 'memory-limit',
      message: `The analysis ran out of memory: ${error.message}`,
      bytes: ctx?.peak ?? 0,
      limit,
    };
  }
  return {
    code: 'worker-failed',
    message: `The analysis failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/** Mesh and solve a request. */
export async function analyse(
  request: FeaRequest,
  options: AnalyseOptions = {},
): Promise<FeaOutcome> {
  const invalid = validateRequest(request);
  if (invalid) return { ok: false, error: invalid };
  const limits = resolveLimits(request.limits);
  if ('code' in limits) return { ok: false, error: limits };
  // gmsh's memory is half the budget and is never given more, so a budget too small for it is
  // refused here rather than exceeded.
  if (mesherMemory(limits) < MESHER_MIN_BYTES) {
    return {
      ok: false,
      error: {
        code: 'memory-limit',
        message: `Meshing needs a memory limit of at least ${mib(2 * MESHER_MIN_BYTES)}; the limit is ${mib(limits.memoryBytes)}.`,
        bytes: 2 * MESHER_MIN_BYTES,
        limit: limits.memoryBytes,
      },
    };
  }
  let ctx: RunContext | null = null;
  try {
    ctx = new RunContext({
      limits,
      cancel: options.cancel ?? null,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    ctx.enter('load-mesher');
    const gmsh = await instantiateGmsh(mesherMemory(limits));
    const loadMesher = ctx.elapsed();
    let meshed: ReturnType<typeof meshBodies>;
    try {
      meshed = meshBodies(gmsh, request, ctx);
    } finally {
      gmsh.finalize();
    }
    const mesherBytes = gmsh.bytes();
    ctx.mesherBytes = 0;
    const solved = solveModel(
      meshed.model,
      {
        materials: request.bodies.map((b) => b.material),
        fixtures: request.fixtures,
        loads: request.loads,
        ...(request.tolerance !== undefined ? { tolerance: request.tolerance } : {}),
      },
      ctx,
    );
    const result = solved.result;
    result.summary.estimatedDof = meshed.estimatedDof;
    result.summary.mesherBytes = mesherBytes;
    result.summary.timings = {
      loadMesher,
      import: meshed.times.import,
      mesh: meshed.times.mesh,
      ...solved.times,
      total: ctx.elapsed(),
    };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: failure(error, ctx) };
  }
}

/**
 * Solve a mesh that is already built (no mesher): what the tests use with structured meshes, and
 * a way in for meshes from elsewhere. Validates the limits and the inputs' numbers.
 */
export function analyseMesh(
  model: MeshedModel,
  input: SolveInput & { limits?: Partial<FeaLimits> },
  options: AnalyseOptions = {},
): FeaOutcome {
  const limits = resolveLimits(input?.limits);
  if ('code' in limits) return { ok: false, error: limits };
  const invalid = validateMeshInput(model, input, limits.maxDof);
  if (invalid) return { ok: false, error: invalid };
  let ctx: RunContext | null = null;
  try {
    ctx = new RunContext({
      limits,
      cancel: options.cancel ?? null,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const solved = solveModel(model, input, ctx);
    const result = solved.result;
    result.summary.estimatedDof = result.summary.dof;
    result.summary.timings = { ...emptyTimings(), ...solved.times, total: ctx.elapsed() };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: failure(error, ctx) };
  }
}
