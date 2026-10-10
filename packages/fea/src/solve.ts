// From a TET10 mesh with its kernel faces to displacements and stresses: renumbering, element
// checks, fixtures and loads on faces, assembly, AMG-preconditioned conjugate gradients and nodal
// stress recovery. Independent of the mesher, so it runs on gmsh's meshes and on the structured
// meshes of the tests alike.

import { amg, fullFromUpper, spmv } from './amg';
import { pcg } from './cg';
import { FeaAbort, mib, type RunContext } from './context';
import { SOLVER_BYTES_PER_DOF } from './limits';
import { applyLoads, faceArea, fixFaces, type SolverLoad } from './loads';
import { assemble, type BlockMatrix, matrixBytes, pattern } from './matrix';
import {
  components,
  type FaceTriangles,
  nodeElements,
  rcmOrder,
  renumber,
  type ResolvedFace,
  resolveFaces,
  type TetMesh,
} from './mesh';
import { elementNodalStress, elementQuality, lame, principalStresses, vonMises } from './tet10';
import type {
  FaceRef,
  FeaFixture,
  FeaLoad,
  FeaMaterial,
  FeaPeak,
  FeaResult,
  FeaSummary,
  FeaWarning,
} from './types';

/** A meshed model as the mesher hands it over. */
export interface MeshedModel {
  mesh: TetMesh;
  /** Surface triangles of every kernel face of every body. */
  faces: FaceTriangles[];
  /** Faces per body (the kernel's count, which gmsh's surfaces matched). */
  faceCounts: number[];
}

export interface SolveInput {
  materials: readonly FeaMaterial[];
  fixtures: readonly FeaFixture[];
  loads: readonly FeaLoad[];
  tolerance?: number;
}

const PA_PER_MPA = 1e6;
/** Elements below this quality are counted in a warning. */
const POOR_QUALITY = 0.1;

const faceKey = (body: number, face: number) => body * 1_000_003 + face;

