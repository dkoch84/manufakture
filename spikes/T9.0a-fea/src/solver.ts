// Linear static solve on a TET10 mesh: assembly into a symmetric block-sparse matrix (upper
// triangle of 3x3 node blocks), homogeneous Dirichlet constraints, surface tractions and pressures,
// preconditioned conjugate gradients, and nodal stress recovery by averaging.
//
// Plain TypeScript on typed arrays, no dependencies: it runs in Node and in a browser worker alike.

import { type BoundaryFaces, type TetMesh } from './mesh.ts';
import { elementNodalStress, elementStiffness, lame, type Material, PAIRS } from './tet10.ts';

/** Upper triangle of the stiffness matrix in 3x3 node blocks, rows sorted, diagonal first. */
export interface BlockMatrix {
  n: number; // nodes
  rowPtr: Int32Array;
  cols: Int32Array;
  vals: Float64Array; // 9 per block, row-major
}

export function matrixBytes(a: BlockMatrix): number {
  return a.rowPtr.byteLength + a.cols.byteLength + a.vals.byteLength;
}

/** The block sparsity pattern: for each node, the nodes >= it that share an element. */
export function pattern(mesh: TetMesh): BlockMatrix {
  const n = mesh.nodes.length / 3;
  const { tets } = mesh;
  const ne = tets.length / 10;
  // node -> elements
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < tets.length; i++) deg[tets[i]! + 1]! += 1;
  for (let i = 0; i < n; i++) deg[i + 1]! += deg[i]!;
  const nodeElems = new Int32Array(tets.length);
  const fill = deg.slice(0, n);
  for (let e = 0; e < ne; e++)
    for (let a = 0; a < 10; a++) nodeElems[fill[tets[10 * e + a]!]!++] = e;

  const mark = new Int32Array(n).fill(-1);
  const rowPtr = new Int32Array(n + 1);
  const scratch: number[] = [];
  // First pass: counts.
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let p = deg[i]!; p < deg[i + 1]!; p++) {
      const e = nodeElems[p]!;
      for (let a = 0; a < 10; a++) {
        const j = tets[10 * e + a]!;
        if (j >= i && mark[j] !== i) {
          mark[j] = i;
          c++;
        }
      }
    }
    rowPtr[i + 1] = rowPtr[i]! + c;
  }
  mark.fill(-1);
  const cols = new Int32Array(rowPtr[n]!);
  for (let i = 0; i < n; i++) {
    scratch.length = 0;
    for (let p = deg[i]!; p < deg[i + 1]!; p++) {
      const e = nodeElems[p]!;
      for (let a = 0; a < 10; a++) {
        const j = tets[10 * e + a]!;
        if (j >= i && mark[j] !== i) {
          mark[j] = i;
          scratch.push(j);
        }
      }
    }
    scratch.sort((x, y) => x - y);
    cols.set(scratch, rowPtr[i]!);
  }
  return { n, rowPtr, cols, vals: new Float64Array(9 * cols.length) };
}

function findBlock(a: BlockMatrix, i: number, j: number): number {
  let lo = a.rowPtr[i]!,
    hi = a.rowPtr[i + 1]! - 1;
  const cols = a.cols;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cols[mid]!;
    if (c === j) return mid;
    if (c < j) lo = mid + 1;
    else hi = mid - 1;
  }
  throw new Error(`block (${i}, ${j}) not in pattern`);
}

/**
 * Assemble K. `fixed[3 * node + c]` = 1 for a constrained component (displacement 0): its row
 * and column are dropped and its diagonal set to 1.
 */
