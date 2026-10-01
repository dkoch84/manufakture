// A small bounding volume hierarchy over a triangle mesh, for the thickness and gap rays (plan
// T3.1c). Our own rather than `three-mesh-bvh`: that one needs `three` (a peer dependency) for
// its geometry and ray types, which a pure-TypeScript worker would load only to build a
// BufferGeometry from arrays it already has. What the checks need is one query, the first hit
// along a ray whose triangle faces a given way, and that fits in a page.
//
// Layout: triangles are stored in BVH order with their vertices widened to float64 (nine numbers
// each) and their unit normals from the winding (counter-clockwise seen from outside, as in
// `MeshData`). Nodes are flat arrays: six bounds per node, and per node either two children
// (`count` 0, left child at `node + 1`, right child at `offset`) or a leaf of `count` triangles
// from `offset`. The tree is built top-down with a binned surface area heuristic.

/** Triangles per leaf, at most. */
const LEAF_SIZE = 4;
/** Bins per axis for the surface area heuristic. */
const BINS = 12;

export interface RayHit {
  /** Distance along the (unit) ray direction. */
  t: number;
  /** The triangle's index in the source mesh. */
  triangle: number;
}

export class TriangleBvh {
  /** Triangle count. */
  readonly size: number;
  /** Per triangle in BVH order: its index in the source mesh. */
  private readonly order: Uint32Array;
  /** Per triangle in BVH order: a, b, c as 9 float64 values. */
  private readonly verts: Float64Array;
  /** Per triangle in BVH order: unit normal from the winding (0 for a degenerate one). */
  private readonly normals: Float64Array;
  private readonly bounds: Float64Array;
  private readonly offset: Uint32Array;
  private readonly count: Uint32Array;
  private nodes = 0;
  private readonly stack: Uint32Array;
  private readonly stackT: Float64Array;

