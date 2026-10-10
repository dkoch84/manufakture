// One analysis, start to finish: mesh a STEP solid, constrain, load, assemble, solve, recover
// stresses. Shared by the Node probes and the browser worker, so both time the same code.

import { type Case, type Metric } from './cases.ts';
import { boundaryFaces, type Gmsh, meshStep, type MeshOptions, type TetMesh } from './mesh.ts';
import {
  applySurfaceLoads,
  assemble,
  blockJacobi,
  fixNodes,
  ic0,
  jacobi,
  type BlockMatrix,
  matrixBytes,
  multiply,
  nodalStress,
  pattern,
  pcg,
  type Preconditioner,
  type SurfaceLoad,
} from './solver.ts';
import { type Material } from './tet10.ts';
import { rcm } from './order.ts';
import { amg, spmv } from './amg.ts';

export type PreconditionerName = 'jacobi' | 'block-jacobi' | 'ic0' | 'amg';

export interface Problem {
  material: Material;
  constrain: Case['constrain'];
  loads: SurfaceLoad[];
}

export interface RunResult {
  nodes: number;
  elements: number;
  dof: number;
  preconditioner: PreconditionerName;
  iterations: number;
  relResidual: number;
  ms: {
    import: number;
    mesh: number;
    extract: number;
    reorder: number;
    boundary: number;
    pattern: number;
    assemble: number;
    precondition: number;
    solve: number;
    stress: number;
    total: number;
  };
  /** Bytes of the solver's own typed arrays at their peak (matrix, preconditioner, vectors, mesh). */
  solverBytes: number;
  /** gmsh's wasm memory after meshing: its high-water mark, since wasm memory never shrinks. */
  gmshBytes: number;
  totalLoad: [number, number, number];
  /** AMG levels: dofs and blocks per level. */
  levels?: { dofs: number; blocks: number }[] | undefined;
  /** AMG setup time by phase, ms. */
  amgPhases?: Record<string, number> | undefined;
  metrics?: Metric[] | undefined;
}

export function makePreconditioner(
  name: PreconditionerName,
  a: BlockMatrix,
  nodes: Float64Array,
  fixed: Uint8Array,
): {
  m: Preconditioner;
  op: (x: Float64Array, y: Float64Array) => void;
  matrixBytes: number;
  levels?: { dofs: number; blocks: number }[];
  phases?: Record<string, number>;
} {
  if (name === 'amg') {
    // AMG keeps the full 3x3 BSR (counted in its bytes); conjugate gradients multiplies with it,
    // and the upper-triangle copy can be dropped.
    const m = amg(a, nodes, fixed);
    return {
      m,
      op: (x, y) => spmv(m.fine, x, y),
      matrixBytes: 0,
      levels: m.levels,
      phases: m.phases,
    };
  }
  const m = name === 'jacobi' ? jacobi(a) : name === 'block-jacobi' ? blockJacobi(a) : ic0(a);
  return { m, op: (x, y) => multiply(a, x, y), matrixBytes: matrixBytes(a) };
}

export function analyse(
  gmsh: Gmsh,
  step: Uint8Array,
  options: MeshOptions,
  problem: Problem,
  preconditioner: PreconditionerName = 'ic0',
  evaluate?: Case['evaluate'],
  tol = 1e-8,
  reorder = true,
): RunResult & { mesh: TetMesh; u: Float64Array; stress: Float64Array } {
  const t0 = performance.now();
  const meshed = meshStep(gmsh, step, options);
  const timing = meshed.timing;
  let t = performance.now();
  const mesh = reorder ? rcm(meshed.mesh) : meshed.mesh;
  const reorderMs = performance.now() - t;
  // wasmMemory, not HEAPU8: with shared memory the views are refreshed lazily and can be stale.
  const gmshBytes = gmsh.module?.wasmMemory?.buffer?.byteLength ?? 0;
  const n = mesh.nodes.length / 3;
  const ne = mesh.tets.length / 10;

  t = performance.now();
  const faces = boundaryFaces(mesh);
  const boundaryMs = performance.now() - t;

  const fixed = new Uint8Array(3 * n);
  problem.constrain(mesh, (where, comps) => void fixNodes(mesh, fixed, where, comps));
  const f = new Float64Array(3 * n);
  const totalLoad = applySurfaceLoads(mesh, faces, problem.loads, f);
  for (let i = 0; i < f.length; i++) if (fixed[i]) f[i] = 0;

  t = performance.now();
  const a = pattern(mesh);
  const patternMs = performance.now() - t;
  t = performance.now();
  assemble(mesh, problem.material, fixed, a);
  const assembleMs = performance.now() - t;

  const pre = makePreconditioner(preconditioner, a, mesh.nodes, fixed);
  const m = pre.m;
  const cg = pcg(pre.op, f, m, tol);
  t = performance.now();
  const stress = nodalStress(mesh, problem.material, cg.x);
  const stressMs = performance.now() - t;
  const total = performance.now() - t0;

  const vectors = 5 * f.byteLength + fixed.byteLength;
  const meshBytes =
    mesh.nodes.byteLength +
    mesh.tets.byteLength +
    faces.nodes.byteLength +
    faces.opposite.byteLength;
  return {
    mesh,
    u: cg.x,
    stress,
    nodes: n,
    elements: ne,
    dof: 3 * n,
    preconditioner,
    iterations: cg.iterations,
    relResidual: cg.relResidual,
    ms: {
      import: timing.importMs,
      mesh: timing.generateMs,
      extract: timing.extractMs,
      reorder: reorderMs,
      boundary: boundaryMs,
      pattern: patternMs,
      assemble: assembleMs,
      precondition: m.setupMs,
      solve: cg.ms,
      stress: stressMs,
      total,
    },
    solverBytes: pre.matrixBytes + m.bytes + vectors + meshBytes,
    levels: pre.levels,
    amgPhases: pre.phases,
    gmshBytes,
    totalLoad,
    metrics: evaluate?.(mesh, cg.x, stress),
  };
}

/** The result without its big arrays, for JSON. */
export function summary(r: ReturnType<typeof analyse>): RunResult {
  const { mesh: _m, u: _u, stress: _s, ...rest } = r;
  return rest;
}