export function assemble(
  mesh: TetMesh,
  material: Material,
  fixed: Uint8Array,
  a: BlockMatrix,
): void {
  const { lambda, mu } = lame(material);
  const { nodes, tets } = mesh;
  const ne = tets.length / 10;
  const xe = new Float64Array(30);
  const ke = new Float64Array(9 * PAIRS);
  const vals = a.vals;
  vals.fill(0);
  for (let e = 0; e < ne; e++) {
    const base = 10 * e;
    for (let k = 0; k < 10; k++) {
      const g = tets[base + k]!;
      xe[3 * k] = nodes[3 * g]!;
      xe[3 * k + 1] = nodes[3 * g + 1]!;
      xe[3 * k + 2] = nodes[3 * g + 2]!;
    }
    if (!elementStiffness(xe, lambda, mu, ke)) throw new Error(`element ${e} is inverted`);
    let p = 0;
    for (let i = 0; i < 10; i++) {
      const gi = tets[base + i]!;
      for (let j = i; j < 10; j++, p++) {
        const gj = tets[base + j]!;
        const o = 9 * p;
        // Block (gi, gj) of the element; store as the upper block (min, max), transposing if needed.
        if (gi < gj) {
          const q = 9 * findBlock(a, gi, gj);
          for (let r = 0; r < 3; r++)
            for (let c = 0; c < 3; c++) {
              if (fixed[3 * gi + r] || fixed[3 * gj + c]) continue;
              vals[q + 3 * r + c]! += ke[o + 3 * r + c]!;
            }
        } else if (gi > gj) {
          const q = 9 * findBlock(a, gj, gi);
          for (let r = 0; r < 3; r++)
            for (let c = 0; c < 3; c++) {
              if (fixed[3 * gj + r] || fixed[3 * gi + c]) continue;
              vals[q + 3 * r + c]! += ke[o + 3 * c + r]!;
            }
        } else {
          // Diagonal block from (i, i): ke is the full 3x3 block, symmetric.
          const q = 9 * findBlock(a, gi, gi);
          for (let r = 0; r < 3; r++)
            for (let c = 0; c < 3; c++) {
              if (fixed[3 * gi + r] || fixed[3 * gi + c]) continue;
              const v = ke[o + 3 * r + c]!;
              // A pair (i, j) with i != j but the same global node cannot happen; (i, i) appears once.
              vals[q + 3 * r + c]! += v;
            }
        }
      }
    }
  }
  for (let i = 0; i < a.n; i++) {
    const q = 9 * a.rowPtr[i]!; // diagonal block is first
    for (let c = 0; c < 3; c++) if (fixed[3 * i + c]) vals[q + 4 * c] = 1;
  }
}

/** y = A x */
export function multiply(a: BlockMatrix, x: Float64Array, y: Float64Array): void {
  const { n, rowPtr, cols, vals } = a;
  y.fill(0);
  for (let i = 0; i < n; i++) {
    const xi0 = x[3 * i]!,
      xi1 = x[3 * i + 1]!,
      xi2 = x[3 * i + 2]!;
    let p = rowPtr[i]!;
    const end = rowPtr[i + 1]!;
    // diagonal block (full, symmetric)
    let q = 9 * p;
    let s0 = vals[q]! * xi0 + vals[q + 1]! * xi1 + vals[q + 2]! * xi2;
    let s1 = vals[q + 3]! * xi0 + vals[q + 4]! * xi1 + vals[q + 5]! * xi2;
    let s2 = vals[q + 6]! * xi0 + vals[q + 7]! * xi1 + vals[q + 8]! * xi2;
    for (p++; p < end; p++) {
      const j = cols[p]!;
      q = 9 * p;
      const b0 = vals[q]!,
        b1 = vals[q + 1]!,
        b2 = vals[q + 2]!,
        b3 = vals[q + 3]!,
        b4 = vals[q + 4]!,
        b5 = vals[q + 5]!,
        b6 = vals[q + 6]!,
        b7 = vals[q + 7]!,
        b8 = vals[q + 8]!;
      const xj0 = x[3 * j]!,
        xj1 = x[3 * j + 1]!,
        xj2 = x[3 * j + 2]!;
      s0 += b0 * xj0 + b1 * xj1 + b2 * xj2;
      s1 += b3 * xj0 + b4 * xj1 + b5 * xj2;
      s2 += b6 * xj0 + b7 * xj1 + b8 * xj2;
      y[3 * j]! += b0 * xi0 + b3 * xi1 + b6 * xi2;
      y[3 * j + 1]! += b1 * xi0 + b4 * xi1 + b7 * xi2;
      y[3 * j + 2]! += b2 * xi0 + b5 * xi1 + b8 * xi2;
    }
    y[3 * i]! += s0;
    y[3 * i + 1]! += s1;
    y[3 * i + 2]! += s2;
  }
}

