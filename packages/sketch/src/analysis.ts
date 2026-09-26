// Degrees-of-freedom analysis per parameter, for the per-entity status the UI
// colours sketches by. planegcs reports the total DOF and the conflicting and
// redundant constraints, but not which parameters are still free, so this is
// computed here from the Jacobian of the same equations (ops.ts).
//
// A parameter is determined when its unit vector lies in the row space of the
// Jacobian: no motion allowed by the constraints (to first order) moves it.
// The Jacobian is split into independent components (parameters linked by a
// shared equation), and each is reduced by Gauss-Jordan elimination with
// partial pivoting. In reduced row echelon form a parameter is determined
// exactly when it is a pivot column whose row has no entry in a free column.

import type { Equation } from './equations';

export interface RankAnalysis {
  /** Number of unknown parameters. */
  unknowns: number;
  /** Rank of the Jacobian. */
  rank: number;
  /** `unknowns - rank`. */
  dof: number;
  /** Per parameter (all of them, fixed ones included): 1 when determined. Fixed parameters are 1. */
  determined: Uint8Array;
}

const PIVOT_TOLERANCE = 1e-7;

/**
 * Analyse the equations at `params`. Parameters below `fixedCount` are
 * constants. Derivatives are central differences with a step relative to the
 * size of the sketch.
 */
export function analyzeRank(
  params: Float64Array,
  fixedCount: number,
  equations: readonly Equation[],
): RankAnalysis {
  const n = params.length;
  const unknowns = n - fixedCount;
  const determined = new Uint8Array(n);
  determined.fill(1, 0, fixedCount);

  let scale = 1;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(params[i]!));
  const h = 1e-6 * scale;

  // Sparse, normalised Jacobian rows over unknown parameters.
  const rows: { cols: number[]; vals: number[] }[] = [];
  const work = Float64Array.from(params);
  for (const eq of equations) {
    const cols: number[] = [];
    const vals: number[] = [];
    for (const i of new Set(eq.params)) {
      if (i < fixedCount) continue;
      const x = work[i]!;
      work[i] = x + h;
      const fp = eq.f(work);
      work[i] = x - h;
      const fm = eq.f(work);
      work[i] = x;
      const d = (fp - fm) / (2 * h);
      if (Number.isFinite(d) && d !== 0) {
        cols.push(i);
        vals.push(d);
      }
    }
    const norm = Math.hypot(...vals);
    if (!(norm > 1e-12)) continue;
    rows.push({ cols, vals: vals.map((v) => v / norm) });
  }

  // Components: union-find over parameters sharing a row.
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const r of rows) {
    for (let k = 1; k < r.cols.length; k++) {
      const a = find(r.cols[0]!);
      const b = find(r.cols[k]!);
      if (a !== b) parent[a] = b;
    }
  }
  const components = new Map<number, { cols: number[]; rows: typeof rows }>();
  for (let i = fixedCount; i < n; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, { cols: [], rows: [] });
    components.get(root)!.cols.push(i);
  }
  for (const r of rows) components.get(find(r.cols[0]!))!.rows.push(r);

  let rank = 0;
  for (const { cols, rows: compRows } of components.values()) {
    if (compRows.length === 0) continue;
    rank += reduce(cols, compRows, determined);
  }
  return { unknowns, rank, dof: unknowns - rank, determined };
}

/** Gauss-Jordan on one component; marks determined parameters and returns the rank. */
function reduce(
  cols: number[],
  rows: { cols: number[]; vals: number[] }[],
  determined: Uint8Array,
): number {
  const m = rows.length;
  const w = cols.length;
  const colIndex = new Map(cols.map((c, j) => [c, j]));
  const a = new Float64Array(m * w);
  rows.forEach((r, i) =>
    r.cols.forEach((c, k) => {
      const at = i * w + colIndex.get(c)!;
      a[at] = a[at]! + r.vals[k]!;
    }),
  );

  const used = new Uint8Array(m);
  const pivotRow = new Int32Array(w).fill(-1);
  const nz: number[] = [];
  let rank = 0;
  for (let j = 0; j < w; j++) {
    let best = -1;
    let bestVal = PIVOT_TOLERANCE;
    for (let i = 0; i < m; i++) {
      if (used[i]) continue;
      const v = Math.abs(a[i * w + j]!);
      if (v > bestVal) {
        bestVal = v;
        best = i;
      }
    }
    if (best < 0) continue;
    used[best] = 1;
    pivotRow[j] = best;
    rank++;
    const pr = best * w;
    const inv = 1 / a[pr + j]!;
    nz.length = 0;
    for (let k = 0; k < w; k++) {
      const v = a[pr + k]!;
      if (v === 0) continue;
      if (Math.abs(v * inv) < 1e-15) {
        a[pr + k] = 0;
        continue;
      }
      a[pr + k] = v * inv;
      nz.push(k);
    }
    for (let i = 0; i < m; i++) {
      if (i === best) continue;
      const row = i * w;
      const f = a[row + j]!;
      if (f === 0) continue;
      for (const k of nz) a[row + k] = a[row + k]! - f * a[pr + k]!;
      a[row + j] = 0;
    }
  }
  for (let j = 0; j < w; j++) {
    const r = pivotRow[j]!;
    if (r < 0) continue;
    let free = false;
    for (let k = 0; k < w && !free; k++) {
      if (pivotRow[k]! < 0 && Math.abs(a[r * w + k]!) > PIVOT_TOLERANCE) free = true;
    }
    if (!free) determined[cols[j]!] = 1;
  }
  return rank;
}
