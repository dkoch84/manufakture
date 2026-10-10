// Smoothed-aggregation algebraic multigrid (Vanek, Mandel, Brezina 1996) for linear elasticity,
// used as a preconditioner for conjugate gradients: a symmetric V-cycle with Chebyshev smoothing,
// rigid body modes as the near-null space, and a dense Cholesky solve on the coarsest level.
//
// Matrices are block sparse rows (BSR) with full storage and blocks of r x c doubles: 3 x 3 on
// the mesh, 6 x 6 on the coarse levels (six rigid body modes per aggregate). Taken over from the
// T9.0a spike (spikes/T9.0a-fea/src/amg.ts), with the memory account and cancellation added.

import type { Preconditioner } from './cg';
import type { RunContext } from './context';
import type { BlockMatrix } from './matrix';

export interface Bsr {
  /** Block rows and block columns. */
  nr: number;
  nc: number;
  /** Block shape. */
  r: number;
  c: number;
  rowPtr: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
}

export const bsrBytes = (a: Bsr) => a.rowPtr.byteLength + a.cols.byteLength + a.vals.byteLength;

/** Full 3x3 BSR from the solver's upper-triangle storage. */
export function fullFromUpper(a: BlockMatrix, ctx?: RunContext): Bsr {
  const n = a.n;
  const count = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    count[i + 1]! += a.rowPtr[i + 1]! - a.rowPtr[i]!;
    for (let p = a.rowPtr[i]! + 1; p < a.rowPtr[i + 1]!; p++) count[a.cols[p]! + 1]! += 1;
  }
  for (let i = 0; i < n; i++) count[i + 1]! += count[i]!;
  ctx?.use(rowPtr_bytes(n, count[n]!), 'the full stiffness matrix');
  const rowPtr = count.slice();
  const fill = count.slice(0, n);
  const cols = new Int32Array(rowPtr[n]!);
  const vals = new Float64Array(9 * cols.length);
  // Lower blocks first (they come from rows i < row), then the row's own upper blocks: rows stay sorted.
  for (let i = 0; i < n; i++) {
    for (let p = a.rowPtr[i]! + 1; p < a.rowPtr[i + 1]!; p++) {
      const j = a.cols[p]!;
      const q = fill[j]!++;
      cols[q] = i;
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) vals[9 * q + 3 * r + c] = a.vals[9 * p + 3 * c + r]!;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) {
      const q = fill[i]!++;
      cols[q] = a.cols[p]!;
      vals.set(a.vals.subarray(9 * p, 9 * p + 9), 9 * q);
    }
  }
  return { nr: n, nc: n, r: 3, c: 3, rowPtr, cols, vals };
}

const rowPtr_bytes = (rows: number, blocks: number, bb = 9): number =>
  4 * (rows + 1) + blocks * (4 + 8 * bb);

/** y = A x */
export function spmv(a: Bsr, x: Float64Array, y: Float64Array): void {
  const { nr, r, c, rowPtr, cols, vals } = a;
  if (r === 3 && c === 3) {
    for (let i = 0; i < nr; i++) {
      let s0 = 0,
        s1 = 0,
        s2 = 0;
      for (let p = rowPtr[i]!; p < rowPtr[i + 1]!; p++) {
        const j = 3 * cols[p]!,
          q = 9 * p;
        const x0 = x[j]!,
          x1 = x[j + 1]!,
          x2 = x[j + 2]!;
        s0 += vals[q]! * x0 + vals[q + 1]! * x1 + vals[q + 2]! * x2;
        s1 += vals[q + 3]! * x0 + vals[q + 4]! * x1 + vals[q + 5]! * x2;
        s2 += vals[q + 6]! * x0 + vals[q + 7]! * x1 + vals[q + 8]! * x2;
      }
      y[3 * i] = s0;
      y[3 * i + 1] = s1;
      y[3 * i + 2] = s2;
    }
    return;
  }
  const rc = r * c;
  for (let i = 0; i < nr; i++) {
    for (let k = 0; k < r; k++) y[r * i + k] = 0;
    for (let p = rowPtr[i]!; p < rowPtr[i + 1]!; p++) {
      const j = c * cols[p]!,
        q = rc * p;
      for (let k = 0; k < r; k++) {
        let s = 0;
        for (let l = 0; l < c; l++) s += vals[q + c * k + l]! * x[j + l]!;
        y[r * i + k]! += s;
      }
    }
  }
}

