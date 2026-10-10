// Fixtures and loads on faces: displacement constraints on every node of a face, and consistent
// nodal forces of uniform tractions, total forces and pressures, integrated over each curved
// 6-node triangle with a 6-point rule so a pressure follows the true normal (T9.0a spike).
// Solver units: mm, N, MPa.

import type { ResolvedFace } from './mesh';

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

const TRI_N = TRI_Q.map(([u, v, w]) => {
  const L0 = 1 - u - v,
    L1 = u,
    L2 = v;
  return {
    w,
    N: [
      L0 * (2 * L0 - 1),
      L1 * (2 * L1 - 1),
      L2 * (2 * L2 - 1),
      4 * L0 * L1,
      4 * L1 * L2,
      4 * L0 * L2,
    ],
    dNu: [-(4 * L0 - 1), 4 * L1 - 1, 0, 4 * (L0 - L1), 4 * L2, -4 * L2],
    dNv: [-(4 * L0 - 1), 0, 4 * L2 - 1, -4 * L1, 4 * L1, 4 * (L0 - L2)],
  };
});

/** A load in solver units on resolved faces. */
export type SolverLoad =
  | {
      kind: 'traction';
      faces: readonly ResolvedFace[];
      traction: readonly [number, number, number];
    }
  | { kind: 'pressure'; faces: readonly ResolvedFace[]; pressure: number };

/**
 * Visit each quadrature point of each triangle: its shape functions, weight and outward area
 * vector (length = the local area scale, pointing out of the body).
 */
function forEachPoint(
  nodes: Float64Array,
  face: ResolvedFace,
  visit: (tri: number, N: readonly number[], w: number, av: [number, number, number]) => void,
): void {
  const nt = face.opposite.length;
  const xs = new Float64Array(18);
  for (let k = 0; k < nt; k++) {
    for (let a = 0; a < 6; a++) {
      const g = face.nodes[6 * k + a]!;
      xs[3 * a] = nodes[3 * g]!;
      xs[3 * a + 1] = nodes[3 * g + 1]!;
      xs[3 * a + 2] = nodes[3 * g + 2]!;
    }
    const o = face.opposite[k]!;
    const e1x = xs[3]! - xs[0]!,
      e1y = xs[4]! - xs[1]!,
      e1z = xs[5]! - xs[2]!;
    const e2x = xs[6]! - xs[0]!,
      e2y = xs[7]! - xs[1]!,
      e2z = xs[8]! - xs[2]!;
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const toOpp =
      nx * (nodes[3 * o]! - xs[0]!) +
      ny * (nodes[3 * o + 1]! - xs[1]!) +
      nz * (nodes[3 * o + 2]! - xs[2]!);
    const sign = toOpp > 0 ? -1 : 1;
    for (const { w, N, dNu, dNv } of TRI_N) {
      let ux = 0,
        uy = 0,
        uz = 0,
        vx = 0,
        vy = 0,
        vz = 0;
      for (let a = 0; a < 6; a++) {
        ux += dNu[a]! * xs[3 * a]!;
        uy += dNu[a]! * xs[3 * a + 1]!;
        uz += dNu[a]! * xs[3 * a + 2]!;
        vx += dNv[a]! * xs[3 * a]!;
        vy += dNv[a]! * xs[3 * a + 1]!;
        vz += dNv[a]! * xs[3 * a + 2]!;
      }
      visit(k, N, w, [
        sign * (uy * vz - uz * vy),
        sign * (uz * vx - ux * vz),
        sign * (ux * vy - uy * vx),
      ]);
    }
  }
}

/** Area of resolved faces, mm². `check` runs before each face (cancellation, time limit). */
export function faceArea(
  nodes: Float64Array,
  faces: readonly ResolvedFace[],
  check?: () => void,
): number {
  let area = 0;
  for (const f of faces) {
    check?.();
    forEachPoint(nodes, f, (_k, _N, w, av) => (area += w * Math.hypot(av[0], av[1], av[2])));
  }
  return area;
}

/**
 * Add consistent nodal forces to f (3 per node). Returns the total force applied, N. `check`
 * runs before each face.
 */
export function applyLoads(
  nodes: Float64Array,
  loads: readonly SolverLoad[],
  f: Float64Array,
  check?: () => void,
): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  for (const load of loads) {
    for (const face of load.faces) {
      check?.();
      forEachPoint(nodes, face, (k, N, w, av) => {
        let fx: number, fy: number, fz: number;
        if (load.kind === 'pressure') {
          fx = -load.pressure * av[0];
          fy = -load.pressure * av[1];
          fz = -load.pressure * av[2];
        } else {
          const area = Math.hypot(av[0], av[1], av[2]);
          fx = load.traction[0] * area;
          fy = load.traction[1] * area;
          fz = load.traction[2] * area;
        }
        for (let a = 0; a < 6; a++) {
          const g = face.nodes[6 * k + a]!;
          const s = N[a]! * w;
          f[3 * g]! += s * fx;
          f[3 * g + 1]! += s * fy;
          f[3 * g + 2]! += s * fz;
          total[0] += s * fx;
          total[1] += s * fy;
          total[2] += s * fz;
        }
      });
    }
  }
  return total;
}

/**
 * Hold components of every node of the faces. Returns the count of nodes touched. `check` runs
 * before each face.
 */
export function fixFaces(
  faces: readonly ResolvedFace[],
  components: readonly [boolean, boolean, boolean],
  fixed: Uint8Array,
  check?: () => void,
): number {
  let count = 0;
  for (const face of faces) {
    check?.();
    for (let i = 0; i < face.nodes.length; i++) {
      const g = face.nodes[i]!;
      for (let c = 0; c < 3; c++) if (components[c]) fixed[3 * g + c] = 1;
      count++;
    }
  }
  return count;
}
