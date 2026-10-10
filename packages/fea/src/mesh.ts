// The TET10 mesh as the solver sees it, and what is derived from it: gmsh's node order mapped to
// ours, node-to-element adjacency, surface triangles resolved to the faces of their tets, and the
// reverse Cuthill-McKee renumbering (from the T9.0a spike's mesh.ts and order.ts).

import { EDGES, FACES } from './tet10';

/** A TET10 mesh in our node order (see tet10.ts). */
export interface TetMesh {
  /** x, y, z per node, mm. */
  nodes: Float64Array;
  /** 10 node indices per element. */
  tets: Uint32Array;
  /** Body index per element. */
  tetBody: Uint16Array;
}

/**
 * Surface triangles of one kernel face, before they are matched to tets: corner node indices,
 * 3 per triangle.
 */
export interface FaceTriangles {
  body: number;
  face: number;
  corners: Uint32Array;
}

/**
 * Map gmsh's TET10 edge-node order to ours, found geometrically (each edge node lies nearest the
 * midpoint of its own corner pair) on a sample of elements rather than trusted from documentation.
 * Returns, for each of our edges 0..5, gmsh's position 4..9.
 */
export function edgeOrder(
  nodeAt: (element: number, position: number, component: number) => number,
  elements: number,
): number[] {
  const votes = Array.from({ length: 6 }, () => new Int32Array(6));
  const sample = Math.min(elements, 200);
  for (let e = 0; e < sample; e++) {
    for (let p = 4; p < 10; p++) {
      let best = 0,
        bestD = Infinity;
      for (let q = 0; q < 6; q++) {
        const [i, j] = EDGES[q]!;
        let d = 0;
        for (let c = 0; c < 3; c++) {
          d += (nodeAt(e, p, c) - 0.5 * (nodeAt(e, i, c) + nodeAt(e, j, c))) ** 2;
        }
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      votes[best]![p - 4]! += 1;
    }
  }
  const perm = votes.map((v) => 4 + v.indexOf(Math.max(...v)));
  if (new Set(perm).size !== 6) throw new Error(`ambiguous TET10 edge order: ${perm.join(',')}`);
  return perm;
}

/** Elements around each node, as compressed rows. */
export interface NodeElements {
  ptr: Int32Array;
  elements: Int32Array;
}

export function nodeElements(mesh: TetMesh): NodeElements {
  const n = mesh.nodes.length / 3;
  const { tets } = mesh;
  const ptr = new Int32Array(n + 1);
  for (let i = 0; i < tets.length; i++) ptr[tets[i]! + 1]! += 1;
  for (let i = 0; i < n; i++) ptr[i + 1]! += ptr[i]!;
  const elements = new Int32Array(tets.length);
  const fill = ptr.slice(0, n);
  const ne = tets.length / 10;
  for (let e = 0; e < ne; e++)
    for (let a = 0; a < 10; a++) elements[fill[tets[10 * e + a]!]!++] = e;
  return { ptr, elements };
}

/** Surface triangles of a face resolved to tet faces: 6 nodes each (ours) and the opposite corner. */
export interface ResolvedFace {
  body: number;
  face: number;
  /** 6 node indices per triangle: corners, then the edge nodes of (0,1), (1,2), (0,2). */
  nodes: Uint32Array;
  /** The tet corner not on the triangle, to orient the outward normal. */
  opposite: Uint32Array;
}

/**
 * Match each surface triangle to the tet face with the same three corners, taking the tet's own
 * edge nodes and its opposite corner. Prefers a tet of the face's own body (a face between two
 * bonded bodies has a tet on each side). Returns the count of triangles no tet owns.
 */
export function resolveFaces(
  mesh: TetMesh,
  adjacency: NodeElements,
  faces: readonly FaceTriangles[],
): { faces: ResolvedFace[]; unmatched: number } {
  const { tets, tetBody } = mesh;
  const { ptr, elements } = adjacency;
  let unmatched = 0;
  const out: ResolvedFace[] = [];
  for (const f of faces) {
    const nt = f.corners.length / 3;
    const nodes = new Uint32Array(6 * nt);
    const opposite = new Uint32Array(nt);
    let k = 0;
    for (let t = 0; t < nt; t++) {
      const a = f.corners[3 * t]!,
        b = f.corners[3 * t + 1]!,
        c = f.corners[3 * t + 2]!;
      let found = -1,
        foundFace = -1;
      for (let p = ptr[a]!; p < ptr[a + 1]!; p++) {
        const e = elements[p]!;
        for (let lf = 0; lf < 4; lf++) {
          const fc = FACES[lf]!.corners;
          const x = tets[10 * e + fc[0]]!,
            y = tets[10 * e + fc[1]]!,
            z = tets[10 * e + fc[2]]!;
          if (
            (x === a || y === a || z === a) &&
            (x === b || y === b || z === b) &&
            (x === c || y === c || z === c)
          ) {
            if (found < 0 || (tetBody[found] !== f.body && tetBody[e] === f.body)) {
              found = e;
              foundFace = lf;
            }
          }
        }
      }
      if (found < 0) {
        unmatched++;
        continue;
      }
      const lf = FACES[foundFace]!;
      const ids = [...lf.corners, ...lf.mids];
      for (let q = 0; q < 6; q++) nodes[6 * k + q] = tets[10 * found + ids[q]!]!;
      opposite[k] = tets[10 * found + lf.opposite]!;
      k++;
    }
    out.push({
      body: f.body,
      face: f.face,
      nodes: k === nt ? nodes : nodes.slice(0, 6 * k),
      opposite: k === nt ? opposite : opposite.slice(0, k),
    });
  }
  return { faces: out, unmatched };
}

/** Connected parts of the mesh (elements sharing a node), as a label per node. */
export function components(
  mesh: TetMesh,
  adjacency: NodeElements,
): { label: Int32Array; count: number } {
  const n = mesh.nodes.length / 3;
  const label = new Int32Array(n).fill(-1);
  const { tets } = mesh;
  const { ptr, elements } = adjacency;
  const stack = new Int32Array(n);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || ptr[s] === ptr[s + 1]) continue;
    let top = 0;
    stack[top++] = s;
    label[s] = count;
    while (top > 0) {
      const v = stack[--top]!;
      for (let p = ptr[v]!; p < ptr[v + 1]!; p++) {
        const e = elements[p]!;
        for (let a = 0; a < 10; a++) {
          const w = tets[10 * e + a]!;
          if (label[w] === -1) {
            label[w] = count;
            stack[top++] = w;
          }
        }
      }
    }
    count++;
  }
  return { label, count };
}