export function transpose(a: Bsr): Bsr {
  const { nr, nc, r, c } = a;
  const rc = r * c;
  const rowPtr = new Int32Array(nc + 1);
  for (let p = 0; p < a.cols.length; p++) rowPtr[a.cols[p]! + 1]! += 1;
  for (let j = 0; j < nc; j++) rowPtr[j + 1]! += rowPtr[j]!;
  const fill = rowPtr.slice(0, nc);
  const cols = new Int32Array(a.cols.length);
  const vals = new Float64Array(a.vals.length);
  for (let i = 0; i < nr; i++)
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) {
      const q = fill[a.cols[p]!]!++;
      cols[q] = i;
      for (let k = 0; k < r; k++)
        for (let l = 0; l < c; l++) vals[rc * q + r * l + k] = a.vals[rc * p + c * k + l]!;
    }
  return { nr: nc, nc: nr, r: c, c: r, rowPtr, cols, vals };
}

/** C = A B (A: r x k blocks, B: k x c blocks). */
export function multiplyBsr(a: Bsr, b: Bsr, ctx?: RunContext): Bsr {
  if (a.c !== b.r || a.nc !== b.nr) throw new Error('shape mismatch');
  const r = a.r,
    k = a.c,
    c = b.c;
  const marker = new Int32Array(b.nc).fill(-1);
  const rowPtr = new Int32Array(a.nr + 1);
  for (let i = 0; i < a.nr; i++) {
    let n = 0;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) {
      const j = a.cols[p]!;
      for (let q = b.rowPtr[j]!; q < b.rowPtr[j + 1]!; q++) {
        const l = b.cols[q]!;
        if (marker[l] !== i) {
          marker[l] = i;
          n++;
        }
      }
    }
    rowPtr[i + 1] = rowPtr[i]! + n;
  }
  ctx?.use(rowPtr_bytes(a.nr, rowPtr[a.nr]!, r * c), 'the multigrid setup');
  ctx?.check();
  const cols = new Int32Array(rowPtr[a.nr]!);
  const vals = new Float64Array(r * c * cols.length);
  marker.fill(-1);
  const where = new Int32Array(b.nc);
  const rk = r * k,
    kc = k * c,
    rc = r * c;
  for (let i = 0; i < a.nr; i++) {
    let next = rowPtr[i]!;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) {
      const j = a.cols[p]!,
        ao = rk * p;
      for (let q = b.rowPtr[j]!; q < b.rowPtr[j + 1]!; q++) {
        const l = b.cols[q]!,
          bo = kc * q;
        let pos: number;
        if (marker[l] !== i) {
          marker[l] = i;
          pos = next++;
          where[l] = pos;
          cols[pos] = l;
        } else pos = where[l]!;
        const co = rc * pos;
        const av = a.vals,
          bv = b.vals;
        if (k === 3) {
          // The common case (mesh level): unrolled over the shared dimension.
          for (let x = 0; x < r; x++) {
            const a0 = av[ao + 3 * x]!,
              a1 = av[ao + 3 * x + 1]!,
              a2 = av[ao + 3 * x + 2]!;
            const o = co + c * x;
            for (let z = 0; z < c; z++)
              vals[o + z]! += a0 * bv[bo + z]! + a1 * bv[bo + c + z]! + a2 * bv[bo + 2 * c + z]!;
          }
        } else {
          for (let x = 0; x < r; x++)
            for (let y = 0; y < k; y++) {
              const v = av[ao + k * x + y]!;
              const o = co + c * x,
                bo2 = bo + c * y;
              for (let z = 0; z < c; z++) vals[o + z]! += v * bv[bo2 + z]!;
            }
        }
      }
    }
  }
  // Rows are left unsorted: nothing downstream needs sorted columns.
  return { nr: a.nr, nc: b.nc, r, c, rowPtr, cols, vals };
}

/** Inverse of a small dense matrix (Gauss-Jordan, partial pivoting); a zero pivot row becomes identity. */
function invert(m: Float64Array, n: number, out: Float64Array): void {
  const a = Float64Array.from(m);
  out.fill(0);
  for (let i = 0; i < n; i++) out[n * i + i] = 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[n * r + col]!) > Math.abs(a[n * piv + col]!)) piv = r;
    if (Math.abs(a[n * piv + col]!) < 1e-300) continue;
    if (piv !== col)
      for (let k = 0; k < n; k++) {
        [a[n * col + k], a[n * piv + k]] = [a[n * piv + k]!, a[n * col + k]!];
        [out[n * col + k], out[n * piv + k]] = [out[n * piv + k]!, out[n * col + k]!];
      }
    const d = 1 / a[n * col + col]!;
    for (let k = 0; k < n; k++) {
      a[n * col + k]! *= d;
      out[n * col + k]! *= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[n * r + col]!;
      if (f === 0) continue;
      for (let k = 0; k < n; k++) {
        a[n * r + k]! -= f * a[n * col + k]!;
        out[n * r + k]! -= f * out[n * col + k]!;
      }
    }
  }
}