// Preconditioners ----------------------------------------------------------------------------

export interface Preconditioner {
  name: string;
  bytes: number;
  setupMs: number;
  apply(r: Float64Array, z: Float64Array): void;
}

export function jacobi(a: BlockMatrix): Preconditioner {
  const t = performance.now();
  const inv = new Float64Array(3 * a.n);
  for (let i = 0; i < a.n; i++) {
    const q = 9 * a.rowPtr[i]!;
    for (let c = 0; c < 3; c++) inv[3 * i + c] = 1 / a.vals[q + 4 * c]!;
  }
  return {
    name: 'jacobi',
    bytes: inv.byteLength,
    setupMs: performance.now() - t,
    apply(r, z) {
      for (let k = 0; k < inv.length; k++) z[k] = inv[k]! * r[k]!;
    },
  };
}

export function blockJacobi(a: BlockMatrix): Preconditioner {
  const t = performance.now();
  const inv = new Float64Array(9 * a.n);
  for (let i = 0; i < a.n; i++) {
    const q = 9 * a.rowPtr[i]!;
    const m = a.vals;
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = [
      m[q]!,
      m[q + 1]!,
      m[q + 2]!,
      m[q + 3]!,
      m[q + 4]!,
      m[q + 5]!,
      m[q + 6]!,
      m[q + 7]!,
      m[q + 8]!,
    ];
    const c0 = m4 * m8 - m5 * m7,
      c1 = m5 * m6 - m3 * m8,
      c2 = m3 * m7 - m4 * m6;
    const id = 1 / (m0 * c0 + m1 * c1 + m2 * c2);
    const o = 9 * i;
    inv[o] = c0 * id;
    inv[o + 1] = (m2 * m7 - m1 * m8) * id;
    inv[o + 2] = (m1 * m5 - m2 * m4) * id;
    inv[o + 3] = c1 * id;
    inv[o + 4] = (m0 * m8 - m2 * m6) * id;
    inv[o + 5] = (m2 * m3 - m0 * m5) * id;
    inv[o + 6] = c2 * id;
    inv[o + 7] = (m1 * m6 - m0 * m7) * id;
    inv[o + 8] = (m0 * m4 - m1 * m3) * id;
  }
  return {
    name: 'block-jacobi',
    bytes: inv.byteLength,
    setupMs: performance.now() - t,
    apply(r, z) {
      for (let i = 0; i < a.n; i++) {
        const o = 9 * i,
          r0 = r[3 * i]!,
          r1 = r[3 * i + 1]!,
          r2 = r[3 * i + 2]!;
        z[3 * i] = inv[o]! * r0 + inv[o + 1]! * r1 + inv[o + 2]! * r2;
        z[3 * i + 1] = inv[o + 3]! * r0 + inv[o + 4]! * r1 + inv[o + 5]! * r2;
        z[3 * i + 2] = inv[o + 6]! * r0 + inv[o + 7]! * r1 + inv[o + 8]! * r2;
      }
    },
  };
}

/**
 * Incomplete Cholesky, no fill (IC(0)), on the scalar matrix with the block pattern: A ~ U^T U.
 * On breakdown (a non-positive pivot) it retries on A + alpha diag(A) with a growing alpha.
 */