/**
 * Reverse Cuthill-McKee on the node graph: returns perm[old] = new. Keeps neighbours close, which
 * helps the cache in every sparse sweep.
 */
export function rcmOrder(mesh: TetMesh, adjacency: NodeElements): Int32Array {
  const n = mesh.nodes.length / 3;
  const { tets } = mesh;
  const { ptr: ep, elements } = adjacency;
  // Node graph from the elements (each node's distinct neighbours).
  const mark = new Int32Array(n).fill(-1);
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    for (let p = ep[i]!; p < ep[i + 1]!; p++) {
      const e = elements[p]!;
      for (let a = 0; a < 10; a++) {
        const j = tets[10 * e + a]!;
        if (j !== i && mark[j] !== i) {
          mark[j] = i;
          deg[i]!++;
        }
      }
    }
  }
  const ptr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) ptr[i + 1] = ptr[i]! + deg[i]!;
  const adj = new Int32Array(ptr[n]!);
  mark.fill(-1);
  for (let i = 0; i < n; i++) {
    let w = ptr[i]!;
    for (let p = ep[i]!; p < ep[i + 1]!; p++) {
      const e = elements[p]!;
      for (let a = 0; a < 10; a++) {
        const j = tets[10 * e + a]!;
        if (j !== i && mark[j] !== i) {
          mark[j] = i;
          adj[w++] = j;
        }
      }
    }
  }
  const order = new Int32Array(n);
  const seen = new Uint8Array(n);
  const lvl = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0,
    tail = 0;
  const nbrs: number[] = [];
  let scan = 0;
  const farthest = (s: number): number => {
    // One breadth-first sweep from s over unseen nodes; the last level's node of least degree.
    let qh = 0,
      qt = 0;
    queue[qt++] = s;
    lvl[s] = 0;
    const touched: number[] = [s];
    let last = s;
    while (qh < qt) {
      const v = queue[qh++]!;
      last = v;
      for (let p = ptr[v]!; p < ptr[v + 1]!; p++) {
        const w = adj[p]!;
        if (!seen[w] && lvl[w] === -1) {
          lvl[w] = lvl[v]! + 1;
          queue[qt++] = w;
          touched.push(w);
        }
      }
    }
    const top = lvl[last]!;
    let best = last;
    for (let k = 0; k < qt; k++) {
      const v = queue[k]!;
      if (lvl[v] === top && deg[v]! < deg[best]!) best = v;
    }
    for (const v of touched) lvl[v] = -1;
    return best;
  };
  lvl.fill(-1);
  while (tail < n) {
    while (scan < n && seen[scan]) scan++;
    // Start each part from a node of least degree among the next unseen nodes' part.
    let start = scan;
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
  const perm = new Int32Array(n);
  for (let k = 0; k < n; k++) perm[order[n - 1 - k]!] = k;
  return perm;
}

/** Apply a node permutation (perm[old] = new) to a mesh. */
export function renumber(mesh: TetMesh, perm: Int32Array): TetMesh {
  const n = mesh.nodes.length / 3;
  const nodes = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const j = perm[i]!;
    nodes[3 * j] = mesh.nodes[3 * i]!;
    nodes[3 * j + 1] = mesh.nodes[3 * i + 1]!;
    nodes[3 * j + 2] = mesh.nodes[3 * i + 2]!;
  }
  const tets = new Uint32Array(mesh.tets.length);
  for (let k = 0; k < tets.length; k++) tets[k] = perm[mesh.tets[k]!]!;
  return { nodes, tets, tetBody: mesh.tetBody };
}
