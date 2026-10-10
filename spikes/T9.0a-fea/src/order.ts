// Node orderings. The incomplete Cholesky factor's quality depends on the order of the unknowns;
// reverse Cuthill-McKee keeps neighbours close, which also helps the cache in every sweep.

import { type TetMesh } from './mesh.ts';
import { pattern } from './solver.ts';

/** Renumber the mesh's nodes with reverse Cuthill-McKee on the node graph. */
export function rcm(mesh: TetMesh): TetMesh {
  const a = pattern(mesh);
  const n = a.n;
  // Full adjacency from the upper pattern.
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++)
    for (let p = a.rowPtr[i]! + 1; p < a.rowPtr[i + 1]!; p++) {
      deg[i]!++;
      deg[a.cols[p]!]!++;
    }
  const ptr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) ptr[i + 1] = ptr[i]! + deg[i]!;
  const adj = new Int32Array(ptr[n]!);
  const fill = ptr.slice(0, n);
  for (let i = 0; i < n; i++)
    for (let p = a.rowPtr[i]! + 1; p < a.rowPtr[i + 1]!; p++) {
      const j = a.cols[p]!;
      adj[fill[i]!++] = j;
      adj[fill[j]!++] = i;
    }
  const order = new Int32Array(n);
  const seen = new Uint8Array(n);
  let head = 0,
    tail = 0;
  const nbrs: number[] = [];
  while (tail < n) {
    // Start each component from a node of minimum degree, then a pseudo-peripheral sweep.
    let start = -1;
    for (let i = 0; i < n; i++) if (!seen[i] && (start < 0 || deg[i]! < deg[start]!)) start = i;
    start = farthest(start);
    seen[start] = 1;
    order[tail++] = start;
    while (head < tail) {
      const v = order[head++]!;
      nbrs.length = 0;
      for (let p = ptr[v]!; p < ptr[v + 1]!; p++) if (!seen[adj[p]!]) nbrs.push(adj[p]!);
      nbrs.sort((x, y) => deg[x]! - deg[y]!);
      for (const w of nbrs) {
        seen[w] = 1;
        order[tail++] = w;
      }
    }
  }
  function farthest(s: number): number {
    // One BFS from s; the last node reached of least degree.
    const lvl = new Int32Array(n).fill(-1);
    const q = [s];
    lvl[s] = 0;
    for (let h = 0; h < q.length; h++) {
      const v = q[h]!;
      for (let p = ptr[v]!; p < ptr[v + 1]!; p++)
        if (lvl[adj[p]!] === -1 && !seen[adj[p]!]) {
          lvl[adj[p]!] = lvl[v]! + 1;
          q.push(adj[p]!);
        }
    }
    const last = lvl[q[q.length - 1]!]!;
    let best = q[q.length - 1]!;
    for (const v of q) if (lvl[v] === last && deg[v]! < deg[best]!) best = v;
    return best;
  }
  // Reverse, then perm[old] = new.
  const perm = new Int32Array(n);
  for (let k = 0; k < n; k++) perm[order[n - 1 - k]!] = k;
  const nodes = new Float64Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) nodes[3 * perm[i]! + c] = mesh.nodes[3 * i + c]!;
  const tets = new Uint32Array(mesh.tets.length);
  for (let k = 0; k < tets.length; k++) tets[k] = perm[mesh.tets[k]!]!;
  return { nodes, tets };
}