export function solveModel(
  model: MeshedModel,
  input: SolveInput,
  ctx: RunContext,
): {
  result: FeaResult;
  times: { prepare: number; assemble: number; precondition: number; solve: number; stress: number };
} {
  ctx.enter('prepare');
  let t = ctx.elapsed();
  const n0 = model.mesh.nodes.length / 3;
  const dof = 3 * n0;
  ctx.dof = dof;
  if (dof > ctx.limits.maxDof) {
    throw new FeaAbort({
      code: 'dof-limit',
      message: `The mesh has ${dof} degrees of freedom, more than the limit of ${ctx.limits.maxDof}. Use a larger element size.`,
      dof,
      limit: ctx.limits.maxDof,
      estimated: false,
    });
  }
  const need = dof * SOLVER_BYTES_PER_DOF + ctx.mesherBytes;
  if (need > ctx.limits.memoryBytes) {
    throw new FeaAbort({
      code: 'memory-limit',
      message: `A mesh of ${dof} degrees of freedom needs about ${mib(need)}, more than the memory limit of ${mib(ctx.limits.memoryBytes)}.`,
      bytes: need,
      limit: ctx.limits.memoryBytes,
    });
  }

  // Renumber for locality, then everything below works on the renumbered mesh.
  let adjacency = nodeElements(model.mesh);
  const perm = rcmOrder(model.mesh, adjacency);
  const mesh = renumber(model.mesh, perm);
  adjacency = nodeElements(mesh);
  ctx.use(mesh.nodes.byteLength + mesh.tets.byteLength + adjacency.elements.byteLength, 'the mesh');
  const faceTris: FaceTriangles[] = model.faces.map((f) => {
    const corners = new Uint32Array(f.corners.length);
    for (let i = 0; i < corners.length; i++) corners[i] = perm[f.corners[i]!]!;
    return { body: f.body, face: f.face, corners };
  });
  const { faces: resolved, unmatched } = resolveFaces(mesh, adjacency, faceTris);
  const byKey = new Map<number, ResolvedFace>();
  for (const f of resolved) byKey.set(faceKey(f.body, f.face), f);
  const warnings: FeaWarning[] = [];
  if (unmatched > 0) {
    warnings.push({
      code: 'load-off-mesh',
      message: `${unmatched} surface triangles matched no element face; loads and fixtures on them were not applied.`,
    });
  }
  const pick = (refs: readonly FaceRef[], path: string): ResolvedFace[] =>
    refs.map((r, i) => {
      const f = byKey.get(faceKey(r.body, r.face));
      if (!f) {
        throw new FeaAbort({
          code: 'invalid-input',
          message: `Body ${r.body} has no face ${r.face} (it has ${model.faceCounts[r.body] ?? 0}).`,
          path: `${path}[${i}]`,
        });
      }
      return f;
    });

  // Element quality, which also refuses inverted elements before assembly.
  const ne = mesh.tets.length / 10;
  const xe = new Float64Array(30);
  let worst = 1,
    poor = 0;
  for (let e = 0; e < ne; e++) {
    if ((e & 8191) === 0) ctx.check();
    for (let k = 0; k < 10; k++) {
      const g = mesh.tets[10 * e + k]!;
      xe[3 * k] = mesh.nodes[3 * g]!;
      xe[3 * k + 1] = mesh.nodes[3 * g + 1]!;
      xe[3 * k + 2] = mesh.nodes[3 * g + 2]!;
    }
    const q = elementQuality(xe);
    if (!(q > 0)) {
      throw new FeaAbort({
        code: 'invalid-element',
        message: `Element ${e} is inverted: the mesh is not valid for analysis. Try a smaller element size or the other 3D algorithm.`,
        element: e,
      });
    }
    if (q < worst) worst = q;
    if (q < POOR_QUALITY) poor++;
  }
  if (poor > 0) {
    warnings.push({
      code: 'poor-elements',
      message: `${poor} of ${ne} elements are strongly distorted (Jacobian ratio below ${POOR_QUALITY}); stresses near them are less accurate.`,
    });
  }
  if (dof > ctx.limits.warnDof) {
    warnings.push({
      code: 'large-model',
      message: `The mesh has ${dof} degrees of freedom (above ${ctx.limits.warnDof}): the analysis may take tens of seconds and a few gigabytes of memory on a slower machine.`,
    });
  }

  // Fixtures, and the check that every connected part is held.
  const n = n0;
  const fixed = new Uint8Array(3 * n);
  const check = () => ctx.check();
  input.fixtures.forEach((fx, i) =>
    fixFaces(
      pick(fx.faces, `fixtures[${i}].faces`),
      fx.components ?? [true, true, true],
      fixed,
      check,
    ),
  );
  const parts = components(mesh, adjacency);
  const held = new Uint8Array(parts.count * 3);
  const heldNodes = new Int32Array(parts.count);
  for (let i = 0; i < n; i++) {
    const p = parts.label[i]!;
    if (p < 0) continue;
    let any = false;
    for (let c = 0; c < 3; c++)
      if (fixed[3 * i + c]) {
        held[3 * p + c] = 1;
        any = true;
      }
    if (any) heldNodes[p]!++;
  }
  const loose = new Set<number>();
  for (let p = 0; p < parts.count; p++) {
    if (!(held[3 * p] && held[3 * p + 1] && held[3 * p + 2] && heldNodes[p]! >= 3)) {
      for (let e = 0; e < ne; e++) {
        if (parts.label[mesh.tets[10 * e]!] === p) {
          loose.add(mesh.tetBody[e]!);
          break;
        }
      }
    }
  }
  if (loose.size > 0) {
    const bodies = [...loose].sort((a, b) => a - b);
    throw new FeaAbort({
      code: 'unconstrained',
      message: `Body ${bodies.join(', ')} is not held in all of x, y and z: add a fixture to it or bond it to a held body.`,
      bodies,
    });
  }

  // Loads.
  const f = new Float64Array(3 * n);
  const solverLoads: SolverLoad[] = input.loads.map((l, i) => {
    const faces = pick(l.faces, `loads[${i}].faces`);
    if (l.kind === 'pressure')
      return { kind: 'pressure', faces, pressure: l.pressure / PA_PER_MPA };
    if (l.kind === 'traction') {
      return {
        kind: 'traction',
        faces,
        traction: l.traction.map((c) => c / PA_PER_MPA) as [number, number, number],
      };
    }
    const area = faceArea(mesh.nodes, faces, check);
    if (!(area > 0)) {
      throw new FeaAbort({
        code: 'invalid-input',
        message: 'The faces of a force have no area.',
        path: `loads[${i}].faces`,
      });
    }
    return {
      kind: 'traction',
      faces,
      traction: l.force.map((c) => c / area) as [number, number, number],
    };
  });
  const appliedForce = applyLoads(mesh.nodes, solverLoads, f, check);
  for (let i = 0; i < f.length; i++) if (fixed[i]) f[i] = 0;
  const prepare = ctx.elapsed() - t;

  // Assembly.
  ctx.enter('assemble');
  t = ctx.elapsed();
  const bodies = input.materials.length;
  const constants = { lambda: new Float64Array(bodies), mu: new Float64Array(bodies) };
  input.materials.forEach((m, b) => {
    const c = lame({ E: m.elasticModulus / PA_PER_MPA, nu: m.poissonRatio });
    constants.lambda[b] = c.lambda;
    constants.mu[b] = c.mu;
  });
  // Held in an object so the upper-triangle copy can be let go once AMG has its full copy.
  const assembled: { upper: BlockMatrix | null } = { upper: pattern(mesh, adjacency, ctx) };
  assemble(mesh, constants, fixed, assembled.upper!, ctx);
  const assembleMs = ctx.elapsed() - t;

  // Preconditioner: AMG keeps the full 3x3 matrix that conjugate gradients multiplies with, so
  // the upper-triangle copy is dropped once it is built.
  ctx.enter('precondition');
  t = ctx.elapsed();
  const fine = fullFromUpper(assembled.upper!, ctx);
  ctx.release(matrixBytes(assembled.upper!));
  assembled.upper = null;
  const m = amg(fine, mesh.nodes, fixed, {}, ctx);
  const preconditionMs = ctx.elapsed() - t;

  ctx.enter('solve');
  t = ctx.elapsed();
  const cg = pcg((x, y) => spmv(m.fine, x, y), f, m, ctx, input.tolerance ?? 1e-8);
  const solveMs = ctx.elapsed() - t;

  // Nodal stresses, averaged over the elements at each node, in Pa.
  ctx.enter('stress');
  t = ctx.elapsed();
  const u = cg.x;
  const stress = new Float64Array(6 * n);
  const count = new Float64Array(n);
  const ue = new Float64Array(30),
    se = new Float64Array(60);
  for (let e = 0; e < ne; e++) {
    if ((e & 8191) === 0) ctx.check();
    const b = mesh.tetBody[e]!;
    for (let k = 0; k < 10; k++) {
      const g = mesh.tets[10 * e + k]!;
      for (let c = 0; c < 3; c++) {
        xe[3 * k + c] = mesh.nodes[3 * g + c]!;
        ue[3 * k + c] = u[3 * g + c]!;
      }
    }
    elementNodalStress(xe, ue, constants.lambda[b]!, constants.mu[b]!, se);
    for (let k = 0; k < 10; k++) {
      const g = mesh.tets[10 * e + k]!;
      for (let c = 0; c < 6; c++) stress[6 * g + c]! += se[6 * k + c]!;
      count[g]! += 1;
    }
  }
  const vm = new Float64Array(n);
  const principal = new Float64Array(3 * n);
  const nodeBody = new Uint16Array(n);
  for (let e = 0; e < ne; e++)
    for (let k = 0; k < 10; k++) nodeBody[mesh.tets[10 * e + k]!] = mesh.tetBody[e]!;
  let vmPeak = -1,
    vmNode = 0,
    uPeak = -1,
    uNode = 0;
  for (let i = 0; i < n; i++) {
    const s = count[i]! > 0 ? PA_PER_MPA / count[i]! : 0;
    for (let c = 0; c < 6; c++) stress[6 * i + c]! *= s;
    vm[i] = vonMises(stress, 6 * i);
    principalStresses(stress, 6 * i, principal, 3 * i);
    if (vm[i]! > vmPeak) {
      vmPeak = vm[i]!;
      vmNode = i;
    }
    const d = Math.hypot(u[3 * i]!, u[3 * i + 1]!, u[3 * i + 2]!);
    if (d > uPeak) {
      uPeak = d;
      uNode = i;
    }
  }
  const stressMs = ctx.elapsed() - t;

  // Display triangles: every resolved face, with its body and face.
  let nt = 0;
  for (const rf of resolved) nt += rf.opposite.length;
  const triangles = new Uint32Array(6 * nt);
  const triangleFace = new Uint32Array(2 * nt);
  let k = 0;
  for (const rf of resolved) {
    triangles.set(rf.nodes, 6 * k);
    for (let i = 0; i < rf.opposite.length; i++) {
      triangleFace[2 * (k + i)] = rf.body;
      triangleFace[2 * (k + i) + 1] = rf.face;
    }
    k += rf.opposite.length;
  }

  const peak = (value: number, node: number): FeaPeak => ({
    value,
    node,
    at: [mesh.nodes[3 * node]!, mesh.nodes[3 * node + 1]!, mesh.nodes[3 * node + 2]!],
    body: nodeBody[node]!,
  });
  const summary: Omit<FeaSummary, 'estimatedDof' | 'mesherBytes' | 'timings'> = {
    nodes: n,
    elements: ne,
    dof,
    iterations: cg.iterations,
    relativeResidual: cg.relResidual,
    maxVonMises: peak(vmPeak, vmNode),
    maxDisplacement: peak(uPeak, uNode),
    appliedForce,
    worstElementQuality: worst,
    solverBytes: ctx.peak,
    warnings,
  };
  return {
    result: {
      nodes: mesh.nodes,
      elements: mesh.tets,
      elementBody: mesh.tetBody,
      triangles,
      triangleFace,
      displacement: u,
      stress,
      vonMises: vm,
      principal,
      summary: { ...summary, estimatedDof: 0, mesherBytes: 0, timings: emptyTimings() },
    },
    times: {
      prepare,
      assemble: assembleMs,
      precondition: preconditionMs,
      solve: solveMs,
      stress: stressMs,
    },
  };
}

export const emptyTimings = () => ({
  loadMesher: 0,
  import: 0,
  mesh: 0,
  prepare: 0,
  assemble: 0,
  precondition: 0,
  solve: 0,
  stress: 0,
  total: 0,
});