export function ic0(a: BlockMatrix): Preconditioner & { shift: number } {
  const t = performance.now();
  const N = 3 * a.n;
  // Scalar upper CSR from the block upper triangle. Row 3i+r: diagonal block columns 3i+c (c >= r),
  // then each off-diagonal block's 3 columns.
  const rowPtr = new Int32Array(N + 1);
  for (let i = 0; i < a.n; i++) {
    const off = a.rowPtr[i + 1]! - a.rowPtr[i]! - 1;
    for (let r = 0; r < 3; r++) rowPtr[3 * i + r + 1] = rowPtr[3 * i + r]! + (3 - r) + 3 * off;
  }
  const nnz = rowPtr[N]!;
  const cols = new Int32Array(nnz);
  const base = new Float64Array(nnz);
  for (let i = 0; i < a.n; i++) {
    for (let r = 0; r < 3; r++) {
      let p = rowPtr[3 * i + r]!;
      const qd = 9 * a.rowPtr[i]!;
      for (let c = r; c < 3; c++) {
        cols[p] = 3 * i + c;
        base[p++] = a.vals[qd + 3 * r + c]!;
      }
      for (let b = a.rowPtr[i]! + 1; b < a.rowPtr[i + 1]!; b++) {
        const j = a.cols[b]!,
          q = 9 * b;
        for (let c = 0; c < 3; c++) {
          cols[p] = 3 * j + c;
          base[p++] = a.vals[q + 3 * r + c]!;
        }
      }
    }
  }
  const vals = new Float64Array(nnz);
  const markRow = new Int32Array(N).fill(-1);
  const markPos = new Int32Array(N);

  const factor = (shift: number): boolean => {
    vals.set(base);
    if (shift > 0) for (let i = 0; i < N; i++) vals[rowPtr[i]!]! *= 1 + shift;
    for (let i = 0; i < N; i++) {
      const pd = rowPtr[i]!,
        end = rowPtr[i + 1]!;
      const d = vals[pd]!;
      if (!(d > 0)) return false;
      const sd = Math.sqrt(d);
      vals[pd] = sd;
      const inv = 1 / sd;
      for (let p = pd + 1; p < end; p++) vals[p]! *= inv;
      for (let p = pd + 1; p < end; p++) {
        const j = cols[p]!,
          uij = vals[p]!;
        if (uij === 0) continue;
        const jEnd = rowPtr[j + 1]!;
        for (let q = rowPtr[j]!; q < jEnd; q++) {
          markRow[cols[q]!] = j;
          markPos[cols[q]!] = q;
        }
        for (let p2 = p; p2 < end; p2++) {
          const k = cols[p2]!;
          if (markRow[k] === j) vals[markPos[k]!]! -= uij * vals[p2]!;
        }
      }
    }
    return true;
  };
  let shift = 0;
  while (!factor(shift)) {
    shift = shift === 0 ? 1e-3 : shift * 4;
    if (shift > 1) throw new Error('IC(0) broke down');
  }
  return {
    name: 'ic0',
    shift,
    bytes:
      rowPtr.byteLength +
      cols.byteLength +
      vals.byteLength +
      base.byteLength +
      markRow.byteLength +
      markPos.byteLength,
    setupMs: performance.now() - t,
    apply(r, z) {
      // U^T y = r (forward, by scattering rows of U), then U z = y (backward).
      z.set(r);
      for (let i = 0; i < N; i++) {
        const pd = rowPtr[i]!,
          end = rowPtr[i + 1]!;
        const yi = z[i]! / vals[pd]!;
        z[i] = yi;
        for (let p = pd + 1; p < end; p++) z[cols[p]!]! -= vals[p]! * yi;
      }
      for (let i = N - 1; i >= 0; i--) {
        const pd = rowPtr[i]!,
          end = rowPtr[i + 1]!;
        let s = z[i]!;
        for (let p = pd + 1; p < end; p++) s -= vals[p]! * z[cols[p]!]!;
        z[i] = s / vals[pd]!;
      }
    },
  };
}

// Conjugate gradients -------------------------------------------------------------------------

export interface CgResult {
  x: Float64Array;
  iterations: number;
  relResidual: number;
  ms: number;
}

