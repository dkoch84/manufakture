// Quadratic tetrahedron (TET10): shape functions, element stiffness for an isotropic linear
// elastic material, and stress at the element's nodes.
//
// Node order (ours, after `mesh.ts` has mapped gmsh's): corners 0..3, then the edge nodes
// 4:(0,1) 5:(1,2) 6:(0,2) 7:(0,3) 8:(1,3) 9:(2,3). Natural coordinates are barycentric,
// L0 = 1 - r - s - t, L1 = r, L2 = s, L3 = t.

/** Corner pairs of the edge nodes 4..9, in our order. */
export const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 3],
];

/** The four corner-triple faces of a tet (corner indices) and the edge nodes on each, in order. */
export const FACES: readonly {
  corners: [number, number, number];
  mids: [number, number, number];
  opposite: number;
}[] = [
  { corners: [0, 1, 2], mids: [4, 5, 6], opposite: 3 },
  { corners: [0, 1, 3], mids: [4, 8, 7], opposite: 2 },
  { corners: [1, 2, 3], mids: [5, 9, 8], opposite: 0 },
  { corners: [0, 2, 3], mids: [6, 9, 7], opposite: 1 },
];

/** Derivatives of the 10 shape functions with respect to (r, s, t) at a point: out[3 * a + k]. */
export function shapeDerivatives(r: number, s: number, t: number, out: Float64Array): void {
  const L = [1 - r - s - t, r, s, t];
  // dL/d(r,s,t)
  const dL = [
    [-1, -1, -1],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let a = 0; a < 4; a++) {
    const f = 4 * L[a]! - 1;
    for (let k = 0; k < 3; k++) out[3 * a + k] = f * dL[a]![k]!;
  }
  for (let e = 0; e < 6; e++) {
    const [i, j] = EDGES[e]!;
    for (let k = 0; k < 3; k++)
      out[3 * (4 + e) + k] = 4 * (L[i]! * dL[j]![k]! + L[j]! * dL[i]![k]!);
  }
}

// 4-point Gauss rule on the reference tet (exact for degree 2).
const GA = 0.5854101966249685;
const GB = 0.1381966011250105;
const GAUSS: readonly (readonly [number, number, number])[] = [
  [GB, GB, GB],
  [GA, GB, GB],
  [GB, GA, GB],
  [GB, GB, GA],
];
const GAUSS_W = 1 / 24;

const GAUSS_DN: Float64Array[] = GAUSS.map(([r, s, t]) => {
  const d = new Float64Array(30);
  shapeDerivatives(r, s, t, d);
  return d;
});

/** Natural coordinates of the 10 nodes, for stress recovery at the nodes. */
const NODE_RST: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.5, 0, 0],
  [0.5, 0.5, 0],
  [0, 0.5, 0],
  [0, 0, 0.5],
  [0.5, 0, 0.5],
  [0, 0.5, 0.5],
];
const NODE_DN: Float64Array[] = NODE_RST.map(([r, s, t]) => {
  const d = new Float64Array(30);
  shapeDerivatives(r, s, t, d);
  return d;
});

/**
 * Physical gradients of the shape functions at a point: grad[3 * a + i] = dN_a/dx_i. Returns the
 * Jacobian determinant (negative for an inverted element).
 */
function gradients(xe: Float64Array, dN: Float64Array, grad: Float64Array): number {
  // J[k][i] = dx_i/dr_k
  let j00 = 0,
    j01 = 0,
    j02 = 0,
    j10 = 0,
    j11 = 0,
    j12 = 0,
    j20 = 0,
    j21 = 0,
    j22 = 0;
  for (let a = 0; a < 10; a++) {
    const x = xe[3 * a]!,
      y = xe[3 * a + 1]!,
      z = xe[3 * a + 2]!;
    const dr = dN[3 * a]!,
      ds = dN[3 * a + 1]!,
      dt = dN[3 * a + 2]!;
    j00 += dr * x;
    j01 += dr * y;
    j02 += dr * z;
    j10 += ds * x;
    j11 += ds * y;
    j12 += ds * z;
    j20 += dt * x;
    j21 += dt * y;
    j22 += dt * z;
  }
  const det =
    j00 * (j11 * j22 - j12 * j21) - j01 * (j10 * j22 - j12 * j20) + j02 * (j10 * j21 - j11 * j20);
  const id = 1 / det;
  // inverse of J
  const i00 = (j11 * j22 - j12 * j21) * id,
    i01 = (j02 * j21 - j01 * j22) * id,
    i02 = (j01 * j12 - j02 * j11) * id;
  const i10 = (j12 * j20 - j10 * j22) * id,
    i11 = (j00 * j22 - j02 * j20) * id,
    i12 = (j02 * j10 - j00 * j12) * id;
  const i20 = (j10 * j21 - j11 * j20) * id,
    i21 = (j01 * j20 - j00 * j21) * id,
    i22 = (j00 * j11 - j01 * j10) * id;
  // dN/dx_i = sum_k dN/dr_k * dr_k/dx_i, and dr_k/dx_i = invJ[i][k]
  for (let a = 0; a < 10; a++) {
    const dr = dN[3 * a]!,
      ds = dN[3 * a + 1]!,
      dt = dN[3 * a + 2]!;
    grad[3 * a] = i00 * dr + i01 * ds + i02 * dt;
    grad[3 * a + 1] = i10 * dr + i11 * ds + i12 * dt;
    grad[3 * a + 2] = i20 * dr + i21 * ds + i22 * dt;
  }
  return det;
}

