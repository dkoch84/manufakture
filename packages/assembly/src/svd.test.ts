import { describe, expect, it } from 'vitest';
import { rankOf, SvdWorkspace } from './svd';
import { rng } from './test-helpers';

function reconstruct(ws: SvdWorkspace, m: number, n: number): Float64Array {
  const a = new Float64Array(m * n);
  for (let i = 0; i < ws.k; i++) {
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < m; r++) a[r + c * m]! += ws.u[i * m + r]! * ws.s[i]! * ws.v[i * n + c]!;
    }
  }
  return a;
}

describe('one-sided Jacobi SVD', () => {
  for (const [m, n] of [
    [6, 4],
    [4, 6],
    [12, 12],
    [3, 20],
    [24, 7],
  ] as const) {
    it(`reconstructs a random ${m} by ${n} matrix with orthonormal factors`, () => {
      const r = rng(m * 100 + n);
      const a = new Float64Array(m * n).map(() => r() * 2 - 1);
      const ws = new SvdWorkspace();
      const k = ws.decompose(a, m, n);
      expect(k).toBe(Math.min(m, n));
      const b = reconstruct(ws, m, n);
      for (let i = 0; i < m * n; i++) expect(Math.abs(b[i]! - a[i]!)).toBeLessThan(1e-12);
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          let uu = 0,
            vv = 0;
          for (let q = 0; q < m; q++) uu += ws.u[i * m + q]! * ws.u[j * m + q]!;
          for (let q = 0; q < n; q++) vv += ws.v[i * n + q]! * ws.v[j * n + q]!;
          expect(uu).toBeCloseTo(i === j ? 1 : 0, 12);
          expect(vv).toBeCloseTo(i === j ? 1 : 0, 12);
        }
      }
      expect(rankOf(ws)).toBe(k);
    });
  }

  it('finds the rank of a rank-deficient matrix', () => {
    // 6 by 5 of rank 2: outer products of two random pairs.
    const r = rng(7);
    const m = 6,
      n = 5;
    const a = new Float64Array(m * n);
    for (let t = 0; t < 2; t++) {
      const x = Array.from({ length: m }, r);
      const y = Array.from({ length: n }, r);
      for (let c = 0; c < n; c++) for (let q = 0; q < m; q++) a[q + c * m]! += x[q]! * y[c]!;
    }
    const ws = new SvdWorkspace();
    ws.decompose(a, m, n);
    expect(rankOf(ws)).toBe(2);
    // Its transpose (5 by 6, the wide path) has the same rank.
    const t = new Float64Array(m * n);
    for (let c = 0; c < n; c++) for (let q = 0; q < m; q++) t[c + q * n] = a[q + c * m]!;
    ws.decompose(t, n, m);
    expect(rankOf(ws)).toBe(2);
    ws.decompose(new Float64Array(12), 3, 4);
    expect(rankOf(ws)).toBe(0);
  });
});