/** Inverses of the diagonal blocks. */
function diagonalInverse(a: Bsr): Float64Array {
  const b = a.r,
    bb = b * b;
  const inv = new Float64Array(bb * a.nr);
  const tmp = new Float64Array(bb);
  for (let i = 0; i < a.nr; i++) {
    let found = false;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++)
      if (a.cols[p] === i) {
        invert(a.vals.subarray(bb * p, bb * p + bb), b, tmp);
        found = true;
        break;
      }
    if (!found) for (let k = 0; k < b; k++) tmp[b * k + k] = 1;
    inv.set(tmp, bb * i);
  }
  return inv;
}

function applyBlockDiag(inv: Float64Array, b: number, x: Float64Array, y: Float64Array): void {
  const n = x.length / b,
    bb = b * b;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < b; k++) {
      let s = 0;
      for (let l = 0; l < b; l++) s += inv[bb * i + b * k + l]! * x[b * i + l]!;
      y[b * i + k] = s;
    }
}

/** Largest eigenvalue of D^-1 A, by power iteration. */
function lambdaMax(a: Bsr, dinv: Float64Array, iterations = 15): number {
  const N = a.nr * a.r;
  let x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(i * 12.9898 + 1) * 0.5 + 0.5;
  const y = new Float64Array(N),
    z = new Float64Array(N);
  let lam = 1;
  for (let it = 0; it < iterations; it++) {
    spmv(a, x, y);
    applyBlockDiag(dinv, a.r, y, z);
    let nz = 0,
      nx = 0;
    for (let i = 0; i < N; i++) {
      nz += z[i]! * z[i]!;
      nx += x[i]! * x[i]!;
    }
    lam = Math.sqrt(nz / nx);
    const s = 1 / Math.sqrt(nz);
    for (let i = 0; i < N; i++) z[i]! *= s;
    x = z.slice();
  }
  return lam;
}

/** Strength-based aggregation (Vanek's three passes). Returns aggregate per block row, -1 if isolated. */
function aggregate(a: Bsr, theta: number): { agg: Int32Array; count: number } {
  const n = a.nr,
    bb = a.r * a.c;
  const norm = new Float64Array(a.cols.length);
  const dn = new Float64Array(n);
  for (let i = 0; i < n; i++)
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) {
      let s = 0;
      for (let k = 0; k < bb; k++) s += a.vals[bb * p + k]! ** 2;
      norm[p] = Math.sqrt(s);
      if (a.cols[p] === i) dn[i] = norm[p]!;
    }
  const strong = (i: number, p: number) => {
    const j = a.cols[p]!;
    return j !== i && norm[p]! > theta * Math.sqrt(dn[i]! * dn[j]!) && norm[p]! > 0;
  };
  const agg = new Int32Array(n).fill(-2); // -2 unassigned, -1 isolated
  let count = 0;
  for (let i = 0; i < n; i++) {
    let any = false;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) if (strong(i, p)) any = true;
    if (!any) agg[i] = -1;
  }
  // Pass 1: a root and its strong neighbours, when none of them is taken.
  for (let i = 0; i < n; i++) {
    if (agg[i] !== -2) continue;
    let free = true;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++)
      if (strong(i, p) && agg[a.cols[p]!] !== -2) free = false;
    if (!free) continue;
    agg[i] = count;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++) if (strong(i, p)) agg[a.cols[p]!] = count;
    count++;
  }
  // Pass 2: join the aggregate of the strongest aggregated neighbour.
  const pass2 = agg.slice();
  for (let i = 0; i < n; i++) {
    if (agg[i] !== -2) continue;
    let best = -1,
      bestN = -1;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++)
      if (strong(i, p) && agg[a.cols[p]!]! >= 0 && norm[p]! > bestN) {
        bestN = norm[p]!;
        best = agg[a.cols[p]!]!;
      }
    if (best >= 0) pass2[i] = best;
  }
  agg.set(pass2);
  // Pass 3: whatever is left forms aggregates with its unassigned strong neighbours.
  for (let i = 0; i < n; i++) {
    if (agg[i] !== -2) continue;
    agg[i] = count;
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++)
      if (strong(i, p) && agg[a.cols[p]!] === -2) agg[a.cols[p]!] = count;
    count++;
  }
  return { agg, count };
}