/** Conjugate gradients on `op` (y = A x), preconditioned by m, to ||r|| <= tol ||b||. */
export function pcg(
  op: (x: Float64Array, y: Float64Array) => void,
  b: Float64Array,
  m: Preconditioner,
  tol = 1e-8,
  maxIt = 20000,
): CgResult {
  const t = performance.now();
  const N = b.length;
  const x = new Float64Array(N);
  const r = b.slice();
  const z = new Float64Array(N);
  const p = new Float64Array(N);
  const q = new Float64Array(N);
  let bn = 0;
  for (let i = 0; i < N; i++) bn += b[i]! * b[i]!;
  bn = Math.sqrt(bn);
  m.apply(r, z);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < N; i++) rz += r[i]! * z[i]!;
  let it = 0,
    rn = bn;
  while (it < maxIt) {
    op(p, q);
    let pq = 0;
    for (let i = 0; i < N; i++) pq += p[i]! * q[i]!;
    const alpha = rz / pq;
    rn = 0;
    for (let i = 0; i < N; i++) {
      x[i]! += alpha * p[i]!;
      r[i]! -= alpha * q[i]!;
      rn += r[i]! * r[i]!;
    }
    rn = Math.sqrt(rn);
    it++;
    if (rn <= tol * bn) break;
    m.apply(r, z);
    let rz2 = 0;
    for (let i = 0; i < N; i++) rz2 += r[i]! * z[i]!;
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < N; i++) p[i] = z[i]! + beta * p[i]!;
  }
  return { x, iterations: it, relResidual: rn / bn, ms: performance.now() - t };
}

// Loads ---------------------------------------------------------------------------------------

// 6-point Dunavant rule on the reference triangle (degree 4), weights summing to 1/2.
const TRI_Q: readonly (readonly [number, number, number])[] = (() => {
  const a1 = 0.445948490915965,
    w1 = 0.223381589678011 / 2;
  const a2 = 0.091576213509771,
    w2 = 0.109951743655322 / 2;
  return [
    [a1, a1, w1],
    [1 - 2 * a1, a1, w1],
    [a1, 1 - 2 * a1, w1],
    [a2, a2, w2],
    [1 - 2 * a2, a2, w2],
    [a2, 1 - 2 * a2, w2],
  ];
})();

/** A load on boundary faces whose three corners pass `where`: a traction (N/mm^2) or a pressure (MPa, into the body). */
export interface SurfaceLoad {
  where: (x: number, y: number, z: number) => boolean;
  traction?: [number, number, number];
  pressure?: number;
}