export interface Material {
  /** Young's modulus, MPa. */
  E: number;
  /** Poisson's ratio. */
  nu: number;
}

export function lame(m: Material): { lambda: number; mu: number } {
  return { lambda: (m.E * m.nu) / ((1 + m.nu) * (1 - 2 * m.nu)), mu: m.E / (2 * (1 + m.nu)) };
}

const gradScratch = new Float64Array(30);

/**
 * Element stiffness as the upper triangle of 3x3 node blocks: for a <= b, block (a, b) is
 * ke[9 * pairIndex(a, b) + 3 * i + j]. Returns false for an inverted element.
 */
export function elementStiffness(
  xe: Float64Array,
  lambda: number,
  mu: number,
  ke: Float64Array,
): boolean {
  ke.fill(0);
  const g = gradScratch;
  for (let q = 0; q < 4; q++) {
    const det = gradients(xe, GAUSS_DN[q]!, g);
    if (!(det > 0)) return false;
    const w = det * GAUSS_W;
    const lw = lambda * w,
      mw = mu * w;
    let p = 0;
    for (let a = 0; a < 10; a++) {
      const ax = g[3 * a]!,
        ay = g[3 * a + 1]!,
        az = g[3 * a + 2]!;
      for (let b = a; b < 10; b++) {
        const bx = g[3 * b]!,
          by = g[3 * b + 1]!,
          bz = g[3 * b + 2]!;
        const dot = mw * (ax * bx + ay * by + az * bz);
        const o = 9 * p;
        // K_ab,ij = lambda dNa_i dNb_j + mu dNa_j dNb_i + mu delta_ij grad Na . grad Nb
        ke[o]! += lw * ax * bx + mw * ax * bx + dot;
        ke[o + 1]! += lw * ax * by + mw * ay * bx;
        ke[o + 2]! += lw * ax * bz + mw * az * bx;
        ke[o + 3]! += lw * ay * bx + mw * ax * by;
        ke[o + 4]! += lw * ay * by + mw * ay * by + dot;
        ke[o + 5]! += lw * ay * bz + mw * az * by;
        ke[o + 6]! += lw * az * bx + mw * ax * bz;
        ke[o + 7]! += lw * az * by + mw * ay * bz;
        ke[o + 8]! += lw * az * bz + mw * az * bz + dot;
        p++;
      }
    }
  }
  return true;
}

/** Number of (a, b) pairs with a <= b over 10 nodes. */
export const PAIRS = 55;

/**
 * Stress (Voigt: xx, yy, zz, yz, xz, xy) at each of the element's 10 nodes, from the element's
 * nodal displacements ue (30 values). out[6 * a + c].
 */
export function elementNodalStress(
  xe: Float64Array,
  ue: Float64Array,
  lambda: number,
  mu: number,
  out: Float64Array,
): void {
  const g = gradScratch;
  for (let n = 0; n < 10; n++) {
    gradients(xe, NODE_DN[n]!, g);
    let exx = 0,
      eyy = 0,
      ezz = 0,
      gyz = 0,
      gxz = 0,
      gxy = 0;
    for (let a = 0; a < 10; a++) {
      const ux = ue[3 * a]!,
        uy = ue[3 * a + 1]!,
        uz = ue[3 * a + 2]!;
      const dx = g[3 * a]!,
        dy = g[3 * a + 1]!,
        dz = g[3 * a + 2]!;
      exx += dx * ux;
      eyy += dy * uy;
      ezz += dz * uz;
      gyz += dz * uy + dy * uz;
      gxz += dz * ux + dx * uz;
      gxy += dy * ux + dx * uy;
    }
    const tr = lambda * (exx + eyy + ezz);
    const o = 6 * n;
    out[o] = tr + 2 * mu * exx;
    out[o + 1] = tr + 2 * mu * eyy;
    out[o + 2] = tr + 2 * mu * ezz;
    out[o + 3] = mu * gyz;
    out[o + 4] = mu * gxz;
    out[o + 5] = mu * gxy;
  }
}

export function vonMises(s: ArrayLike<number>, o = 0): number {
  const xx = s[o]!,
    yy = s[o + 1]!,
    zz = s[o + 2]!,
    yz = s[o + 3]!,
    xz = s[o + 4]!,
    xy = s[o + 5]!;
  return Math.sqrt(
    0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (yz * yz + xz * xz + xy * xy),
  );
}