/**
 * Tentative prolongator from aggregates and the near-null space B (b x m per block row, row-major
 * by dof): per aggregate, B restricted to it = Q R; Q becomes the prolongator's block column, R
 * the coarse near-null space.
 */
function tentative(
  agg: Int32Array,
  count: number,
  b: number,
  m: number,
  B: Float64Array,
): { T: Bsr; Bc: Float64Array } {
  const n = agg.length;
  const members: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < n; i++) if (agg[i]! >= 0) members[agg[i]!]!.push(i);
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i]! + (agg[i]! >= 0 ? 1 : 0);
  const cols = new Int32Array(rowPtr[n]!);
  const vals = new Float64Array(b * m * cols.length);
  const Bc = new Float64Array(count * m * m);
  for (let g = 0; g < count; g++) {
    const rows = members[g]!;
    const R = rows.length * b;
    // Local copy, column-major for Gram-Schmidt.
    const Q = new Float64Array(R * m);
    rows.forEach((node, t) => {
      for (let k = 0; k < b; k++)
        for (let c = 0; c < m; c++) Q[c * R + t * b + k] = B[(node * b + k) * m + c]!;
    });
    const Rm = new Float64Array(m * m);
    for (let c = 0; c < m; c++) {
      let n0 = 0;
      for (let t = 0; t < R; t++) n0 += Q[c * R + t]! ** 2;
      n0 = Math.sqrt(n0);
      for (let d = 0; d < c; d++) {
        let dot = 0;
        for (let t = 0; t < R; t++) dot += Q[d * R + t]! * Q[c * R + t]!;
        Rm[d * m + c] = dot;
        for (let t = 0; t < R; t++) Q[c * R + t]! -= dot * Q[d * R + t]!;
      }
      let nc = 0;
      for (let t = 0; t < R; t++) nc += Q[c * R + t]! ** 2;
      nc = Math.sqrt(nc);
      if (nc <= 1e-10 * Math.max(n0, 1e-300) || nc === 0) {
        for (let t = 0; t < R; t++) Q[c * R + t] = 0;
        Rm[c * m + c] = 0;
      } else {
        for (let t = 0; t < R; t++) Q[c * R + t]! /= nc;
        Rm[c * m + c] = nc;
      }
    }
    Bc.set(Rm, g * m * m);
    rows.forEach((node, t) => {
      const p = rowPtr[node]!;
      cols[p] = g;
      for (let k = 0; k < b; k++)
        for (let c = 0; c < m; c++) vals[b * m * p + m * k + c] = Q[c * R + t * b + k]!;
    });
  }
  return { T: { nr: n, nc: count, r: b, c: m, rowPtr, cols, vals }, Bc };
}

/** P = T - omega D^-1 A T */
function smooth(a: Bsr, dinv: Float64Array, T: Bsr, omega: number, ctx?: RunContext): Bsr {
  const AT = multiplyBsr(a, T, ctx);
  const b = a.r,
    m = T.c,
    bm = b * m,
    bb = b * b;
  const tmp = new Float64Array(bm);
  for (let i = 0; i < AT.nr; i++) {
    for (let p = AT.rowPtr[i]!; p < AT.rowPtr[i + 1]!; p++) {
      const o = bm * p;
      for (let k = 0; k < b; k++)
        for (let c = 0; c < m; c++) {
          let s = 0;
          for (let l = 0; l < b; l++) s += dinv[bb * i + b * k + l]! * AT.vals[o + m * l + c]!;
          tmp[m * k + c] = -omega * s;
        }
      // Add T's block if it has one here.
      if (T.rowPtr[i + 1]! > T.rowPtr[i]! && T.cols[T.rowPtr[i]!] === AT.cols[p]) {
        const to = bm * T.rowPtr[i]!;
        for (let k = 0; k < bm; k++) tmp[k]! += T.vals[to + k]!;
      }
      AT.vals.set(tmp, o);
    }
  }
  return AT;
}