/** Add consistent nodal forces of surface loads to f. Returns the total force applied. */
export function applySurfaceLoads(
  mesh: TetMesh,
  faces: BoundaryFaces,
  loads: SurfaceLoad[],
  f: Float64Array,
): [number, number, number] {
  const X = mesh.nodes;
  const total: [number, number, number] = [0, 0, 0];
  const nf = faces.opposite.length;
  const xs = new Float64Array(18);
  for (let k = 0; k < nf; k++) {
    for (let a = 0; a < 6; a++) {
      const g = faces.nodes[6 * k + a]!;
      xs[3 * a] = X[3 * g]!;
      xs[3 * a + 1] = X[3 * g + 1]!;
      xs[3 * a + 2] = X[3 * g + 2]!;
    }
    const load = loads.find((l) => [0, 3, 6].every((o) => l.where(xs[o]!, xs[o + 1]!, xs[o + 2]!)));
    if (!load) continue;
    // Outward sign from the opposite corner.
    const o = faces.opposite[k]!;
    const e1 = [xs[3]! - xs[0]!, xs[4]! - xs[1]!, xs[5]! - xs[2]!];
    const e2 = [xs[6]! - xs[0]!, xs[7]! - xs[1]!, xs[8]! - xs[2]!];
    const nrm = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const toOpp = [X[3 * o]! - xs[0]!, X[3 * o + 1]! - xs[1]!, X[3 * o + 2]! - xs[2]!];
    const sign = nrm[0]! * toOpp[0]! + nrm[1]! * toOpp[1]! + nrm[2]! * toOpp[2]! > 0 ? -1 : 1;
    for (const [u, v, w] of TRI_Q) {
      const L0 = 1 - u - v,
        L1 = u,
        L2 = v;
      const N = [
        L0 * (2 * L0 - 1),
        L1 * (2 * L1 - 1),
        L2 * (2 * L2 - 1),
        4 * L0 * L1,
        4 * L1 * L2,
        4 * L0 * L2,
      ];
      const dNu = [-(4 * L0 - 1), 4 * L1 - 1, 0, 4 * (L0 - L1), 4 * L2, -4 * L2];
      const dNv = [-(4 * L0 - 1), 0, 4 * L2 - 1, -4 * L1, 4 * L1, 4 * (L0 - L2)];
      const tu = [0, 0, 0],
        tv = [0, 0, 0];
      for (let a = 0; a < 6; a++)
        for (let c = 0; c < 3; c++) {
          tu[c]! += dNu[a]! * xs[3 * a + c]!;
          tv[c]! += dNv[a]! * xs[3 * a + c]!;
        }
      // Area vector, outward.
      const av = [
        sign * (tu[1]! * tv[2]! - tu[2]! * tv[1]!),
        sign * (tu[2]! * tv[0]! - tu[0]! * tv[2]!),
        sign * (tu[0]! * tv[1]! - tu[1]! * tv[0]!),
      ];
      const area = Math.hypot(av[0]!, av[1]!, av[2]!);
      const force =
        load.pressure !== undefined
          ? av.map((c) => -load.pressure! * c)
          : load.traction!.map((c) => c * area);
      for (let a = 0; a < 6; a++) {
        const g = faces.nodes[6 * k + a]!;
        for (let c = 0; c < 3; c++) {
          const fc = N[a]! * force[c]! * w;
          f[3 * g + c]! += fc;
          total[c]! += fc;
        }
      }
    }
  }
  return total;
}

/** Fix components of nodes passing `where`. */
export function fixNodes(
  mesh: TetMesh,
  fixed: Uint8Array,
  where: (x: number, y: number, z: number) => boolean,
  comps: readonly number[] = [0, 1, 2],
): number {
  const X = mesh.nodes;
  let count = 0;
  for (let i = 0; i < X.length / 3; i++) {
    if (where(X[3 * i]!, X[3 * i + 1]!, X[3 * i + 2]!)) {
      for (const c of comps) fixed[3 * i + c] = 1;
      count++;
    }
  }
  return count;
}

/** Nodal stresses (6 per node, Voigt xx yy zz yz xz xy), averaged over the elements at each node. */
export function nodalStress(mesh: TetMesh, material: Material, u: Float64Array): Float64Array {
  const { lambda, mu } = lame(material);
  const { nodes, tets } = mesh;
  const n = nodes.length / 3,
    ne = tets.length / 10;
  const sum = new Float64Array(6 * n);
  const cnt = new Float64Array(n);
  const xe = new Float64Array(30),
    ue = new Float64Array(30),
    se = new Float64Array(60);
  for (let e = 0; e < ne; e++) {
    for (let k = 0; k < 10; k++) {
      const g = tets[10 * e + k]!;
      for (let c = 0; c < 3; c++) {
        xe[3 * k + c] = nodes[3 * g + c]!;
        ue[3 * k + c] = u[3 * g + c]!;
      }
    }
    elementNodalStress(xe, ue, lambda, mu, se);
    for (let k = 0; k < 10; k++) {
      const g = tets[10 * e + k]!;
      for (let c = 0; c < 6; c++) sum[6 * g + c]! += se[6 * k + c]!;
      cnt[g]! += 1;
    }
  }
  for (let i = 0; i < n; i++) for (let c = 0; c < 6; c++) sum[6 * i + c]! /= cnt[i]!;
  return sum;
}
