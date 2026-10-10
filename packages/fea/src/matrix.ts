// Assembly of the stiffness matrix into the upper triangle of 3x3 node blocks, with homogeneous
// Dirichlet constraints (from the T9.0a spike's solver.ts). Each element takes its own body's
// material, so bonded bodies of different materials assemble into one matrix.

import type { RunContext } from './context';
import { FeaAbort } from './context';
import type { NodeElements, TetMesh } from './mesh';
import { elementStiffness, PAIRS } from './tet10';

/** Upper triangle of the stiffness matrix in 3x3 node blocks, rows sorted, diagonal first. */
export interface BlockMatrix {
  n: number;
  rowPtr: Int32Array;
  cols: Int32Array;
  /** 9 per block, row-major. */
  vals: Float64Array;
}

export const matrixBytes = (a: BlockMatrix): number =>
  a.rowPtr.byteLength + a.cols.byteLength + a.vals.byteLength;

/** The block sparsity pattern: for each node, the nodes >= it that share an element. */
export function pattern(mesh: TetMesh, adjacency: NodeElements, ctx: RunContext): BlockMatrix {
  const n = mesh.nodes.length / 3;
  const { tets } = mesh;
  const { ptr, elements } = adjacency;
  const mark = new Int32Array(n).fill(-1);
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let p = ptr[i]!; p < ptr[i + 1]!; p++) {
      const e = elements[p]!;
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
  const blocks = rowPtr[n]!;
  ctx.use(blocks * (4 + 72), 'the stiffness matrix');
  mark.fill(-1);
  const cols = new Int32Array(blocks);
  const scratch: number[] = [];
  for (let i = 0; i < n; i++) {
    scratch.length = 0;
    for (let p = ptr[i]!; p < ptr[i + 1]!; p++) {
      const e = elements[p]!;
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
  return { n, rowPtr, cols, vals: new Float64Array(9 * blocks) };
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

/** Lame constants per body. */
export interface BodyConstants {
  lambda: Float64Array;
  mu: Float64Array;
}

/**
 * Assemble K. `fixed[3 * node + c]` = 1 for a constrained component (displacement 0): its row and
 * column are dropped and its diagonal set to 1. An inverted element is a typed error.
 */
export function assemble(
  mesh: TetMesh,
  constants: BodyConstants,
  fixed: Uint8Array,
  a: BlockMatrix,
  ctx: RunContext,
): void {
  const { nodes, tets, tetBody } = mesh;
  const ne = tets.length / 10;
  const xe = new Float64Array(30);
  const ke = new Float64Array(9 * PAIRS);
  const vals = a.vals;
  vals.fill(0);
  for (let e = 0; e < ne; e++) {
    if ((e & 4095) === 0) {
      ctx.check();
      ctx.report({});
    }
    const base = 10 * e;
    for (let k = 0; k < 10; k++) {
      const g = tets[base + k]!;
      xe[3 * k] = nodes[3 * g]!;
      xe[3 * k + 1] = nodes[3 * g + 1]!;
      xe[3 * k + 2] = nodes[3 * g + 2]!;
    }
    const body = tetBody[e]!;
    if (!elementStiffness(xe, constants.lambda[body]!, constants.mu[body]!, ke)) {
      throw new FeaAbort({
        code: 'invalid-element',
        message: `Element ${e} is inverted: the mesh is not valid for analysis. Try a smaller element size or the other 3D algorithm.`,
        element: e,
      });
    }
    let p = 0;
    for (let i = 0; i < 10; i++) {
      const gi = tets[base + i]!;
      for (let j = i; j < 10; j++, p++) {
        const gj = tets[base + j]!;
        const o = 9 * p;
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
          const q = 9 * findBlock(a, gi, gi);
          for (let r = 0; r < 3; r++)
            for (let c = 0; c < 3; c++) {
              if (fixed[3 * gi + r] || fixed[3 * gi + c]) continue;
              vals[q + 3 * r + c]! += ke[o + 3 * r + c]!;
            }
        }
      }
    }
  }
  for (let i = 0; i < a.n; i++) {
    const q = 9 * a.rowPtr[i]!;
    for (let c = 0; c < 3; c++) if (fixed[3 * i + c]) vals[q + 4 * c] = 1;
  }
}