/** Decouple dofs whose diagonal is zero (a mode the tentative prolongator dropped): set it to 1. */
function fixZeroDiagonal(a: Bsr): void {
  const b = a.r,
    bb = b * b;
  for (let i = 0; i < a.nr; i++)
    for (let p = a.rowPtr[i]!; p < a.rowPtr[i + 1]!; p++)
      if (a.cols[p] === i)
        for (let k = 0; k < b; k++)
          if (Math.abs(a.vals[bb * p + b * k + k]!) < 1e-14) a.vals[bb * p + b * k + k] = 1;
}

interface Level {
  A: Bsr;
  P?: Bsr;
  R?: Bsr;
  dinv: Float64Array;
  lmax: number;
  // work vectors
  x: Float64Array;
  b: Float64Array;
  r: Float64Array;
  d: Float64Array;
  t: Float64Array;
}

export interface AmgOptions {
  theta?: number;
  coarsest?: number;
  chebyshevDegree?: number;
}

/** Rigid body modes at each node (3 dofs x 6 modes), zero on fixed dofs; coordinates centred and scaled. */
export function rigidBodyModes(nodes: Float64Array, fixed: Uint8Array): Float64Array {
  const n = nodes.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k]! += nodes[3 * i + k]! / n;
  let s = 0;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) s = Math.max(s, Math.abs(nodes[3 * i + k]! - c[k]!));
  const B = new Float64Array(n * 3 * 6);
  for (let i = 0; i < n; i++) {
    const x = (nodes[3 * i]! - c[0]!) / s,
      y = (nodes[3 * i + 1]! - c[1]!) / s,
      z = (nodes[3 * i + 2]! - c[2]!) / s;
    const rows = [
      [1, 0, 0, 0, z, -y],
      [0, 1, 0, -z, 0, x],
      [0, 0, 1, y, -x, 0],
    ];
    for (let k = 0; k < 3; k++) {
      if (fixed[3 * i + k]) continue;
      for (let m = 0; m < 6; m++) B[(3 * i + k) * 6 + m] = rows[k]![m]!;
    }
  }
  return B;
}

