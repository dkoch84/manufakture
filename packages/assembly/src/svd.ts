// A small one-sided Jacobi SVD (Hestenes) for the dense matrices of loop closures and
// drags: a few to a few tens of rows and columns.
//
// Matrices are column-major: element (i, j) of an m by n matrix is a[i + j * m]. The
// result is A = U diag(s) V^T with k = min(m, n) singular values, not sorted. U is m by k
// and V is n by k, both column-major. A column of U or V whose singular value is zero is
// left zero. The workspace grows as needed and is reused, so repeated calls on matrices of
// the same size allocate nothing.

export class SvdWorkspace {
  s = new Float64Array(0);
  u = new Float64Array(0);
  v = new Float64Array(0);
  /** The matrix being orthogonalised (p by q) and the accumulated rotations (q by q). */
  private b = new Float64Array(0);
  private w = new Float64Array(0);
  k = 0;

  ensure(m: number, n: number): void {
    const k = Math.min(m, n);
    const p = Math.max(m, n);
    if (this.s.length < k) this.s = new Float64Array(k);
    if (this.u.length < m * k) this.u = new Float64Array(m * k);
    if (this.v.length < n * k) this.v = new Float64Array(n * k);
    if (this.b.length < p * k) this.b = new Float64Array(p * k);
    if (this.w.length < k * k) this.w = new Float64Array(k * k);
  }

  /** Decomposes the column-major m by n matrix `a` (left unchanged); returns k. */
  decompose(a: Float64Array, m: number, n: number): number {
    this.ensure(m, n);
    const k = Math.min(m, n);
    this.k = k;
    if (k === 0) return 0;
    // Orthogonalise the columns of B = A (m >= n) or B = A^T (m < n): p rows, k columns.
    const tall = m >= n;
    const p = tall ? m : n;
    const b = this.b;
    const w = this.w;
    if (tall) {
      for (let i = 0; i < m * n; i++) b[i] = a[i]!;
    } else {
      // Column i of A^T is row i of A.
      for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) b[j + i * n] = a[i + j * m]!;
    }
    for (let i = 0; i < k * k; i++) w[i] = 0;
    for (let i = 0; i < k; i++) w[i + i * k] = 1;

    for (let sweep = 0; sweep < 60; sweep++) {
      let rotated = false;
      for (let i = 0; i < k - 1; i++) {
        const bi = i * p;
        for (let j = i + 1; j < k; j++) {
          const bj = j * p;
          let alpha = 0,
            beta = 0,
            gamma = 0;
          for (let r = 0; r < p; r++) {
            const x = b[bi + r]!,
              y = b[bj + r]!;
            alpha += x * x;
            beta += y * y;
            gamma += x * y;
          }
          if (gamma === 0 || Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta)) continue;
          rotated = true;
          const zeta = (beta - alpha) / (2 * gamma);
          const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
          const c = 1 / Math.sqrt(1 + t * t);
          const s = c * t;
          for (let r = 0; r < p; r++) {
            const x = b[bi + r]!,
              y = b[bj + r]!;
            b[bi + r] = c * x - s * y;
            b[bj + r] = s * x + c * y;
          }
          const wi = i * k,
            wj = j * k;
          for (let r = 0; r < k; r++) {
            const x = w[wi + r]!,
              y = w[wj + r]!;
            w[wi + r] = c * x - s * y;
            w[wj + r] = s * x + c * y;
          }
        }
      }
      if (!rotated) break;
    }

    // B W = U' diag(s): the column norms are the singular values.
    const s = this.s;
    // For a tall A: U = B_j / s_j (m rows), V = W. For a wide A: U = W, V = B_j / s_j (n rows).
    const scaled = tall ? this.u : this.v;
    const other = tall ? this.v : this.u;
    for (let j = 0; j < k; j++) {
      let norm = 0;
      for (let r = 0; r < p; r++) norm += b[j * p + r]! ** 2;
      norm = Math.sqrt(norm);
      s[j] = norm;
      const f = norm > 0 ? 1 / norm : 0;
      for (let r = 0; r < p; r++) scaled[j * p + r] = b[j * p + r]! * f;
      for (let r = 0; r < k; r++) other[j * k + r] = w[j * k + r]!;
    }
    return k;
  }
}

/** The largest singular value in ws.s[0..k-1]. */
export function maxSingular(ws: SvdWorkspace): number {
  let max = 0;
  for (let i = 0; i < ws.k; i++) if (ws.s[i]! > max) max = ws.s[i]!;
  return max;
}

/** The numerical rank: singular values above `relative` times the largest. */
export function rankOf(ws: SvdWorkspace, relative = 1e-8): number {
  const max = maxSingular(ws);
  if (!(max > 1e-12)) return 0;
  let r = 0;
  for (let i = 0; i < ws.k; i++) if (ws.s[i]! > relative * max) r++;
  return r;
}
