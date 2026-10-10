// @manufakture/fea: linear static stress analysis on TET10 meshes, in a worker (T9.6a; ADR 0017
// decision 13). The types, limits and the in-thread pipeline; the worker hosts are in ./client,
// ./browser and ./node.

export type {
  FaceRef,
  FeaBody,
  FeaError,
  FeaErrorCode,
  FeaFixture,
  FeaLimits,
  FeaLoad,
  FeaMaterial,
  FeaMeshOptions,
  FeaOutcome,
  FeaPeak,
  FeaPhase,
  FeaProgress,
  FeaRefinement,
  FeaRequest,
  FeaResult,
  FeaSummary,
  FeaTimings,
  FeaWarning,
} from './types';
export {
  DEFAULT_LIMITS,
  DEFAULT_TARGET_DOF,
  HARD_LIMITS,
  REQUEST_LIMITS,
  estimateDof,
  resolveLimits,
  sizeForDof,
  validateRequest,
} from './limits';
export { analyse, analyseMesh, type AnalyseOptions } from './analyse';
export type { MeshedModel, SolveInput } from './solve';
export type { FaceTriangles, TetMesh } from './mesh';
export { principalStresses, vonMises } from './tet10';

/** A core material's elastic constants as FEA takes them, or null when either is missing. */
export function feaMaterial(material: {
  elasticModulus?: { value: number };
  poissonRatio?: { value: number };
}): { elasticModulus: number; poissonRatio: number } | null {
  const E = material.elasticModulus?.value;
  const nu = material.poissonRatio?.value;
  return E !== undefined && nu !== undefined ? { elasticModulus: E, poissonRatio: nu } : null;
}