export function amg(
  fine: Bsr,
  nodes: Float64Array,
  fixed: Uint8Array,
  options: AmgOptions = {},
  ctx?: RunContext,
): Preconditioner & {
  levels: { dofs: number; blocks: number }[];
  fine: Bsr;
  phases: Record<string, number>;
} {
  const t0 = performance.now();
  const theta = options.theta ?? 0.02;
  const coarsest = options.coarsest ?? 900;
  const degree = options.chebyshevDegree ?? 2;
  const phases: Record<string, number> = {};
  const lap = (name: string, since: number) => {
    phases[name] = (phases[name] ?? 0) + performance.now() - since;
    return performance.now();
  };
  let tp: number;
  let B = rigidBodyModes(nodes, fixed);
  let bsz = 3;
  const levels: Level[] = [];
  let A = fine;
  let bytes = 0;
  for (;;) {
    ctx?.check();
    tp = performance.now();
    ctx?.use(8 * A.r * A.r * A.nr + 5 * 8 * A.nr * A.r, 'the multigrid levels');
    const dinv = diagonalInverse(A);
    tp = lap('diagonal', tp);
    const N = A.nr * A.r;
    const lvl: Level = {
      A,
      dinv,
      lmax: 0,
      x: new Float64Array(N),
      b: new Float64Array(N),
      r: new Float64Array(N),
      d: new Float64Array(N),
      t: new Float64Array(N),
    };
    levels.push(lvl);
    bytes += (levels.length > 1 ? bsrBytes(A) : 0) + dinv.byteLength + 5 * 8 * N;
    if (N <= coarsest) break;
    lvl.lmax = lambdaMax(A, dinv);
    tp = lap('lambda', tp);
    const { agg, count } = aggregate(A, theta);
    tp = lap('aggregate', tp);
    if (count * 6 >= N * 0.8 || count === 0) break; // not coarsening any more
    const { T, Bc } = tentative(agg, count, bsz, 6, B);
    tp = lap('tentative', tp);
    const P = smooth(A, dinv, T, 4 / 3 / lvl.lmax, ctx);
    tp = lap('smooth', tp);
    ctx?.use(bsrBytes(P), 'the multigrid restriction');
    const R = transpose(P);
    tp = lap('transpose', tp);
    const AP = multiplyBsr(A, P, ctx);
    tp = lap('AP', tp);
    const Ac = multiplyBsr(R, AP, ctx);
    ctx?.release(bsrBytes(AP));
    lap('RAP', tp);
    fixZeroDiagonal(Ac);
    lvl.P = P;
    lvl.R = R;
    bytes += bsrBytes(P) + bsrBytes(R);
    A = Ac;
    B = Bc;
    bsz = 6;
  }
  // Dense Cholesky of the coarsest matrix.
  tp = performance.now();
  const last = levels[levels.length - 1]!;
  const Nc = last.A.nr * last.A.r;
  ctx?.use(8 * Nc * Nc, 'the coarsest multigrid level');
  const L = new Float64Array(Nc * Nc);
  {
    const { r, c, rowPtr, cols, vals } = last.A;
    for (let i = 0; i < last.A.nr; i++)
      for (let p = rowPtr[i]!; p < rowPtr[i + 1]!; p++)
        for (let k = 0; k < r; k++)
          for (let l = 0; l < c; l++)
            L[(r * i + k) * Nc + c * cols[p]! + l] = vals[r * c * p + c * k + l]!;
    for (let j = 0; j < Nc; j++) {
      ctx?.check();
      let d = L[j * Nc + j]!;
      for (let k = 0; k < j; k++) d -= L[j * Nc + k]! ** 2;
      d = d > 1e-300 ? Math.sqrt(d) : 1;
      L[j * Nc + j] = d;
      for (let i = j + 1; i < Nc; i++) {
        let s = L[i * Nc + j]!;
        for (let k = 0; k < j; k++) s -= L[i * Nc + k]! * L[j * Nc + k]!;
        L[i * Nc + j] = s / d;
      }
    }
    bytes += L.byteLength;
  }
  lap('cholesky', tp);
  const coarseSolve = (b: Float64Array, x: Float64Array) => {
    for (let i = 0; i < Nc; i++) {
      let s = b[i]!;
      for (let k = 0; k < i; k++) s -= L[i * Nc + k]! * x[k]!;
      x[i] = s / L[i * Nc + i]!;
    }
    for (let i = Nc - 1; i >= 0; i--) {
      let s = x[i]!;
      for (let k = i + 1; k < Nc; k++) s -= L[k * Nc + i]! * x[k]!;
      x[i] = s / L[i * Nc + i]!;
    }
  };

  // Chebyshev smoothing of A x = b on D^-1 A over [lmax / 30, 1.1 lmax], from the current x.
  const chebyshev = (lv: Level, x: Float64Array, b: Float64Array) => {
    const hi = 1.1 * lv.lmax,
      lo = lv.lmax / 30;
    const theta = (hi + lo) / 2,
      delta = (hi - lo) / 2,
      sigma = theta / delta;
    let rho = 1 / sigma;
    const { r, d, t } = lv;
    const N = x.length;
    spmv(lv.A, x, t);
    for (let i = 0; i < N; i++) r[i] = b[i]! - t[i]!;
    applyBlockDiag(lv.dinv, lv.A.r, r, t);
    for (let i = 0; i < N; i++) {
      d[i] = t[i]! / theta;
      x[i]! += d[i]!;
    }
    for (let k = 1; k < degree; k++) {
      const rhoNew = 1 / (2 * sigma - rho);
      spmv(lv.A, d, t);
      for (let i = 0; i < N; i++) r[i]! -= t[i]!;
      applyBlockDiag(lv.dinv, lv.A.r, r, t);
      for (let i = 0; i < N; i++) {
        d[i] = rhoNew * rho * d[i]! + ((2 * rhoNew) / delta) * t[i]!;
        x[i]! += d[i]!;
      }
      rho = rhoNew;
    }
  };

  const vcycle = (l: number, b: Float64Array, x: Float64Array) => {
    const lv = levels[l]!;
    if (l === levels.length - 1) {
      coarseSolve(b, x);
      return;
    }
    x.fill(0);
    chebyshev(lv, x, b);
    spmv(lv.A, x, lv.t);
    for (let i = 0; i < x.length; i++) lv.r[i] = b[i]! - lv.t[i]!;
    const next = levels[l + 1]!;
    spmv(lv.R!, lv.r, next.b);
    vcycle(l + 1, next.b, next.x);
    spmv(lv.P!, next.x, lv.t);
    for (let i = 0; i < x.length; i++) x[i]! += lv.t[i]!;
    chebyshev(lv, x, b);
  };

  return {
    name: 'amg',
    fine,
    bytes: bytes + bsrBytes(fine),
    setupMs: performance.now() - t0,
    levels: levels.map((lv) => ({ dofs: lv.A.nr * lv.A.r, blocks: lv.A.cols.length })),
    phases,
    apply(r, z) {
      vcycle(0, r, z);
    },
  };
}