  /**
   * Builds the tree over the triangles of `indices` into `positions` (xyz per vertex). `transform`,
   * when given, maps every vertex first (a placement), so that several bodies can share one frame.
   */
  constructor(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    transform?: (x: number, y: number, z: number, out: Float64Array) => void,
  ) {
    const n = Math.floor(indices.length / 3);
    this.size = n;
    const raw = new Float64Array(n * 9);
    const p = new Float64Array(3);
    for (let i = 0; i < n * 3; i++) {
      const v = indices[i]!;
      const x = positions[3 * v]!,
        y = positions[3 * v + 1]!,
        z = positions[3 * v + 2]!;
      if (transform) {
        transform(x, y, z, p);
        raw[3 * i] = p[0]!;
        raw[3 * i + 1] = p[1]!;
        raw[3 * i + 2] = p[2]!;
      } else {
        raw[3 * i] = x;
        raw[3 * i + 1] = y;
        raw[3 * i + 2] = z;
      }
    }
    // Centroids and per-triangle bounds, for the build.
    const centroid = new Float64Array(n * 3);
    const tb = new Float64Array(n * 6);
    for (let t = 0; t < n; t++) {
      for (let a = 0; a < 3; a++) {
        const v0 = raw[9 * t + a]!,
          v1 = raw[9 * t + 3 + a]!,
          v2 = raw[9 * t + 6 + a]!;
        centroid[3 * t + a] = (v0 + v1 + v2) / 3;
        tb[6 * t + a] = Math.min(v0, v1, v2);
        tb[6 * t + 3 + a] = Math.max(v0, v1, v2);
      }
    }
    const items = new Uint32Array(n);
    for (let t = 0; t < n; t++) items[t] = t;
    const maxNodes = Math.max(1, 2 * n - 1);
    this.bounds = new Float64Array(maxNodes * 6);
    this.offset = new Uint32Array(maxNodes);
    this.count = new Uint32Array(maxNodes);
    let depth = 0;
    if (n > 0) depth = this.build(items, 0, n, centroid, tb);
    this.stack = new Uint32Array(Math.max(64, depth * 2 + 2));
    this.stackT = new Float64Array(this.stack.length);

    this.order = items;
    this.verts = new Float64Array(n * 9);
    this.normals = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = items[i]!;
      for (let j = 0; j < 9; j++) this.verts[9 * i + j] = raw[9 * t + j]!;
      const ax = raw[9 * t]!,
        ay = raw[9 * t + 1]!,
        az = raw[9 * t + 2]!;
      const e1x = raw[9 * t + 3]! - ax,
        e1y = raw[9 * t + 4]! - ay,
        e1z = raw[9 * t + 5]! - az;
      const e2x = raw[9 * t + 6]! - ax,
        e2y = raw[9 * t + 7]! - ay,
        e2z = raw[9 * t + 8]! - az;
      const nx = e1y * e2z - e1z * e2y,
        ny = e1z * e2x - e1x * e2z,
        nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) {
        this.normals[3 * i] = nx / l;
        this.normals[3 * i + 1] = ny / l;
        this.normals[3 * i + 2] = nz / l;
      }
    }
  }

  /** Recursive build of the node for items[start, end); returns the subtree's depth. */
  private build(
    items: Uint32Array,
    start: number,
    end: number,
    centroid: Float64Array,
    tb: Float64Array,
  ): number {
    const node = this.nodes++;
    const b = this.bounds;
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    let cx0 = Infinity,
      cy0 = Infinity,
      cz0 = Infinity,
      cx1 = -Infinity,
      cy1 = -Infinity,
      cz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const t = items[i]!;
      x0 = Math.min(x0, tb[6 * t]!);
      y0 = Math.min(y0, tb[6 * t + 1]!);
      z0 = Math.min(z0, tb[6 * t + 2]!);
      x1 = Math.max(x1, tb[6 * t + 3]!);
      y1 = Math.max(y1, tb[6 * t + 4]!);
      z1 = Math.max(z1, tb[6 * t + 5]!);
      const cx = centroid[3 * t]!,
        cy = centroid[3 * t + 1]!,
        cz = centroid[3 * t + 2]!;
      cx0 = Math.min(cx0, cx);
      cy0 = Math.min(cy0, cy);
      cz0 = Math.min(cz0, cz);
      cx1 = Math.max(cx1, cx);
      cy1 = Math.max(cy1, cy);
      cz1 = Math.max(cz1, cz);
    }
    b[6 * node] = x0;
    b[6 * node + 1] = y0;
    b[6 * node + 2] = z0;
    b[6 * node + 3] = x1;
    b[6 * node + 4] = y1;
    b[6 * node + 5] = z1;

    const n = end - start;
    const leaf = () => {
      this.offset[node] = start;
      this.count[node] = n;
      return 1;
    };
    if (n <= LEAF_SIZE) return leaf();

    // Split on the axis of the widest centroid extent, at the best of BINS - 1 bin boundaries.
    const ext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    const axis = ext[0]! >= ext[1]! && ext[0]! >= ext[2]! ? 0 : ext[1]! >= ext[2]! ? 1 : 2;
    const lo = [cx0, cy0, cz0][axis]!;
    const width = ext[axis]!;
    if (!(width > 0)) return leaf(); // every centroid in one spot: nothing to split by
    const binOf = (t: number) =>
      Math.min(BINS - 1, Math.floor(((centroid[3 * t + axis]! - lo) / width) * BINS));
    const binCount = new Uint32Array(BINS);
    const binBox = new Float64Array(BINS * 6);
    for (let k = 0; k < BINS; k++) {
      binBox.fill(Infinity, 6 * k, 6 * k + 3);
      binBox.fill(-Infinity, 6 * k + 3, 6 * k + 6);
    }
    for (let i = start; i < end; i++) {
      const t = items[i]!;
      const k = binOf(t);
      binCount[k]!++;
      for (let a = 0; a < 3; a++) {
        binBox[6 * k + a] = Math.min(binBox[6 * k + a]!, tb[6 * t + a]!);
        binBox[6 * k + 3 + a] = Math.max(binBox[6 * k + 3 + a]!, tb[6 * t + 3 + a]!);
      }
    }
    const area = (bx: Float64Array) => {
      const dx = bx[3]! - bx[0]!,
        dy = bx[4]! - bx[1]!,
        dz = bx[5]! - bx[2]!;
      return dx >= 0 ? dx * dy + dy * dz + dz * dx : 0; // an empty bin's box is inverted
    };
    // Sweep from the left: area and count of bins [0, k].
    const leftArea = new Float64Array(BINS);
    const leftCount = new Uint32Array(BINS);
    const acc = new Float64Array(6);
    acc.fill(Infinity, 0, 3);
    acc.fill(-Infinity, 3, 6);
    let c = 0;
    for (let k = 0; k < BINS; k++) {
      for (let a = 0; a < 3; a++) {
        acc[a] = Math.min(acc[a]!, binBox[6 * k + a]!);
        acc[3 + a] = Math.max(acc[3 + a]!, binBox[6 * k + 3 + a]!);
      }
      c += binCount[k]!;
      leftArea[k] = area(acc);
      leftCount[k] = c;
    }
    acc.fill(Infinity, 0, 3);
    acc.fill(-Infinity, 3, 6);
    let best = -1;
    let bestCost = Infinity;
    c = 0;
    for (let k = BINS - 1; k > 0; k--) {
      for (let a = 0; a < 3; a++) {
        acc[a] = Math.min(acc[a]!, binBox[6 * k + a]!);
        acc[3 + a] = Math.max(acc[3 + a]!, binBox[6 * k + 3 + a]!);
      }
      c += binCount[k]!;
      const left = leftCount[k - 1]!;
      if (left === 0 || c === 0) continue;
      const cost = leftArea[k - 1]! * left + area(acc) * c;
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    let mid: number;
    if (best < 0) {
      // Every triangle in one bin: split the list in half by position along the axis.
      const slice = Array.from(items.subarray(start, end)).sort(
        (p, q) => centroid[3 * p + axis]! - centroid[3 * q + axis]!,
      );
      items.set(slice, start);
      mid = start + (n >> 1);
    } else {
      // Partition in place: bins below `best` to the left.
      let i = start,
        j = end - 1;
      while (i <= j) {
        if (binOf(items[i]!) < best) i++;
        else {
          const tmp = items[i]!;
          items[i] = items[j]!;
          items[j] = tmp;
          j--;
        }
      }
      mid = i;
      if (mid === start || mid === end) mid = start + (n >> 1);
    }
    this.count[node] = 0;
    const dl = this.build(items, start, mid, centroid, tb);
    this.offset[node] = this.nodes;
    const dr = this.build(items, mid, end, centroid, tb);
    return 1 + Math.max(dl, dr);
  }

  /**
   * The nearest triangle hit by the ray from (ox, oy, oz) along the unit direction (dx, dy, dz),
   * with `tMin < t <= tMax`, whose normal faces the way `facing` asks: `dot(normal, direction)`
   * at least `minCos` when `facing` is 1 (a surface the ray leaves the material through), at most
   * `-minCos` when it is -1 (a surface the ray enters through). Other hits (grazing or facing the
   * wrong way) are passed over. `skip` is a source-mesh triangle index never reported (the ray's
   * own triangle), or -1. Null when nothing qualifies.
   */
  firstHit(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    tMax: number,
    facing: 1 | -1,
    minCos: number,
    skip = -1,
  ): RayHit | null {
    if (this.size === 0) return null;
    const ix = 1 / dx,
      iy = 1 / dy,
      iz = 1 / dz;
    const b = this.bounds;
    const v = this.verts;
    const nrm = this.normals;
    const stack = this.stack;
    const stackT = this.stackT;
    let best = tMax;
    let bestTri = -1;
    let sp = 0;
    stack[sp] = 0;
    stackT[sp++] = 0;
    while (sp > 0) {
      sp--;
      if (stackT[sp]! > best) continue;
      const node = stack[sp]!;
      const count = this.count[node]!;
      if (count > 0) {
        const first = this.offset[node]!;
        for (let i = first; i < first + count; i++) {
          const cos = nrm[3 * i]! * dx + nrm[3 * i + 1]! * dy + nrm[3 * i + 2]! * dz;
          if (facing === 1 ? cos < minCos : cos > -minCos) continue;
          if (this.order[i] === skip) continue;
          const t = intersect(v, i, ox, oy, oz, dx, dy, dz);
          if (t > tMin && t <= best) {
            best = t;
            bestTri = i;
          }
        }
        continue;
      }
      const l = node + 1;
      const r = this.offset[node]!;
      const tl = slab(b, l, ox, oy, oz, ix, iy, iz, best);
      const tr = slab(b, r, ox, oy, oz, ix, iy, iz, best);
      // Push the farther child first, so the nearer one is popped next.
      if (tl <= tr) {
        if (tr <= best) {
          stack[sp] = r;
          stackT[sp++] = tr;
        }
        if (tl <= best) {
          stack[sp] = l;
          stackT[sp++] = tl;
        }
      } else {
        if (tl <= best) {
          stack[sp] = l;
          stackT[sp++] = tl;
        }
        if (tr <= best) {
          stack[sp] = r;
          stackT[sp++] = tr;
        }
      }
    }
    return bestTri < 0 ? null : { t: best, triangle: this.order[bestTri]! };
  }
}

