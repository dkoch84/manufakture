// Preconditioned conjugate gradients (from the T9.0a spike's solver.ts), checking the run context
// between iterations so a cancel or the time limit stops it, and reporting progress.

import { FeaAbort, type RunContext } from './context';

export interface Preconditioner {
  name: string;
  bytes: number;
  setupMs: number;
  apply(r: Float64Array, z: Float64Array): void;
}

export interface CgResult {
  x: Float64Array;
  iterations: number;
  relResidual: number;
}

/**
 * Conjugate gradients on `op` (y = A x), preconditioned by m, to ||r|| <= tol ||b||. A curvature
 * that is not positive means the matrix is singular (a body free to move) and is reported as
 * unconstrained; running out of iterations is `not-converged`.
 */
export function pcg(
  op: (x: Float64Array, y: Float64Array) => void,
  b: Float64Array,
  m: Preconditioner,
  ctx: RunContext,
  tol = 1e-8,
  maxIt = 2000,
): CgResult {
  const N = b.length;
  ctx.use(5 * 8 * N, 'the solver vectors');
  const x = new Float64Array(N);
  const r = b.slice();
  const z = new Float64Array(N);
  const p = new Float64Array(N);
  const q = new Float64Array(N);
  let bn = 0;
  for (let i = 0; i < N; i++) bn += b[i]! * b[i]!;
  bn = Math.sqrt(bn);
  if (bn === 0) return { x, iterations: 0, relResidual: 0 };
  m.apply(r, z);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < N; i++) rz += r[i]! * z[i]!;
  let it = 0,
    rn = bn;
  while (it < maxIt) {
    ctx.check();
    op(p, q);
    let pq = 0;
    for (let i = 0; i < N; i++) pq += p[i]! * q[i]!;
    if (!(pq > 0) || !Number.isFinite(rz)) {
      throw new FeaAbort({
        code: 'unconstrained',
        message:
          'The stiffness matrix is singular: some part can move without resistance. Add fixtures so every body is held in x, y and z and cannot rotate.',
        bodies: [],
      });
    }
    const alpha = rz / pq;
    rn = 0;
    for (let i = 0; i < N; i++) {
      x[i]! += alpha * p[i]!;
      r[i]! -= alpha * q[i]!;
      rn += r[i]! * r[i]!;
    }
    rn = Math.sqrt(rn);
    it++;
    ctx.report({ iteration: it, residual: rn / bn });
    if (rn <= tol * bn) break;
    m.apply(r, z);
    let rz2 = 0;
    for (let i = 0; i < N; i++) rz2 += r[i]! * z[i]!;
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < N; i++) p[i] = z[i]! + beta * p[i]!;
  }
  if (!(rn <= tol * bn)) {
    throw new FeaAbort({
      code: 'not-converged',
      message: `The solver did not converge in ${it} iterations (relative residual ${(rn / bn).toExponential(2)}). The model may be nearly unconstrained or the mesh badly shaped.`,
      iterations: it,
      residual: rn / bn,
    });
  }
  ctx.release(4 * 8 * N);
  return { x, iterations: it, relResidual: rn / bn };
}