/** Entry distance of the ray into node's box (0 when the origin is inside), Infinity on a miss. */
function slab(
  b: Float64Array,
  node: number,
  ox: number,
  oy: number,
  oz: number,
  ix: number,
  iy: number,
  iz: number,
  tMax: number,
): number {
  let t0 = 0;
  let t1 = tMax;
  let a = (b[6 * node]! - ox) * ix;
  let c = (b[6 * node + 3]! - ox) * ix;
  // NaN (0 * Infinity, a ray in a slab's plane) compares false and leaves the range unchanged.
  if (a > c) [a, c] = [c, a];
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  a = (b[6 * node + 1]! - oy) * iy;
  c = (b[6 * node + 4]! - oy) * iy;
  if (a > c) [a, c] = [c, a];
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  a = (b[6 * node + 2]! - oz) * iz;
  c = (b[6 * node + 5]! - oz) * iz;
  if (a > c) [a, c] = [c, a];
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  return t0 <= t1 ? t0 : Infinity;
}

/** Moller-Trumbore, two-sided: the ray distance to triangle i, or -1 on a miss. */
function intersect(
  v: Float64Array,
  i: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const ax = v[9 * i]!,
    ay = v[9 * i + 1]!,
    az = v[9 * i + 2]!;
  const e1x = v[9 * i + 3]! - ax,
    e1y = v[9 * i + 4]! - ay,
    e1z = v[9 * i + 5]! - az;
  const e2x = v[9 * i + 6]! - ax,
    e2y = v[9 * i + 7]! - ay,
    e2z = v[9 * i + 8]! - az;
  const px = dy * e2z - dz * e2y,
    py = dz * e2x - dx * e2z,
    pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det === 0) return -1;
  const inv = 1 / det;
  const sx = ox - ax,
    sy = oy - ay,
    sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y,
    qy = sz * e1x - sx * e1z,
    qz = sx * e1y - sy * e1x;
  const w = (dx * qx + dy * qy + dz * qz) * inv;
  if (w < 0 || u + w > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
